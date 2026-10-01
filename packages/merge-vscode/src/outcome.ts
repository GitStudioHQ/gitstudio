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
import * as l10n from "@vscode/l10n";

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
      return l10n.t("Merge");
    case "rebase":
    case "rebase-merge-step":
      return l10n.t("Rebase");
    case "cherry-pick":
      return l10n.t("Cherry-pick");
    case "revert":
      return l10n.t("Revert");
    case "am":
      return l10n.t("Applying patches");
    case "stash":
      return l10n.t("Applying the stash");
    case "none":
      return l10n.t("The operation");
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
  if (view.kind === "none" || view.kind === "stash") return l10n.t("Nothing is in progress.");
  if (!view.verbs.continue) return l10n.t("There is nothing to continue in the {0}.", opNoun(view.kind));
  if (!view.canContinue) return view.continueBlocked || l10n.t("git can't continue the {0} yet.", opNoun(view.kind));
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
      ? l10n.t("All patches applied.")
      : l10n.t("Patch series abandoned — the branch is back where it was before it started.");
  }
  if (kind === "stash") {
    return l10n.t("Stash apply cancelled — the files are back as they were, and the stash is still in your list.");
  }
  if (kind === "none") {
    return l10n.t("The conflicted files are back to their last committed versions.");
  }
  const noun = operationNoun(kind);
  return verb === "abort" ? l10n.t("{0} cancelled — the repository is back where it was before.", noun) : l10n.t("{0} complete.", noun);
}

function stoppedText(view: OperationView): string {
  if (view.pause) {
    return l10n.t("Paused: {0}", view.pause.detail);
  }
  if (view.step) {
    return l10n.t("Stopped at {0} {1} of {2} — it has conflicts to resolve.", view.step.unit, view.step.n, view.step.m);
  }
  return l10n.t("Stopped again — there are conflicts to resolve.");
}

function refusedText(outcome: OperationOutcome, verb: OperationVerb): string {
  switch (outcome.refused) {
    case "blocked":
      return outcome.view.continueBlocked || l10n.t("Git can't continue yet.");
    case "confirm-drop":
      return outcome.view.willDrop
        ? l10n.t("Continuing drops {0} {1} — confirm to go ahead.", outcome.view.willDrop.sha.slice(0, 7), outcome.view.willDrop.subject)
        : l10n.t("Continuing would drop an emptied commit — confirm to go ahead.");
    case "not-allowed":
      return verb === "skip" ? l10n.t("There is nothing git can skip here.") : l10n.t("Nothing is in progress.");
    default:
      return l10n.t("Git refused to {0}.", verb);
  }
}
