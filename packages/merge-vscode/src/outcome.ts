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

export type OperationVerb = "continue" | "skip" | "abort";

export interface OutcomeLine {
  kind: "done" | "stopped" | "failed";
  text: string;
}

/** The operation's noun for sentences ("Rebase complete", "Cherry-pick aborted"). */
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
  before: Pick<OperationView, "kind">,
): OutcomeLine {
  const noun = operationNoun(before.kind);
  if (outcome.ok) {
    const text =
      outcome.message ||
      (verb === "abort"
        ? `${noun} cancelled — the repository is back where it was before.`
        : verb === "skip"
          ? `${noun}: skipped.`
          : `${noun} complete.`);
    return { kind: "done", text };
  }
  if (outcome.stopped) {
    return { kind: "stopped", text: outcome.message || stoppedText(outcome.view) };
  }
  return { kind: "failed", text: outcome.message || refusedText(outcome, verb) };
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
