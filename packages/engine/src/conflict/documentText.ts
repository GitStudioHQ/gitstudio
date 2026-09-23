// What the merge editor may WRITE to the conflicted file before Apply
// (POLISH A1.1), and what it should START from when the file was already
// resolved outside it (A1.2). Pure: no vscode, no monaco, no fs.
//
// Both answer one question — where does each change block of the merge sit in
// a document that is not base? — the same way: diff base against the document,
// anchor on the COMMON lines (lines no block owns) that survived unchanged, and
// read each run of blocks between two anchors as one region. What is in that
// region says what happened to the blocks in it.
//
// markUnsettled: the extensions mirror the Result pane into the file's
// document on every click, and VS Code's autosave (or ⌘S, or Save on close)
// writes it. A conflict nobody has settled sits in the Result as BASE text, so
// one accept plus an autosave wrote base over every other conflict, with no
// markers — `git diff --check` passed, and a staged commit silently reverted
// both sides. The document gets this instead: every conflict whose region
// still holds base is written as diff3 markers, and a non-conflicting change
// the Result has not taken yet is written as git wrote it (the side's text),
// never as base. Apply still writes the plain Result.
//
// seedFromWorking: the Result was always seeded from base, so opening the
// merge editor on a file resolved by hand or by git rerere (no markers left)
// showed the conflict from the start, and the next write put base back over
// the resolution.

import { linesDiffComputers } from "vscode-diff";
import { buildMergeModel } from "../mergeModel";
import { detectEol, eolChars, normalizeEol, splitLines } from "../lineDiff";
import { sideBlockSpan, type ChangeBlock, type LineSpan, type MergeModel } from "../types";

/** The three texts of a merge, as the merge view gets them: `ours` is Yours (left), `theirs` Theirs (right). */
export interface MergeTexts {
  base: string;
  ours: string;
  theirs: string;
}

/** The model and the line arrays, computed once per merge (the load fixture's model costs seconds). */
export interface PreparedMerge {
  readonly model: MergeModel;
  /** Lines as the view holds them (`splitLines`, so "" is one empty line). */
  readonly base: readonly string[];
  readonly ours: readonly string[];
  readonly theirs: readonly string[];
  /** The DOCUMENT is "" — it has no lines, whatever splitLines says. */
  readonly baseEmpty: boolean;
  readonly oursEmpty: boolean;
  readonly theirsEmpty: boolean;
}

export function prepareMerge(texts: MergeTexts): PreparedMerge {
  const base = normalizeEol(texts.base);
  const ours = normalizeEol(texts.ours);
  const theirs = normalizeEol(texts.theirs);
  return {
    // Whitespace "none": the finest blocks, which is what the view opens with.
    model: buildMergeModel(texts.base, texts.ours, texts.theirs, { whitespace: "none" }),
    base: splitLines(base),
    ours: splitLines(ours),
    theirs: splitLines(theirs),
    baseEmpty: base === "",
    oursEmpty: ours === "",
    theirsEmpty: theirs === "",
  };
}

/**
 * How the markers name the sides. The FIRST section is git's stage 2, as git
 * writes it — so a reader that falls back to the markers (and maps stage 2
 * through the operation, as ConflictOps does) puts each side where it belongs.
 * During a rebase stage 2 is Theirs.
 */
export interface MarkerLabels {
  /** The first section holds Yours (`ours`); false when stage 2 is Theirs. */
  firstIsYours: boolean;
  first: string;
  second: string;
  base?: string;
}

export interface MarkedDocument {
  /** The text to put in the file's document. */
  text: string;
  /** Conflicts written as markers. */
  marked: number;
  /**
   * Regions the Result settled differently from what git itself wrote there
   * (a conflict resolved, a one-sided change left out, a hand edit). Zero
   * means the document git left says the same thing, so nothing needs writing.
   */
  changes: number;
}

/**
 * The document text for a Result that may still hold unsettled conflicts
 * (see the file comment). Undefined when the result could not be mapped onto
 * the merge (the diff gave up) — write nothing then.
 */
