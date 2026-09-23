/**
 * "Did this git operation stop to ask the user something, or did it fail?"
 *
 * Asked of git directly, never of git's prose. Matching English stderr is what
 * produced crash report #5: a user on a Russian locale cherry-picked a commit
 * whose change was already on the branch, git paused and said so in Russian, our
 * `/conflict/i` test missed it, and a routine outcome was shown as a failure AND
 * filed as a crash.
 *
 * Lives here rather than next to one caller because every merge-like operation
 * asks the same question — cherry-pick and revert from the graph, merge and
 * rebase from the branch list — and a second copy is how the fix rots.
 */

/** All this needs from a GitContext: the ability to run a git command. */
export interface GitRunner {
  run(args: string[]): Promise<{ code: number }>;
}

/**
 * The ref git leaves behind while an operation is paused mid-flight. One per
 * operation, and the same name in every locale.
 */
export type OperationMarker =
  | "CHERRY_PICK_HEAD"
  | "REVERT_HEAD"
  | "MERGE_HEAD"
  | "REBASE_HEAD";

/**
 * Did THIS operation stop to ask the user something?
 *
 * Two conditions, and both are load-bearing.
 *
 * The marker ref exists while an operation is in progress — the same answer in
 * every locale, unlike reading git's prose.
 *
 * But the marker alone is not enough: if a cherry-pick was ALREADY paused and
 * you start another one, git refuses ("you have unmerged files") while the old
 * marker is still there, pointing at the earlier commit. Reading the marker on
 * its own would announce that the commit you just picked "needs a decision",
 * naming a commit git never touched, and swallow the real reason.
 *
 * The exit code separates them cleanly: git exits 1 when it PAUSED and non-1
 * when it REFUSED while an operation was already in flight (128 for all four
 * operations). Verified against git 2.49 — see test/opInProgress.test.ts, which
 * pins the contract against real git for every case below.
 *
 * The converse does NOT hold: exit 1 alone means very little. `git merge
 * nosuchref` and `git rebase` onto a dirty tree both exit 1 without pausing,
 * which is exactly why the marker is the other half of the test.
 */
export async function pausedForUser(
  proc: GitRunner,
  code: number,
  marker: OperationMarker,
): Promise<boolean> {
  if (code !== 1) {
    return false;
  }
  const r = await proc.run(["rev-parse", "--verify", "--quiet", marker]);
  return r.code === 0;
}

// ── After the pause: say so, and offer the way through ──────────────────────
//
// The toasts that report "paused" used to have no buttons (PLAN matrix row
// 13): the user was told to resolve conflicts and continue with nothing to
// click. They now offer "Resolve Conflicts…", which opens the Conflicts
// dashboard — the rows, Accept Yours / Theirs, Merge…, and Continue / Skip /
// Abort. The UI is a parameter so this module stays free of `vscode` (its
// tests run against real git under plain node).

/** The one label every "paused" toast offers. */
export const RESOLVE_CONFLICTS_ACTION = "Resolve Conflicts…";

/** The command that opens the Conflicts dashboard. */
export const SHOW_CONFLICTS_COMMAND = "gitstudio.showConflicts";

/** The two VS Code calls a pause notice makes. */
export interface PauseNoticeUi {
  showWarningMessage(message: string, ...actions: string[]): PromiseLike<string | undefined>;
  executeCommand(command: string): PromiseLike<unknown>;
}

/** Tell the user git stopped for them, with the dashboard one click away. */
export async function announcePause(ui: PauseNoticeUi, message: string): Promise<void> {
  const choice = await ui.showWarningMessage(message, RESOLVE_CONFLICTS_ACTION);
  if (choice === RESOLVE_CONFLICTS_ACTION) {
    await ui.executeCommand(SHOW_CONFLICTS_COMMAND);
  }
}

// ── Locale-free "is something in progress?" ──────────────────────────────────
//
// Three places answered this by matching `git status` / stderr prose against
// English regexes ("rebase in progress", /conflict/i), which a non-English git
// never prints. The answer now comes from OperationProvider.detect(), which
// reads the files git writes (MERGE_HEAD, rebase-merge/, rebase-apply/…).

/** What OperationProvider.detect() reports (structurally; no git-service import needed). */
export interface DetectedOperation {
  kind: string;
  unmerged: number;
}

/** The operation's name for a sentence ("a rebase"). */
function operationPhrase(kind: string): string {
  switch (kind) {
    case "merge":
      return "a merge";
    case "rebase":
    case "rebase-merge-step":
      return "a rebase";
    case "cherry-pick":
      return "a cherry-pick";
    case "revert":
      return "a revert";
    case "am":
      return "applying patches (git am)";
    case "stash":
      return "applying a stash";
    default:
      return "an operation";
  }
}

/**
 * Why a new rebase must not start now, or undefined when nothing is in the
 * way. Any stopped operation blocks it — git would refuse, or stack the new
 * rebase on top of a half-finished one.
 */
export function operationInProgressMessage(d: DetectedOperation): string | undefined {
  if (d.kind !== "none") {
    return `${capitalise(operationPhrase(d.kind))} is already in progress — continue or abort it first.`;
  }
  if (d.unmerged > 0) {
    return "There are unresolved conflicts — resolve them or cancel first.";
  }
  return undefined;
}

/**
 * Did THIS command leave git stopped on conflicts? Only a change counts: an
 * operation (or unmerged files) that was already there before the command ran
 * is why git refused, not something the command started.
 */
export function stoppedByThisCommand(before: DetectedOperation, after: DetectedOperation): boolean {
  const started = before.kind === "none" && after.kind !== "none";
  const newConflicts = before.unmerged === 0 && after.unmerged > 0;
  return started || newConflicts;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
