// What colour a change is PAINTED in, and what happened to each of its sides.
//
// The paint is the DECISION a change needs, never what it did (the owner, 24
// Sep 2026: a change made the same on both sides was blue one time and green
// the next, and blue also meant "one side only" — so the colour did not
// answer "does my choice matter here?"):
//
// - RED, a conflict: the sides differ, you choose;
// - GREEN, the same change on both sides — whether lines were added, changed
//   or removed: nothing to choose, either arrow takes the whole block;
// - BLUE, a change on one side only — whether added, changed or removed:
//   safe to take.
//
// What a change DID stays readable without a colour of its own: from the
// shape of its band (a band that meets a line between two rows on the other
// side was added there, or removed) and from its word highlights. The engine
// owns the rule (`blockTone`); this module is the view's name for it.
//
// Pure: no Monaco, no DOM.

import type { BlockTone, ChangeBlock, Side } from "@gitstudio/engine/types";
import { blockTone, category } from "@gitstudio/engine/types";

/** The three colours the merge paints with: red, green, blue — by decision. */
export type PaintTone = BlockTone;

/** Every paint tone, conflict last (drawn over the others where marks crowd). */
export const PAINT_TONES: readonly PaintTone[] = ["one-sided", "same", "conflict"];

/** A block's paint: red for a conflict, green for the same change on both sides, blue for one side only. */
export function paintTone(block: ChangeBlock): PaintTone {
  return blockTone(block);
}

/**
 * What became of one side of a change:
 * - "pending": still to decide (its band, its ribbon and its controls);
 * - "took": its text went into the Result (Accept, Add after, the wand, a
 *   whole-file Accept) — it keeps a muted band and its ribbon to the Result;
 * - "discarded": set aside (×, or the other side taken by a whole-file
 *   Accept) — an outline only, and no ribbon.
 */
export type SideFate = "pending" | "took" | "discarded";

/** The words a trace says, for a tooltip and a screen reader. */
export function fateWords(
  block: ChangeBlock,
  fates: { left?: SideFate; right?: SideFate },
  names: { left: string; right: string },
): { left?: string; right?: string; result?: string } {
  const out: { left?: string; right?: string; result?: string } = {};
  const same = category(block) === "same";
  const word = (side: Side, fate: SideFate | undefined): string | undefined => {
    if (!fate || fate === "pending") return undefined;
    if (same) return fate === "took" ? "Took the change (the same on both sides)" : "Discarded the change (the same on both sides)";
    return `${fate === "took" ? "Took" : "Discarded"} ${side === "left" ? names.left : names.right}`;
  };
  out.left = word("left", fates.left);
  out.right = word("right", fates.right);
  const pendingSide = fates.left === "pending" || fates.right === "pending";
  if (!pendingSide) {
    const tookLeft = fates.left === "took";
    const tookRight = fates.right === "took";
    const both = fates.left !== undefined && fates.right !== undefined;
    out.result = same
      ? tookLeft || tookRight
        ? "Took the change (the same on both sides)"
        : "Discarded the change (the same on both sides): the Result keeps the original"
      : tookLeft && tookRight
        ? "Took both"
        : tookLeft
          ? `Took ${names.left}`
          : tookRight
            ? `Took ${names.right}`
            : both
              ? "Discarded both: the Result keeps the original"
              : `Discarded ${fates.left ? names.left : names.right}: the Result keeps the original`;
  }
  return out;
}
