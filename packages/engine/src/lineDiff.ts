import { linesDiffComputers } from "vscode-diff";
import type {
  InnerRange,
  LineEnding,
  LineSpan,
  Side,
  SideChange,
} from "./types";

/** How whitespace differences are treated when diffing. */
export type WhitespaceMode = "none" | "trailing" | "all";

export interface DiffOptions {
  whitespace?: WhitespaceMode;
  /**
   * When set, skip inner (character-level) diffs above this combined line
   * count to stay responsive on very large inputs.
   */
  innerLineBudget?: number;
  /**
   * Merge only. With a whitespace-ignoring mode, ALSO report the lines the
   * whitespace-blind diff calls equal but whose bytes differ, as changes
   * flagged `whitespaceOnly` (JetBrains' IgnoringChangeBuilder). Without this
   * a merge in "Trim"/"Ignore" mode silently dropped a side's whitespace-only
   * edit: nothing showed it, and the result kept base's bytes.
   *
   * Off for the 2-way diff on purpose: there "ignore whitespace" must hide the
   * change, to agree with Monaco's own diff (see ignoreTrimWhitespaceFor).
   */
  whitespaceOnlyChanges?: boolean;
}

const BASE_DIFF_OPTIONS = {
  ignoreTrimWhitespace: false,
  maxComputationTimeMs: 5000,
  computeMoves: false,
};

/** One change as vscode-diff reports it — the fields this package reads. */
export interface LineChange {
  original: { startLineNumber: number; endLineNumberExclusive: number };
  modified: { startLineNumber: number; endLineNumberExclusive: number };
  innerChanges?: ReadonlyArray<{ originalRange: RangeLike; modifiedRange: RangeLike }>;
}

/**
 * A line no text has. Appended to both sides by `computeLineChanges`.
 */
const END_OF_TEXT = "\u0000gitstudio:end-of-text\u0000";

const isBlank = (line: string): boolean => line.trim() === "";

/**
 * Whether vscode-diff can get the end of these two texts wrong (see
 * computeLineChanges): both end in a blank line, and their blank lines are
 * not all spelled the same — `""` beside `"  "`, or a CRLF file's `"\r"`
 * beside the empty line after its final newline.
 *
 * Checked, not guessed: over every pair of texts of up to four lines built
 * from empty, space, tab, CR, indented and plain lines (two alphabets, 7.84
 * million pairs each), every one of vscode-diff's 1,822 failures has this
 * shape. Narrower guesses miss some: "a whitespace-only line among the
 * trailing blank lines" misses 72 ("\n" → "\n \na\n"). Plain LF source with
 * no whitespace-only line never has it; a CRLF file with an empty line in it
 * nearly always does.
 */
export function endIsAtRisk(a: readonly string[], b: readonly string[]): boolean {
  if (a.length < 2 || b.length < 2 || !isBlank(a[a.length - 1]) || !isBlank(b[b.length - 1])) {
    return false;
  }
  let spelling: string | undefined;
  for (const lines of [a, b]) {
    for (const line of lines) {
      if (!isBlank(line)) continue;
      if (spelling === undefined) spelling = line;
      else if (line !== spelling) return true;
    }
  }
  return false;
}

/**
 * vscode-diff's line diff, minus one defect it has at the end of a text.
 *
 * Its line pass compares TRIMMED lines, so a whitespace-only line and the empty
 * line after a text's final "\n" look the same to it. In the shape
 * `endIsAtRisk` names it can pair them wrongly, file the left-over line as an
 * insertion AFTER the last line, and turn that into line numbers one short.
 * The changes then no longer add up: `"x\n"` → `"x\n \n"` came back as "line
 * 2 modified" with nothing inserted, and staging every change of it wrote
 * `"x\n "` to the index; a blank line added to a CRLF file staged a lone "\r"
 * at its end. vscode-diff notices — its `assertFn` fails — but only reports it
 * through `setTimeout(() => { throw … })`, an uncaught exception in the host:
 * crash report #19, six times from Windows, from the editor gutter's refresh.
 * The same code is upstream in VS Code, unfixed.
 *
 * Every other pair of texts goes to vscode-diff untouched, and its answer is
 * returned as it is. In the risky shape one more line, equal on both sides and
 * like no other, goes after both texts, so no change can sit after the last
 * line and the defect has nowhere to happen. The answer then comes back in the
 * caller's own line numbers (`endOfText`). Where vscode-diff would not have
 * failed, the answer is the same except, now and then, for which blank lines
 * near the end belong to which change — on CRLF source edits, never at all
 * (0 of 19,799); on texts thick with whitespace-only lines, 83 of 19,807,
 * every one of them about blank lines only.
 */
