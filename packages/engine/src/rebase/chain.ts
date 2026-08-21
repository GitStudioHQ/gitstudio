/**
 * Which commits the Commits list may reorder, and what a drag does to them.
 *
 * Issue #18 asks for interactive rebase driven from the Commits list itself.
 * The obstacle is that the list shows `--all` — every branch, interleaved by
 * topology — so a branch's own commits are usually NOT adjacent on screen:
 *
 *     main-C   <- main          dragging main-C "down one" means dragging it
 *     feat-Y   <- feature       past feat-Y, which belongs to another branch
 *     main-B   <- main          and must not move
 *
 * So a drag is locked to a CHAIN: the first-parent run from HEAD that may
 * legally be rewritten. Rows outside it are inert, and a drop can only land in
 * a gap between two consecutive chain members. That also decides the ambiguous
 * drop the issue raises, before the pointer is released rather than in a dialog
 * afterwards.
 *
 * Pure by design — no git, no DOM. The caller runs
 *   git rev-list --first-parent HEAD --not --remotes
 * and hands the result here; this decides where the chain stops and what a move
 * produces.
 */

/** A commit as the chain builder needs it, in first-parent order from HEAD. */
export interface ChainCommit {
  sha: string;
  /** Parent shas. More than one means a merge commit. */
  parents: readonly string[];
}

/**
 * Why the chain ends where it does — the reason a row below it is inert, which
 * is what the UI puts on the hover.
 */
export type ChainStop =
  /** A merge. A plain `rebase -i` cannot move a commit past one: our todo model
   *  composes six linear verbs and treats label/reset/merge as passthrough, so
   *  the merge would be flattened rather than preserved. */
  | "merge"
  /** The next commit down is already on a remote. Reordering it is a republish,
   *  and that should not begin with a drag. */
  | "published"
  /** Nothing below — the chain reaches the root. */
  | "root";

export interface RewritableChain {
  /** Shas that may be reordered, NEWEST FIRST, matching the Commits list. */
  shas: string[];
  stop: ChainStop;
  /**
   * The commit a rebase would run onto: the first parent of the oldest commit
   * in the chain. Undefined when the chain reaches the root, where the rebase
   * needs `--root` instead.
   */
  base?: string;
}

/**
 * The rewritable chain, given the unpushed first-parent commits from HEAD.
 *
 * `unpushed` must already be filtered to commits absent from every remote —
 * that is `--not --remotes`, and it is what makes "published" the stop reason
 * when the list runs out with history still below it.
 */
export function rewritableChain(
  unpushed: readonly ChainCommit[],
): RewritableChain {
  const shas: string[] = [];
  for (const c of unpushed) {
    if (c.parents.length > 1) {
      // Stop AT the merge, not after it: the merge itself cannot move either.
      return { shas, stop: "merge", base: c.sha };
    }
    shas.push(c.sha);
  }

  // The stop reason is DERIVED, not passed in. If the oldest unpushed commit
  // has a parent, that parent is by definition not unpushed — it would be in
  // this list otherwise — so it is published. No parent means the root. A
  // caller-supplied flag here was one more thing to get wrong for no gain.
  const oldest = unpushed[unpushed.length - 1];
  const base = oldest?.parents[0];
  return { shas, stop: base === undefined ? "root" : "published", base };
}

/** Human wording for why a row cannot be dragged. Shown on hover, not in a dialog. */
export function stopReason(stop: ChainStop): string {
  switch (stop) {
    case "merge":
      return "Reordering stops at a merge — moving a commit past one would flatten it.";
    case "published":
      return "Already pushed. Reordering it would rewrite history other people have.";
    default:
      return "The first commit — there is nothing below it to reorder past.";
  }
}

/**
 * Move the entry at `from` into the gap `to`.
 *
 * Gaps are numbered by the slot they sit ABOVE, so for [A, B, C] gap 0 is above
 * A, gap 1 between A and B, gap 3 below C — n + 1 gaps for n entries. That is
 * the same coordinate an insertion line uses on screen, so the UI can hand its
 * hit-test result straight here without converting.
 *
 * Returns the input unchanged for a move that means nothing (onto itself, or
 * into the gap it already occupies), so callers can compare by identity to
 * decide whether anything needs doing.
 */
export function moveToGap<T>(items: readonly T[], from: number, to: number): T[] {
  if (from < 0 || from >= items.length) return items.slice();
  if (to < 0 || to > items.length) return items.slice();
  // The gap directly above and directly below the item are both no-ops: pulling
  // it out and putting it back in the same place.
  if (to === from || to === from + 1) return items.slice();

  const out = items.slice();
  const [moved] = out.splice(from, 1);
  // Removing shifts every later gap down by one.
  out.splice(to > from ? to - 1 : to, 0, moved);
  return out;
}

/** Whether `moveToGap` would actually change the order. */
export function isRealMove(from: number, to: number): boolean {
  return to !== from && to !== from + 1;
}

/**
 * The gaps a drag may legally target.
 *
 * Every gap within the chain qualifies except the two that would not move the
 * commit at all. The chain is contiguous by construction, so this is a range —
 * but returning the set explicitly keeps the UI from re-deriving the rule and
 * getting it subtly different.
 */
export function legalGaps(chainLength: number, from: number): number[] {
  const gaps: number[] = [];
  for (let g = 0; g <= chainLength; g++) {
    if (isRealMove(from, g)) gaps.push(g);
  }
  return gaps;
}
