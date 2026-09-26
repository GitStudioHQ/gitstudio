// Reset a local branch to its upstream — "make it 1:1 with origin" (#32).
//
// The request, in the user's words: "When having a messy branch, in IDEA you
// can checkout the same branch from origin and it throws everything local
// away and makes it 1:1 with origin." Here it is a verb on the branch's own
// menu, `Reset to 'origin/feature'…`, worded the way the VS Code extension
// words it. Three calls, because a person decides between the first two:
//
//   plan  — fetch that one branch from its remote, then say what resetting
//           would cost: the commits only on the local branch (with their
//           subjects), and for the checked-out branch how many files of
//           uncommitted changes go. Nothing is written but the remote-tracking
//           ref the fetch moves.
//   reset — run it, but only against the state the plan described. Both tips
//           travel back with the request; if either has moved, nothing runs,
//           because the confirm would have described a different loss.
//   undo  — put the tip back, and for the checked-out branch the uncommitted
//           changes too, from a `git stash create` taken just before.
//
// Every ref this WRITES is qualified or a sha: the checked-out branch resets
// with `git reset --hard <sha>`, any other moves with `git branch -f -- <name>
// <sha>` — whose `--` keeps a name from ever being read as an option, and
// which is git's own guard against moving a branch another worktree has
// checked out OR is rebasing (%(worktreepath) does not see the second; the
// test pins it). The fetch writes `+<remote ref>:refs/remotes/<remote>/<x>`.

import { lstat } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import type { GitContext } from "@gitstudio/git-service/index";
import type { OperationKind } from "@gitstudio/host-bridge/conflictsProtocol";
import type {
  BranchResetPlan,
  BranchResetRequest,
  BranchResetResult,
  BranchResetUndoRequest,
  CommitActionResult,
} from "../shared/ipc";

/** How many local-only commits the confirm names by subject. */
export const LOST_SUBJECTS = 5;

/** A commit id as rev-parse prints it — the only thing a reset or an undo
 *  hands git as a revision. */
const SHA = /^[0-9a-f]{7,64}$/i;

const US = "\x1f";

interface BranchFacts {
  /** refs/remotes/<remote>/<branch>, or "" when it tracks nothing. */
  upstreamRef: string;
  remote: string;
  /** The branch's name ON the remote (refs/heads/x). */
  remoteRef: string;
  /** Another worktree that has it checked out, or "". */
  worktree: string;
}

/** The branch's upstream and where it is checked out, or undefined when the
 *  branch does not exist. for-each-ref matches its pattern as a PREFIX (a
 *  pattern "refs/heads/feat" also lists refs/heads/feat/x), so the line is
 *  picked by its own refname. */
async function branchFacts(ctx: GitContext, fullName: string): Promise<BranchFacts | undefined> {
  const r = await ctx.process.run([
    "for-each-ref",
    `--format=%(refname)${US}%(upstream)${US}%(upstream:remotename)${US}%(upstream:remoteref)${US}%(worktreepath)`,
    fullName,
  ]);
  if (r.code !== 0) return undefined;
  for (const line of r.stdout.split("\n")) {
    const [ref, upstreamRef = "", remote = "", remoteRef = "", worktree = ""] = line.split(US);
    if (ref === fullName) return { upstreamRef, remote, remoteRef, worktree };
  }
  return undefined;
}

/** "origin/feature" — the upstream as a person reads it. Everything after
 *  refs/remotes/, so a remote named with a slash reads whole. */
