// "Drop commit…" from the graph's menu (issue #32) — the renderer's half.
//
// The main process plans and runs the drop with git-service's dropCommit.ts,
// the module the extension's menu uses; the words are the engine's. What is
// left here is the asking and the telling, in this app's own dialogs:
//
//   1. ask main again — the menu may have been open while history moved — with
//      `preflight`, so an operation in progress or uncommitted changes are said
//      BEFORE the question, not after the user agreed to a rewrite;
//   2. one question: which commit, from where, how many later commits are
//      replayed, and whether it is already pushed. When other branches point
//      at the replayed commits it is the either/or the extension's reorder
//      asks, whether they come along;
//   3. run it, then: a finished drop registers an Undo (the toast's button and
//      ⌘Z); a stop — a later commit conflicting — goes to Changes, where the
//      conflicts dashboard offers Continue, Skip and Abort; a refusal is said.
//
// Everything it touches comes in through `DropCommitDeps`, so the flow is
// tested without a DOM or an Electron (test/dropCommitFlow.test.ts).

import { dropOutcomeMessage, dropQuestion } from "@gitstudio/engine/rebase/drop";
import type {
  CommitActionResult,
  DropOutcomeWire,
  DropPlanRequest,
  DropPlanWire,
  DropRequest,
  UndoDropRequest,
} from "../shared/ipc";
import type { ChoiceOption } from "./dialogs";
import type { Undoable } from "./undo";

export interface DropCommitDeps {
  plan(req: DropPlanRequest): Promise<DropPlanWire>;
  drop(req: DropRequest): Promise<DropOutcomeWire>;
  undo(req: UndoDropRequest): Promise<CommitActionResult>;
  confirm(opts: { title: string; message: string; confirmLabel: string; danger: boolean }): Promise<boolean>;
  choose(opts: { title: string; hint: string; choices: readonly ChoiceOption[]; cancelId: string }): Promise<string>;
  toast(message: string, kind: "error" | "success" | "info"): void;
  /** Say it happened and offer Undo (renderer/undo.ts's didUndoable). */
  undoable(message: string, action: Undoable): void;
  /** Redraw after the repository changed. */
  refresh(): Promise<void>;
  /** A drop that stopped: take the user to the conflict flow in Changes. */
  landOnConflicts(): Promise<void>;
}

export type DropFlowResult = "done" | "stopped" | "refused" | "cancelled" | "failed";

export async function dropCommitFlow(sha: string, d: DropCommitDeps): Promise<DropFlowResult> {
  const plan = await d.plan({ sha, preflight: true });
  if (!plan.ok) {
    d.toast(plan.message, "info");
    return "refused";
  }
  if (plan.blocked) {
    d.toast(plan.blocked, "info");
    return "refused";
  }

  const question = dropQuestion(plan);
  let carry = false;
  if (plan.carryable.length > 0) {
    // The question names the branches; the choice IS the confirmation.
    const picked = await d.choose({
      title: question.title,
      hint: question.message,
      cancelId: "cancel",
      choices: [
        {
          id: "carry",
          label: "Drop and move those branches",
          sub: "They follow onto the replayed commits.",
          icon: "git-branch",
        },
        {
          id: "only",
          label: "Drop from this branch only",
          sub: "They keep pointing at the commits as they are now.",
          icon: "git-commit",
        },
      ],
    });
    if (picked !== "carry" && picked !== "only") return "cancelled";
    carry = picked === "carry";
  } else {
    const ok = await d.confirm({
      title: question.title,
      message: question.message,
      confirmLabel: "Drop commit",
      danger: true,
    });
    if (!ok) return "cancelled";
  }

  const out = await d.drop({ sha: plan.sha, head: plan.head, carry });
  const text = dropOutcomeMessage(plan.shortSha, out);
  if (out.status === "done") {
    const { before, after } = out;
    if (before && after) {
      d.undoable(text, {
        label: `Put ${plan.shortSha} back`,
        undo: async () => {
          const back = await d.undo({ before, after });
          if (back.ok) return undefined;
          const why = back.message ?? `Couldn't put ${plan.shortSha} back.`;
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
    // Neutral: nothing failed. The rebase is open and the rest is the user's.
    d.toast(text, "info");
    await d.landOnConflicts();
    return "stopped";
  }
  d.toast(text, out.expected ? "info" : "error");
  return "failed";
}
