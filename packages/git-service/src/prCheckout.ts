/**
 * Checking out a pull request as the local branch `pr/<n>` — deciding what
 * that means for the branch that may already be there. Both products use it:
 * the extension's Pull Requests view (pr/checkoutPr.ts) and the desktop app's
 * PR page (main/githubBridge.ts prCheckout).
 *
 * The old way was one command, `git fetch <remote> [--force] pull/<n>/head:pr/<n>`,
 * which is wrong three ways:
 *   · with pr/<n> CHECKED OUT, git refuses to fetch into it ("refusing to
 *     fetch into branch … checked out") — a checked-out PR could never be
 *     brought up to date;
 *   · with --force (the extension), commits made on pr/<n> that the PR does
 *     not have were thrown away without a word — alive only in the reflog;
 *   · without it (the desktop), any force-push to the PR made the checkout
 *     fail outright.
 *
 * Now the PR head is fetched on its own (into FETCH_HEAD, nothing written to
 * a branch), and then:
 *   create        — no pr/<n> yet: create it there and check it out
 *   current       — pr/<n> is already at the PR head
 *   fast-forward  — pr/<n> is behind the PR head and has nothing of its own:
 *                   move it (a fast-forward merge when it is checked out)
 *   diverged      — pr/<n> has commits the PR head does not: NOTHING is moved
 *                   until the user says so
 *   elsewhere     — pr/<n> is checked out in another worktree: git will not
 *                   switch to it here, and it is not moved under that worktree
 *
 * Only the ref is decided here; the checkout itself goes through each
 * product's in-the-way door (applyOrAsk / applyForDoor), which asks about
 * uncommitted work in its way.
 */

import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { nativePath } from "./folderPath";
import type { GitRunResult } from "./GitProcess";

/** All this needs from a GitProcess. */
export interface PrGitRunner {
  readonly cwd: string;
  run(args: string[], opts?: { signal?: AbortSignal }): Promise<GitRunResult>;
}

export interface PrHeadPlan {
  /** The local branch name, `pr/<n>`. */
  local: string;
  /** Its full ref, `refs/heads/pr/<n>`. */
  ref: string;
  /** The PR head as just fetched. */
  sha: string;
  kind: "create" | "current" | "fast-forward" | "diverged" | "elsewhere";
  /** pr/<n> is this worktree's HEAD. */
  checkedOut: boolean;
  /** Where pr/<n> was, when it exists. */
  localSha?: string;
  /** Diverged: how many commits pr/<n> has that the PR head does not. */
  localOnly?: number;
  /** Elsewhere: the worktree pr/<n> is checked out in. */
  worktree?: string;
}

/** `pr/<n>` for a PR number — the only names this module ever writes. */
export function prBranchName(n: number): string {
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error(`not a pull request number: ${String(n)}`);
  }
  return `pr/${n}`;
}

/**
 * Fetch the PR's head (`refs/pull/<n>/head`, which exists for forks too) from
 * `remote` without writing any branch, and return the commit it names. The
 * commit is read from FETCH_HEAD's line for exactly that ref, so a fetch
 * running beside this one cannot hand us its answer.
 */
export async function fetchPrHead(
  proc: PrGitRunner,
  remote: string,
  n: number,
  opts?: { signal?: AbortSignal },
): Promise<{ sha: string } | { error: string }> {
  prBranchName(n);
  if (!remote || remote.startsWith("-")) {
    return { error: `"${remote}" isn't a remote name.` };
  }
  const refspec = `refs/pull/${n}/head`;
  const f = await proc.run(["fetch", "--no-tags", "--", remote, refspec], opts);
  if (f.code !== 0) {
    return { error: firstLine(f.stderr) || `git fetch exited with ${f.code}` };
  }
  const where = await proc.run(["rev-parse", "--git-path", "FETCH_HEAD"], opts);
  const rel = where.stdout.trim();
  if (where.code !== 0 || !rel) {
    return { error: "Couldn't find what was fetched (FETCH_HEAD)." };
  }
  let text = "";
  try {
    text = await readFile(isAbsolute(rel) ? rel : join(proc.cwd, rel), "utf8");
  } catch {
    return { error: "Couldn't read what was fetched (FETCH_HEAD)." };
  }
  for (const line of text.split("\n")) {
    const m = /^([0-9a-f]{40,64})\t[^\t]*\t'([^']+)'/.exec(line);
    if (m && m[2] === refspec) {
      return { sha: m[1] };
    }
  }
  return { error: "Couldn't find the pull request's head in what was fetched." };
}