export function upstreamLabel(upstreamRef: string): string {
  return upstreamRef.replace(/^refs\/remotes\//, "");
}

async function tip(ctx: GitContext, ref: string): Promise<string | undefined> {
  const r = await ctx.process.run(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
  const sha = r.stdout.trim();
  return r.code === 0 && SHA.test(sha) ? sha : undefined;
}

async function isCurrent(ctx: GitContext, fullName: string): Promise<boolean> {
  const r = await ctx.process.run(["symbolic-ref", "--quiet", "HEAD"]);
  return r.code === 0 && r.stdout.trim() === fullName;
}

async function count(ctx: GitContext, range: string): Promise<number> {
  const r = await ctx.process.run(["rev-list", "--count", range]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
}

/**
 * Tracked files with uncommitted changes — staged, unstaged, or both; a
 * staged new file counts, an untracked one does not. Porcelain v2 records a
 * change as a line starting "1 " (ordinary), "2 " (rename or copy, which
 * carries a second NUL-separated path) or "u " (unmerged).
 */
export function parseDirty(porcelainV2z: string): number {
  const parts = porcelainV2z.split("\0");
  let n = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.startsWith("1 ") || p.startsWith("u ")) n++;
    else if (p.startsWith("2 ")) {
      n++;
      i++; // the rename's original path
    }
  }
  return n;
}

async function dirtyCount(ctx: GitContext): Promise<number> {
  const r = await ctx.process.run(["status", "--porcelain=v2", "-z", "--untracked-files=no"]);
  return r.code === 0 ? parseDirty(r.stdout) : 0;
}

/** Is anything under `path` (the path itself, or a directory's contents) in
 *  the index? Literal, so a name with glob characters means itself. */
async function inIndex(ctx: GitContext, path: string): Promise<boolean> {
  const r = await ctx.process.run(["ls-files", "--cached", "-z", "--", `:(literal)${path}`]);
  return r.code === 0 && r.stdout.length > 0;
}

/** At most this many overwritten files are looked for — one is already
 *  enough to refuse, and the confirm names three. */
const COLLISIONS_CAP = 50;

/**
 * The files git is not tracking that `git reset --hard <to>` would overwrite.
 *
 * `reset --hard` leaves untracked files alone EXCEPT where the target has a
 * file of the same name — there it writes the target's version over it, with
 * no warning, and nothing (not the stash snapshot, which holds tracked
 * changes only) could bring it back. Measured against real git; see
 * test/branchReset.test.ts.
 *
 * The candidates are the target's paths the index does not have
 * (`diff-index --cached --diff-filter=D <to>`: present in the tree, absent
 * from the index). One of those that exists on disk is overwritten — as is a
 * file sitting where the target needs a directory (lstat answers ENOTDIR for
 * the path below it).
 */
export async function overwrittenUntracked(ctx: GitContext, to: string): Promise<string[]> {
  const r = await ctx.process.run([
    "diff-index",
    "--cached",
    "--name-only",
    "-z",
    "--no-renames",
    "--diff-filter=D",
    to,
    "--",
  ]);
  if (r.code !== 0) return [];
  const out: string[] = [];
  for (const path of r.stdout.split("\0").filter(Boolean)) {
    if (out.length >= COLLISIONS_CAP) break;
    const hit = await occupied(ctx, path);
    if (hit && !out.includes(hit)) out.push(hit);
  }
  return out;
}

async function occupied(ctx: GitContext, path: string): Promise<string | undefined> {
  try {
    const st = await lstat(join(ctx.root, path));
    // A directory is only in the way when nothing in it is tracked — a tracked
    // directory the target turns into a file is a tracked change, which the
    // snapshot holds.
    if (st.isDirectory() && (await inIndex(ctx, path))) return undefined;
    return path;
  } catch (e) {
    // POSIX answers ENOTDIR when a parent is a file; Windows answers ENOENT,
    // the same as for a path that simply isn't there. Either way, climb.
    const code = (e as NodeJS.ErrnoException)?.code;
    if (code !== "ENOTDIR" && code !== "ENOENT") return undefined;
  }
  // Something above it may be a FILE where the target needs a directory; the
  // first ancestor that exists decides.
  for (let up = dirname(path); up && up !== "."; up = dirname(up)) {
    try {
      const st = await lstat(join(ctx.root, up));
      if (st.isDirectory()) return undefined;
      return (await inIndex(ctx, up)) ? undefined : up;
    } catch {
      /* keep climbing */
    }
  }
  return undefined;
}

function operationName(kind: OperationKind): string {
  switch (kind) {
    case "merge":
      return "A merge is";
    case "rebase":
    case "rebase-merge-step":
      return "A rebase is";
    case "cherry-pick":
      return "A cherry-pick is";
    case "revert":
      return "A revert is";
    case "am":
      return "A patch series (git am) is";
    case "stash":
      return "A stash with conflicts is";
    default:
      return "An operation is";
  }
}

function refused(message: string): { ok: false; changed: false; expected: true; message: string } {
  return { ok: false, changed: false, expected: true, message };
}

function checkedOutElsewhere(name: string, where: string): string {
  return (
    // git spells a Windows path C:/Users/…; say it the way the system does.
    `'${name}' is checked out in the worktree at ${normalize(where)}. Reset it there, or switch that ` +
    `worktree to another branch first.`
  );
}

function dashName(name: string): string {
  return `git won't force-move a branch whose name starts with "-". Rename '${name}' first.`;
}

function firstLine(s: string): string {
  return (
    s
      .split("\n")
      .map((l) => l.replace(/^(fatal|error):\s*/i, "").trim())
      .find(Boolean) ?? ""
  );
}

function overwriteMessage(files: string[], label: string): string {
  const n = files.length;
  const shown = files.slice(0, 3).join(", ") + (n > 3 ? `, and ${n >= COLLISIONS_CAP ? "more" : `${n - 3} more`}` : "");
  const them = n === 1 ? "it" : "them";
  return (
    `Resetting would overwrite ${n === 1 ? "a file" : `${n >= COLLISIONS_CAP ? `${COLLISIONS_CAP} or more` : n} files`} ` +
    `git isn't tracking, which ${label} has too: ${shown}. Nothing could bring ${them} back, so ` +
    `nothing was changed — move or delete ${them} first.`
  );
}

/** Refusals shared by the plan and the reset, in the order they are cheap. */
async function blockers(
  ctx: GitContext,
  name: string,
  facts: BranchFacts,
  current: boolean,
): Promise<string | undefined> {
  if (current) {
    const op = await ctx.operation.detect().catch(() => ({ kind: "none" as OperationKind }));
    if (op.kind !== "none") {
      return `${operationName(op.kind)} in progress. Finish or abort it in Changes before resetting '${name}'.`;
    }
    return undefined;
  }
  if (facts.worktree) return checkedOutElsewhere(name, facts.worktree);
  if (name.startsWith("-")) return dashName(name);
  return undefined;
}

/**
 * Fetch the branch's upstream, then describe what resetting to it would cost.
 * `name` is the part of `fullName` under refs/heads/ — the caller has already
 * refused anything that is not a local branch's full name.
 */
export async function planBranchReset(
  ctx: GitContext,
  fullName: string,
  name: string,
): Promise<BranchResetPlan> {
  const facts = await branchFacts(ctx, fullName);
  if (!facts) return refused(`'${name}' no longer exists.`);
  if (!facts.upstreamRef.startsWith("refs/remotes/")) {
    return refused(`'${name}' doesn't track a branch on a remote, so there is nothing to reset it to.`);
  }
  const label = upstreamLabel(facts.upstreamRef);
  const current = await isCurrent(ctx, fullName);
  const blocked = await blockers(ctx, name, facts, current);
  if (blocked) return refused(blocked);

  // Fetch THIS branch, into its own remote-tracking ref: the question is "what
  // does origin have for it now", and a forced refspec follows a force-push.
  let fetchError: string | undefined;
  if (facts.remote && !facts.remote.startsWith("-") && facts.remoteRef.startsWith("refs/")) {
    const f = await ctx.process.run([
      "fetch",
      "--quiet",
      "--no-tags",
      "--",
      facts.remote,
      `+${facts.remoteRef}:${facts.upstreamRef}`,
    ]);
    if (f.code !== 0) {
      if (/couldn't find remote ref/i.test(f.stderr)) {
        return refused(`${label} no longer exists on ${facts.remote}, so there is nothing to reset '${name}' to.`);
      }
      fetchError = firstLine(f.stderr) || `the fetch from ${facts.remote} failed`;
    }
  } else {
    fetchError = `couldn't tell which remote ${label} comes from`;
  }

  const [from, to] = await Promise.all([tip(ctx, fullName), tip(ctx, facts.upstreamRef)]);
  if (!from) return refused(`'${name}' no longer exists.`);
  if (!to) {
    return refused(`There is no ${label} here to reset '${name}' to${fetchError ? ` — ${fetchError}` : ""}.`);
  }
  const [lost, gained, subjects, dirty, overwrites] = await Promise.all([
    count(ctx, `${to}..${from}`),
    count(ctx, `${from}..${to}`),
    ctx.process.run(["log", `-n${LOST_SUBJECTS}`, "--format=%s", `${to}..${from}`, "--"]),
    current ? dirtyCount(ctx) : Promise.resolve(0),
    current ? overwrittenUntracked(ctx, to) : Promise.resolve([] as string[]),
  ]);
  if (overwrites.length) return refused(overwriteMessage(overwrites, label));
  return {
    ok: true,
    branch: name,
    upstream: label,
    remote: facts.remote,
    current,
    from,
    to,
    lost,
    lostSubjects: subjects.code === 0 ? subjects.stdout.split("\n").filter((s) => s.length) : [],
    gained,
    ...(current ? { dirty } : {}),
    ...(fetchError ? { fetchError } : {}),
  };
}

/** Run the reset a plan described. */
export async function resetBranchToUpstream(
  ctx: GitContext,
  name: string,
  req: BranchResetRequest,
): Promise<BranchResetResult> {
  if (!SHA.test(req.from) || !SHA.test(req.to)) {
    return { ok: false, changed: false, message: "That value isn't a valid git reference." };
  }
  const facts = await branchFacts(ctx, req.fullName);
  if (!facts) return refused(`'${name}' no longer exists.`);
  if (!facts.upstreamRef.startsWith("refs/remotes/")) {
    return refused(`'${name}' doesn't track a branch on a remote any more — nothing was changed.`);
  }
  const label = upstreamLabel(facts.upstreamRef);
  const [from, to] = await Promise.all([tip(ctx, req.fullName), tip(ctx, facts.upstreamRef)]);
  if (from !== req.from || to !== req.to) {
    return refused(
      `'${name}' or ${label} moved after you were asked, so nothing was changed. ` +
        `Reset again to see what it would do now.`,
    );
  }
  const current = await isCurrent(ctx, req.fullName);
  const blocked = await blockers(ctx, name, facts, current);
  if (blocked) return refused(blocked);

  if (current) {
    const overwrites = await overwrittenUntracked(ctx, to);
    if (overwrites.length) return refused(overwriteMessage(overwrites, label));
    // The restore point. `stash create` writes objects only — no ref moves,
    // nothing on disk changes — and prints nothing when there is nothing to
    // keep. Without one there is no honest undo, so no reset either.
    const snap = await ctx.process.run(["stash", "create", `gitstudio: before resetting ${name} to ${label}`]);
    if (snap.code !== 0) {
      return {
        ok: false,
        changed: false,
        message: `Couldn't keep a copy of your uncommitted changes, so nothing was reset: ${firstLine(snap.stderr) || "git stash create failed"}`,
      };
    }
    const snapshot = snap.stdout.trim();
    const r = await ctx.process.run(["reset", "--hard", "--quiet", to]);
    if (r.code !== 0) {
      return { ok: false, changed: true, message: firstLine(r.stderr) || `Couldn't reset '${name}'.` };
    }
    return { ok: true, changed: true, was: from, current: true, ...(SHA.test(snapshot) ? { snapshot } : {}) };
  }

  const r = await ctx.process.run(["branch", "-f", "--", name, to]);
  if (r.code !== 0) return branchForceRefusal(name, r.stderr);
  return { ok: true, changed: true, was: from, current: false };
}

/** `git branch -f`'s refusal, said in words — "used by worktree at" covers a
 *  branch checked out there AND one being rebased there. */
function branchForceRefusal(name: string, stderr: string): CommitActionResult {
  const at = /used by worktree at '([^']+)'/.exec(stderr);
  if (at) {
    return refused(
      `'${name}' is in use in the worktree at ${at[1]} — checked out, or being rebased there. ` +
        `Nothing was changed.`,
    );
  }
  return { ok: false, changed: false, message: firstLine(stderr) || `Couldn't move '${name}'.` };
}

