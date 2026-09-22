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

/**
 * How a pull reconciles local commits with the ones it brings in — git's own
 * three answers, passed on the command line so nothing is written to the user's
 * config. `undefined` means "decide for me", which is what `pull()` does when
 * the caller has not asked (see below).
 */
export type PullMode = "merge" | "rebase" | "ff-only";

/** A branch and its upstream that have BOTH moved since they last agreed. */
export interface PullDivergence {
  /** The local branch, short name. */
  branch: string;
  /** Its upstream, short name (e.g. "origin/main"). */
  upstream: string;
  /** Commits only we have / only they have. Both are > 0 by definition. */
  ahead: number;
  behind: number;
}

export interface PullResult extends SyncOpResult {
  /**
   * Set when the pull stopped because the branch and its upstream have
   * diverged and nobody has said how to reconcile them. NOTHING was changed —
   * the caller is expected to ask the user for a `PullMode` and call again.
   */
  diverged?: PullDivergence;
}

export interface PullOptions extends GitRunOptions {
  /**
   * Explicit reconciliation. Wins over `rebase`, and is always passed to git as
   * a flag — we never write `pull.rebase` / `pull.ff` into anyone's config.
   */
  mode?: PullMode;
  /**
   * Legacy spelling of `mode`, kept because the extension's UI is a yes/no
   * question. `true` → "rebase"; `false` → "merge" (a caller that passed
   * `false` had ASKED and been told to merge — leaving the flag off instead is
   * how "Pull using Merge" ended at git's divergent-branches wall).
   */
  rebase?: boolean;
  remote?: string;
  branch?: string;
}

export interface FetchOptions extends GitRunOptions {
  all?: boolean;
  prune?: boolean;
}

