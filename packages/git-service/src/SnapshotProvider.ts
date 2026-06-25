import type { GitProcess, GitRunOptions } from "./GitProcess";

/**
 * A point-in-time record of repository state, enough to put HEAD (and any dirty
 * working-tree/index changes) back where they were. This is the portable
 * mechanics behind GitStudio's universal Undo envelope — the extension's
 * UndoLedger persists these and the desktop app can reuse the same provider.
 *
 *   headSha  — the commit HEAD pointed at when captured.
 *   stashSha — a `git stash create` commit capturing uncommitted index + tree
 *              changes (null when the working tree was clean). Captured WITHOUT
 *              modifying the working tree, so capture is side-effect-free.
 *   ref      — the short branch name HEAD was on (null when detached).
 *   label    — the operation this snapshot guards (for UI).
 */
export interface Snapshot {
  headSha: string;
  stashSha: string | null;
  ref: string | null;
  label: string;
}

/**
 * Captures and restores repository snapshots using only plumbing that never
 * touches the working tree on capture. This package must never import vscode.
 */
export class SnapshotProvider {
  constructor(private readonly process: GitProcess) {}

  /**
   * Record HEAD, the current branch (or null when detached), and — when the
   * working tree or index is dirty — a `git stash create` commit of those
   * uncommitted changes. Capture does NOT modify the working tree: `stash
   * create` only writes objects and prints a commit sha.
   */
  async capture(label: string, opts?: GitRunOptions): Promise<Snapshot> {
    const headSha = (
      await this.run(["rev-parse", "HEAD"], opts)
    ).trim();

    // symbolic-ref fails (non-zero) on a detached HEAD; treat that as null.
    const ref = await this.currentBranch(opts);

    let stashSha: string | null = null;
    if (await this.isDirty(opts)) {
      const created = (
        await this.run(["stash", "create", label], opts)
      ).trim();
      // `stash create` prints nothing (empty) when there's nothing to stash.
      stashSha = created.length > 0 ? created : null;
    }

    return { headSha, stashSha, ref, label };
  }

  /**
   * Put the repository back to `snap`: hard-reset the current HEAD to the
   * captured commit, then (if a dirty snapshot was taken) re-apply those
   * uncommitted changes so in-flight work returns. A conflicting re-apply is
   * surfaced as a thrown error carrying git's stderr — the caller decides how
   * to present it.
   */
  async restore(snap: Snapshot, opts?: GitRunOptions): Promise<void> {
    // Reset the current branch/HEAD to the captured commit. We keep this simple
    // and reset whatever HEAD currently is; if a branch ref was captured and is
    // still checked out, this moves that branch back to headSha.
    const reset = await this.process.run(
      ["reset", "--hard", snap.headSha],
      opts,
    );
    if (reset.code !== 0) {
      throw new Error(
        `Undo failed: could not reset to ${snap.headSha}: ${reset.stderr.trim()}`,
      );
    }

    if (snap.stashSha) {
      // Re-apply (not pop — the stash commit isn't on the stash stack) the
      // captured uncommitted work. Conflicts leave markers in the tree; we
      // surface them rather than silently swallowing.
      const apply = await this.process.run(
        ["stash", "apply", snap.stashSha],
        opts,
      );
      if (apply.code !== 0) {
        throw new Error(
          `Undo restored the commit but re-applying your uncommitted changes ` +
            `hit a conflict: ${apply.stderr.trim()}`,
        );
      }
    }
  }

  /**
   * True when `sha` is contained in any remote-tracking branch — i.e. the
   * commit has been published. Used to choose Undo(reset) vs Revert: rewriting
   * pushed history is unsafe, so a pushed op is undone by reverting instead.
   */
  async isPushed(sha: string, opts?: GitRunOptions): Promise<boolean> {
    const result = await this.process.run(
      ["branch", "-r", "--contains", sha],
      opts,
    );
    if (result.code !== 0) {
      // An unknown sha or no remotes: treat as not-pushed (safe default — we'd
      // rather offer a reset-undo on a local commit than wrongly block it).
      return false;
    }
    return result.stdout.trim().length > 0;
  }

  // ── Internals ──────────────────────────────────────────────────────────────

  private async currentBranch(opts?: GitRunOptions): Promise<string | null> {
    const result = await this.process.run(
      ["symbolic-ref", "--quiet", "--short", "HEAD"],
      opts,
    );
    if (result.code !== 0) {
      return null; // detached HEAD
    }
    const name = result.stdout.trim();
    return name.length > 0 ? name : null;
  }

  private async isDirty(opts?: GitRunOptions): Promise<boolean> {
    const result = await this.process.run(["status", "--porcelain"], opts);
    return result.stdout.trim().length > 0;
  }

  private async run(args: string[], opts?: GitRunOptions): Promise<string> {
    const result = await this.process.run(args, opts);
    if (result.code !== 0) {
      throw new Error(
        `git ${args.join(" ")} failed: ${result.stderr.trim()}`,
      );
    }
    return result.stdout;
  }
}