/** Put a reset back — only while nothing has happened on top of it. */
export async function undoBranchReset(
  ctx: GitContext,
  name: string,
  req: BranchResetUndoRequest,
): Promise<CommitActionResult> {
  if (!SHA.test(req.was) || !SHA.test(req.now) || (req.snapshot !== undefined && !SHA.test(req.snapshot))) {
    return { ok: false, changed: false, message: "That value isn't a valid git reference." };
  }
  const now = await tip(ctx, req.fullName);
  if (!now) return refused(`'${name}' no longer exists, so there is nothing to put back.`);
  if (now !== req.now) {
    return refused(`'${name}' has moved since the reset — undoing it now would throw that away, so nothing was changed.`);
  }
  if (req.current) {
    if (!(await isCurrent(ctx, req.fullName))) {
      return refused(`You're no longer on '${name}'. Switch back to it to undo the reset.`);
    }
    const op = await ctx.operation.detect().catch(() => ({ kind: "none" as OperationKind }));
    if (op.kind !== "none") return refused(`${operationName(op.kind)} in progress — finish or abort it first.`);
    if ((await dirtyCount(ctx)) > 0) {
      return refused("You've changed files since the reset. Commit or stash them, then undo.");
    }
    // --keep, not --hard: it refuses rather than overwrite a file git is not
    // tracking, and the tree is clean, so there is nothing else for it to keep.
    const k = await ctx.process.run(["reset", "--keep", "--quiet", req.was]);
    if (k.code !== 0) {
      return refused(`Couldn't put '${name}' back: ${firstLine(k.stderr) || "git refused"}. Nothing was changed.`);
    }
    if (req.snapshot) {
      const a = await ctx.process.run(["stash", "apply", "--index", "--quiet", req.snapshot]);
      if (a.code !== 0) {
        return {
          ok: false,
          changed: true,
          message:
            `'${name}' is back where it was, but your uncommitted changes couldn't be put back ` +
            `(${firstLine(a.stderr) || "git stash apply failed"}). They are kept in ${req.snapshot} — ` +
            `\`git stash apply ${req.snapshot}\` brings them back.`,
        };
      }
    }
    return { ok: true, changed: true };
  }
  const facts = await branchFacts(ctx, req.fullName);
  if (facts?.worktree) return refused(checkedOutElsewhere(name, facts.worktree));
  if (name.startsWith("-")) return refused(dashName(name));
  const r = await ctx.process.run(["branch", "-f", "--", name, req.was]);
  if (r.code !== 0) return branchForceRefusal(name, r.stderr);
  return { ok: true, changed: true };
}
