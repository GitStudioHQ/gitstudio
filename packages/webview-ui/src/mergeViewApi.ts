// The public surface of the three-pane merge view, as an interface — so the
// merge shell (mergeShell.ts), the desktop renderer and their tests can build
// against it without Monaco, and a fake can stand in for the real view.
//
// FROZEN after the S0 contract seed (merge-parity/seed). A change goes through
// the orchestrator. `MergeView` (mergeView.ts) implements it; P1 owns that body.
//
// No monaco import here, on purpose: the interface is what the shell may rely
// on. The concrete class keeps its public editors (`left` / `result` / `right`)
// and `model` for tests that inspect Monaco decorations directly.

import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type { WhitespaceMode } from "@gitstudio/engine/lineDiff";
import type { ChangeBlock, Side } from "@gitstudio/engine/types";

/**
 * The colour category of a change block (PLAN §3.6), JetBrains' model:
 * - "conflict": both sides changed the region differently (red; may be
 *   `resolvable` — Resolve simple, the wand, applies both);
 * - "same": both sides made the same change, exactly or up to whitespace (violet);
 * - "yours-only" / "theirs-only": one side changed it (green / blue / grey by type).
 * Left is always Yours after D1, so "yours-only" is the engine's left-only.
 * The engine's `category(block)` (P1) returns exactly this union.
 */
export type MergeCategory = "conflict" | "same" | "yours-only" | "theirs-only";

/** Every category, in legend order. */
export const MERGE_CATEGORIES: readonly MergeCategory[] = [
  "conflict",
  "same",
  "yours-only",
  "theirs-only",
];

/** Toolbar-driven render options. Granularity (`showInner`) only re-decorates. */
export interface MergeRenderOptions {
  whitespace: WhitespaceMode;
  showInner: boolean;
}

/** Options for one `render()` call. */
export interface MergeRenderInit {
  /**
   * Apply every non-conflicting change (identical + one-sided) as the
   * BASELINE: no undo entry, `hasProgress` stays false, and Reset returns to
   * it. When omitted the view uses `payload.autoApplyNonConflicting ?? false`.
   */
  autoApplyNonConflicting?: boolean;
}

/**
 * How an accept writes into the result span: "auto" replaces on the first
 * accept and appends once another side has already been applied; "append"
 * forces the append; "replace" forces the overwrite (bulk actions).
 */
export type AcceptMode = "auto" | "replace" | "append";

export interface MergeCategoryCount {
  total: number;
  pending: number;
}

/** Resolution progress, pushed through `onCountsChanged` on every change. */
export interface MergeCountsView {
  total: number;
  pending: number;
  /** Pending blocks of category "conflict". */
  conflictsPending: number;
  /** Per category (legend chips, "Apply non-conflicting" enablement). */
  byCategory: Record<MergeCategory, MergeCategoryCount>;
  /** Pending conflicts the wand can resolve (both edits apply without overlap). */
  resolvableConflictsPending: number;
  /**
   * Pending blocks whose Result no longer holds the base text: a conflict with
   * one side taken and the other still open, or a block edited by hand. The
   * rest of `pending` still holds the original text — which is what an Apply
   * with unresolved changes saves for them, and the shell says so per group.
   */
  pendingChanged: number;
  /**
   * The user has changed something since the baseline this view opened with
   * (any accept / ignore / edit since render() or the last Reset; the
   * auto-applied baseline itself does not count). The shell asks before a
   * whitespace-mode change throws that work away (D7).
   */
  hasProgress: boolean;
}

/** A line-ending style, for the EOL notice. */
export type LineEnding = "LF" | "CRLF" | "CR";

/**
 * The sides disagree on line endings. The view merges on normalised text and
 * writes `result` back; the shell shows the notice ("Yours uses CRLF, theirs
 * LF: the result keeps CRLF").
 */
export interface EolMismatchInfo {
  /** Dominant ending of the Yours side; "none" when it has no line break. */
  yours: LineEnding | "none";
  /** Dominant ending of the Theirs side; "none" when it has no line break. */
  theirs: LineEnding | "none";
  /** What `getResultText()` writes (Yours' dominant ending). */
  result: LineEnding;
}

/**
 * The Result started from the file's own text rather than base (POLISH A1.2):
 * the file was already resolved outside the editor — "working": no conflict
 * markers left, by hand or by git rerere; "markers": some regions settled
 * outside git's markers, by hand or by git's own merge. `changes` of the
 * merge's changes hold the file's text; they stay pending.
 */
export interface SeedInfo {
  kind: "working" | "markers";
  changes: number;
}

/** Undo / redo labels, oldest first — indices align with `undoTo()`. */
export interface MergeHistoryView {
  undo: string[];
  redo: string[];
}