export function computeLineChanges(
  original: readonly string[],
  modified: readonly string[],
  options: typeof BASE_DIFF_OPTIONS,
): { changes: readonly LineChange[]; hitTimeout: boolean } {
  const computer = linesDiffComputers.getDefault();
  if (options.ignoreTrimWhitespace || !endIsAtRisk(original, modified)) {
    return computer.computeDiff(original as string[], modified as string[], options);
  }
  const diff = computer.computeDiff([...original, END_OF_TEXT], [...modified, END_OF_TEXT], options);
  return { hitTimeout: diff.hitTimeout, changes: endOfText(diff.changes, original, modified) };
}

/**
 * Changes computed with END_OF_TEXT after both texts, in the texts' own terms.
 *
 * Line numbers and positions are clamped to the real texts: a position on the
 * added line is the end of the real last line. Then two shapes the added line
 * produces are put where the user can reach them:
 *
 * - A change that runs to the end of BOTH texts gives back the lines it ends
 *   with that are the same on both sides. A blank line added to a CRLF file is
 *   that blank line inserted, not a two-line block that also marks the
 *   untouched last line.
 * - A pure insertion or deletion anchored AFTER the last line of the side it
 *   is empty on — which no line of that text can select, so no line action can
 *   stage or unstage it — slides up through the identical lines above it, as
 *   far as they go. If the change before it is in the way, the two are one
 *   change (and lose any equal lines they end with, as above). Deleting the
 *   last of two blank lines (files.trimFinalNewlines) is the first blank line
 *   deleted, on a line the working text has — where vscode-diff puts it.
 *
 * A change either step moved keeps the character ranges still inside it, and
 * gets whole-line ones if none are.
 */
function endOfText(
  changes: readonly LineChange[],
  a: readonly string[],
  b: readonly string[],
): LineChange[] {
  const out: LineChange[] = [];
  for (const change of changes) {
    let os = Math.min(change.original.startLineNumber, a.length + 1);
    let oe = Math.min(change.original.endLineNumberExclusive, a.length + 1);
    let ms = Math.min(change.modified.startLineNumber, b.length + 1);
    let me = Math.min(change.modified.endLineNumberExclusive, b.length + 1);
    let inner = (change.innerChanges ?? []).map((i) => ({
      originalRange: rangeWithin(i.originalRange, a),
      modifiedRange: rangeWithin(i.modifiedRange, b),
    }));
    let moved = false;
    const trimAtEnd = (): void => {
      if (oe !== a.length + 1 || me !== b.length + 1) return;
      while (oe > os && me > ms && a[oe - 2] === b[me - 2]) {
        oe--;
        me--;
        moved = true;
      }
    };
    trimAtEnd();
    const pastEnd = (): boolean => (os === oe && ms < me && os > a.length) || (ms === me && os < oe && ms > b.length);
    if (pastEnd()) {
      const prev = out[out.length - 1];
      const floorO = prev ? prev.original.endLineNumberExclusive + 1 : 1;
      const floorM = prev ? prev.modified.endLineNumberExclusive + 1 : 1;
      // The lines it is made of, read on the side that has them.
      const [lines, start, end] = os === oe ? [b, ms, me] : [a, os, oe];
      let s = start;
      let e = end;
      while (os - 1 >= floorO && ms - 1 >= floorM && lines[s - 2] === lines[e - 2] && a[os - 2] === b[ms - 2]) {
        os--;
        oe--;
        ms--;
        me--;
        s--;
        e--;
        moved = true;
      }
      if (pastEnd() && prev && (os - 1 < floorO || ms - 1 < floorM)) {
        // Wedged against the change before it: they are one change.
        out.pop();
        os = prev.original.startLineNumber;
        ms = prev.modified.startLineNumber;
        inner = [...(prev.innerChanges ?? []), ...inner];
        moved = true;
        trimAtEnd();
      }
    }
    if (os === oe && ms === me) continue;
    if (moved) {
      inner = inner.filter(
        (i) =>
          linesWithin(i.originalRange, os, oe, a) && linesWithin(i.modifiedRange, ms, me, b),
      );
      if (inner.length === 0) {
        inner = [{ originalRange: wholeLines(a, os, oe), modifiedRange: wholeLines(b, ms, me) }];
      }
    }
    out.push({
      original: { startLineNumber: os, endLineNumberExclusive: oe },
      modified: { startLineNumber: ms, endLineNumberExclusive: me },
      innerChanges: inner,
    });
  }
  return out;
}

