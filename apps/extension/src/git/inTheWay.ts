import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { GitRunResult } from "@gitstudio/git-service/GitProcess";
import type { PullMode, PullResult } from "@gitstudio/git-service/SyncOps";
import {
  changesInTheWayMessage,
  operationInTheWayMessage,
  runApplying,
  stashAndRetry,
  stashAndRetryPull,
  stashRetryNote,
  type ApplyOp,
  type ChangesInTheWay,
  type OperationInTheWay,
} from "@gitstudio/git-service/changesInTheWay";
import { promptPick } from "../ui/dialogs";
import { notifyPaused } from "./pauseNotice";

/**
 * Every extension door that applies commits — the graph's Cherry-Pick, Revert
 * and Checkout, the Branches view's Checkout, Merge, Rebase and Create and
 * Switch, the Changes view's Checkout Revision, the Stashes view's Apply and
 * Pop — runs its git command through here, and every pull door its pull
 * (`pullOrAsk`).
 *
 * Crash report #18 was a revert refused over the user's uncommitted edit:
 * "Your local changes to the following files would be overwritten by merge …
 * fatal: revert failed", shown in red and filed as a crash. When git refuses
 * like that (recognised by the engine from git's state — see
 * changesInTheWay.ts), this says which of the user's changes are in the way
 * and asks: Stash & Retry, or Cancel. Nothing is filed either way; the
 * refusal was the user's state, not a defect.
 *
 * One place, for the reason `settlePullStop` is one place: a question that
 * lives inside one door is a question the next door forgets.
 */
export interface Applied {
  /** git's last run: the command, or its retry after the stash. */
  result: GitRunResult;
  /** Asked, and the user cancelled — nothing ran. Not a failure; say nothing. */
  cancelled?: true;
  /** Already said here (the stash failed, it is still in the way, or git is
   *  stopped in an operation that refused it). The caller reports nothing
   *  more. */
  settled?: true;
}

export async function applyOrAsk(ctx: GitContext, op: ApplyOp): Promise<Applied> {
  const first = await runApplying(ctx.process, op);
  if (first.blocked) {
    return sayBlocked(first.result, first.blocked);
  }
  if (first.result.code === 0 || !first.inTheWay) {
    return { result: first.result };
  }
  if (!(await askStashRetry(first.inTheWay))) {
    return { result: first.result, cancelled: true };
  }
  const out = await stashAndRetry(ctx.process, op);
  if (out.blocked) {
    return sayBlocked(out.result, out.blocked);
  }
  if (out.stashFailed) {
    void vscode.window.showWarningMessage(
      `GitStudio: couldn't stash your changes, so nothing ran — ${out.stashFailed}`,
    );
    return { result: out.result, settled: true };
  }
  if (out.inTheWay) {
    void vscode.window.showWarningMessage(`GitStudio: ${changesInTheWayMessage(out.inTheWay)}`);
    return { result: out.result, settled: true };
  }
  // What became of the stashed changes, when it is anything but "back where
  // they were" — conflicting with what came in, waiting for a stop to be
  // finished, or kept because git will not pop over new changes.
  const note = stashRetryNote(out);
  if (note) {
    void vscode.window.showWarningMessage(`GitStudio: ${note}`);
  }
  return { result: out.result };
}

/**
 * A pull, through the same door. Every extension pull door (the Changes
 * view's Update / Pull using Merge / Pull using Rebase, the status bar's Sync
 * and Pull) runs its `sync.pull` through here: refused over the user's
 * uncommitted work (`dirty`), it asks the question above, and Stash & Retry
 * stashes just those files, pulls again and puts them back
 * (stashAndRetryPull). It used to be said as "commit or stash them, then pull
 * again", with nothing to do it — the one door the desktop answered and the
 * extension did not.
 *
 * Returns the pull's result — the retry's after a Stash & Retry — for the door
 * to settle as it always has (`diverged`, `stopped`, `blocked`, `detached`,
 * and `dirty` when the stash could not cover it). `undefined` when there is
 * nothing more to say: the user cancelled, or the stash failed and that was
 * said here. Nothing ran then.
 */
export async function pullOrAsk(ctx: GitContext, mode?: PullMode): Promise<PullResult | undefined> {
  // pull-stop-reviewed: pull-detached-reviewed: a forwarder. What it pulls
  // goes back to the door, which hands it to settlePullStop and
  // settlePullDetached — only the refusal over the user's work is answered
  // here.
  const pull = (): Promise<PullResult> => ctx.sync.pull(mode ? { mode } : undefined);
  const first = await pull();
  if (!first.dirty) {
    return first;
  }
  const v: ChangesInTheWay = {
    kind: "pull",
    paths: first.dirty.paths,
    untracked: [],
    ...(first.dirty.rebase ? { rebase: true as const } : {}),
  };
  if (!(await askStashRetry(v))) {
    return undefined;
  }
  const out = await stashAndRetryPull(ctx.process, pull);
  if (out.stashFailed) {
    void vscode.window.showWarningMessage(
      `GitStudio: couldn't stash your changes, so nothing ran — ${out.stashFailed}`,
    );
    return undefined;
  }
  const note = stashRetryNote(out);
  if (note) {
    void vscode.window.showWarningMessage(`GitStudio: ${note}`);
  }
  return out.pulled;
}

/**
 * Refused because git is already stopped — a merge, a rebase, a cherry-pick, a
 * revert or a `git am` waiting, or files left unmerged. The user's state, and
 * their stop's files are never offered to a stash: said in the engine's words
 * (what is stopped, what is left, finish or abort it first) and never filed.
 * With files left to resolve it is a pause like every other, through
 * notifyPaused — Resolve Conflicts… opens the dashboard, where the stop's own
 * Continue / Skip / Abort are; with none left, a plain warning, as
 * settlePullStop says a pull blocked the same way.
 */
function sayBlocked(result: GitRunResult, blocked: OperationInTheWay): Applied {
  const message = `GitStudio: ${operationInTheWayMessage(blocked)}`;
  if (blocked.unmerged > 0) {
    notifyPaused(message);
  } else {
    void vscode.window.showWarningMessage(message);
  }
  return { result, settled: true };
}

/** The question itself: which changes are in the way, and the two answers. */
async function askStashRetry(v: ChangesInTheWay): Promise<boolean> {
  const n = v.paths.length;
  const choice = await promptPick({
    title: "Your uncommitted changes are in the way",
    hint: changesInTheWayMessage(v),
    choices: [
      {
        id: "stash",
        label: "Stash & Retry",
        icon: "archive",
        description:
          `Stash ${n === 1 ? "it" : `these ${n} files`}, run it again, and put ${n === 1 ? "it" : "them"} back.`,
      },
      {
        id: "cancel",
        label: "Cancel",
        icon: "close",
        description: "Nothing runs. Commit or stash them yourself first.",
      },
    ],
  });
  return choice === "stash";
}

/** A checkout op for the argv a door already runs: its target is its last word. */
export function checkoutOp(args: string[]): ApplyOp {
  return { kind: "checkout", target: args[args.length - 1] ?? "HEAD", args };
}
