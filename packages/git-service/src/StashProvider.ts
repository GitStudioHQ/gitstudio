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
  /**
   * Restrict the stash to these repo-relative paths (`git stash push -- …`).
   *
   * Empty or omitted means the whole working tree. Each is a FILE NAME (or a
   * directory's), never a pattern: it is passed after `--` as a literal
   * pathspec (see `literalPathspec`), so a file named like an option, like
   * pathspec magic (":odd") or like a glob ("*glob*", "a[bc].txt") is that
   * file and nothing else.
   */
  paths?: readonly string[];
  /**
   * `--staged` — stash ONLY what is currently staged, leaving unstaged work in
   * place.
   *
   * Cannot be combined with `paths`; see `save()` for why that combination is
   * refused rather than passed through.
   */
  stagedOnly?: boolean;
}

export interface StashOpResult {
  ok: boolean;
  stderr: string;
  /**
   * The stash, named by its sha, is no longer in the list (popped or dropped
   * since it was shown), so nothing ran. The user's state, not a failure.
   */
  gone?: true;
}

/** What the user is told when the stash they acted on has left the list. */
export const STASH_GONE_MESSAGE = "That stash is no longer in the list, so nothing was changed.";

/**
 * A stash's full sha. A stash is ADDRESSED by it: `stash@{n}` is a position,
 * and every push, pop or drop renumbers the list under a row that still shows
 * the old number.
 */
export function isStashSha(s: string): boolean {
  return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(s);
}

/**
 * The only two ways a stash is named here: its full sha, or a `stash@{n}`
 * selector from the list. Anything else — a name that looks like an option,
 * a revision expression — never reaches git.
 */