/** The command-line flag for each reconciliation. Never a config write. */
const FLAG_FOR_MODE: Record<PullMode, string> = {
  merge: "--no-rebase",
  rebase: "--rebase",
  "ff-only": "--ff-only",
};

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
    } else if (branch && !setUpstream) {
      // A NAMED branch (the Branches view's Push, which pushes a branch you are
      // not standing on). This ran `git push <remote> <localName>` — the local
      // name on both sides — so after `git branch -m`, which keeps the tracking
      // config pointing at the OLD remote name, Push created a second remote
      // branch under the new name and left the tracked one untouched. Verified
      // against real git: "* [new branch] feature-local-rename". The ahead
      // count never cleared either, because the branch still tracked a ref that
      // had not moved.
      //
      // Source is the local branch by full ref (a bare name resolves against
      // refs/tags too); destination is the name the upstream actually has.
      const pair = await this.upstreamPair(opts?.signal, branch);
      if (pair) {
        // ALWAYS fully qualified, not only when the names differ. A bare name is
        // resolved against refs/heads AND refs/tags, so on a repo where a tag
        // shares the branch's name git refuses outright:
        //   error: src refspec release matches more than one
        // The HEAD path above has said this in a comment since it was written;
        // the named-branch path qualified only the rename case and inherited
        // the bug for every ordinary push.
        remote = pair.remote;
        refspec = `refs/heads/${pair.local}:refs/heads/${pair.remoteBranch}`;
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
        // Qualify here too. This is the PUBLISH path — a branch with no
        // upstream yet, so `upstreamPair` above found nothing to resolve — and
        // a bare name is matched against refs/heads AND refs/tags, so
        // publishing a branch that shares a tag's name failed outright with
        // "error: src refspec v2 matches more than one". Verified against real
        // git, including that `--set-upstream` still tracks correctly with an
        // explicit src:dst ("branch 'v2' set up to track 'origin/v2'").
        args.push(`refs/heads/${branch}:refs/heads/${branch}`);
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
    /** Resolve THIS branch's pair rather than HEAD's. The Branches view pushes
     *  a branch it is not standing on, and needs the same answer. */
    branch?: string,
  ): Promise<{ local: string; remote: string; remoteBranch: string } | null> {
    let local = branch;
    if (!local) {
      const head = await this.proc.run(["symbolic-ref", "--quiet", "HEAD"], {
        signal,
      });
      const fullRef = head.stdout.trim();
      if (head.code !== 0 || !fullRef.startsWith("refs/heads/")) {
        return null; // detached
      }
      local = fullRef.slice("refs/heads/".length);
    }
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

  /**
   * `git pull`, with the reconciliation decided HERE rather than left to git.
   *
   * Since 2.27 git refuses a pull outright when the branch has diverged from
   * its upstream and neither `pull.rebase` nor `pull.ff` is set. What it prints
   * is advice for a terminal — "You have divergent branches and need to specify
   * how to reconcile them", then three `git config` lines — and that wall is
   * exactly what a GitStudio user saw when they pressed Pull (report #12).
   *
   * So:
   *
   * - `mode` (or the legacy `rebase`) is passed as `--rebase` / `--no-rebase` /
   *   `--ff-only`. Explicit, one invocation, and **nothing is written to the
   *   user's git config** — the choice belongs to the press, not to the repo.
   * - With no mode and no configuration of their own, we pull `--ff-only`,
   *   which is the one reconciliation that can never surprise anyone. If that
   *   refuses, we ask git for the ahead/behind counts — a fact, not a parse of
   *   its English — and hand the caller a `diverged` result to ask about.
   *   `--ff-only` aborts before touching the worktree, so nothing has changed.
   * - With no mode but `pull.rebase` / `pull.ff` / `branch.<name>.rebase` set,
   *   we get out of the way: the user has already told git what they want, and
   *   a plain `git pull` does it.
   */
  async pull(opts?: PullOptions): Promise<PullResult> {
    const mode: PullMode | undefined =
      opts?.mode ??
      (opts?.rebase === true ? "rebase" : opts?.rebase === false ? "merge" : undefined);
    const signal = opts?.signal;

    // Only the no-mode, no-config case is ours to decide; everything else runs
    // the pull the caller (or the user's own config) asked for.
    const auto = mode === undefined && !(await this.reconcileConfigured(signal));

    const args = ["pull"];
    // No flag at all ONLY when the user's own config is driving.
    //
    // The lookup is guarded rather than indexed blind: `mode` is typed, but a
    // value crossing a process boundary is only ever as good as the last thing
    // that checked it, and an unknown key here would push `undefined` into an
    // argv that is about to be spawned.
    if (mode !== undefined && Object.hasOwn(FLAG_FOR_MODE, mode)) {
      args.push(FLAG_FOR_MODE[mode]);
    } else if (auto) {
      args.push(FLAG_FOR_MODE["ff-only"]);
    }
    if (opts?.remote) {
      args.push(opts.remote);
      if (opts.branch) {
        args.push(opts.branch);
      }
    }
    const r = await this.proc.run(args, { signal });
    if (r.code === 0) {
      return { ok: true, stderr: r.stderr };
    }
    if (auto) {
      // The fetch half of `pull --ff-only` already ran, so the counts below are
      // current. Diverged is a structural fact — both sides have commits the
      // other does not — never a match on git's advice text.
      const d = await this.divergence(signal);
      if (d) {
        return { ok: false, stderr: r.stderr, diverged: d };
      }
    }
    return { ok: false, stderr: r.stderr };
  }

  /**
   * Has the user already told git how to reconcile a pull? `pull.rebase` and
   * `pull.ff` are the global answers, `branch.<name>.rebase` the per-branch one
   * git honours above them. If any is set we must not second-guess it.
   */
  private async reconcileConfigured(signal?: AbortSignal): Promise<boolean> {
    const keys = ["pull.rebase", "pull.ff"];
    const head = await this.proc.run(["symbolic-ref", "--quiet", "HEAD"], { signal });
    const fullRef = head.stdout.trim();
    if (head.code === 0 && fullRef.startsWith("refs/heads/")) {
      keys.push(`branch.${fullRef.slice("refs/heads/".length)}.rebase`);
    }
    for (const key of keys) {
      const r = await this.proc.run(["config", "--get", key], { signal });
      if (r.code === 0 && r.stdout.trim().length > 0) {
        return true;
      }
    }
    return false;
  }

  /**
   * The current branch and its upstream when BOTH have moved — the state git
   * will not reconcile on its own. Null for every other state, including a
   * detached HEAD and a branch with no upstream.
   */
  async divergence(signal?: AbortSignal): Promise<PullDivergence | null> {
    const head = await this.proc.run(["symbolic-ref", "--quiet", "HEAD"], { signal });
    const fullRef = head.stdout.trim();
    if (head.code !== 0 || !fullRef.startsWith("refs/heads/")) {
      return null; // detached — there is no branch to reconcile
    }
    const branch = fullRef.slice("refs/heads/".length);
    const upstream = await this.currentUpstream({ signal });
    if (!upstream) {
      return null;
    }
    const { ahead, behind } = await this.aheadBehind(undefined, { signal });
    return ahead > 0 && behind > 0 ? { branch, upstream, ahead, behind } : null;
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

  /**
   * Fast-forward a local branch from its upstream WITHOUT checking it out:
   * `git fetch <remote> <upstream ref>:refs/heads/<branch>`. Git itself
   * refuses a non-fast-forward and the currently checked-out branch, so the
   * worktree is never touched — the "Pull into 'feature'" a branch menu
   * offers for a branch that is not the current one.
   *
   * The remote and its ref come from for-each-ref's own atoms rather than
   * splitting `%(upstream:short)` on its first slash, which misreads a remote
   * named with a slash ("team/eu/main" is not remote "team"). Both sides of
   * the refspec are written fully qualified, as every ref this package
   * writes is.
   */
  async pullFastForward(
    branch: string,
    opts?: GitRunOptions,
  ): Promise<SyncOpResult> {
    const up = await this.proc.run(
      [
        "for-each-ref",
        "--format=%(upstream:remotename)\t%(upstream:remoteref)",
        `refs/heads/${branch}`,
      ],
      opts,
    );
    const [remote, remoteRef] = up.stdout.trim().split("\t");
    if (up.code !== 0 || !remote || !remoteRef) {
      return { ok: false, stderr: `'${branch}' has no upstream to pull from.` };
    }
    const r = await this.proc.run(
      ["fetch", remote, `${remoteRef}:refs/heads/${branch}`],
      opts,
    );
    return { ok: r.code === 0, stderr: r.stderr };
  }
}
