// The words for removing a worktree — one vocabulary for both products.
//
// Host-agnostic and node-free: the extension builds its question from these in
// the extension host, the desktop in its renderer. The facts come from
// git-service's WorktreeProvider.removal(), read BEFORE anything is asked, so
// the question can name what will be lost — a lock's reason, the uncommitted
// files — and the answer runs exactly what it said (removeAsAgreed).

/** What the question needs to know about the worktree it asks about. */
export interface WorktreeRemovalFacts {
  /** `missing`: its folder is gone, and removing it only forgets git's record
   *  of it. `present`: its folder is there and is deleted. */
  kind: "missing" | "present";
  /** How the worktree is named: its branch, or "<sha> (detached)". */
  label: string;
  /** Its folder, as the host shows paths. */
  shownPath: string;
  /** The branch it has checked out; absent when detached. */
  branch?: string;
  /** Its HEAD commit. */
  head: string;
  locked: boolean;
  lockReason?: string;
  /** The uncommitted paths removing it deletes; undefined when git could not
   *  say (then any it has are deleted). Ignored for a missing folder. */
  changes?: string[];
  /** What git is stopped in there (git-service's StoppedOperation). Removing
   *  the worktree abandons it — git removes a clean one mid-rebase without a
   *  word. Ignored for a missing folder. */
  operation?: WorktreeOperation;
}

/** An operation git can be stopped in, as git-service's stoppedIn names it. */
export type WorktreeOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "am";

/** What removing the worktree does to the operation stopped in it. */
const ABANDONS: Record<WorktreeOperation, string> = {
  merge: "A merge is in progress in it. Removing the worktree abandons the merge.",
  rebase:
    "A rebase is in progress in it. Removing the worktree abandons the rebase; the branch being rebased stays as it was before the rebase began.",
  "cherry-pick": "A cherry-pick is in progress in it. Removing the worktree abandons the cherry-pick.",
  revert: "A revert is in progress in it. Removing the worktree abandons the revert.",
  am: "git am is applying patches in it. Removing the worktree abandons the patches not yet applied.",
};

export interface WorktreeRemovalQuestion {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  /** Whether saying yes agrees to delete uncommitted changes — the remove
   *  then runs with --force. False means git refuses a change made since. */
  discardChanges: boolean;
}

/** How many uncommitted paths the question names before "and N more". */
const NAMED = 5;

/** The one question asked before a worktree is removed or forgotten. */
export function worktreeRemovalQuestion(f: WorktreeRemovalFacts): WorktreeRemovalQuestion {
  const operation = f.kind === "present" && f.operation ? ABANDONS[f.operation] : "";
  // Mid-rebase git lists the worktree as detached: the rebase's own sentence
  // says what happens to the branch, and "no branch checked out" would not.
  const stays = f.branch
    ? `The branch ${f.branch} and its commits stay.`
    : f.kind === "present" && f.operation === "rebase"
      ? ""
      : `It has no branch checked out (detached at ${f.head.slice(0, 7)}).`;
  const lock = f.locked
    ? f.lockReason
      ? `It is locked: “${f.lockReason}”.`
      : "It is locked, with no reason given."
    : "";

  if (f.kind === "missing") {
    // A lock is git's answer for a worktree on a drive or share that is not
    // always there. Forgotten while it is unplugged, the folder that comes
    // back points at a record that is gone — "not a git repository" — so
    // "nothing on disk changes" is only true of an unlocked one.
    const gone = f.locked
      ? `Its folder isn't there: ${f.shownPath}. Forgetting it removes git's record of the worktree. If the folder is on a drive that isn't connected, it is no longer a worktree when the drive comes back.`
      : `Its folder is gone: ${f.shownPath}. Forgetting it removes git's record of the worktree; nothing on disk changes.`;
    return {
      title: `Forget worktree ${f.label}?`,
      message: [
        gone,
        lock && `${lock} Forgetting it unlocks it.`,
        stays,
      ]
        .filter(Boolean)
        .join("\n\n"),
      confirmLabel: f.locked ? "Unlock and Forget" : "Forget",
      danger: f.locked,
      discardChanges: false,
    };
  }

  const changes = f.changes;
  const dirty = changes === undefined || changes.length > 0;
  const lost =
    changes === undefined
      ? "Its uncommitted changes couldn't be read; any it has are deleted with it."
      : changes.length > 0
        ? `Its ${changes.length} uncommitted change${changes.length === 1 ? "" : "s"} go with it, and nothing can bring them back:\n` +
          changes
            .slice(0, NAMED)
            .map((c) => `  ${c}`)
            .join("\n") +
          (changes.length > NAMED ? `\n  and ${changes.length - NAMED} more` : "")
        : "";
  return {
    title: `Remove worktree ${f.label}?`,
    message: [`Deletes its folder, ${f.shownPath}.`, lost, operation, lock, stays].filter(Boolean).join("\n\n"),
    confirmLabel:
      f.locked && dirty
        ? "Unlock, Discard Changes and Remove"
        : f.locked
          ? "Unlock and Remove"
          : dirty
            ? "Discard Changes and Remove"
            : "Remove",
    danger: true,
    discardChanges: dirty,
  };
}

/**
 * Said when the remove ran nothing because the worktree changed while the
 * question was open (an agent still at work in it) and it has already been
 * asked about again once: nothing it holds was deleted unasked.
 */
export function worktreeChangedSinceAsked(label: string): string {
  return `${label} has uncommitted changes it didn't have when you were asked, so nothing was removed. Remove it again to see what it holds now.`;
}

/**
 * Why a worktree is not removed at all, said before anything runs: the main
 * worktree (git never removes it), the one this window has open (its folder
 * would go from under the window), one another of the window's repository
 * tabs has open (the desktop's, #32 — the same, under that tab), or one no
 * longer listed.
 *
 * `holds` is what has one repository open: a VS Code window, or a desktop
 * tab (#32). "Open something else in this one" is no way out on the desktop:
 * that opens a new tab, and this one still has the worktree.
 */
export function worktreeRemovalRefusal(
  why: "main" | "current" | "openInTab" | "notListed",
  label: string,
  holds: "window" | "tab" = "window",
): string {
  switch (why) {
    case "main":
      return `${label} is the main worktree — it holds the repository itself, so git never removes it.`;
    case "current":
      return holds === "tab"
        ? `This tab has ${label} open, so it can't be removed from here — its folder would be deleted from under the tab. Close this tab, then remove it from another worktree of the repository.`
        : `This window has ${label} open, so it can't be removed from here — its folder would be deleted from under the window. Remove it from another window, or open something else in this one first.`;
    case "openInTab":
      return `${label} is open in another tab of this window, so it can't be removed — its folder would be deleted from under that tab. Close that tab first.`;
    case "notListed":
      return `${label} is no longer a worktree of this repository.`;
  }
}
