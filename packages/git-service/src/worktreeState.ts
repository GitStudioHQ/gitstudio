import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { GitProcess, GitRunOptions } from "./GitProcess";
import { parseV2 } from "./StatusProvider";
import { stoppedIn, type StoppedOperation } from "./stoppedOperation";
import type { WorktreeEntry } from "./WorktreeProvider";
import * as l10n from "@vscode/l10n";

// What each worktree of a repository is doing — read in tiers, so a list of
// seventy worktrees costs a fixed handful of spawns to paint, and the rest is
// read only for the rows someone can see or opens.
//
//   · tier 0, every refresh, for EVERY worktree: `git worktree list`, one
//     `for-each-ref` over refs/heads and refs/remotes (each branch's
//     upstream, ahead/behind and gone, and each remote's HEAD — the default
//     branch) and `git remote`. Three spawns however many worktrees there are.
//   · tier 1, for a row in view: its working tree (`status -z`, every
//     untracked file), what git is stopped in there, and — with no upstream —
//     how many of its commits no remote has.
//   · tier 2, for a row that is open: the commits themselves, and one
//     commit's files when that commit is opened.
//
// Every read about ANOTHER worktree names it with `-C <path>` (or a process
// AT it), because its index, HEAD and operation markers are its own; the
// objects and refs are shared.

/** One worktree, as a list row needs it before anything else is read. */
export interface WorktreeSummary {
  /** Its folder, as git lists it. */
  path: string;
  /** The commit it has checked out (empty for a bare repository's entry). */
  head: string;
  /** The branch it has checked out, by the name under refs/heads/. */
  branch?: string;
  /** The bare repository's own entry — not a working tree at all. */
  bare: boolean;
  /** The first entry git lists: the worktree that holds the repository. */
  main: boolean;
  /** No branch checked out: a commit, or a rebase in progress. */
  detached: boolean;
  locked: boolean;
  lockReason?: string;
  /** git would prune it (its folder is gone, and it is not locked). */
  prunable: boolean;
  prunableReason?: string;
  /** Its folder is not there — the filesystem's answer, which a LOCKED
   *  worktree needs (git never calls a locked one prunable). */
  missing: boolean;
  /**
   * Its folder is there, but it is not a worktree any more: its .git is gone
   * (git lists it prunable, or — locked, which git never prunes — the folder
   * says so). `git -C` there finds whatever repository is AROUND the folder —
   * the main worktree, for one nested in it — so nothing is ever read or run
   * in it: its tree is not read, and it can only be forgotten.
   */
  unlinked: boolean;
  /** Its branch's upstream, by full name (refs/remotes/origin/x, or
   *  refs/heads/y for a branch that tracks a local one). */
  upstream?: string;
  /** The upstream is configured but its ref is gone (deleted on the remote
   *  and pruned here). */
  upstreamGone: boolean;
  /** Commits it has that its upstream does not, and the other way round. */
  ahead: number;
  behind: number;
}

/** The repository-wide facts every row is judged against. */
export interface WorktreesSnapshot {
  worktrees: WorktreeSummary[];
  /** The remotes configured (`git remote`). */
  remotes: string[];
  /**
   * The branch the others merge into: a remote's HEAD (origin's first, else
   * the first remote's), else a local `main` or `master`, else the main
   * worktree's branch. `ref` is the full name; `name` how it reads
   * ("origin/main", or "main").
   */
  defaultBranch?: { ref: string; name: string; local: string };
}

/** What a branch's for-each-ref line says. */
interface BranchFacts {
  upstream?: string;
  ahead: number;
  behind: number;
  gone: boolean;
}

/** The for-each-ref read behind every row's sync state. */
export interface RefFacts {
  /** refs/heads/<b> → its upstream and how far apart they are. */
  branches: Map<string, BranchFacts>;
  /** remote name → the full ref its HEAD points at (refs/remotes/origin/main). */
  remoteHeads: Map<string, string>;
}

