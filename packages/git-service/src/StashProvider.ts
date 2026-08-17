import type { GitProcess, GitRunOptions } from "./GitProcess";

/** Unit separator — frames the stash-list fields (robust to messages). */
const FIELD_SEP = "\x1f";

const STASH_LIST_FORMAT =
  `--format=%H${FIELD_SEP}%gd${FIELD_SEP}%gs${FIELD_SEP}%ct`;

/** One stash entry. `ref` is the selector git uses (`stash@{n}`). */
export interface StashEntry {
  /** Full sha of the stash commit. */
  sha: string;
  /** The stash selector, e.g. "stash@{0}". */
  ref: string;
  /** The stash message (the `%gs` reflog subject). */
  message: string;
  /** Commit time, epoch seconds. */
  time: number;
}

export interface StashSaveOptions extends GitRunOptions {
  message?: string;
  /** `--keep-index` — leave already-staged changes staged. */
  keepIndex?: boolean;
  /** `--include-untracked` — also stash untracked files. */
  includeUntracked?: boolean;
}

export interface StashOpResult {
  ok: boolean;
  stderr: string;
}

/**
 * `save()` alone reports whether a stash was actually CREATED, because a
 * successful exit code does not mean one was.
 *
 * `git stash push` with nothing to stash exits **0** and prints "No local
 * changes to save" on stdout. Reading only the exit code therefore reported a
 * successful stash for an operation that did nothing — the worst shape a bug can
 * take here, because the user is told their work is safely tucked away when it
 * is still sitting in the working tree.
 */
export interface StashSaveOutcome extends StashOpResult {
  /**
   * True when there was something to stash and git took it — i.e. the user's
   * changes really are put away now.
   *
   * Not "the stash list grew": two identical stashes in the same second produce
   * the same commit, so the list can stay the same length while a real stash
   * happened. See `save()`.
   */
  created: boolean;
  /** Why nothing was stashed. Only set when `ok` is true and `created` is false. */
  blocker?: StashBlocker;
}

/** Why a `git stash push` succeeded without stashing anything. */
export type StashBlocker =
  /** Nothing was different from HEAD at all. */
  | "cleanTree"
  /**
   * The only changes were untracked files, and `--include-untracked` was not
   * asked for — so git had nothing in its remit to save. Worth its own message:
   * unlike a clean tree, the user really does have work here, and it is one
   * checkbox away from being stashed.
   */
  | "untrackedOnly";

/**
 * What to tell the user about a `StashBlocker`. Lives beside the enum for the
 * same reason `commitBlockerMessage` does: so the extension and the desktop app
 * cannot describe the same state differently. The caller adds any prefix.
 */
export function stashBlockerMessage(blocker: StashBlocker): string {
  switch (blocker) {
    case "cleanTree":
      return "Nothing to stash — the working tree is clean.";
    case "untrackedOnly":
      return "Nothing was stashed — the only changes are new files git isn't tracking yet. Stash again with \"Include untracked files\" to put those away too.";
  }
}

/**
 * Host-agnostic `git stash` plumbing: list/save/apply/pop/drop/show/branch.
 * Pure git CLI — never imports `vscode`, so it powers headless tests, the VS
 * Code extension, and the desktop app alike.
 */
export class StashProvider {
  constructor(private proc: GitProcess) {}

  /** `git stash list` parsed into {sha, ref, message, time}, newest first. */
  async list(opts?: GitRunOptions): Promise<StashEntry[]> {
    const r = await this.proc.run(["stash", "list", STASH_LIST_FORMAT], {
      signal: opts?.signal,
    });
    if (r.code !== 0) {
      return [];
    }
    const entries: StashEntry[] = [];
    for (const line of splitLines(r.stdout)) {
      const [sha, ref, message, time] = line.split(FIELD_SEP);
      if (!sha || !ref) {
        continue;
      }
      entries.push({
        sha,
        ref,
        message: message ?? "",
        time: Number(time) || 0,
      });
    }
    return entries;
  }

