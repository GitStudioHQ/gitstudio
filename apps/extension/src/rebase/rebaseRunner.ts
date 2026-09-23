import * as vscode from "vscode";
import {
  runRebasePlan as runShared,
  continueRebase as continueShared,
  abortRebaseAt as abortShared,
  isRebaseInProgress as inProgressShared,
  reportableRebaseFailure,
  type RebasePlan,
  type RebaseOutcome,
} from "@gitstudio/git-service/RebaseRunner";
import { ErrorReporter } from "../reporting/errorReporter";

/**
 * VS Code binding for the shared, host-agnostic rebase driver
 * (@gitstudio/git-service/RebaseRunner) — it supplies the editor's configured
 * git executable and otherwise delegates. The desktop app drives the same module
 * from its main process, so both hosts share one implementation.
 *
 * It is also where a failed rebase reaches the crash reporter. The rebase doors
 * (the rebase panel's Start and Continue, the graph's drag-to-reorder) never
 * went through showGitError, so a failed outcome was shown and forgotten — a
 * genuine failure (the editor shim not starting, a base that does not exist)
 * was never heard of. Reporting here means no door can run a rebase without it.
 */
export type { RebasePlan, RebaseOutcome };

function opts(): { gitPath: string } {
  return { gitPath: vscode.workspace.getConfiguration("git").get<string>("path") || "git" };
}

/**
 * File a failed rebase — unless it failed over the user's own state. The rule
 * is `reportableRebaseFailure`, the one the desktop's IPC wrapper applies to
 * the same outcome: the runner marks a rebase already under way and
 * uncommitted changes `expected`, and the plan builder a plan the user
 * composed that git cannot run. `label` is our own fixed English title.
 */
export function reportRebaseFailure(label: string, outcome: RebaseOutcome): void {
  const message = reportableRebaseFailure(outcome);
  if (message) {
    ErrorReporter.current?.captureGitError(label, message);
  }
}

/** Run the composed plan. Resolves with the outcome; never throws for git errors. */
export async function runRebasePlan(root: string, plan: RebasePlan): Promise<RebaseOutcome> {
  const outcome = await runShared(root, plan, opts());
  reportRebaseFailure("git rebase failed", outcome);
  return outcome;
}

/** `git rebase --continue` (after resolving a conflict / finishing an edit). */
export async function continueRebase(root: string): Promise<RebaseOutcome> {
  const outcome = await continueShared(root, opts());
  reportRebaseFailure("git rebase --continue failed", outcome);
  return outcome;
}

/** `git rebase --abort`. */
export function abortRebaseAt(root: string): Promise<boolean> {
  return abortShared(root, opts());
}

/** True while a rebase is mid-flight (conflict or `edit` stop) in this repo. */
export function isRebaseInProgress(root: string): Promise<boolean> {
  return inProgressShared(root, opts());
}
