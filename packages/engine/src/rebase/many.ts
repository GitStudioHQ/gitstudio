/**
 * Several commits at once (issue #32): "select multiple commits and with right
 * click do some action on multiple commits, e.g. cherry pick, squashing or
 * dropping commits".
 *
 * Dropping several commits is Drop Commit (drop.ts) with several rows set to
 * `drop`; squashing is the same first-parent run with the selected rows folded
 * into their oldest. Both rewrite the current branch, so both are decided by
 * the same rule Drop Commit is: every selected commit on HEAD's first-parent
 * line, none of them a merge, and no merge between the oldest of them and HEAD
 * (replaying past one would flatten it). A published commit is allowed — the
 * confirmation says so — exactly as it is for one commit.
 *
 * Squash has one more rule, JetBrains' own: the selection must be CONTIGUOUS on
 * that line. Squashing c1 and c3 over c2 would have to reorder c2, and that is a
 * drag the user did not make.
 *
 * Pure by design — no git, no DOM. The caller runs
 *   git rev-list --first-parent HEAD
 * and hands the result here.
 */

import { publishedWarning, type ChainCommit } from "./chain";
import type { DropRefusal } from "./drop";

/** Why several commits cannot be dropped or squashed together. */
export type ManyRefusal =
  | DropRefusal
  /** Squash only: a commit between two selected ones is not selected. */
  | "not-contiguous"
  /** Squash only: one commit is not a squash. */
  | "too-few";

/** One row of the run from HEAD down to the oldest selected commit. */
export interface ManyRow {
  sha: string;
  /** One of the commits the user selected. */
  selected: boolean;
}

export type ManyTarget =
  | {
      ok: true;
      /**
       * HEAD's first-parent line from the tip down to the OLDEST selected
       * commit, newest first — every row a rebase onto `base` replays, the
       * selected ones marked.
       */
      rows: ManyRow[];
      /** The oldest selected commit's parent; undefined for the root (`--root`). */
      base?: string;
    }
  | { ok: false; reason: ManyRefusal };

/**
 * The run a rewrite of `shas` needs, or why there is none.
 *
 * `capped` says the walk stopped at a length limit rather than at the root, so
 * a commit it never reached may be further down rather than absent.
 */
export function manyTarget(
  firstParent: readonly ChainCommit[],
  shas: readonly string[],
  opts: { capped?: boolean } = {},
): ManyTarget {
  const want = new Set(shas);
  if (want.size === 0) return { ok: false, reason: "not-on-branch" };
  const rows: ManyRow[] = [];
  let found = 0;
  for (const c of firstParent) {
    const merge = c.parents.length > 1;
    if (want.has(c.sha)) {
      if (merge) return { ok: false, reason: "merge" };
      rows.push({ sha: c.sha, selected: true });
      found++;
      if (found === want.size) return { ok: true, rows, base: c.parents[0] };
      continue;
    }
    // A merge above a selected commit: replaying across it flattens it.
    if (merge) return { ok: false, reason: "past-merge" };
    rows.push({ sha: c.sha, selected: false });
  }
  return { ok: false, reason: opts.capped ? "too-far" : "not-on-branch" };
}

/**
 * Can these commits be DROPPED together? manyTarget's rule, plus drop's own:
 * not every commit down to the root — that leaves the branch with nothing.
 */
export function dropManyTarget(
  firstParent: readonly ChainCommit[],
  shas: readonly string[],
  opts: { capped?: boolean } = {},
): ManyTarget {
  const t = manyTarget(firstParent, shas, opts);
  if (t.ok && t.base === undefined && t.rows.every((r) => r.selected)) {
    return { ok: false, reason: "only-commit" };
  }
  return t;
}

/**
 * Can these commits be SQUASHED into one? manyTarget's rule, at least two of
 * them, and contiguous: once the first selected row is reached going down,
 * every row to the oldest is selected.
 */
