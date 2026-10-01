// The words for removing a worktree — one vocabulary for both products.
//
// Host-agnostic and node-free: the extension builds its question from these in
// the extension host, the desktop in its renderer. The facts come from
// git-service's WorktreeProvider.removal(), read BEFORE anything is asked, so
// the question can name what will be lost — a lock's reason, the uncommitted
// files — and the answer runs exactly what it said (removeAsAgreed).

import * as l10n from "@vscode/l10n";

/** What the question needs to know about the worktree it asks about. */
export interface WorktreeRemovalFacts {
  /** `missing`: its folder is gone, and removing it only forgets git's record
   *  of it. `present`: its folder is there and is deleted. `stale`: its
   *  folder is there but is not a worktree any more (its .git is gone) —
   *  forgetting it leaves the folder alone. */
  kind: "missing" | "present" | "stale";
  /** `stale`: what git makes of it (its prunable reason); absent for a
   *  locked one, which git never prunes. */
  staleWhy?: string;
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

/**
 * Why a folder that git still lists is not a worktree any more, in words: its
 * .git is gone (what git's "gitdir file points to non-existent location"
 * means while the folder stands, and all a locked one — which git gives no
 * reason for — can mean), or git's own words for anything else.
 */
export function unlinkedWhy(reason?: string): string {
  return !reason || reason === "gitdir file points to non-existent location"
    ? l10n.t("its .git file is gone")
    : l10n.t("git says: “{0}”", reason);
}

/** What removing the worktree does to the operation stopped in it. */
function operationAbandons(operation: WorktreeOperation): string {
  switch (operation) {
    case "merge":
      return l10n.t("A merge is in progress in it. Removing the worktree abandons the merge.");
    case "rebase":
      return l10n.t(
        "A rebase is in progress in it. Removing the worktree abandons the rebase; the branch being rebased stays as it was before the rebase began.",
      );
    case "cherry-pick":
      return l10n.t("A cherry-pick is in progress in it. Removing the worktree abandons the cherry-pick.");
    case "revert":
      return l10n.t("A revert is in progress in it. Removing the worktree abandons the revert.");
    case "am":
      return l10n.t("git am is applying patches in it. Removing the worktree abandons the patches not yet applied.");
  }
}

export interface WorktreeRemovalQuestion {
  title: string;
  message: string;
  confirmLabel: string;
  danger: boolean;
  /** Whether saying yes agrees to delete uncommitted changes — the remove
   *  then runs with --force. False means git refuses a change made since. */
  discardChanges: boolean;
  /** The paragraph naming what is lost with it, as it stands in `message`:
   *  worktreeRemovalAsk swaps it for its own list, and finding it by its words
   *  would only work in English. */
  lostParagraph?: string;
}

/** How many uncommitted paths the question names before "and N more". */
const NAMED = 5;

/** The one question asked before a worktree is removed or forgotten. */
export function worktreeRemovalQuestion(f: WorktreeRemovalFacts): WorktreeRemovalQuestion {
  const operation = f.kind === "present" && f.operation ? operationAbandons(f.operation) : "";
  // Mid-rebase git lists the worktree as detached: the rebase's own sentence
  // says what happens to the branch, and "no branch checked out" would not.
  const stays = f.branch
    ? l10n.t("The branch {0} and its commits stay.", f.branch)
    : f.kind === "present" && f.operation === "rebase"
      ? ""
      : l10n.t("It has no branch checked out (detached at {0}).", f.head.slice(0, 7));
  const lock = f.locked
    ? f.lockReason
      ? l10n.t("It is locked: “{0}”.", f.lockReason)
      : l10n.t("It is locked, with no reason given.")
    : "";

  if (f.kind === "stale") {
    // Its folder stays whatever is said here: only git's record goes. What is
    // IN the folder is never read (git there reads the repository around it).
    return {
      title: l10n.t("Forget worktree {0}?", f.label),
      message: [
        l10n.t(
          "Its folder, {0}, isn't a worktree any more: {1}. Forgetting it removes git's record of the worktree; the folder and everything in it stay.",
          f.shownPath,
          unlinkedWhy(f.staleWhy),
        ),
        lock && l10n.t("{0} Forgetting it unlocks it.", lock),
        stays,
      ]
        .filter(Boolean)
        .join("\n\n"),
      confirmLabel: f.locked ? l10n.t("Unlock and Forget") : l10n.t("Forget"),
      danger: false,
      discardChanges: false,
    };
  }

  if (f.kind === "missing") {
    // A lock is git's answer for a worktree on a drive or share that is not
    // always there. Forgotten while it is unplugged, the folder that comes
    // back points at a record that is gone — "not a git repository" — so
    // "nothing on disk changes" is only true of an unlocked one.
    const gone = f.locked
      ? l10n.t(
          "Its folder isn't there: {0}. Forgetting it removes git's record of the worktree. If the folder is on a drive that isn't connected, it is no longer a worktree when the drive comes back.",
          f.shownPath,
        )
      : l10n.t("Its folder is gone: {0}. Forgetting it removes git's record of the worktree; nothing on disk changes.", f.shownPath);
    return {
      title: l10n.t("Forget worktree {0}?", f.label),
      message: [gone, lock && l10n.t("{0} Forgetting it unlocks it.", lock), stays].filter(Boolean).join("\n\n"),
      confirmLabel: f.locked ? l10n.t("Unlock and Forget") : l10n.t("Forget"),
      danger: f.locked,
      discardChanges: false,
    };
  }

  const changes = f.changes;
  const dirty = changes === undefined || changes.length > 0;
  const lost =
    changes === undefined
      ? l10n.t("Its uncommitted changes couldn't be read; any it has are deleted with it.")
      : changes.length > 0
        ? (changes.length === 1
            ? l10n.t("Its 1 uncommitted change goes with it, and nothing can bring it back:\n")
            : l10n.t("Its {0} uncommitted changes go with it, and nothing can bring them back:\n", changes.length)) +
          changes
            .slice(0, NAMED)
            .map((c) => `  ${c}`)
            .join("\n") +
          (changes.length > NAMED ? l10n.t("\n  and {0} more", changes.length - NAMED) : "")
        : "";
  return {
    title: l10n.t("Remove worktree {0}?", f.label),
    message: [l10n.t("Deletes its folder, {0}.", f.shownPath), lost, operation, lock, stays].filter(Boolean).join("\n\n"),
    confirmLabel:
      f.locked && dirty
        ? l10n.t("Unlock, Discard Changes and Remove")
        : f.locked
          ? l10n.t("Unlock and Remove")
          : dirty
            ? l10n.t("Discard Changes and Remove")
            : l10n.t("Remove"),
    danger: true,
    discardChanges: dirty,
    lostParagraph: lost || undefined,
  };
}

/**
 * Said when the remove ran nothing because the worktree changed while the
 * question was open (an agent still at work in it) and it has already been
 * asked about again once: nothing it holds was deleted unasked.
 */
export function worktreeChangedSinceAsked(label: string): string {
  return l10n.t(
    "{0} has uncommitted changes it didn't have when you were asked, so nothing was removed. Remove it again to see what it holds now.",
    label,
  );
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
      return l10n.t("{0} is the main worktree — it holds the repository itself, so git never removes it.", label);
    case "current":
      return holds === "tab"
        ? l10n.t(
            "This tab has {0} open, so it can't be removed from here — its folder would be deleted from under the tab. Close this tab, then remove it from another worktree of the repository.",
            label,
          )
        : l10n.t(
            "This window has {0} open, so it can't be removed from here — its folder would be deleted from under the window. Remove it from another window, or open something else in this one first.",
            label,
          );
    case "openInTab":
      return l10n.t(
        "{0} is open in another tab of this window, so it can't be removed — its folder would be deleted from under that tab. Close that tab first.",
        label,
      );
    case "notListed":
      return l10n.t("{0} is no longer a worktree of this repository.", label);
  }
}

