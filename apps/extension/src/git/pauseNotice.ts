import * as vscode from "vscode";
import { announcePause, type DetectedOperation, type PauseNoticeUi } from "./pausedForUser";

// The VS Code side of the "paused for you" notice (pausedForUser.ts keeps the
// logic vscode-free). One adapter, so every door that can leave git stopped —
// cherry-pick and revert from the graph, merge and rebase from the branch
// list, pull from the status bar — offers the same way through.

const VS_CODE_UI: PauseNoticeUi = {
  showWarningMessage: (message, ...actions) => vscode.window.showWarningMessage(message, ...actions),
  executeCommand: (command) => vscode.commands.executeCommand(command),
};

/** "… hit conflicts" with a Resolve Conflicts… button that opens the dashboard. */
export function notifyPaused(message: string): void {
  void announcePause(VS_CODE_UI, message);
}

/** OperationProvider.detect(), never throwing (a failed read is "nothing in progress"). */
export async function detectOperation(ctx: {
  operation: { detect(): Promise<DetectedOperation> };
}): Promise<DetectedOperation> {
  try {
    return await ctx.operation.detect();
  } catch {
    return { kind: "none", unmerged: 0 };
  }
}
