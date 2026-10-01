import type { GitProcess } from "./GitProcess";
import type { ChainCommit } from "@gitstudio/engine/rebase/chain";
import {
  dropRefusalMessage,
  dropTarget,
  type DropRefusal,
  type DropSummary,
} from "@gitstudio/engine/rebase/drop";
import { buildRebasePlan, type RebasePlanRow } from "./rebasePlan";
import type { RebaseOutcome, RebasePlan } from "./RebaseRunner";
import { operationInTheWayMessage, pick, stoppedIn } from "./stoppedOperation";
import {
  branchShort,
  headBranch,
  isBranchRef,
  putRefBack,
  whyRefsNotRestorable,
  type RefMove,
} from "./refRestore";
import * as l10n from "@vscode/l10n";

// Drop Commit (issue #32), for both products.
//
// Dropping a commit is the drag-to-reorder pipeline with that one commit set to
// `drop`: the first-parent chain from HEAD (engine/rebase/drop.ts decides what
// may be dropped), `buildRebasePlan` for the todo, `runRebasePlan` to run it.
// This module is the git half — reading the chain, the checks a drop owes the
// user before it rewrites anything — so the extension's graph menu and the
// desktop's do the same thing. The words (the question, how it ended) are the
// engine's, pure, so the desktop's renderer can say them too. Each host brings
// only its own dialogs, its own runner binding and its own undo.

/**
 * How many later commits one Drop Commit will replay. It bounds the walk the
 * menu does on every right-click; a commit further down than this is not
 * offered (the reorder chain caps at the same 500 for the same reason).
 */
export const DROP_MAX_REPLAY = 500;

/** A drop that can run: what it removes, what it replays, and onto what. */
export interface DropPlan extends DropSummary {
  ok: true;
  /** The dropped commit, full sha. */
  sha: string;
  /** HEAD when this was planned — the run refuses if it has moved since. */
  head: string;
  /** What the rebase runs onto: the dropped commit's parent, or "--root". */
  base: string;
  /** The todo's rows in display order (newest first); the last one is the drop. */
  rows: RebasePlanRow[];
  /**
   * Other local branches pointing at a commit that is replayed. Left alone,
   * they keep pointing at the old commits; carried, they follow the rewrite
   * (`update-ref`). The branch being rebased is never listed — git moves it
   * itself, and naming it makes the rebase fail ("cannot lock ref").
   */
  carryable: string[];
}

/** Why a commit cannot be dropped, in the engine's terms and in words. */
export interface DropRefused {
  ok: false;
  reason: DropRefusal;
  message: string;
}

export type DropPlanResult = DropPlan | DropRefused;

function refused(reason: DropRefusal): DropRefused {
  return { ok: false, reason, message: dropRefusalMessage(reason) };
}

export async function revParse(proc: GitProcess, rev: string, signal?: AbortSignal): Promise<string | undefined> {
  // `rev` is always "HEAD" or a validated hex sha, never user text.
  const r = await proc.run(["rev-parse", "--verify", "--quiet", rev], { signal });
  const out = r.stdout.trim();
  return r.code === 0 && out ? out : undefined;
}

/**
 * Is `sha` on any remote-tracking branch? Asked the way the reorder chain asks
 * it (`--not --remotes`), so "published" means the same thing at both doors:
 * the commit is listed only when no remote-tracking ref reaches it.
 */
export async function isPublished(proc: GitProcess, sha: string, signal?: AbortSignal): Promise<boolean> {
  const r = await proc.run(["rev-list", "--max-count=1", sha, "--not", "--remotes"], { signal });
  return r.code === 0 && r.stdout.trim() === "";
}

/**
 * Plan dropping `sha` from the current branch — or say why it can't be.
 *
 * Cheap enough for every right-click: an ancestry check answers the common
 * "not on this branch" without a walk, and the walk is bounded.
 */
