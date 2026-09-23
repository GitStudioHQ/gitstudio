import {
  detectEol,
  diffSide,
  linesEqual,
  normalizeEol,
  splitLines,
  type DiffOptions,
  type WhitespaceMode,
} from "./lineDiff";
import type {
  ChangeBlock,
  ChangeRole,
  ChangeType,
  EolMismatch,
  LineEnding,
  LineSpan,
  MergeModel,
  SideChange,
} from "./types";
import { isEmptySpan, sideBlockSpan } from "./types";

/**
 * Builds the 3-way merge model from base/ours/theirs by diffing each side
 * against base, then clustering the two change sets over base coordinates, and
 * classifying each cluster the way JetBrains does (MergeRangeUtil.getMergeType):
 *
 * 1. Line endings are normalised first (`\r\n?` → `\n`). The result is written
 *    back with Yours' dominant ending (`eol`); `eolMismatch` says when the
 *    sides disagree.
 * 2. Emptiness is judged on the DOCUMENT: "" has no lines, whatever
 *    `splitLines("")`'s phantom line says.
 * 3. With a whitespace-ignoring mode, lines that differ only in whitespace are
 *    still reported, flagged `whitespaceOnly` — never silently dropped.
 * 4. Touching spans join (base 2–3 and 3–4 are one block), as git and
 *    JetBrains both chunk them: adjacent edits are one conflict, not two
 *    independent changes.
 * 5. Sides are compared over their FULL block regions (`sideBlockSpan`), not
 *    only their change hunks, so "both made the same edit" really means the
 *    two versions of the region are the same.
 */
export function buildMergeModel(
  base: string,
  ours: string,
  theirs: string,
  options: DiffOptions = {},
): MergeModel {
  const eolYours = detectEol(ours);
  const eolTheirs = detectEol(theirs);
  const eolBase = detectEol(base);
  const eol: LineEnding =
    eolYours !== "none"
      ? eolYours
      : eolTheirs !== "none"
        ? eolTheirs
        : eolBase !== "none"
          ? eolBase
          : "LF";
  const eolMismatch: EolMismatch | undefined =
    eolYours !== "none" && eolTheirs !== "none" && eolYours !== eolTheirs
      ? { yours: eolYours, theirs: eolTheirs, result: eol }
      : undefined;

  const baseText = normalizeEol(base);
  const oursText = normalizeEol(ours);
  const theirsText = normalizeEol(theirs);
  const docs: Documents = {
    base: splitLines(baseText),
    ours: splitLines(oursText),
    theirs: splitLines(theirsText),
    baseEmpty: baseText === "",
    oursEmpty: oursText === "",
    theirsEmpty: theirsText === "",
    mode: options.whitespace ?? "none",
  };

  const sideOptions: DiffOptions = { ...options, whitespaceOnlyChanges: true };
  const left = diffSide(docs.base, docs.ours, "left", sideOptions);
  const right = diffSide(docs.base, docs.theirs, "right", sideOptions);

  const clusters = cluster([...left, ...right]);
  const blocks: ChangeBlock[] = clusters.map((items, index) =>
    toBlock(items, index, docs),
  );

  let conflicts = 0;
  let autoResolvable = 0;
  let identical = 0;
  let resolvableConflicts = 0;
  for (const block of blocks) {
    if (block.kind === "conflict") {
      conflicts++;
      if (block.resolvable) {
        resolvableConflicts++;
      }
    } else {
      autoResolvable++;
      if (block.kind === "both-same") {
        identical++;
      }
    }
  }

  return {
    blocks,
    counts: {
      total: blocks.length,
      conflicts,
      autoResolvable,
      identical,
      resolvableConflicts,
    },
    eol,
    eolMismatch,
  };
}

/** The three normalised documents a model is built from. */
interface Documents {
  base: string[];
  ours: string[];
  theirs: string[];
  /** The document is "" — no lines at all (splitLines still returns [""]). */
  baseEmpty: boolean;
  oursEmpty: boolean;
  theirsEmpty: boolean;
  mode: WhitespaceMode;
}

