import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitProcess, GitRunOptions } from "./GitProcess";
import { restoreStash, stashStack } from "./stashRestore";
import * as l10n from "@vscode/l10n";

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
export const STASH_GONE_MESSAGE = l10n.t("That stash is no longer in the list, so nothing was changed.");

// ── What a stash holds ───────────────────────────────────────────────────────

/**
 * A file's change in a stash, in the letters the Changes view uses: M, A, D,
 * R (renamed), T (type changed), and U for a file git did not track, which a
 * stash made with `-u` keeps in its third parent.
 */
export type StashFileStatus = "M" | "A" | "D" | "R" | "T" | "U";

/** One file a stash holds. */
export interface StashFile {
  /** Repo-relative path — for a rename, its new name. */
  path: string;
  /** A rename's old name. */
  oldPath?: string;
  status: StashFileStatus;
  /**
   * Staged when the stash was made. "all": the stash's index holds the same
   * version as its working copy; "part": a different one (staged, then edited
   * further — or staged and then put back in the working tree).
   */
  staged?: "all" | "part";
  /**
   * The stash's working copy is the base's: only its staged version differs
   * (staged, and then put back in the working tree). Its changes are the
   * staged ones.
   */
  onlyStaged?: true;
  /** Its content is binary: there is no text to diff. */
  binary?: true;
}

/**
 * A stash's message as a row shows it: the words, and the branch it was made
 * on. git writes "On main: my words" for a stash with a message and "WIP on
 * main: 1a2b3c4 subject" for one without, so every row of a list read "On
 * main:" and the words that tell stashes apart were cut off.
 */
export interface StashTitle {
  /** What the row says. Never empty. */
  text: string;
  /** The branch it was made on; absent on a detached HEAD, or when the
   *  message is not one git wrote (another tool's, or `stash store -m`). */
  branch?: string;
  /** git wrote it — nobody typed these words. */
  auto?: true;
}

/** "On main: words", "WIP on main: 1a2b3c4 subject", and anything else, as a row says them. */
export function stashTitle(message: string): StashTitle {
  // A branch name cannot hold a colon, so the first ": " ends it.
  const typed = /^On ([^:]+): ([\s\S]*)$/.exec(message);
  const wip = /^WIP on ([^:]+): (?:[0-9a-f]{4,64} )?([\s\S]*)$/.exec(message);
  const branchOf = (b: string): string | undefined => (b === "(no branch)" ? undefined : b);
  if (typed) {
    const words = typed[2].trim();
    // GitHub Desktop stashes with a marker instead of words.
    const desktop = /^!!GitHub_Desktop<(.+)>$/.exec(words);
    if (desktop) {
      return { text: l10n.t("Stashed by GitHub Desktop"), branch: desktop[1] };
    }
    return { text: words || l10n.t("(no message)"), ...optional("branch", branchOf(typed[1])) };
  }
  if (wip) {
    const subject = wip[2].trim();
    return {
      // "WIP: subject", never quoted here: every question, label and bar
      // puts a stash's words in quotes of its own, and quotes inside them
      // read "Drop “WIP on “Add tests””?".
      text: subject ? `WIP: ${subject}` : "WIP",
      ...optional("branch", branchOf(wip[1])),
      auto: true,
    };
  }
  if (message.trim() === "autostash") {
    // What git's own autostash (pull or rebase with autoStash) is stored as
    // when it could not be put back.
    return { text: "Autostash", auto: true };
  }
  return { text: message.trim() || l10n.t("(no message)") };
}

function optional<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return (value === undefined ? {} : { [key]: value }) as { [P in K]?: V };
}

/** A stash-shaped commit cut from a stash: some of its files, and nothing else. */
export type StashSubsetResult = { ok: true; sha: string } | { ok: false; stderr: string };

/** One side of a stash (its working tree, its index, its untracked files), by path. */
interface StashSide {
  /** path → its entry there, or null where the side removes it. */
  entries: Map<string, { mode: string; oid: string } | null>;
}