export function markUnsettled(
  prepared: PreparedMerge,
  result: string,
  labels: MarkerLabels,
): MarkedDocument | undefined {
  const { model } = prepared;
  if (model.blocks.length === 0) return { text: result, marked: 0, changes: 0 };
  const doc = splitLines(normalizeEol(result));
  const groups = mapGroups(prepared, doc);
  if (!groups) return undefined;

  const out: string[] = [];
  let at = 0; // next doc line (0-based) not yet copied
  let marked = 0;
  let changes = 0;
  for (const g of groups) {
    out.push(...doc.slice(at, g.docFrom));
    at = g.docTo;
    const region = doc.slice(g.docFrom, g.docTo);
    const baseRegion = prepared.base.slice(g.baseFrom, g.baseTo);
    const conflicts = g.blocks.filter((b) => b.kind === "conflict").length;
    const pending = (): string[] => {
      marked += conflicts;
      return render(prepared, g, (b) => (b.kind === "conflict" ? markers(prepared, b, labels) : natural(prepared, b)));
    };
    if (same(region, baseRegion)) {
      // Nothing settled here: conflicts keep their markers, and a change only
      // one side made (or both made alike) stays as git merged it.
      out.push(...pending());
      continue;
    }
    if (g.blocks.length === 1) {
      const b = g.blocks[0];
      const pre = prepared.base.slice(g.baseFrom, b.baseSpan.start - 1);
      const post = prepared.base.slice(b.baseSpan.endExclusive - 1, g.baseTo);
      const settledAs = candidates(prepared, b).find((c) => same(region, [...pre, ...c.lines, ...post]));
      if (settledAs) {
        out.push(...region);
        if (!settledAs.natural) changes++;
        continue;
      }
      // Lines typed right beside a conflict nobody has settled: the conflict is
      // still intact next to them. Keep them, and keep the markers.
      if (baseRegion.length > 0 && !(prepared.baseEmpty && baseRegion.length === 1 && baseRegion[0] === "")) {
        if (endsWith(region, baseRegion)) {
          out.push(...region.slice(0, region.length - baseRegion.length), ...pending());
          changes++;
          continue;
        }
        if (startsWith(region, baseRegion)) {
          out.push(...pending(), ...region.slice(baseRegion.length));
          changes++;
          continue;
        }
      }
    }
    // Settled here — by an accept, the wand, or by hand. The Result is the answer.
    out.push(...region);
    changes++;
  }
  out.push(...doc.slice(at));

  // Always the rendered text, even with nothing to report: a one-sided change
  // the Result has not taken is written as git wrote it, never as base.
  return { text: withEol(out.join("\n"), result, model), marked, changes };
}

/** What the Result should start from, given the file as it is on disk. */
export type WorkingSeed =
  /** The working file adds nothing (it is base, or empty): start as usual. */
  | { kind: "base" }
  /**
   * No conflict markers are left: the file was resolved by hand or by git
   * rerere. Start from `text`, every block counted as resolved.
   */
  | { kind: "working"; text: string }
  /**
   * Markers remain (git's own conflicted file, or one partly resolved by hand):
   * start as usual, but keep each `keep` region's lines — a region edited by
   * hand outside the markers — with its blocks counted as resolved.
   */
  | { kind: "markers"; keep: Array<{ blockIds: number[]; baseSpan: LineSpan; lines: string[] }> }
  /** The file could not be mapped onto the merge: ask before discarding it. */
  | { kind: "ask" };

