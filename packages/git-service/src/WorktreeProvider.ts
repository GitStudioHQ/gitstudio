import { existsSync } from "node:fs";
import { sameFolder } from "./folderPath";
import type { GitProcess, GitRunOptions } from "./GitProcess";
import { stoppedIn, type StoppedOperation } from "./stoppedOperation";

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
  /** Its folder is there. `changes` are the paths git counts as uncommitted
   *  there, which removing it deletes; undefined when they could not be read.
   *  `operation`: what git is stopped in THERE — removing the worktree
   *  abandons it, and git says nothing (a clean worktree mid-rebase goes
   *  with a plain remove, exit 0). */
  | { kind: "present"; entry: WorktreeEntry; changes?: string[]; operation?: StoppedOperation };

export interface WorktreeOpResult {
  ok: boolean;
  stderr: string;
  /** removeAsAgreed ran nothing: the worktree has uncommitted changes the
   *  question never listed (or they could no longer be read), made since it
   *  was asked. Read removal() again and ask again; `stderr` is empty. */
  changedSince?: true;
}

/**
 * Host-agnostic `git worktree` plumbing: list/add/remove/move/prune/lock.
 * Pure git CLI — never imports `vscode`. Worktrees are absent from free VS Code,
 * so this is a first-class GitStudio surface.
 */
export class WorktreeProvider {
  constructor(private proc: GitProcess) {}

  /** `git worktree list --porcelain` parsed into entries. */
  async list(opts?: GitRunOptions): Promise<WorktreeEntry[]> {
    const r = await this.proc.run(["worktree", "list", "--porcelain"], {
      signal: opts?.signal,
    });
    if (r.code !== 0) {
      return [];
    }
    return parseWorktreePorcelain(r.stdout);
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
    // Read in THAT worktree: its index and its operation markers are its own.
    const [changes, stop] = await Promise.all([
      this.uncommitted(entry.path, opts),
      stoppedIn(this.proc.at(entry.path), opts?.signal),
    ]);
    return { kind: "present", entry, changes, ...(stop?.operation ? { operation: stop.operation } : {}) };
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
    const r = await this.remove(path, { signal });
    if (!r.ok && opts.pastLock) {
      await this.lock(path, { reason: opts.pastLock.reason, signal });
    }
    return r;
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
