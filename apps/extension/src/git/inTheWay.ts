import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import type { GitRunResult } from "@gitstudio/git-service/GitProcess";
import {
  changesInTheWayMessage,
  runApplying,
  stashAndRetry,
  stashRetryNote,
  type ApplyOp,
  type ChangesInTheWay,
} from "@gitstudio/git-service/changesInTheWay";
import { promptPick } from "../ui/dialogs";

/**
 * Every extension door that applies commits — the graph's Cherry-Pick, Revert
 * and Checkout, the Branches view's Checkout, Merge, Rebase and Create and
 * Switch, the Changes view's Checkout Revision, the Stashes view's Apply and
 * Pop — runs its git command through here.
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
  /** Already said here (the stash failed, or it is still in the way). The
   *  caller reports nothing more. */
  settled?: true;
}

export async function applyOrAsk(ctx: GitContext, op: ApplyOp): Promise<Applied> {
  const first = await runApplying(ctx.process, op);
  if (first.result.code === 0 || !first.inTheWay) {
    return { result: first.result };
  }
  if (!(await askStashRetry(first.inTheWay))) {
    return { result: first.result, cancelled: true };
  }
  const out = await stashAndRetry(ctx.process, op);
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