  /**
   * `git stash push` with optional message + keep-index / include-untracked.
   *
   * Reports whether anything was actually stashed, not merely whether git exited
   * 0 — see StashSaveOutcome for why those are different questions.
   */
  async save(opts?: StashSaveOptions): Promise<StashSaveOutcome> {
    const args = ["stash", "push"];
    if (opts?.keepIndex) {
      args.push("--keep-index");
    }
    if (opts?.includeUntracked) {
      args.push("--include-untracked");
    }
    if (opts?.message) {
      args.push("-m", opts.message);
    }
    // Asked BEFORE the push, not after, and deliberately so.
    //
    // The obvious implementation compares the stash list before and after. It is
    // wrong in a way only git can teach you: stash twice with the same tree, the
    // same message and inside the same second, and both commits are byte
    // identical, so `refs/stash` does not move and the list does NOT grow — git
    // prints "Saved working directory…" and exits 0 all the same. A
    // grew-the-list test then calls that second stash a no-op and tells the user
    // "nothing to stash" seconds after clearing their working tree.
    //
    // "Was there anything to stash?" is both the question the user actually has
    // and the one with a stable answer.
    const blocker = await this.nothingToStash(opts);
    const r = await this.proc.run(args, { signal: opts?.signal });
    if (r.code !== 0) {
      return { ok: false, created: false, stderr: r.stderr };
    }
    return blocker
      ? { ok: true, created: false, stderr: r.stderr, blocker }
      : { ok: true, created: true, stderr: r.stderr };
  }

  /**
   * Is there nothing for `git stash push` to save — and if so, why? Returns
   * undefined when there IS something, i.e. the stash will be real.
   *
   * Three single-purpose questions rather than parsing `status --porcelain`: no
   * locale, no XY codes. Both diffs matter, because a stash takes staged changes
   * as well as unstaged ones.
   */
  private async nothingToStash(
    opts?: StashSaveOptions,
  ): Promise<StashBlocker | undefined> {
    const [worktree, index] = await Promise.all([
      this.proc.run(["diff", "--name-only", "-z"], { signal: opts?.signal }),
      this.proc.run(["diff", "--cached", "--name-only", "-z"], {
        signal: opts?.signal,
      }),
    ]);
    if (countPaths(worktree) > 0 || countPaths(index) > 0) {
      return undefined;
    }
    if (await this.hasUntracked(opts)) {
      // With --include-untracked these ARE the stash; without it, they are the
      // thing the user needs telling about.
      return opts?.includeUntracked ? undefined : "untrackedOnly";
    }
    return "cleanTree";
  }

  /** Are there untracked, non-ignored files? `--exclude-standard` is what keeps
   *  build output from counting as work the user meant to stash. */
  private async hasUntracked(opts?: GitRunOptions): Promise<boolean> {
    const r = await this.proc.run(
      ["ls-files", "--others", "--exclude-standard", "-z"],
      { signal: opts?.signal },
    );
    return countPaths(r) > 0;
  }

  /** `git stash apply <ref>` — apply without dropping. */
  async apply(ref: string, opts?: GitRunOptions): Promise<StashOpResult> {
    const r = await this.proc.run(["stash", "apply", ref], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git stash pop <ref>` — apply then drop on success. */
  async pop(ref: string, opts?: GitRunOptions): Promise<StashOpResult> {
    const r = await this.proc.run(["stash", "pop", ref], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git stash drop <ref>` — discard a stash entry. */
  async drop(ref: string, opts?: GitRunOptions): Promise<StashOpResult> {
    const r = await this.proc.run(["stash", "drop", ref], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git stash show -p <ref>` — the stash's diff text (empty on failure). */
  async show(ref: string, opts?: GitRunOptions): Promise<string> {
    const r = await this.proc.run(["stash", "show", "-p", ref], {
      signal: opts?.signal,
    });
    return r.code === 0 ? r.stdout : "";
  }

  /** `git stash branch <name> <ref>` — create a branch from a stash. */
  async branch(
    ref: string,
    name: string,
    opts?: GitRunOptions,
  ): Promise<StashOpResult> {
    const r = await this.proc.run(["stash", "branch", name, ref], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }
}

function splitLines(text: string): string[] {
  return text.split("\n").filter((line) => line.length > 0);
}

/** Entries in a `-z` path list; a failed command counts as zero, not as junk. */
function countPaths(r: { code: number; stdout: string }): number {
  if (r.code !== 0) {
    return 0;
  }
  return r.stdout.split("\0").filter((s) => s.length > 0).length;
}