/** Groups overlapping/touching changes (across sides) into clusters. */
function cluster(changes: SideChange[]): SideChange[][] {
  const sorted = [...changes].sort(
    (a, b) =>
      a.baseSpan.start - b.baseSpan.start ||
      a.baseSpan.endExclusive - b.baseSpan.endExclusive,
  );

  const clusters: SideChange[][] = [];
  let current: SideChange[] = [];
  let union: LineSpan | undefined;

  for (const change of sorted) {
    if (union && spansConnected(union, change.baseSpan)) {
      current.push(change);
      union = joinSpans(union, change.baseSpan);
    } else {
      if (current.length) {
        clusters.push(current);
      }
      current = [change];
      union = change.baseSpan;
    }
  }
  if (current.length) {
    clusters.push(current);
  }
  return clusters;
}

/**
 * Whether a change (sorted by start) belongs to the running union: it overlaps
 * it or TOUCHES it. Base 2–3 and 3–4 share the boundary at line 3 and join, as
 * they do in git and JetBrains — an edit to line 2 and an edit to line 3 are
 * one region whose two versions have to be reconciled, not two independent
 * changes to apply blindly. An insertion point (empty span) joins a span it
 * sits within or at the boundary of; two insertions at one point join.
 */
function spansConnected(union: LineSpan, next: LineSpan): boolean {
  return next.start <= union.endExclusive && union.start <= next.endExclusive;
}

/**
 * Whether two edits (on different sides) collide: they overlap, or both insert
 * at the same point (whose order nobody can decide). Touching does not collide:
 * an insertion AT the start or end of a modified span has a well-defined place.
 */
function spansCollide(a: LineSpan, b: LineSpan): boolean {
  const aEmpty = isEmptySpan(a);
  const bEmpty = isEmptySpan(b);
  if (aEmpty && bEmpty) {
    return a.start === b.start;
  }
  if (aEmpty) {
    return b.start < a.start && a.start < b.endExclusive;
  }
  if (bEmpty) {
    return a.start < b.start && b.start < a.endExclusive;
  }
  return a.start < b.endExclusive && b.start < a.endExclusive;
}

function joinSpans(a: LineSpan, b: LineSpan): LineSpan {
  return {
    start: Math.min(a.start, b.start),
    endExclusive: Math.max(a.endExclusive, b.endExclusive),
  };
}

function toBlock(items: SideChange[], index: number, docs: Documents): ChangeBlock {
  const byBase = (a: SideChange, b: SideChange): number =>
    a.baseSpan.start - b.baseSpan.start ||
    // An insertion at a point comes before a change that starts there.
    Number(!isEmptySpan(a.baseSpan)) - Number(!isEmptySpan(b.baseSpan));
  const leftItems = items.filter((c) => c.side === "left").sort(byBase);
  const rightItems = items.filter((c) => c.side === "right").sort(byBase);
  const left = mergeSameSide(leftItems);
  const right = mergeSameSide(rightItems);

  let baseSpan: LineSpan | undefined;
  for (const item of items) {
    baseSpan = baseSpan ? joinSpans(baseSpan, item.baseSpan) : item.baseSpan;
  }

  const block: ChangeBlock = {
    id: index,
    kind: "left-only",
    baseSpan: baseSpan ?? { start: 1, endExclusive: 1 },
    left,
    right,
    type: "modified",
  };

  // The three versions of the region. An empty DOCUMENT has no lines, even
  // though splitLines("") hands back one empty one.
  const baseRegion = docs.baseEmpty ? [] : slice(docs.base, block.baseSpan);
  const leftRegion = !left
    ? baseRegion
    : docs.oursEmpty
      ? []
      : slice(docs.ours, sideBlockSpan(block, "left"));
  const rightRegion = !right
    ? baseRegion
    : docs.theirsEmpty
      ? []
      : slice(docs.theirs, sideBlockSpan(block, "right"));

  const baseEmpty = baseRegion.length === 0;
  const leftEmpty = leftRegion.length === 0;
  const rightEmpty = rightRegion.length === 0;
  if (left) {
    block.leftType = changeType(baseEmpty, leftEmpty);
  }
  if (right) {
    block.rightType = changeType(baseEmpty, rightEmpty);
  }

  if (left && right) {
    if (linesEqual(leftRegion, rightRegion, docs.mode)) {
      // Both sides made the same change — exactly, or up to whitespace.
      block.kind = "both-same";
      block.type = baseEmpty ? "inserted" : leftEmpty && rightEmpty ? "deleted" : "modified";
      block.exact = linesEqual(leftRegion, rightRegion, "none");
    } else {
      block.kind = "conflict";
      block.type = "conflict";
      const collide = leftItems.some((l) =>
        rightItems.some((r) => spansCollide(l.baseSpan, r.baseSpan)),
      );
      block.resolvable = !leftEmpty && !rightEmpty && !collide;
      if (block.resolvable) {
        block.resolvedText = applyBoth(block.baseSpan, [...leftItems, ...rightItems], docs);
      }
    }
  } else if (left) {
    block.kind = "left-only";
    block.type = block.leftType as ChangeRole;
  } else {
    block.kind = "right-only";
    block.type = block.rightType as ChangeRole;
  }

  if (items.every((c) => c.whitespaceOnly)) {
    block.whitespaceOnly = true;
  }
  return block;
}