export async function planDropCommit(
  proc: GitProcess,
  sha: string,
  opts: { signal?: AbortSignal; maxReplay?: number } = {},
): Promise<DropPlanResult> {
  const { signal } = opts;
  const maxReplay = opts.maxReplay ?? DROP_MAX_REPLAY;
  // Everything below puts this into argv; a sha is hex and nothing else.
  if (!/^[0-9a-fA-F]{4,64}$/.test(sha)) {
    return refused("not-on-branch");
  }
  const [full, head] = await Promise.all([
    revParse(proc, `${sha}^{commit}`, signal),
    revParse(proc, "HEAD", signal),
  ]);
  if (!full || !head) {
    return refused("not-on-branch"); // an unknown commit, or an unborn branch
  }
  const ancestor = await proc.run(["merge-base", "--is-ancestor", full, head], { signal });
  if (ancestor.code !== 0) {
    return refused("not-on-branch");
  }

  // One commit per line: "<sha> <parents…>\x1f<subject>". One more than the
  // replay limit, because the dropped commit itself is in the walk.
  const walk = await proc.run(
    [
      "rev-list",
      "--first-parent",
      `--max-count=${maxReplay + 1}`,
      "--no-commit-header",
      "--format=%H %P%x1f%s",
      head,
    ],
    { signal },
  );
  if (walk.code !== 0) {
    return refused("not-on-branch");
  }
  const commits: ChainCommit[] = [];
  const subjects = new Map<string, string>();
  for (const line of walk.stdout.split("\n")) {
    if (!line.trim()) continue;
    const cut = line.indexOf("\x1f");
    const ids = (cut < 0 ? line : line.slice(0, cut)).trim().split(" ").filter(Boolean);
    const [id, ...parents] = ids;
    if (!id) continue;
    commits.push({ sha: id, parents });
    subjects.set(id, cut < 0 ? "" : line.slice(cut + 1));
  }
  const last = commits[commits.length - 1];
  const capped = commits.length >= maxReplay + 1 && !!last && last.parents.length > 0;
  const target = dropTarget(commits, full, { capped });
  if (!target.ok) {
    return refused(target.reason);
  }

  const [published, symbolic, heads] = await Promise.all([
    isPublished(proc, full, signal),
    proc.run(["symbolic-ref", "--quiet", "HEAD"], { signal }),
    target.later.length > 0
      ? proc.run(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"], { signal })
      : Promise.resolve(undefined),
  ]);
  // The full name, compared as such: a tag or a remote named like the branch
  // must not make it look like some other ref.
  const currentRef = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  const branch = currentRef.startsWith("refs/heads/") ? currentRef.slice("refs/heads/".length) : null;

  const replayed = new Set(target.later);
  const tips = new Map<string, string[]>();
  for (const line of heads?.code === 0 ? heads.stdout.split("\n") : []) {
    const at = line.indexOf(" ");
    if (at < 0) continue;
    const tip = line.slice(0, at);
    const ref = line.slice(at + 1).trim();
    if (!replayed.has(tip) || ref === currentRef || !ref.startsWith("refs/heads/")) continue;
    tips.set(tip, [...(tips.get(tip) ?? []), ref.slice("refs/heads/".length)]);
  }

  const rows: RebasePlanRow[] = [
    ...target.later.map((s) => ({
      sha: s,
      action: "pick",
      subject: subjects.get(s) ?? "",
      ...(tips.has(s) ? { branches: tips.get(s) } : {}),
    })),
    { sha: full, action: "drop", subject: subjects.get(full) ?? "" },
  ];
  return {
    ok: true,
    sha: full,
    shortSha: full.slice(0, 7),
    subject: subjects.get(full) ?? "",
    head,
    base: target.base ?? "--root",
    rows,
    replayed: target.later.length,
    published,
    branch,
    carryable: target.later.flatMap((s) => tips.get(s) ?? []),
  };
}

/** The dirty-tree refusal, in the runner's own words for the same state. */
export const DROP_DIRTY_MESSAGE = l10n.t("You have uncommitted changes. Commit or stash them, then drop the commit.");

/**
 * What stops a drop from starting right now — said BEFORE the confirmation,
 * so nobody agrees to rewrite history only to be told no.
 *
 * An operation git is stopped in (a merge, a rebase, a pick, a revert, `git
 * am`, files left unmerged), in the words every other door uses; or changes
 * to tracked files, which git refuses a rebase over. Untracked files do not
 * stop a rebase and do not stop this. Undefined when the drop can go ahead.
 */
export function dropBlocker(proc: GitProcess, signal?: AbortSignal): Promise<string | undefined> {
  return rewriteBlocker(proc, "drop", DROP_DIRTY_MESSAGE, signal);
}

/**
 * dropBlocker's check for any rewrite of the current branch (issue #32: Drop
 * and Squash of several commits too) — `door` names it in the stop's
 * sentence, `dirty` is what is said over uncommitted changes.
 */
export async function rewriteBlocker(
  proc: GitProcess,
  door: "drop" | "drop-many" | "squash",
  dirty: string,
  signal?: AbortSignal,
): Promise<string | undefined> {
  const stop = await stoppedIn(proc, signal);
  if (stop) {
    return operationInTheWayMessage({ ...pick(stop), kind: door });
  }
  const status = await proc.run(
    ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=all"],
    { signal },
  );
  if (status.code === 0 && status.stdout.length > 0) {
    return dirty;
  }
  return undefined;
}

/** What a host sends to run a drop it has confirmed. */
export interface DropRequest {
  /** The commit, as the confirmed plan named it. */
  sha: string;
  /** HEAD as the confirmed plan saw it. */
  head: string;
  /** Carry `carryable` along with the rewrite. */
  carry?: boolean;
}

/**
 * A branch a rewrite carried along (`update-ref` in the todo): where it
 * pointed before, and where the rewrite left it. The undo puts each one back —
 * the question that offered to carry them says "Undo is available afterwards",
 * and resetting HEAD alone left them on the rewritten commits.
 */
export interface CarriedBranch {
  /** The branch's short name: refs/heads/<branch>. */
  branch: string;
  before: string;
  after: string;
}

/** How a drop ended, plus what a host needs to offer its undo. */
export type DropOutcome = RebaseOutcome & {
  /** HEAD before the drop. */
  before?: string;
  /** HEAD after a drop that finished. */
  after?: string;
  /**
   * The branch the drop rewrote, by full name — null when HEAD was detached.
   * An undo puts THIS branch back: HEAD's commit alone can't say which branch
   * it was, and a branch made at the new tip since shares it.
   */
  branch?: string | null;
  /** The other branches it carried, when it was asked to; absent otherwise. */
  carried?: CarriedBranch[];
};

/**
 * Where the branches on `rows` went, once a rewrite that carried them has
 * finished: each is read again, and one the rewrite did not move is left out.
 * `rows` are the plan the rewrite ran, so each branch's row is where it was.
 */
export async function carriedBranches(proc: GitProcess, rows: readonly RebasePlanRow[]): Promise<CarriedBranch[]> {
  const out: CarriedBranch[] = [];
  for (const row of rows) {
    for (const branch of row.branches ?? []) {
      // A name for-each-ref gave the plan, under refs/heads/: never an option.
      const after = await revParse(proc, `refs/heads/${branch}`);
      if (after && after !== row.sha) out.push({ branch, before: row.sha, after });
    }
  }
  return out;
}

/** The refusal for a confirmation that went stale. */
export const DROP_MOVED_MESSAGE =
  l10n.t("The branch has moved since you chose Drop, so nothing was dropped. Look at the history again and retry.");

/**
 * Run a confirmed drop through the host's rebase runner.
 *
 * Nothing the confirmation saw is trusted: the plan is read again from git,
 * and HEAD must be where it was when the user said yes. A commit landing, a
 * pull or an amend in between changes what "the commits after it" means, and
 * this refuses rather than replaying something nobody was shown.
 */
export async function dropCommit(
  proc: GitProcess,
  req: DropRequest,
  run: (plan: RebasePlan) => Promise<RebaseOutcome>,
): Promise<DropOutcome> {
  const plan = await planDropCommit(proc, req.sha);
  if (!plan.ok) {
    return { status: "failed", expected: true, message: plan.message };
  }
  if (plan.head !== req.head) {
    return { status: "failed", expected: true, message: DROP_MOVED_MESSAGE };
  }
  const blocked = await dropBlocker(proc);
  if (blocked) {
    return { status: "failed", expected: true, message: blocked };
  }
  const built = buildRebasePlan(plan.rows, { updateRefs: !!req.carry, allowDropAll: true });
  if (!built.ok) {
    // Every row here is one this module wrote, so a refusal is ours: reported.
    return { status: "failed", message: built.message };
  }
  const branch = plan.branch ? `refs/heads/${plan.branch}` : null;
  const outcome = await run({ base: plan.base, todo: built.todo, rewords: built.rewords });
  const after = outcome.status === "done" ? await revParse(proc, "HEAD") : undefined;
  const carried = after && req.carry ? await carriedBranches(proc, plan.rows) : [];
  return {
    ...outcome,
    before: plan.head,
    ...(after ? { after } : {}),
    ...(outcome.status === "done" ? { branch } : {}),
    ...(carried.length ? { carried } : {}),
  };
}

const FULL_SHA = /^[0-9a-f]{40,64}$/i;

/**
 * A branch name as for-each-ref gave the plan one — what an undo request may
 * name. Nothing git would read as an option or a revision expression, and no
 * whitespace or control character; git's own check-ref-format has the rest,
 * at update-ref.
 */
function plainBranchName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    !name.startsWith("-") &&
    !name.includes("..") &&
    !name.includes("@{") &&
    // eslint-disable-next-line no-control-regex
    !/[\s\x00-\x1f\x7f~^:?*[\\]/.test(name)
  );
}

