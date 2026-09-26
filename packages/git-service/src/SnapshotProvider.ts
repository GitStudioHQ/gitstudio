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
  /**
   * The ONE branch the op moves, when the op says so up front ("Reset 'x' to
   * 'origin/x'"): its full name, where it pointed before (`sha`), where the op
   * left it (`after`, filled in by `settle` once the op has run), and whether
   * it was HEAD's branch in this worktree (`checkedOut`).
   *
   * Such a snapshot is restored exactly, rather than by resetting whatever
   * HEAD is: a branch that was not checked out is put back on its own and
   * nothing else is touched — the op never saw HEAD's working tree, so undoing
   * it must not reset that — and either kind is restored only while the branch
   * is still where the op left it (see `whyNotRestorable`).
   */
  branch?: SnapshotBranch;
}

/** See `Snapshot.branch`. */
export interface SnapshotBranch {
  /** refs/heads/<name>. */
  ref: string;
  /** Where it pointed before the op. */
  sha: string;
  /** Where the op left it. */
  after?: string;
  /** HEAD's branch here when the op ran: the op took the working tree too. */
  checkedOut: boolean;
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
  async capture(
    label: string,
    opts?: GitRunOptions & {
      /** The one branch the op moves, by full name — see `Snapshot.branch`. */
      branch?: string;
    },
  ): Promise<Snapshot> {
    const headSha = (
      await this.run(["rev-parse", "HEAD"], opts)
    ).trim();

    // symbolic-ref fails (non-zero) on a detached HEAD; treat that as null.
    const ref = await this.currentBranch(opts);

    let branch: SnapshotBranch | undefined;
    if (opts?.branch) {
      const sha = (
        await this.run(["rev-parse", "--verify", `${opts.branch}^{commit}`], opts)
      ).trim();
      branch = { ref: opts.branch, sha, checkedOut: (await this.headRef(opts)) === opts.branch };
    }

    let stashSha: string | null = null;
    // A branch that is not checked out is all such an op touches — the
    // working tree here is another branch's — so none of it is captured.
    if ((!branch || branch.checkedOut) && (await this.isDirty(opts))) {
      const created = (
        await this.run(["stash", "create", label], opts)
      ).trim();
      // `stash create` prints nothing (empty) when there's nothing to stash.
      stashSha = created.length > 0 ? created : null;
    }

    return branch ? { headSha, stashSha, ref, label, branch } : { headSha, stashSha, ref, label };
  }

  /**
   * Record where the op left `snap.branch` (its `after`), once the op has
   * run. A no-op for a snapshot that names no branch.
   */
  async settle(snap: Snapshot, opts?: GitRunOptions): Promise<void> {
    if (!snap.branch) {
      return;
    }
    const now = await this.commitOf(snap.branch.ref, opts);
    if (now) {
      snap.branch.after = now;
    }
  }

  /**
   * Why `snap` cannot be restored as things stand — a sentence — or undefined
   * when it can. Only a snapshot that names its branch is checked; the others
   * restore as they always have.
   *
   * The branch must still be where the op left it: anything committed or
   * reset onto it since would be thrown away. And it must be checked out the
   * way it was: one that was checked out comes back with its working tree
   * (reset --hard, then the captured changes), which is only right in that
   * worktree; one that was not is moved on its own, which must not happen
   * under a worktree that has it checked out.
   */
  async whyNotRestorable(snap: Snapshot, opts?: GitRunOptions): Promise<string | undefined> {
    const b = snap.branch;
    if (!b) {
      return undefined;
    }
    const name = b.ref.replace(/^refs\/heads\//, "");
    const now = await this.commitOf(b.ref, opts);
    if (!now) {
      return `'${name}' is not in this repository any more.`;
    }
    if (b.after && now !== b.after) {
      return `'${name}' has moved since (it is at ${now.slice(0, 7)} now), and putting it back would throw that away.`;
    }
    const here = (await this.headRef(opts)) === b.ref;
    if (b.checkedOut && !here) {
      return `'${name}' was checked out here when it was reset, and it isn't now. Check it out again, then undo.`;
    }
    if (!b.checkedOut && !here) {
      const wt = await this.process.run(["for-each-ref", "--format=%(refname)%00%(worktreepath)", b.ref], opts);
      const row = wt.stdout.split("\n").map((l) => l.split("\0")).find((f) => f[0] === b.ref);
      if (row && row[1]) {
        return `'${name}' is checked out in another worktree, at ${row[1]}. Undo it there.`;
      }
    }
    return undefined;
  }

  /**
   * Put the repository back to `snap`: hard-reset the current HEAD to the
   * captured commit, then (if a dirty snapshot was taken) re-apply those
   * uncommitted changes so in-flight work returns. A conflicting re-apply is
   * surfaced as a thrown error carrying git's stderr — the caller decides how
   * to present it.
   *
   * A snapshot that names a branch the op moved WITHOUT it being checked out
   * restores only that branch: with update-ref (compare-and-swap against
   * where the op left it) while nothing has it checked out, or with
   * `reset --keep` when it has been checked out here since — that moves the
   * branch and the files it changes, keeps uncommitted edits, and refuses
   * rather than overwrite one.
   */
  async restore(snap: Snapshot, opts?: GitRunOptions): Promise<void> {
    const b = snap.branch;
    if (b && !b.checkedOut) {
      const name = b.ref.replace(/^refs\/heads\//, "");
      const here = (await this.headRef(opts)) === b.ref;
      const args = here
        ? ["reset", "--keep", b.sha]
        : ["update-ref", "-m", `GitStudio undo: ${snap.label}`, b.ref, b.sha, ...(b.after ? [b.after] : [])];
      const moved = await this.process.run(args, opts);
      if (moved.code !== 0) {
        throw new Error(
          `Undo failed: could not move ${name} back to ${b.sha.slice(0, 7)}: ${moved.stderr.trim()}`,
        );
      }
      return;
    }
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

  /** HEAD's branch by full name ("" when detached). */
  private async headRef(opts?: GitRunOptions): Promise<string> {
    const result = await this.process.run(["symbolic-ref", "--quiet", "HEAD"], opts);
    return result.code === 0 ? result.stdout.trim() : "";
  }

  /** The commit a full ref name points at ("" when there is no such ref). */
  private async commitOf(ref: string, opts?: GitRunOptions): Promise<string> {
    const result = await this.process.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], opts);
    return result.code === 0 ? result.stdout.trim() : "";
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
