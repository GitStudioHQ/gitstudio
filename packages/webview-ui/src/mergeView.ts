import * as monaco from "monaco-editor";
import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type { ChangeBlock, LineSpan, MergeModel, Side } from "@gitstudio/engine/types";
import { blockRole, isEmptySpan, sideBlockSpan } from "@gitstudio/engine/types";
import { buildMergeModel } from "@gitstudio/engine/mergeModel";
import { languageForFile } from "./language";
import { ensureNativeTheme, nativeFontOptions } from "./theme";
import { DecorationManager } from "./decorations";
import {
  chevronDoubleLeft,
  chevronDoubleRight,
  cross,
  iconElement,
  lockIcon,
} from "./icons";
import { computeAlignmentZones, type Spacer } from "@gitstudio/engine/alignment";
import { RibbonOverlay } from "./ribbons";
import { splitLines, type WhitespaceMode } from "@gitstudio/engine/lineDiff";
import { LARGE_FILE_LINE_THRESHOLD } from "./limits";

type Editor = monaco.editor.IStandaloneCodeEditor;

/**
 * How an accept writes into the result span: "auto" replaces on the first
 * accept and appends once another side has already been applied (IntelliJ's
 * behavior when both sides of a conflict are taken); "append" forces the
 * append; "replace" forces the overwrite (bulk actions).
 */
type AcceptMode = "auto" | "replace" | "append";

/** Pixel height of the ✕/≫ action row drawn in the gutter strips. */
// Must fit inside one code line WITH clearance (line height is typically
// 18-19px) so the icon row never touches the band's frame lines.
const ACTION_ROW_HEIGHT = 16;

export interface MergeRenderOptions {
  whitespace: WhitespaceMode;
  showInner: boolean;
}

/**
 * Per-block runtime state. Each side of a block is processed (applied or
 * ignored) independently, like IntelliJ's merge gutter: a conflict stays
 * pending until both of its sides have been dealt with. Absent sides start
 * out done.
 */
interface BlockState {
  doneLeft: boolean;
  doneRight: boolean;
  /** Whether some side's text has already been applied into the result. */
  applied: boolean;
}

/**
 * One entry of the merge's own undo/redo history. Monaco's native stack only
 * covers text, so undoing through it desyncs blockState and the tracked
 * spans; instead every user gesture snapshots all three together.
 */
interface MergeSnapshot {
  /** Human-readable action name, shown in the history dropdown. */
  label: string;
  resultText: string;
  blockState: Map<number, BlockState>;
  /** Live result spans per block id (tracker decoration ids churn). */
  trackerSpans: Map<number, LineSpan>;
}

export interface MergeCountsView {
  total: number;
  pending: number;
  conflictsPending: number;
}

const SHARED_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  automaticLayout: false,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderLineHighlight: "none",
  fontLigatures: false,
  overviewRulerLanes: 0,
  hideCursorInOverviewRuler: true,
  scrollbar: { useShadows: false, vertical: "auto", horizontal: "auto" },
  lineNumbersMinChars: 3,
  lineDecorationsWidth: 6,
  folding: false,
  glyphMargin: false,
  wordWrap: "off",
  fixedOverflowWidgets: true,
  stickyScroll: { enabled: false },
  // No scroll animation: the three panes + two gutter overlays must move in
  // lockstep, and smooth scrolling makes them animate through transiently
  // different offsets (bands/frames visibly detach from the panes mid-scroll).
  smoothScrolling: false,
};

/** Side panes lean on sync-scroll; hiding their vertical bars keeps the
 * change bands visually continuous across the gutter strips. */
const SIDE_PANE_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  scrollbar: { useShadows: false, vertical: "hidden", horizontal: "auto" },
};

/**
 * The three-pane JetBrains-style merge surface and its interactions: Left
 * (ours, read-only), Result (editable, seeded with base), Right (theirs,
 * read-only), with gutter ribbons + accept/ignore controls.
 */
export class MergeView {
  private editors: Editor[] = [];
  private resizeObserver?: ResizeObserver;
  private themeObserver?: MutationObserver;
  private decorations?: DecorationManager;
  private ribbons?: RibbonOverlay;
  private zoneIds = new Map<Editor, string[]>();
  private viewSubs: monaco.IDisposable[] = [];
  private syncingScroll = false;
  private syncScrollEnabled = true;
  private realignTimer = 0;
  private buttonsRaf = 0;

  private trackers = new Map<number, string>();
  private blockState = new Map<number, BlockState>();
  private baseLines: string[] = [];
  private oursLines: string[] = [];
  private theirsLines: string[] = [];

  // --- undo/redo history (snapshots of text + blockState + spans) ---
  private undoStack: MergeSnapshot[] = [];
  private redoStack: MergeSnapshot[] = [];
  /** Suppresses history capture during programmatic edits and restores. */
  private suppressHistory = false;
  /** State at the last quiet point; becomes an undo entry when typing starts. */
  private stableSnapshot?: MergeSnapshot;
  private typingTimer = 0;
  /** Keybindings register into a page-global service — once per view only. */
  private navKeysInstalled = false;

