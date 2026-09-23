import type { GitProcess } from "./GitProcess";
import { OperationProvider } from "./OperationProvider";

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
export type BlockedDoor = "revert" | "cherry-pick" | "merge" | "rebase" | "checkout" | "stash" | "pull";

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
  revert: "reverting",
  "cherry-pick": "cherry-picking",
  merge: "merging",
  rebase: "rebasing",
  checkout: "checking out",
  stash: "applying a stash",
  pull: "pulling again",
};

/** The operation, as the subject of a sentence. */
const NAME: Record<StoppedOperation, string> = {
  merge: "A merge",
  rebase: "A rebase",
  "cherry-pick": "A cherry-pick",
  revert: "A revert",
  am: "Applying patches (git am)",
};

/** How the operation is finished once nothing is left to resolve. */
const FINISH: Record<StoppedOperation, string> = {
  merge: "commit the merge",
  rebase: "continue the rebase",
  "cherry-pick": "continue the cherry-pick",
  revert: "continue the revert",
  am: "continue",
};

/**
 * What to tell the user: what is stopped, what is left to resolve, and the two
 * ways out — finish it or abort it — before the door they pressed. The pull's
 * `blocked` sentence (pullBlockedMessage) is this one, before "pulling again".
 */
export function operationInTheWayMessage(b: OperationInTheWay): string {
  const n = b.unmerged;
  const files = n === 1 ? "1 file" : `${n} files`;
  const it = n === 1 ? "it" : "them";
  const before = BEFORE[b.kind];
  if (!b.operation) {
    return `${files} ${n === 1 ? "is" : "are"} still conflicted. Resolve ${it} before ${before}.`;
  }
  const name = NAME[b.operation];
  if (n === 0) {
    return `${name} is still in progress. ${b.operation === "merge" ? "Commit" : "Continue"} it — or abort it — before ${before}.`;
  }
  return (
    `${name} is still in progress, with ${files} still conflicted. ` +
    `Resolve ${it} and ${FINISH[b.operation]} — or abort it — before ${before}.`
  );
}
