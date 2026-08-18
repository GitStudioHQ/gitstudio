// Messaging contract shared between the extension host and the webview.
// IMPORTANT: this module must stay free of any `vscode` import so the webview
// bundle (browser context) can import it too.

export type ConflictType =
  | "content" // both sides modified; real common ancestor (the common case)
  | "add-add" // both sides added the file; no common ancestor
  | "deleted-by-us" // we deleted, they modified
  | "deleted-by-them" // they deleted, we modified
  | "unknown";

export type VersionsSource =
  | "git-stages" // read from git index stages :1:/:2:/:3:
  | "markers" // reconstructed from <<<<<<< / ======= / >>>>>>> markers
  | "none"; // nothing usable found

export interface MergeInitPayload {
  fileName: string;
  conflictType: ConflictType;
  source: VersionsSource;
  /** Whether a real common ancestor (base) is available for 3-way diffing. */
  hasBase: boolean;
  oursLabel: string;
  theirsLabel: string;
  base: string;
  ours: string;
  theirs: string;
  /** Current working-tree text (still carries conflict markers until resolved). */
  result: string;
  /**
   * Name of the installed JetBrains IDE (WebStorm, PyCharm, …) the host can
   * hand this merge to, or absent when none is installed.
   */
  jetbrainsName?: string;
}

export interface DiffInitPayload {
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  /** Used for language detection / pane titles. */
  fileName: string;
  /** When true the right pane is editable and edits are synced back to the host. */
  rightEditable: boolean;
}

/**
 * One change since HEAD, identified by content-derived ranges rather than a
 * position in a list — so a change that merely shifted because something above
 * it was edited still resolves, and only one that genuinely vanished is refused.
 * Spans are 1-based, end-exclusive, matching the engine's LineSpan.
 */
export interface StageBlockRef {
  head: { start: number; end: number };
  working: { start: number; end: number };
  state: "staged" | "unstaged" | "partial";
}

/** Messages sent from the extension host to the webview. */
export type HostMessage =
  | ({ type: "init" } & MergeInitPayload)
  | { type: "applied"; staged: boolean }
  | ({ type: "diffInit" } & DiffInitPayload)
  // Opaque state the webview persists via setState() so a diff panel can be
  // restored after a window reload. The host owns its shape.
  | { type: "persistState"; state: unknown }
  /**
   * Enter (or refresh) staging mode. `indexText` is the third text the ticks
   * need — the diff itself is HEAD vs the working tree, and the index decides
   * which of those changes are already staged. Undefined leaves staging mode.
   */
  | { type: "stagingState"; indexText: string | undefined };

/** Messages sent from the webview to the extension host. */
export type WebviewMessage =
  | { type: "ready" }
  | { type: "resultChanged"; text: string }
  | { type: "apply"; text: string }
  // Close the merge editor without applying (the dialog's Cancel button).
  | { type: "cancel" }
  // Hand this conflict to the real JetBrains merge window and close the panel.
  | { type: "openInJetBrains" }
  | { type: "diffChanged"; text: string }
  /** The user toggled a staging tick; the host performs the git write. */
  | { type: "toggleTick"; block: StageBlockRef; staged: boolean };
