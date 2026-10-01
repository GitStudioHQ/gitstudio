// Several commits at once from the graph (issue #32) — the renderer's half.
//
// The graph's menu for a selection, and the "N commits selected" summary in
// the details pane, run these. The main process plans and runs them with
// git-service's multiCommit.ts — the module the extension's menu uses — and
// the words are the engine's (engine/rebase/many.ts), so both products say
// the same thing. What is left here is the asking and the telling, in this
// app's own dialogs:
//
//   Cherry-pick N / Revert N  one commit:action with `shas` (main orders them
//                             and runs them through the commit-applying door;
//                             uncommitted changes in the way are asked about
//                             by bridge.ts, Stash & Retry); a stop goes to
//                             Changes; a finished run registers an Undo.
//   Drop N… / Squash N…       main again with `preflight` first, so what stops
//                             it is said before the question; one question —
//                             for a squash the message editor, pre-filled —
//                             and the carry either/or when other branches
//                             point at rewritten commits; then the run, Undo,
//                             or the conflict flow.
//   Compare these two         the Compare view, older → newer.
//   Copy SHAs                 every one, a line each, newest first.
//
// Everything it touches comes in through `ManyDeps`, so the flow is tested
// without a DOM or an Electron (test/multiCommitFlow.test.ts).

import {
  applyManyMessage,
  dropManyQuestion,
  manyOutcomeMessage,
  rewordOutcomeMessage,
  rewordQuestion,
  squashCarryQuestion,
  squashQuestion,
} from "@gitstudio/engine/rebase/many";
import type {
  CommitActionRequest,
  CommitActionResult,
  CommitsPlanRequest,
  CommitsPlanWire,
  CommitsRewriteRequest,
  CommitsUndoRequest,
  DropOutcomeWire,
} from "../shared/ipc";
import type { ChoiceOption } from "./dialogs";
import type { ManyAction } from "./contextMenu";
import type { Undoable } from "./undo";
import * as l10n from "@vscode/l10n";

export interface ManyDeps {
  plan(req: CommitsPlanRequest): Promise<CommitsPlanWire>;
  rewrite(req: CommitsRewriteRequest): Promise<DropOutcomeWire>;
  undo(req: CommitsUndoRequest): Promise<CommitActionResult>;
  /** commit:action — through bridge.ts, which asks about changes in the way. */
  apply(req: CommitActionRequest): Promise<CommitActionResult>;
  confirm(opts: { title: string; message: string; confirmLabel: string; danger: boolean }): Promise<boolean>;
  choose(opts: { title: string; hint: string; choices: readonly ChoiceOption[]; cancelId: string }): Promise<string>;
  /** The message editor (dialogs.ts promptMessage): the text, or null. */
  message(opts: { title: string; hint: string; value: string; okLabel: string }): Promise<string | null>;
  toast(message: string, kind: "error" | "success" | "info"): void;
  /** Say it happened and offer Undo (renderer/undo.ts's didUndoable). */
  undoable(message: string, action: Undoable): void;
  /** Redraw after the repository changed. */
  refresh(): Promise<void>;
  /** A run that stopped: take the user to the conflict flow in Changes. */
  landOnConflicts(): Promise<void>;
  copy(text: string, said: string): Promise<void>;
  /** Open the Compare view: what `head` has that `base` does not. */
  compare(base: string, head: string): void;
}

export type ManyFlowResult = "done" | "stopped" | "refused" | "cancelled" | "failed";

/** Run an item of the several-commit menu. `shas` are newest first, as the graph lists them. */
export async function runManyAction(action: ManyAction, shas: string[], d: ManyDeps): Promise<ManyFlowResult> {
  switch (action) {
    case "cherry-pick-many":
      return applyManyFlow("cherry-pick", shas, d);
    case "revert-many":
      return applyManyFlow("revert", shas, d);
    case "drop-many":
      return rewriteManyFlow("drop", shas, d);
    case "squash-many":
      return rewriteManyFlow("squash", shas, d);
    case "reword":
      return rewordFlow(shas, d);
    case "compare-two":
      if (shas.length !== 2) return "refused";
      // Newest first as listed: the second is the older — the base.
      d.compare(shas[1], shas[0]);
      return "done";
    case "copy-shas":
      await d.copy(shas.join("\n"), l10n.t("Copied {0} SHAs.", shas.length));
      return "done";
  }
}

