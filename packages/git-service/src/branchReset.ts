/**
 * "Reset 'feature' to 'origin/feature'" — make a local branch match a remote
 * branch exactly, dropping whatever it has that the remote does not (issue
 * #32: "in IDEA you can just checkout the same branch from origin and it
 * throws everything local away and makes it 1:1 with origin").
 *
 * Planned here, free of any host, so every door means the same thing — the
 * extension's branch menu ("Reset to 'origin/feature'…" on a branch that
 * tracks one) and its "Checkout origin/feature" over a local branch that has
 * moved on — and so the whole plan runs against real git in tests.
 *
 * The order is fixed: name the target, FETCH it (the point is to match the
 * remote as it is now, not as it was at the last fetch), then read what the
 * reset would take away, then — only after the person has seen that — reset.
 *
 * What it hands git is never a short name:
 *   · the branch is read as refs/heads/<name>. Beside a tag of the same name,
 *     "release" is the tag;
 *   · the target is a refs/remotes/ name, and the reset lands on the SHA the
 *     question was asked about, so a background fetch between the question
 *     and the answer cannot change what was agreed to;
 *   · the checked-out branch is reset with `reset --hard <sha>` — its name
 *     never reaches argv — and any other branch is moved with
 *     `branch -f -- <name> <sha>`, which git itself refuses for a branch
 *     checked out in any worktree (including one being rebased there).
 */

import type { GitRef } from "@gitstudio/host-bridge/git";
import type { GitProcess, GitRunOptions } from "./GitProcess";
import { parseV2 } from "./StatusProvider";
import { refShortName } from "./checkoutRef";
import { localNameFor } from "./checkoutRemote";
import { operationInTheWayMessage, pick, stoppedIn } from "./stoppedOperation";

/** How many of the commits a reset drops the question lists by subject. */
export const DROPPED_SHOWN = 5;

/** Why a reset is not offered or not run — the whole sentence, for a person. */
export interface ResetRefusal {
  refused: string;
}

export function isResetRefusal(x: unknown): x is ResetRefusal {
  return typeof x === "object" && x !== null && typeof (x as ResetRefusal).refused === "string";
}

/** The branch, and what it would be made to match. */
export interface ResetTarget {
  /** refs/heads/<branch>. */
  fullName: string;
  /** The name under refs/heads/. */
  branch: string;
  /** refs/remotes/<remote>/<name> — what the branch is made to match. */
  target: string;
  /** The target as a person reads it: "origin/feature". */
  targetName: string;
  /** The remote fetched before anything is compared. */
  remote: string;
  /** HEAD's branch in this worktree: the reset takes the working tree with it. */
  current: boolean;
}

/** A reset, read after the fetch: what it takes away, and what it brings. */
export interface ResetPlan extends ResetTarget {
  /** Where the branch is now. */
  localSha: string;
  /** Where it is going: the target's commit, as the question saw it. */
  targetSha: string;
  /** Commits on the branch the target doesn't have — what the reset drops. */
  ahead: number;
  /** Commits on the target the branch doesn't have — what it gains. */
  behind: number;
  /** Up to DROPPED_SHOWN of the dropped commits, newest first. */
  dropped: { sha: string; subject: string }[];
  /** The current branch only: files with uncommitted changes, discarded. */
  dirty: number;
  /** The current branch only: untracked files the target tracks, which
   *  `reset --hard` overwrites without asking. */
  untrackedOverwritten: number;
  /** The fetch failed, so the target is as it was at the last fetch. */
  fetchFailed?: boolean;
}

/** What the reset should ask — or, when it would change nothing, say. */
export type ResetQuestion =
  | { kind: "nothing"; message: string }
  | { kind: "confirm"; title: string; message: string; confirmLabel: string; danger: boolean };

