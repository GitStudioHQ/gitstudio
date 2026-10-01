import { existsSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { sameFolder } from "./folderPath";
import type { GitProcess, GitRunOptions } from "./GitProcess";
import { stoppedIn, type StoppedOperation } from "./stoppedOperation";
import { StashProvider } from "./StashProvider";
import {
  readCommits,
  readWorktreesSnapshot,
  readWorktreeStatus,
  type WorktreeCommit,
  type WorktreeStatus,
  type WorktreeSummary,
  type WorktreesSnapshot,
} from "./worktreeState";
import * as l10n from "@vscode/l10n";

// Worktree paths are compared through the one shared rule (folderPath.ts);
// re-exported here, where the extension and the desktop import them from.
export { folderKey, sameFolder } from "./folderPath";

/** One linked worktree as reported by `git worktree list --porcelain`. */
export interface WorktreeEntry {
  /** Absolute path to the worktree. */
  path: string;
  /** The checked-out commit sha (empty for a bare main worktree). */
  head: string;
  /** Short branch name (refs/heads/<branch> → <branch>), if on a branch. */
  branch?: string;
  /** True for the bare repository entry. */
  bare?: boolean;
  /** True when the worktree is locked. */
  locked?: boolean;
  /** Why it is locked — the `--reason` it was locked with; absent when it was
   *  locked without one. An agent's lock names the agent and its pid here. */
  lockReason?: string;
  /** True when git considers the worktree prunable (its path is gone). */
  prunable?: boolean;
  /** Why git would prune it ("gitdir file points to non-existent location"). */
  prunableReason?: string;
}

export interface WorktreeAddOptions extends GitRunOptions {
  /** Create a new branch (`-b <ref>`) instead of checking out an existing one. */
  newBranch?: boolean;
  /** When `newBranch`, the ref the new branch starts from (`git worktree add
   *  -b <ref> <path> <startPoint>`). Defaults to the current HEAD when unset. */
  startPoint?: string;
  /** When `newBranch`, suppress the new branch tracking its start point
   *  (`--no-track`). Pass it whenever the branch's name differs from the start
   *  point's short name: under git's default `branch.autoSetupMerge=true` a
   *  `-b foo <path> origin/feature` would otherwise auto-track origin/feature,
   *  and GitStudio's push then targets that remote branch. This implements
   *  `branch.autoSetupMerge=simple` semantics ourselves. */
  noTrack?: boolean;
}

export interface WorktreeRemoveOptions extends GitRunOptions {
  /** `--force`: remove it even with uncommitted changes, which are deleted
   *  with the folder. It does NOT get past a lock — see `evenIfLocked`. */
  force?: boolean;
  /** `--force` twice: git's only way to remove a LOCKED worktree (one
   *  `--force` is refused: "cannot remove a locked working tree"). Like
   *  `force`, it also deletes uncommitted changes. */
  evenIfLocked?: boolean;
}

export interface WorktreeAgreedRemoveOptions extends GitRunOptions {
  /** Its uncommitted changes go with it — the ones the question listed:
   *  `listed` is removal()'s `changes`, exactly as asked about. They are read
   *  again just before the `--force`, and a path the question never named
   *  stops it (see removeAsAgreed). `listed: undefined` — the question could
   *  not read them, and said any it has go. */
  discardChanges?: { listed: readonly string[] | undefined };
  /**
   * Its uncommitted changes — the ones the question listed — are STASHED in
   * it first (`stash push --include-untracked -m <message>`), and then it is
   * removed without `--force`. The stash stack is the repository's, not the
   * worktree's, so the stash outlives the folder and shows in every
   * worktree's stash list. A path the question never listed stops it before
   * anything runs, as for `discardChanges`.
   */
  stashChanges?: { listed: readonly string[] | undefined; message: string };
  /** It is locked and removing it anyway was agreed; `reason` is the lock's,
   *  put back if git refuses the remove. */
  pastLock?: { reason?: string };
}

export interface WorktreeLockOptions extends GitRunOptions {
  /** `--reason <text>`: why, kept by git and shown with the lock. */
  reason?: string;
}

/**
 * What removing a worktree takes, read before git runs — so the question a
 * host asks can name what will be lost (and refuse what git would refuse)
 * instead of relaying git's refusal after the person already said yes.
 */
export type WorktreeRemoval =
  /** Not a worktree of this repository (any more): nothing to remove. */
  | { kind: "notListed" }
  /** The main worktree, or the bare repository itself: git never removes it. */
  | { kind: "main"; entry: WorktreeEntry }
  /** Its folder is gone. Removing it only forgets git's record of it — past
   *  its lock, when it has one (`entry.locked`). */
  | { kind: "missing"; entry: WorktreeEntry }
  /** Its folder is there, but is not a worktree any more: its .git is gone
   *  (`entry.prunableReason` says what git makes of it; a LOCKED one has
   *  none, as git never prunes it). Git run in the folder reads the
   *  repository around it — the main worktree, for one nested in it — so
   *  nothing is read there. Removing it only forgets git's record of it, past
   *  its lock when it has one; the folder and its files stay. */
  | { kind: "stale"; entry: WorktreeEntry }
  /** Its folder is there. `changes` are the paths git counts as uncommitted
   *  there, which removing it deletes; undefined when they could not be read.
   *  `operation`: what git is stopped in THERE — removing the worktree
   *  abandons it, and git says nothing (a clean worktree mid-rebase goes
   *  with a plain remove, exit 0). `unmerged`: files left unmerged there,
   *  which `git stash` refuses ("needs merge") — so they can only be
   *  discarded with it. */
  | {
      kind: "present";
      entry: WorktreeEntry;
      changes?: string[];
      operation?: StoppedOperation;
      unmerged?: number;
    };

export interface WorktreeOpResult {
  ok: boolean;
  stderr: string;
  /** removeAsAgreed ran nothing: the worktree has uncommitted changes the
   *  question never listed (or they could no longer be read), made since it
   *  was asked — or its folder is not the worktree any more (its .git went).
   *  Read removal() again and ask again; `stderr` is empty. */
  changedSince?: true;
  /** `stashChanges`: the stash was made — by its commit sha — whether or not
   *  the remove that followed it went through. */
  stashed?: string;
}

/**
 * Host-agnostic `git worktree` plumbing: list/add/remove/move/prune/lock.
 * Pure git CLI — never imports `vscode`. Worktrees are absent from free VS Code,
 * so this is a first-class GitStudio surface.
 */
export class WorktreeProvider {
  constructor(private proc: GitProcess) {}

  /**
   * Whether this git knows `worktree list -z` (2.36+). Asked once: an older
   * git answers the flag with its usage (exit 129), and the newline form is
   * read from then on — which a path holding a newline breaks, as it always
   * did there.
   */
  private listZ: boolean | undefined;

  /** `git worktree list --porcelain [-z]` parsed into entries. */
  async list(opts?: GitRunOptions): Promise<WorktreeEntry[]> {
    if (this.listZ !== false) {
      const z = await this.proc.run(["worktree", "list", "--porcelain", "-z"], { signal: opts?.signal });
      if (z.code === 0) {
        this.listZ = true;
        return parseWorktreePorcelainZ(z.stdout);
      }
      if (z.code !== 129) {
        return [];
      }
      this.listZ = false;
    }
    const r = await this.proc.run(["worktree", "list", "--porcelain"], {
      signal: opts?.signal,
    });
    if (r.code !== 0) {
      return [];
    }
    return parseWorktreePorcelain(r.stdout);
  }

  /** Tier 0: every worktree's summary and the repository's remotes and
   *  default branch, in three spawns (see worktreeState.ts). */
  snapshot(opts?: GitRunOptions): Promise<WorktreesSnapshot> {
    return readWorktreesSnapshot(this.proc, (o) => this.list(o), opts);
  }

  /** Tier 1: what one worktree's working tree holds and what git is stopped in there. */
  status(
    w: WorktreeSummary,
    snap: Pick<WorktreesSnapshot, "remotes" | "defaultBranch">,
    opts?: GitRunOptions,
  ): Promise<WorktreeStatus | undefined> {
    return readWorktreeStatus(this.proc, w, snap, opts);
  }

  /** Tier 2: up to `limit` commits `range` selects, read in the worktree at `path`. */
  commits(
    path: string,
    range: string[],
    limit: number,
    opts?: GitRunOptions,
  ): Promise<{ commits: WorktreeCommit[]; more: boolean }> {
    return readCommits(this.proc, path, range, limit, opts);
  }

  /**
   * `git worktree add [-b <ref>] -- <path> <ref>` — check out `ref` (or a new
   * branch named `ref`) into a fresh worktree at `path`.
   *
   * A new branch's upstream is decided HERE, not left to the user's
   * `branch.autoSetupMerge`: git's default (`true`) makes a differently-named
   * branch started from a remote-tracking ref auto-track it, and GitStudio's
   * push then targets that remote branch — a commit the user never asked for.
   * So `noTrack` should be set whenever the new branch's name differs from the
   * start point's short name, keeping tracking only when the names match (the
   * `simple` semantics, and what JetBrains' "New Branch from remote" does).
   */
  async add(
    path: string,
    ref: string,
    opts?: WorktreeAddOptions,
  ): Promise<WorktreeOpResult> {
    // The path and the ref after `--`: a branch named "-x" (update-ref makes
    // one, and a fetch can bring one in) is otherwise read as an option. So
    // every option goes BEFORE it — `--no-track` after `--` would be a path.
    const args = ["worktree", "add"];
    if (opts?.newBranch) {
      args.push("-b", ref);
      if (opts.noTrack) {
        args.push("--no-track");
      }
      args.push("--", path);
      if (opts.startPoint) {
        args.push(opts.startPoint);
      }
    } else {
      args.push("--", path, ref);
    }
    // `-b` makes the branch BEFORE git looks at the folder, and a failed add
    // leaves it behind — so retrying with the same name then fails on the
    // name. Note the commit a new branch starts at, and drop it again if the
    // add fails (only a branch this call made: absent before, still there).
    const madeAt = opts?.newBranch ? await this.newBranchStart(ref, opts) : undefined;
    const r = await this.proc.run(args, { signal: opts?.signal });
    if (r.code !== 0 && madeAt) {
      await this.dropBranchLeftAt(ref, madeAt);
    }
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** The commit `git worktree add -b <name>` would create the branch at, or
   *  undefined when refs/heads/<name> already exists (git then refuses, and
   *  that branch is not this call's to delete). */
  private async newBranchStart(
    name: string,
    opts: WorktreeAddOptions,
  ): Promise<string | undefined> {
    const existing = await this.proc.run(
      ["rev-parse", "--verify", "--quiet", `refs/heads/${name}`],
      { signal: opts.signal },
    );
    if (existing.code === 0) {
      return undefined;
    }
    const start = await this.proc.run(
      ["rev-parse", "--verify", "--quiet", `${opts.startPoint ?? "HEAD"}^{commit}`],
      { signal: opts.signal },
    );
    return start.code === 0 ? start.stdout.trim() || undefined : undefined;
  }

  /** Delete refs/heads/<name> when it still sits where a failed add made it.
   *  `git branch -D` rather than `update-ref -d`: it also drops the
   *  branch.<name>.* tracking config the add may have written, which a later
   *  branch of the same name would otherwise inherit. */
  private async dropBranchLeftAt(name: string, sha: string): Promise<void> {
    const now = await this.proc.run(["rev-parse", "--verify", "--quiet", `refs/heads/${name}`]);
    if (now.code !== 0 || now.stdout.trim() !== sha) {
      return;
    }
    await this.proc.run(["branch", "-D", "--", name]);
  }

  /**
   * The MAIN repository's working-tree root — the repo's "home" checkout, not
   * this (possibly linked) worktree. `git worktree list` always reports the
   * primary worktree first, so its path is the main checkout even when this
   * runs from inside a linked worktree. Returns undefined when git can't report
   * it. Used to name new worktree folders with a stable project prefix
   * regardless of where the add is initiated from.
   *
   * NOT `rev-parse --absolute-git-common-dir`: Apple Git doesn't recognize that
   * flag and `git rev-parse` then echoes the flag back as its own output
   * (exit 0), turning the "project name" into ".". Worktree-list parsing has no
   * such dependence on flag support.
   */
  async mainRoot(opts?: GitRunOptions): Promise<string | undefined> {
    const entries = await this.list(opts);
    return entries[0]?.path;
  }

  /**
   * What removing the worktree at `path` takes, read fresh: refused (the main
   * worktree), forgotten (its folder is gone), or removed along with the
   * uncommitted changes listed. See WorktreeRemoval.
   */
  async removal(path: string, opts?: GitRunOptions): Promise<WorktreeRemoval> {
    const list = await this.list(opts);
    const at = list.findIndex((e) => sameFolder(e.path, path));
    if (at < 0) {
      return { kind: "notListed" };
    }
    const entry = list[at];
    // `git worktree list` always reports the main worktree first.
    if (at === 0 || entry.bare) {
      return { kind: "main", entry };
    }
    // Not `entry.prunable`: git never marks a LOCKED worktree prunable, even
    // with its folder gone — the folder itself is the answer.
    if (!existsSync(entry.path)) {
      return { kind: "missing", entry };
    }
    // Its folder is there but is not this worktree: nothing is read in it
    // (its "changes" would be the repository's around it).
    if (entry.prunable || !existsSync(join(entry.path, ".git")) || !(await this.isWorktreeRoot(entry.path, opts))) {
      return { kind: "stale", entry };
    }
    // Read in THAT worktree: its index and its operation markers are its own.
    const [changes, stop] = await Promise.all([
      this.uncommitted(entry.path, opts),
      stoppedIn(this.proc.at(entry.path), opts?.signal),
    ]);
    return {
      kind: "present",
      entry,
      changes,
      ...(stop?.operation ? { operation: stop.operation } : {}),
      ...(stop?.unmerged ? { unmerged: stop.unmerged } : {}),
    };
  }

  /**
   * Whether git run IN `path` is the worktree at `path`: `rev-parse
   * --show-toplevel` there names the folder itself. A folder whose .git is
   * gone answers with the repository AROUND it — the main worktree, for one
   * nested in it (…/app/.claude/worktrees/x) — and a read or a stash there
   * would be that repository's. Asked before anything is read or run there
   * that deletes or moves changes.
   */
  async isWorktreeRoot(path: string, opts?: GitRunOptions): Promise<boolean> {
    const r = await this.proc.run(["-C", path, "rev-parse", "--show-toplevel"], { signal: opts?.signal });
    return r.code === 0 && sameFolder(r.stdout.trim(), path);
  }

  /**
   * The paths `git worktree remove` counts as uncommitted in the worktree at
   * `path` — git's own check (`status --porcelain --ignore-submodules=none`):
   * staged, unstaged and untracked, never ignored. Undefined when git could
   * not say (then git would refuse a plain remove too).
   */
  async uncommitted(path: string, opts?: GitRunOptions): Promise<string[] | undefined> {
    const r = await this.proc.run(
      ["-C", path, "status", "--porcelain", "-z", "--ignore-submodules=none"],
      { signal: opts?.signal },
    );
    if (r.code !== 0) {
      return undefined;
    }
    const names: string[] = [];
    const fields = r.stdout.split("\0");
    for (let i = 0; i < fields.length; i++) {
      const f = fields[i];
      if (f.length < 4) {
        continue;
      }
      names.push(f.slice(3));
      // A rename or copy is followed by the field naming where it came from.
      if (/[RC]/.test(f.slice(0, 2))) {
        i++;
      }
    }
    return names;
  }

  /**
   * Remove a worktree the way the person agreed to, after the question
   * `removal()` let a host ask. `discardChanges`: the uncommitted changes it
   * listed go too (`--force`). `pastLock`: it is locked, and removing it anyway
   * was agreed.
   *
   * A change made SINCE the question — an agent still at work in it — is never
   * deleted unasked. Without `discardChanges` there is no `--force`, so git
   * refuses it. Past a lock that means unlocking first (a second `--force`
   * would also delete changes), and locking it again, with its reason, when
   * git refuses. With `discardChanges` git would delete anything, so the
   * changes are read again first: a path the question did not list runs
   * nothing and answers `changedSince` — a worktree that was already dirty
   * when asked (an agent's, typically) is the common case, not the rare one.
   * Only the moment between that read and git's own is left uncovered — and
   * a new file inside an untracked folder the question already named whole
   * (`tmp/`, as git reports one), which is inside what was agreed to. With
   * `discardChanges` a lock is passed with the second `--force`.
   */
  async removeAsAgreed(
    path: string,
    opts: WorktreeAgreedRemoveOptions,
  ): Promise<WorktreeOpResult> {
    const signal = opts.signal;
    // Nothing is stashed from, or read in, a folder that is not this worktree
    // any more (its .git went since the question): it would be the repository
    // AROUND it — the main worktree, emptied into a stash named for this one.
    // Asked again, it is a worktree to forget.
    if ((opts.stashChanges || opts.discardChanges) && !(await this.isWorktreeRoot(path, { signal }))) {
      return { ok: false, stderr: "", changedSince: true };
    }
    if (opts.stashChanges) {
      const { listed, message } = opts.stashChanges;
      if (listed) {
        const now = await this.uncommitted(path, { signal });
        const agreed = new Set(listed);
        if (now === undefined || now.some((p) => !agreed.has(p))) {
          return { ok: false, stderr: "", changedSince: true };
        }
      }
      const here = this.proc.at(path);
      const saved = await new StashProvider(here).save({ includeUntracked: true, message, signal });
      if (!saved.ok) {
        return { ok: false, stderr: saved.stderr };
      }
      const top = saved.created ? await here.run(["rev-parse", "--verify", "--quiet", "refs/stash"], { signal }) : undefined;
      const stashed = top && top.code === 0 ? top.stdout.trim() : undefined;
      const r = await this.removeAsAgreed(path, { pastLock: opts.pastLock, signal });
      return stashed ? { ...r, stashed } : r;
    }
    if (opts.discardChanges) {
      const { listed } = opts.discardChanges;
      if (listed) {
        const now = await this.uncommitted(path, { signal });
        const agreed = new Set(listed);
        if (now === undefined || now.some((p) => !agreed.has(p))) {
          return { ok: false, stderr: "", changedSince: true };
        }
      }
      return this.remove(path, { force: true, evenIfLocked: !!opts.pastLock, signal });
    }
    if (opts.pastLock) {
      const unlocked = await this.unlock(path, { signal });
      if (!unlocked.ok) {
        return unlocked;
      }
    }
    const r = await this.removeOrForget(path, signal);
    if (!r.ok && opts.pastLock) {
      await this.lock(path, { reason: opts.pastLock.reason, signal });
    }
    return r;
  }

  /** A plain remove — or, for a folder that is not a worktree any more, which
   *  `git worktree remove` refuses ("validation failed"), forgetting it. */
  private async removeOrForget(path: string, signal?: AbortSignal): Promise<WorktreeOpResult> {
    const entry = (await this.list({ signal })).find((e) => sameFolder(e.path, path));
    if (entry && existsSync(entry.path) && (entry.prunable || !existsSync(join(entry.path, ".git")))) {
      return this.forgetUnlinked(entry, signal);
    }
    return this.remove(path, { signal });
  }

  /**
   * Forget ONE worktree whose folder is there but is not a worktree any more:
   * drop its record under <common dir>/worktrees/<id> — what `git worktree
   * prune` does for each entry it prunes, which is the only way git has, and
   * it prunes every such entry at once. The folder is never touched. Only
   * while git's own test for pruning it holds (should_prune_worktree): its
   * record points at a .git that is not there, and it is not locked.
   */
  private async forgetUnlinked(entry: WorktreeEntry, signal?: AbortSignal): Promise<WorktreeOpResult> {
    const common = await this.proc.run(["rev-parse", "--git-common-dir"], { signal });
    if (common.code !== 0) {
      return { ok: false, stderr: common.stderr };
    }
    const records = join(resolve(this.proc.cwd, common.stdout.trim()), "worktrees");
    let ids: string[] = [];
    try {
      ids = readdirSync(records);
    } catch {
      // No records at all.
    }
    for (const id of ids) {
      const record = join(records, id);
      let gitdir: string;
      try {
        gitdir = readFileSync(join(record, "gitdir"), "utf8").trim();
      } catch {
        continue;
      }
      // Absolute — or, under worktree.useRelativePaths, relative to the record.
      const dotGit = resolve(record, gitdir);
      if (!gitdir || !sameFolder(dirname(dotGit), entry.path)) {
        continue;
      }
      if (existsSync(dotGit)) {
        return { ok: false, stderr: l10n.t("{0} is a worktree again — its .git is back.", entry.path) };
      }
      if (existsSync(join(record, "locked"))) {
        return { ok: false, stderr: l10n.t("The worktree at {0} is locked.", entry.path) };
      }
      rmSync(record, { recursive: true, force: true });
      try {
        rmdirSync(records); // as git does when the last one goes
      } catch {
        // Others remain.
      }
      return { ok: true, stderr: "" };
    }
    return { ok: false, stderr: l10n.t("git's record of the worktree at {0} wasn't found.", entry.path) };
  }

  /** `git worktree remove [--force [--force]] -- <path>` — see
   *  WorktreeRemoveOptions for what each force gets past. */
  async remove(
    path: string,
    opts?: WorktreeRemoveOptions,
  ): Promise<WorktreeOpResult> {
    const args = ["worktree", "remove"];
    if (opts?.force || opts?.evenIfLocked) {
      args.push("--force");
    }
    if (opts?.evenIfLocked) {
      args.push("--force");
    }
    args.push("--", path);
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git worktree move -- <from> <to>`. */
  async move(
    from: string,
    to: string,
    opts?: GitRunOptions,
  ): Promise<WorktreeOpResult> {
    const r = await this.proc.run(["worktree", "move", "--", from, to], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git worktree prune` — clean up administrative files of gone worktrees. */
  async prune(opts?: GitRunOptions): Promise<WorktreeOpResult> {
    const r = await this.proc.run(["worktree", "prune"], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git worktree lock [--reason <text>] -- <path>`. */
  async lock(path: string, opts?: WorktreeLockOptions): Promise<WorktreeOpResult> {
    const reason = opts?.reason?.trim();
    const r = await this.proc.run(
      ["worktree", "lock", ...(reason ? ["--reason", reason] : []), "--", path],
      { signal: opts?.signal },
    );
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git worktree unlock -- <path>`. */
  async unlock(path: string, opts?: GitRunOptions): Promise<WorktreeOpResult> {
    const r = await this.proc.run(["worktree", "unlock", "--", path], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }
}

/**
 * Parse the `git worktree list --porcelain` stream. Records are separated by a
 * blank line; each record's first line is `worktree <path>`, followed by
 * `HEAD <sha>`, `branch <ref>`, and standalone `bare`/`locked`/`prunable`
 * attribute lines.
 */
export function parseWorktreePorcelain(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;

  const flush = () => {
    if (current) {
      entries.push(current);
      current = undefined;
    }
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (line.length === 0) {
      flush();
      continue;
    }
    const spaceIdx = line.indexOf(" ");
    const key = spaceIdx === -1 ? line : line.slice(0, spaceIdx);
    const value = spaceIdx === -1 ? "" : line.slice(spaceIdx + 1);

    switch (key) {
      case "worktree":
        flush();
        current = { path: value, head: "" };
        break;
      case "HEAD":
        if (current) {
          current.head = value;
        }
        break;
      case "branch":
        if (current) {
          current.branch = value.startsWith("refs/heads/")
            ? value.slice("refs/heads/".length)
            : value;
        }
        break;
      case "bare":
        if (current) {
          current.bare = true;
        }
        break;
      case "locked":
        if (current) {
          current.locked = true;
          // `locked <reason>`, C-quoted by git when the reason holds a
          // newline, a quote, a backslash or (core.quotePath) non-ASCII.
          if (value) {
            current.lockReason = unquoteC(value);
          }
        }
        break;
      case "prunable":
        if (current) {
          current.prunable = true;
          if (value) {
            current.prunableReason = unquoteC(value);
          }
        }
        break;
      default:
        break;
    }
  }
  flush();
  return entries;
}

/**
 * Parse `git worktree list --porcelain -z` (git 2.36+): every attribute line
 * ends in NUL instead of a newline, and a record ends in an empty one — so a
 * path (or a lock reason) holding a newline reads whole, and nothing is
 * C-quoted.
 */
export function parseWorktreePorcelainZ(text: string): WorktreeEntry[] {
  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | undefined;
  for (const field of text.split("\0")) {
    if (field.length === 0) {
      if (current) entries.push(current);
      current = undefined;
      continue;
    }
    const sp = field.indexOf(" ");
    const key = sp === -1 ? field : field.slice(0, sp);
    const value = sp === -1 ? "" : field.slice(sp + 1);
    if (key === "worktree") {
      if (current) entries.push(current);
      current = { path: value, head: "" };
      continue;
    }
    if (!current) continue;
    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.startsWith("refs/heads/") ? value.slice("refs/heads/".length) : value;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = true;
        if (value) current.lockReason = value;
        break;
      case "prunable":
        current.prunable = true;
        if (value) current.prunableReason = value;
        break;
      default:
        break;
    }
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Undo git's C-style quoting (quote_c_style): a value wrapped in double quotes
 * with \\, \", \n, \t… and octal \ooo byte escapes, the bytes UTF-8. Anything
 * not wrapped in quotes is returned as it is.
 */
export function unquoteC(value: string): string {
  if (value.length < 2 || !value.startsWith('"') || !value.endsWith('"')) {
    return value;
  }
  const named: Record<string, number> = {
    a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92,
  };
  const chars = Array.from(value.slice(1, -1));
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    const next = chars[i + 1];
    if (ch !== "\\" || next === undefined) {
      bytes.push(...encoder.encode(ch));
    } else if (/[0-7]/.test(next)) {
      const octal = /^[0-7]{1,3}/.exec(chars.slice(i + 1, i + 4).join(""))?.[0] ?? next;
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
    } else if (next in named) {
      bytes.push(named[next]);
      i += 1;
    } else {
      bytes.push(...encoder.encode(ch));
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}
