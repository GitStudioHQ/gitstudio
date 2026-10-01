import type { GitProcess } from "./GitProcess";
import { OperationProvider } from "./OperationProvider";
import * as l10n from "@vscode/l10n";

// What git is ALREADY stopped in, for a door about to run a command — and the
// sentence for a command refused over it.
//
// A command that applies commits (a merge, a rebase, a cherry-pick, a revert,
// a checkout, a stash apply or pop) — or a pull — meets a repository that is
// mid-merge, mid-rebase, mid-pick, mid-revert or mid-`git am`, or that has
// files left unmerged by a stash. git refuses most of them there ("Merging is
// not possible because you have unmerged files", "You have not concluded your
// merge", "It seems that there is already a rebase-merge directory", "your
// local changes would be overwritten by cherry-pick" over the staged
// resolution), and that is the user's state, not a defect: said in the app's
// words, never git's, and never filed.
//
// Read by the operation core (OperationProvider.detect — the files git
// writes, locale-free, through `rev-parse --git-path` so a linked worktree's
// markers are found), never by a list of its own. The doors used to keep one,
// and it missed `git am` and a cherry-pick or revert with nothing left
// unmerged: their staged resolution was then read as "your uncommitted
// changes" and offered to Stash & Retry, which stashed it OUT of the
// operation.

/** An operation a command can be refused over, by the name the sentence uses. */
export type StoppedOperation = "merge" | "rebase" | "cherry-pick" | "revert" | "am";

/** The door a stop was in the way of. */
export type BlockedDoor =
  | "revert"
  | "cherry-pick"
  | "merge"
  | "rebase"
  | "checkout"
  | "stash"
  | "pull"
  | "reset"
  /** Drop Commit (issue #32) — a rebase, said as the action the user chose. */
  | "drop"
  /** Drop N Commits and Squash N Commits (issue #32) — rebases too. */
  | "drop-many"
  | "squash";

/** What git is stopped in, and what is left unmerged. */
export interface Stopped {
  /** Absent when files are unmerged with no operation (a conflicted stash apply or pop). */
  operation?: StoppedOperation;
  unmerged: number;
}

/** A command refused because git is already stopped — the user's state. */
export interface OperationInTheWay extends Stopped {
  /** The door that was refused. */
  kind: BlockedDoor;
}

/** What `stoppedIn` reads: the stop, and whether a rebase is stopped on a merge step. */
export interface StoppedHere extends Stopped {
  /** A `rebase --rebase-merges` stopped on its `merge` step (MERGE_HEAD inside a rebase). */
  mergeStep?: true;
}

/**
 * What git is stopped in right now — null when nothing is (no operation,
 * nothing unmerged) or when git cannot say (then nothing is claimed).
 */
export async function stoppedIn(proc: GitProcess, signal?: AbortSignal): Promise<StoppedHere | null> {
  let d: { kind: string; unmerged: number };
  try {
    d = await new OperationProvider(proc, proc.cwd).detect({ signal });
  } catch {
    return null;
  }
  const operation = operationOf(d.kind);
  if (!operation && d.unmerged === 0) return null;
  if (!operation) return { unmerged: d.unmerged };
  return d.kind === "rebase-merge-step"
    ? { operation, unmerged: d.unmerged, mergeStep: true }
    : { operation, unmerged: d.unmerged };
}

/** The stop as a sentence needs it. */
export function pick(stop: StoppedHere): Stopped {
  return stop.operation ? { operation: stop.operation, unmerged: stop.unmerged } : { unmerged: stop.unmerged };
}

function operationOf(kind: string): StoppedOperation | undefined {
  switch (kind) {
    case "merge":
      return "merge";
    case "rebase":
    case "rebase-merge-step":
      return "rebase";
    case "cherry-pick":
      return "cherry-pick";
    case "revert":
      return "revert";
    case "am":
      return "am";
    default:
      return undefined; // "none", and "stash" (unmerged files, no operation)
  }
}

/** The same stop — nothing a refused command did moved it. */
export function sameStop(a: Stopped | null, b: Stopped | null): boolean {
  return (a?.operation ?? null) === (b?.operation ?? null) && (a?.unmerged ?? 0) === (b?.unmerged ?? 0);
}

/** "…before <what>". */
const BEFORE: Record<BlockedDoor, string> = {
  revert: l10n.t("reverting"),
  "cherry-pick": l10n.t("cherry-picking"),
  merge: l10n.t("merging"),
  rebase: l10n.t("rebasing"),
  checkout: l10n.t("checking out"),
  stash: l10n.t("applying a stash"),
  pull: l10n.t("pulling again"),
  reset: l10n.t("resetting"),
  drop: l10n.t("dropping a commit"),
  "drop-many": l10n.t("dropping commits"),
  squash: l10n.t("squashing commits"),
};

/** The operation, as the subject of a sentence. */
const NAME: Record<StoppedOperation, string> = {
  merge: l10n.t("A merge"),
  rebase: l10n.t("A rebase"),
  "cherry-pick": l10n.t("A cherry-pick"),
  revert: l10n.t("A revert"),
  am: l10n.t("Applying patches (git am)"),
};

/** How the operation is finished once nothing is left to resolve — "commit"
 *  only for a merge; a rebase, a pick, a revert and an am CONTINUE. */
export const FINISH: Readonly<Record<StoppedOperation, string>> = {
  merge: l10n.t("commit the merge"),
  rebase: l10n.t("continue the rebase"),
  "cherry-pick": l10n.t("continue the cherry-pick"),
  revert: l10n.t("continue the revert"),
  am: l10n.t("continue"),
};

/**
 * What to tell the user: what is stopped, what is left to resolve, and the two
 * ways out — finish it or abort it — before the door they pressed. The pull's
 * `blocked` sentence (pullBlockedMessage) is this one, before "pulling again".
 */
export function operationInTheWayMessage(b: OperationInTheWay): string {
  const n = b.unmerged;
  const files = n === 1 ? l10n.t("1 file") : l10n.t("{0} files", n);
  const it = n === 1 ? l10n.t("it") : l10n.t("them");
  const before = BEFORE[b.kind];
  if (!b.operation) {
    return n === 1
      ? l10n.t("{0} is still conflicted. Resolve {1} before {2}.", files, it, before)
      : l10n.t("{0} are still conflicted. Resolve {1} before {2}.", files, it, before);
  }
  const name = NAME[b.operation];
  if (n === 0) {
    return b.operation === "merge"
      ? l10n.t("{0} is still in progress. Commit it — or abort it — before {1}.", name, before)
      : l10n.t("{0} is still in progress. Continue it — or abort it — before {1}.", name, before);
  }
  return (
    l10n.t("{0} is still in progress, with {1} still conflicted. ", name, files) +
    l10n.t("Resolve {0} and {1} — or abort it — before {2}.", it, FINISH[b.operation], before)
  );
}