/** How a run ended. `refused`: a check just before running stopped it, and nothing ran. */
export interface ResetRun {
  ok: boolean;
  stderr: string;
  refused?: string;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const short = (sha: string): string => sha.slice(0, 7);

/** The commit a full ref name points at, or "" when there is no such ref. */
async function commitOf(proc: GitProcess, fullName: string, opts?: GitRunOptions): Promise<string> {
  const r = await proc.run(["rev-parse", "--verify", "--quiet", `${fullName}^{commit}`], opts);
  return r.code === 0 ? r.stdout.trim() : "";
}

/** HEAD's branch, by full name ("" when detached). */
async function headRef(proc: GitProcess, opts?: GitRunOptions): Promise<string> {
  const r = await proc.run(["symbolic-ref", "--quiet", "HEAD"], opts);
  return r.code === 0 ? r.stdout.trim() : "";
}

/**
 * The remote a remote-tracking ref belongs to. A remote's name may itself
 * hold a slash ("team/eu"), so the LONGEST configured remote whose namespace
 * the ref sits in wins; the first path segment is the fallback.
 */
async function remoteOf(proc: GitProcess, target: string, opts?: GitRunOptions): Promise<string> {
  const rest = target.slice("refs/remotes/".length);
  const r = await proc.run(["remote"], opts);
  const names = r.code === 0 ? r.stdout.split("\n").map((s) => s.trim()).filter(Boolean) : [];
  const owner = names
    .filter((n) => rest.startsWith(`${n}/`))
    .sort((a, b) => b.length - a.length)[0];
  return owner ?? rest.slice(0, Math.max(0, rest.indexOf("/")));
}

/**
 * The branch `fullName` and what it would be reset to: `target` (a
 * refs/remotes/ name) when a door names one, else the remote branch the
 * branch tracks. Refused — in a sentence — where no reset can be offered:
 * the branch is gone, it tracks nothing or only a local branch, it is checked
 * out in ANOTHER worktree, or its name would reach git as an option.
 */
export async function resetTargetOf(
  proc: GitProcess,
  fullName: string,
  target?: string,
  opts?: GitRunOptions,
): Promise<ResetTarget | ResetRefusal> {
  const branch = fullName.startsWith("refs/heads/") ? fullName.slice("refs/heads/".length) : "";
  if (!branch) {
    return { refused: `${fullName} is not a local branch.` };
  }
  // for-each-ref matches a pattern up to a slash as well as exactly
  // (refs/heads/x also lists refs/heads/x/y), so the row is picked by name.
  const r = await proc.run(
    ["for-each-ref", "--format=%(refname)%00%(upstream)%00%(upstream:remotename)%00%(worktreepath)", fullName],
    opts,
  );
  const row = r.stdout
    .split("\n")
    .map((line) => line.split("\0"))
    .find((f) => f[0] === fullName);
  if (r.code !== 0 || !row) {
    return { refused: `'${branch}' is not in this repository any more — refresh and try again.` };
  }
  const [, upstream = "", upstreamRemote = "", worktreePath = ""] = row;
  const current = (await headRef(proc, opts)) === fullName;

  let to = target ?? "";
  let remote = "";
  if (!to) {
    if (!upstream) {
      return {
        refused: `'${branch}' doesn't track a remote branch, so there is nothing to reset it to. Set its tracked branch first.`,
      };
    }
    if (!upstream.startsWith("refs/remotes/")) {
      return {
        refused: `'${branch}' tracks '${refShortName(upstream)}', a branch in this repository, not on a remote — there is nothing to fetch and reset it to.`,
      };
    }
    to = upstream;
    remote = upstreamRemote;
  } else if (!to.startsWith("refs/remotes/")) {
    return { refused: `${to} is not a remote branch.` };
  }
  if (!remote) {
    remote = await remoteOf(proc, to, opts);
  }
  const targetName = refShortName(to);

  // Checked out somewhere else: moving it would leave that worktree's HEAD
  // ahead of its own index — "staged changes" there that nobody made — and
  // resetting it here cannot discard what is uncommitted over there.
  if (!current && worktreePath) {
    return {
      refused: `'${branch}' is checked out in another worktree, at ${worktreePath}. Reset it there, or check out another branch in that worktree first.`,
    };
  }
  // A name git reads as an option. `branch -f -- <name>` is refused by git
  // for it, so say why rather than show git's words. (The checked-out branch
  // is reset without its name on argv, so it is not affected.)
  if (!current && branch.startsWith("-")) {
    return {
      refused: `Git can't safely move '${branch}': a branch name that starts with "-" reads as an option. Rename it, then reset it.`,
    };
  }
  if (!remote) {
    return { refused: `${targetName} does not belong to a remote this repository knows.` };
  }
  return { fullName, branch, target: to, targetName, remote, current };
}

/**
 * `git fetch -- <remote>`: the target as the remote has it NOW. True when the
 * fetch worked. `--` keeps a remote name that starts with "-" from being read
 * as an option (git refuses such a name outright: "strange pathname").
 */
export async function fetchResetTarget(proc: GitProcess, t: ResetTarget, opts?: GitRunOptions): Promise<boolean> {
  const r = await proc.run(["fetch", "--", t.remote], opts);
  return r.code === 0;
}

/**
 * What resetting `t` would do, read from git after the fetch. Refused when
 * the target is not there to reset to, or — for the checked-out branch —
 * when git is stopped in a merge, rebase, cherry-pick, revert or am:
 * `reset --hard` would end it without a word.
 */
export async function planReset(
  proc: GitProcess,
  t: ResetTarget,
  opts: GitRunOptions & { fetchFailed?: boolean } = {},
): Promise<ResetPlan | ResetRefusal> {
  const run = { signal: opts.signal };
  if (t.current) {
    const stop = await stoppedIn(proc, opts.signal).catch(() => null);
    if (stop) {
      return { refused: operationInTheWayMessage({ kind: "reset", ...pick(stop) }) };
    }
  }
  const localSha = await commitOf(proc, t.fullName, run);
  if (!localSha) {
    return { refused: `'${t.branch}' is not in this repository any more — refresh and try again.` };
  }
  const targetSha = await commitOf(proc, t.target, run);
  if (!targetSha) {
    return {
      refused: opts.fetchFailed
        ? `There is no '${t.targetName}' to reset to, and ${t.remote} couldn't be reached to fetch it.`
        : `There is no '${t.targetName}' to reset to — it is not on ${t.remote} any more.`,
    };
  }

  // "<behind>\t<ahead>": left = only on the target, right = only on the branch.
  const counts = await proc.run(["rev-list", "--left-right", "--count", `${targetSha}...${localSha}`], run);
  const [behindText = "0", aheadText = "0"] = counts.stdout.trim().split(/\s+/);
  const behind = Number(behindText) || 0;
  const ahead = Number(aheadText) || 0;

  const dropped: { sha: string; subject: string }[] = [];
  if (ahead > 0) {
    const log = await proc.run(
      ["log", `--max-count=${DROPPED_SHOWN}`, "--format=%h%x09%s", `${targetSha}..${localSha}`],
      run,
    );
    for (const line of log.stdout.split("\n")) {
      if (!line) continue;
      const tab = line.indexOf("\t");
      dropped.push(tab < 0 ? { sha: line, subject: "" } : { sha: line.slice(0, tab), subject: line.slice(tab + 1) });
    }
  }

  let dirty = 0;
  let untrackedOverwritten = 0;
  if (t.current) {
    // Every untracked FILE, not git's folded "dir/": an untracked file is only
    // at risk where the target has something at its path.
    const st = await proc.run(["status", "--porcelain=v2", "-z", "--untracked-files=all"], run);
    const s = parseV2(st.stdout);
    const changed = new Set<string>([
      ...s.staged.map((f) => f.path),
      ...s.unstaged.filter((f) => f.status !== "U").map((f) => f.path),
      ...s.merge.map((f) => f.path),
    ]);
    dirty = changed.size;
    const untracked = s.unstaged.filter((f) => f.status === "U").map((f) => f.path);
    if (untracked.length > 0) {
      untrackedOverwritten = await countOverwritten(proc, targetSha, untracked, run);
    }
  }

  return {
    ...t,
    localSha,
    targetSha,
    ahead,
    behind,
    dropped,
    dirty,
    untrackedOverwritten,
    ...(opts.fetchFailed ? { fetchFailed: true } : {}),
  };
}

/**
 * How many untracked files `reset --hard <targetSha>` would overwrite: those
 * the target has a file at, those under a path the target has as a FILE, and
 * those at a path the target needs as a DIRECTORY. git deletes each of them
 * to write the target's tree, and nothing records them first.
 */
async function countOverwritten(
  proc: GitProcess,
  targetSha: string,
  untracked: string[],
  opts?: GitRunOptions,
): Promise<number> {
  const tree = await proc.run(["ls-tree", "-r", "--name-only", "-z", targetSha], opts);
  if (tree.code !== 0) return 0;
  const files = new Set(tree.stdout.split("\0").filter(Boolean));
  const dirs = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf("/"); i > 0; i = f.indexOf("/", i + 1)) dirs.add(f.slice(0, i));
  }
  let n = 0;
  for (const p of untracked) {
    let hit = files.has(p) || dirs.has(p);
    for (let i = p.indexOf("/"); !hit && i > 0; i = p.indexOf("/", i + 1)) {
      if (files.has(p.slice(0, i))) hit = true;
    }
    if (hit) n++;
  }
  return n;
}

