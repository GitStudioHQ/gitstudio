import * as vscode from "vscode";
import {
  runRebasePlan as runShared,
  continueRebase as continueShared,
  abortRebaseAt as abortShared,
  isRebaseInProgress as inProgressShared,
  type RebasePlan,
  type RebaseOutcome,
} from "@gitstudio/git-service/RebaseRunner";

/**
 * VS Code binding for the shared, host-agnostic rebase driver
 * (@gitstudio/git-service/RebaseRunner) — it supplies the editor's configured
 * git executable and otherwise delegates. The desktop app drives the same module
 * from its main process, so both hosts share one implementation.
 */
export type { RebasePlan, RebaseOutcome };

function opts(): { gitPath: string } {
  return { gitPath: vscode.workspace.getConfiguration("git").get<string>("path") || "git" };
}

/** Run the composed plan. Resolves with the outcome; never throws for git errors. */
export function runRebasePlan(root: string, plan: RebasePlan): Promise<RebaseOutcome> {
  return runShared(root, plan, opts());
}

/** `git rebase --continue` (after resolving a conflict / finishing an edit). */
export function continueRebase(root: string): Promise<RebaseOutcome> {
  return continueShared(root, opts());
}

/** `git rebase --abort`. */
export function abortRebaseAt(root: string): Promise<boolean> {
  return abortShared(root, opts());
}

/** True while a rebase is mid-flight (conflict or `edit` stop) in this repo. */
export function isRebaseInProgress(root: string): Promise<boolean> {
  return inProgressShared(root, opts());
}
