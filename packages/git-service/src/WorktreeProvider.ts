import type { GitProcess, GitRunOptions } from "./GitProcess";

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
  /** True when git considers the worktree prunable (its path is gone). */
  prunable?: boolean;
}

export interface WorktreeAddOptions extends GitRunOptions {
  /** Create a new branch (`-b <ref>`) instead of checking out an existing one. */
  newBranch?: boolean;
}

export interface WorktreeRemoveOptions extends GitRunOptions {
  /** `--force` — remove even with a dirty/locked worktree. */
  force?: boolean;
}

export interface WorktreeOpResult {
  ok: boolean;
  stderr: string;
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
   * `git worktree add [-b <ref>] <path> <ref>` — check out `ref` (or a new
   * branch named `ref`) into a fresh worktree at `path`.
   */
  async add(
    path: string,
    ref: string,
    opts?: WorktreeAddOptions,
  ): Promise<WorktreeOpResult> {
    const args = ["worktree", "add"];
    if (opts?.newBranch) {
      args.push("-b", ref, path);
    } else {
      args.push(path, ref);
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git worktree remove [--force] <path>`. */
  async remove(
    path: string,
    opts?: WorktreeRemoveOptions,
  ): Promise<WorktreeOpResult> {
    const args = ["worktree", "remove"];
    if (opts?.force) {
      args.push("--force");
    }
    args.push(path);
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git worktree move <from> <to>`. */
  async move(
    from: string,
    to: string,
    opts?: GitRunOptions,
  ): Promise<WorktreeOpResult> {
    const r = await this.proc.run(["worktree", "move", from, to], {
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

  /** `git worktree lock <path>`. */
  async lock(path: string, opts?: GitRunOptions): Promise<WorktreeOpResult> {
    const r = await this.proc.run(["worktree", "lock", path], {
      signal: opts?.signal,
    });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git worktree unlock <path>`. */
  async unlock(path: string, opts?: GitRunOptions): Promise<WorktreeOpResult> {
    const r = await this.proc.run(["worktree", "unlock", path], {
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
