import type { GitProcess, GitRunOptions } from "./GitProcess";

/** How far the branch is ahead of / behind its upstream. */
export interface AheadBehind {
  ahead: number;
  behind: number;
}

export interface SyncOpResult {
  ok: boolean;
  stderr: string;
}

export interface PushOptions extends GitRunOptions {
  remote?: string;
  branch?: string;
  /** `--set-upstream` — publish + start tracking. */
  setUpstream?: boolean;
  /** Force the push; we use `--force-with-lease` to stay safe. */
  force?: boolean;
  /** `--tags` — also push tags. */
  tags?: boolean;
}

export interface PullOptions extends GitRunOptions {
  rebase?: boolean;
  remote?: string;
  branch?: string;
}

export interface FetchOptions extends GitRunOptions {
  all?: boolean;
  prune?: boolean;
}

/**
 * Sync operations against the upstream: ahead/behind counts, push, pull, fetch,
 * and reading the current upstream. Pure git CLI — never imports `vscode`.
 */
export class SyncOps {
  constructor(private proc: GitProcess) {}

  /**
   * The current branch's upstream short name (e.g. "origin/main"), or null when
   * there is no upstream configured.
   */
  async currentUpstream(opts?: GitRunOptions): Promise<string | null> {
    const r = await this.proc.run(
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"],
      { signal: opts?.signal },
    );
    if (r.code !== 0) {
      return null;
    }
    const name = r.stdout.trim();
    return name.length > 0 ? name : null;
  }

  /**
   * `git rev-list --left-right --count <upstream>...HEAD` → {ahead, behind}.
   * When `branch` is omitted we use the current branch's upstream; with no
   * upstream we report {ahead: 0, behind: 0}.
   */
  async aheadBehind(
    branch?: string,
    opts?: GitRunOptions,
  ): Promise<AheadBehind> {
    let upstream: string | null;
    if (branch) {
      const r = await this.proc.run(
        [
          "rev-parse",
          "--abbrev-ref",
          "--symbolic-full-name",
          `${branch}@{u}`,
        ],
        { signal: opts?.signal },
      );
      upstream = r.code === 0 && r.stdout.trim().length > 0
        ? r.stdout.trim()
        : null;
    } else {
      upstream = await this.currentUpstream(opts);
    }
    if (!upstream) {
      return { ahead: 0, behind: 0 };
    }

    const head = branch ?? "HEAD";
    const r = await this.proc.run(
      ["rev-list", "--left-right", "--count", `${upstream}...${head}`],
      { signal: opts?.signal },
    );
    if (r.code !== 0) {
      return { ahead: 0, behind: 0 };
    }
    // Output is "<behind>\t<ahead>": left=upstream-only (behind), right=HEAD-only.
    const [behindStr, aheadStr] = r.stdout.trim().split(/\s+/);
    return {
      behind: Number(behindStr) || 0,
      ahead: Number(aheadStr) || 0,
    };
  }

  /** `git push` with optional set-upstream / force-with-lease / tags. */
  async push(opts?: PushOptions): Promise<SyncOpResult> {
    const args = ["push"];
    if (opts?.force) {
      args.push("--force-with-lease");
    }
    if (opts?.setUpstream) {
      args.push("--set-upstream");
    }
    if (opts?.tags) {
      args.push("--tags");
    }
    if (opts?.remote) {
      args.push(opts.remote);
      if (opts.branch) {
        args.push(opts.branch);
      }
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git pull [--rebase] [<remote> <branch>]`. */
  async pull(opts?: PullOptions): Promise<SyncOpResult> {
    const args = ["pull"];
    if (opts?.rebase) {
      args.push("--rebase");
    }
    if (opts?.remote) {
      args.push(opts.remote);
      if (opts.branch) {
        args.push(opts.branch);
      }
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /** `git fetch [--all] [--prune]`. */
  async fetch(opts?: FetchOptions): Promise<SyncOpResult> {
    const args = ["fetch"];
    if (opts?.all) {
      args.push("--all");
    }
    if (opts?.prune) {
      args.push("--prune");
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }
}
