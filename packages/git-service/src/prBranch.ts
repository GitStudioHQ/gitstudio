/**
 * Checking out a pull request the way `gh pr checkout` does: onto its REAL
 * head branch, tracking it where it lives, so a push from here reaches the
 * pull request. Both products can use it; the extension's Pull Requests
 * section does (pr/checkoutPr.ts).
 *
 * The old way (prCheckout.ts, still used when the head is gone) made a
 * `pr/<n>` copy from `refs/pull/<n>/head` with no upstream: fixes made on it
 * could never be pushed to the pull request.
 *
 * Now the head branch is fetched from the remote that names the repository it
 * lives in — the pull request's own for a same-repository branch, the fork's
 * for a fork's (the caller adds that remote when the clone has none) — into
 * its remote-tracking ref, and what that means for the local branch of the
 * same name is decided here:
 *
 *   create        — no such local branch: create it at the head, tracking it
 *   current       — it is the pull request's branch, and at its head
 *   fast-forward  — it is the pull request's branch, behind its head, with
 *                   nothing of its own: move it (a fast-forward merge when it
 *                   is checked out)
 *   ahead         — it is the pull request's branch with commits of its own on
 *                   top (not pushed yet): check it out as it is
 *   diverged      — both have commits the other doesn't: NOTHING is moved
 *                   until the user says so
 *   taken         — a branch of that name exists and is NOT the pull
 *                   request's (it tracks something else — your `main` is not a
 *                   fork's `main`): the user decides, and is offered a free
 *                   name (`owner-branch`)
 *   elsewhere     — it is checked out in another worktree
 *
 * "The pull request's branch" means: it tracks <remote>/<head> — or, for a
 * same-repository pull request, it tracks nothing (your own branch, pushed
 * without -u); its upstream is set then.
 *
 * Only refs and config are decided and written here; the checkout itself goes
 * through each product's in-the-way door (Stash & Retry over uncommitted work
 * in its way). Every name that reaches git is checked first: a branch or
 * remote name that reads as an option never gets there.
 */

import { nativePath } from "./folderPath";
import type { GitRunResult } from "./GitProcess";
import type { PrGitRunner } from "./prCheckout";
import * as l10n from "@vscode/l10n";

/** The pull request's branch, and where it lives. */
export interface PrBranchTarget {
  /** The pull request's number. */
  n: number;
  /** Its head branch's name, on the repository it lives in. */
  headRef: string;
  /** The git remote that names that repository (a name, never a URL). */
  remote: string;
  /** Other ways the local config may name that repository (remote names, URLs). */
  remoteAliases?: readonly string[];
  /** The head lives in the pull request's own repository (not a fork). */
  sameRepo: boolean;
  /** Who owns the repository the head lives in — names the alternative branch. */
  headOwner: string;
}

export type PrBranchKind = "create" | "current" | "fast-forward" | "ahead" | "diverged" | "taken" | "elsewhere";

export interface PrBranchPlan {
  /** The local branch the checkout lands on. */
  local: string;
  /** Its full ref, `refs/heads/<local>`. */
  ref: string;
  /** The remote-tracking ref of the pull request's branch, `refs/remotes/<remote>/<head>`. */
  tracking: string;
  /** The same, in words: `<remote>/<head>`. */
  trackingName: string;
  /** The pull request's branch as just fetched. */
  sha: string;
  kind: PrBranchKind;
  /** <local> is this worktree's HEAD. */
  checkedOut: boolean;
  /** Where <local> is, when it exists. */
  localSha?: string;
  /** What <local> tracks now: the pull request's branch, nothing, or something else. */
  tracks: "pr" | "none" | "other";
  /** Something else, in words: "origin/main", "the local branch main". */
  tracksName?: string;
  /** <local> against the pull request's branch, when it exists. */
  relation?: "same" | "behind" | "ahead" | "diverged";
  /** Commits <local> has that the pull request's branch doesn't. */
  ahead?: number;
  /** Commits the pull request's branch has that <local> doesn't. */
  behind?: number;
  /** The other worktree that has it checked out (elsewhere; or taken, where it rules out Use). */
  worktree?: string;
  /** Once landed, point its upstream (and push remote) at the pull request's branch. */
  setUpstream: boolean;
}

