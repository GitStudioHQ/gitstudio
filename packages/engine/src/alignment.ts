// Pure computation of spacer view-zones that pad each pane's change blocks so
// corresponding unchanged lines sit at the same vertical position across the
// three panes. No monaco import => unit-testable.

import type {
  ChangeBlock,
  DiffModel,
  LineSpan,
  MergeModel,
  SideChange,
} from "./types";

export interface Spacer {
  /** Monaco afterLineNumber (0 = top of the editor). */
  afterLineNumber: number;
  /** Number of blank lines' worth of height to insert. */
  lines: number;
}

export interface AlignmentZones {
  left: Spacer[];
  result: Spacer[];
  right: Spacer[];
}

export interface DiffAlignmentZones {
  left: Spacer[];
  right: Spacer[];
}

/**
 * For every block, the aligned height is the tallest of the three panes'
 * versions of that block; shorter panes get a spacer to match, which realigns
 * everything below the block.
 *
 * `resultSpanOf` supplies the block's CURRENT span in the (editable) result
 * document — accepts and manual edits change result block heights, and the
 * spacers must track them or every row below drifts out of alignment. When
 * omitted, the base span is used (the result starts as a copy of base).
 */
export function computeAlignmentZones(
  model: MergeModel,
  resultSpanOf?: (block: ChangeBlock) => LineSpan,
): AlignmentZones {
  const zones: AlignmentZones = { left: [], result: [], right: [] };

  // Running line-number offset of each side relative to base (from prior blocks).
  let leftOffset = 0;
  let rightOffset = 0;

  for (const block of model.blocks) {
    const resultSpan = resultSpanOf?.(block) ?? block.baseSpan;
    const resultStart = resultSpan.start;
    const resultHeight = resultSpan.endExclusive - resultSpan.start;

    const left = placeSide(block.left, block.baseSpan, leftOffset);
    const right = placeSide(block.right, block.baseSpan, rightOffset);

    const aligned = Math.max(left.height, resultHeight, right.height);

    addSpacer(zones.left, left.start, left.height, aligned - left.height);
    addSpacer(zones.result, resultStart, resultHeight, aligned - resultHeight);
    addSpacer(zones.right, right.start, right.height, aligned - right.height);

    // Each side's offset tracks ITS OWN net line change (added − removed), not
    // the union block height — a clustered block can be taller than what this
    // side actually touched (see placeSide).
    leftOffset += left.delta;
    rightOffset += right.delta;
  }

  return zones;
}

interface SidePlacement {
  /** First line of the block region in the side's own document coordinates. */
  start: number;
  /** Height of the block region in the side, INCLUDING passthrough lines. */
  height: number;
  /** Net lines this side added (+) or removed (−) vs base in this block. */
  delta: number;
}

/**
 * A block's `baseSpan` is the UNION of both sides' changes, so it can cover
 * base lines that THIS side never touched. Those passthrough lines still exist
 * verbatim in the side's document and count toward its block height — counting
 * only `sideSpan` undercounts the side and leaks a spurious spacer, which (with
 * pixel-locked scroll sync) makes the panes drift apart further down the file.
 */
function placeSide(
  change: SideChange | undefined,
  baseSpan: LineSpan,
  offset: number,
): SidePlacement {
  const baseHeight = baseSpan.endExclusive - baseSpan.start;
  if (!change) {
    // Untouched across the whole region: maps 1:1 from base via the offset.
    return { start: baseSpan.start + offset, height: baseHeight, delta: 0 };
  }
  const sideBaseHeight = change.baseSpan.endExclusive - change.baseSpan.start;
  const sideHeight = change.sideSpan.endExclusive - change.sideSpan.start;
  // Passthrough lines between the union start and where this side's own change
  // begins — they sit above the change in the side's coordinates.
  const leadIn = change.baseSpan.start - baseSpan.start;
  return {
    start: change.sideSpan.start - leadIn,
    height: baseHeight - sideBaseHeight + sideHeight,
    delta: sideHeight - sideBaseHeight,
  };
}

/**
 * 2-pane variant: for every diff block, the shorter of the left/right versions
 * gets a spacer so the unchanged lines below it line up across both panes.
 */
export function computeDiffAlignment(model: DiffModel): DiffAlignmentZones {
  const zones: DiffAlignmentZones = { left: [], right: [] };

  for (const block of model.blocks) {
    const leftHeight = block.leftSpan.endExclusive - block.leftSpan.start;
    const rightHeight = block.rightSpan.endExclusive - block.rightSpan.start;
    const aligned = Math.max(leftHeight, rightHeight);

    addSpacer(zones.left, block.leftSpan.start, leftHeight, aligned - leftHeight);
    addSpacer(
      zones.right,
      block.rightSpan.start,
      rightHeight,
      aligned - rightHeight,
    );
  }

  return zones;
}

function addSpacer(
  target: Spacer[],
  paneStart: number,
  paneHeight: number,
  extraLines: number,
): void {
  if (extraLines <= 0) {
    return;
  }
  // Anchor after the block's last line, or at the insertion gap if empty.
  const afterLineNumber =
    paneHeight > 0 ? paneStart + paneHeight - 1 : paneStart - 1;
  target.push({ afterLineNumber: Math.max(afterLineNumber, 0), lines: extraLines });
}
