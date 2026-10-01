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
import * as l10n from "@vscode/l10n";

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
export function manyRefusalMessage(reason: ManyRefusal, verb: "drop" | "squash" | "reword"): string {
  if (verb === "reword") return rewordRefusalMessage(reason);
  switch (reason) {
    case "not-on-branch":
      return l10n.t("Not all of those commits are on the current branch, so they can't be {0} from it.", verb === "drop" ? l10n.t("dropped") : l10n.t("squashed"));
    case "merge":
      return l10n.t("One of those commits is a merge — {0} it would flatten the history it joined.", verb === "drop" ? l10n.t("dropping") : l10n.t("squashing"));
    case "past-merge":
      return l10n.t("There's a merge between those commits and the tip of the branch — replaying the commits after them would flatten the merge.");
    case "only-commit":
      return l10n.t("Those are all the commits on the branch — dropping them would leave nothing.");
    case "too-far":
      return verb === "drop"
        ? l10n.t("Those commits are too far down the branch to drop from here. Start an interactive rebase instead.")
        : l10n.t("Those commits are too far down the branch to squash from here. Start an interactive rebase instead.");
    case "not-contiguous":
      return l10n.t("Only commits next to each other on the branch can be squashed — there are other commits between the ones you selected.");
    case "too-few":
      return l10n.t("Select at least two commits to squash them.");
  }
}

