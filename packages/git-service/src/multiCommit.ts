import type { GitProcess } from "./GitProcess";
import type { ChainCommit } from "@gitstudio/engine/rebase/chain";
import {
  dropManyTarget,
  manyRefusalMessage,
  squashMessage,
  squashTarget,
  type ManyRefusal,
  type ManySummary,
  type ManyTarget,
} from "@gitstudio/engine/rebase/many";
import { buildRebasePlan, type RebasePlanRow } from "./rebasePlan";
import type { RebaseOutcome, RebasePlan } from "./RebaseRunner";
import { DROP_MAX_REPLAY, carriedBranches, isPublished, revParse, rewriteBlocker, type DropOutcome } from "./dropCommit";

// Several commits at once, for both products (issue #32): the graph's and the
// Commits list's multi-selection menu.
//
//   · Drop N Commits… and Squash N Commits… rewrite the current branch. They
//     are Drop Commit's pipeline (dropCommit.ts) with several rows changed:
//     the first-parent line from HEAD, the engine's rule for what may be
//     rewritten (engine/rebase/many.ts), `buildRebasePlan` for the todo and
//     the host's rebase runner to run it. A squash is `reword` on the oldest
//     selected commit — with the message the user edited — and `fixup` on the
//     rest, so git asks for one message and it is the one the user wrote.
//   · Cherry-Pick N and Revert N are ONE git command over all of them, oldest
//     first and newest first; `orderCommits` asks git for the order. They run
//     through each host's commit-applying door (changesInTheWay.ts), which
//     knows a multi-commit op (`commits`) and asks about uncommitted changes
//     in the way BEFORE git starts, since a refusal half-way leaves some
//     commits applied.
//
// Words are the engine's; each host brings its dialogs, runner and undo.

/** A full sha, or a prefix of one — what a webview may send. Nothing else reaches argv. */
const HEX = /^[0-9a-fA-F]{4,64}$/;

/** A rewrite of several commits that can run. */
export interface ManyPlan extends ManySummary {
  ok: true;
  verb: "drop" | "squash";
  /** The selected commits, full shas, newest first along the branch. */
  shas: string[];
  /** HEAD when planned — the run refuses if it has moved since. */
  head: string;
  /** What the rebase runs onto, or "--root". */
  base: string;
  /** The todo's rows, newest first (display order). */
  rows: RebasePlanRow[];
  /** Other local branches on a rewritten commit — the carry question. */
  carryable: string[];
  /** Squash: the pre-filled message — every message in full, oldest first. */
  message?: string;
}

/** Why several commits cannot be rewritten together, in the engine's terms and in words. */
export interface ManyRefused {
  ok: false;
  reason: ManyRefusal;
  message: string;
}

export type ManyPlanResult = ManyPlan | ManyRefused;

/** What a host sends to run a rewrite it has confirmed. */
export interface ManyRequest {
  /** The commits as the confirmed plan named them. */
  shas: string[];
  /** HEAD as the confirmed plan saw it. */
  head: string;
  /** Carry `carryable` along with the rewrite. */
  carry?: boolean;
  /** Squash: the squashed commit's message. */
  message?: string;
}

/** The dirty-tree refusals, in the runner's own words for the same state. */
export const DROP_MANY_DIRTY_MESSAGE = "You have uncommitted changes. Commit or stash them, then drop the commits.";
export const SQUASH_DIRTY_MESSAGE = "You have uncommitted changes. Commit or stash them, then squash the commits.";

/** A confirmation that went stale. */
export const MANY_MOVED_MESSAGE =
  "The branch has moved since you chose these commits, so nothing was changed. Look at the history again and retry.";

/** Squash was confirmed with no message. */
export const SQUASH_EMPTY_MESSAGE = "The squashed commit needs a message.";

function refused(reason: ManyRefusal, verb: "drop" | "squash"): ManyRefused {
  return { ok: false, reason, message: manyRefusalMessage(reason, verb) };
}

/** Every sha, resolved to its full commit, or undefined if any is not one. */
async function resolveAll(proc: GitProcess, shas: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
  // Hex only: a value that is not one never reaches argv, so none can be an option.
  if (shas.length === 0 || !shas.every((s) => HEX.test(s))) return undefined;
  const resolved = await Promise.all(shas.map((s) => revParse(proc, `${s}^{commit}`, signal)));
  if (resolved.some((r) => !r)) return undefined;
  return [...new Set(resolved as string[])];
}

interface Walked {
  commits: ChainCommit[];
  messages: Map<string, { subject: string; body: string }>;
  capped: boolean;
}