// ── Names ────────────────────────────────────────────────────────────────────

/**
 * A branch name git takes (`git check-ref-format --branch`'s rules), that can
 * never read as an option. Anything else is refused before git is run.
 */
export function isSafeBranchName(name: string): boolean {
  if (!name || name.length > 255 || name.startsWith("-") || name === "@" || name === "HEAD") return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{") || name.includes("//")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".")) return false;
  for (const part of name.split("/")) {
    if (part.startsWith(".") || part.endsWith(".lock")) return false;
  }
  return true;
}

/** A remote name git takes, never an option or a URL. */
export function isSafeRemoteName(name: string): boolean {
  return /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(name) && !name.endsWith(".") && !name.includes("..") && !name.endsWith(".lock");
}

function nameProblem(t: Pick<PrBranchTarget, "headRef" | "remote">, local?: string): string | undefined {
  if (!isSafeRemoteName(t.remote)) return l10n.t("\"{0}\" isn't a remote name.", t.remote);
  if (!isSafeBranchName(t.headRef)) return l10n.t("\"{0}\" isn't a branch name git takes.", t.headRef);
  if (local !== undefined && !isSafeBranchName(local)) return l10n.t("\"{0}\" isn't a branch name git takes.", local);
  return undefined;
}

// ── Fetch ────────────────────────────────────────────────────────────────────

/**
 * Fetch the pull request's branch from the remote that names its repository
 * into that remote's tracking ref — the one ref git's own fetch keeps for it
 * (forced, as a remote-tracking ref always is) — and read back where it is.
 * `gone`: the repository answered, and has no such branch (deleted after a
 * merge, or never pushed there).
 */
export async function fetchPrBranch(
  proc: PrGitRunner,
  t: Pick<PrBranchTarget, "headRef" | "remote">,
  opts?: { signal?: AbortSignal },
): Promise<{ sha: string } | { error: string; gone?: boolean }> {
  const bad = nameProblem(t);
  if (bad) return { error: bad };
  const tracking = `refs/remotes/${t.remote}/${t.headRef}`;
  const f = await proc.run(["fetch", "--no-tags", "--", t.remote, `+refs/heads/${t.headRef}:${tracking}`], opts);
  if (f.code !== 0) {
    const said = firstLine(f.stderr) || l10n.t("git fetch exited with {0}", f.code);
    return { error: said, ...(/couldn't find remote ref|no such ref|not our ref/i.test(f.stderr) ? { gone: true } : {}) };
  }
  const r = await proc.run(["rev-parse", "--verify", "--quiet", `${tracking}^{commit}`], opts);
  const sha = r.stdout.trim();
  if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(sha)) return { error: l10n.t("Couldn't read {0}/{1} after fetching it.", t.remote, t.headRef) };
  return { sha };
}

// ── Plan ─────────────────────────────────────────────────────────────────────

/** The local branch of that name as it is: where it points, what it tracks, who holds it. */
interface LocalBranch {
  exists: boolean;
  localSha?: string;
  checkedOut: boolean;
  tracks: PrBranchPlan["tracks"];
  tracksName?: string;
  /** Another worktree that has it checked out. */
  worktree?: string;
  /** It is the pull request's branch (tracks it, or — same repository — tracks nothing). */
  isPrs: boolean;
}

async function readLocal(proc: PrGitRunner, t: PrBranchTarget, local: string, opts?: { signal?: AbortSignal }): Promise<LocalBranch> {
  const ref = `refs/heads/${local}`;
  const [existing, head, worktrees, remoteCfg, mergeCfg] = await Promise.all([
    proc.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], opts),
    proc.run(["symbolic-ref", "--quiet", "HEAD"], opts),
    proc.run(["worktree", "list", "--porcelain"], opts),
    proc.run(["config", "--get", `branch.${local}.remote`], opts),
    proc.run(["config", "--get", `branch.${local}.merge`], opts),
  ]);
  const checkedOut = head.code === 0 && head.stdout.trim() === ref;
  if (existing.code !== 0) return { exists: false, checkedOut: false, tracks: "none", isPrs: false };
  const upRemote = remoteCfg.code === 0 ? remoteCfg.stdout.trim() : "";
  const upMerge = mergeCfg.code === 0 ? mergeCfg.stdout.trim() : "";
  const names = new Set([t.remote, ...(t.remoteAliases ?? [])]);
  let tracks: PrBranchPlan["tracks"];
  let tracksName: string | undefined;
  if (!upRemote && !upMerge) {
    tracks = "none";
  } else if (names.has(upRemote) && upMerge === `refs/heads/${t.headRef}`) {
    tracks = "pr";
  } else {
    tracks = "other";
    const branch = upMerge.replace(/^refs\/heads\//, "");
    tracksName = upRemote === "." ? l10n.t("the local branch {0}", branch) : `${upRemote}/${branch}`;
  }
  const worktree = checkedOut ? undefined : worktreeHolding(worktrees.stdout, ref);
  return {
    exists: true,
    localSha: existing.stdout.trim(),
    checkedOut,
    tracks,
    ...(tracksName ? { tracksName } : {}),
    ...(worktree ? { worktree } : {}),
    // Not the pull request's branch: a same-named one that tracks something
    // else, or a fork's head name on a branch of yours that tracks nothing.
    isPrs: tracks === "pr" || (tracks === "none" && t.sameRepo),
  };
}

/**
 * The worktree that has the pull request's own branch checked out, when it is
 * another one — asked before anything is fetched: that checkout can't happen
 * here, and saying so takes no network. (A same-named branch that isn't the
 * pull request's is asked about instead, with a name that is free.)
 */
export async function prBranchElsewhere(proc: PrGitRunner, t: PrBranchTarget, opts?: { signal?: AbortSignal }): Promise<string | undefined> {
  if (nameProblem(t, t.headRef)) return undefined;
  const b = await readLocal(proc, t, t.headRef, opts);
  return b.exists && b.isPrs ? b.worktree : undefined;
}

/** What checking out the pull request's branch as `local` means for the branch that is there. */
export async function planPrBranch(
  proc: PrGitRunner,
  t: PrBranchTarget,
  sha: string,
  local: string = t.headRef,
  opts?: { signal?: AbortSignal },
): Promise<PrBranchPlan> {
  const bad = nameProblem(t, local);
  if (bad) throw new Error(bad);
  const ref = `refs/heads/${local}`;
  const tracking = `refs/remotes/${t.remote}/${t.headRef}`;
  const base = { local, ref, tracking, trackingName: `${t.remote}/${t.headRef}`, sha };
  const b = await readLocal(proc, t, local, opts);
  if (!b.exists || !b.localSha) {
    return { ...base, kind: "create", checkedOut: false, tracks: "none", setUpstream: true };
  }
  const rel = await relation(proc, b.localSha, sha, opts);
  const known = {
    ...base,
    checkedOut: b.checkedOut,
    localSha: b.localSha,
    tracks: b.tracks,
    ...(b.tracksName ? { tracksName: b.tracksName } : {}),
    ...(b.worktree ? { worktree: b.worktree } : {}),
    ...rel,
  };
  // Not the pull request's: the user decides (another worktree holding it
  // only takes Use off the table).
  if (!b.isPrs) return { ...known, kind: "taken", setUpstream: false };
  if (b.worktree) return { ...known, kind: "elsewhere", setUpstream: false };
  const kind: PrBranchKind =
    rel.relation === "same" ? "current" : rel.relation === "behind" ? "fast-forward" : rel.relation === "ahead" ? "ahead" : "diverged";
  return { ...known, kind, setUpstream: b.tracks === "none" };
}

async function relation(
  proc: PrGitRunner,
  localSha: string,
  sha: string,
  opts?: { signal?: AbortSignal },
): Promise<Pick<PrBranchPlan, "relation" | "ahead" | "behind">> {
  if (localSha === sha) return { relation: "same", ahead: 0, behind: 0 };
  const counts = await proc.run(["rev-list", "--left-right", "--count", `${localSha}...${sha}`], opts);
  const [a, b] = counts.stdout.trim().split(/\s+/).map((x) => Number.parseInt(x, 10));
  const ahead = Number.isFinite(a) ? a : undefined;
  const behind = Number.isFinite(b) ? b : undefined;
  if (ahead === 0) return { relation: "behind", ahead: 0, ...(behind !== undefined ? { behind } : {}) };
  if (behind === 0) return { relation: "ahead", behind: 0, ...(ahead !== undefined ? { ahead } : {}) };
  return { relation: "diverged", ...(ahead !== undefined ? { ahead } : {}), ...(behind !== undefined ? { behind } : {}) };
}

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * Move <local> to the pull request's head when it is NOT checked out here — a
 * compare-and-swap against where it was, so a branch that moved meanwhile is
 * left alone. (Checked out, the caller fast-forwards with `merge --ff-only`
 * through its door: the working tree moves with it.)
 */
export async function moveLocalBranch(
  proc: PrGitRunner,
  plan: Pick<PrBranchPlan, "local" | "ref" | "sha" | "localSha">,
  why: string,
  opts?: { signal?: AbortSignal },
): Promise<GitRunResult> {
  if (!plan.localSha) return { code: 1, stdout: "", stderr: l10n.t("{0} doesn't exist yet.", plan.local) };
  // English on purpose: the `-m` text is the reflog entry git stores.
  return proc.run(["update-ref", "-m", `GitStudio: ${why}`, plan.ref, plan.sha, plan.localSha], opts);
}

/**
 * <local> tracks the pull request's branch, and pushes there — whatever
 * `remote.pushDefault` says, as `gh pr checkout` sets it — so a push reaches
 * the pull request.
 */
export async function trackPrBranch(
  proc: PrGitRunner,
  t: Pick<PrBranchTarget, "headRef" | "remote">,
  local: string,
  opts?: { signal?: AbortSignal },
): Promise<GitRunResult> {
  const bad = nameProblem(t, local);
  if (bad) return { code: 1, stdout: "", stderr: bad };
  for (const [key, value] of [
    [`branch.${local}.remote`, t.remote],
    [`branch.${local}.merge`, `refs/heads/${t.headRef}`],
    [`branch.${local}.pushRemote`, t.remote],
  ] as const) {
    const r = await proc.run(["config", key, value], opts);
    if (r.code !== 0) return r;
  }
  return { code: 0, stdout: "", stderr: "" };
}

/**
 * A free local name for the pull request's branch when its own is taken:
 * `<owner>-<head>` ("alice-main" for a fork's main), else `pr/<n>`, else
 * `pr/<n>-2`… Free means: no branch has it, none is a folder of it, it is no
 * folder of one (git refuses `a/b` beside `a`), and no remote-tracking branch
 * goes by the same short name — `alice/main` beside the remote `alice` is an
 * ambiguous name to every git command that takes one.
 */
export async function freeBranchName(
  proc: PrGitRunner,
  t: Pick<PrBranchTarget, "n" | "headRef" | "headOwner">,
  opts?: { signal?: AbortSignal },
): Promise<string | undefined> {
  const list = await proc.run(["for-each-ref", "--format=%(refname)", "refs/heads/", "refs/remotes/"], opts);
  const heads = new Set<string>();
  const remotes = new Set<string>();
  for (const line of list.stdout.split("\n")) {
    const r = line.trim();
    if (r.startsWith("refs/heads/")) heads.add(r.slice("refs/heads/".length));
    else if (r.startsWith("refs/remotes/")) remotes.add(r.slice("refs/remotes/".length));
  }
  const free = (name: string): boolean => {
    if (!isSafeBranchName(name) || heads.has(name) || remotes.has(name)) return false;
    const parts = name.split("/");
    for (let i = 1; i < parts.length; i++) if (heads.has(parts.slice(0, i).join("/"))) return false;
    for (const h of heads) if (h.startsWith(`${name}/`)) return false;
    return true;
  };
  const owner = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(t.headOwner) ? t.headOwner.toLowerCase() : undefined;
  const flat = t.headRef.replace(/\//g, "-");
  const candidates = [
    ...(owner ? [`${owner}-${flat}`] : []),
    `pr/${t.n}`,
    ...Array.from({ length: 8 }, (_, i) => `pr/${t.n}-${i + 2}`),
  ];
  return candidates.find(free);
}

// ── The head repository's remote ─────────────────────────────────────────────

/**
 * The URL of `owner/repo` written the way the clone already talks to GitHub:
 * over SSH (keeping the host — an ~/.ssh/config alias stays an alias) when
 * `like` is an SSH remote, else over https.
 */
export function remoteUrlLike(like: string | undefined, owner: string, repo: string): string | undefined {
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo) || owner.startsWith("-") || repo.startsWith("-")) return undefined;
  const path = `${owner}/${repo}.git`;
  const u = (like ?? "").trim();
  const ssh = /^ssh:\/\/([^/@\s]+@)?([^/:\s]+)(:\d+)?\//i.exec(u);
  if (ssh) return `ssh://${ssh[1] ?? "git@"}${ssh[2]}${ssh[3] ?? ""}/${path}`;
  const scp = /^([^@/\s:]+@)?([^/:\s]+):(?!\/\/)/.exec(u);
  if (scp && !u.includes("://")) return `${scp[1] ?? "git@"}${scp[2]}:${path}`;
  return `https://github.com/${path}`;
}