export function isStashName(s: string): boolean {
  return isStashSha(s) || /^stash@\{\d+\}$/.test(s);
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
export function stashBlockerMessage(
  blocker: StashBlocker,
  /**
   * What the user actually asked to stash, so the message describes THAT rather
   * than the repository. "The working tree is clean" is a plain falsehood when
   * the tree is full of changes and the three files they picked are not.
   */
  scope: StashScope = "tree",
): string {
  switch (blocker) {
    case "cleanTree":
      switch (scope) {
        case "selection":
          return "Nothing to stash — the files you selected have no changes.";
        case "staged":
          return "Nothing to stash — nothing is staged.";
        default:
          return "Nothing to stash — the working tree is clean.";
      }
    case "untrackedOnly":
      return scope === "selection"
        ? "Nothing was stashed — the files you selected are new ones git isn't tracking yet. Stash again with \"Include untracked files\" to put those away too."
        : "Nothing was stashed — the only changes are new files git isn't tracking yet. Stash again with \"Include untracked files\" to put those away too.";
  }
}

/** What a stash was asked to cover, for reporting purposes only. */
export type StashScope = "tree" | "selection" | "staged";

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
    const paths = opts?.paths?.filter((p) => p.length > 0) ?? [];

    // REFUSED, because git does the wrong thing silently. `git stash push
    // --staged -- <path>` ignores the pathspec: the stash gets every staged
    // change, and files outside the pathspec are left with their index entry
    // intact but their working tree reverted — `MM` in status, with the working
    // copy of work the user never selected quietly thrown away. Exit code 0, no
    // warning. Verified against git 2.49.
    //
    // "The staged changes of just these files" is not expressible through
    // `stash push` at all, so the caller has to pick one axis.
    if (opts?.stagedOnly && paths.length > 0) {
      return {
        ok: false,
        created: false,
        stderr:
          "Stashing the staged changes of specific files is not supported by git — " +
          "stash the whole staged section, or stash those files entirely.",
      };
    }

    const args = ["stash", "push"];
    if (opts?.stagedOnly) {
      args.push("--staged");
    }
    if (opts?.keepIndex) {
      args.push("--keep-index");
    }
    if (opts?.includeUntracked) {
      args.push("--include-untracked");
    }
    if (opts?.message) {
      args.push("-m", opts.message);
    }
    // After `--`, so a path that looks like an option cannot become one, and
    // literal, so one that looks like magic or a glob cannot either.
    args.push(...pathspecOf(paths));
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
      // Two of these "failures" are user states wearing an error's clothes, and
      // only appear once a stash can be narrowed:
      //
      //   git stash push --staged            (nothing staged)  -> exit 1
      //   git stash push -- <untracked path> (needs -u)        -> exit 1,
      //       "pathspec ... did not match any file(s) known to git"
      //
      // The unscoped equivalent exits 0 and says "No local changes to save", so
      // adding a pathspec would otherwise turn a calm "nothing to stash" into a
      // red error quoting git's internal pathspec syntax at the user.
      //
      // The pre-flight already knows WHY nothing could be stashed, and it was
      // asked before the push, so it is both the more accurate answer and the
      // more useful one.
      if (blocker) {
        return { ok: true, created: false, stderr: r.stderr, blocker };
      }
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
    // Every question is asked THROUGH the same pathspec the push will use.
    // Without that, stashing a selection whose files happen to be clean would
    // see the rest of the dirty tree, conclude there was something to stash, and
    // report a stash that git declined to make — the exact lie this whole
    // mechanism exists to prevent, just scoped down.
    const scope = pathspecOf(opts?.paths?.filter((p) => p.length > 0) ?? []);

    const [worktree, index] = await Promise.all([
      this.proc.run(["diff", "--name-only", "-z", ...scope], {
        signal: opts?.signal,
      }),
      this.proc.run(["diff", "--cached", "--name-only", "-z", ...scope], {
        signal: opts?.signal,
      }),
    ]);

    // `--staged` takes the index and nothing else, so unstaged work is not an
    // answer to "is there anything to stash?" here.
    if (opts?.stagedOnly) {
      return countPaths(index) > 0 ? undefined : "cleanTree";
    }

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
  private async hasUntracked(opts?: StashSaveOptions): Promise<boolean> {
    const paths = opts?.paths?.filter((p) => p.length > 0) ?? [];
    const r = await this.proc.run(
      ["ls-files", "--others", "--exclude-standard", "-z", ...pathspecOf(paths)],
      { signal: opts?.signal },
    );
    return countPaths(r) > 0;
  }

  /**
   * The stash with this sha, where the list holds it NOW, or undefined when it
   * has left the list.
   */
  async find(sha: string, opts?: GitRunOptions): Promise<StashEntry | undefined> {
    if (!isStashSha(sha)) {
      return undefined;
    }
    return (await this.list(opts)).find((e) => e.sha === sha);
  }

  /**
   * The `stash@{n}` to hand git for a stash named by sha, read from the list
   * just before git runs; a selector is taken as it is. Undefined for a sha
   * that has left the list, and for anything that is not a stash's name.
   *
   * `pop`, `drop` and `branch` need the selector — git refuses them a bare
   * commit ("is not a stash reference"), and `branch` would not drop it.
   */
  private async selectorFor(stash: string, opts?: GitRunOptions): Promise<string | undefined> {
    if (!isStashName(stash)) {
      return undefined;
    }
    return isStashSha(stash) ? (await this.find(stash, opts))?.ref : stash;
  }

  /** `git stash apply <stash>` — apply without dropping. A sha is applied as
   *  itself: git needs no selector for this one. */
  async apply(stash: string, opts?: GitRunOptions): Promise<StashOpResult> {
    if (!isStashName(stash)) {
      return notAStash(stash);
    }
    const r = await this.proc.run(["stash", "apply", stash], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git stash pop <stash>` — apply then drop on success. */
  async pop(stash: string, opts?: GitRunOptions): Promise<StashOpResult> {
    const ref = await this.selectorFor(stash, opts);
    if (!ref) {
      return isStashName(stash) ? gone() : notAStash(stash);
    }
    const r = await this.proc.run(["stash", "pop", ref], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /**
   * `git stash drop <stash>` — discard a stash entry. Named by sha, the entry
   * is found in the list immediately before git runs, so a list that was
   * renumbered while the user was being asked cannot make it drop another.
   */
  async drop(stash: string, opts?: GitRunOptions): Promise<StashOpResult> {
    const ref = await this.selectorFor(stash, opts);
    if (!ref) {
      return isStashName(stash) ? gone() : notAStash(stash);
    }
    const r = await this.proc.run(["stash", "drop", ref], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /**
   * The stash as a patch — everything it holds, empty on failure.
   *
   * `git stash show -p` alone leaves out the files a stash made with `-u`
   * holds (its third parent), so a stash of new files read as an empty
   * document: easy to drop believing there was nothing in it. They are added
   * as new files, read from that parent with plumbing that every git has
   * (`stash show --include-untracked` needs 2.32).
   */
  async show(stash: string, opts?: GitRunOptions): Promise<string> {
    if (!isStashName(stash)) {
      return "";
    }
    // `stash.showIncludeUntracked` (git 2.32+) makes `stash show` list those
    // files itself, and then they were listed twice. Set off for this run:
    // older git ignores a key it does not know.
    const tracked = await this.proc.run(
      ["-c", "stash.showIncludeUntracked=false", "stash", "show", "-p", stash],
      { signal: opts?.signal },
    );
    if (tracked.code !== 0) {
      return "";
    }
    const untracked = await this.proc.run(
      ["diff-tree", "-p", "-r", "--root", "--no-commit-id", `${stash}^3`, "--"],
      { signal: opts?.signal },
    );
    // No third parent (no -u): git exits non-zero, and there is nothing to add.
    return untracked.code === 0 ? tracked.stdout + untracked.stdout : tracked.stdout;
  }

  /**
   * Was anything STAGED when this stash was made? Then a plain apply brings
   * those changes back unstaged, and where the staged version differed from
   * the working copy (`MM`), the staged version is gone once the stash is
   * popped. Such a stash is applied with `--index` (ApplyOp's `index`).
   */
  async holdsStaged(stash: string, opts?: GitRunOptions): Promise<boolean> {
    if (!isStashName(stash)) {
      return false;
    }
    // The stash's index commit (^2) against its base (^1): the same tree
    // means nothing was staged. (Both revisions are built from a checked
    // stash name, so neither can read as an option.)
    const trees = await this.proc.run(
      ["rev-parse", `${stash}^1^{tree}`, `${stash}^2^{tree}`],
      { signal: opts?.signal },
    );
    const [base, index] = trees.stdout.split("\n").filter((l) => l.length > 0);
    return trees.code === 0 && !!base && !!index && base !== index;
  }

  /**
   * `git stash branch <name> <stash>` — create a branch at the stash's base,
   * apply it there and drop it. A name git cannot use, or one a branch already
   * has, is refused before git runs (see stashBranchNameRefusal).
   *
   * This runs git as it is. The extension's Create Branch goes through the
   * shared door instead (changesInTheWay.ts, a stash op with `branch`), which
   * asks about uncommitted work in its way first.
   */
  async branch(
    stash: string,
    name: string,
    opts?: GitRunOptions,
  ): Promise<StashOpResult> {
    const refused = await stashBranchNameRefusal(this.proc, name, opts?.signal);
    if (refused) {
      return { ok: false, stderr: refused };
    }
    const ref = await this.selectorFor(stash, opts);
    if (!ref) {
      return isStashName(stash) ? gone() : notAStash(stash);
    }
    const r = await this.proc.run(["stash", "branch", name, ref], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }
}

/**
 * Why `git stash branch <name>` cannot take this name, or undefined when it
 * can. Asked before git runs: a name like an option would be read as one, and
 * git refuses a name that is no branch name, or that a branch already has,
 * only after it has looked — in its own words.
 */
export async function stashBranchNameRefusal(
  proc: GitProcess,
  name: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (name.length === 0 || name.startsWith("-")) {
    return `“${name}” is not a branch name git can use.`;
  }
  if ((await proc.run(["check-ref-format", "--branch", name], { signal })).code !== 0) {
    return `“${name}” is not a branch name git can use.`;
  }
  const exists = await proc.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { signal });
  return exists.code === 0 ? `A branch named “${name}” already exists.` : undefined;
}

function gone(): StashOpResult {
  return { ok: false, gone: true, stderr: STASH_GONE_MESSAGE };
}

function notAStash(name: string): StashOpResult {
  return { ok: false, stderr: `“${name}” is not a stash.` };
}

/**
 * `path` as a pathspec that matches that file (or everything under that
 * directory) and nothing else: no magic, no glob.
 *
 * A bare path after `--` is still a PATTERN. ":odd" is short magic for the
 * file "odd", so a stash of ":odd" took "odd" and left ":odd" where it was;
 * "*glob*" and "a[bc].txt" match their neighbours too. `:(literal)` per path
 * rather than `--literal-pathspecs` for the whole command: under that flag a
 * pathspec that already says `:(literal)` is read as a file of that name, so
 * the two cannot be mixed, and this one form is what stashTheWay's `reset`
 * and `rm --cached` use as well.
 */
export function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

/** `-- <each path, literally>`, or nothing for no paths (the whole tree). */
function pathspecOf(paths: readonly string[]): string[] {
  return paths.length > 0 ? ["--", ...paths.map(literalPathspec)] : [];
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