async function applyManyFlow(verb: "cherry-pick" | "revert", shas: string[], d: ManyDeps): Promise<ManyFlowResult> {
  const n = shas.length;
  // A revert asks, as the one-commit Revert does on this app; a pick does not.
  if (verb === "revert") {
    const ok = await d.confirm({
      title: l10n.t("Revert {0} commits?", n),
      message: l10n.t(
        "A revert commit will be created for each of these {0} commits, newest first. Undo is available afterwards.",
        n,
      ),
      confirmLabel: l10n.t("Revert"),
      danger: false,
    });
    if (!ok) return "cancelled";
  }
  const res = await d.apply({ action: verb, sha: shas[0], shas });
  if (res.cancelled) return "cancelled"; // Cancel on "changes in the way": nothing ran
  if (res.ok) {
    const text = applyManyMessage(verb, n, "done");
    const { before, after, branch } = res;
    if (before && after) {
      d.undoable(text, {
        label:
          verb === "cherry-pick"
            ? l10n.t("Take the {0} picked commits back off", n)
            : l10n.t("Take the {0} revert commits back off", n),
        undo: async () => {
          // The branch it ran on goes back — not whichever HEAD is on by then.
          const back = await d.undo({ before, after, what: verb, ...(branch !== undefined ? { branch } : {}) });
          if (back.ok) return undefined;
          const why = back.message ?? l10n.t("Couldn't put the branch back.");
          return back.expected ? { info: why } : why;
        },
        after: () => d.refresh(),
      });
    } else {
      d.toast(text, "success");
    }
    await d.refresh();
    return "done";
  }
  if (res.paused) {
    // Neutral: nothing failed. git is waiting on the user.
    d.toast(res.message ?? applyManyMessage(verb, n, "stopped"), "info");
    await d.landOnConflicts();
    return "stopped";
  }
  d.toast(
    res.message ??
      (verb === "cherry-pick"
        ? l10n.t("Couldn't cherry-pick {0} commits.", n)
        : l10n.t("Couldn't revert {0} commits.", n)),
    res.expected ? "info" : "error",
  );
  if (res.changed) await d.refresh();
  return "failed";
}

async function rewriteManyFlow(verb: "drop" | "squash", shas: string[], d: ManyDeps): Promise<ManyFlowResult> {
  // Asked again, with the preflight: the menu may have been open while
  // history moved, and what stops it is said BEFORE the question.
  const plan = await d.plan({ verb, shas, preflight: true });
  if (!plan.ok) {
    d.toast(plan.message, "info");
    return "refused";
  }
  if (plan.blocked) {
    d.toast(plan.blocked, "info");
    return "refused";
  }
  const n = plan.shas.length;

  let message: string | undefined;
  if (verb === "squash") {
    const q = squashQuestion(plan);
    const m = await d.message({
      title: q.title,
      hint: q.message,
      value: plan.message ?? "",
      okLabel: l10n.t("Squash commits"),
    });
    if (!m || !m.trim()) return "cancelled";
    message = m.trim();
  }

  let carry = false;
  if (plan.carryable.length > 0) {
    // The question names the branches; the choice IS the confirmation.
    // A squash's own words here: the editor's "with the message below" is
    // not what is below this question — its choices are.
    const q = verb === "drop" ? dropManyQuestion(plan) : squashCarryQuestion(plan);
    const picked = await d.choose({
      title: q.title,
      hint: q.message,
      cancelId: "cancel",
      choices: [
        {
          id: "carry",
          label: verb === "drop" ? l10n.t("Drop and move those branches") : l10n.t("Squash and move those branches"),
          sub: l10n.t("They follow onto the rewritten commits."),
          icon: "git-branch",
        },
        {
          id: "only",
          label: verb === "drop" ? l10n.t("Drop on this branch only") : l10n.t("Squash on this branch only"),
          sub: l10n.t("They keep pointing at the commits as they are now."),
          icon: "git-commit",
        },
      ],
    });
    if (picked !== "carry" && picked !== "only") return "cancelled";
    carry = picked === "carry";
  } else if (verb === "drop") {
    const q = dropManyQuestion(plan);
    const ok = await d.confirm({
      title: q.title,
      message: q.message,
      confirmLabel: l10n.t("Drop commits"),
      danger: true,
    });
    if (!ok) return "cancelled";
  }

  const out = await d.rewrite({ verb, shas: plan.shas, head: plan.head, carry, ...(message ? { message } : {}) });
  const text = manyOutcomeMessage(verb, n, out);
  if (out.status === "done") {
    const { before, after, carried } = out;
    if (before && after) {
      d.undoable(text, {
        label:
          verb === "drop"
            ? l10n.t("Put the {0} dropped commits back", n)
            : l10n.t("Put the {0} squashed commits back", n),
        undo: async () => {
          // The branch it rewrote, and the ones it carried: those go back.
          const back = await d.undo({
            before,
            after,
            what: verb,
            ...(out.branch !== undefined ? { branch: out.branch } : {}),
            ...(carried?.length ? { carried } : {}),
          });
          if (back.ok) return undefined;
          const why = back.message ?? l10n.t("Couldn't put the branch back.");
          return back.expected ? { info: why } : why;
        },
        after: () => d.refresh(),
      });
    } else {
      // No tips, no way back that is known to be right — so no Undo offered.
      d.toast(text, "success");
    }
    await d.refresh();
    return "done";
  }
  if (out.status === "stopped") {
    d.toast(text, "info");
    await d.landOnConflicts();
    return "stopped";
  }
  d.toast(text, out.expected ? "info" : "error");
  return "failed";
}