/** Carried branches exactly as an outcome handed them out: plain names, full shas. */
function validCarried(carried: unknown): carried is readonly CarriedBranch[] {
  return (
    Array.isArray(carried) &&
    carried.every(
      (c: Partial<CarriedBranch> | undefined) =>
        plainBranchName(c?.branch) && FULL_SHA.test(String(c?.before)) && FULL_SHA.test(String(c?.after)),
    )
  );
}

/** A carried branch as refRestore moves it: by full name. */
function carriedMove(c: CarriedBranch): RefMove {
  return { ref: `refs/heads/${c.branch}`, before: c.before, after: c.after };
}

/**
 * Put the branch back where it was before a drop: from `after` to `before`
 * with `reset --keep` where it is checked out, so uncommitted work made since
 * is kept, or the reset refuses rather than overwrite it — and the branches
 * the drop carried along back too.
 *
 * Only while each is still exactly where the drop left it. If anything has
 * moved one since, going back would throw that away too, so this says so and
 * changes nothing. With `branch` the drop's OWN branch is the one moved:
 * checking HEAD's commit alone reset whichever branch HEAD was on — one made
 * and checked out at the new tip after the drop, left the dropped branch
 * dropped, and reported success. Without it (a caller that predates it), HEAD
 * is put back as undoRewrite does.
 */