export function squashTarget(
  firstParent: readonly ChainCommit[],
  shas: readonly string[],
  opts: { capped?: boolean } = {},
): ManyTarget {
  if (new Set(shas).size < 2) return { ok: false, reason: "too-few" };
  const t = manyTarget(firstParent, shas, opts);
  if (!t.ok) return t;
  const first = t.rows.findIndex((r) => r.selected);
  if (t.rows.slice(first).some((r) => !r.selected)) return { ok: false, reason: "not-contiguous" };
  return t;
}

/** Why several commits cannot be dropped or squashed, in words. */
export function manyRefusalMessage(reason: ManyRefusal, verb: "drop" | "squash"): string {
  switch (reason) {
    case "not-on-branch":
      return `Not all of those commits are on the current branch, so they can't be ${verb === "drop" ? "dropped" : "squashed"} from it.`;
    case "merge":
      return `One of those commits is a merge — ${verb === "drop" ? "dropping" : "squashing"} it would flatten the history it joined.`;
    case "past-merge":
      return "There's a merge between those commits and the tip of the branch — replaying the commits after them would flatten the merge.";
    case "only-commit":
      return "Those are all the commits on the branch — dropping them would leave nothing.";
    case "too-far":
      return `Those commits are too far down the branch to ${verb} from here. Start an interactive rebase instead.`;
    case "not-contiguous":
      return "Only commits next to each other on the branch can be squashed — there are other commits between the ones you selected.";
    case "too-few":
      return "Select at least two commits to squash them.";
  }
}

/** A commit as the questions name it. */
export interface NamedCommit {
  shortSha: string;
  subject: string;
}

/** What a question about several commits needs to say. */
export interface ManySummary {
  /** The selected commits, newest first. */
  commits: readonly NamedCommit[];
  /** How many unselected commits above them are replayed on top. */
  replayed: number;
  /** At least one of them is already on a remote. */
  published: boolean;
  /** The branch they are on; null on a detached HEAD. */
  branch: string | null;
  /** Other local branches pointing at a rewritten commit (the carry question). */
  carryable?: readonly string[];
}

/** `a1b2c3d "subject"`, or the bare sha for an empty subject. */
function named(c: NamedCommit): string {
  return c.subject ? `${c.shortSha} "${c.subject}"` : c.shortSha;
}

/** "x", "x and y", "x, y and z" — every item, so a confirmation lists them all. */
export function listInWords(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

/**
 * What else a rewrite replays: every commit newer than the oldest selected one
 * that is not itself selected — after them, or (for a drop) between them.
 */
function replayedSentence(n: number): string {
  return n === 0
    ? "Nothing else changes."
    : n === 1
      ? "One later commit will be replayed on top, with a new SHA."
      : `The ${n} later commits will be replayed on top, with new SHAs.`;
}

function carrySentence(carry: readonly string[]): string | undefined {
  if (carry.length === 0) return undefined;
  const names = carry.slice(0, 3).join(", ") + (carry.length > 3 ? ` and ${carry.length - 3} more` : "");
  return `${names} ${carry.length === 1 ? "points" : "point"} at a commit that will be rewritten.`;
}

/**
 * Drop N Commits' confirmation: every commit it removes, from where, what is
 * replayed, and — for pushed history — that it rewrites what others have and
 * the next push must be forced. The same words in both products.
 */
export function dropManyQuestion(s: ManySummary): { title: string; message: string } {
  const n = s.commits.length;
  const parts = [
    `${n} commits will be removed from ${s.branch ?? "the detached HEAD"}: ${listInWords(s.commits.map(named))}.`,
    replayedSentence(s.replayed),
  ];
  const carry = carrySentence(s.carryable ?? []);
  if (carry) parts.push(carry);
  if (s.published) parts.push(`${publishedWarning("Dropping", n)} The next push will need to be a force push.`);
  parts.push("Undo is available afterwards.");
  return { title: `Drop ${n} commits?`, message: parts.join(" ") };
}

/** A squash's sentences after its first: what is replayed, the branches on
 *  rewritten commits, the pushed-history warning, the undo. */
function squashRest(s: ManySummary): string[] {
  const parts = [replayedSentence(s.replayed)];
  const carry = carrySentence(s.carryable ?? []);
  if (carry) parts.push(carry);
  if (s.published) parts.push(`${publishedWarning("Squashing", s.commits.length)} The next push will need to be a force push.`);
  parts.push("Undo is available afterwards.");
  return parts;
}

/** "3333333, 2222222 and 1111111 on main" — the commits a squash makes one. */
function squashWhat(s: ManySummary): string {
  return `${listInWords(s.commits.map((c) => c.shortSha))} on ${s.branch ?? "the detached HEAD"}`;
}

/**
 * Squash N Commits' question — the words above the message editor (JetBrains'
 * "Squash Commits" dialog): which commits become one, on which branch, what is
 * replayed, and the pushed-history warning.
 */
export function squashQuestion(s: ManySummary): { title: string; message: string } {
  const n = s.commits.length;
  const parts = [`${squashWhat(s)} will become one commit with the message below.`, ...squashRest(s)];
  return { title: `Squash ${n} commits`, message: parts.join(" ") };
}

/**
 * The squash's second question, when other branches point at rewritten
 * commits: whether they come along. Its choices are what is below it, not a
 * message — the editor's "with the message below" read as nonsense here — so
 * it says the rest in its own words: what becomes one, what is replayed,
 * which branches are on the rewrite, the pushed warning and the undo.
 */
export function squashCarryQuestion(s: ManySummary): { title: string; message: string } {
  const n = s.commits.length;
  const parts = [`${squashWhat(s)} will become one commit.`, ...squashRest(s)];
  return { title: `Squash ${n} commits — move the branches too?`, message: parts.join(" ") };
}

/** A commit's whole message, as git stores it. */
export interface CommitMessage {
  subject: string;
  body: string;
}

/**
 * The squashed commit's message, pre-filled the way JetBrains fills it: every
 * message in full, oldest first, a blank line between them. A message repeated
 * word for word ("wip", "fixup") is kept once.
 */
export function squashMessage(oldestFirst: readonly CommitMessage[]): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of oldestFirst) {
    const text = [m.subject.trim(), m.body.trim()].filter(Boolean).join("\n\n");
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out.join("\n\n");
}