  private gutterA?: HTMLElement;
  private gutterB?: HTMLElement;
  private buttonLayerA?: HTMLElement;
  private buttonLayerB?: HTMLElement;

  public left?: Editor;
  public result?: Editor;
  public right?: Editor;
  public model?: MergeModel;

  private payload?: MergeInitPayload;
  private renderOptions: MergeRenderOptions = {
    whitespace: "none",
    showInner: true,
  };
  private largeFile = false;

  /** Notified whenever the resolved/pending counts change. */
  public onCountsChanged?: (counts: MergeCountsView) => void;
  /** Notified whenever the result document content changes. */
  public onResultChanged?: () => void;
  /** Notified when the large-file fallback kicks in (line-level only). */
  public onLargeFile?: (large: boolean) => void;
  /** Notified whenever the undo/redo stacks change (toolbar state). */
  public onHistoryChanged?: () => void;

  constructor(private readonly container: HTMLElement) {}

  public render(payload: MergeInitPayload): void {
    this.payload = payload;
    this.clearHistory(); // new inputs — old snapshots reference dead blocks
    this.build(payload);
  }

  /**
   * Re-runs the diff with new whitespace / granularity options. Note: this
   * recomputes from base, discarding any already-applied accepts (the accepted
   * text lives only in the result document, which we reseed). The human can
   * re-apply; preserving in-progress edits across a re-diff is out of scope.
   */
  public setRenderOptions(options: Partial<MergeRenderOptions>): void {
    this.renderOptions = { ...this.renderOptions, ...options };
    // A whitespace change rebuilds the model with different block ids, which
    // invalidates every snapshot's spans/state.
    this.clearHistory();
    if (this.payload) {
      this.build(this.payload);
    }
  }

  private build(payload: MergeInitPayload): void {
    this.dispose();

    const language = languageForFile(payload.fileName);
    const theme = ensureNativeTheme();
    const font = nativeFontOptions();

    const grid = document.createElement("div");
    grid.className = "jb-merge-grid";
    this.container.replaceChildren(grid);

    const leftBody = this.addPane(grid, 1, payload.oursLabel, true);
    this.gutterA = this.addGutter(grid, 2, "a");
    const resultBody = this.addPane(grid, 3, "Result", false);
    this.gutterB = this.addGutter(grid, 4, "b");
    const rightBody = this.addPane(grid, 5, payload.theirsLabel, true);

    // Result starts as a copy of base so the block trackers (anchored in base
    // coordinates) line up. With no common ancestor (add/add, or a fallback
    // that couldn't recover a base) base is "", so the result starts empty and
    // the user builds it by accepting sides — same as IntelliJ.
    const resultSeed = payload.base;

    this.left = monaco.editor.create(leftBody, {
      ...SHARED_OPTIONS,
      ...SIDE_PANE_OPTIONS,
      ...font,
      theme,
      language,
      value: payload.ours,
      readOnly: true,
      domReadOnly: true,
    });
    this.result = monaco.editor.create(resultBody, {
      ...SHARED_OPTIONS,
      ...font,
      theme,
      language,
      value: resultSeed,
      readOnly: false,
      // IntelliJ's "error stripe": colored change marks beside the scrollbar,
      // clickable to jump anywhere in the merge.
      overviewRulerLanes: 1,
      overviewRulerBorder: false,
    });
    this.right = monaco.editor.create(rightBody, {
      ...SHARED_OPTIONS,
      ...SIDE_PANE_OPTIONS,
      ...font,
      theme,
      language,
      value: payload.theirs,
      readOnly: true,
      domReadOnly: true,
    });

    this.editors = [this.left, this.result, this.right];

    // Build the merge model for every conflict — including ones with no common
    // ancestor (add/add, or a marker fallback that recovered no base, where
    // payload.base is ""). Guarding this on hasBase used to leave those
    // conflicts as three dead panes showing "0 conflicts".
    this.baseLines = splitLines(payload.base);
    this.oursLines = splitLines(payload.ours);
    this.theirsLines = splitLines(payload.theirs);

    const totalLines =
      this.baseLines.length + this.oursLines.length + this.theirsLines.length;
    this.largeFile = totalLines > LARGE_FILE_LINE_THRESHOLD;
    this.onLargeFile?.(this.largeFile);

    this.model = buildMergeModel(payload.base, payload.ours, payload.theirs, {
      whitespace: this.renderOptions.whitespace,
    });
    this.initBlockState();
    this.installTrackers();

    this.decorations = new DecorationManager({
      left: this.left,
      result: this.result,
      right: this.right,
    });
    this.installAlignment(this.model);

    this.buttonLayerA = this.addButtonLayer(this.gutterA);
    this.buttonLayerB = this.addButtonLayer(this.gutterB);

    this.ribbons = new RibbonOverlay(
      this.gutterA,
      this.gutterB,
      { left: this.left, result: this.result, right: this.right },
      () => this.model,
      {
        resultSpanOf: (block) => this.currentResultSpan(block),
        isResolved: (block) => this.isResolved(block),
        isSideDone: (block, side) => this.isSideDone(block, side),
      },
    );

    this.installViewListeners();
    this.installNavigationKeys();
    this.refresh();
    this.revealFirstPending();

    this.installSyncScroll();
    this.observeResize();
    this.observeTheme();

    // Fresh editors: re-arm the typing-burst base for history capture.
    if (this.typingTimer) {
      window.clearTimeout(this.typingTimer);
      this.typingTimer = 0;
    }
    this.stableSnapshot = this.captureSnapshot("Edit result");
    this.onHistoryChanged?.();
  }

