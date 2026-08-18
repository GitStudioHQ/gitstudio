import {
  computeHunks,
  isEmptyRange,
  rangesIntersect,
  type Hunk,
  type LineRange,
} from "./applyLineChanges";

/**
 * Tri-state staging over whole diff blocks — the model behind a tick beside
 * each change in a diff.
 *
 * WHY BLOCKS AND NOT LINES. `applySelectedChanges` promotes an entire diff block
 * whenever a selected range touches any part of it, so a tick offered per LINE
 * would stage more than it showed. Probed against the engine: original
 * `a b c d e` against modified `a B C D e` is ONE hunk, and selecting only the
 * middle line yields `a B C D e` — all three changed lines staged. The tick
 * therefore spans a block, and the block is the unit the whole model is built on.
 *
 * WHY HEAD ↔ WORKING AND NOT INDEX ↔ WORKING. Tri-state only exists if the index
 * is not one of the two sides. Diffed against the index, every visible change is
 * unstaged by definition, so a tick could never be anything but empty — a
 * checkbox that cannot be checked. Diffing HEAD against the working tree shows
 * every change since the last commit, and the index then decides which of them
 * are already staged.
 */

/** Whether a change block is fully staged, fully unstaged, or a mix of both. */
export type BlockState = "staged" | "unstaged" | "partial";

/**
 * One change since HEAD, and how much of it is currently in the index.
 *
 * Identity is the pair of content-derived ranges, never a position in this
 * array: a block that merely shifted down ten lines because something above it
 * changed is still the same block, and only a block that genuinely no longer
 * exists should be refused.
 */
export interface ChangeBlock {
  /** The block's span in the HEAD text, 0-based inclusive. */
  head: LineRange;
  /** The block's span in the WORKING text, 0-based inclusive. */
  working: LineRange;
  /** How much of this block the index already holds. */
  state: BlockState;
}

/** The lines of `range`, or just its anchor line when it is zero-width. */
function linesOf(range: LineRange): number[] {
  if (isEmptyRange(range)) {
    return [range.start];
  }
  const out: number[] = [];
  for (let l = range.start; l <= range.end; l++) out.push(l);
  return out;
}

/**
 * Whether `parts` together cover every line of `whole`.
 *
 * A zero-width span — a pure deletion, which occupies no line on the modified
 * side — cannot be half-covered, so it is covered exactly when something
 * overlaps it. Treating it by line arithmetic instead would make every deletion
 * report "partial" and give it a tick that could never be filled in.
 */
function fullyCovered(whole: LineRange, parts: LineRange[]): boolean {
  if (parts.length === 0) return false;
  if (isEmptyRange(whole)) return true;
  const seen = new Set<number>();
  for (const p of parts) for (const l of linesOf(p)) seen.add(l);
  for (let l = whole.start; l <= whole.end; l++) {
    if (!seen.has(l)) return false;
  }
  return true;
}

/**
 * Every change between `headText` and `workingText`, each labelled with how much
 * of it the index already holds.
 *
 * Composition only — no new diff maths. Two diffs share the working tree as
 * their modified side, which makes their modified-side ranges directly
 * comparable:
 *
 * - `computeHunks(head, working)` — every change since the last commit.
 * - `computeHunks(index, working)` — precisely what git calls unstaged.
 *
 * A block untouched by the second is already staged; one entirely covered by it
 * is entirely unstaged; anything else is a mix.
 */
export function computeChangeBlocks(
  headText: string,
  indexText: string,
  workingText: string,
): ChangeBlock[] {
  const sinceHead = computeHunks(headText, workingText);
  const unstaged = computeHunks(indexText, workingText);

  return sinceHead.map((block) => {
    const overlapping = unstaged
      .filter((h) => rangesIntersect(h.modified, block.modified))
      .map((h) => h.modified);

    let state: BlockState;
    if (overlapping.length === 0) {
      state = "staged";
    } else if (fullyCovered(block.modified, overlapping)) {
      state = "unstaged";
    } else {
      state = "partial";
    }

    return { head: block.original, working: block.modified, state };
  });
}

/**
 * The working-side ranges to hand `applySelectedChanges(index, working, …)` to
 * stage `block`.
 *
 * Returns only the parts of the block that are actually still unstaged. Passing
 * the block's own span instead would work for a wholly-unstaged block and
 * quietly re-apply already-staged content for a partial one.
 */
export function rangesToStage(
  block: ChangeBlock,
  unstagedHunks: Hunk[],
): LineRange[] {
  return unstagedHunks
    .filter((h) => rangesIntersect(h.modified, block.working))
    .map((h) => h.modified);
}

/**
 * The index-side ranges to hand `applySelectedChanges(index, head, …)` to
 * unstage `block` — the reverse direction, rolling the index back to HEAD for
 * this block alone.
 *
 * `stagedHunks` must be `computeHunks(indexText, headText)`, whose modified side
 * is HEAD, so the returned ranges are HEAD coordinates. Matching is by the
 * block's HEAD span, which is the one coordinate system both diffs share when
 * the working tree is not involved.
 */
export function rangesToUnstage(
  block: ChangeBlock,
  stagedHunks: Hunk[],
): LineRange[] {
  return stagedHunks
    .filter((h) => rangesIntersect(h.modified, block.head))
    .map((h) => h.modified);
}

/** Whether `a` and `b` describe the same change, by content-derived position. */
export function sameBlock(a: ChangeBlock, b: ChangeBlock): boolean {
  return (
    a.head.start === b.head.start &&
    a.head.end === b.head.end &&
    a.working.start === b.working.start &&
    a.working.end === b.working.end
  );
}