/**
 * Edit message… (issue #75): one commit's whole message in the editor, then a
 * rebase that rewords it and replays what came after — git-service's
 * multiCommit.ts, the extension's path too — with Undo after.
 */
async function rewordFlow(shas: string[], d: ManyDeps): Promise<ManyFlowResult> {
  const plan = await d.plan({ verb: "reword", shas, preflight: true });
  if (!plan.ok) {
    d.toast(plan.message, "info");
    return "refused";
  }
  if (plan.blocked) {
    d.toast(plan.blocked, "info");
    return "refused";
  }
  const q = rewordQuestion(plan);
  const m = await d.message({ title: q.title, hint: q.message, value: plan.message ?? "", okLabel: l10n.t("Edit message") });
  const message = m?.trim();
  if (!message || message === (plan.message ?? "").trim()) return "cancelled";

  let carry = false;
  if (plan.carryable.length > 0) {
    const picked = await d.choose({
      title: l10n.t("Move the branches on rewritten commits too?"),
      hint: q.message,
      cancelId: "cancel",
      choices: [
        { id: "carry", label: l10n.t("Edit and move those branches"), sub: l10n.t("They follow onto the rewritten commits."), icon: "git-branch" },
        { id: "only", label: l10n.t("Edit on this branch only"), sub: l10n.t("They keep pointing at the commits as they are now."), icon: "git-commit" },
      ],
    });
    if (picked !== "carry" && picked !== "only") return "cancelled";
    carry = picked === "carry";
  }

  const out = await d.rewrite({ verb: "reword", shas: plan.shas, head: plan.head, carry, message });
  const text = rewordOutcomeMessage(out);
  if (out.status === "done") {
    const { before, after, carried } = out;
    if (before && after) {
      d.undoable(text, {
        label: l10n.t("Put the old message back"),
        undo: async () => {
          const back = await d.undo({
            before,
            after,
            what: "reword",
            ...(out.branch !== undefined ? { branch: out.branch } : {}),
            ...(carried?.length ? { carried } : {}),
          });
          if (back.ok) return undefined;
          const why = back.message ?? l10n.t("Couldn't put the branch back.");
          return back.expected ? { info: why } : why;
        },
        after: () => d.refresh(),
      });
    } else {
      d.toast(text, "success");
    }
    await d.refresh();
    return "done";
  }
  if (out.status === "stopped") {
    d.toast(text, "info");
    await d.landOnConflicts();
    return "stopped";
  }
  d.toast(text, out.expected ? "info" : "error");
  return "failed";
}

