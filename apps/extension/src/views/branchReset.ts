import * as vscode from "vscode";
import type { GitContext } from "@gitstudio/git-service/index";
import {
  fetchResetTarget,
  isResetRefusal,
  localMovedOnFrom,
  planReset,
  resetQuestion,
  resetTargetOf,
  runReset,
} from "@gitstudio/git-service/branchReset";
import { refShortName } from "@gitstudio/git-service/checkoutRef";
import { promptConfirm, promptPick } from "../ui/dialogs";
import type { UndoOptions } from "../git/repoManager";

// "Reset 'feature' to 'origin/feature'…" (issue #32), the door. The plan, the
// words and the git are git-service's (branchReset.ts); this is where they
// meet the person: fetch with a word in the status bar, ask in GitStudio's
// own dialog, run under the Undo envelope, say how it went.
//
// Two ways in, one door:
//   · the branch menu's submenu, on a branch that tracks a remote branch
//     (gitstudio.branch.resetToUpstream → branchActions.resetBranchToUpstream);
//   · "Checkout origin/x" — from the branch menu's Remote group or a graph
//     chip — when a local x already exists and has commits origin/x doesn't:
//     askOverLocalBranch offers the reset beside the plain switch.

/** An Undo runner that can say which branch an op moves (see UndoOptions). */
export type BranchUndoRunner = <T>(label: string, fn: () => Promise<T>, opts?: UndoOptions) => Promise<T>;

/**
 * Reset the local branch `fullName` to `target` (a refs/remotes/ name), or
 * to the remote branch it tracks when `target` is omitted. Fetches first,
 * asks — saying what would be lost — and runs under `undo`. True when the
 * branch was changed.
 */
export async function resetBranchTo(
  ctx: GitContext,
  fullName: string,
  target: string | undefined,
  undo: BranchUndoRunner | undefined,
): Promise<boolean> {
  const t = await resetTargetOf(ctx.process, fullName, target);
  if (isResetRefusal(t)) {
    void vscode.window.showWarningMessage(`GitStudio: ${t.refused}`);
    return false;
  }
  // Fetch first: the point is to match the remote as it is now. A failed
  // fetch (offline) does not stop it — the question says the target is as
  // last fetched.
  const busy = vscode.window.setStatusBarMessage(`$(sync~spin) Fetching ${t.remote}…`);
  let fetched = false;
  try {
    fetched = await fetchResetTarget(ctx.process, t);
  } finally {
    busy.dispose();
  }
  const plan = await planReset(ctx.process, t, { fetchFailed: !fetched });
  if (isResetRefusal(plan)) {
    void vscode.window.showWarningMessage(`GitStudio: ${plan.refused}`);
    return false;
  }
  const q = resetQuestion(plan);
  if (q.kind === "nothing") {
    void vscode.window.showInformationMessage(`GitStudio: ${q.message}`);
    return false;
  }
  const ok = await promptConfirm({
    title: q.title,
    message: q.message,
    confirmLabel: q.confirmLabel,
    danger: q.danger,
  });
  if (!ok) {
    return false;
  }
  const run = async (): Promise<boolean> => {
    const r = await runReset(ctx.process, plan);
    if (r.refused) {
      void vscode.window.showWarningMessage(`GitStudio: ${r.refused}`);
      return false;
    }
    if (!r.ok) {
      void vscode.window.showErrorMessage(
        `GitStudio: couldn't reset ${plan.branch} to ${plan.targetName}${r.stderr.trim() ? ` — ${r.stderr.trim()}` : ""}`,
      );
      return false;
    }
    return true;
  };
  // `false` from run is "nothing ran", which the envelope records nothing for.
  const label = `Reset ${plan.branch} to ${plan.targetName}`;
  const changed = undo ? await undo(label, run, { branch: plan.fullName }) : await run();
  if (changed) {
    void vscode.window.setStatusBarMessage(
      `$(check) ${q.danger ? "Reset" : "Fast-forwarded"} ${plan.branch} to ${plan.targetName}`,
      2500,
    );
  }
  return changed;
}

/** What "Checkout origin/x" should do over an existing local x. */
export type OverLocal =
  | { choice: "checkout" }
  | { choice: "cancel" }
  | { choice: "reset"; localFullName: string };

/**
 * "Checkout origin/x" when a local x exists. The checkout has always just
 * switched to x — the right thing while x is origin/x or behind it. When x
 * has commits of its own, the person may have meant IntelliJ's "take the
 * remote's version" (#32), so ask: switch to x as it is, or reset x to
 * origin/x first. Nothing is asked when x has nothing of its own, or when a
 * reset could not run (x checked out in another worktree): the checkout
 * goes on as before.
 */
export async function askOverLocalBranch(ctx: GitContext, remoteFullName: string): Promise<OverLocal> {
  const local = await localMovedOnFrom(ctx.process, remoteFullName).catch(() => undefined);
  if (!local) {
    return { choice: "checkout" };
  }
  if (isResetRefusal(await resetTargetOf(ctx.process, local.fullName, remoteFullName))) {
    return { choice: "checkout" };
  }
  const remote = `'${refShortName(remoteFullName)}'`;
  const x = `'${local.branch}'`;
  const commits = (n: number): string => `${n} commit${n === 1 ? "" : "s"}`;
  const picked = await promptPick({
    title: `Check out ${remote}`,
    hint:
      `A local ${x} already exists, with ${commits(local.ahead)} that ${remote} doesn't have` +
      (local.behind > 0 ? `, and ${remote} has ${commits(local.behind)} it doesn't.` : "."),
    choices: [
      {
        id: "checkout",
        label: `Switch to local ${x}`,
        icon: "git-branch",
        description: `Keeps its ${commits(local.ahead)}. Nothing is reset.`,
      },
      {
        id: "reset",
        label: `Reset ${x} to ${remote}…`,
        icon: "discard",
        danger: true,
        description: `Makes ${x} match ${remote}, then switches to it. Asks first, and says what would be lost.`,
      },
    ],
  });
  if (picked === undefined) {
    return { choice: "cancel" };
  }
  return picked === "reset" ? { choice: "reset", localFullName: local.fullName } : { choice: "checkout" };
}

/** Whether `fullName` is HEAD's branch — the reset already left you on it. */
export async function isCheckedOutHere(ctx: GitContext, fullName: string): Promise<boolean> {
  const r = await ctx.process.run(["symbolic-ref", "--quiet", "HEAD"]);
  return r.code === 0 && r.stdout.trim() === fullName;
}