  /** Opens the merge scrolled to the first pending change, like IntelliJ. */
  private revealFirstPending(): void {
    const first = this.model?.blocks.find((block) => !this.isResolved(block));
    if (!first || !this.result) {
      return;
    }
    const line = this.currentResultSpan(first).start;
    this.result.revealLineInCenterIfOutsideViewport(line);
    this.result.setPosition({ lineNumber: line, column: 1 });
  }

  // --- layout helpers ---

  private addPane(
    grid: HTMLElement,
    column: number,
    titleText: string,
    readOnly: boolean,
  ): HTMLElement {
    const variant =
      column === 1 ? "jb-title-left" : column === 5 ? "jb-title-right" : "jb-title-result";
    const title = document.createElement("div");
    title.className = `jb-pane-title ${variant}`;
    title.style.gridColumn = String(column);
    title.style.gridRow = "1";
    title.title = titleText;
    if (readOnly) {
      const lock = iconElement(lockIcon, "jb-svg jb-lock");
      lock.title = "Read-only";
      title.appendChild(lock);
    }
    const label = document.createElement("span");
    label.className = "jb-pane-label";
    label.textContent = titleText;
    title.appendChild(label);

    const body = document.createElement("div");
    body.className = "jb-pane-body";
    body.style.gridColumn = String(column);
    body.style.gridRow = "2";

    grid.append(title, body);
    return body;
  }

  private addGutter(
    grid: HTMLElement,
    column: number,
    side: "a" | "b",
  ): HTMLElement {
    const gutter = document.createElement("div");
    gutter.className = `jb-gutter jb-gutter-${side}`;
    gutter.style.gridColumn = String(column);
    gutter.style.gridRow = "2";
    grid.append(gutter);
    return gutter;
  }

  private addButtonLayer(gutter: HTMLElement): HTMLElement {
    const layer = document.createElement("div");
    layer.className = "jb-button-layer";
    gutter.appendChild(layer);
    return layer;
  }

  // --- block runtime state ---

  private initBlockState(): void {
    this.blockState.clear();
    for (const block of this.model?.blocks ?? []) {
      this.blockState.set(block.id, {
        doneLeft: !block.left,
        doneRight: !block.right,
        applied: false,
      });
    }
  }