/** The merge view as the shell sees it. */
export interface MergeViewApi {
  /** Resolution progress changed (fires on every build and every action). */
  onCountsChanged?: (counts: MergeCountsView) => void;
  /** The result document's text changed. */
  onResultChanged?: () => void;
  /** The large-file fallback (line-level highlights only) turned on or off. */
  onLargeFile?: (large: boolean) => void;
  /** The undo / redo stacks changed (toolbar state). */
  onHistoryChanged?: () => void;
  /**
   * Fired after EVERY (re)build: the mismatch, or `undefined` when the sides
   * agree — so the shell can clear a stale notice.
   */
  onEolMismatch?: (info: EolMismatchInfo | undefined) => void;
  /**
   * Fired after EVERY (re)build: what the Result was seeded with from the
   * file (SeedInfo), or `undefined` when it started from base — so the shell
   * can say so, and clear a stale strip.
   */
  onSeeded?: (info: SeedInfo | undefined) => void;

  /** Builds the three panes for a text conflict (never called for a no-text shape). */
  render(payload: MergeInitPayload, init?: MergeRenderInit): void;
  /**
   * Whitespace changes rebuild the model (the shell confirms first when
   * `hasProgress`); granularity only re-decorates and keeps every resolution.
   */
  setRenderOptions(options: Partial<MergeRenderOptions>): void;
  /** Re-measure the editors after the container changed size or became visible. */
  layout(): void;
  /**
   * Mount the colour legend (items in words, each with a dot of its colour:
   * "Conflicts n · Same on both sides n · Changed Added Removed on one side n",
   * + the "?" key popover) into `slot`. Yours-only and Theirs-only are one
   * item; its tooltip says how many of each.
   * The view keeps it current; a later call moves it to the new slot. The EOL
   * notice is NOT part of the legend — the shell renders it from onEolMismatch.
   */
  attachLegend(slot: HTMLElement): void;

  /** Per-block gutter actions (the view's own controls call these). */
  acceptSide(block: ChangeBlock, side: Side, mode: AcceptMode): void;
  ignoreSide(block: ChangeBlock, side: Side): void;

  /** "Apply non-conflicting changes: All" (identical + one-sided blocks). */
  applyAllNonConflicting(): void;
  /** "Apply non-conflicting changes: Yours" ("left") / "Theirs" ("right"). */
  applyNonConflictingSide(side: Side): void;
  /** Bottom bar "Accept Yours": resolve everything as the left (Yours) version. */
  acceptAllLeft(): void;
  /** Bottom bar "Accept Theirs": resolve everything as the right (Theirs) version. */
  acceptAllRight(): void;
  /** The wand: apply both sides of every resolvable conflict. */
  resolveSimpleConflicts(): void;
  /** Whether the wand has anything to do (a resolvable conflict is pending). */
  hasSimpleConflicts(): boolean;

  /** F7 / Shift+F7; with a category, the next / previous PENDING block of it (legend chips). */
  goToNextChange(category?: MergeCategory): void;
  goToPrevChange(category?: MergeCategory): void;

  /** The result text to write back, in the model's line ending. */
  getResultText(): string;
  /**
   * The Result with every change the editor has not settled put back to base
   * (a conflict with one side in and the other still to decide; a region
   * seeded from the file and untouched since) — what the host marks up for
   * the file before Apply (POLISH A1.1). Absent: the host uses the Result.
   */
  getUnsettledText?(): string;

  /** Back to the baseline (the auto-applied one when that was on). Undoable. */
  reset(): void;
  undo(): void;
  redo(): void;
  /** Undo every action at stack index `index` and above (history jump). */
  undoTo(index: number): void;
  canUndo(): boolean;
  canRedo(): boolean;
  getHistory(): MergeHistoryView;

  setSyncScroll(enabled: boolean): void;
  getSyncScroll(): boolean;

  dispose(): void;
}

/** How the shell obtains a view — the real `new MergeView(container)` or a test fake. */
export type MergeViewFactory = (container: HTMLElement) => MergeViewApi;

/** Zeroed per-category counts. */
export function emptyCategoryCounts(): Record<MergeCategory, MergeCategoryCount> {
  return {
    conflict: { total: 0, pending: 0 },
    same: { total: 0, pending: 0 },
    "yours-only": { total: 0, pending: 0 },
    "theirs-only": { total: 0, pending: 0 },
  };
}

/** The counts of a view with nothing in it (before the first build). */
export function emptyMergeCounts(): MergeCountsView {
  return {
    total: 0,
    pending: 0,
    conflictsPending: 0,
    byCategory: emptyCategoryCounts(),
    resolvableConflictsPending: 0,
    pendingChanged: 0,
    hasProgress: false,
  };
}