/**
 * A name for a new remote that fetches `owner`'s repository: the owner's
 * login, lowercased (gh's name), else it with a number — never one the clone
 * already uses.
 */
export function newRemoteName(preferred: string, taken: readonly string[]): string | undefined {
  const base = preferred.toLowerCase().replace(/[^a-z0-9_.-]/g, "-").replace(/^[-.]+/, "");
  if (!base) return undefined;
  const used = new Set(taken.map((n) => n.toLowerCase()));
  for (const name of [base, ...Array.from({ length: 8 }, (_, i) => `${base}-${i + 2}`)]) {
    if (isSafeRemoteName(name) && !used.has(name)) return name;
  }
  return undefined;
}

/** `git remote add <name> <url>` — only a checked name, only a URL. */
export async function addRemote(proc: PrGitRunner, name: string, url: string, opts?: { signal?: AbortSignal }): Promise<GitRunResult> {
  if (!isSafeRemoteName(name)) return { code: 1, stdout: "", stderr: l10n.t("\"{0}\" isn't a remote name.", name) };
  if (!/^(https:\/\/|ssh:\/\/|[A-Za-z0-9_.-]+@[A-Za-z0-9_.-]+:)/.test(url)) return { code: 1, stdout: "", stderr: l10n.t("\"{0}\" isn't a remote URL.", url) };
  return proc.run(["remote", "add", "--", name, url], opts);
}

// ── Words ────────────────────────────────────────────────────────────────────

export function commitsWord(n: number | undefined): string {
  return n === undefined ? l10n.t("commits") : n === 1 ? l10n.t("1 commit") : l10n.t("{0} commits", n);
}

/**
 * The worktree that has `ref` checked out, if any — spelled the system's way,
 * as it is shown (prCheckout's sibling does the same). Asked only when THIS
 * worktree's HEAD is not `ref`, so any worktree listed with it is another.
 */
function worktreeHolding(porcelain: string, ref: string): string | undefined {
  let path: string | undefined;
  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice("worktree ".length);
    else if (line === `branch ${ref}`) return path === undefined ? undefined : nativePath(path);
  }
  return undefined;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim().length > 0) ?? "").trim();
}