/**
 * The question to ask, in words — or, when the reset would change nothing,
 * the sentence that says so. Scary words only where something is lost:
 * a branch that is behind and has nothing of its own is fast-forwarded, and
 * says that.
 */
export function resetQuestion(p: ResetPlan): ResetQuestion {
  const b = `'${p.branch}'`;
  const t = `'${p.targetName}'`;
  const stale = p.fetchFailed
    ? `${p.remote} couldn't be reached, so this uses ${t} as it was when last fetched.`
    : "";
  const dirty = p.current ? p.dirty : 0;
  const overwritten = p.current ? p.untrackedOverwritten : 0;
  const loses = p.ahead > 0 || dirty > 0 || overwritten > 0;

  if (!loses && p.behind === 0) {
    return { kind: "nothing", message: [`${b} already matches ${t}. Nothing to reset.`, stale].filter(Boolean).join(" ") };
  }
  if (!loses) {
    return {
      kind: "confirm",
      title: `Fast-forward ${b} to ${t}?`,
      message: [
        `${b} is ${plural(p.behind, "commit")} behind ${t} and has no commits of its own, so nothing is lost: it moves forward to match.`,
        stale,
      ]
        .filter(Boolean)
        .join("\n\n"),
      confirmLabel: "Fast-forward",
      danger: false,
    };
  }

  const parts: string[] = [];
  if (p.ahead > 0) {
    const lines = p.dropped.map((c) => `    ${c.sha}  ${c.subject}`);
    if (p.ahead > p.dropped.length) lines.push(`    …and ${p.ahead - p.dropped.length} more`);
    parts.push(
      `${plural(p.ahead, "commit")} on ${b} ${p.ahead === 1 ? "is" : "are"} not on ${t}, and the reset takes ${p.ahead === 1 ? "it" : "them"} off the branch:\n` +
        lines.join("\n"),
    );
  }
  if (dirty > 0) {
    parts.push(`Uncommitted changes to ${plural(dirty, "file")} are discarded.`);
  }
  if (overwritten > 0) {
    parts.push(
      `${plural(overwritten, "untracked file")} ${overwritten === 1 ? "is" : "are"} overwritten by what ${t} has at ${overwritten === 1 ? "its path" : "their paths"}.`,
    );
  }
  if (p.behind > 0) {
    parts.push(`${b} also gets the ${plural(p.behind, "commit")} on ${t} it doesn't have yet.`);
  }
  parts.push(
    `GitStudio's Undo can put the branch back${dirty > 0 ? ", with your uncommitted changes" : ""}.` +
      (overwritten > 0 ? ` It can't bring back the overwritten untracked ${overwritten === 1 ? "file" : "files"}.` : ""),
  );
  if (stale) parts.push(stale);
  return {
    kind: "confirm",
    title: `Reset ${b} to ${t}?`,
    message: parts.join("\n\n"),
    confirmLabel: "Reset",
    danger: true,
  };
}