/** What `files` reads, kept for `subset` to cut from. A stash never changes. */
interface StashContents {
  files: StashFile[];
  tree: StashSide;
  index: StashSide;
  untracked: StashSide;
  /** The commits the stash is built from. */
  base: string;
  indexCommit: string;
  untrackedCommit?: string;
}

/** How many stashes' file lists are kept, newest reads last. */
const CONTENTS_CACHE = 200;

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
          return l10n.t("Nothing to stash — the files you selected have no changes.");
        case "staged":
          return l10n.t("Nothing to stash — nothing is staged.");
        default:
          return l10n.t("Nothing to stash — the working tree is clean.");
      }
    case "untrackedOnly":
      return scope === "selection"
        ? l10n.t("Nothing was stashed — the files you selected are new ones git isn't tracking yet. Stash again with \"Include untracked files\" to put those away too.")
        : l10n.t("Nothing was stashed — the only changes are new files git isn't tracking yet. Stash again with \"Include untracked files\" to put those away too.");
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
  /** What each stash holds, by its sha — a stash is immutable, so never stale. */
  private readonly contentsCache = new Map<string, StashContents>();

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
          l10n.t("Stashing the staged changes of specific files is not supported by git — ") +
          l10n.t("stash the whole staged section, or stash those files entirely."),
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
   * Every file the stash holds — its tracked changes, whether each was staged,
   * and the untracked files a `-u` stash keeps in its third parent — sorted by
   * path. Undefined when `stash` is not a stash's full sha, or git can't read
   * it. Read once per stash: a stash never changes, its sha is its content.
   *
   * Plumbing only (`diff-tree`), so no diff configuration of the user's —
   * colour, renames, external diff — can change what is read.
   */
  async files(stash: string, opts?: GitRunOptions): Promise<StashFile[] | undefined> {
    return (await this.contents(stash, opts))?.files;
  }

  private async contents(stash: string, opts?: GitRunOptions): Promise<StashContents | undefined> {
    if (!isStashSha(stash)) {
      return undefined;
    }
    const cached = this.contentsCache.get(stash);
    if (cached) {
      // Most recently read last, so the oldest read is the one let go.
      this.contentsCache.delete(stash);
      this.contentsCache.set(stash, cached);
      return cached;
    }
    const signal = opts?.signal;
    const parents = await this.proc.run(["rev-list", "--parents", "-n", "1", stash, "--"], { signal });
    const [, base, indexCommit, untrackedCommit] = parents.code === 0 ? parents.stdout.trim().split(/\s+/) : [];
    if (!base || !indexCommit) {
      return undefined;
    }
    const [tree, index, untracked] = await Promise.all([
      this.proc.run(["diff-tree", "-r", "-z", "--raw", "--numstat", "-M", "--no-commit-id", base, stash, "--"], { signal }),
      this.proc.run(["diff-tree", "-r", "-z", "--raw", "-M", "--no-commit-id", base, indexCommit, "--"], { signal }),
      untrackedCommit
        ? this.proc.run(["diff-tree", "-r", "-z", "--raw", "--numstat", "--root", "--no-commit-id", untrackedCommit, "--"], { signal })
        : Promise.resolve({ code: 0, stdout: "", stderr: "" }),
    ]);
    if (tree.code !== 0 || index.code !== 0 || untracked.code !== 0) {
      return undefined;
    }
    const w = parseRawDiff(tree.stdout);
    const i = parseRawDiff(index.stdout);
    const u = parseRawDiff(untracked.stdout);

    const byPath = new Map<string, StashFile>();
    for (const r of w.records) {
      byPath.set(r.path, {
        path: r.path,
        ...(r.oldPath !== undefined ? { oldPath: r.oldPath } : {}),
        status: letterOf(r.status),
        ...(w.binary.has(r.path) ? { binary: true as const } : {}),
      });
    }
    for (const r of i.records) {
      const f = byPath.get(r.path);
      if (f) {
        const inTree = w.records.find((x) => x.path === r.path);
        f.staged = inTree && inTree.mode === r.mode && inTree.oid === r.oid ? "all" : "part";
      } else {
        // Staged, and the working copy was then put back as it was: the
        // stash's index is all it holds of this file.
        byPath.set(r.path, {
          path: r.path,
          ...(r.oldPath !== undefined ? { oldPath: r.oldPath } : {}),
          status: letterOf(r.status),
          staged: "part",
          onlyStaged: true,
        });
      }
    }
    for (const r of u.records) {
      if (!byPath.has(r.path)) {
        byPath.set(r.path, { path: r.path, status: "U", ...(u.binary.has(r.path) ? { binary: true as const } : {}) });
      }
    }
    const contents: StashContents = {
      files: [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
      tree: sideOf(w.records),
      index: sideOf(i.records),
      untracked: sideOf(u.records),
      base,
      indexCommit,
      ...(untrackedCommit ? { untrackedCommit } : {}),
    };
    this.contentsCache.set(stash, contents);
    while (this.contentsCache.size > CONTENTS_CACHE) {
      const oldest = this.contentsCache.keys().next().value;
      if (oldest === undefined) break;
      this.contentsCache.delete(oldest);
    }
    return contents;
  }

  /**
   * A stash-shaped commit holding only `paths` of this stash — their working
   * copies, their staged versions and, from a `-u` stash, those untracked
   * files — over the same base, with the stash's own author, dates and
   * message. `git stash apply` takes it like any stash, so it goes through
   * the same door (Stash & Retry, the staging question, a conflict pause).
   * Nothing the user can see changes: a commit is only written as objects.
   *
   * The two names of a rename travel together: picking either takes both, or
   * the new name would come back as a copy with the old one still there.
   * Paths the stash does not hold are ignored; picking none is refused.
   *
   * `unstaged`: the part to apply WITHOUT `--index`, which restores only
   * working copies. A file the stash holds only staged (`onlyStaged`:
   * staged, then put back in the working tree) has the base as its working
   * copy, so nothing of it would come back; here its staged version is its
   * working copy instead, and its change comes back unstaged.
   */
  async subset(
    stash: string,
    paths: readonly string[],
    opts?: GitRunOptions & { unstaged?: boolean },
  ): Promise<StashSubsetResult> {
    const signal = opts?.signal;
    const c = await this.contents(stash, opts);
    if (!c) {
      return { ok: false, stderr: l10n.t("“{0}” is not a stash git can read.", stash) };
    }
    const wanted = new Set(paths);
    const picked = c.files.filter((f) => wanted.has(f.path) || (f.oldPath !== undefined && wanted.has(f.oldPath)));
    if (picked.length === 0) {
      return { ok: false, stderr: l10n.t("None of those files are in the stash.") };
    }
    // Every name the picked files have on either side: a rename's old name too.
    const names = new Set<string>();
    for (const f of picked) {
      names.add(f.path);
      if (f.oldPath !== undefined) names.add(f.oldPath);
    }
    const zero = "0".repeat(stash.length);
    const info = await this.proc.run(
      ["log", "-1", "--date=raw", "--format=%an%x1f%ae%x1f%ad%x1f%cn%x1f%ce%x1f%cd", stash, "--"],
      { signal },
    );
    const [an, ae, ad, cn, ce, cd] = info.code === 0 ? info.stdout.replace(/\n$/, "").split(FIELD_SEP) : [];
    const ident: Record<string, string> = {};
    if (an !== undefined && ae !== undefined && ad && cn !== undefined && ce !== undefined && cd) {
      Object.assign(ident, {
        GIT_AUTHOR_NAME: an,
        GIT_AUTHOR_EMAIL: ae,
        GIT_AUTHOR_DATE: `@${ad}`,
        GIT_COMMITTER_NAME: cn,
        GIT_COMMITTER_EMAIL: ce,
        GIT_COMMITTER_DATE: `@${cd}`,
      });
    }
    const messageOf = async (commit: string): Promise<string> => {
      const r = await this.proc.run(["log", "-1", "--format=%B", commit, "--"], { signal });
      return r.code === 0 && r.stdout.trim() ? r.stdout : "stash\n";
    };

    const dir = mkdtempSync(join(tmpdir(), "gs-stash-part-"));
    const env = { GIT_INDEX_FILE: join(dir, "index") };
    const fail = (what: string, r: { stderr: string }): StashSubsetResult => ({
      ok: false,
      stderr: l10n.t("Couldn't take those files out of the stash ({0}): {1}", what, r.stderr.trim() || "git refused"),
    });
    try {
      // One side's tree: `start` (a commit, or nothing), with each name set as
      // the side has it — or removed, where the side removes it.
      const treeOf = async (start: string | null, side: StashSide, only: Iterable<string>): Promise<StashSubsetResult> => {
        const read = await this.proc.run(start ? ["read-tree", start] : ["read-tree", "--empty"], { signal, env });
        if (read.code !== 0) return fail("read-tree", read);
        let input = "";
        for (const name of only) {
          if (!side.entries.has(name)) continue;
          const e = side.entries.get(name);
          input += e ? `${e.mode} ${e.oid}\t${name}\0` : `0 ${zero}\t${name}\0`;
        }
        if (input) {
          const upd = await this.proc.run(["update-index", "-z", "--index-info"], { signal, env, input });
          if (upd.code !== 0) return fail("update-index", upd);
        }
        const written = await this.proc.run(["write-tree"], { signal, env });
        return written.code === 0 ? { ok: true, sha: written.stdout.trim() } : fail("write-tree", written);
      };
      const commit = async (tree: string, parents: string[], message: string): Promise<StashSubsetResult> => {
        const args = ["commit-tree", tree];
        for (const p of parents) args.push("-p", p);
        args.push("-F", "-");
        const r = await this.proc.run(args, { signal, env: ident, input: message });
        return r.code === 0 ? { ok: true, sha: r.stdout.trim() } : fail("commit-tree", r);
      };

      const workTree = await treeOf(c.base, opts?.unstaged ? stagedAsWorking(c, picked) : c.tree, names);
      if (!workTree.ok) return workTree;
      const indexTree = await treeOf(c.base, c.index, names);
      if (!indexTree.ok) return indexTree;
      const indexCommit = await commit(indexTree.sha, [c.base], await messageOf(c.indexCommit));
      if (!indexCommit.ok) return indexCommit;
      const parents = [c.base, indexCommit.sha];
      const loose = [...names].filter((n) => c.untracked.entries.has(n));
      if (loose.length > 0 && c.untrackedCommit) {
        const untrackedTree = await treeOf(null, c.untracked, loose);
        if (!untrackedTree.ok) return untrackedTree;
        const untrackedCommit = await commit(untrackedTree.sha, [], await messageOf(c.untrackedCommit));
        if (!untrackedCommit.ok) return untrackedCommit;
        parents.push(untrackedCommit.sha);
      }
      return await commit(workTree.sha, parents, await messageOf(stash));
    } finally {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // The OS sweeps its temp directory; a leftover index is harmless.
      }
    }
  }

  /**
   * Put `replacement` where the stash `stash` is in the list, with its
   * message: what is left of a stash once some of its files have been moved
   * out. git has no "replace" or "insert at" — `git stash store` only pushes
   * on top — so the stash is dropped and the replacement stored at its place
   * the way Undo of a drop does (stashRestore.ts). The stash is found by its
   * sha just before; `gone` when it has left the list, and nothing changes.
   */
  async replace(stash: string, replacement: string, opts?: GitRunOptions): Promise<StashOpResult & { index?: number }> {
    if (!isStashSha(stash) || !isStashSha(replacement)) {
      return notAStash(isStashSha(stash) ? replacement : stash);
    }
    const stack = await stashStack(this.proc, opts);
    const at = stack.findIndex((s) => s.sha === stash);
    if (at < 0) {
      return gone();
    }
    const entry = stack[at];
    const dropped = await this.proc.run(["stash", "drop", "-q", `stash@{${at}}`], { signal: opts?.signal });
    if (dropped.code !== 0) {
      return { ok: false, stderr: dropped.stderr };
    }
    const put = await restoreStash(
      this.proc,
      { sha: replacement, message: entry.message },
      { index: at, above: stack.slice(0, at).map((s) => s.sha) },
      opts,
    );
    if (!put.ok) {
      // The rest of its files are still in the object store; say how to get
      // them back rather than lose them quietly.
      return {
        ok: false,
        stderr: l10n.t("{0} The files left in the stash are in commit {1}: `git stash store {2}` brings them back.", put.message, replacement, replacement),
      };
    }
    return { ok: true, stderr: "", index: put.index };
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
    return l10n.t("“{0}” is not a branch name git can use.", name);
  }
  if ((await proc.run(["check-ref-format", "--branch", name], { signal })).code !== 0) {
    return l10n.t("“{0}” is not a branch name git can use.", name);
  }
  const exists = await proc.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`], { signal });
  return exists.code === 0 ? l10n.t("A branch named “{0}” already exists.", name) : undefined;
}

/** One `diff-tree --raw` record: the new side's mode and blob, and git's letter. */
interface RawRecord {
  status: string;
  path: string;
  oldPath?: string;
  mode: string;
  oid: string;
}

/**
 * `diff-tree -z --raw [--numstat]` output: the raw records, and the paths
 * numstat calls binary ("-\t-"). Raw records start with ":"; numstat ones
 * with a count or "-" — and for a rename, an empty name followed by the old
 * and new ones.
 */
function parseRawDiff(stdout: string): { records: RawRecord[]; binary: Set<string> } {
  const t = stdout.split("\0");
  const records: RawRecord[] = [];
  const binary = new Set<string>();
  for (let i = 0; i < t.length; i++) {
    const tok = t[i];
    if (!tok) continue;
    if (tok.startsWith(":")) {
      const [, mode, , oid, status] = tok.slice(1).split(" ");
      if (!status) continue;
      if (/^[RC]/.test(status)) {
        records.push({ status, oldPath: t[i + 1], path: t[i + 2], mode, oid });
        i += 2;
      } else {
        records.push({ status, path: t[i + 1], mode, oid });
        i += 1;
      }
      continue;
    }
    const m = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(tok);
    if (!m) continue;
    let path = m[3];
    if (path === "") {
      // A rename: "added\tdeleted\t" then the old name, then the new one.
      path = t[i + 2] ?? "";
      i += 2;
    }
    if (m[1] === "-" && m[2] === "-" && path) binary.add(path);
  }
  return { records, binary };
}

/** git's raw status as the Changes view's letter. A copy is a new file. */
function letterOf(status: string): StashFileStatus {
  switch (status.charAt(0)) {
    case "A":
    case "C":
      return "A";
    case "D":
      return "D";
    case "R":
      return "R";
    case "T":
      return "T";
    default:
      return "M";
  }
}

/** A side's entries by path: what each record leaves there, a rename's old name removed. */
function sideOf(records: readonly RawRecord[]): StashSide {
  const entries = new Map<string, { mode: string; oid: string } | null>();
  for (const r of records) {
    if (r.status.startsWith("R") && r.oldPath !== undefined) entries.set(r.oldPath, null);
    entries.set(r.path, r.status.startsWith("D") ? null : { mode: r.mode, oid: r.oid });
  }
  return { entries };
}

/**
 * The stash's working-tree side, with each of `picked` that it holds only
 * staged taken from its index side instead (see subset's `unstaged`).
 */
function stagedAsWorking(c: StashContents, picked: readonly StashFile[]): StashSide {
  const entries = new Map(c.tree.entries);
  for (const f of picked) {
    if (!f.onlyStaged) continue;
    for (const name of f.oldPath !== undefined ? [f.path, f.oldPath] : [f.path]) {
      if (c.index.entries.has(name)) entries.set(name, c.index.entries.get(name) ?? null);
    }
  }
  return { entries };
}

function gone(): StashOpResult {
  return { ok: false, gone: true, stderr: STASH_GONE_MESSAGE };
}

function notAStash(name: string): StashOpResult {
  return { ok: false, stderr: l10n.t("“{0}” is not a stash.", name) };
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
