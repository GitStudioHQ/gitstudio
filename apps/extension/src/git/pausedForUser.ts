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