/** `r` with any position past the last line put at the end of the last line. */
function rangeWithin(r: RangeLike, lines: readonly string[]): RangeLike {
  const last = lines.length;
  const end = lines[last - 1].length + 1;
  const [startLineNumber, startColumn] = r.startLineNumber > last ? [last, end] : [r.startLineNumber, r.startColumn];
  const [endLineNumber, endColumn] = r.endLineNumber > last ? [last, end] : [r.endLineNumber, r.endColumn];
  return { startLineNumber, startColumn, endLineNumber, endColumn };
}

/** Whether `r` starts on or after line `start`, and ends by line `end`, inside `lines`. */
function linesWithin(r: RangeLike, start: number, end: number, lines: readonly string[]): boolean {
  return r.startLineNumber >= start && r.endLineNumber <= Math.max(start, end) && r.endLineNumber <= lines.length;
}

/** The whole lines [start, end) as a character range inside `lines`. */
function wholeLines(lines: readonly string[], start: number, end: number): RangeLike {
  const n = lines.length;
  const endOf = (line: number): number => lines[line - 1].length + 1;
  if (start === end) {
    return start <= n
      ? { startLineNumber: start, startColumn: 1, endLineNumber: start, endColumn: 1 }
      : { startLineNumber: n, startColumn: endOf(n), endLineNumber: n, endColumn: endOf(n) };
  }
  if (end <= n) return { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: 1 };
  if (start > 1) {
    return { startLineNumber: start - 1, startColumn: endOf(start - 1), endLineNumber: end - 1, endColumn: endOf(end - 1) };
  }
  return { startLineNumber: 1, startColumn: 1, endLineNumber: n, endColumn: endOf(n) };
}

/**
 * Whether a diff run in this mode should ignore leading/trailing whitespace.
 *
 * Exported because a second implementation depends on the answer: the desktop
 * app draws its split view through this module but its unified view through
 * Monaco's own diff worker, whose only whitespace knob is the identically named
 * `ignoreTrimWhitespace`. When the two derived that flag separately they drifted
 * — the same file, the same toggle, one view showing a change and the other
 * showing none. They now read it from here.
 *
 * Note "all" is NOT expressible in Monaco: it additionally normalizes internal
 * whitespace runs (below), which no editor option does. Any surface that has to
 * agree with Monaco must offer "trailing", not "all".
 */
export function ignoreTrimWhitespaceFor(mode: WhitespaceMode): boolean {
  return mode !== "none";
}

export function splitLines(text: string): string[] {
  return text.split("\n");
}

/**
 * The line ending a text mostly uses, or "none" when it has no line break.
 * A tie goes to the ending that appears first.
 */
export function detectEol(text: string): LineEnding | "none" {
  let crlf = 0;
  let lf = 0;
  let cr = 0;
  let first: LineEnding | undefined;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    if (ch === 13 /* \r */) {
      if (text.charCodeAt(i + 1) === 10) {
        crlf++;
        first ??= "CRLF";
        i++;
      } else {
        cr++;
        first ??= "CR";
      }
    } else if (ch === 10 /* \n */) {
      lf++;
      first ??= "LF";
    }
  }
  if (!first) {
    return "none";
  }
  const counts: Record<LineEnding, number> = { CRLF: crlf, LF: lf, CR: cr };
  const best = Math.max(crlf, lf, cr);
  return counts[first] === best
    ? first
    : (["CRLF", "LF", "CR"] as const).find((e) => counts[e] === best)!;
}