  private installTrackers(): void {
    const model = this.result?.getModel();
    if (!model || !this.model) {
      return;
    }
    const specs: monaco.editor.IModelDeltaDecoration[] = this.model.blocks.map(
      (block) => ({
        range: this.trackerRange(model, block.baseSpan),
        options: {
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }),
    );
    const ids = model.deltaDecorations([], specs);
    this.model.blocks.forEach((block, index) => {
      this.trackers.set(block.id, ids[index]);
    });
  }

  private trackerRange(
    model: monaco.editor.ITextModel,
    span: LineSpan,
  ): monaco.Range {
    if (isEmptySpan(span)) {
      return new monaco.Range(span.start, 1, span.start, 1);
    }
    const lineCount = model.getLineCount();
    if (span.endExclusive > lineCount) {
      return new monaco.Range(
        span.start,
        1,
        lineCount,
        model.getLineMaxColumn(lineCount),
      );
    }
    return new monaco.Range(span.start, 1, span.endExclusive, 1);
  }

  private isResolved(block: ChangeBlock): boolean {
    const state = this.blockState.get(block.id);
    return state ? state.doneLeft && state.doneRight : false;
  }

  private isSideDone(block: ChangeBlock, side: Side): boolean {
    const state = this.blockState.get(block.id);
    if (!state) {
      return false;
    }
    return side === "left" ? state.doneLeft : state.doneRight;
  }

  /** Marks one side processed; "both-same" sides always resolve together. */
  private markSideDone(state: BlockState, block: ChangeBlock, side: Side): void {
    if (side === "left") {
      state.doneLeft = true;
    } else {
      state.doneRight = true;
    }
    if (block.kind === "both-same") {
      state.doneLeft = state.doneRight = true;
    }
  }

  /** The block's live span in the result document, tracked through edits. */
  private currentResultSpan(block: ChangeBlock): LineSpan {
    const model = this.result?.getModel();
    const id = this.trackers.get(block.id);
    if (!model || !id) {
      return block.baseSpan;
    }
    const range = model.getDecorationRange(id);
    if (!range) {
      return block.baseSpan;
    }
    const start = range.startLineNumber;
    let endExclusive: number;
    if (
      range.startLineNumber === range.endLineNumber &&
      range.startColumn === range.endColumn
    ) {
      endExclusive = start; // collapsed (insertion point)
    } else {
      endExclusive = range.endColumn === 1 ? range.endLineNumber : range.endLineNumber + 1;
    }
    return { start, endExclusive };
  }

  // --- interactions ---

  public acceptSide(block: ChangeBlock, side: Side, mode: AcceptMode): void {
    const state = this.blockState.get(block.id);
    if (!state || this.isSideDone(block, side)) {
      return;
    }
    const sideText = this.sideText(block, side);
    const span = this.currentResultSpan(block);

    const append = mode === "append" || (mode === "auto" && state.applied);
    this.pushHistory(
      `${append ? "Append" : "Accept"} ${side} change #${block.id + 1}`,
    );
    let newText = sideText;
    if (append) {
      const existing = this.readResultLines(span);
      newText = existing.length ? `${existing}\n${sideText}` : sideText;
    }
    this.replaceResultLines(span, newText);
    // Replacing the whole tracked range makes Monaco collapse the tracker to
    // an empty span (forceMoveMarkers pushes both endpoints to the end of the
    // inserted text). Re-anchor it onto the inserted lines so alignment,
    // highlights, and follow-up accepts keep seeing the block's real extent.
    this.retrackBlock(block, {
      start: span.start,
      endExclusive:
        span.start + (newText.length ? splitLines(newText).length : 0),
    });

    state.applied = true;
    this.markSideDone(state, block, side);
    this.refresh();
  }

  /** Re-anchors a block's result tracker onto an explicit span. */
  private retrackBlock(block: ChangeBlock, span: LineSpan): void {
    const model = this.result?.getModel();
    const id = this.trackers.get(block.id);
    if (!model || !id) {
      return;
    }
    const [newId] = model.deltaDecorations(
      [id],
      [
        {
          range: this.trackerRange(model, span),
          options: {
            stickiness:
              monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        },
      ],
    );
    this.trackers.set(block.id, newId);
  }

  /** Marks one side processed without touching the result (the ✕ action). */
  public ignoreSide(block: ChangeBlock, side: Side): void {
    const state = this.blockState.get(block.id);
    if (!state || this.isSideDone(block, side)) {
      return;
    }
    this.pushHistory(`Ignore ${side} change #${block.id + 1}`);
    this.markSideDone(state, block, side);
    this.refresh();
  }

  // --- bulk auto-resolve actions ---

  /** Accepts (replace) every left-only / right-only / both-same block. */
  public applyAllNonConflicting(): void {
    this.bulkAccept(
      (block) => {
        if (block.kind === "conflict") {
          return undefined;
        }
        // both-same / left-only -> take left; right-only -> take right.
        return block.left ? "left" : "right";
      },
      false,
      "Apply all non-conflicting",
    );
  }

  /**
   * Accepts only the non-conflicting changes contributed by one side
   * (IntelliJ's "Apply non-conflicting changes from the left/right side").
   */
  public applyNonConflictingSide(side: Side): void {
    this.bulkAccept(
      (block) => {
        if (side === "left" && block.kind === "left-only") {
          return "left";
        }
        if (side === "right" && block.kind === "right-only") {
          return "right";
        }
        return undefined;
      },
      false,
      `Apply non-conflicting from ${side}`,
    );
  }

  /**
   * Resolves the whole merge as the left version: every block with a left
   * side takes it; right-only blocks are rejected (the base text already
   * matches the left version there). Mirrors the dialog's "Accept Left".
   */
  public acceptAllLeft(): void {
    this.bulkAccept(
      (block) => (block.left ? "left" : undefined),
      true,
      "Accept all left",
    );
  }

  /** Resolves the whole merge as the right version (see acceptAllLeft). */
  public acceptAllRight(): void {
    this.bulkAccept(
      (block) => (block.right ? "right" : undefined),
      true,
      "Accept all right",
    );
  }

  /** Auto-accepts every "both-same" block (identical edits on both sides). */
  public resolveSimpleConflicts(): void {
    this.bulkAccept(
      (block) => (block.kind === "both-same" ? "left" : undefined),
      false,
      "Resolve simple conflicts",
    );
  }

  /** Whether any "both-same" block exists (enables the Magic Wand action). */
  public hasSimpleConflicts(): boolean {
    return (this.model?.blocks ?? []).some(
      (block) => block.kind === "both-same" && !this.isResolved(block),
    );
  }

  /**
   * Applies a side selection to many blocks at once, resolving each chosen
   * block entirely with that side's text (the dialog-level "Accept Left /
   * Right" semantics). Iterates from the bottom up so that earlier edits
   * don't shift the tracked spans of later (lower) blocks mid-loop.
   */
  private bulkAccept(
    chooseSide: (block: ChangeBlock) => Side | undefined,
    settleUnchosen = false,
    label = "Bulk accept",
  ): void {
    if (!this.model) {
      return;
    }
    const blocks = [...this.model.blocks].sort(
      (a, b) => b.baseSpan.start - a.baseSpan.start,
    );
    // One history entry for the whole gesture (a no-op bulk pushes nothing);
    // the per-block acceptSide pushes are suppressed below.
    const touchesAnything = blocks.some(
      (block) =>
        !this.isResolved(block) && (chooseSide(block) || settleUnchosen),
    );
    if (!touchesAnything) {
      return;
    }
    this.pushHistory(label);
    const wasSuppressed = this.suppressHistory;
    this.suppressHistory = true;
    try {
      for (const block of blocks) {
        if (this.isResolved(block)) {
          continue;
        }
        const side = chooseSide(block);
        if (!side && !settleUnchosen) {
          continue;
        }
        if (side) {
          this.acceptSide(block, side, "replace");
        }
        // The bulk action settles the whole block: any other pending side is
        // considered processed (accepted-side blocks already hold the chosen
        // version; unchosen blocks keep base, i.e. the chosen side's text).
        const state = this.blockState.get(block.id);
        if (state) {
          state.doneLeft = state.doneRight = true;
        }
      }
    } finally {
      this.suppressHistory = wasSuppressed;
    }
    this.refresh();
  }

  // --- change navigation (F7 / Shift+F7) ---

  /** Reveals the next PENDING block below the result caret; wraps around. */
  public goToNextChange(): void {
    this.navigate(1);
  }

  public goToPrevChange(): void {
    this.navigate(-1);
  }

  private navigate(direction: 1 | -1): void {
    if (!this.model || !this.result) {
      return;
    }
    const pending = this.model.blocks.filter((b) => !this.isResolved(b));
    if (pending.length === 0) {
      return;
    }
    const spans = pending
      .map((block) => ({ block, line: this.currentResultSpan(block).start }))
      .sort((a, b) => a.line - b.line);
    const current = this.result.getPosition()?.lineNumber ?? 1;

    let target: ChangeBlock;
    if (direction === 1) {
      target = (spans.find((s) => s.line > current) ?? spans[0]).block;
    } else {
      const before = spans.filter((s) => s.line < current);
      target = (before.length ? before[before.length - 1] : spans[spans.length - 1])
        .block;
    }
    this.revealBlock(target);
  }

  private revealBlock(block: ChangeBlock): void {
    if (!this.result) {
      return;
    }
    const line = this.currentResultSpan(block).start;
    this.result.revealLineInCenter(line);
    this.result.setPosition({ lineNumber: line, column: 1 });
    this.result.focus();
  }

  private sideText(block: ChangeBlock, side: Side): string {
    const change = side === "left" ? block.left : block.right;
    if (!change) {
      return "";
    }
    const lines = side === "left" ? this.oursLines : this.theirsLines;
    // The side's FULL block region, not just its change hunk: a clustered block
    // can include lines this side never touched (passthrough), and accepting
    // the side must carry them along — otherwise resolving a modify/delete (or
    // any asymmetric conflict) silently drops the unchanged lines.
    const span = sideBlockSpan(block, side);
    return lines.slice(span.start - 1, span.endExclusive - 1).join("\n");
  }

  private readResultLines(span: LineSpan): string {
    const model = this.result?.getModel();
    if (!model || span.endExclusive <= span.start) {
      return "";
    }
    const lastLine = Math.min(span.endExclusive - 1, model.getLineCount());
    return model.getValueInRange(
      new monaco.Range(span.start, 1, lastLine, model.getLineMaxColumn(lastLine)),
    );
  }

  private replaceResultLines(span: LineSpan, newText: string): void {
    const editor = this.result;
    const model = editor?.getModel();
    if (!editor || !model) {
      return;
    }
    const lineCount = model.getLineCount();
    let range: monaco.Range;
    let text: string;
    if (span.endExclusive > lineCount) {
      // Block reaches end-of-file: replace to the end without a trailing newline.
      range = new monaco.Range(
        span.start,
        1,
        lineCount,
        model.getLineMaxColumn(lineCount),
      );
      text = newText;
    } else {
      range = new monaco.Range(span.start, 1, span.endExclusive, 1);
      text = newText.length ? `${newText}\n` : "";
    }
    // Suppressed so the content listener doesn't mistake this for typing.
    const wasSuppressed = this.suppressHistory;
    this.suppressHistory = true;
    try {
      editor.executeEdits("jbMerge", [{ range, text, forceMoveMarkers: true }]);
    } finally {
      this.suppressHistory = wasSuppressed;
    }
  }

  // --- rendering refresh ---

  private refresh(): void {
    if (!this.model || !this.left || !this.result || !this.right) {
      return;
    }
    this.installAlignment(this.model);
    this.decorations?.apply(this.model, {
      resultSpanOf: (block) => this.currentResultSpan(block),
      isResolved: (block) => this.isResolved(block),
      isSideDone: (block, side) => this.isSideDone(block, side),
      showInner: this.renderOptions.showInner && !this.largeFile,
    });
    this.ribbons?.scheduleDraw();
    this.rebuildButtons();
    this.notifyCounts();
    // Re-arm the typing-burst base: every gesture ends here, and the next
    // manual keystroke must snapshot the state as of NOW — a stale pre-action
    // snapshot would make its undo entry revert the action too.
    this.stableSnapshot = this.captureSnapshot("Edit result");
  }

  /** Coalesces button-layer rebuilds to one per animation frame. */
  private scheduleButtons(): void {
    if (this.buttonsRaf) {
      return;
    }
    this.buttonsRaf = requestAnimationFrame(() => {
      this.buttonsRaf = 0;
      this.rebuildButtons();
    });
  }

  private rebuildButtons(): void {
    if (
      !this.model ||
      !this.left ||
      !this.result ||
      !this.right ||
      !this.buttonLayerA ||
      !this.buttonLayerB
    ) {
      return;
    }
    this.buttonLayerA.replaceChildren();
    this.buttonLayerB.replaceChildren();

    const height = this.gutterA?.clientHeight ?? 0;
    const lineHeight = this.result.getOption(
      monaco.editor.EditorOption.lineHeight,
    );

    // The icons live in the gutter's rectangular strip, which tracks the
    // SIDE pane's rows — so they anchor to the side editor's geometry, not
    // the result's, and can never drift out of the colored band.
    const place = (editor: Editor, span: LineSpan): number | undefined => {
      const top =
        editor.getTopForLineNumber(span.start) - editor.getScrollTop();
      // Center the icon row on the first line (or on the boundary for
      // insertion points), like IntelliJ anchors its gutter actions. The
      // clamp keeps the row below the band's 1px top frame even when the
      // row is as tall as the line.
      const y = isEmptySpan(span)
        ? top - ACTION_ROW_HEIGHT / 2
        : top + Math.max(1, (lineHeight - ACTION_ROW_HEIGHT) / 2);
      return y < -24 || y > height + 24 ? undefined : y;
    };

    for (const block of this.model.blocks) {
      if (this.isResolved(block)) {
        continue;
      }
      if (block.left && !this.isSideDone(block, "left")) {
        const y = place(this.left, block.left.sideSpan);
        if (y !== undefined) {
          this.buttonLayerA.appendChild(this.makeActions(block, "left", y));
        }
      }
      if (block.right && !this.isSideDone(block, "right")) {
        const y = place(this.right, block.right.sideSpan);
        if (y !== undefined) {
          this.buttonLayerB.appendChild(this.makeActions(block, "right", y));
        }
      }
    }
  }

  private makeActions(block: ChangeBlock, side: Side, y: number): HTMLElement {
    const group = document.createElement("div");
    group.className = "jb-change-actions";
    group.style.top = `${Math.round(y)}px`;

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = `jb-gutter-btn jb-btn-accept jb-role-${blockRole(block)}`;
    accept.appendChild(
      iconElement(side === "left" ? chevronDoubleRight : chevronDoubleLeft),
    );
    accept.title =
      side === "left"
        ? "Accept left change (Ctrl/⌘-click to append)"
        : "Accept right change (Ctrl/⌘-click to append)";
    accept.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const mode: AcceptMode =
        event.ctrlKey || event.metaKey ? "append" : "auto";
      this.acceptSide(block, side, mode);
    });

    const ignore = document.createElement("button");
    ignore.type = "button";
    ignore.className = "jb-gutter-btn jb-btn-ignore";
    ignore.appendChild(iconElement(cross));
    ignore.title = "Ignore this change";
    ignore.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.ignoreSide(block, side);
    });

    // IntelliJ keeps ✕ on the outer edge (next to the side pane) and the
    // apply chevron next to the result column.
    if (side === "left") {
      group.append(ignore, accept);
    } else {
      group.append(accept, ignore);
    }
    return group;
  }

  private notifyCounts(): void {
    if (!this.model) {
      return;
    }
    let pending = 0;
    let conflictsPending = 0;
    for (const block of this.model.blocks) {
      if (!this.isResolved(block)) {
        pending++;
        if (block.kind === "conflict") {
          conflictsPending++;
        }
      }
    }
    this.onCountsChanged?.({
      total: this.model.blocks.length,
      pending,
      conflictsPending,
    });
  }

  /** Current resolved text of the result pane (for write-back). */
  public getResultText(): string {
    return this.result?.getModel()?.getValue() ?? "";
  }

  // --- alignment / scrolling / observers ---

  private installAlignment(model: MergeModel): void {
    if (!this.left || !this.result || !this.right) {
      return;
    }
    // Use the blocks' CURRENT result spans so accepts/edits that change a
    // block's height re-balance the spacers, keeping rows aligned while
    // scrolling — IntelliJ re-aligns continuously the same way.
    const zones = computeAlignmentZones(model, (block) =>
      this.currentResultSpan(block),
    );
    this.installZones(this.left, zones.left);
    this.installZones(this.result, zones.result);
    this.installZones(this.right, zones.right);
  }

  /** Debounced re-alignment for manual edits in the result pane. */
  private scheduleRealign(): void {
    if (this.realignTimer) {
      window.clearTimeout(this.realignTimer);
    }
    this.realignTimer = window.setTimeout(() => {
      this.realignTimer = 0;
      if (this.model) {
        this.installAlignment(this.model);
        this.ribbons?.scheduleDraw();
        this.rebuildButtons();
      }
    }, 120);
  }

  private installZones(editor: Editor, spacers: Spacer[]): void {
    const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight);
    editor.changeViewZones((accessor) => {
      for (const id of this.zoneIds.get(editor) ?? []) {
        accessor.removeZone(id);
      }
      const ids = spacers.map((spacer) =>
        accessor.addZone({
          afterLineNumber: spacer.afterLineNumber,
          heightInPx: spacer.lines * lineHeight,
          domNode: document.createElement("div"),
        }),
      );
      this.zoneIds.set(editor, ids);
    });
  }

  /** Re-renders from the original payload, discarding all resolutions. */
  public reset(): void {
    if (this.payload) {
      // Undoable: block ids are deterministic for the same payload+options,
      // so pre-reset snapshots stay valid against the rebuilt model.
      this.pushHistory("Reset merge");
      this.build(this.payload);
    }
  }

  // --- undo/redo history ---

  public undo(): void {
    this.flushTyping();
    const snapshot = this.undoStack.pop();
    if (!snapshot) {
      return;
    }
    const current = this.captureSnapshot(snapshot.label);
    if (current) {
      this.redoStack.push(current);
    }
    this.restoreSnapshot(snapshot);
    this.onHistoryChanged?.();
  }

  public redo(): void {
    const snapshot = this.redoStack.pop();
    if (!snapshot) {
      return;
    }
    const current = this.captureSnapshot(snapshot.label);
    if (current) {
      this.undoStack.push(current);
    }
    this.restoreSnapshot(snapshot);
    this.onHistoryChanged?.();
  }

  /** Undoes every action at stack index `index` and above (history jump). */
  public undoTo(index: number): void {
    while (this.undoStack.length > Math.max(0, index)) {
      this.undo();
    }
  }

  public canUndo(): boolean {
    return this.undoStack.length > 0 || this.typingTimer !== 0;
  }

  public canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  /** Action labels, oldest first — index aligns with undoTo(). */
  public getHistory(): { undo: string[]; redo: string[] } {
    return {
      undo: this.undoStack.map((snapshot) => snapshot.label),
      redo: this.redoStack.map((snapshot) => snapshot.label),
    };
  }

  private clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.stableSnapshot = undefined;
    if (this.typingTimer) {
      window.clearTimeout(this.typingTimer);
      this.typingTimer = 0;
    }
    this.onHistoryChanged?.();
  }

  /** Captures the full mutable merge state (text + blockState + spans). */
  private captureSnapshot(label: string): MergeSnapshot | undefined {
    const model = this.result?.getModel();
    if (!model || !this.model) {
      return undefined;
    }
    const blockState = new Map<number, BlockState>();
    for (const [id, state] of this.blockState) {
      blockState.set(id, { ...state });
    }
    const trackerSpans = new Map<number, LineSpan>();
    for (const block of this.model.blocks) {
      trackerSpans.set(block.id, this.currentResultSpan(block));
    }
    return { label, resultText: model.getValue(), blockState, trackerSpans };
  }

  /** Appends an undo entry, enforcing the cap and invalidating redo. */
  private pushUndoEntry(snapshot: MergeSnapshot): void {
    this.undoStack.push(snapshot);
    if (this.undoStack.length > 200) {
      this.undoStack.shift();
    }
    this.redoStack = [];
    this.onHistoryChanged?.();
  }

  /** Records the pre-action state; called at the top of every user gesture. */
  private pushHistory(label: string): void {
    if (this.suppressHistory) {
      return;
    }
    this.flushTyping();
    const snapshot = this.captureSnapshot(label);
    if (!snapshot) {
      return;
    }
    this.pushUndoEntry(snapshot);
  }

  /**
   * Manual typing in the result pane: the first keystroke of a burst turns
   * the last quiet state into an undo entry; the burst settles after a pause.
   */
  private onUserEdit(): void {
    if (this.typingTimer) {
      window.clearTimeout(this.typingTimer);
    } else if (this.stableSnapshot) {
      this.pushUndoEntry({ ...this.stableSnapshot, label: "Edit result" });
    }
    this.typingTimer = window.setTimeout(() => {
      this.typingTimer = 0;
      this.stableSnapshot = this.captureSnapshot("Edit result");
      this.onHistoryChanged?.();
    }, 600);
  }

  /** Settles a pending typing burst so undo/actions see a stable base. */
  private flushTyping(): void {
    if (this.typingTimer) {
      window.clearTimeout(this.typingTimer);
      this.typingTimer = 0;
      this.stableSnapshot = this.captureSnapshot("Edit result");
    }
  }

  /** Restores text, trackers and block state together, then redraws once. */
  private restoreSnapshot(snapshot: MergeSnapshot): void {
    const editor = this.result;
    const model = editor?.getModel();
    if (!editor || !model || !this.model) {
      return;
    }
    this.suppressHistory = true;
    try {
      if (model.getValue() !== snapshot.resultText) {
        editor.executeEdits("jbMergeRestore", [
          {
            range: model.getFullModelRange(),
            text: snapshot.resultText,
            forceMoveMarkers: true,
          },
        ]);
      }
      for (const block of this.model.blocks) {
        const span = snapshot.trackerSpans.get(block.id);
        if (span) {
          this.retrackBlock(block, span);
        }
        const live = this.blockState.get(block.id);
        const saved = snapshot.blockState.get(block.id);
        if (live && saved) {
          live.doneLeft = saved.doneLeft;
          live.doneRight = saved.doneRight;
          live.applied = saved.applied;
        }
      }
    } finally {
      this.suppressHistory = false;
    }
    this.stableSnapshot = this.captureSnapshot("Edit result");
    this.refresh();
  }

  public setSyncScroll(enabled: boolean): void {
    this.syncScrollEnabled = enabled;
  }

  public getSyncScroll(): boolean {
    return this.syncScrollEnabled;
  }

  private installSyncScroll(): void {
    for (const editor of this.editors) {
      const sub = editor.onDidScrollChange(() => {
        if (this.syncingScroll || !this.syncScrollEnabled) {
          return;
        }
        this.syncingScroll = true;
        const top = editor.getScrollTop();
        for (const other of this.editors) {
          if (other !== editor && other.getScrollTop() !== top) {
            other.setScrollTop(top);
          }
        }
        this.syncingScroll = false;
      });
      this.viewSubs.push(sub);
    }
  }

  private installNavigationKeys(): void {
    // Monaco's addCommand registers into a page-global keybinding service and
    // never exposes a disposable, so registering on every build() (reset,
    // whitespace toggle, re-init) leaks rules. The handlers only reference
    // `this`, and the global rules keep dispatching for rebuilt editors, so
    // one registration per MergeView lifetime suffices.
    if (this.navKeysInstalled) {
      return;
    }
    this.navKeysInstalled = true;
    for (const editor of this.editors) {
      editor.addCommand(monaco.KeyCode.F7, () => this.goToNextChange());
      editor.addCommand(
        monaco.KeyMod.Shift | monaco.KeyCode.F7,
        () => this.goToPrevChange(),
      );
      // Shadow Monaco's native undo/redo: text-only undo desyncs blockState
      // and the tracked spans, so the merge owns its own history.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ,
        () => this.undo(),
      );
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
        () => this.redo(),
      );
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY,
        () => this.redo(),
      );
    }
  }

  /** Keeps ribbons + buttons in sync with result scroll and manual edits. */
  private installViewListeners(): void {
    if (!this.result) {
      return;
    }
    // Buttons anchor to the SIDE panes' geometry, so their scroll (which can
    // diverge from the result's when sync-scroll is off) must reposition too.
    if (this.left && this.right) {
      this.viewSubs.push(
        this.left.onDidScrollChange(() => this.scheduleButtons()),
        this.right.onDidScrollChange(() => this.scheduleButtons()),
      );
    }
    this.viewSubs.push(
      this.result.onDidScrollChange(() => this.scheduleButtons()),
      this.result.onDidChangeModelContent(() => {
        if (!this.suppressHistory) {
          this.onUserEdit(); // manual typing — make it undoable
        }
        this.ribbons?.scheduleDraw();
        this.scheduleButtons();
        this.scheduleRealign();
        this.onResultChanged?.();
      }),
    );
  }

  private observeResize(): void {
    this.resizeObserver = new ResizeObserver(() => {
      for (const editor of this.editors) {
        editor.layout();
      }
      this.scheduleButtons();
    });
    this.resizeObserver.observe(this.container);
  }

  private observeTheme(): void {
    this.themeObserver = new MutationObserver(() => {
      monaco.editor.setTheme(ensureNativeTheme());
    });
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  public dispose(): void {
    if (this.realignTimer) {
      window.clearTimeout(this.realignTimer);
      this.realignTimer = 0;
    }
    if (this.typingTimer) {
      window.clearTimeout(this.typingTimer);
      this.typingTimer = 0;
    }
    if (this.buttonsRaf) {
      cancelAnimationFrame(this.buttonsRaf);
      this.buttonsRaf = 0;
    }
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.ribbons?.dispose();
    this.ribbons = undefined;
    this.decorations?.clear();
    this.decorations = undefined;
    this.model = undefined;
    for (const sub of this.viewSubs) {
      sub.dispose();
    }
    this.viewSubs = [];
    this.zoneIds.clear();
    this.trackers.clear();
    this.blockState.clear();
    for (const editor of this.editors) {
      editor.getModel()?.dispose();
      editor.dispose();
    }
    this.editors = [];
    this.left = this.result = this.right = undefined;
    this.buttonLayerA = this.buttonLayerB = undefined;
    this.gutterA = this.gutterB = undefined;
  }
}
