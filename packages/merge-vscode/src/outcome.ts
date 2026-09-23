// What a Continue / Skip / Abort did, in plain words, for every surface that
// reports it: the merge shell's outcome line, the dashboard, the Changes
// banner and the toasts. One mapping (the S0 contract):
//   ok → "done", stopped → "stopped", anything else → "failed".
// vscode-free.

import type {
  OperationKind,
  OperationOutcome,
  OperationView,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { skipEndedText } from "@gitstudio/engine/conflict/sides";
import { abortConfirm, opNoun, skipConfirm } from "@gitstudio/webview-ui/conflicts/opText";

export type OperationVerb = "continue" | "skip" | "abort";

export interface OutcomeLine {
  kind: "done" | "stopped" | "failed";
  text: string;
}

/**
 * The operation's name at the START of a sentence ("Rebase complete",
 * "Cherry-pick cancelled"). For `am`, a stash apply and "none" there is no
 * such noun — doneText says those per operation instead.
 */
export function operationNoun(kind: OperationKind): string {
  switch (kind) {
    case "merge":
      return "Merge";
    case "rebase":
    case "rebase-merge-step":
      return "Rebase";
    case "cherry-pick":
      return "Cherry-pick";
    case "revert":
      return "Revert";
    case "am":
      return "Applying patches";
    case "stash":
      return "Applying the stash";
    case "none":
      return "The operation";
  }
}

/**
 * The outcome line. `before` is the operation the verb was pressed on — after
 * a finished Continue or an Abort, `outcome.view` is already "none" and can no
 * longer name it.
 */
export function outcomeLine(
  outcome: OperationOutcome,
  verb: OperationVerb,
  before: Pick<OperationView, "kind"> & Partial<Pick<OperationView, "step" | "queued" | "commit">>,
): OutcomeLine {
  if (outcome.ok) {
    return { kind: "done", text: outcome.message || doneText(before, verb) };
  }
  if (outcome.stopped) {
    return { kind: "stopped", text: outcome.message || stoppedText(outcome.view) };
  }
  return { kind: "failed", text: outcome.message || refusedText(outcome, verb) };
}

/**
 * The question a Skip or an Abort asks first, in the SAME words the
 * conflicts dashboard and the merge shell use (webview-ui conflicts/opText) —
 * one vocabulary per operation, including what an abort of "none" (reset
 * --merge) costs: staged work too.
 */
export function verbConfirm(
  view: OperationView,
  verb: "skip" | "abort",
): { title: string; message: string; confirmLabel: string } {
  const c = verb === "skip" ? skipConfirm(view) : abortConfirm(view);
  return { title: c.question, message: c.detail, confirmLabel: c.confirm };
}

/** Why Continue cannot run right now, or undefined when it can. */
export function continueRefusal(view: OperationView): string | undefined {
  if (view.kind === "none" || view.kind === "stash") return "Nothing is in progress.";
  if (!view.verbs.continue) return `There is nothing to continue in the ${opNoun(view.kind)}.`;
  if (!view.canContinue) return view.continueBlocked || `git can't continue the ${opNoun(view.kind)} yet.`;
  return undefined;
}

/** A finished verb, said per operation (never "the applying patches"). */
function doneText(
  before: Pick<OperationView, "kind"> & Partial<Pick<OperationView, "step" | "queued" | "commit">>,
  verb: OperationVerb,
): string {
  const kind = before.kind;
  // A Skip that ended it says which commit or patch it left out, and whether
  // git went on to apply the rest — the words git-service's outcome uses.
  if (verb === "skip") return `${skipEndedText(before)}.`;
  if (kind === "am") {
    return verb === "continue"
      ? "All patches applied."
      : "Patch series abandoned — the branch is back where it was before it started.";
  }
  if (kind === "stash") {
    return "Stash apply cancelled — the files are back as they were, and the stash is still in your list.";
  }
  if (kind === "none") {
    return "The conflicted files are back to their last committed versions.";
  }
  const noun = operationNoun(kind);
  return verb === "abort" ? `${noun} cancelled — the repository is back where it was before.` : `${noun} complete.`;
}

function stoppedText(view: OperationView): string {
  if (view.pause) {
    return `Paused: ${view.pause.detail}`;
  }
  if (view.step) {
    return `Stopped at ${view.step.unit} ${view.step.n} of ${view.step.m} — it has conflicts to resolve.`;
  }
  return "Stopped again — there are conflicts to resolve.";
}

function refusedText(outcome: OperationOutcome, verb: OperationVerb): string {
  switch (outcome.refused) {
    case "blocked":
      return outcome.view.continueBlocked || "Git can't continue yet.";
    case "confirm-drop":
      return outcome.view.willDrop
        ? `Continuing drops ${outcome.view.willDrop.sha.slice(0, 7)} ${outcome.view.willDrop.subject} — confirm to go ahead.`
        : "Continuing would drop an emptied commit — confirm to go ahead.";
    case "not-allowed":
      return verb === "skip" ? "There is nothing git can skip here." : "Nothing is in progress.";
    default:
      return `Git refused to ${verb}.`;
  }
}