/** A rebase or sequencer outcome, as much of it as the words need. */
export interface ManyOutcomeLike {
  status: "done" | "stopped" | "failed";
  reason?: string;
  message?: string;
  /** A refusal over the user's own state — its sentence already says it all. */
  expected?: boolean;
}

/** How dropping or squashing N commits ended, in words — the same in both products. */
export function manyOutcomeMessage(verb: "drop" | "squash", n: number, outcome: ManyOutcomeLike): string {
  const what = `${n} commits`;
  if (outcome.status === "done") {
    return verb === "drop" ? `Dropped ${what}.` : `Squashed ${what} into one.`;
  }
  const verbing = verb === "drop" ? "Dropping" : "Squashing";
  if (outcome.status === "stopped") {
    return outcome.reason === "conflict"
      ? `${verbing} ${what} hit a conflict while replaying a later commit. Resolve it and continue the rebase — or skip that commit, or abort to put the branch back as it was.`
      : `${verbing} ${what} stopped and needs you — continue the rebase, or abort it to put the branch back as it was.`;
  }
  if (!outcome.message) return `Couldn't ${verb} ${what}.`;
  return outcome.expected ? outcome.message : `Couldn't ${verb} ${what}: ${outcome.message}`;
}

/**
 * How cherry-picking or reverting N commits ended, in words. A stop is git's
 * sequencer waiting on a conflict (or an empty pick): the conflict flow takes
 * it from there, and abort undoes the whole run — the commits already applied
 * included.
 */
export function applyManyMessage(verb: "cherry-pick" | "revert", n: number, status: "done" | "stopped"): string {
  if (status === "done") {
    return verb === "cherry-pick" ? `Cherry-picked ${n} commits.` : `Reverted ${n} commits.`;
  }
  return verb === "cherry-pick"
    ? `Cherry-picking ${n} commits stopped on a commit that needs you — resolve any conflicts and continue, skip that commit, or abort to put the branch back as it was.`
    : `Reverting ${n} commits stopped on a commit that needs you — resolve any conflicts and continue, skip that commit, or abort to put the branch back as it was.`;
}
