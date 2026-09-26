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

async function revParse(proc: GitProcess, rev: string, signal?: AbortSignal): Promise<string | undefined> {
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
async function isPublished(proc: GitProcess, sha: string, signal?: AbortSignal): Promise<boolean> {
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
export const DROP_DIRTY_MESSAGE = "You have uncommitted changes. Commit or stash them, then drop the commit.";

/**
 * What stops a drop from starting right now — said BEFORE the confirmation,
 * so nobody agrees to rewrite history only to be told no.
 *
 * An operation git is stopped in (a merge, a rebase, a pick, a revert, `git
 * am`, files left unmerged), in the words every other door uses; or changes
 * to tracked files, which git refuses a rebase over. Untracked files do not
 * stop a rebase and do not stop this. Undefined when the drop can go ahead.
 */
export async function dropBlocker(proc: GitProcess, signal?: AbortSignal): Promise<string | undefined> {
  const stop = await stoppedIn(proc, signal);
  if (stop) {
    return operationInTheWayMessage({ ...pick(stop), kind: "drop" });
  }
  const status = await proc.run(
    ["status", "--porcelain=v1", "-z", "--untracked-files=no", "--ignore-submodules=all"],
    { signal },
  );
  if (status.code === 0 && status.stdout.length > 0) {
    return DROP_DIRTY_MESSAGE;
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

/** How a drop ended, plus the two tips a host needs to offer its undo. */
export type DropOutcome = RebaseOutcome & {
  /** HEAD before the drop. */
  before?: string;
  /** HEAD after a drop that finished. */
  after?: string;
};

/** The refusal for a confirmation that went stale. */
export const DROP_MOVED_MESSAGE =
  "The branch has moved since you chose Drop, so nothing was dropped. Look at the history again and retry.";

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
  const outcome = await run({ base: plan.base, todo: built.todo, rewords: built.rewords });
  const after = outcome.status === "done" ? await revParse(proc, "HEAD") : undefined;
  return { ...outcome, before: plan.head, ...(after ? { after } : {}) };
}

/**
 * Put the branch back where it was before a drop: HEAD moves from `after` to
 * `before` with `reset --keep`, so uncommitted work made since is kept, or the
 * reset refuses rather than overwrite it.
 *
 * Only while HEAD is still exactly where the drop left it. If anything has
 * moved it since, going back would throw that away too, so this says so and
 * changes nothing.
 */
export async function undoDrop(
  proc: GitProcess,
  u: { before: string; after: string },
): Promise<{ ok: true } | { ok: false; expected?: true; message: string }> {
  if (!/^[0-9a-f]{40,64}$/i.test(u.before) || !/^[0-9a-f]{40,64}$/i.test(u.after)) {
    // The renderer only ever sends the two shas a drop answered with.
    return { ok: false, message: "That isn't a drop this app made." };
  }
  const head = await revParse(proc, "HEAD");
  if (head !== u.after) {
    return {
      ok: false,
      expected: true,
      message: "The branch has moved since the drop, so undoing it now would throw that away too. Nothing was changed.",
    };
  }
  const stop = await stoppedIn(proc);
  if (stop) {
    return { ok: false, expected: true, message: operationInTheWayMessage({ ...pick(stop), kind: "reset" }) };
  }
  const r = await proc.run(["reset", "--keep", u.before]);
  if (r.code === 0) {
    return { ok: true };
  }
  const status = await proc.run(["status", "--porcelain=v1", "-z", "--untracked-files=no"]);
  if (status.code === 0 && status.stdout.length > 0) {
    return {
      ok: false,
      expected: true,
      message: "Your uncommitted changes touch files the drop changed. Commit or stash them, then undo.",
    };
  }
  return { ok: false, message: r.stderr.trim() || "Couldn't put the branch back." };
}