/**
 * Every line break as "\n". The merge runs on normalised text so a side that
 * only rewrote its line endings is not a whole-file conflict, and the same
 * change saved with CRLF on one side and LF on the other is the same change.
 */
export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** The characters of one line break of the given style. */
export function eolChars(eol: LineEnding): string {
  return eol === "CRLF" ? "\r\n" : eol === "CR" ? "\r" : "\n";
}

/** Collapses runs of whitespace to a single space and trims, for "ignore all". */
function normalizeAllWhitespace(line: string): string {
  return line.replace(/\s+/g, " ").trim();
}

/** A line as the given whitespace mode compares it. */
export function lineKey(line: string, mode: WhitespaceMode): string {
  if (mode === "all") {
    return normalizeAllWhitespace(line);
  }
  // "trailing" is vscode-diff's ignoreTrimWhitespace: both ends are trimmed.
  return mode === "trailing" ? line.trim() : line;
}

/** Whether two runs of lines are equal line by line under the whitespace mode. */
export function linesEqual(
  a: readonly string[],
  b: readonly string[],
  mode: WhitespaceMode,
): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i] && lineKey(a[i], mode) !== lineKey(b[i], mode)) {
      return false;
    }
  }
  return true;
}

/**
 * Diffs `base` against one side and returns the side's changes anchored in both
 * base and side coordinates, with character-level inner ranges.
 */
export function diffSide(
  baseLines: string[],
  sideLines: string[],
  side: Side,
  options: DiffOptions = {},
): SideChange[] {
  const whitespace = options.whitespace ?? "none";
  // "all" whitespace is handled by normalizing the compared lines; the diff
  // computer's own ignoreTrimWhitespace covers the "trailing" case.
  const compareBase =
    whitespace === "all" ? baseLines.map(normalizeAllWhitespace) : baseLines;
  const compareSide =
    whitespace === "all" ? sideLines.map(normalizeAllWhitespace) : sideLines;

  const diffOptions = {
    ...BASE_DIFF_OPTIONS,
    ignoreTrimWhitespace: ignoreTrimWhitespaceFor(whitespace),
  };
  // `innerLineBudget`: above it, no character-level ranges (see DiffOptions).
  const overBudget =
    options.innerLineBudget !== undefined &&
    baseLines.length + sideLines.length > options.innerLineBudget;

  const { changes } = computeLineChanges(compareBase, compareSide, diffOptions);

  const result: SideChange[] = changes.map((change) => {
    const baseSpan: LineSpan = {
      start: change.original.startLineNumber,
      endExclusive: change.original.endLineNumberExclusive,
    };
    const sideSpan: LineSpan = {
      start: change.modified.startLineNumber,
      endExclusive: change.modified.endLineNumberExclusive,
    };
    const innerBase: InnerRange[] = [];
    const innerSide: InnerRange[] = [];
    // Under "all" the diff ran on NORMALISED lines (runs collapsed, ends
    // trimmed), so its character ranges index into strings the editor never
    // shows — every word highlight landed on the wrong columns. Re-derive them
    // from the ORIGINAL lines of the change. Over the budget, none at all: the
    // views do not draw word ranges on a large file, and "all" would pay for
    // them twice.
    const inners = overBudget
      ? []
      : whitespace === "all"
        ? innerOnOriginals(baseLines, sideLines, baseSpan, sideSpan)
        : (change.innerChanges ?? []).map((inner) => ({
            base: toInnerRange(inner.originalRange),
            side: toInnerRange(inner.modifiedRange),
          }));
    for (const inner of inners) {
      innerBase.push(inner.base);
      innerSide.push(inner.side);
    }
    return {
      side,
      role: roleFor(baseSpan, sideSpan),
      baseSpan,
      sideSpan,
      innerBase,
      innerSide,
    };
  });

  if (options.whitespaceOnlyChanges && whitespace !== "none") {
    result.push(
      ...whitespaceOnlyChanges(baseLines, sideLines, result, side),
    );
    result.sort(
      (a, b) =>
        a.baseSpan.start - b.baseSpan.start ||
        a.baseSpan.endExclusive - b.baseSpan.endExclusive,
    );
  }
  return result;
}