/** Why one commit's message cannot be edited from here, in words. */
function rewordRefusalMessage(reason: ManyRefusal): string {
  switch (reason) {
    case "merge":
      return l10n.t("That's a merge commit — editing its message would flatten the history it joined. Use an interactive rebase that keeps merges instead.");
    case "past-merge":
      return l10n.t("There's a merge between that commit and the tip of the branch — replaying the commits after it would flatten the merge.");
    case "too-far":
      return l10n.t("That commit is too far down the branch to edit from here. Start an interactive rebase instead.");
    default:
      return l10n.t("That commit isn't on the current branch, so its message can't be edited from here.");
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
  return l10n.t("{0} and {1}", items.slice(0, -1).join(", "), items[items.length - 1]);
}

/**
 * What else a rewrite replays: every commit newer than the oldest selected one
 * that is not itself selected — after them, or (for a drop) between them.
 */
function replayedSentence(n: number): string {
  return n === 0
    ? l10n.t("Nothing else changes.")
    : n === 1
      ? l10n.t("One later commit will be replayed on top, with a new SHA.")
      : l10n.t("The {0} later commits will be replayed on top, with new SHAs.", n);
}

function carrySentence(carry: readonly string[]): string | undefined {
  if (carry.length === 0) return undefined;
  const names = carry.slice(0, 3).join(", ") + (carry.length > 3 ? l10n.t(" and {0} more", carry.length - 3) : "");
  const which = carry.length === 1 ? l10n.t("points") : l10n.t("point");
  return l10n.t("{0} {1} at a commit that will be rewritten.", names, which);
}

/**
 * Drop N Commits' confirmation: every commit it removes, from where, what is
 * replayed, and — for pushed history — that it rewrites what others have and
 * the next push must be forced. The same words in both products.
 */
export function dropManyQuestion(s: ManySummary): { title: string; message: string } {
  const n = s.commits.length;
  const parts = [
    l10n.t("{0} commits will be removed from {1}: {2}.", n, s.branch ?? "the detached HEAD", listInWords(s.commits.map(named))),
    replayedSentence(s.replayed),
  ];
  const carry = carrySentence(s.carryable ?? []);
  if (carry) parts.push(carry);
  if (s.published) parts.push(l10n.t("{0} The next push will need to be a force push.", publishedWarning(l10n.t("Dropping"), n)));
  parts.push(l10n.t("Undo is available afterwards."));
  return { title: l10n.t("Drop {0} commits?", n), message: parts.join(" ") };
}

/** A squash's sentences after its first: what is replayed, the branches on
 *  rewritten commits, the pushed-history warning, the undo. */
function squashRest(s: ManySummary): string[] {
  const parts = [replayedSentence(s.replayed)];
  const carry = carrySentence(s.carryable ?? []);
  if (carry) parts.push(carry);
  if (s.published) parts.push(l10n.t("{0} The next push will need to be a force push.", publishedWarning(l10n.t("Squashing"), s.commits.length)));
  parts.push(l10n.t("Undo is available afterwards."));
  return parts;
}

/** "3333333, 2222222 and 1111111 on main" — the commits a squash makes one. */
function squashWhat(s: ManySummary): string {
  return l10n.t("{0} on {1}", listInWords(s.commits.map((c) => c.shortSha)), s.branch ?? l10n.t("the detached HEAD"));
}

/**
 * Squash N Commits' question — the words above the message editor (JetBrains'
 * "Squash Commits" dialog): which commits become one, on which branch, what is
 * replayed, and the pushed-history warning.
 */
export function squashQuestion(s: ManySummary): { title: string; message: string } {
  const n = s.commits.length;
  const parts = [l10n.t("{0} will become one commit with the message below.", squashWhat(s)), ...squashRest(s)];
  return { title: l10n.t("Squash {0} commits", n), message: parts.join(" ") };
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
  const parts = [l10n.t("{0} will become one commit.", squashWhat(s)), ...squashRest(s)];
  return { title: l10n.t("Squash {0} commits — move the branches too?", n), message: parts.join(" ") };
}

/**
 * Edit Message's question — the words above the message editor: which commit,
 * on which branch, what is replayed, and the pushed-history warning.
 */
export function rewordQuestion(s: ManySummary): { title: string; message: string } {
  const c = s.commits[0];
  const parts = [
    l10n.t("{0} on {1} gets the message below.", c ? named(c) : "", s.branch ?? l10n.t("the detached HEAD")),
    replayedSentence(s.replayed),
  ];
  const carry = carrySentence(s.carryable ?? []);
  if (carry) parts.push(carry);
  if (s.published) parts.push(l10n.t("Already pushed. Editing its message would rewrite history other people have. The next push will need to be a force push."));
  parts.push(l10n.t("Undo is available afterwards."));
  return { title: l10n.t("Edit commit message"), message: parts.join(" ") };
}

/** How editing one commit's message ended, in words — the same in both products. */
export function rewordOutcomeMessage(outcome: ManyOutcomeLike): string {
  if (outcome.status === "done") return l10n.t("Commit message changed.");
  if (outcome.status === "stopped") {
    return outcome.reason === "conflict"
      ? l10n.t("Editing the message hit a conflict while replaying a later commit. Resolve it and continue the rebase — or abort to put the branch back as it was.")
      : l10n.t("Editing the message stopped and needs you — continue the rebase, or abort it to put the branch back as it was.");
  }
  if (!outcome.message) return l10n.t("Couldn't change the commit message.");
  return outcome.expected ? outcome.message : l10n.t("Couldn't change the commit message: {0}", outcome.message);
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
  const what = l10n.t("{0} commits", n);
  if (outcome.status === "done") {
    return verb === "drop" ? l10n.t("Dropped {0}.", what) : l10n.t("Squashed {0} into one.", what);
  }
  const verbing = verb === "drop" ? l10n.t("Dropping") : l10n.t("Squashing");
  const verbWord = verb === "drop" ? l10n.t("drop") : l10n.t("squash");
  if (outcome.status === "stopped") {
    return outcome.reason === "conflict"
      ? l10n.t("{0} {1} hit a conflict while replaying a later commit. Resolve it and continue the rebase — or skip that commit, or abort to put the branch back as it was.", verbing, what)
      : l10n.t("{0} {1} stopped and needs you — continue the rebase, or abort it to put the branch back as it was.", verbing, what);
  }
  if (!outcome.message) return l10n.t("Couldn't {0} {1}.", verbWord, what);
  return outcome.expected ? outcome.message : l10n.t("Couldn't {0} {1}: {2}", verbWord, what, outcome.message);
}

/**
 * How cherry-picking or reverting N commits ended, in words. A stop is git's
 * sequencer waiting on a conflict (or an empty pick): the conflict flow takes
 * it from there, and abort undoes the whole run — the commits already applied
 * included.
 */
export function applyManyMessage(verb: "cherry-pick" | "revert", n: number, status: "done" | "stopped"): string {
  if (status === "done") {
    return verb === "cherry-pick" ? l10n.t("Cherry-picked {0} commits.", n) : l10n.t("Reverted {0} commits.", n);
  }
  return verb === "cherry-pick"
    ? l10n.t("Cherry-picking {0} commits stopped on a commit that needs you — resolve any conflicts and continue, skip that commit, or abort to put the branch back as it was.", n)
    : l10n.t("Reverting {0} commits stopped on a commit that needs you — resolve any conflicts and continue, skip that commit, or abort to put the branch back as it was.", n);
}
