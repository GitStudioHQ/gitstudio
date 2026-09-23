import type { GitProcess, GitRunOptions } from "./GitProcess";
import { parseUnmergedPaths } from "./ConflictProvider";
import { rebaseInProgress } from "./rebaseInProgress";
import { parseV2 } from "./StatusProvider";

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
  /**
   * Force the push — never a bare `--force`. See `SyncOps.push`: the lease is
   * explicit (`--force-with-lease=<ref>:<sha>`), `--force-if-includes` rides
   * with it where git has it, and the push is refused before it runs when the
   * sha it would replace was never part of this branch (`PushResult.unseen`).
   */
  force?: boolean;
  /**
   * With `force`: the sha the remote branch must STILL be at — the upstream
   * tip the user last saw, read before any fetch this push follows. Without it
   * the lease is the remote-tracking ref as it is NOW, and a fetch just before
   * the push has made that equal to the remote — which is why the push also
   * refuses a tip this branch never had. Ignored unless it is a full sha.
   */
  lease?: string;
  /** `--tags` — also push tags. */
  tags?: boolean;
}

export interface PushResult extends SyncOpResult {
  /**
   * A FORCE push refused before it ran: the remote branch's tip — the lease
   * the caller passed, or the remote-tracking ref as last fetched — was never
   * part of this branch. A background fetch brings in the same commit amended
   * on another machine, or a colleague's push, and a force leased on it would
   * delete it: that is a divergence to pull in, not a rewrite to push over.
   * Nothing was pushed. See `pushUnseenMessage`.
   */
  unseen?: true;
}

/** What to tell the user when a force push was refused as `PushResult.unseen`. */
export function pushUnseenMessage(): string {
  return (
    "The remote branch has commits this branch has never had — fetched in the background, " +
    "from another machine or someone else — and a force push would delete them. " +
    "Pull them in first, then push."
  );
}

/**
 * Is this `git version` output 2.30 or later — the first git with
 * `--force-if-includes`? Reads the numbers, not the words around them: Apple
 * ("2.39.3 (Apple Git-146)") and Windows ("2.45.1.windows.1") builds say it
 * differently. Anything unreadable is treated as older, which only loses the
 * extra flag — the lease and the engine's own includes check stay.
 */