/** HEAD's first-parent line with each commit's message, newest first, bounded. */
async function walkFirstParent(proc: GitProcess, head: string, maxReplay: number, signal?: AbortSignal): Promise<Walked | undefined> {
  // One record per commit: "<sha> <parents…>\x1f<subject>\x1f<body>\x1e".
  // The body can hold newlines, so records end with a record separator.
  const walk = await proc.run(
    [
      "rev-list",
      "--first-parent",
      `--max-count=${maxReplay + 1}`,
      "--no-commit-header",
      "--format=%H %P%x1f%s%x1f%b%x1e",
      head,
    ],
    { signal },
  );
  if (walk.code !== 0) return undefined;
  const commits: ChainCommit[] = [];
  const messages = new Map<string, { subject: string; body: string }>();
  for (const raw of walk.stdout.split("\x1e")) {
    const rec = raw.replace(/^\n+/, "");
    if (!rec.trim()) continue;
    const [ids = "", subject = "", body = ""] = rec.split("\x1f");
    const [id, ...parents] = ids.trim().split(" ").filter(Boolean);
    if (!id) continue;
    commits.push({ sha: id, parents });
    messages.set(id, { subject, body });
  }
  const last = commits[commits.length - 1];
  const capped = commits.length >= maxReplay + 1 && !!last && last.parents.length > 0;
  return { commits, messages, capped };
}

/**
 * Plan dropping or squashing `shas` on the current branch — or say why not.
 * Cheap enough for every right-click: one resolve, one bounded walk.
 */
export async function planMany(
  proc: GitProcess,
  verb: "drop" | "squash",
  shas: readonly string[],
  opts: { signal?: AbortSignal; maxReplay?: number } = {},
): Promise<ManyPlanResult> {
  const { signal } = opts;
  const maxReplay = opts.maxReplay ?? DROP_MAX_REPLAY;
  if (verb === "squash" && new Set(shas).size < 2) return refused("too-few", verb);
  const [full, head] = await Promise.all([resolveAll(proc, shas, signal), revParse(proc, "HEAD", signal)]);
  if (!full || !head) return refused("not-on-branch", verb);
  if (verb === "squash" && full.length < 2) return refused("too-few", verb);

  const walked = await walkFirstParent(proc, head, maxReplay, signal);
  if (!walked) return refused("not-on-branch", verb);
  const target: ManyTarget =
    verb === "drop"
      ? dropManyTarget(walked.commits, full, { capped: walked.capped })
      : squashTarget(walked.commits, full, { capped: walked.capped });
  if (!target.ok) return refused(target.reason, verb);

  const selected = target.rows.filter((r) => r.selected).map((r) => r.sha);
  const oldest = selected[selected.length - 1];
  const [published, symbolic, heads] = await Promise.all([
    // The oldest is an ancestor of every other one on the line: if any of
    // them is on a remote, so is it.
    isPublished(proc, oldest, signal),
    proc.run(["symbolic-ref", "--quiet", "HEAD"], { signal }),
    proc.run(["for-each-ref", "--format=%(objectname) %(refname)", "refs/heads/"], { signal }),
  ]);
  // The full name, compared as such: a tag or a remote named like the branch
  // must not make it look like some other ref.
  const currentRef = symbolic.code === 0 ? symbolic.stdout.trim() : "";
  const branch = currentRef.startsWith("refs/heads/") ? currentRef.slice("refs/heads/".length) : null;

  // Branches that can follow the rewrite: on a replayed commit, or — for a
  // squash — on one of the squashed ones (update-ref lands them on the result).
  // A dropped commit is not in the new history at all, so a branch on it is
  // left where it is, as git's own --update-refs leaves it.
  const rewritten = new Set(target.rows.filter((r) => !r.selected || verb === "squash").map((r) => r.sha));
  const tips = new Map<string, string[]>();
  for (const line of heads.code === 0 ? heads.stdout.split("\n") : []) {
    const at = line.indexOf(" ");
    if (at < 0) continue;
    const tip = line.slice(0, at);
    const ref = line.slice(at + 1).trim();
    if (!rewritten.has(tip) || ref === currentRef || !ref.startsWith("refs/heads/")) continue;
    tips.set(tip, [...(tips.get(tip) ?? []), ref.slice("refs/heads/".length)]);
  }

  const subject = (sha: string): string => walked.messages.get(sha)?.subject ?? "";
  const rows: RebasePlanRow[] = target.rows.map((r) => ({
    sha: r.sha,
    action: !r.selected ? "pick" : verb === "drop" ? "drop" : r.sha === oldest ? "reword" : "fixup",
    subject: subject(r.sha),
    ...(tips.has(r.sha) ? { branches: tips.get(r.sha) } : {}),
  }));
  return {
    ok: true,
    verb,
    shas: selected,
    commits: selected.map((sha) => ({ shortSha: sha.slice(0, 7), subject: subject(sha) })),
    head,
    base: target.base ?? "--root",
    rows,
    replayed: target.rows.filter((r) => !r.selected).length,
    published,
    branch,
    carryable: target.rows.flatMap((r) => tips.get(r.sha) ?? []),
    ...(verb === "squash"
      ? {
          message: squashMessage(
            selected
              .slice()
              .reverse()
              .map((sha) => walked.messages.get(sha) ?? { subject: "", body: "" }),
          ),
        }
      : {}),
  };
}

