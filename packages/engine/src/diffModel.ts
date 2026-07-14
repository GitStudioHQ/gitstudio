import { diffSide, splitLines, type DiffOptions } from "./lineDiff";
import type { DiffBlock, DiffModel } from "./types";

/**
 * Builds a 2-way diff model (left = original, right = modified) by diffing the
 * two texts directly. Left plays the role of "base" and right the role of the
 * changed side, so we reuse the merge engine's `diffSide`: its `baseSpan` is the
 * left span and its `sideSpan` is the right span.
 */
export function buildDiffModel(
  left: string,
  right: string,
  options: DiffOptions = {},
): DiffModel {
  const leftLines = splitLines(left);
  const rightLines = splitLines(right);

  const changes = diffSide(leftLines, rightLines, "right", options);
  const blocks: DiffBlock[] = changes.map((change, index) => ({
    id: index,
    role: change.role,
    leftSpan: change.baseSpan,
    rightSpan: change.sideSpan,
    innerLeft: change.innerBase,
    innerRight: change.innerSide,
  }));

  return { blocks };
}