/**
 * Run the reset the person agreed to — after checking it is still that
 * reset: the branch must be where the question saw it, and checked out (or
 * not) the same way, or nothing runs.
 */
export async function runReset(proc: GitProcess, p: ResetPlan, opts?: GitRunOptions): Promise<ResetRun> {
  const now = await commitOf(proc, p.fullName, opts);
  if (now !== p.localSha) {
    return {
      ok: false,
      stderr: "",
      refused: now
        ? `'${p.branch}' moved while you were being asked (it is at ${short(now)} now, not ${short(p.localSha)}). Nothing was reset — try again.`
        : `'${p.branch}' is not in this repository any more. Nothing was reset.`,
    };
  }
  if (((await headRef(proc, opts)) === p.fullName) !== p.current) {
    return {
      ok: false,
      stderr: "",
      refused: `Which branch is checked out changed while you were being asked. Nothing was reset — try again.`,
    };
  }
  const args = p.current
    ? ["reset", "--hard", p.targetSha]
    : ["branch", "-f", "--", p.branch, p.targetSha];
  const r = await proc.run(args, opts);
  return { ok: r.code === 0, stderr: r.stderr };
}

/**
 * The local branches (by short name, as a menu names them) whose upstream is
 * a remote-tracking branch this repository HAS — the branches a menu offers
 * "Reset to '<upstream>'…" on. Not one with no upstream, one tracking a local
 * branch, or one whose upstream is gone.
 *
 * `%(upstream:short)` and a remote ref's `%(refname:short)` are shortened by
 * the same rule, so the upstream of such a branch is one of the remote refs'
 * names — including where a local branch "origin/x" makes both of them
 * "remotes/origin/x".
 */