export async function undoDrop(
  proc: GitProcess,
  u: {
    before: string;
    after: string;
    /** The branch the drop rewrote (DropOutcome.branch); null: HEAD was detached. */
    branch?: string | null;
    /** The branches it carried (DropOutcome.carried). */
    carried?: readonly CarriedBranch[];
  },
): Promise<{ ok: true } | { ok: false; expected?: true; message: string }> {
  const carried = u.carried ?? [];
  if (
    !FULL_SHA.test(u.before) ||
    !FULL_SHA.test(u.after) ||
    !validCarried(carried) ||
    (u.branch !== undefined && u.branch !== null && !isBranchRef(u.branch))
  ) {
    // The renderer only ever sends what a drop answered with.
    return { ok: false, message: l10n.t("That isn't a drop this app made.") };
  }
  if (u.branch) {
    return undoOnBranch(proc, { before: u.before, after: u.after, branch: u.branch, carried: carried.map(carriedMove) }, "drop");
  }
  if (u.branch === null && (await headBranch(proc))) {
    // Detached when dropped. A branch made and checked out at the new tip has
    // the same commit, and resetting it would move a branch the drop never
    // touched.
    return {
      ok: false,
      expected: true,
      message: l10n.t("HEAD was detached when the commit was dropped, and it's on a branch now. Detach it again, then undo."),
    };
  }
  return undoRewrite(proc, { before: u.before, after: u.after, carried }, "drop");
}

/**
 * Undo a rewrite (`what`: a drop, a squash…) of `branch`: put THAT branch
 * back — and the ones it carried — each only while it is still where the
 * rewrite left it. The branch moves with `reset --keep` when it is checked
 * out here (its files move too, uncommitted work is kept or the reset
 * refuses), and with a compare-and-swap `update-ref` when it isn't — so a
 * branch made and checked out at the new tip since stays exactly where it is.
 */
async function undoOnBranch(
  proc: GitProcess,
  u: { before: string; after: string; branch: string; carried: readonly RefMove[] },
  what: string,
): Promise<{ ok: true } | { ok: false; expected?: true; message: string }> {
  const own: RefMove = { ref: u.branch, before: u.before, after: u.after };
  const why = await whyRefsNotRestorable(proc, [own, ...u.carried], `the ${what}`);
  if (why) {
    return { ok: false, expected: true, message: why };
  }
  const here = (await headBranch(proc)) === u.branch;
  if (here) {
    const stop = await stoppedIn(proc);
    if (stop) {
      return { ok: false, expected: true, message: operationInTheWayMessage({ ...pick(stop), kind: "reset" }) };
    }
  }
  const reflog = undoReflog(what);
  try {
    await putRefBack(proc, own, reflog, { here });
  } catch (err) {
    return here ? keepRefused(proc, err instanceof Error ? err.message : String(err), what) : { ok: false, message: String(err instanceof Error ? err.message : err) };
  }
  return putCarriedBack(proc, u.carried, what, reflog);
}