/** `%(refname) %(upstream) %(upstream:track,nobracket) %(symref)`, NUL-separated. */
export const REF_FACTS_FORMAT = "--format=%(refname)%00%(upstream)%00%(upstream:track,nobracket)%00%(symref)";

/** Parse the for-each-ref read (one ref per line, four NUL-separated fields). */
export function parseRefFacts(stdout: string): RefFacts {
  const branches = new Map<string, BranchFacts>();
  const remoteHeads = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const [ref = "", upstream = "", track = "", symref = ""] = line.split("\0");
    if (ref.startsWith("refs/heads/")) {
      const ahead = /ahead (\d+)/.exec(track);
      const behind = /behind (\d+)/.exec(track);
      branches.set(ref, {
        upstream: upstream || undefined,
        ahead: ahead ? Number(ahead[1]) : 0,
        behind: behind ? Number(behind[1]) : 0,
        gone: track.trim() === "gone",
      });
    } else if (ref.startsWith("refs/remotes/") && ref.endsWith("/HEAD") && symref.startsWith("refs/remotes/")) {
      const remote = ref.slice("refs/remotes/".length, -"/HEAD".length);
      if (remote) remoteHeads.set(remote, symref);
    }
  }
  return { branches, remoteHeads };
}

/** The default branch, from what is known without another spawn. */
export function defaultBranchOf(
  facts: RefFacts,
  list: readonly WorktreeEntry[],
): WorktreesSnapshot["defaultBranch"] {
  const remote = facts.remoteHeads.has("origin") ? "origin" : [...facts.remoteHeads.keys()].sort()[0];
  const target = remote ? facts.remoteHeads.get(remote) : undefined;
  if (remote && target) {
    const name = target.slice("refs/remotes/".length);
    return { ref: target, name, local: name.startsWith(`${remote}/`) ? name.slice(remote.length + 1) : name };
  }
  for (const n of ["main", "master"]) {
    if (facts.branches.has(`refs/heads/${n}`)) return { ref: `refs/heads/${n}`, name: n, local: n };
  }
  const home = list.find((e) => !e.bare)?.branch;
  return home ? { ref: `refs/heads/${home}`, name: home, local: home } : undefined;
}

/** Join git's list with the ref facts and the filesystem. */
export function summarize(
  list: readonly WorktreeEntry[],
  facts: RefFacts,
  exists: (path: string) => boolean = existsSync,
): WorktreeSummary[] {
  return list.map((e, i) => {
    const b = e.branch ? facts.branches.get(`refs/heads/${e.branch}`) : undefined;
    const missing = !e.bare && !exists(e.path);
    return {
      path: e.path,
      head: e.head,
      ...(e.branch ? { branch: e.branch } : {}),
      bare: !!e.bare,
      main: i === 0,
      detached: !e.bare && !e.branch,
      locked: !!e.locked,
      ...(e.lockReason ? { lockReason: e.lockReason } : {}),
      prunable: !!e.prunable,
      ...(e.prunableReason ? { prunableReason: e.prunableReason } : {}),
      missing,
      // Never the main worktree (git lists it first): only a linked one has a
      // .git FILE that can go while its folder stays.
      unlinked: !e.bare && i > 0 && !missing && (!!e.prunable || !exists(join(e.path, ".git"))),
      ...(b?.upstream ? { upstream: b.upstream } : {}),
      upstreamGone: !!b?.gone,
      ahead: b?.ahead ?? 0,
      behind: b?.behind ?? 0,
    };
  });
}

/** Tier 0: every worktree's summary, in three spawns. */
export async function readWorktreesSnapshot(
  proc: GitProcess,
  list: (opts?: GitRunOptions) => Promise<WorktreeEntry[]>,
  opts?: GitRunOptions,
): Promise<WorktreesSnapshot> {
  const [entries, refs, remotes] = await Promise.all([
    list(opts),
    proc.run(["for-each-ref", REF_FACTS_FORMAT, "refs/heads", "refs/remotes"], { signal: opts?.signal }),
    proc.run(["remote"], { signal: opts?.signal }),
  ]);
  const facts = parseRefFacts(refs.code === 0 ? refs.stdout : "");
  const defaultBranch = defaultBranchOf(facts, entries);
  return {
    worktrees: summarize(entries, facts),
    remotes: remotes.code === 0 ? remotes.stdout.split("\n").map((r) => r.trim()).filter(Boolean) : [],
    ...(defaultBranch ? { defaultBranch } : {}),
  };
}

