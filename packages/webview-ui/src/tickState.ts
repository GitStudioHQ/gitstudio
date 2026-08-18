import {
  computeChangeBlocks,
  type BlockState,
  type ChangeBlock,
} from "@gitstudio/engine/staging/blockStaging";

/**
 * Tick state per rendered diff block — all of the correctness, none of the
 * rendering, so it can be tested without Monaco or a DOM.
 *
 * The one thing that makes this exact rather than approximate: `computeHunks`
 * maps `buildDiffModel(...).blocks` one-to-one and in order, and
 * `computeChangeBlocks` maps that result one-to-one again. So the i-th tick
 * state belongs to the i-th block the DiffView drew, with no matching heuristic
 * in between — provided the view is showing HEAD on the left and the working
 * tree on the right, which is what staging mode means.
 */

export type { BlockState, ChangeBlock };

export interface TickModel {
  /** One entry per rendered diff block, in render order. */
  blocks: ChangeBlock[];
  /**
   * False when the index text could not be read and every change is therefore
   * being reported as unstaged. Callers show ticks as disabled rather than
   * claiming nothing is staged.
   */
  trustworthy: boolean;
}

/**
 * Tick state for a diff of `headText` (left) against `workingText` (right),
 * given the current `indexText`.
 *
 * `expectedBlocks` is the number of blocks the view actually rendered. If the
 * two disagree the texts have drifted apart from what is on screen — a repaint
 * is in flight, or the caller passed mismatched revisions — and we return no
 * ticks at all rather than pinning states onto the wrong changes.
 */
export function deriveTickStates(
  headText: string,
  indexText: string,
  workingText: string,
  expectedBlocks: number,
): TickModel {
  const blocks = computeChangeBlocks(headText, indexText, workingText);
  if (blocks.length !== expectedBlocks) {
    return { blocks: [], trustworthy: false };
  }
  return { blocks, trustworthy: true };
}

/** The label a screen reader reads for a tick in this state. */
export function tickLabel(state: BlockState): string {
  switch (state) {
    case "staged":
      return "Staged — click to unstage this change";
    case "partial":
      return "Partly staged — click to stage the rest of this change";
    default:
      return "Not staged — click to stage this change";
  }
}

/** The `aria-checked` value for a tri-state checkbox. */
export function ariaChecked(state: BlockState): "true" | "false" | "mixed" {
  if (state === "staged") return "true";
  if (state === "partial") return "mixed";
  return "false";
}

/**
 * What a click on a tick in this state should ask for.
 *
 * A partial block stages the remainder rather than unstaging what is already
 * there: the visible state is "not finished", so the obvious completion is
 * forward. Unstaging a partial block would throw away work the user explicitly
 * staged earlier, which is the more surprising of the two.
 */
export function nextStaged(state: BlockState): boolean {
  return state !== "staged";
}
