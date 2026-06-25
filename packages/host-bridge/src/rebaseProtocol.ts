// Messaging contract for the interactive-rebase webview editor, shared between
// the extension host (CustomTextEditorProvider) and the rebase webview UI.
//
// IMPORTANT: this module is TYPE-ONLY and must stay free of any runtime code and
// of any `vscode`/`node`/`monaco` import — the webview (browser context) imports
// it too, and the engine/host-bridge purity guard depends on it staying pure.

/** The six commit actions a row can carry. Mirrors engine RebaseAction. */
export type WireRebaseAction =
  | "pick"
  | "reword"
  | "edit"
  | "squash"
  | "fixup"
  | "drop";

/** One reorderable commit row presented to the user. */
export interface WireRebaseRow {
  /** Stable id for DnD/keyboard reorder (the original line index). */
  id: number;
  action: WireRebaseAction;
  /** Object name as in the todo (abbreviated or full). */
  sha: string;
  shortSha: string;
  subject: string;
}

/** Host → webview: render this todo. */
export interface RebaseInitMessage {
  type: "rebaseInit";
  /** A human summary parsed from the comment block, if present. */
  headerComment: string | null;
  rows: WireRebaseRow[];
}

export type RebaseHostMessage = RebaseInitMessage;

/** Webview → host: the user pressed Start with this ordered action list. */
export interface RebaseStartMessage {
  type: "start";
  /** Rows in their final order, each with its (possibly retyped) action. */
  rows: Array<{ id: number; action: WireRebaseAction }>;
}

/** Webview → host: abort the in-progress rebase. */
export interface RebaseAbortMessage {
  type: "abort";
}

/** Webview → host: the webview is mounted and ready for the init payload. */
export interface RebaseReadyMessage {
  type: "ready";
}

export type RebaseWebviewMessage =
  | RebaseReadyMessage
  | RebaseStartMessage
  | RebaseAbortMessage;