/** The reflog entry an undo of `what` writes on each branch it puts back. */
function undoReflog(what: string): string {
  // English on purpose: a reflog entry, stored in the repository itself.
  return what === "drop" ? "GitStudio undo: drop commit" : `GitStudio undo: ${what}`;
}

/** The carried branches back, each by compare-and-swap. */
async function putCarriedBack(
  proc: GitProcess,
  carried: readonly RefMove[],
  what: string,
  reflog: string,
): Promise<{ ok: true } | { ok: false; expected?: true; message: string }> {
  const head = await headBranch(proc);
  for (const m of carried) {
    try {
      await putRefBack(proc, m, reflog, { here: head === m.ref });
    } catch (err) {
      const back = what === "drop" ? l10n.t("The dropped commit is back") : l10n.t("The branch is back");
      return { ok: false, message: l10n.t("{0}, but {1} isn't: {2}", back, branchShort(m.ref), err instanceof Error ? err.message : String(err)) };
    }
  }
  return { ok: true };
}

/** `reset --keep` refused: over the user's changes (said as such), or for a reason of git's. */
async function keepRefused(proc: GitProcess, stderr: string, what: string): Promise<{ ok: false; expected?: true; message: string }> {
  const status = await proc.run(["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  if (status.code === 0 && status.stdout.length > 0) {
    return {
      ok: false,
      expected: true,
      message: l10n.t("Your uncommitted changes touch files the {0} changed. Commit or stash them, then undo.", what),
    };
  }
  return { ok: false, message: stderr.trim() || l10n.t("Couldn't put the branch back.") };
}

/**
 * The same way back for any operation that moved HEAD from `before` to
 * `after` on the branch it is on — a drop, a squash, several commits
 * cherry-picked or reverted (issue #32). `what` names it in the words: "the
 * branch has moved since the squash".
 *
 * With `branch` (the rewrite's own, as rewriteMany names it) THAT branch goes
 * back, as undoDrop's does: HEAD's commit alone can't say which branch it was,
 * and one made and checked out at the new tip since shares it. Without it,
 * HEAD's branch goes back from `after`.
 *
 * `carried` are the other branches the rewrite moved along with it: each goes
 * back too, and only while it is still where the rewrite left it — checked
 * for every one before anything moves, so a refusal changes nothing.
 */
export async function undoRewrite(
  proc: GitProcess,
  u: { before: string; after: string; branch?: string | null; carried?: readonly CarriedBranch[] },
  what: string,
): Promise<{ ok: true } | { ok: false; expected?: true; message: string }> {
  const carried = u.carried ?? [];
  if (
    !FULL_SHA.test(u.before) ||
    !FULL_SHA.test(u.after) ||
    !validCarried(carried) ||
    (u.branch !== undefined && u.branch !== null && !isBranchRef(u.branch))
  ) {
    // The renderer only ever sends the tips the operation answered with.
    return { ok: false, message: l10n.t("That isn't a {0} this app made.", what) };
  }
  if (u.branch) {
    return undoOnBranch(proc, { before: u.before, after: u.after, branch: u.branch, carried: carried.map(carriedMove) }, what);
  }
  if (u.branch === null && (await headBranch(proc))) {
    // Detached when it ran: a branch made and checked out at the new tip has
    // the same commit, and resetting it would move a branch the rewrite never
    // touched.
    return {
      ok: false,
      expected: true,
      message: l10n.t("HEAD was detached when the {0} ran, and it's on a branch now. Detach it again, then undo.", what),
    };
  }
  const head = await revParse(proc, "HEAD");
  if (head !== u.after) {
    return {
      ok: false,
      expected: true,
      message: l10n.t("The branch has moved since the {0}, so undoing it now would throw that away too. Nothing was changed.", what),
    };
  }
  // The carried branches through the same checks and the same way back as
  // undoOnBranch's — every one checked before anything moves.
  const moves = carried.map(carriedMove);
  const why = await whyRefsNotRestorable(proc, moves, `the ${what}`);
  if (why) {
    return { ok: false, expected: true, message: why };
  }
  const stop = await stoppedIn(proc);
  if (stop) {
    return { ok: false, expected: true, message: operationInTheWayMessage({ ...pick(stop), kind: "reset" }) };
  }
  const r = await proc.run(["reset", "--keep", u.before]);
  if (r.code !== 0) {
    return keepRefused(proc, r.stderr, what);
  }
  return putCarriedBack(proc, moves, what, undoReflog(what));
}