/**
 * The lines a whitespace-blind diff paired as equal whose bytes differ.
 * Between (and around) the real changes, base and side lines correspond one to
 * one; each run of pairs that differ exactly is one whitespace-only change.
 */
function whitespaceOnlyChanges(
  baseLines: string[],
  sideLines: string[],
  changes: readonly SideChange[],
  side: Side,
): SideChange[] {
  const found: SideChange[] = [];
  let baseAt = 1;
  let sideAt = 1;
  const scanEqual = (baseEnd: number, sideEnd: number): void => {
    const length = Math.min(baseEnd - baseAt, sideEnd - sideAt);
    let runStart = -1;
    for (let k = 0; k <= length; k++) {
      const differs =
        k < length && baseLines[baseAt - 1 + k] !== sideLines[sideAt - 1 + k];
      if (differs && runStart < 0) {
        runStart = k;
      } else if (!differs && runStart >= 0) {
        found.push({
          side,
          role: "modified",
          baseSpan: { start: baseAt + runStart, endExclusive: baseAt + k },
          sideSpan: { start: sideAt + runStart, endExclusive: sideAt + k },
          innerBase: [],
          innerSide: [],
          whitespaceOnly: true,
        });
        runStart = -1;
      }
    }
  };
  for (const change of changes) {
    scanEqual(change.baseSpan.start, change.sideSpan.start);
    baseAt = change.baseSpan.endExclusive;
    sideAt = change.sideSpan.endExclusive;
  }
  scanEqual(baseLines.length + 1, sideLines.length + 1);
  return found;
}

/** Character ranges of one change, computed on the original (unnormalised) lines. */
function innerOnOriginals(
  baseLines: string[],
  sideLines: string[],
  baseSpan: LineSpan,
  sideSpan: LineSpan,
): Array<{ base: InnerRange; side: InnerRange }> {
  const baseSlice = baseLines.slice(baseSpan.start - 1, baseSpan.endExclusive - 1);
  const sideSlice = sideLines.slice(sideSpan.start - 1, sideSpan.endExclusive - 1);
  if (baseSlice.length === 0 || sideSlice.length === 0) {
    return [];
  }
  const { changes } = linesDiffComputers.getDefault().computeDiff(baseSlice, sideSlice, {
    ...BASE_DIFF_OPTIONS,
    ignoreTrimWhitespace: true,
  });
  const out: Array<{ base: InnerRange; side: InnerRange }> = [];
  for (const change of changes) {
    for (const inner of change.innerChanges ?? []) {
      out.push({
        base: shiftInner(toInnerRange(inner.originalRange), baseSpan.start - 1),
        side: shiftInner(toInnerRange(inner.modifiedRange), sideSpan.start - 1),
      });
    }
  }
  return out;
}

function shiftInner(range: InnerRange, lines: number): InnerRange {
  return {
    ...range,
    startLine: range.startLine + lines,
    endLine: range.endLine + lines,
  };
}

function roleFor(
  baseSpan: LineSpan,
  sideSpan: LineSpan,
): SideChange["role"] {
  const baseEmpty = baseSpan.start === baseSpan.endExclusive;
  const sideEmpty = sideSpan.start === sideSpan.endExclusive;
  if (baseEmpty && !sideEmpty) {
    return "inserted";
  }
  if (!baseEmpty && sideEmpty) {
    return "deleted";
  }
  return "modified";
}

interface RangeLike {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

function toInnerRange(range: RangeLike): InnerRange {
  return {
    startLine: range.startLineNumber,
    startColumn: range.startColumn,
    endLine: range.endLineNumber,
    endColumn: range.endColumn,
  };
}
