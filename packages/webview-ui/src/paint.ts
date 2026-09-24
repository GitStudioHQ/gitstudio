// What colour a change is PAINTED in, and what happened to each of its sides.
//
// The engine's categories stay what they are (conflict / same / yours-only /
// theirs-only — the counts, the legend's numbers, "Apply non-conflicting"
// all read them). The PAINT is simpler, and the owner's: a conflict is red,
// and every other change is coloured by what it did — green added, blue
// changed, grey removed — whether one side made it or both made it alike. A
// change made the same on both sides is simply coloured on BOTH sides, and
// either arrow takes it (JetBrains shows it this way). It once had a violet
// of its own, from the research; the owner found it wrong on sight.
//
// Pure: no Monaco, no DOM.

import type { ChangeBlock, ChangeType, Side } from "@gitstudio/engine/types";
import { category } from "@gitstudio/engine/types";

/** The colours the merge paints with: red for a conflict, else what the change did. */
export type PaintTone = ChangeType | "conflict";

/** Every paint tone, conflict last (drawn over the others where marks crowd). */
export const PAINT_TONES: readonly PaintTone[] = ["deleted", "inserted", "modified", "conflict"];

/** A block's paint: red for a conflict; green / blue / grey by what it did otherwise. */
export function paintTone(block: ChangeBlock): PaintTone {
  if (block.kind === "conflict") return "conflict";
  return block.type === "conflict" ? "modified" : block.type;
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
