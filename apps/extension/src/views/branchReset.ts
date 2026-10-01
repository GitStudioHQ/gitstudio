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
import * as l10n from "@vscode/l10n";

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
    void vscode.window.showWarningMessage(l10n.t("GitStudio: {0}", t.refused));
    return false;
  }
  // Fetch first: the point is to match the remote as it is now. A failed
  // fetch (offline) does not stop it — the question says the target is as
  // last fetched.
  const busy = vscode.window.setStatusBarMessage(l10n.t("$(sync~spin) Fetching {0}…", t.remote));
  let fetched = false;
  try {
    fetched = await fetchResetTarget(ctx.process, t);
  } finally {
    busy.dispose();
  }
  const plan = await planReset(ctx.process, t, { fetchFailed: !fetched });
  if (isResetRefusal(plan)) {
    void vscode.window.showWarningMessage(l10n.t("GitStudio: {0}", plan.refused));
    return false;
  }
  const q = resetQuestion(plan);
  if (q.kind === "nothing") {
    void vscode.window.showInformationMessage(l10n.t("GitStudio: {0}", q.message));
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
      void vscode.window.showWarningMessage(l10n.t("GitStudio: {0}", r.refused));
      return false;
    }
    if (!r.ok) {
      void vscode.window.showErrorMessage(
        l10n.t("GitStudio: couldn't reset {0} to {1}{2}", plan.branch, plan.targetName, r.stderr.trim() ? ` — ${r.stderr.trim()}` : ""),
      );
      return false;
    }
    return true;
  };
  // `false` from run is "nothing ran", which the envelope records nothing for.
  const label = l10n.t("Reset {0} to {1}", plan.branch, plan.targetName);
  const changed = undo ? await undo(label, run, { branch: plan.fullName }) : await run();
  if (changed) {
    void vscode.window.setStatusBarMessage(
      l10n.t("$(check) {0} {1} to {2}", q.danger ? l10n.t("Reset") : l10n.t("Fast-forwarded"), plan.branch, plan.targetName),
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
    title: l10n.t("Check out {0}", remote),
    hint:
      l10n.t("A local {0} already exists, with {1} that {2} doesn't have", x, commits(local.ahead), remote) +
      (local.behind > 0 ? l10n.t(", and {0} has {1} it doesn't.", remote, commits(local.behind)) : "."),
    choices: [
      {
        id: "checkout",
        label: l10n.t("Switch to local {0}", x),
        icon: "git-branch",
        description: l10n.t("Keeps its {0}. Nothing is reset.", commits(local.ahead)),
      },
      {
        id: "reset",
        label: l10n.t("Reset {0} to {1}…", x, remote),
        icon: "discard",
        danger: true,
        description: l10n.t("Makes {0} match {1}, then switches to it. Asks first, and says what would be lost.", x, remote),
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
