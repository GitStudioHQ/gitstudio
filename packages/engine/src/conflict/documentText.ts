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
// Typing does not settle a conflict — only taking a side (or both, or the
// wand) does. A line edited, deleted or typed BESIDE an open conflict (the
// Result pane is editable, and the common lines around a conflict are where
// people type) leaves that conflict marked; it once read the whole region as
// "settled by hand" and wrote the conflict's base with no markers (byBlock).
// A region the file had already settled outside its markers when the editor
// opened keeps the file's lines until the Result settles it (KeptRegion).
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
 * A region of the file that was already settled OUTSIDE the conflict markers
 * when the merge editor opened: by hand, by git rerere, or by git's own merge
 * where the engine sees a conflict (seedFromWorking's `keep`).
 */
export interface KeptRegion {
  blockIds: number[];
  baseSpan: LineSpan;
  lines: string[];
}

/**
 * The document text for a Result that may still hold unsettled conflicts
 * (see the file comment). Undefined when the result could not be mapped onto
 * the merge (the diff gave up) — write nothing then.
 *
 * `keep`: regions the file had already settled when the editor opened. While
 * the Result leaves one untouched (still base, the whole span), the document
 * keeps the file's own lines there — a resolution made by hand in a text
 * editor before the merge editor opened existed nowhere else, and the first
 * accept wrote it back as markers. Once the Result settles it, the Result wins.
 */
export function markUnsettled(
  prepared: PreparedMerge,
  result: string,
  labels: MarkerLabels,
  keep: readonly KeptRegion[] = [],
): MarkedDocument | undefined {
  const { model } = prepared;
  if (model.blocks.length === 0) return { text: result, marked: 0, changes: 0 };
  const doc = splitLines(normalizeEol(result));
  const groups = mapGroups(prepared, doc, true);
  if (!groups) return undefined;

  // What each group puts in the document, in doc order.
  const parts: Part[] = [];
  let changes = 0;
  for (const g of groups) {
    const region = doc.slice(g.docFrom, g.docTo);
    const baseRegion = prepared.base.slice(g.baseFrom, g.baseTo);
    const conflicts = g.blocks.filter((b) => b.kind === "conflict").length;
    const part = (lines: string[], marked: number, open = false): void => {
      parts.push({ g, docFrom: g.docFrom, docTo: g.docTo, lines, marked, open });
    };
    const pending = (): string[] =>
      render(prepared, g, (b) => (b.kind === "conflict" ? markers(prepared, b, labels) : natural(prepared, b)));
    if (same(region, baseRegion)) {
      // Nothing settled here: conflicts keep their markers, and a change only
      // one side made (or both made alike) stays as git merged it.
      part(pending(), conflicts, true);
      continue;
    }
    if (g.blocks.length === 1) {
      const b = g.blocks[0];
      const pre = prepared.base.slice(g.baseFrom, b.baseSpan.start - 1);
      const post = prepared.base.slice(b.baseSpan.endExclusive - 1, g.baseTo);
      const settledAs = candidates(prepared, b).find((c) => same(region, [...pre, ...c.lines, ...post]));
      if (settledAs) {
        part(region, 0);
        if (!settledAs.natural) changes++;
        continue;
      }
      // Lines typed right beside a conflict nobody has settled: the conflict is
      // still intact next to them. Keep them, and keep the markers.
      if (baseRegion.length > 0 && !(prepared.baseEmpty && baseRegion.length === 1 && baseRegion[0] === "")) {
        if (endsWith(region, baseRegion)) {
          part([...region.slice(0, region.length - baseRegion.length), ...pending()], conflicts);
          changes++;
          continue;
        }
        if (startsWith(region, baseRegion)) {
          part([...pending(), ...region.slice(baseRegion.length)], conflicts);
          changes++;
          continue;
        }
      }
    }
    // Changed here in a way the blocks do not explain as a whole: an accept,
    // the wand or a hand edit — often to a COMMON line beside them, which
    // settles nothing. Decide block by block (byBlock).
    const settled = byBlock(prepared, g, region, labels);
    if (!settled) return undefined;
    part(settled.lines, settled.marked);
    changes++;
  }

  // A line typed far from every block sits between groups, not in one: it is
  // a change to write all the same.
  let docAt = 0;
  let baseAt = 0;
  for (const p of [...parts, undefined]) {
    const docTo = p ? p.docFrom : doc.length;
    const baseTo = p ? p.g!.baseFrom : prepared.base.length;
    if (!same(doc.slice(docAt, docTo), prepared.base.slice(baseAt, baseTo))) {
      changes++;
      break;
    }
    if (p) {
      docAt = p.docTo;
      baseAt = p.g!.baseTo;
    }
  }

  for (const k of keep) keepRegion(prepared, doc, parts, k);

  const out: string[] = [];
  let at = 0; // next doc line (0-based) not yet copied
  let marked = 0;
  for (const p of parts) {
    out.push(...doc.slice(at, p.docFrom), ...p.lines);
    at = p.docTo;
    marked += p.marked;
  }
  out.push(...doc.slice(at));

  // Always the rendered text, even with nothing to report: a one-sided change
  // the Result has not taken is written as git wrote it, never as base.
  return { text: withEol(out.join("\n"), result, model), marked, changes };
}

/** What one group (or a kept region, which has none) puts in the document: doc lines [docFrom, docTo) → `lines`. */
interface Part {
  g?: Group;
  docFrom: number;
  docTo: number;
  lines: string[];
  /** Conflicts written as markers here. */
  marked: number;
  /** The Result left every block here untouched (still base). */
  open: boolean;
}

/**
 * Put a kept region's own lines in place of the parts it covers — only when
 * every block it holds is still untouched in the Result (its groups all open,
 * nothing else in between) and the Result reads as base across the whole
 * span, so nothing the user did in the merge editor is overruled.
 */
function keepRegion(
  prepared: PreparedMerge,
  doc: readonly string[],
  parts: Part[],
  k: KeptRegion,
): void {
  const from = k.baseSpan.start - 1;
  const to = k.baseSpan.endExclusive - 1;
  const ids = new Set(k.blockIds);
  const covered = parts.filter((p) => p.g && p.g.blocks.some((b) => ids.has(b.id)));
  if (covered.length === 0) return;
  const seen = new Set<number>();
  for (const p of covered) {
    const g = p.g!;
    if (!p.open || g.baseFrom < from || g.baseTo > to) return;
    for (const b of g.blocks) {
      if (!ids.has(b.id)) return;
      seen.add(b.id);
    }
  }
  if (seen.size !== ids.size) return;
  const first = covered[0];
  const last = covered[covered.length - 1];
  const docFrom = first.docFrom - (first.g!.baseFrom - from);
  const docTo = last.docTo + (to - last.g!.baseTo);
  if (docFrom < 0 || docTo > doc.length || !same(doc.slice(docFrom, docTo), prepared.base.slice(from, to))) return;
  const i = parts.indexOf(first);
  const j = parts.indexOf(last);
  if (parts.slice(i, j + 1).some((p) => !covered.includes(p))) return;
  if ((i > 0 && parts[i - 1].docTo > docFrom) || (j + 1 < parts.length && parts[j + 1].docFrom < docTo)) return;
  parts.splice(i, j - i + 1, { docFrom, docTo, lines: [...k.lines], marked: 0, open: false });
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
 *
 * `strict` (markUnsettled): a region edited by hand ends only where the diff
 * finds the next chunk too (see mapByChunks). The seed reads the conflicted
 * file itself, whose diff3 markers repeat base lines the diff pairs with, so
 * it walks as before.
 */
function mapGroups(prepared: PreparedMerge, doc: readonly string[], strict = false): Group[] | undefined {
  return mapByChunks(prepared, doc, strict) ?? mapByDiff(prepared, doc);
}

function mapByChunks(prepared: PreparedMerge, doc: readonly string[], strict: boolean): Group[] | undefined {
  const base = prepared.base;
  const blocks = sortedBlocks(prepared);
  // chunk[i] = the common lines before blocks[i]; chunk[n] = after the last one.
  const chunkFrom = (i: number): number => (i === 0 ? 0 : blocks[i - 1].baseSpan.endExclusive - 1);
  const chunk = (i: number): readonly string[] =>
    base.slice(chunkFrom(i), i === blocks.length ? base.length : blocks[i].baseSpan.start - 1);
  // The diff's match for each base line, computed only if a region was edited by hand.
  let matched: Int32Array | null | undefined;
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
      // Edited by hand: the region runs to where the next common chunk starts —
      // where the DIFF finds that chunk too. A chunk that was itself edited (a
      // common line beside a conflict) turns up again only by chance, further
      // down (a blank line, a lone brace), and a region stretched to it would
      // swallow the blocks in between: the diff's anchors decide then. So does
      // an empty chunk, which marks no place at all.
      if (strict && next.length === 0 && !last) return undefined;
      const q = last ? doc.length - next.length : indexOfRun(doc, next, pos);
      if (q < pos || !fits(q - pos)) return undefined;
      if (strict && next.length > 0) {
        if (matched === undefined) matched = matchLines(base, doc) ?? null;
        if (!matched || matched[chunkFrom(i + 1)] !== q) return undefined;
      }
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
/**
 * For each line of `from` (0-based), the line of `to` the diff matched it to,
 * or -1. Undefined when the diff timed out.
 */
function matchLines(from: readonly string[], to: readonly string[]): Int32Array | undefined {
  const at = new Int32Array(from.length).fill(-1);
  // The diff wants a line on each side (a text model always has one).
  if (from.length === 0 || to.length === 0) return at;
  let diff: ReturnType<ReturnType<typeof linesDiffComputers.getDefault>["computeDiff"]>;
  try {
    diff = linesDiffComputers.getDefault().computeDiff(from as string[], to as string[], {
      ignoreTrimWhitespace: false,
      maxComputationTimeMs: 5000,
      computeMoves: false,
    });
  } catch {
    return undefined;
  }
  const { changes, hitTimeout } = diff;
  if (hitTimeout) return undefined;
  let f = 0;
  let t = 0;
  const equalUntil = (fEnd: number, tEnd: number): void => {
    while (f < fEnd && t < tEnd) at[f++] = t++;
  };
  for (const c of changes) {
    equalUntil(c.original.startLineNumber - 1, c.modified.startLineNumber - 1);
    f = c.original.endLineNumberExclusive - 1;
    t = c.modified.endLineNumberExclusive - 1;
  }
  equalUntil(from.length, to.length);
  return at;
}

function mapByDiff(prepared: PreparedMerge, doc: readonly string[]): Group[] | undefined {
  const base = prepared.base;
  const n = base.length;
  const matched = matchLines(base, doc);
  if (!matched) return undefined;
  // docOf[i] = the document line (1-based) base line i (1-based) is matched to, or 0.
  const docOf = new Int32Array(n + 2);
  for (let i = 0; i < n; i++) docOf[i + 1] = matched[i] + 1;

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

/**
 * A group's region the blocks do not explain as a whole, block by block.
 * Typing does not settle a conflict — only taking a side (or both, or the
 * wand) does — so the region's lines stand except where a block was plainly
 * left alone:
 *
 * - a block with base lines is left alone when the diff finds all of them,
 *   in a row, in the region: a conflict is written as markers there, a
 *   one-sided change as git merged it;
 * - a block with none (both sides inserted at one spot) is left alone unless
 *   one of the ways to settle it sits at that spot, between the base lines
 *   found on either side of it. A conflict is marked there, beside anything
 *   typed; a one-sided insertion is written as git merged it only when
 *   nothing at all was typed there.
 *
 * Undefined when the diff timed out.
 */
function byBlock(
  p: PreparedMerge,
  g: Group,
  region: readonly string[],
  labels: MarkerLabels,
): { lines: string[]; marked: number } | undefined {
  // Base as the view holds it: an empty base has no lines at all.
  const baseRegion = p.baseEmpty ? [] : p.base.slice(g.baseFrom, g.baseTo);
  const found = matchLines(baseRegion, region);
  if (!found) return undefined;
  const edits: Array<{ from: number; to: number; lines: string[] }> = [];
  let marked = 0;
  for (const b of g.blocks) {
    const s = p.baseEmpty ? 0 : b.baseSpan.start - 1 - g.baseFrom;
    const e = p.baseEmpty ? 0 : b.baseSpan.endExclusive - 1 - g.baseFrom;
    const open = (): string[] => {
      if (b.kind !== "conflict") return natural(p, b);
      marked++;
      return markers(p, b, labels);
    };
    if (e > s) {
      const at = found[s];
      let intact = at >= 0;
      for (let k = s + 1; k < e && intact; k++) intact = found[k] === at + (k - s);
      if (intact) edits.push({ from: at, to: at + (e - s), lines: open() });
      continue;
    }
    // No base lines: what sits between the base lines found on either side?
    let l = s - 1;
    while (l >= 0 && found[l] < 0) l--;
    let r = s;
    while (r < baseRegion.length && found[r] < 0) r++;
    const gapFrom = l >= 0 ? found[l] + 1 : 0;
    let gapTo = r < baseRegion.length ? found[r] : region.length;
    // An empty base's region ends with the file's last line break, not a line.
    if (p.baseEmpty && gapTo > gapFrom && region[gapTo - 1] === "") gapTo--;
    const gap = region.slice(gapFrom, gapTo);
    const taken = candidates(p, b).some((c) => {
      const lines = p.baseEmpty && c.lines[c.lines.length - 1] === "" ? c.lines.slice(0, -1) : c.lines;
      return lines.length > 0 && containsRun(gap, lines);
    });
    if (taken || (b.kind !== "conflict" && gap.length > 0)) continue;
    // Right after the base line before it when only the line after it was
    // edited; otherwise right before the line after it — so after anything
    // typed at the spot itself.
    const before = s > 0 ? found[s - 1] : -1;
    const afterIntact = s < baseRegion.length && found[s] >= 0;
    const place = before >= 0 && !afterIntact ? before + 1 : gapTo;
    edits.push({ from: place, to: place, lines: open() });
  }
  const out: string[] = [];
  let at = 0;
  for (const edit of edits.sort((x, y) => x.from - y.from || x.to - y.to)) {
    if (edit.from < at) return undefined; // overlapping reads: never guess
    out.push(...region.slice(at, edit.from), ...edit.lines);
    at = edit.to;
  }
  out.push(...region.slice(at));
  return { lines: out, marked };
}

/** Whether `run` (non-empty) occurs in `lines`, in a row. */
function containsRun(lines: readonly string[], run: readonly string[]): boolean {
  return indexOfRun(lines, run, 0) >= 0;
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