/** What a side did to a region, from the region's emptiness before and after. */
function changeType(baseEmpty: boolean, sideEmpty: boolean): ChangeType {
  if (baseEmpty && !sideEmpty) {
    return "inserted";
  }
  if (!baseEmpty && sideEmpty) {
    return "deleted";
  }
  return "modified";
}

/**
 * The base region with every edit of both sides applied, in base order. Only
 * called when no two edits collide, so each base line is either kept or
 * replaced by exactly one side.
 */
function applyBoth(region: LineSpan, edits: SideChange[], docs: Documents): string {
  const ordered = [...edits].sort(
    (a, b) =>
      a.baseSpan.start - b.baseSpan.start ||
      Number(!isEmptySpan(a.baseSpan)) - Number(!isEmptySpan(b.baseSpan)),
  );
  const out: string[] = [];
  let cursor = region.start;
  for (const edit of ordered) {
    out.push(...docs.base.slice(cursor - 1, Math.max(cursor, edit.baseSpan.start) - 1));
    const lines = edit.side === "left" ? docs.ours : docs.theirs;
    out.push(...lines.slice(edit.sideSpan.start - 1, edit.sideSpan.endExclusive - 1));
    cursor = Math.max(cursor, edit.baseSpan.endExclusive);
  }
  out.push(...docs.base.slice(cursor - 1, region.endExclusive - 1));
  return out.join("\n");
}

/** Merges multiple same-side changes (from chained clustering) into one. */
function mergeSameSide(changes: SideChange[]): SideChange | undefined {
  if (changes.length === 0) {
    return undefined;
  }
  if (changes.length === 1) {
    return changes[0];
  }
  const sorted = [...changes].sort(
    (a, b) => a.sideSpan.start - b.sideSpan.start,
  );
  const merged: SideChange = {
    side: sorted[0].side,
    role: "modified",
    baseSpan: sorted.reduce<LineSpan>(
      (acc, c) => joinSpans(acc, c.baseSpan),
      sorted[0].baseSpan,
    ),
    sideSpan: sorted.reduce<LineSpan>(
      (acc, c) => joinSpans(acc, c.sideSpan),
      sorted[0].sideSpan,
    ),
    innerBase: sorted.flatMap((c) => c.innerBase),
    innerSide: sorted.flatMap((c) => c.innerSide),
  };
  if (sorted.every((c) => c.whitespaceOnly)) {
    merged.whitespaceOnly = true;
  }
  return merged;
}

/** Lines of a 1-based, end-exclusive span. */
function slice(lines: string[], span: LineSpan): string[] {
  return lines.slice(span.start - 1, span.endExclusive - 1);
}