export function gitHasForceIfIncludes(versionOutput: string): boolean {
  const m = /(\d+)\.(\d+)/.exec(versionOutput);
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return major > 2 || (major === 2 && minor >= 30);
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

/**
 * A pull that merged or rebased and STOPPED on conflicts.
 *
 * Not a failure: it is the pull doing what was asked up to the point where a
 * person has to choose, and the repository is now mid-merge or mid-rebase. The
 * caller's job is to say so plainly and send the user to where conflicts are
 * resolved — never to show git's terminal hint, and never to file a report.
 */
export interface PullStop {
  /** What the repository is in the middle of: a merge to commit, or a rebase
   *  to continue. */
  operation: "merge" | "rebase";
  /** Repo-relative paths left conflicted. Never empty. */
  conflicted: string[];
}

/**
 * A pull that never started, because an operation is still paused in the
 * repository — most often the very merge or rebase an earlier pull stopped on.
 *
 * git refuses that pull before it fetches anything ("Pulling is not possible
 * because you have unmerged files", "You have not concluded your merge") or,
 * mid-rebase, fails on the detached HEAD. Like `PullStop` it is a state, not a
 * defect: the caller says what is paused and sends the user to finish it.
 */
export interface PullBlock {
  /** What is paused. Absent when files are unmerged with no operation marker
   *  (a conflicted `stash pop`, say). */
  operation?: "merge" | "rebase" | "cherry-pick" | "revert";
  /** Files still unmerged. 0 once every conflict is resolved but the operation
   *  has not been committed or continued. */
  conflicted: number;
}

/**
 * A pull git refused because the user's uncommitted work is in its way — work
 * in progress, not a defect, and nothing was changed.
 *
 * Two shapes, both read from git's state rather than its English: a pull that
 * REBASES refuses any uncommitted change to a tracked file (exit 128, "cannot
 * pull with rebase: You have unstaged changes"); a merge or fast-forward
 * refuses only when an uncommitted — or untracked — file is one the incoming
 * commits change ("Your local changes to the following files would be
 * overwritten by merge", exit 1 or 2). Neither applies when git is configured
 * to stash around the pull (`rebase.autoStash` / `merge.autoStash`).
 */
export interface PullDirty {
  /** The files in the way, repo-relative. Never empty. */
  paths: string[];
  /** The pull was rebasing, which needs the whole working tree clean. */
  rebase?: true;
}

/** What to tell the user when uncommitted work stopped a pull (`PullDirty`). */
export function pullDirtyMessage(d: PullDirty): string {
  const n = d.paths.length;
  const which = n === 1 ? d.paths[0] : `${n} files`;
  const them = n === 1 ? "it" : "them";
  if (d.rebase) {
    return (
      `Pulling with rebase needs a clean working tree, and you have uncommitted changes to ${which}. ` +
      `Commit or stash ${them}, then pull again.`
    );
  }
  return `The pull would overwrite your uncommitted changes to ${which}. Commit or stash ${them}, then pull again.`;
}

/**
 * What to tell the user when a pull was blocked by a paused operation — what
 * is paused, how many files are still conflicted, and the two ways out, in the
 * app's words rather than git's `git add/rm` hint.
 */
export function pullBlockedMessage(block: PullBlock): string {
  const n = block.conflicted;
  const files = n === 1 ? "1 file" : `${n} files`;
  if (!block.operation) {
    return `${files} ${n === 1 ? "is" : "are"} still conflicted. Resolve ${n === 1 ? "it" : "them"} before pulling again.`;
  }
  const op = block.operation;
  const finish = op === "merge" ? "commit" : "continue";
  if (n === 0) {
    return `A ${op} is still in progress. ${finish === "commit" ? "Commit" : "Continue"} it — or abort it — before pulling again.`;
  }
  return (
    `A ${op} is still in progress, with ${files} still conflicted. ` +
    `Resolve ${n === 1 ? "it" : "them"} and ${finish} the ${op} — or abort it — before pulling again.`
  );
}

/**
 * The sentence for a pull that STOPPED on conflicts, that was BLOCKED by the
 * operation a stop left paused, or that the user's uncommitted work was in the
 * way of (`dirty`) — undefined for every other result. The extension's settler
 * shows exactly this, and takes the user to Changes, where each of the three is
 * finished; so no face of it can be settled by one door and forgotten by
 * another.
 */
export function pullPauseMessage(result: {
  stopped?: PullStop;
  blocked?: PullBlock;
  dirty?: PullDirty;
}): string | undefined {
  if (result.stopped) return pullStoppedMessage(result.stopped);
  if (result.blocked) return pullBlockedMessage(result.blocked);
  if (result.dirty) return pullDirtyMessage(result.dirty);
  return undefined;
}

export interface PullResult extends SyncOpResult {
  /**
   * Set when the pull stopped because the branch and its upstream have
   * diverged and nobody has said how to reconcile them. NOTHING was changed —
   * the caller is expected to ask the user for a `PullMode` and call again.
   */
  diverged?: PullDivergence;
  /** Set when the merge or rebase the pull ran stopped on conflicts. */
  stopped?: PullStop;
  /** Set when the pull could not start because an operation is paused. */
  blocked?: PullBlock;
  /** Set when git refused because the user's uncommitted work is in the way. */
  dirty?: PullDirty;
  /**
   * Set when HEAD is detached — a commit or a tag checked out, nothing paused
   * — so there is no branch to pull into. git's own answer is terminal advice
   * ("You are not currently on a branch… git pull <remote> <branch>"); the way
   * on is to check out a branch. See `pullDetachedMessage`.
   */
  detached?: true;
  /**
   * git's stdout on failure. A merge that conflicts explains itself HERE
   * ("CONFLICT (content): …") and writes nothing to stderr, so a caller that
   * shows only stderr has nothing to say.
   */
  stdout?: string;
}

/** What to tell the user when a pull found HEAD detached (`PullResult.detached`). */
export function pullDetachedMessage(): string {
  return "HEAD is detached, so there is no branch to pull into. Check out a branch first.";
}

/**
 * What to tell the user when a pull stopped on conflicts — in the app's words,
 * with the count and the next step, and nothing a terminal would say.
 *
 * Lives beside `PullStop`, for the reason `unresolvedConflictsMessage` lives
 * beside ConflictProvider: the extension and the desktop app describe the same
 * state, and two copies of the sentence is how they start to disagree.
 */
export function pullStoppedMessage(stop: PullStop): string {
  const n = stop.conflicted.length;
  const files = n === 1 ? "1 file" : `${n} files`;
  const next = stop.operation === "rebase" ? "continue the rebase" : "commit the merge";
  return (
    `The pull stopped on conflicts in ${files}. Resolve ${n === 1 ? "it" : "them"}, ` +
    `then ${next} — or abort to go back to where you were.`
  );
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
 * `git pull`'s exit status when its merge or rebase STOPPED for the user, and
 * equally when its fetch failed (builtin/pull.c returns 1 from a failed
 * `run_fetch`). Every refusal of its own — `--ff-only` on a diverged branch,
 * "need to specify how to reconcile", "you have unmerged files" — is a `die()`,
 * which is 128. See `SyncOps.pull`.
 */
const GIT_PULL_STOPPED_OR_FETCH_FAILED = 1;

/** A full object name (SHA-1 or SHA-256) — all a push lease may carry. */
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/**
 * The work in progress `git status --porcelain=v2 -z` shows: tracked files
 * with staged or unstaged changes, and untracked files — the two kinds a pull
 * can be refused over (see `PullDirty`). Parsed by StatusProvider's parser, the
 * one every other status read uses.
 */
function parseWorkInProgress(porcelain: string): { tracked: string[]; untracked: string[] } {
  const s = parseV2(porcelain);
  const untracked = s.unstaged.filter((f) => f.status === "U").map((f) => f.path);
  const tracked = new Set<string>([
    ...s.staged.map((f) => f.path),
    ...s.unstaged.filter((f) => f.status !== "U").map((f) => f.path),
    ...s.merge.map((f) => f.path),
  ]);
  return { tracked: [...tracked], untracked };
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
  async push(opts?: PushOptions): Promise<PushResult> {
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
      // ALWAYS an explicit expected value: the tip the user last SAW — the
      // caller's lease when it read one before a fetch, else the
      // remote-tracking ref as last fetched. It names the ref on the REMOTE,
      // which differs from the local name after a rename — the same pair the
      // refspec above resolves.
      //
      // And never a tip this branch has not had. An explicit value is only as
      // good as what the user saw, and a BACKGROUND fetch — the editor's, the
      // app's, a terminal's — sets the remote-tracking ref to the same commit
      // amended on another machine without anybody looking at it: leased on
      // that, the force deletes it. `--force-if-includes` is git's answer, but
      // git ignores it beside an explicit value (verified against git 2.49:
      // `--force-with-lease=<ref>:<sha> --force-if-includes` overwrote exactly
      // that amendment), so the includes check is made here, the way git makes
      // it: the tip must be reachable from this branch's reflog. The flag is
      // still passed where git knows it, for the no-value lease below.
      const pair = await this.upstreamPair(opts.signal, branch);
      const expect = opts.lease && FULL_SHA.test(opts.lease)
        ? opts.lease
        : pair
          ? await this.trackingTip(pair.local, opts.signal)
          : null;
      if (pair && expect) {
        if (!(await this.hasHad(pair.local, expect, opts.signal))) {
          return { ok: false, stderr: "", unseen: true };
        }
        args.push(`--force-with-lease=refs/heads/${pair.remoteBranch}:${expect}`);
      } else {
        // Nothing tracked to lease on (a branch with no upstream, or one whose
        // remote branch is gone): git's own lease, on whatever it tracks.
        args.push("--force-with-lease");
      }
      if (await this.knowsForceIfIncludes()) {
        args.push("--force-if-includes");
      }
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
   *
   * Two failures are answered as facts rather than as git's text:
   *
   * - A merge or rebase that STOPPED on conflicts comes back `stopped` (see
   *   `PullStop`). Recognised the way `pausedForUser` recognises a paused
   *   cherry-pick — exit 1 AND files left unmerged — never by reading git's
   *   English. The exit code is what keeps a REFUSAL out: pulling while an
   *   earlier merge is still unresolved is refused with 128 before anything
   *   runs, and those conflicts are not this pull's.
   * - A pull that could not REACH the remote is never a divergence, whatever
   *   the remote-tracking ref says. git's pull returns 1 when its fetch fails
   *   and dies (128) on its own refusals, `--ff-only`'s included — and the ref
   *   a failed fetch leaves behind is from the last fetch that worked, so it
   *   can show a divergence that asking about would only answer with this same
   *   transport error. Both codes are pinned against real git in
   *   test/pullStopped.test.ts.
   * - A pull that could not START because a merge or rebase is still paused —
   *   the state a stop leaves the user in, with the branch still ahead and
   *   behind — comes back `blocked` (see `PullBlock`), and is checked before
   *   the divergence: git refused without fetching, so there is nothing new to
   *   ask about, and any answer would be refused the same way.
   * - A pull refused because the user's uncommitted work is in its way comes
   *   back `dirty` (see `PullDirty`) — work in progress, not a failure.
   * - `pull.ff=only` in the user's config is treated as the auto case above:
   *   it makes a mode-less pull `--ff-only`, so a diverged branch is the same
   *   question, not git's advice.
   */
  async pull(opts?: PullOptions): Promise<PullResult> {
    const mode: PullMode | undefined =
      opts?.mode ??
      (opts?.rebase === true ? "rebase" : opts?.rebase === false ? "merge" : undefined);
    const signal = opts?.signal;

    // Only the no-mode, no-config case is ours to decide; everything else runs
    // the pull the caller (or the user's own config) asked for.
    const auto = mode === undefined && !(await this.reconcileConfigured(signal));
    // `pull.ff=only` is the answer git's own divergence advice suggests, and it
    // makes a mode-less pull exactly our `--ff-only` (git lets it win over a
    // configured pull.rebase; only a flag on the command line overrides it). So
    // a diverged branch meets the same refusal the auto path turns into a
    // question — and handed on as git's hint wall, it was report #12 again for
    // everyone who had taken git's advice.
    const ffOnly = auto || (mode === undefined && (await this.configuredFfOnly(signal)));

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
    const failed = { ok: false, stderr: r.stderr, stdout: r.stdout };
    if (r.code === GIT_PULL_STOPPED_OR_FETCH_FAILED) {
      // Either the merge/rebase stopped for the user, or the fetch never got
      // through. Files left unmerged tell the two apart. (Files unmerged BEFORE
      // this pull cannot be mistaken for its stop: git refuses such a pull up
      // front with 128, never 1.)
      const stopped = await this.stoppedOnConflicts(mode, signal);
      if (stopped) {
        return { ...failed, stopped };
      }
    }
    // An operation still paused from before — typically the merge or rebase an
    // earlier pull stopped on, which is exactly where that stop sent the user.
    // Checked BEFORE the divergence below: git refused without fetching, so the
    // counts are the ones that made the first pull ask, and asking again would
    // offer a choice git is going to refuse whatever the answer.
    const blocked = await this.pausedByOperation(signal);
    if (blocked) {
      return { ...failed, blocked };
    }
    // Nothing paused, and HEAD on no branch: a commit or a tag checked out.
    // git fetched and then had nothing to merge into (exit 1, "You are not
    // currently on a branch"). Asked after the paused operation, because a
    // paused rebase is detached too and what is left there is to finish it.
    if ((await this.proc.run(["symbolic-ref", "-q", "HEAD"], { signal })).code === 1) {
      return { ...failed, detached: true };
    }
    // The user's uncommitted work in the way — see `PullDirty`. After the
    // paused operation (a conflicted file is "uncommitted" too, and what is
    // left there is to finish the operation) and before the divergence: a
    // fast-forward refused for divergence is 128, which this never claims.
    const dirty = await this.inTheWay(mode, r.code, signal);
    if (dirty) {
      return { ...failed, dirty };
    }
    if (r.code === GIT_PULL_STOPPED_OR_FETCH_FAILED) {
      return failed;
    }
    if (ffOnly) {
      // The fetch half of `pull --ff-only` already ran — and succeeded, or the
      // exit code above would have said so — so the counts below are current.
      // Diverged is a structural fact — both sides have commits the other does
      // not — never a match on git's advice text.
      const d = await this.divergence(signal);
      if (d) {
        return { ...failed, diverged: d };
      }
    }
    return failed;
  }

  /**
   * The conflicts a pull that exited 1 left behind, and what is paused over
   * them — or null when nothing is unmerged (the exit was the fetch failing).
   *
   * The operation is read from git's own state — the rebase state directory,
   * MERGE_HEAD — spelled the same in every locale. NOT from REBASE_HEAD, which
   * git leaves behind when a rebase finishes: in any repository that had ever
   * finished a stopped rebase, a MERGE stopping on conflicts was announced as
   * "continue the rebase". With neither present — unconfigured shapes this has
   * not met — it falls back to what was asked for, which is what git was
   * running.
   */
  private async stoppedOnConflicts(
    mode: PullMode | undefined,
    signal?: AbortSignal,
  ): Promise<PullStop | null> {
    const status = await this.proc.run(["status", "--porcelain=v2", "-z"], { signal });
    if (status.code !== 0) {
      return null;
    }
    const conflicted = parseUnmergedPaths(status.stdout);
    if (conflicted.length === 0) {
      return null;
    }
    const has = async (ref: string): Promise<boolean> =>
      (await this.proc.run(["rev-parse", "--verify", "--quiet", ref], { signal })).code === 0;
    const operation: PullStop["operation"] = (await this.rebaseInProgress(signal))
      ? "rebase"
      : (await has("MERGE_HEAD"))
        ? "merge"
        : mode === "rebase"
          ? "rebase"
          : "merge";
    return { operation, conflicted };
  }

  /**
   * The paused operation a FAILED pull ran into, or null when nothing is.
   *
   * Mirrors what actually stops git's pull, and nothing more: an unmerged index
   * and MERGE_HEAD are refused up front (builtin/pull.c), and a rebase that is
   * still paused (its state directory — see rebaseInProgress) leaves HEAD
   * detached, which fails every pull.
   * A CHERRY_PICK_HEAD or REVERT_HEAD with nothing unmerged does NOT stop git
   * pull, so on its own it is never blamed — a failure then is some other
   * failure, and keeps its own message (and keeps reporting). Those two only
   * NAME the operation when files are unmerged.
   */
  private async pausedByOperation(signal?: AbortSignal): Promise<PullBlock | null> {
    const status = await this.proc.run(["status", "--porcelain=v2", "-z"], { signal });
    const conflicted = status.code === 0 ? parseUnmergedPaths(status.stdout).length : 0;
    const has = async (ref: string): Promise<boolean> =>
      (await this.proc.run(["rev-parse", "--verify", "--quiet", ref], { signal })).code === 0;
    if (await this.rebaseInProgress(signal)) {
      return { operation: "rebase", conflicted };
    }
    if (await has("MERGE_HEAD")) {
      return { operation: "merge", conflicted };
    }
    if (conflicted === 0) {
      return null;
    }
    if (await has("CHERRY_PICK_HEAD")) {
      return { operation: "cherry-pick", conflicted };
    }
    if (await has("REVERT_HEAD")) {
      return { operation: "revert", conflicted };
    }
    return { conflicted };
  }

  /**
   * The paused operation a pull would run into RIGHT NOW, or null — the same
   * answer `pull()` gives as `blocked`, for a door that asks a question before
   * it pulls. "Merge or rebase?" over a merge still in progress is a question
   * every answer of which git refuses; and a paused rebase leaves HEAD
   * detached, so a door that looked only at the HEAD sent the user off to
   * "check out a branch" in the middle of their rebase.
   */
  pausedOperation(signal?: AbortSignal): Promise<PullBlock | null> {
    return this.pausedByOperation(signal);
  }

  /** See ./rebaseInProgress — the state directory, never REBASE_HEAD. */
  private rebaseInProgress(signal?: AbortSignal): Promise<boolean> {
    return rebaseInProgress(this.proc, signal);
  }

  /** Is `key` set to a true boolean in the user's config? */
  private async configTrue(key: string, signal?: AbortSignal): Promise<boolean> {
    const r = await this.proc.run(["config", "--bool", "--get", key], { signal });
    return r.code === 0 && r.stdout.trim() === "true";
  }

  /** `pull.ff=only` — git's own "only ever fast-forward" answer. */
  private async configuredFfOnly(signal?: AbortSignal): Promise<boolean> {
    const r = await this.proc.run(["config", "--get", "pull.ff"], { signal });
    return r.code === 0 && r.stdout.trim() === "only";
  }

  /**
   * Does the user's config make a mode-less pull REBASE? `branch.<name>.rebase`
   * over `pull.rebase`, any value but false — and not under `pull.ff=only`,
   * which git lets win over both.
   */
  private async rebasesByConfig(signal?: AbortSignal): Promise<boolean> {
    if (await this.configuredFfOnly(signal)) {
      return false;
    }
    const head = await this.proc.run(["symbolic-ref", "--quiet", "HEAD"], { signal });
    const fullRef = head.stdout.trim();
    const keys = head.code === 0 && fullRef.startsWith("refs/heads/")
      ? [`branch.${fullRef.slice("refs/heads/".length)}.rebase`, "pull.rebase"]
      : ["pull.rebase"];
    for (const key of keys) {
      const r = await this.proc.run(["config", "--get", key], { signal });
      const v = r.stdout.trim().toLowerCase();
      if (r.code === 0 && v.length > 0) {
        return !["false", "no", "off", "0"].includes(v);
      }
    }
    return false;
  }

  /**
   * The user's uncommitted work a FAILED pull was refused over, or null — see
   * `PullDirty`. Read from porcelain status and the upstream's own diff, never
   * from git's English, and only for the exit each refusal has:
   *
   * - rebasing, 128: git's `require_clean_work_tree` — any staged or unstaged
   *   change to a tracked file, submodules ignored — unless `rebase.autoStash`
   *   stashes it;
   * - merging or fast-forwarding, 1 or 2: a changed tracked file (unless
   *   `merge.autoStash`), or an untracked one, that the incoming commits touch.
   *
   * Exit 1 is also a fetch that failed; the upstream diff is then the last one
   * fetched — and if THAT already runs through the user's edits, pulling it is
   * refused the moment the remote answers, so "commit or stash first" is true
   * either way. With nothing incoming it is never claimed.
   */
  private async inTheWay(
    mode: PullMode | undefined,
    code: number,
    signal?: AbortSignal,
  ): Promise<PullDirty | null> {
    const rebasing = mode === "rebase" || (mode === undefined && (await this.rebasesByConfig(signal)));
    if (!(rebasing && code === 128) && code !== 1 && code !== 2) {
      return null;
    }
    // Renames off, so a staged rename is in the way under both of its names —
    // a Stash & Retry of only the new one would leave the old one's deletion
    // staged, and a rebasing pull refused all over again.
    const status = await this.proc.run(
      ["status", "--porcelain=v2", "-z", "--untracked-files=all", "--ignore-submodules=all", "--no-renames"],
      { signal },
    );
    if (status.code !== 0) {
      return null;
    }
    const { tracked, untracked } = parseWorkInProgress(status.stdout);
    if (rebasing && code === 128) {
      return tracked.length > 0 && !(await this.configTrue("rebase.autoStash", signal))
        ? { paths: tracked, rebase: true }
        : null;
    }
    if (tracked.length + untracked.length === 0) {
      return null;
    }
    const incoming = await this.proc.run(
      ["diff", "--name-only", "-z", "--no-renames", "HEAD...@{upstream}", "--"],
      { signal },
    );
    if (incoming.code !== 0) {
      return null;
    }
    const touched = new Set(incoming.stdout.split("\0").filter((p) => p.length > 0));
    const stashed = await this.configTrue(rebasing ? "rebase.autoStash" : "merge.autoStash", signal);
    const paths = [...(stashed ? [] : tracked), ...untracked].filter((p) => touched.has(p));
    return paths.length > 0 ? { paths } : null;
  }

  /**
   * The sha the current branch's upstream points at, or null when it has none.
   * Read BEFORE a fetch, it is the remote tip the user last saw — the lease a
   * force push after that fetch must hold the remote to (see `PushOptions`).
   */
  async upstreamTip(signal?: AbortSignal): Promise<string | null> {
    const r = await this.proc.run(["rev-parse", "--verify", "--quiet", "@{upstream}"], { signal });
    const sha = r.stdout.trim();
    return r.code === 0 && FULL_SHA.test(sha) ? sha : null;
  }

  /**
   * Would a force push of the current branch be refused as `unseen` right
   * now — does the remote branch's tip (`lease`, or the remote-tracking ref as
   * last fetched) carry commits this branch has never had? For a door that
   * asks "Force push?" before pushing: a remote in that state is a divergence
   * to pull in, and the question should be merge-or-rebase instead. False when
   * there is nothing tracked to compare.
   */
  async upstreamUnseen(lease?: string, signal?: AbortSignal): Promise<boolean> {
    const pair = await this.upstreamPair(signal);
    if (!pair) return false;
    const expect = lease && FULL_SHA.test(lease) ? lease : await this.trackingTip(pair.local, signal);
    return expect ? !(await this.hasHad(pair.local, expect, signal)) : false;
  }

  /**
   * The sha `refs/heads/<local>`'s upstream remote-tracking ref points at, or
   * null. By the branch's FULL name through for-each-ref: `<name>@{upstream}`
   * is resolved against tags too, and `refs/heads/<name>@{upstream}` is not a
   * branch name git accepts.
   */
  private async trackingTip(local: string, signal?: AbortSignal): Promise<string | null> {
    const up = await this.proc.run(["for-each-ref", "--format=%(upstream)", `refs/heads/${local}`], { signal });
    const ref = up.stdout.trim();
    if (up.code !== 0 || !ref.startsWith("refs/")) return null;
    const r = await this.proc.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { signal });
    const sha = r.stdout.trim();
    return r.code === 0 && FULL_SHA.test(sha) ? sha : null;
  }

  /**
   * Has `refs/heads/<local>` ever had `sha` — is it reachable from the
   * branch's tip or from any entry of its reflog? This is git's own
   * `--force-if-includes` test: an amend replaced the old tip, but the reflog
   * still remembers it, so a rewrite of your own pushed work passes; a commit
   * that arrived only in the remote-tracking ref (a background fetch) was never
   * here, and fails. A git that cannot answer is a no.
   */
  private async hasHad(local: string, sha: string, signal?: AbortSignal): Promise<boolean> {
    const full = `refs/heads/${local}`;
    const log = await this.proc.run(["reflog", "show", "--format=%H", full, "--"], { signal });
    const seen = new Set<string>([full]);
    if (log.code === 0) {
      for (const line of log.stdout.split("\n")) {
        const s = line.trim();
        if (FULL_SHA.test(s)) seen.add(s);
      }
    }
    // Everything reachable from `sha` and from none of them: empty exactly
    // when one of them contains it. On stdin, so a long reflog is no argv.
    const r = await this.proc.run(["rev-list", "--stdin", "--max-count=1"], {
      signal,
      input: [sha, ...[...seen].map((s) => `^${s}`)].join("\n") + "\n",
    });
    return r.code === 0 && r.stdout.trim() === "";
  }

  /** Does this git know `--force-if-includes` (2.30+)? Asked once. */
  private forceIfIncludes?: Promise<boolean>;
  private knowsForceIfIncludes(): Promise<boolean> {
    this.forceIfIncludes ??= this.proc
      .run(["version"])
      .then((r) => r.code === 0 && gitHasForceIfIncludes(r.stdout), () => false);
    return this.forceIfIncludes;
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
   * Did WE rewrite the commits only the upstream has — an amend, or a reword in
   * an interactive rebase, of work already pushed — rather than the upstream
   * moving on without us?
   *
   * Both leave the branch ahead AND behind, and they need opposite answers: a
   * rewrite is settled by a force push (pulling brings the old version back),
   * a divergence by a merge or a rebase (a force push deletes somebody else's
   * commits). And `--force-with-lease` does NOT tell them apart after a fetch:
   * the lease is the remote-tracking ref, which the fetch has just made equal
   * to the remote, so it is satisfied either way.
   *
   * What an amend and a rebase keep, and a colleague's commit does not, is the
   * AUTHOR and the AUTHOR DATE; what they change is the COMMITTER date, to the
   * moment of the rewrite. So: true only when every commit the upstream has
   * that HEAD lacks is matched, one to one, by a commit HEAD has that the
   * upstream lacks, with the same author and author date and committed LATER
   * than the one it replaces. One commit there that we did not rewrite —
   * somebody else's, or a merge — and it is a divergence.
   *
   * One to one, and "later", because author + author date is only to the
   * second: two clones committing as the same person in the same second (a
   * script, or a fast hand on two machines) look identical by it, and a set
   * match let one fresh commit of ours "account for" two of theirs. Errs toward
   * false, which asks merge-or-rebase and loses nothing — including for an
   * amend made within the same second as the commit it replaces, which no
   * timestamp can tell from a fresh commit.
   */
  async rewroteUpstream(signal?: AbortSignal): Promise<boolean> {
    const fmt = ["--format=%an%x00%ae%x00%ad%x00%ct", "--date=raw"];
    const theirs = await this.proc.run(["log", ...fmt, "HEAD..@{upstream}", "--"], { signal });
    const ours = await this.proc.run(["log", ...fmt, "@{upstream}..HEAD", "--"], { signal });
    if (theirs.code !== 0 || ours.code !== 0) {
      return false;
    }
    const parse = (s: string): { who: string; committed: number }[] =>
      s
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => {
          const cut = l.lastIndexOf("\0");
          return { who: l.slice(0, cut), committed: Number(l.slice(cut + 1)) };
        });
    const replaced = parse(theirs.stdout);
    const rewrites = parse(ours.stdout);
    if (replaced.length === 0) {
      return false;
    }
    const used = new Set<number>();
    return replaced.every((old) => {
      const i = rewrites.findIndex(
        (c, k) => !used.has(k) && c.who === old.who && c.committed > old.committed,
      );
      if (i < 0) return false;
      used.add(i);
      return true;
    });
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