/** One uncommitted change in a worktree, as its row lists it. */
export interface WorktreeFileChange {
  path: string;
  /** Where a rename came from. */
  oldPath?: string;
  /** A/M/D/R/T — the letter the Changes view uses — "U" untracked, "!" conflicted. */
  status: string;
  /** Which side it is on: the index, the working tree, untracked, or unmerged. */
  area: "staged" | "unstaged" | "untracked" | "conflicted";
}

/** Tier 1: what one worktree's working tree holds, and what git is stopped in. */
export interface WorktreeStatus {
  files: WorktreeFileChange[];
  staged: number;
  unstaged: number;
  untracked: number;
  conflicted: number;
  /** Paths with any change — a file both staged and edited again counts once. */
  changed: number;
  /** What git is stopped in there; absent when nothing is. */
  operation?: StoppedOperation;
  /** Mid-rebase git lists the worktree detached: the branch being rebased,
   *  by the name under refs/heads/, read from the rebase's own head-name. */
  rebasing?: string;
  /**
   * With no upstream: its commits no remote has (as the push review counts
   * them), or — with no remote at all — its commits the default branch does
   * not have. Absent when it has an upstream (ahead says it) or when it is the
   * default branch itself with no remote.
   */
  unpublished?: number;
}

/** The commits a worktree has that nothing it pushes to has yet — its rule. */
export type UnpublishedRule =
  | { kind: "upstream"; upstream: string }
  | { kind: "remotes" }
  | { kind: "default"; ref: string }
  | { kind: "none" };

/**
 * Which commits count as not pushed for a worktree: `upstream..HEAD` with an
 * upstream; with none, those no remote has (`HEAD --not --remotes`, the push
 * review's count); with no remote at all, those the default branch lacks —
 * and none for the default branch itself.
 */
export function unpublishedRule(w: WorktreeSummary, snap: Pick<WorktreesSnapshot, "remotes" | "defaultBranch">): UnpublishedRule {
  if (w.bare || w.missing || w.unlinked) return { kind: "none" };
  if (w.upstream && !w.upstreamGone) return { kind: "upstream", upstream: w.upstream };
  if (snap.remotes.length > 0) return { kind: "remotes" };
  const d = snap.defaultBranch;
  if (!d || (w.branch !== undefined && `refs/heads/${w.branch}` === d.ref)) return { kind: "none" };
  return { kind: "default", ref: d.ref };
}

/** The `git log` / `rev-list` arguments that select a rule's commits. */
export function unpublishedRange(rule: UnpublishedRule): string[] | undefined {
  switch (rule.kind) {
    case "upstream":
      return [`${rule.upstream}..HEAD`];
    case "remotes":
      return ["HEAD", "--not", "--remotes"];
    case "default":
      return [`${rule.ref}..HEAD`];
    case "none":
      return undefined;
  }
}