export function seedFromWorking(prepared: PreparedMerge, working: string): WorkingSeed {
  const text = normalizeEol(working);
  if (!hasConflictMarkers(text)) {
    if (text === "" || same(splitLines(text), prepared.base)) return { kind: "base" };
    return { kind: "working", text: working };
  }
  const doc = splitLines(text);
  const groups = mapGroups(prepared, doc);
  if (!groups) return { kind: "ask" };
  const inMarkers = markerLines(doc);
  const keep: Array<{ blockIds: number[]; baseSpan: LineSpan; lines: string[] }> = [];
  for (const g of groups) {
    // Inclusive of the lines just outside: a region that ENDS where a marker
    // starts is the lead-in git wrote before the conflict (zdiff3 moves the
    // common lines out), not a separate edit.
    let touchesMarkers = false;
    for (let i = Math.max(0, g.docFrom - 1); i < Math.min(doc.length, g.docTo + 1) && !touchesMarkers; i++) {
      touchesMarkers = inMarkers[i];
    }
    if (touchesMarkers) continue;
    const region = doc.slice(g.docFrom, g.docTo);
    if (same(region, prepared.base.slice(g.baseFrom, g.baseTo))) continue;
    // What git writes for changes that do not conflict; a conflict outside the
    // markers was settled by someone, so it is kept.
    if (g.blocks.every((b) => b.kind !== "conflict") && same(region, render(prepared, g, (b) => natural(prepared, b)))) {
      continue;
    }
    keep.push({
      blockIds: g.blocks.map((b) => b.id),
      baseSpan: { start: g.baseFrom + 1, endExclusive: g.baseTo + 1 },
      lines: region,
    });
  }
  return { kind: "markers", keep };
}

/**
 * The working file was resolved outside the merge editor: no conflict markers
 * are left in it, and it is neither empty nor simply base. The cheap half of
 * seedFromWorking, for a host deciding before any model exists.
 */
export function resolvedOutsideMerge(working: string, base: string): boolean {
  if (hasConflictMarkers(working)) return false;
  const text = normalizeEol(working);
  return text !== "" && text !== normalizeEol(base);
}

/** A line that opens (`<<<<<<<`) and one that closes (`>>>>>>>`) a conflict. */
export function hasConflictMarkers(text: string): boolean {
  return /^<{7}(?: |\r?$)/m.test(text) && /^>{7}(?: |\r?$)/m.test(text);
}

// ── mapping ──────────────────────────────────────────────────────────────────

interface Group {
  blocks: ChangeBlock[];
  /** Base lines [baseFrom, baseTo), 0-based: the blocks plus any unmatched common lines. */
  baseFrom: number;
  baseTo: number;
  /** Document lines [docFrom, docTo), 0-based. */
  docFrom: number;
  docTo: number;
}

/**
 * Where each block sits in `doc`. First by walking the COMMON chunks (the base
 * lines between blocks, which every version shares): each block's region is
 * the text between one chunk and the next, read as one of the ways the block
 * can be (base, a side, both, the wand's) when one of them fits. A plain diff
 * cannot be trusted with that: an insertion whose last line repeats the line
 * after it can be matched one line early, and the region slides. Only when a
 * hand edit changed a common chunk itself does the walk fail, and the diff's
 * anchors (mapByDiff) decide. Undefined when neither can place the blocks.
 */
function mapGroups(prepared: PreparedMerge, doc: readonly string[]): Group[] | undefined {
  return mapByChunks(prepared, doc) ?? mapByDiff(prepared, doc);
}

function mapByChunks(prepared: PreparedMerge, doc: readonly string[]): Group[] | undefined {
  const base = prepared.base;
  const blocks = sortedBlocks(prepared);
  // chunk[i] = the common lines before blocks[i]; chunk[n] = after the last one.
  const chunk = (i: number): readonly string[] =>
    base.slice(i === 0 ? 0 : blocks[i - 1].baseSpan.endExclusive - 1, i === blocks.length ? base.length : blocks[i].baseSpan.start - 1);
  const first = chunk(0);
  if (!matchAt(doc, 0, first)) return undefined;
  let pos = first.length;
  const groups: Group[] = [];
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const next = chunk(i + 1);
    const last = i === blocks.length - 1;
    const fits = (len: number): boolean =>
      pos + len <= doc.length && matchAt(doc, pos + len, next) && (!last || pos + len + next.length === doc.length);
    let len: number | undefined;
    for (const way of [base.slice(b.baseSpan.start - 1, b.baseSpan.endExclusive - 1), ...candidates(prepared, b).map((c) => c.lines)]) {
      if (matchAt(doc, pos, way) && fits(way.length)) {
        len = way.length;
        break;
      }
    }
    if (len === undefined) {
      // Edited by hand: the region runs to where the next common chunk starts.
      const q = last ? doc.length - next.length : indexOfRun(doc, next, pos);
      if (q < pos || !fits(q - pos)) return undefined;
      len = q - pos;
    }
    groups.push({
      blocks: [b],
      baseFrom: b.baseSpan.start - 1,
      baseTo: b.baseSpan.endExclusive - 1,
      docFrom: pos,
      docTo: pos + len,
    });
    pos += len + next.length;
  }
  return groups;
}