/**
 * What stops a drop or a squash of several commits from starting right now —
 * said BEFORE the question. The same check Drop Commit makes.
 */
export function manyBlocker(proc: GitProcess, verb: "drop" | "squash", signal?: AbortSignal): Promise<string | undefined> {
  return verb === "drop"
    ? rewriteBlocker(proc, "drop-many", DROP_MANY_DIRTY_MESSAGE, signal)
    : rewriteBlocker(proc, "squash", SQUASH_DIRTY_MESSAGE, signal);
}

/**
 * Run a confirmed drop or squash of several commits through the host's rebase
 * runner. Nothing the question saw is trusted: the plan is read again from
 * git, and HEAD must be where it was when the user said yes.
 */
export async function rewriteMany(
  proc: GitProcess,
  verb: "drop" | "squash",
  req: ManyRequest,
  run: (plan: RebasePlan) => Promise<RebaseOutcome>,
): Promise<DropOutcome> {
  const message = verb === "squash" ? (req.message ?? "").trim() : "";
  if (verb === "squash" && !message) {
    return { status: "failed", expected: true, message: SQUASH_EMPTY_MESSAGE };
  }
  const plan = await planMany(proc, verb, req.shas);
  if (!plan.ok) {
    return { status: "failed", expected: true, message: plan.message };
  }
  // The plan is made from `req.shas` themselves, so HEAD is the one thing
  // that can have moved under the question: a commit landing, a pull, an amend.
  if (plan.head !== req.head) {
    return { status: "failed", expected: true, message: MANY_MOVED_MESSAGE };
  }
  const blocked = await manyBlocker(proc, verb);
  if (blocked) {
    return { status: "failed", expected: true, message: blocked };
  }
  const rows = plan.rows.map((r) => (r.action === "reword" ? { ...r, message } : r));
  const built = buildRebasePlan(rows, { updateRefs: !!req.carry, allowDropAll: true });
  if (!built.ok) {
    // Every row here is one this module wrote, so a refusal is ours: reported.
    return { status: "failed", message: built.message };
  }
  const outcome = await run({ base: plan.base, todo: built.todo, rewords: built.rewords });
  const after = outcome.status === "done" ? await revParse(proc, "HEAD") : undefined;
  // The branches it carried, so the undo can put them back as well — and the
  // branch it rewrote, by full name, so the undo puts back THAT one (as a
  // drop's does), not whichever branch HEAD is on by then.
  const carried = after && req.carry ? await carriedBranches(proc, plan.rows) : [];
  const branch = plan.branch ? `refs/heads/${plan.branch}` : null;
  return {
    ...outcome,
    before: plan.head,
    ...(after ? { after } : {}),
    ...(outcome.status === "done" ? { branch } : {}),
    ...(carried.length ? { carried } : {}),
  };
}

/**
 * The selected commits in the order git has to apply them: `oldest-first` for
 * a cherry-pick (a child after its parent), `newest-first` for a revert (undo
 * the later change first). Asked of git, never of dates — a rebased series
 * shares one commit second, and a committer clock can run backwards.
 *
 * The walk is bounded by the selection itself: from the selected commits down
 * to where they all meet. Undefined when a sha is not a commit.
 */
export async function orderCommits(
  proc: GitProcess,
  shas: readonly string[],
  order: "oldest-first" | "newest-first",
  signal?: AbortSignal,
): Promise<string[] | undefined> {
  const full = await resolveAll(proc, shas, signal);
  if (!full) return undefined;
  if (full.length === 1) return full;
  const base = await proc.run(["merge-base", "--octopus", ...full], { signal });
  const stop = base.code === 0 ? base.stdout.split("\n").map((s) => s.trim()).filter((s) => HEX.test(s)) : [];
  const args = ["rev-list", "--topo-order", ...full];
  if (stop.length) args.push("--not", ...stop.map((s) => `${s}^@`));
  const walk = await proc.run(args, { signal });
  if (walk.code !== 0) return undefined;
  const want = new Set(full);
  const newestFirst = walk.stdout.split("\n").map((s) => s.trim()).filter((s) => want.has(s));
  if (newestFirst.length !== want.size) return undefined;
  return order === "newest-first" ? newestFirst : newestFirst.reverse();
}

/** The merge commits among `shas` — cherry-pick and revert of several need none. */
export async function mergesAmong(proc: GitProcess, shas: readonly string[], signal?: AbortSignal): Promise<string[] | undefined> {
  const full = await resolveAll(proc, shas, signal);
  if (!full) return undefined;
  const r = await proc.run(["rev-list", "--no-walk=unsorted", "--min-parents=2", ...full], { signal });
  if (r.code !== 0) return undefined;
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The argv for picking or reverting commits already in `orderCommits`' order. */
export function applyManyArgs(verb: "cherry-pick" | "revert", ordered: readonly string[]): string[] {
  return verb === "cherry-pick" ? ["cherry-pick", ...ordered] : ["revert", "--no-edit", ...ordered];
}
