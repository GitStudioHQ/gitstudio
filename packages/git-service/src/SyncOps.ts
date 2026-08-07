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

  /**
   * `git push` with optional set-upstream / force-with-lease / tags.
   *
   * When the branch has NO upstream, a bare `git push` does not publish it — it
   * fails outright with "The current branch X has no upstream branch". Pushing
   * an unpublished branch is overwhelmingly meant as "publish this", and that is
   * true even when the branch has no commits of its own: creating an empty
   * branch on the remote is a normal thing to want (open a PR, share a name,
   * park work). So resolve the upstream ourselves and push with --set-upstream
   * rather than surfacing git's refusal.
   *
   * Only applies when the caller did not name a remote/branch explicitly.
   */
  async push(opts?: PushOptions): Promise<SyncOpResult> {
    let remote = opts?.remote;
    let branch = opts?.branch;
    let setUpstream = opts?.setUpstream ?? false;
    /**
     * The refspec to push, when WE resolved the target rather than the caller.
     * Always fully qualified: a bare name is resolved against refs/heads AND
     * refs/tags, so a branch sharing a name with a tag fails outright with
     * "src refspec X matches more than one".
     */
    let refspec: string | undefined;

    if (!remote && !branch) {
      const upstream = await this.currentUpstream({ signal: opts?.signal });
      if (upstream === null) {
        const target = await this.publishTarget(opts?.signal);
        if (target) {
          remote = target.remote;
          refspec = `refs/heads/${target.branch}:refs/heads/${target.branch}`;
          setUpstream = true;
        }
      } else {
        // The upstream can be named differently from the local branch — most
        // often because the branch was renamed, since `git branch -m` keeps the
        // old tracking config. A bare `git push` then behaves differently on
        // every machine: push.default=simple REFUSES with a wall of advice,
        // while `upstream`/`tracking` silently pushes to the other name. Neither
        // is a thing to hand a user, so resolve the pair ourselves and push an
        // explicit refspec — "push" then means the same everywhere.
        //
        // Source is HEAD, not the local branch name: the destination is the
        // UPSTREAM's name, and pushing refs/heads/<upstream> would look for a
        // local branch by that name (which usually doesn't exist).
        const pair = await this.upstreamPair(opts?.signal);
        if (pair && pair.remoteBranch !== pair.local) {
          remote = pair.remote;
          refspec = `HEAD:refs/heads/${pair.remoteBranch}`;
        }
      }
    }

    const args = ["push"];
    if (opts?.force) {
      args.push("--force-with-lease");
    }
    if (setUpstream) {
      args.push("--set-upstream");
    }
    if (opts?.tags) {
      args.push("--tags");
    }
    if (remote) {
      args.push(remote);
      if (refspec) {
        args.push(refspec);
      } else if (branch) {
        args.push(branch);
      }
    }
    const r = await this.proc.run(args, { signal: opts?.signal });
    return { ok: r.code === 0, stderr: r.stderr };
  }

  /**
   * The current branch and the branch its upstream names ON the remote. These
   * differ after a rename (git keeps the tracking config), and legitimately when
   * someone tracks `origin/main` from a differently-named local branch.
   */
  private async upstreamPair(
    signal?: AbortSignal,
  ): Promise<{ local: string; remote: string; remoteBranch: string } | null> {
    const head = await this.proc.run(["symbolic-ref", "--quiet", "HEAD"], {
      signal,
    });
    const fullRef = head.stdout.trim();
    if (head.code !== 0 || !fullRef.startsWith("refs/heads/")) {
      return null; // detached
    }
    const local = fullRef.slice("refs/heads/".length);
    const [remoteR, mergeR] = await Promise.all([
      this.proc.run(["config", "--get", `branch.${local}.remote`], { signal }),
      this.proc.run(["config", "--get", `branch.${local}.merge`], { signal }),
    ]);
    const remote = remoteR.stdout.trim();
    const merge = mergeR.stdout.trim();
    if (!remote || !merge.startsWith("refs/heads/")) {
      return null;
    }
    return { local, remote, remoteBranch: merge.slice("refs/heads/".length) };
  }

  /**
   * Where an unpublished branch should go: the current branch plus a remote to
   * publish it to. Prefers "origin" when present, else the only remote; with
   * several non-origin remotes there is no safe guess, so we return null and let
   * the caller ask. Detached HEAD has no branch to publish.
   */
  private async publishTarget(
    signal?: AbortSignal,
  ): Promise<{ remote: string; branch: string } | null> {
    // NOT --short. shorten_unambiguous_ref() disambiguates against tags, so on a
    // repo where a tag shares the branch's name it returns "heads/<branch>" —
    // which then poisons both the config lookup and the refspec. Read the full
    // ref and strip the prefix ourselves.
    const head = await this.proc.run(["symbolic-ref", "--quiet", "HEAD"], {
      signal,
    });
    const fullRef = head.stdout.trim();
    if (head.code !== 0 || !fullRef.startsWith("refs/heads/")) {
      return null; // detached HEAD, or something we should not guess about
    }
    const branch = fullRef.slice("refs/heads/".length);
    if (branch.length === 0) {
      return null;
    }

    // CRITICAL: `git rev-parse @{u}` fails both when no upstream is configured
    // AND when one IS configured but the remote branch has been deleted — the
    // routine "PR merged, branch deleted, git fetch --prune" cycle. Treating
    // the second case as "unpublished" makes a plain Push silently RESURRECT a
    // branch someone deliberately deleted. The config is the honest signal:
    // if branch.<name>.merge exists, this branch is tracked and must not be
    // auto-published — let the push fail so the upstream-repair flow runs.
    const configured = await this.proc.run(
      ["config", "--get", `branch.${branch}.merge`],
      { signal },
    );
    if (configured.code === 0 && configured.stdout.trim().length > 0) {
      return null;
    }

    const remotes = await this.proc.run(["remote"], { signal });
    if (remotes.code !== 0) {
      return null;
    }
    const names = remotes.stdout
      .split("\n")
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (names.length === 0) {
      return null;
    }
    // Honour git's own push routing before falling back to a name guess:
    // branch.<name>.pushRemote, then remote.pushDefault. A fork workflow
    // (origin = upstream org repo, fork = yours, remote.pushDefault = fork)
    // would otherwise publish to the wrong remote.
    const cfg = async (key: string): Promise<string | undefined> => {
      const r = await this.proc.run(["config", "--get", key], { signal });
      const v = r.code === 0 ? r.stdout.trim() : "";
      return v.length > 0 && names.includes(v) ? v : undefined;
    };
    const remote =
      (await cfg(`branch.${branch}.pushRemote`)) ??
      (await cfg("remote.pushDefault")) ??
      (names.includes("origin")
        ? "origin"
        : names.length === 1
          ? names[0]
          : null);
    return remote ? { remote, branch } : null;
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
