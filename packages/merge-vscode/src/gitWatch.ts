// Where to watch for "git just started / stopped / moved an operation"
// (PLAN matrix row 12).
//
// Both extensions watched `<root>/.git/{MERGE_HEAD,…}`. In a LINKED worktree
// `<root>/.git` is a FILE ("gitdir: …/main/.git/worktrees/<name>"), so those
// watchers could never fire: a conflict there appeared only when vscode.git's
// own status poll caught up. git answers the question itself —
// `rev-parse --git-path <name>` — and OperationProvider.gitPath resolves that
// answer (resolve, never join: in a linked worktree it is absolute). The
// per-worktree files (HEAD, MERGE_HEAD, rebase-merge/, …) live in the
// worktree's private git dir; refs live in the COMMON dir.
//
// vscode-free: this computes the targets; the hosts create the watchers.

import { basename, dirname } from "node:path";

/** All this needs: OperationProvider.gitPath. */
export interface GitPathSource {
  gitPath(name: string): Promise<string>;
}

export interface GitWatchTargets {
  /** This worktree's private git dir (where HEAD, MERGE_HEAD, rebase-merge/ live). */
  gitDir: string;
  /** The shared git dir (refs/, packed-refs), the same as gitDir outside a linked worktree. */
  commonDir: string;
  /** Glob, relative to gitDir, for the operation-state entries. */
  opStateGlob: string;
  /** Glob, relative to commonDir, for ref moves. */
  refsGlob: string;
}

/**
 * The operation-state entries git writes and removes as an operation starts,
 * stops at the next commit and ends. REBASE_HEAD changes at every rebase stop
 * (the rebase-merge/ directory itself only appears and disappears once), and
 * sequencer/ holds a cherry-pick or revert range.
 */
export const OP_STATE_ENTRIES = [
  "HEAD",
  "MERGE_HEAD",
  "CHERRY_PICK_HEAD",
  "REVERT_HEAD",
  "REBASE_HEAD",
  "rebase-merge",
  "rebase-apply",
  "sequencer",
] as const;

/**
 * Resolve the watch targets for one repository (two `rev-parse` calls).
 * Rejects unless git named the entries it was asked about: a git killed
 * mid-answer (its context disposed) reads as exit 0 with nothing on stdout,
 * which resolves to the worktree root — and its dirname is the folder ABOVE
 * the repository, not a git dir.
 */
export async function gitWatchTargets(source: GitPathSource): Promise<GitWatchTargets> {
  const [head, refs] = await Promise.all([source.gitPath("HEAD"), source.gitPath("refs")]);
  if (basename(head) !== "HEAD" || basename(refs) !== "refs") {
    throw new Error("git did not say where this repository keeps its files.");
  }
  return {
    gitDir: dirname(head),
    commonDir: dirname(refs),
    opStateGlob: `{${OP_STATE_ENTRIES.join(",")}}`,
    refsGlob: "refs/**",
  };
}
