// Messaging contract shared between the extension host and the webview.
// IMPORTANT: this module must stay free of any `vscode` import so the webview
// bundle (browser context) can import it too.
//
// The merge-parity additions (marked "S0") are FROZEN with conflictsProtocol.ts:
// a change goes through the orchestrator.

import type { ConflictShape, OperationView, SideRole } from "./conflictsProtocol";

/**
 * In ROLE terms ("us" is Yours, whichever stage that is), in git status's own
 * words. Every host derives it with the engine's conflictTypeFor.
 */
export type ConflictType =
  | "content" // both sides modified; real common ancestor (the common case)
  | "add-add" // both sides added the file; no common ancestor
  | "deleted-by-us" // we deleted, they modified
  | "deleted-by-them" // they deleted, we modified
  | "added-by-us" // only we added it (no ancestor, nothing in theirs)
  | "added-by-them" // only they added it
  | "deleted-by-both" // both deleted it (git's DD)
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
  /**
   * S0. The operation this conflict belongs to. When present, the host has
   * ALREADY mapped the contents through it: `ours` holds the Yours (LEFT)
   * content = stage `op.yours.stage`, `theirs` holds the Theirs (RIGHT)
   * content = stage `op.theirs.stage`, and `oursLabel` / `theirsLabel` are
   * `op.yours.paneTitle` / `op.theirs.paneTitle`. The webview never swaps.
   * Absent = a host that knows no operation (legacy labels, no op strip, no
   * Continue / "Cancel <operation>").
   */
  op?: OperationView;
  /**
   * S0. The host's `autoApplyNonConflicting` setting (default false): open with
   * every non-conflicting change applied as the view's baseline (no undo entry;
   * Reset returns to it). `MergeViewApi.render`'s init option wins when given.
   */
  autoApplyNonConflicting?: boolean;
  /**
   * S0. What kind of conflict this file is. Absent = "text". Anything other
   * than "text" / "added-both" shows the shared no-text panel (Accept Yours /
   * Accept Theirs / Delete the file) instead of the three panes.
   */
  shape?: ConflictShape;
  /** S0. modify-delete / added-one-side: the ROLE that has no version of the file. */
  missingRole?: SideRole;
  /**
   * A submodule: the commit each side points it at (full shas, by ROLE) —
   * the choice the no-text panel names ("yours at 1c34b25, theirs at
   * 9d20bed"). Absent for every other shape, or when the host could not read
   * them.
   */
  commits?: { yours?: string; theirs?: string };
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
  /**
   * The result was written (Apply), or a whole side was taken (takeRole /
   * deleteFile). `staged` is true only when `git add` / `git rm` exited 0;
   * S0: `message` says why not (or any other plain-words warning).
   */
  | {
      type: "applied";
      staged: boolean;
      message?: string;
      /**
       * The host can bring the conflict back (`undoApply`): the shell offers
       * Undo in its bottom bar, in place — until the next change in the editor.
       */
      undoable?: boolean;
    }
  /**
   * Something other than the merge editor changed the file since it last
   * wrote it (another tab, a formatter, a checkout — POLISH A1.3). The shell
   * asks, inline: reload the merge from the file as it is now, or keep what
   * the editor has (`outsideEdit`). The host writes nothing to the file
   * meanwhile.
   */
  | { type: "fileChanged" }
  /**
   * S0. The operation was re-read — after every applied / takeRole / Continue.
   * The shell shows the primary "Continue <op>" (op.verbs.continue) once
   * `remainingConflicts === 0 && op.canContinue`, with the op.willDrop confirm.
   */
  | { type: "opChanged"; op: OperationView; remainingConflicts: number }
  /**
   * S0. What a continueOperation or cancel{mode:"abort"} did, for the shell's
   * outcome line (OperationOutcome mapped: ok → done, stopped → stopped, else
   * failed with git's reason). When a Continue stops on a commit that
   * conflicts in THIS file again, the host follows with a fresh `init`.
   */
  | { type: "outcome"; kind: "done" | "stopped" | "failed"; text: string }
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
  /**
   * The Result changed (text, or which of its changes are settled).
   * `unsettled`: the same text with every change the editor has NOT settled
   * put back to base — a conflict with one side in and the other still to
   * decide, a region seeded from the file and untouched since. What the host
   * writes to the file before Apply is built from it (POLISH A1.1); absent
   * when it is the Result itself.
   */
  | { type: "resultChanged"; text: string; unsettled?: string }
  | { type: "apply"; text: string }
  /**
   * Close the merge editor without applying (the dialog's Cancel button).
   * S0 `mode`: "exit" (the default when absent) closes the viewer and keeps
   * the conflict in the file — the host's exit guard stops it re-opening;
   * "abort" cancels the whole operation (OperationProvider.abort), posted only
   * after the shell's own inline confirm — hosts never ask again.
   */
  | { type: "cancel"; mode?: "exit" | "abort" }
  // Hand this conflict to the real JetBrains merge window and close the panel.
  | { type: "openInJetBrains" }
  /**
   * S0. The shell's "Continue <op>" after Apply. `confirmDrop: true` only after
   * the user confirmed op.willDrop. Host answers `outcome` then `opChanged`.
   */
  | { type: "continueOperation"; confirmDrop?: boolean }
  /**
   * S0. Resolve the whole file as that role (the no-text panel's Accept Yours /
   * Accept Theirs; for the role in `missingRole` this deletes the file).
   * Host answers `applied` then `opChanged`.
   */
  | { type: "takeRole"; role: SideRole }
  /**
   * S0. "Delete the file" for a both-deleted (DD) conflict, the one shape with
   * no role to take. Host answers `applied` then `opChanged`.
   */
  | { type: "deleteFile" }
  /** The answer to `fileChanged`: start the merge over from the file, or keep the editor's work. */
  | { type: "outsideEdit"; answer: "reload" | "keep" }
  /** The bottom bar's Undo after an `applied{undoable}`: bring the conflict back. */
  | { type: "undoApply" }
  | { type: "diffChanged"; text: string }
  /** The user toggled a staging tick; the host performs the git write. */
  | { type: "toggleTick"; block: StageBlockRef; staged: boolean };
