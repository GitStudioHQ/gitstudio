import { diffSide, splitLines, type DiffOptions } from "./lineDiff";
import type {
  ChangeBlock,
  LineSpan,
  MergeModel,
  SideChange,
} from "./types";

/**
 * Builds the 3-way merge model from base/ours/theirs by diffing each side
 * against base, then clustering the two change sets over base coordinates:
 * regions where only one side changed are auto-mergeable; regions where both
 * sides changed overlap into a conflict (or "both-same" if identical).
 */
export function buildMergeModel(
  base: string,
  ours: string,
  theirs: string,
  options: DiffOptions = {},
): MergeModel {
  const baseLines = splitLines(base);
  const oursLines = splitLines(ours);
  const theirsLines = splitLines(theirs);

  const left = diffSide(baseLines, oursLines, "left", options);
  const right = diffSide(baseLines, theirsLines, "right", options);

  const clusters = cluster([...left, ...right]);
  const blocks: ChangeBlock[] = clusters.map((items, index) =>
    toBlock(items, index, oursLines, theirsLines),
  );

  let conflicts = 0;
  let autoResolvable = 0;
  for (const block of blocks) {
    if (block.kind === "conflict") {
      conflicts++;
    } else {
      autoResolvable++;
    }
  }

  return {
    blocks,
    counts: { total: blocks.length, conflicts, autoResolvable },
  };
}

/** Groups overlapping/adjacent changes (across sides) into clusters. */
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
 * Whether two base spans should sit in the same block. Overlapping spans
 * connect; an insertion point (empty span) connects to a span it sits within or
 * at the boundary of, and two insertions at the same point connect.
 */
function spansConnected(a: LineSpan, b: LineSpan): boolean {
  const aEmpty = a.start === a.endExclusive;
  const bEmpty = b.start === b.endExclusive;
  if (aEmpty && bEmpty) {
    return a.start === b.start;
  }
  if (aEmpty) {
    return b.start <= a.start && a.start <= b.endExclusive;
  }
  if (bEmpty) {
    return a.start <= b.start && b.start <= a.endExclusive;
  }
  return a.start < b.endExclusive && b.start < a.endExclusive;
}

function joinSpans(a: LineSpan, b: LineSpan): LineSpan {
  return {
    start: Math.min(a.start, b.start),
    endExclusive: Math.max(a.endExclusive, b.endExclusive),
  };
}

function toBlock(
  items: SideChange[],
  index: number,
  oursLines: string[],
  theirsLines: string[],
): ChangeBlock {
  const left = mergeSameSide(items.filter((c) => c.side === "left"));
  const right = mergeSameSide(items.filter((c) => c.side === "right"));

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
  };

  if (left && right) {
    const oursText = sliceLines(oursLines, left.sideSpan);
    const theirsText = sliceLines(theirsLines, right.sideSpan);
    block.kind = oursText === theirsText ? "both-same" : "conflict";
  } else if (left) {
    block.kind = "left-only";
  } else {
    block.kind = "right-only";
  }

  return block;
}

/** Merges multiple same-side changes (rare; from chained clustering) into one. */
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
  return merged;
}

function sliceLines(lines: string[], span: LineSpan): string {
  // span is 1-based, end-exclusive.
  return lines.slice(span.start - 1, span.endExclusive - 1).join("\n");
}