export function resettableBranches(refs: readonly GitRef[]): Set<string> {
  const remotes = new Set(refs.filter((r) => r.type === "remote" && !r.symref).map((r) => r.name));
  return new Set(
    refs
      .filter((r) => r.type === "head" && !!r.upstream && !r.gone && remotes.has(r.upstream))
      .map((r) => r.name),
  );
}

/**
 * For "Checkout origin/x" over a local x: the local branch and how far it
 * has moved on from origin/x. Undefined when there is no local x, or when it
 * has no commits of its own (equal, or only behind) — then the checkout just
 * switches to it, as it always has, and nothing needs asking.
 *
 * The local name is the one the checkout itself lands on (localNameFor, the
 * planner's rule), so the question is about the branch the checkout means.
 */
export async function localMovedOnFrom(
  proc: GitProcess,
  remoteFullName: string,
  opts?: GitRunOptions,
): Promise<{ fullName: string; branch: string; ahead: number; behind: number } | undefined> {
  if (!remoteFullName.startsWith("refs/remotes/")) return undefined;
  const branch = localNameFor(refShortName(remoteFullName));
  const fullName = `refs/heads/${branch}`;
  const [localSha, remoteSha] = await Promise.all([commitOf(proc, fullName, opts), commitOf(proc, remoteFullName, opts)]);
  if (!localSha || !remoteSha || localSha === remoteSha) return undefined;
  const counts = await proc.run(["rev-list", "--left-right", "--count", `${remoteSha}...${localSha}`], opts);
  if (counts.code !== 0) return undefined;
  const [behindText = "0", aheadText = "0"] = counts.stdout.trim().split(/\s+/);
  const ahead = Number(aheadText) || 0;
  const behind = Number(behindText) || 0;
  return ahead > 0 ? { fullName, branch, ahead, behind } : undefined;
}