function sortedBlocks(prepared: PreparedMerge): ChangeBlock[] {
  return [...prepared.model.blocks].sort(
    (x, y) => x.baseSpan.start - y.baseSpan.start || x.baseSpan.endExclusive - y.baseSpan.endExclusive,
  );
}

function matchAt(doc: readonly string[], at: number, run: readonly string[]): boolean {
  if (at + run.length > doc.length) return false;
  for (let i = 0; i < run.length; i++) if (doc[at + i] !== run[i]) return false;
  return true;
}

/** The first index >= from where `run` (non-empty) occurs in doc, or -1. */
function indexOfRun(doc: readonly string[], run: readonly string[], from: number): number {
  if (run.length === 0) return from;
  for (let i = from; i + run.length <= doc.length; i++) if (matchAt(doc, i, run)) return i;
  return -1;
}

/**
 * The blocks, grouped by the unchanged COMMON lines around them. An anchor is
 * a base line no block owns that the diff matched to a document line; the
 * blocks between two consecutive anchors are one group, and the document lines
 * between the anchors' matches are its region. Undefined when the diff timed out.
 */
function mapByDiff(prepared: PreparedMerge, doc: readonly string[]): Group[] | undefined {
  const base = prepared.base;
  const n = base.length;
  const { changes, hitTimeout } = linesDiffComputers.getDefault().computeDiff(base as string[], doc as string[], {
    ignoreTrimWhitespace: false,
    maxComputationTimeMs: 5000,
    computeMoves: false,
  });
  if (hitTimeout) return undefined;
  // docOf[i] = the document line (1-based) base line i (1-based) is matched to, or 0.
  const docOf = new Int32Array(n + 2);
  let b = 1;
  let d = 1;
  const equalUntil = (bEnd: number, dEnd: number): void => {
    while (b < bEnd && d < dEnd) docOf[b++] = d++;
  };
  for (const c of changes) {
    equalUntil(c.original.startLineNumber, c.modified.startLineNumber);
    b = c.original.endLineNumberExclusive;
    d = c.modified.endLineNumberExclusive;
  }
  equalUntil(n + 1, doc.length + 1);

  const owned = new Uint8Array(n + 2);
  for (const block of prepared.model.blocks) {
    for (let i = block.baseSpan.start; i < block.baseSpan.endExclusive; i++) owned[i] = 1;
  }
  const anchors: number[] = [0];
  const docAt: number[] = [0];
  for (let i = 1; i <= n; i++) {
    if (!owned[i] && docOf[i] > 0) {
      anchors.push(i);
      docAt.push(docOf[i]);
    }
  }
  anchors.push(n + 1);
  docAt.push(doc.length + 1);

  const blocks = sortedBlocks(prepared);
  const groups: Group[] = [];
  let k = 0; // anchor index: blocks[j] lies after anchors[k]
  for (const block of blocks) {
    // The anchor pair (a, z) with a < start and endExclusive <= z.
    while (k + 1 < anchors.length && anchors[k + 1] < block.baseSpan.start) k++;
    const a = anchors[k];
    const z = anchors[k + 1];
    const last = groups[groups.length - 1];
    if (last && last.baseFrom === a) {
      last.blocks.push(block);
      continue;
    }
    groups.push({ blocks: [block], baseFrom: a, baseTo: z - 1, docFrom: docAt[k], docTo: docAt[k + 1] - 1 });
  }
  return groups;
}

