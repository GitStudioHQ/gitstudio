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

  /** `git stash push` with optional message + keep-index / include-untracked. */
  async save(opts?: StashSaveOptions): Promise<StashOpResult> {
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
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
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