/** Tier 1 for one worktree. */
export async function readWorktreeStatus(
  proc: GitProcess,
  w: WorktreeSummary,
  snap: Pick<WorktreesSnapshot, "remotes" | "defaultBranch">,
  opts?: GitRunOptions,
): Promise<WorktreeStatus | undefined> {
  if (w.bare || w.missing || w.unlinked) return undefined;
  // Checked again now, not only when the list was read: a linked worktree
  // whose .git went since would answer with the repository around it.
  if (!w.main && !existsSync(join(w.path, ".git"))) return undefined;
  const signal = opts?.signal;
  const rule = unpublishedRule(w, snap);
  // With an upstream, for-each-ref's `ahead` already counts them.
  const range = rule.kind === "upstream" ? undefined : unpublishedRange(rule);
  const [st, stop, count] = await Promise.all([
    proc.run(["-C", w.path, "status", "--porcelain=v2", "-z", "--untracked-files=all"], { signal }),
    stoppedIn(proc.at(w.path), signal),
    range ? proc.run(["-C", w.path, "rev-list", "--count", ...range], { signal }) : Promise.resolve(undefined),
  ]);
  const unpublished = count && count.code === 0 ? Number(count.stdout.trim()) || 0 : undefined;
  if (st.code !== 0) return undefined;
  const rebasing = stop?.operation === "rebase" && w.detached ? await rebasingBranch(proc, w.path, signal) : undefined;
  const parsed = parseV2(st.stdout);
  const files: WorktreeFileChange[] = [];
  for (const f of parsed.merge) files.push({ path: f.path, status: "!", area: "conflicted" });
  for (const f of parsed.staged) files.push({ path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, area: "staged" });
  for (const f of parsed.unstaged) {
    files.push(
      f.status === "U"
        ? { path: f.path, status: "U", area: "untracked" }
        : { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, area: "unstaged" },
    );
  }
  const inArea = (area: WorktreeFileChange["area"]) => files.filter((f) => f.area === area).length;
  return {
    files,
    staged: inArea("staged"),
    unstaged: inArea("unstaged"),
    untracked: inArea("untracked"),
    conflicted: inArea("conflicted"),
    changed: new Set(files.map((f) => f.path)).size,
    ...(stop?.operation ? { operation: stop.operation } : {}),
    ...(rebasing ? { rebasing } : {}),
    ...(unpublished !== undefined ? { unpublished } : {}),
  };
}

/** The branch a stopped rebase in the worktree at `path` is rebasing — from
 *  rebase-merge/ or rebase-apply/'s head-name, whichever backend it is. */
async function rebasingBranch(proc: GitProcess, path: string, signal?: AbortSignal): Promise<string | undefined> {
  const r = await proc.run(
    ["-C", path, "rev-parse", "--git-path", "rebase-merge/head-name", "--git-path", "rebase-apply/head-name"],
    { signal },
  );
  if (r.code !== 0) return undefined;
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      // Relative to the folder git ran in (-C), unless git answered absolute.
      const name = readFileSync(resolve(path, line.trim()), "utf8").trim();
      if (name.startsWith("refs/heads/")) return name.slice("refs/heads/".length);
    } catch {
      // Not this backend.
    }
  }
  return undefined;
}

/** One commit, as a worktree's (or the push review's) commit row shows it. */
export interface WorktreeCommit {
  sha: string;
  parents: string[];
  subject: string;
  author: string;
  /** Author date, seconds since the epoch. */
  date: number;
}

/**
 * Up to `limit` commits `git log <range>` selects, run in the worktree at
 * `path` (a range naming HEAD means ITS HEAD), newest first — plus whether
 * there were more.
 */
export async function readCommits(
  proc: GitProcess,
  path: string,
  range: string[],
  limit: number,
  opts?: GitRunOptions,
): Promise<{ commits: WorktreeCommit[]; more: boolean }> {
  const r = await proc.run(
    ["-C", path, "log", "--date-order", "-z", `--max-count=${limit + 1}`, "--format=%H%x1f%P%x1f%an%x1f%at%x1f%s", ...range],
    { signal: opts?.signal },
  );
  if (r.code !== 0) return { commits: [], more: false };
  const commits: WorktreeCommit[] = [];
  for (const rec of r.stdout.split("\0")) {
    const f = rec.replace(/^\n/, "").split("\x1f");
    if (f.length < 5 || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(f[0])) continue;
    commits.push({
      sha: f[0],
      parents: f[1].split(" ").filter(Boolean),
      author: f[2],
      date: Number(f[3]) || 0,
      subject: f.slice(4).join("\x1f") || l10n.t("(no message)"),
    });
  }
  return { commits: commits.slice(0, limit), more: commits.length > limit };
}