/** For each document line, whether it lies inside a conflict (markers included). */
function markerLines(doc: readonly string[]): boolean[] {
  const inside: boolean[] = new Array(doc.length).fill(false);
  let open = -1;
  for (let i = 0; i < doc.length; i++) {
    if (/^<{7}(?: |$)/.test(doc[i])) open = i;
    if (open >= 0) inside[i] = true;
    if (open >= 0 && /^>{7}(?: |$)/.test(doc[i])) open = -1;
  }
  return inside;
}

// ── rendering ────────────────────────────────────────────────────────────────

/** The group's base lines with each block replaced by `each(block)`. */
function render(prepared: PreparedMerge, g: Group, each: (b: ChangeBlock) => string[]): string[] {
  const out: string[] = [];
  let at = g.baseFrom; // 0-based base line
  for (const b of g.blocks) {
    out.push(...prepared.base.slice(at, b.baseSpan.start - 1));
    out.push(...each(b));
    at = b.baseSpan.endExclusive - 1;
  }
  out.push(...prepared.base.slice(at, g.baseTo));
  return out;
}

function lines(all: readonly string[], empty: boolean, span: LineSpan): string[] {
  return empty ? [] : all.slice(span.start - 1, span.endExclusive - 1);
}

function baseOf(p: PreparedMerge, b: ChangeBlock): string[] {
  return lines(p.base, p.baseEmpty, b.baseSpan);
}

function yoursOf(p: PreparedMerge, b: ChangeBlock): string[] {
  return b.left ? lines(p.ours, p.oursEmpty, sideBlockSpan(b, "left")) : baseOf(p, b);
}

function theirsOf(p: PreparedMerge, b: ChangeBlock): string[] {
  return b.right ? lines(p.theirs, p.theirsEmpty, sideBlockSpan(b, "right")) : baseOf(p, b);
}

/** What git writes for a block that is not a conflict: the side that changed it. */
function natural(p: PreparedMerge, b: ChangeBlock): string[] {
  return b.kind === "right-only" ? theirsOf(p, b) : yoursOf(p, b);
}

/** A conflict as diff3 markers, stage 2's side first (see MarkerLabels). */
function markers(p: PreparedMerge, b: ChangeBlock, labels: MarkerLabels): string[] {
  const yours = yoursOf(p, b);
  const theirs = theirsOf(p, b);
  const [first, second] = labels.firstIsYours ? [yours, theirs] : [theirs, yours];
  return [
    `<<<<<<< ${labels.first}`,
    ...first,
    `||||||| ${labels.base ?? "Base"}`,
    ...baseOf(p, b),
    "=======",
    ...second,
    `>>>>>>> ${labels.second}`,
  ];
}

/** The ways a block can be settled in the Result; `natural` = what git itself wrote. */
function candidates(p: PreparedMerge, b: ChangeBlock): Array<{ lines: string[]; natural: boolean }> {
  const yours = yoursOf(p, b);
  const theirs = theirsOf(p, b);
  if (b.kind !== "conflict") return [{ lines: natural(p, b), natural: true }];
  const out = [
    { lines: yours, natural: false },
    { lines: theirs, natural: false },
    { lines: [...yours, ...theirs], natural: false },
    { lines: [...theirs, ...yours], natural: false },
  ];
  if (b.resolvedText !== undefined) out.push({ lines: splitLines(b.resolvedText), natural: false });
  return out;
}

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function startsWith(a: readonly string[], prefix: readonly string[]): boolean {
  return a.length > prefix.length && same(a.slice(0, prefix.length), prefix);
}

function endsWith(a: readonly string[], suffix: readonly string[]): boolean {
  return a.length > suffix.length && same(a.slice(a.length - suffix.length), suffix);
}

/** Join in the result's own line ending (Yours' when the result has none yet). */
function withEol(text: string, result: string, model: MergeModel): string {
  const found = detectEol(result);
  const eol = found === "none" ? model.eol : found;
  return eol === "LF" ? text : text.replace(/\n/g, eolChars(eol));
}