/** What the choosing question needs beyond WorktreeRemovalFacts. */
export interface WorktreeRemovalChoiceFacts extends WorktreeRemovalFacts {
  /** Files left unmerged there: `git stash` refuses them, so Stash & Remove
   *  is not offered. */
  unmerged?: number;
  /** Its branch is fully merged into `mergedInto` (the default branch, which
   *  is never this branch itself): deleting the branch loses no commit, so
   *  "Also delete the branch" is offered — unchecked. */
  mergedInto?: string;
}

/** One way to answer the removal question. */
export interface WorktreeRemovalChoice {
  /** `stash`: stash its changes, then remove it. `discard`: remove it with its
   *  changes. `remove`: a clean one. `forget`: a missing one, or one that is
   *  not a worktree any more. */
  id: "stash" | "discard" | "remove" | "forget";
  label: string;
  description: string;
  danger: boolean;
}

/**
 * The question asked before a worktree is removed, as a choice: a dirty one
 * offers Stash & Remove (first, the default) beside Discard Changes and
 * Remove; a clean or missing one has one way. A branch merged into the
 * default branch adds an unchecked "Also delete the branch".
 */
export interface WorktreeRemovalAsk {
  title: string;
  message: string;
  choices: WorktreeRemovalChoice[];
  deleteBranch?: { label: string; description: string };
}

