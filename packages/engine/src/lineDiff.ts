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

  const { changes } = linesDiffComputers
    .getDefault()
    .computeDiff(compareBase, compareSide, diffOptions);

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