/** What checking out `pr/<n>` at `sha` means for the branch that is there. */
export async function planPrHead(
  proc: PrGitRunner,
  n: number,
  sha: string,
  opts?: { signal?: AbortSignal },
): Promise<PrHeadPlan> {
  const local = prBranchName(n);
  const ref = `refs/heads/${local}`;
  const [existing, head, worktrees] = await Promise.all([
    proc.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], opts),
    proc.run(["symbolic-ref", "--quiet", "HEAD"], opts),
    proc.run(["worktree", "list", "--porcelain"], opts),
  ]);
  const checkedOut = head.code === 0 && head.stdout.trim() === ref;
  if (existing.code !== 0) {
    return { local, ref, sha, kind: "create", checkedOut: false };
  }
  const localSha = existing.stdout.trim();
  const base = { local, ref, sha, checkedOut, localSha };

  if (!checkedOut) {
    const other = worktreeHolding(worktrees.stdout, ref);
    if (other) {
      return { ...base, kind: "elsewhere", worktree: other };
    }
  }
  if (localSha === sha) {
    return { ...base, kind: "current" };
  }
  const ancestor = await proc.run(["merge-base", "--is-ancestor", ref, sha], opts);
  if (ancestor.code === 0) {
    return { ...base, kind: "fast-forward" };
  }
  const count = await proc.run(["rev-list", "--count", `${sha}..${ref}`], opts);
  const localOnly = Number.parseInt(count.stdout.trim(), 10);
  return { ...base, kind: "diverged", localOnly: Number.isFinite(localOnly) ? localOnly : undefined };
}

/**
 * Move pr/<n> to the PR head when it is NOT checked out here — a compare-and-
 * swap against where it was, so a branch that moved meanwhile is left alone.
 * (Checked out, the caller fast-forwards with `merge --ff-only` through its
 * door instead: the working tree moves with it.)
 */
export async function movePrBranch(
  proc: PrGitRunner,
  plan: PrHeadPlan,
  opts?: { signal?: AbortSignal },
): Promise<GitRunResult> {
  if (!plan.localSha) {
    return { code: 1, stdout: "", stderr: `${plan.local} doesn't exist yet.` };
  }
  return proc.run(
    ["update-ref", "-m", `GitStudio: update ${plan.local} to pull request head`, plan.ref, plan.sha, plan.localSha],
    opts,
  );
}

/** "pr/7 has 2 commits that pull request #7 doesn't …" — the diverged case, in words. */
export function divergedMessage(n: number, plan: PrHeadPlan): string {
  const k = plan.localOnly;
  const commits = k === undefined ? "commits" : k === 1 ? "1 commit" : `${k} commits`;
  return (
    `${plan.local} has ${commits} that pull request #${n} doesn't — made here, or from before ` +
    `the PR was force-pushed.`
  );
}

/**
 * The worktree that has `ref` checked out, if any — spelled the system's way,
 * as it is shown. Asked only when THIS worktree's HEAD is not `ref`, so any
 * worktree listed with it is another.
 */
function worktreeHolding(porcelain: string, ref: string): string | undefined {
  let path: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      path = line.slice("worktree ".length);
    } else if (line === `branch ${ref}`) {
      return path === undefined ? undefined : nativePath(path);
    }
  }
  return undefined;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}