export function worktreeRemovalAsk(f: WorktreeRemovalChoiceFacts): WorktreeRemovalAsk {
  const q = worktreeRemovalQuestion(f);
  const deleteBranch =
    f.branch && f.mergedInto
      ? {
          label: l10n.t("Also delete the branch {0}", f.branch),
          description: l10n.t("It is fully merged into {0}, so no commit is lost.", f.mergedInto),
        }
      : undefined;
  const extra = deleteBranch ? { deleteBranch } : {};
  if (f.kind === "missing" || f.kind === "stale") {
    return {
      title: q.title,
      message: q.message,
      choices: [
        {
          id: "forget",
          label: q.confirmLabel,
          description:
            f.kind === "stale"
              ? l10n.t("Removes git's record of the worktree; the folder stays.")
              : l10n.t("Removes git's record of the worktree."),
          danger: q.danger,
        },
      ],
      ...extra,
    };
  }
  if (!q.discardChanges) {
    return {
      title: q.title,
      message: q.message,
      choices: [{ id: "remove", label: q.confirmLabel, description: l10n.t("Deletes its folder."), danger: true }],
      ...extra,
    };
  }
  const changes = f.changes;
  const n = changes?.length ?? 0;
  const them =
    changes === undefined
      ? l10n.t("Its uncommitted changes")
      : n === 1
        ? l10n.t("Its 1 uncommitted change")
        : l10n.t("Its {0} uncommitted changes", n);
  // The verbs agree with the count: one change goes, two go.
  const one = n === 1;
  const listed =
    changes === undefined
      ? l10n.t("Its uncommitted changes couldn't be read.")
      : (n === 1 ? l10n.t("It has 1 uncommitted change:\n") : l10n.t("It has {0} uncommitted changes:\n", n)) +
        changes
          .slice(0, NAMED)
          .map((c) => `  ${c}`)
          .join("\n") +
        (n > NAMED ? l10n.t("\n  and {0} more", n - NAMED) : "");
  const canStash = changes !== undefined && !(f.unmerged && f.unmerged > 0);
  // The question's own message, with its "go with it" paragraph swapped for
  // the plain list: the choices below say where they go. The paragraph is the
  // one the question marked, never found by its words.
  const paragraphs = q.message
    .split("\n\n")
    .map((p) => (q.lostParagraph !== undefined && p === q.lostParagraph ? listed : p));
  if (!canStash) {
    paragraphs.push(
      changes === undefined
        ? l10n.t("They can't be stashed without knowing what they are.")
        : f.unmerged === 1
          ? l10n.t("A file is left unmerged in it, which git can't stash.")
          : l10n.t("{0} files are left unmerged in it, which git can't stash.", f.unmerged ?? 0),
    );
  }
  const choices: WorktreeRemovalChoice[] = [];
  if (canStash) {
    choices.push({
      id: "stash",
      label: f.locked ? l10n.t("Unlock, Stash & Remove") : l10n.t("Stash & Remove"),
      description: one
        ? l10n.t("{0} goes into a stash you can apply from any worktree of this repository; then its folder is deleted.", them)
        : l10n.t("{0} go into a stash you can apply from any worktree of this repository; then its folder is deleted.", them),
      danger: false,
    });
  }
  choices.push({
    id: "discard",
    label: f.locked ? l10n.t("Unlock, Discard Changes and Remove") : l10n.t("Discard Changes and Remove"),
    description: one
      ? l10n.t("{0} is deleted with its folder, and nothing can bring it back.", them)
      : l10n.t("{0} are deleted with its folder, and nothing can bring them back.", them),
    danger: true,
  });
  return { title: q.title, message: paragraphs.join("\n\n"), choices, ...extra };
}

/** The stash message Stash & Remove leaves, so the stash says where it came from. */
export function worktreeStashMessage(label: string, shownPath: string): string {
  return l10n.t("Changes from worktree {0} ({1}), stashed before removing it", label, shownPath);
}
