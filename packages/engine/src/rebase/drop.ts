/**
 * Drop Commit (issue #32): take one commit out of the current branch and
 * replay the ones after it.
 *
 * It is the drag-to-reorder chain (chain.ts) with that one commit set to
 * `drop` — the same first-parent run from HEAD, the same rule that a merge
 * cannot be replayed past — with one difference: a PUBLISHED commit is not a
 * stop here. Reordering refuses to begin a republish with a drag; dropping is
 * a menu item and a confirmation, so it is allowed, and the confirmation says
 * plainly that it rewrites pushed history (`publishedWarning`).
 *
 * Pure by design — no git, no DOM. The caller runs
 *   git rev-list --first-parent HEAD
 * and hands the result here; this decides whether the commit can be dropped
 * and what gets replayed.
 */

import { publishedWarning, type ChainCommit } from "./chain";

/** Why a commit cannot be dropped — what the menu leaves the item out for. */
export type DropRefusal =
  /** Not an ancestor of HEAD: there is nothing to drop it FROM. */
  | "not-on-branch"
  /** The commit is a merge. Removing one with a linear todo would flatten it. */
  | "merge"
  /** A merge sits between the commit and HEAD, and replaying past it would
   *  flatten that merge. */
  | "past-merge"
  /** The only commit on the branch: dropping it would leave nothing. */
  | "only-commit"
  /** Further down than the walk looked — more replaying than one menu item
   *  should start. */
  | "too-far";

export type DropTarget =
  | {
      ok: true;
      /** The commits AFTER the dropped one, newest first. These are replayed. */
      later: string[];
      /**
       * The dropped commit's parent — what the rebase runs onto. Undefined for
       * the root commit, where the rebase needs `--root` instead (verified
       * against git 2.49: the next commit becomes the new root).
       */
      base?: string;
    }
  | { ok: false; reason: DropRefusal };

/**
 * Can `sha` be dropped, given HEAD's first-parent history (newest first)?
 *
 * `capped` says the walk stopped at a length limit rather than at the root,
 * so a commit it never reached may be further down rather than absent.
 */
export function dropTarget(
  firstParent: readonly ChainCommit[],
  sha: string,
  opts: { capped?: boolean } = {},
): DropTarget {
  const later: string[] = [];
  for (let i = 0; i < firstParent.length; i++) {
    const c = firstParent[i];
    const merge = c.parents.length > 1;
    if (c.sha === sha) {
      if (merge) return { ok: false, reason: "merge" };
      // The root AND the tip: nothing would be left on the branch at all.
      // git will run that rebase, and leaves the branch on an empty commit.
      if (c.parents.length === 0 && i === 0) return { ok: false, reason: "only-commit" };
      return { ok: true, later, base: c.parents[0] };
    }
    // Stop AT a merge above the target, as the reorder chain does: the commits
    // above the target would be replayed across it, which flattens it.
    if (merge) return { ok: false, reason: "past-merge" };
    later.push(c.sha);
  }
  return { ok: false, reason: opts.capped ? "too-far" : "not-on-branch" };
}

/** Why the item is not offered, in words — shown when a stale menu is used. */
export function dropRefusalMessage(reason: DropRefusal): string {
  switch (reason) {
    case "not-on-branch":
      return "That commit isn't on the current branch, so there's nothing to drop it from.";
    case "merge":
      return "That's a merge commit — dropping it would flatten the history it joined. Revert it instead.";
    case "past-merge":
      return "There's a merge between that commit and the tip of the branch — replaying the commits after it would flatten the merge.";
    case "only-commit":
      return "That's the only commit on the branch — dropping it would leave nothing.";
    case "too-far":
      return "That commit is too far down the branch to drop from here. Start an interactive rebase from it instead.";
  }
}

/** What the confirmation needs to say about a drop. */
export interface DropSummary {
  shortSha: string;
  subject: string;
  /** How many commits after the dropped one are replayed on top. */
  replayed: number;
  /** Already on a remote, so dropping it rewrites pushed history. */
  published: boolean;
  /** The branch it is dropped from; null on a detached HEAD. */
  branch: string | null;
  /** Other local branches pointing at a replayed commit (the carry question). */
  carryable?: readonly string[];
}

/**
 * The confirmation, in words: which commit, from where, how many later
 * commits are replayed — and, for a pushed commit, that this rewrites history
 * others have and the next push must be forced. Shared by both products so the
 * extension's dialog and the desktop's say the same thing.
 */
export function dropQuestion(s: DropSummary): { title: string; message: string } {
  const what = s.subject ? `${s.shortSha} "${s.subject}"` : s.shortSha;
  const parts = [`${what} is removed from ${s.branch ?? "the detached HEAD"}.`];
  parts.push(
    s.replayed === 0
      ? "It's the newest commit, so nothing else is replayed."
      : s.replayed === 1
        ? "The 1 commit after it is replayed on top, so it gets a new identity."
        : `The ${s.replayed} commits after it are replayed on top, so they get new identities.`,
  );
  const carry = s.carryable ?? [];
  if (carry.length > 0) {
    const names = carry.slice(0, 3).join(", ") + (carry.length > 3 ? ` and ${carry.length - 3} more` : "");
    parts.push(`${names} ${carry.length === 1 ? "points" : "point"} at a commit that is replayed.`);
  }
  if (s.published) {
    parts.push(`${publishedWarning("Dropping")} The next push will need to be a force push.`);
  }
  parts.push("Undo is available afterwards.");
  return { title: `Drop ${s.shortSha}?`, message: parts.join(" ") };
}

/** A rebase outcome, as much of it as the words need (the runner's shape). */
export interface DropOutcomeLike {
  status: "done" | "stopped" | "failed";
  reason?: string;
  message?: string;
  /** A refusal over the user's own state — its sentence already says it all. */
  expected?: boolean;
}

/**
 * How a drop ended, in words — the same sentence in both products.
 *
 * A stop is not a failure: a later commit that touched what the dropped one
 * changed conflicts when it is replayed, and git leaves the rebase open. The
 * product's conflict flow takes it from there, and abort is the way back.
 */
export function dropOutcomeMessage(shortSha: string, outcome: DropOutcomeLike): string {
  if (outcome.status === "done") {
    return `Dropped ${shortSha}.`;
  }
  if (outcome.status === "stopped") {
    return outcome.reason === "conflict"
      ? `Dropping ${shortSha} hit a conflict while replaying a later commit. Resolve it and continue the rebase — or skip that commit, or abort to put the branch back as it was.`
      : `Dropping ${shortSha} stopped and needs you — continue the rebase, or abort it to put the branch back as it was.`;
  }
  if (!outcome.message) {
    return `Couldn't drop ${shortSha}.`;
  }
  // "You have uncommitted changes. Commit or stash them, then drop the
  // commit." needs no preamble; git's own words for a real failure do.
  return outcome.expected ? outcome.message : `Couldn't drop ${shortSha}: ${outcome.message}`;
}
