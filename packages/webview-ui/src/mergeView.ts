import * as monaco from "monaco-editor";
import type { MergeInitPayload } from "@gitstudio/host-bridge/protocol";
import type {
  ChangeBlock,
  LineSpan,
  MergeCategory,
  MergeModel,
  Side,
} from "@gitstudio/engine/types";
import {
  category,
  isEmptySpan,
  sideBlockSpan,
} from "@gitstudio/engine/types";
import { PAINT_TONES, fateWords, paintTone, type PaintTone, type SideFate } from "./paint";
import { buildMergeModel } from "@gitstudio/engine/mergeModel";
import { eolChars, normalizeEol, splitLines } from "@gitstudio/engine/lineDiff";
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
import { MERGE_ICON_STRIP, RibbonOverlay, lineTopY, scheduleFrame, spanY } from "./ribbons";
import { OverviewMap } from "./overviewMap";
import { preparedFrom, seedResult, type ResultSeed } from "./seedResult";
import { splitTitle } from "./conflicts/opText";
import { lineDocOf, planLineWrite } from "./lineEdits";
import { LARGE_FILE_LINE_THRESHOLD } from "./limits";
import { MergeLegend, type LegendDetail } from "./mergeLegend";
import {
  emptyCategoryCounts,
  emptyMergeCounts,
  type AcceptMode,
  type EolMismatchInfo,
  type MergeCountsView,
  type MergeRenderInit,
  type MergeRenderOptions,
  type MergeViewApi,
  type SeedInfo,
} from "./mergeViewApi";

// The public types live in the frozen API module; re-exported so existing
// imports from "./mergeView" keep working.
export type { AcceptMode, MergeCountsView, MergeRenderOptions } from "./mergeViewApi";

type Editor = monaco.editor.IStandaloneCodeEditor;

/** Pixel height of the ×/→ action row drawn in the gutter strips. */
// Must fit inside one code line WITH clearance (line height is typically
// 18-19px) so the icon row never touches the band's frame lines.
const ACTION_ROW_HEIGHT = 16;

/** Numbers each MergeView's keybinding scope (installNavigationKeys). */
let mergeViewSerial = 0;

/**
 * What a control acts on, in words ("Accept Yours (test) for this conflict"),
 * and how the block is counted for a screen reader ("… (2 of 5)").
 */
const CATEGORY_WORDS: Record<MergeCategory, string> = {
  conflict: "this conflict",
  same: "this change, made the same on both sides",
  "yours-only": "this change",
  "theirs-only": "this change",
};

/** How a screen reader names a block before its place in its category ("Conflict 2 of 5"). */
const CATEGORY_NOUNS: Record<MergeCategory, string> = {
  conflict: "Conflict",
  same: "Change made the same on both sides",
  "yours-only": "Change on one side only",
  "theirs-only": "Change on one side only",
};

/**
 * What a change made the same on both sides says on either of its arrows —
 * the legend's own words for its colour (green).
 */
const SAME_ARROW_WORDS = "Same on both sides — either arrow takes it";

/** What a change on one side only says after its side's name — the legend's words for blue. */
const ONE_SIDE_WORDS = "one side only — safe to take";

/**
 * Per-block runtime state. Each side of a block is processed (applied or
 * ignored) independently, like IntelliJ's merge gutter: a conflict stays
 * pending until both of its sides have been dealt with. Absent sides start
 * out done.
 */
interface BlockState {
  doneLeft: boolean;
  doneRight: boolean;
  /**
   * Which handled sides went INTO the Result (accepted, added after, the
   * wand, a whole-file Accept) — the rest were discarded. What the traces
   * show: a taken side keeps its muted band and ribbon, a discarded one an
   * outline (paint.ts SideFate).
   */
  tookLeft: boolean;
  tookRight: boolean;
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

/** Every pane leans on sync-scroll; hiding their vertical bars keeps the
 * change bands continuous across the gutter strips. The Result's too: its bar
 * and overview ruler sat on the Result|gutter seam and cut every band there.
 * The merge's scrollbar is its overview strip, at the view's right edge
 * (overviewMap.ts). */
const PANE_SCROLL_OPTIONS: monaco.editor.IStandaloneEditorConstructionOptions = {
  scrollbar: { useShadows: false, vertical: "hidden", horizontal: "auto" },
};

/**
 * The three-pane JetBrains-style merge surface and its interactions: Left
 * (Yours, read-only), Result (editable, seeded with base), Right (Theirs,
 * read-only), with gutter ribbons + accept/ignore controls.
 *
 * Blocks are painted by the DECISION they need (paint.ts), in JetBrains' dark
 * merge colours: a conflict orange (you choose); the same change on both
 * sides green, on both sides (either arrow takes it, for both); a change on
 * one side only blue (safe to take); and lines removed without a conflict
 * grey, on one side or on both. Every change is one
 * continuous band — side pane, filled ribbon, result — and its controls are
 * the ones JetBrains and VS Code users already know: an arrow toward the
 * result to accept a side, × to ignore it, each with its action in words.
 * A handled side leaves a trace of what happened to it: a TAKEN side keeps its
 * band and its ribbon to the Result, muted; a DISCARDED side keeps an outline
 * and no ribbon. While a conflict's other side is still to decide, the Result
 * is muted between two faint lines; once settled, the Result keeps a muted
 * band in the colour of what went in — calm, and still saying where it came
 * from ("Took Yours", "Discarded Theirs", "Took both", in words on hover).
 */
export class MergeView implements MergeViewApi {
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
  private cancelButtons?: () => void;

  private trackers = new Map<number, string>();
  /**
   * Blocks that own the END of the result document. A range cannot say this on
   * its own: the file's final line may be empty (the text ends with a break),
   * and an empty line has no width — so "up to and including that line" and
   * "up to the break before it", or "the empty last line" and "the point after
   * it", are the same range. "span" runs to the end (last line included);
   * "point" is an insertion point after the last line. Replacing a block's own
   * lines never changes which it is, so it is decided whenever a tracker is set.
   */
  private eofKind = new Map<number, "span" | "point">();
  private blockState = new Map<number, BlockState>();
  /** Each block's place within its category, for "Conflict 2 of 5". */
  private ordinals = new Map<number, { index: number; total: number }>();
  private baseLines: string[] = [];
  private oursLines: string[] = [];
  private theirsLines: string[] = [];

  // --- undo/redo history (snapshots of text + blockState + spans) ---
  private undoStack: MergeSnapshot[] = [];
  private redoStack: MergeSnapshot[] = [];
  /** Suppresses history capture during programmatic edits and restores. */
  private suppressHistory = false;
  /** Inside a bulk action: per-block redraws wait for the one at the end. */
  private batching = false;
  /** State at the last quiet point; becomes an undo entry when typing starts. */
  private stableSnapshot?: MergeSnapshot;
  /**
   * The state this merge opened with — after the auto-apply when that is on.
   * Reset returns here, and `hasProgress` is "the state differs from this".
   */
  private baseline?: MergeSnapshot;
  private typingTimer = 0;
  /** Keybindings register into a page-global service — once per view only. */
  private navKeysInstalled = false;
  /** The context key only this view's editors carry (see installNavigationKeys). */
  private readonly keyScope = `gsMergeView${++mergeViewSerial}`;

  private gutterA?: HTMLElement;
  private gutterB?: HTMLElement;
  private buttonLayerA?: HTMLElement;
  private buttonLayerB?: HTMLElement;
  /** The overview strip at the view's right edge (overviewMap.ts). */
  private map?: OverviewMap;

  public left?: Editor;
  public result?: Editor;
  public right?: Editor;
  public model?: MergeModel;

  private payload?: MergeInitPayload;
  private renderOptions: MergeRenderOptions = {
    whitespace: "none",
    showInner: true,
  };
  /** Open with every non-conflicting change applied, as the baseline. */
  private autoApply = false;
  private largeFile = false;
  private legend?: MergeLegend;
  private lastCounts: MergeCountsView = emptyMergeCounts();

  /** Notified whenever the resolved/pending counts change. */
  public onCountsChanged?: (counts: MergeCountsView) => void;
  /** Notified whenever the result document content changes. */
  public onResultChanged?: () => void;
  /** Notified when the large-file fallback kicks in (line-level only). */
  public onLargeFile?: (large: boolean) => void;
  /** Notified whenever the undo/redo stacks change (toolbar state). */
  public onHistoryChanged?: () => void;
  /** Fired after EVERY (re)build: the line-ending mismatch, or undefined. */
  public onEolMismatch?: (info: EolMismatchInfo | undefined) => void;
  /** Fired after EVERY (re)build: what the Result was seeded with from the file, or undefined. */
  public onSeeded?: (info: SeedInfo | undefined) => void;
  /** The file's own text the Result started from (seedResult.ts), when it did. */
  private seed?: ResultSeed;

  constructor(private readonly container: HTMLElement) {}

  public render(payload: MergeInitPayload, init?: MergeRenderInit): void {
    this.payload = payload;
    this.autoApply =
      init?.autoApplyNonConflicting ?? payload.autoApplyNonConflicting ?? false;
    this.clearHistory(); // new inputs — old snapshots reference dead blocks
    this.build(payload);
  }

  /**
   * Granularity (`showInner`) only re-decorates: every accept, ignore and
   * edit stays, and so does the undo history.
   *
   * A whitespace change re-diffs, which changes the blocks themselves (a
   * whitespace-only edit can join a neighbour, a conflict can become an
   * identical change), so it starts over from the baseline. The shell asks
   * before that throws work away — it has `hasProgress` for exactly this (D7).
   */
  public setRenderOptions(options: Partial<MergeRenderOptions>): void {
    const whitespaceChanged =
      options.whitespace !== undefined &&
      options.whitespace !== this.renderOptions.whitespace;
    this.renderOptions = { ...this.renderOptions, ...options };
    if (whitespaceChanged) {
      this.clearHistory();
      if (this.payload) {
        this.build(this.payload);
      }
      return;
    }
    this.decorate();
  }

  /** Re-measures the three editors (container resized, or just became visible). */
  public layout(): void {
    for (const editor of this.editors) {
      editor.layout();
    }
    this.ribbons?.scheduleDraw();
    this.rebuildButtons();
  }

  /**
   * Mounts the category legend into the shell's slot and keeps it current.
   * The legend outlives rebuilds (a whitespace change, Reset); a second call
   * moves it.
   */
  public attachLegend(slot: HTMLElement): void {
    if (!this.legend) {
      this.legend = new MergeLegend((cats, tone) => this.navigate(1, cats, tone));
    }
    slot.appendChild(this.legend.element);
    this.legend.update(this.lastCounts, this.legendDetail());
  }

  private build(payload: MergeInitPayload): void {
    this.teardown();

    const language = languageForFile(payload.fileName);
    const theme = ensureNativeTheme();
    const font = nativeFontOptions();

    const grid = document.createElement("div");
    grid.className = "jb-merge-grid";
    this.container.replaceChildren(grid);

    const leftBody = this.addPane(grid, 1, payload.oursLabel, true, payload.op?.yours.name);
    this.gutterA = this.addGutter(grid, 2, "a");
    const resultBody = this.addPane(grid, 3, "Result", false);
    this.gutterB = this.addGutter(grid, 4, "b");
    const rightBody = this.addPane(grid, 5, payload.theirsLabel, true, payload.op?.theirs.name);

    // The merge runs on text with "\n" breaks only (the engine normalises the
    // same way), so a side that just rewrote its line endings is not a
    // whole-file conflict. getResultText() writes the model's ending back.
    const base = normalizeEol(payload.base);
    const ours = normalizeEol(payload.ours);
    const theirs = normalizeEol(payload.theirs);

    // Result starts as a copy of base so the block trackers (anchored in base
    // coordinates) line up. With no common ancestor (add/add, or a fallback
    // that couldn't recover a base) base is "", so the result starts empty and
    // the user builds it by accepting sides — same as IntelliJ.
    this.left = monaco.editor.create(leftBody, {
      ...SHARED_OPTIONS,
      ...PANE_SCROLL_OPTIONS,
      ...font,
      theme,
      language,
      value: ours,
      readOnly: true,
      domReadOnly: true,
    });
    this.result = monaco.editor.create(resultBody, {
      ...SHARED_OPTIONS,
      ...PANE_SCROLL_OPTIONS,
      ...font,
      theme,
      language,
      value: base,
      readOnly: false,
    });
    this.right = monaco.editor.create(rightBody, {
      ...SHARED_OPTIONS,
      ...PANE_SCROLL_OPTIONS,
      ...font,
      theme,
      language,
      value: theirs,
      readOnly: true,
      domReadOnly: true,
    });

    this.editors = [this.left, this.result, this.right];

    // Build the merge model for every conflict — including ones with no common
    // ancestor (add/add, or a marker fallback that recovered no base, where
    // payload.base is ""). Guarding this on hasBase used to leave those
    // conflicts as three dead panes showing "0 conflicts".
    this.baseLines = splitLines(base);
    this.oursLines = splitLines(ours);
    this.theirsLines = splitLines(theirs);

    const totalLines =
      this.baseLines.length + this.oursLines.length + this.theirsLines.length;
    this.largeFile = totalLines > LARGE_FILE_LINE_THRESHOLD;
    this.onLargeFile?.(this.largeFile);

    this.model = buildMergeModel(payload.base, payload.ours, payload.theirs, {
      whitespace: this.renderOptions.whitespace,
      // A large file draws no word ranges, so none are computed either.
      innerLineBudget: this.largeFile ? 0 : undefined,
    });
    this.computeOrdinals();
    this.initBlockState();
    // POLISH A1.2: a file already resolved outside the editor — by hand, by
    // git rerere, or by git's own merge outside its markers — seeds the
    // Result with what it has there (seedResult.ts). Every change stays
    // pending, holding the file's text the way a hand edit would.
    this.seed = this.seedFromFile(payload, base, ours, theirs);
    if (this.seed) {
      this.result.getModel()?.setValue(this.seed.text);
    }
    this.installTrackers(this.seed?.spans);

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
        sideFate: (block, side) => this.sideFate(block, side),
        isSeeded: (block) => this.seededUntouched(block),
      },
    );
    // IntelliJ's "error stripe", at the view's right edge — never on a seam.
    this.map = new OverviewMap(grid, 6, this.result, () => this.model, {
      resultSpanOf: (block) => this.currentResultSpan(block),
      isResolved: (block) => this.isResolved(block),
    });

    this.installViewListeners();
    this.installNavigationKeys();

    // The auto-applied state IS the baseline: no undo entry, `hasProgress`
    // stays false, and Reset comes back here.
    this.baseline = undefined;
    if (this.autoApply) {
      const wasSuppressed = this.suppressHistory;
      this.suppressHistory = true;
      try {
        this.applyAllNonConflicting();
      } finally {
        this.suppressHistory = wasSuppressed;
      }
    }
    this.baseline = this.captureSnapshot("Baseline");

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
    this.onEolMismatch?.(this.model?.eolMismatch);
    this.onSeeded?.(this.seed ? { kind: this.seed.kind, changes: this.seed.changes } : undefined);
  }

  /**
   * The seed for this build, or undefined to start from base: only a file git
   * holds the three versions of (the stages), whose text says something
   * base and git's markers do not.
   */
  private seedFromFile(payload: MergeInitPayload, base: string, ours: string, theirs: string): ResultSeed | undefined {
    if (!this.model || payload.source !== "git-stages") {
      return undefined;
    }
    const working = normalizeEol(payload.result ?? "");
    if (working === "" || working === base) {
      return undefined;
    }
    try {
      return seedResult(preparedFrom(this.model, base, ours, theirs), working);
    } catch {
      // A file that cannot be read against the merge starts from base, as before.
      return undefined;
    }
  }

  /**
   * Scroll to the first change the Result was seeded with from the file — the
   * one git (or a hand edit) already merged outside the markers — so the
   * notice that says it exists can show where it is. False when there is none.
   */
  public revealSeeded(): boolean {
    const ids = new Set((this.seed?.regions ?? []).flatMap((r) => r.blockIds));
    const first = this.model?.blocks.find((block) => ids.has(block.id));
    if (!first || !this.result) {
      return false;
    }
    const line = this.currentResultSpan(first).start;
    this.result.revealLineInCenter(line);
    this.result.setPosition({ lineNumber: line, column: 1 });
    this.result.focus();
    return true;
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
    /** The side's own name (a branch, a sha): kept on screen when the title is cut. */
    name?: string,
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
    // The words around the side's name give way first; the name itself stays
    // (it was cut from the END — "Already rebased commits and commits from …"
    // lost "master", the one word that says which side this is).
    const parts = splitTitle(titleText, name);
    if (parts) {
      label.classList.add("jb-pane-label-split");
      for (const [cls, text] of [
        ["jb-pane-pre", parts.pre],
        ["jb-pane-name", parts.name],
        ["jb-pane-post", parts.post],
      ] as const) {
        if (!text) continue;
        const s = document.createElement("span");
        s.className = cls;
        s.textContent = text;
        label.appendChild(s);
      }
    } else {
      label.textContent = titleText;
    }
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
        tookLeft: false,
        tookRight: false,
        applied: false,
      });
    }
  }

  /** Numbers every block within its category, in document order. */
  private computeOrdinals(): void {
    this.ordinals.clear();
    const blocks = this.model?.blocks ?? [];
    const totals = emptyCategoryCounts();
    for (const block of blocks) {
      totals[category(block)].total++;
    }
    const seen = emptyCategoryCounts();
    for (const block of blocks) {
      const cat = category(block);
      seen[cat].total++;
      this.ordinals.set(block.id, { index: seen[cat].total, total: totals[cat].total });
    }
  }

  /** One tracker per block, on its base span — or on `spans` (a seeded Result). */
  private installTrackers(spans?: ReadonlyMap<number, LineSpan>): void {
    const model = this.result?.getModel();
    if (!model || !this.model) {
      return;
    }
    const at = (block: ChangeBlock): LineSpan => spans?.get(block.id) ?? block.baseSpan;
    const specs: monaco.editor.IModelDeltaDecoration[] = this.model.blocks.map(
      (block) => ({
        range: this.trackerRange(model, at(block)),
        options: {
          stickiness:
            monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
        },
      }),
    );
    const ids = model.deltaDecorations([], specs);
    this.model.blocks.forEach((block, index) => {
      this.trackers.set(block.id, ids[index]);
      this.noteEof(block, at(block), model);
    });
  }

  /** Records whether a block's span owns the end of the document (see eofKind). */
  private noteEof(block: ChangeBlock, span: LineSpan, model: monaco.editor.ITextModel): void {
    if (span.endExclusive > model.getLineCount()) {
      this.eofKind.set(block.id, isEmptySpan(span) ? "point" : "span");
    } else {
      this.eofKind.delete(block.id);
    }
  }

  private trackerRange(
    model: monaco.editor.ITextModel,
    span: LineSpan,
  ): monaco.Range {
    const lineCount = model.getLineCount();
    if (span.start > lineCount) {
      // The point after the last line — the end of the document. Said
      // explicitly rather than left to Monaco's clamping of line lineCount + 1
      // (which lands in the same place); what makes it read back as "after
      // the last line", not "before it", is the block's eofKind.
      const column = model.getLineMaxColumn(lineCount);
      return new monaco.Range(lineCount, column, lineCount, column);
    }
    if (isEmptySpan(span)) {
      return new monaco.Range(span.start, 1, span.start, 1);
    }
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

  /**
   * Marks one side processed — `took` when its text went into the Result,
   * else discarded. A change made the same on both sides is ONE change: either
   * side settles both, the same way (either arrow takes it, either × sets it
   * aside).
   */
  private markSideDone(state: BlockState, block: ChangeBlock, side: Side, took: boolean): void {
    if (side === "left") {
      state.doneLeft = true;
      state.tookLeft = took;
    } else {
      state.doneRight = true;
      state.tookRight = took;
    }
    if (block.kind === "both-same") {
      state.doneLeft = state.doneRight = true;
      state.tookLeft = state.tookRight = took;
    }
  }

  /** What became of one side: still to decide, taken into the Result, or discarded. */
  private sideFate(block: ChangeBlock, side: Side): SideFate {
    const state = this.blockState.get(block.id);
    if (!state) {
      return "pending";
    }
    const done = side === "left" ? state.doneLeft : state.doneRight;
    if (!done) {
      return "pending";
    }
    return (side === "left" ? state.tookLeft : state.tookRight) ? "took" : "discarded";
  }

  /** A handled block's traces in words: each side's, and the Result's once settled. */
  private traceWords(block: ChangeBlock): { left?: string; right?: string; result?: string } {
    return fateWords(
      block,
      {
        left: block.left ? this.sideFate(block, "left") : undefined,
        right: block.right ? this.sideFate(block, "right") : undefined,
      },
      { left: this.sideTitle("left"), right: this.sideTitle("right") },
    );
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
    const lineCount = model.getLineCount();
    const eof = this.eofKind.get(block.id);
    if (
      eof &&
      range.endLineNumber === lineCount &&
      range.endColumn === model.getLineMaxColumn(lineCount)
    ) {
      // The block owns the end of the document, so its range's end means
      // "through the last line" — even when that line is empty and the range
      // cannot show it (see eofKind).
      if (eof === "point" && range.isEmpty()) {
        return { start: lineCount + 1, endExclusive: lineCount + 1 };
      }
      return { start: range.startLineNumber, endExclusive: lineCount + 1 };
    }
    if (range.isEmpty()) {
      // An insertion point. At the end of a non-empty line it is the point
      // AFTER that line, not before it.
      const line = range.startLineNumber;
      const after = range.startColumn > 1 && range.startColumn === model.getLineMaxColumn(line);
      const start = after ? line + 1 : line;
      return { start, endExclusive: start };
    }
    const endExclusive = range.endColumn === 1 ? range.endLineNumber : range.endLineNumber + 1;
    return { start: range.startLineNumber, endExclusive };
  }

  /** "yours" / "theirs", plus the side's real name when the host knows it. */
  private sideWords(side: Side): { role: string; name?: string } {
    const view = side === "left" ? this.payload?.op?.yours : this.payload?.op?.theirs;
    const name = view?.name?.trim();
    return { role: side === "left" ? "yours" : "theirs", name: name || undefined };
  }

  /** "Yours (test)" / "Theirs (master)": the role, and the side's real name when the host knows it. */
  private sideTitle(side: Side): string {
    const { name } = this.sideWords(side);
    const role = side === "left" ? "Yours" : "Theirs";
    return name ? `${role} (${name})` : role;
  }

  /** " (2 of 5)": where the block stands in its category, for a screen reader. */
  private ordinalText(block: ChangeBlock): string {
    const ordinal = this.ordinals.get(block.id);
    return ordinal && ordinal.total > 1 ? ` (${ordinal.index} of ${ordinal.total})` : "";
  }

  // --- interactions ---

  public acceptSide(block: ChangeBlock, side: Side, mode: AcceptMode): void {
    const state = this.blockState.get(block.id);
    if (!state || this.isSideDone(block, side)) {
      return;
    }
    const sideLines = this.sideLines(block, side);
    const span = this.currentResultSpan(block);

    const append = mode === "append" || (mode === "auto" && state.applied);
    this.pushHistory(
      `${append ? "Append" : "Accept"} ${this.sideWords(side).role}, change ${block.id + 1}`,
    );
    const lines = append ? [...this.readResultLines(span), ...sideLines] : sideLines;
    // Re-anchor the tracker onto the written lines so alignment, highlights
    // and follow-up accepts keep seeing the block's real extent.
    this.retrackBlock(block, this.replaceResultLines(span, lines));

    state.applied = true;
    this.markSideDone(state, block, side, true);
    // JetBrains (MergeConflictModel.replaceChange): taking one side of a
    // conflict resolves the whole conflict when the other side has no lines
    // in it — there is nothing left to add after it (that side is discarded).
    const other: Side = side === "left" ? "right" : "left";
    if (
      category(block) === "conflict" &&
      (other === "left" ? block.left : block.right) &&
      !this.isSideDone(block, other) &&
      isEmptySpan(sideBlockSpan(block, other))
    ) {
      this.markSideDone(state, block, other, false);
    }
    if (!this.batching) {
      this.refresh();
    }
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
    this.noteEof(block, span, model);
  }

  /** Marks one side processed without touching the result (the × action). */
  public ignoreSide(block: ChangeBlock, side: Side): void {
    const state = this.blockState.get(block.id);
    if (!state || this.isSideDone(block, side)) {
      return;
    }
    this.pushHistory(`Ignore ${this.sideWords(side).role}, change ${block.id + 1}`);
    this.markSideDone(state, block, side, false);
    if (!this.batching) {
      this.refresh();
    }
  }

  /**
   * Whether the wand can still apply both sides of this block: a resolvable
   * conflict nobody has touched — neither side taken or ignored, and the
   * result's lines still the base's (so a hand edit is never overwritten).
   */
  private isWandable(block: ChangeBlock): boolean {
    if (!block.resolvable || block.resolvedText === undefined) {
      return false;
    }
    const state = this.blockState.get(block.id);
    if (!state || state.applied || state.doneLeft || state.doneRight) {
      return false;
    }
    return this.holdsBase(block);
  }

  /** The block's lines in the Result are still exactly base's. */
  private holdsBase(block: ChangeBlock): boolean {
    const baseRegion = this.baseLines.slice(
      block.baseSpan.start - 1,
      block.baseSpan.endExclusive - 1,
    );
    const now = this.readResultLines(this.currentResultSpan(block));
    return now.length === baseRegion.length && now.every((line, i) => line === baseRegion[i]);
  }

  /** Writes a resolvable conflict's `resolvedText`: both sides' edits, in base order. */
  private applyBothSides(block: ChangeBlock): void {
    const state = this.blockState.get(block.id);
    if (!state || !this.isWandable(block) || block.resolvedText === undefined) {
      return;
    }
    this.pushHistory(`Apply both sides, change ${block.id + 1}`);
    const span = this.currentResultSpan(block);
    // Never empty: both sides' regions are non-empty for a resolvable block,
    // so "" here is one empty line, which splitLines says.
    this.retrackBlock(block, this.replaceResultLines(span, splitLines(block.resolvedText)));
    state.applied = true;
    state.doneLeft = state.doneRight = true;
    // Both sides' edits went in.
    state.tookLeft = state.tookRight = true;
    if (!this.batching) {
      this.refresh();
    }
  }

  // --- bulk auto-resolve actions ---

  /**
   * "Apply non-conflicting changes: All" — every identical and one-sided
   * block (JetBrains parity: an identical change is non-conflicting).
   */
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
      "Apply non-conflicting changes: all",
    );
  }

  /**
   * "Apply non-conflicting changes: Yours / Theirs" — that side's one-sided
   * changes, and the identical ones (taken as that side's version, which
   * matters only when they differ in whitespace).
   */
  public applyNonConflictingSide(side: Side): void {
    this.bulkAccept(
      (block) => {
        if (block.kind === "both-same") {
          return side;
        }
        if (side === "left" && block.kind === "left-only") {
          return "left";
        }
        if (side === "right" && block.kind === "right-only") {
          return "right";
        }
        return undefined;
      },
      false,
      `Apply non-conflicting changes: ${this.sideWords(side).role}`,
    );
  }

  /**
   * Resolves the whole merge as the left version: every block with a left
   * side takes it; right-only blocks are rejected (the base text already
   * matches the left version there). Mirrors the dialog's "Accept Yours".
   */
  public acceptAllLeft(): void {
    this.bulkAccept(
      (block) => (block.left ? "left" : undefined),
      true,
      "Accept yours everywhere",
    );
  }

  /** Resolves the whole merge as the right version (see acceptAllLeft). */
  public acceptAllRight(): void {
    this.bulkAccept(
      (block) => (block.right ? "right" : undefined),
      true,
      "Accept theirs everywhere",
    );
  }

  /**
   * The magic wand: applies both sides of every resolvable conflict (their
   * edits don't overlap). Identical changes are "Apply non-conflicting"'s job.
   */
  public resolveSimpleConflicts(): void {
    if (!this.model) {
      return;
    }
    const targets = this.model.blocks
      .filter((block) => this.isWandable(block))
      .sort((a, b) => b.baseSpan.start - a.baseSpan.start);
    if (targets.length === 0) {
      return;
    }
    this.pushHistory("Resolve simple conflicts");
    const wasSuppressed = this.suppressHistory;
    const wasBatching = this.batching;
    this.suppressHistory = true;
    this.batching = true;
    try {
      for (const block of targets) {
        this.applyBothSides(block);
      }
    } finally {
      this.suppressHistory = wasSuppressed;
      this.batching = wasBatching;
    }
    this.refresh();
  }

  /** Whether the wand has anything to do (a resolvable conflict is pending). */
  public hasSimpleConflicts(): boolean {
    return (this.model?.blocks ?? []).some((block) => this.isWandable(block));
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
    const wasBatching = this.batching;
    this.suppressHistory = true;
    this.batching = true;
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
        // considered processed — set aside (accepted-side blocks already hold
        // the chosen version; unchosen blocks keep base, i.e. the chosen
        // side's text).
        const state = this.blockState.get(block.id);
        if (state) {
          state.doneLeft = state.doneRight = true;
        }
      }
    } finally {
      this.suppressHistory = wasSuppressed;
      this.batching = wasBatching;
    }
    if (!this.batching) {
      this.refresh();
    }
  }

  // --- change navigation (F7 / Shift+F7, legend chips) ---

  /**
   * Reveals the next PENDING block below the result caret; wraps around.
   * With a category, only pending blocks of that category (a legend chip).
   */
  public goToNextChange(cat?: MergeCategory): void {
    this.navigate(1, cat ? [cat] : undefined);
  }

  public goToPrevChange(cat?: MergeCategory): void {
    this.navigate(-1, cat ? [cat] : undefined);
  }

  /**
   * With categories, only pending blocks of those (a legend item may name
   * two); with a paint tone too, only those painted in it (a legend item is a
   * colour, and removed lines are grey whatever their category).
   */
  private navigate(direction: 1 | -1, cats?: readonly MergeCategory[], tone?: PaintTone): void {
    if (!this.model || !this.result) {
      return;
    }
    const pending = this.model.blocks.filter(
      (b) => !this.isResolved(b) && (!cats || cats.includes(category(b))) && (!tone || paintTone(b) === tone),
    );
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

  /**
   * The LINES a side contributes to a block — an array, never a joined
   * string: joined, one empty line ([""]) and no lines at all ([]) are both
   * "", and accepting a side that inserted a single blank line wrote nothing.
   */
  private sideLines(block: ChangeBlock, side: Side): string[] {
    const change = side === "left" ? block.left : block.right;
    if (!change) {
      return [];
    }
    const lines = side === "left" ? this.oursLines : this.theirsLines;
    // The side's FULL block region, not just its change hunk: a clustered block
    // can include lines this side never touched (passthrough), and accepting
    // the side must carry them along — otherwise resolving a modify/delete (or
    // any asymmetric conflict) silently drops the unchanged lines.
    const span = sideBlockSpan(block, side);
    return lines.slice(span.start - 1, span.endExclusive - 1);
  }

  private readResultLines(span: LineSpan): string[] {
    const model = this.result?.getModel();
    if (!model) {
      return [];
    }
    const last = Math.min(span.endExclusive - 1, model.getLineCount());
    const lines: string[] = [];
    for (let line = span.start; line <= last; line++) {
      lines.push(model.getLineContent(line));
    }
    return lines;
  }

  /**
   * Replaces a block's lines in the result and returns the span they now
   * occupy. Text is lines joined by "\n", so where the block sits decides who
   * owns each break:
   * - lines follow it: every written line ends with a break;
   * - it runs to the end: the last written line takes none (the side's own
   *   region ends with an empty line when its file ends with a break);
   * - nothing is written at the end: the break BEFORE the block goes too, or
   *   removing a final newline (or the file's last lines) left one behind;
   * - an insertion after the last line takes the break before it — unless the
   *   document is empty, whose one "line" is no line at all.
   */
  private replaceResultLines(span: LineSpan, lines: string[]): LineSpan {
    const editor = this.result;
    const model = editor?.getModel();
    if (!editor || !model) {
      return span;
    }
    // The line-break rules live in lineEdits.ts, shared with the 2-way diff's
    // copy arrow, which had its own copy of them and the same bugs.
    const plan = planLineWrite(lineDocOf(model), span, lines);
    if (!plan) {
      return span; // nothing to write, and nothing to remove
    }
    const r = plan.range;
    const range = new monaco.Range(r.startLine, r.startColumn, r.endLine, r.endColumn);
    const { text, next } = plan;
    // Suppressed so the content listener doesn't mistake this for typing.
    // No forceMoveMarkers: every OTHER block's tracker keeps its own edge (the
    // trackers never grow at their edges) — forcing them to the end of the
    // insert dragged a neighbour that ended at the insertion point over the
    // new lines. This block's own tracker is re-set by the caller.
    const wasSuppressed = this.suppressHistory;
    this.suppressHistory = true;
    try {
      editor.executeEdits("jbMerge", [{ range, text }]);
    } finally {
      this.suppressHistory = wasSuppressed;
    }
    return next;
  }

  // --- rendering refresh ---

  private refresh(): void {
    if (!this.model || !this.left || !this.result || !this.right) {
      return;
    }
    this.installAlignment(this.model);
    this.decorate();
    this.ribbons?.scheduleDraw();
    this.rebuildButtons();
    this.notifyCounts();
    // Re-arm the typing-burst base: every gesture ends here, and the next
    // manual keystroke must snapshot the state as of NOW — a stale pre-action
    // snapshot would make its undo entry revert the action too.
    this.stableSnapshot = this.captureSnapshot("Edit result");
  }

  /** Re-applies the pane decorations (granularity changes need only this). */
  private decorate(): void {
    if (!this.model) {
      return;
    }
    this.decorations?.apply(this.model, {
      resultSpanOf: (block) => this.currentResultSpan(block),
      isResolved: (block) => this.isResolved(block),
      isSideDone: (block, side) => this.isSideDone(block, side),
      sideFate: (block, side) => this.sideFate(block, side),
      traceWords: (block) => this.traceWords(block),
      isApplied: (block) => this.blockState.get(block.id)?.applied ?? false,
      isSeeded: (block) => this.seededUntouched(block),
      showInner: this.renderOptions.showInner && !this.largeFile,
    });
    this.map?.scheduleDraw();
  }

  /**
   * A change the file already had merged OUTSIDE its conflict markers (by
   * git's own merge, or by hand) that the Result was seeded with and nothing
   * has touched since. It is still pending — marked, with its controls — but
   * its Result already holds the merged text, so it is painted like a
   * half-settled one with a hover that says so: it looked exactly like the
   * open conflicts around it (the critic, r0923, stress/userService.js).
   */
  private seededUntouched(block: ChangeBlock): boolean {
    const seed = this.seed;
    if (!seed || seed.kind !== "markers" || this.isResolved(block)) {
      return false;
    }
    const state = this.blockState.get(block.id);
    if (!state || state.applied || state.doneLeft || state.doneRight) {
      return false;
    }
    const region = seed.regions.find((r) => r.blockIds.length === 1 && r.blockIds[0] === block.id);
    if (!region) {
      return false;
    }
    const now = this.readResultLines(this.currentResultSpan(block));
    return now.length === region.lines.length && now.every((line, i) => line === region.lines[i]);
  }

  /** The overview strip (tests read its marks). */
  public get overview(): OverviewMap | undefined {
    return this.map;
  }

  /** Coalesces button-layer rebuilds to one per frame (or 32 ms, when no frame comes). */
  private scheduleButtons(): void {
    if (this.cancelButtons) {
      return;
    }
    this.cancelButtons = scheduleFrame(() => {
      this.cancelButtons = undefined;
      this.rebuildButtons();
    });
  }

  /**
   * Rebuilds every control, synchronously. Each side of a pending change that
   * is still to be dealt with gets the two controls JetBrains and VS Code
   * users know: [×][→] in Yours' gutter, [←][×] in Theirs' — accept toward the
   * result, or ignore. That holds for every category, a change made the same
   * on both sides included (either side accepts it, like JetBrains). Once one
   * side of a conflict is in, the other side's arrow stays an arrow and says
   * what it now does — "Add Theirs after Yours" — and its × says "Discard
   * Theirs: keep Yours as the result". A handled side has none.
   */
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

    const height =
      this.gutterA?.clientHeight || this.container.clientHeight || 0;
    const lineHeight = this.result.getOption(
      monaco.editor.EditorOption.lineHeight,
    );

    // The side icons live in the gutter's rectangular strip, which tracks the
    // SIDE pane's rows — so they anchor to the side editor's geometry, not
    // the result's, and can never drift out of the coloured band.
    const place = (editor: Editor, span: LineSpan): number | undefined => {
      // The point after an unterminated last line is that line's bottom edge.
      const top = lineTopY(editor, span.start, lineHeight);
      // Centre the icon row on the first line (or on the boundary for
      // insertion points), like IntelliJ anchors its gutter actions.
      const y = isEmptySpan(span)
        ? top - ACTION_ROW_HEIGHT / 2
        : top + Math.max(1, (lineHeight - ACTION_ROW_HEIGHT) / 2);
      return y < -24 || y > height + 24 ? undefined : y;
    };

    for (const block of this.model.blocks) {
      const words = this.isResolved(block) || this.halfDone(block) ? this.traceWords(block) : undefined;
      for (const [side, editor, layer] of [
        ["left", this.left, this.buttonLayerA],
        ["right", this.right, this.buttonLayerB],
      ] as const) {
        if (!(side === "left" ? block.left : block.right)) {
          continue;
        }
        const span = sideBlockSpan(block, side);
        if (!this.isSideDone(block, side)) {
          const y = place(editor, span);
          if (y !== undefined) {
            layer.appendChild(this.makeActions(block, side, y));
          }
          continue;
        }
        // A handled side has no controls, only its trace — and the trace's
        // words, for a pointer (a tooltip) and a screen reader.
        const said = words?.[side];
        if (said) {
          const note = this.makeTraceNote(block, side, editor, span, lineHeight, height, said);
          if (note) {
            layer.appendChild(note);
          }
        }
      }
    }
  }

  /**
   * What a handled side says, where its controls were: a quiet element over
   * its band in the gutter's icon strip, with the words as its tooltip and
   * its accessible name ("Conflict 2 of 5: Took Yours (test)"). Nothing to
   * see — the trace is the band itself — nothing to press.
   */
  private makeTraceNote(
    block: ChangeBlock,
    side: Side,
    editor: Editor,
    span: LineSpan,
    lineHeight: number,
    height: number,
    words: string,
  ): HTMLElement | undefined {
    const [y0, y1] = spanY(editor, span, lineHeight);
    const top = isEmptySpan(span) ? y0 - 3 : y0;
    const bottom = isEmptySpan(span) ? y0 + 3 : y1;
    if (bottom < 0 || top > height) {
      return undefined;
    }
    const note = document.createElement("span");
    note.className = `jb-trace-note jb-trace-note-${side}`;
    note.dataset.block = String(block.id);
    note.dataset.side = side;
    note.dataset.fate = this.sideFate(block, side);
    note.style.top = `${Math.round(top)}px`;
    note.style.height = `${Math.max(6, Math.round(bottom - top))}px`;
    note.style.width = `${MERGE_ICON_STRIP}px`;
    const ordinal = this.ordinals.get(block.id);
    const where = ordinal && ordinal.total > 1 ? ` ${ordinal.index} of ${ordinal.total}` : "";
    note.title = words;
    note.setAttribute("role", "img");
    note.setAttribute("aria-label", `${CATEGORY_NOUNS[category(block)]}${where}: ${words}`);
    return note;
  }

  /**
   * A control that fires on a PRESS for the mouse (so the result editor keeps
   * its focus and caret) and on a click for the keyboard (Enter / Space fire
   * no mousedown — the controls used to do nothing for keyboard users).
   */
  private makeButton(
    className: string,
    icon: string,
    title: string,
    label: string,
    act: (event: MouseEvent) => void,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.appendChild(iconElement(icon));
    button.title = title;
    button.setAttribute("aria-label", label);
    button.addEventListener("mousedown", (event) => {
      if (event.button !== 0) {
        return;
      }
      event.preventDefault();
      act(event);
    });
    button.addEventListener("click", (event) => {
      if (event.detail === 0) {
        act(event);
      }
    });
    return button;
  }

  private makeActions(block: ChangeBlock, side: Side, y: number): HTMLElement {
    const group = document.createElement("div");
    group.className = "jb-change-actions";
    group.style.top = `${Math.round(y)}px`;
    const cat = category(block);
    group.dataset.block = String(block.id);
    group.dataset.category = cat;
    group.dataset.side = side;

    const tone = paintTone(block);
    const who = this.sideTitle(side);
    const other = this.sideTitle(side === "left" ? "right" : "left");
    const what = CATEGORY_WORDS[cat];
    const ordinal = this.ordinalText(block);
    // The other side of this conflict is already in the result: this one is
    // ADDED after it. The control stays the same arrow (JetBrains bends it);
    // its words say what it now does. And its × no longer "ignores" in the
    // abstract: it discards this side, and the result is settled as it is.
    const state = this.blockState.get(block.id);
    const addAfter = cat === "conflict" && (state?.applied ?? false);
    const otherIn = cat === "conflict" && this.halfDone(block) !== undefined;
    // The same change on both sides is one change, green on both sides:
    // either arrow takes it, either × sets it aside — for both.
    const same = cat === "same";
    const oneSided = cat === "yours-only" || cat === "theirs-only";

    const acceptWords = addAfter
      ? `Add ${who} after ${other}`
      : same
        ? SAME_ARROW_WORDS
        : oneSided
          ? `Accept ${who}: ${ONE_SIDE_WORDS}`
          : `Accept ${who} for ${what}`;
    const accept = this.makeButton(
      `jb-gutter-btn jb-btn-accept jb-tone-${tone}`,
      side === "left" ? chevronDoubleRight : chevronDoubleLeft,
      addAfter || same
        ? acceptWords
        : `${acceptWords}\nCtrl/⌘-click: add it after what the result has`,
      `${acceptWords}${ordinal}`,
      (event) => {
        const mode: AcceptMode =
          (event.ctrlKey || event.metaKey) && !same ? "append" : "auto";
        this.acceptSide(block, side, mode);
      },
    );

    const ignoreWords = otherIn
      ? addAfter
        ? `Discard ${who}: keep ${other} as the result`
        : `Discard ${who} too: the result keeps what it has`
      : same
        ? "Discard this change on both sides"
        : `Ignore ${who} for ${what}`;
    const ignore = this.makeButton(
      "jb-gutter-btn jb-btn-ignore",
      cross,
      otherIn ? ignoreWords : `${ignoreWords}\nThe result keeps what it has`,
      `${ignoreWords}${ordinal}`,
      () => this.ignoreSide(block, side),
    );

    // IntelliJ keeps × on the outer edge (next to the side pane) and the
    // accept arrow next to the result column.
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
    const byCategory = emptyCategoryCounts();
    let pending = 0;
    let conflictsPending = 0;
    let resolvableConflictsPending = 0;
    let pendingChanged = 0;
    for (const block of this.model.blocks) {
      const cat = category(block);
      byCategory[cat].total++;
      if (this.isResolved(block)) {
        continue;
      }
      pending++;
      byCategory[cat].pending++;
      if (!this.holdsBase(block)) {
        pendingChanged++;
      }
      if (cat === "conflict") {
        conflictsPending++;
        if (this.isWandable(block)) {
          resolvableConflictsPending++;
        }
      }
    }
    const counts: MergeCountsView = {
      total: this.model.blocks.length,
      pending,
      conflictsPending,
      byCategory,
      resolvableConflictsPending,
      pendingChanged,
      hasProgress: this.hasProgress(),
    };
    this.lastCounts = counts;
    this.legend?.update(counts, this.legendDetail());
    this.onCountsChanged?.(counts);
  }

  /**
   * The pending conflicts with one side in (taken or ignored) and the other
   * still to decide — JetBrains: that side is resolved, the change is not.
   * The legend says it in words ("Yours taken, Theirs to decide").
   */
  private legendDetail(): LegendDetail {
    const halfDone: LegendDetail["halfDone"] = [];
    // Each colour's count, by the paint each change wears (paint.ts): the
    // legend names colours, and removed lines are grey whatever their category.
    const tones = Object.fromEntries(
      PAINT_TONES.map((tone) => [tone, { total: 0, pending: 0, yours: 0, theirs: 0, both: 0 }]),
    ) as NonNullable<LegendDetail["tones"]>;
    for (const block of this.model?.blocks ?? []) {
      const half = this.halfDone(block);
      if (half) {
        halfDone.push(half);
      }
      const tally = tones[paintTone(block)];
      tally.total++;
      if (!this.isResolved(block)) {
        tally.pending++;
        const cat = category(block);
        if (cat === "yours-only") tally.yours++;
        else if (cat === "theirs-only") tally.theirs++;
        else if (cat === "same") tally.both++;
      }
    }
    return { halfDone, tones };
  }

  /** Which side of a pending block is in, when exactly one of its own sides is. */
  private halfDone(block: ChangeBlock): LegendDetail["halfDone"][number] | undefined {
    const state = this.blockState.get(block.id);
    if (!state || !block.left || !block.right || this.isResolved(block)) {
      return undefined;
    }
    if (state.doneLeft === state.doneRight) {
      return undefined;
    }
    return { done: state.doneLeft ? "yours" : "theirs", taken: state.applied };
  }

  /** Whether anything differs from the baseline (text, or any block's state). */
  private hasProgress(): boolean {
    const baseline = this.baseline;
    const model = this.result?.getModel();
    if (!baseline || !model) {
      return false;
    }
    if (model.getValue() !== baseline.resultText) {
      return true;
    }
    for (const [id, state] of this.blockState) {
      const was = baseline.blockState.get(id);
      if (
        !was ||
        was.doneLeft !== state.doneLeft ||
        was.doneRight !== state.doneRight ||
        was.tookLeft !== state.tookLeft ||
        was.tookRight !== state.tookRight ||
        was.applied !== state.applied
      ) {
        return true;
      }
    }
    return false;
  }

  /** The result text to write back, in the model's line ending (Yours'). */
  public getResultText(): string {
    const text =
      this.result?.getModel()?.getValue(monaco.editor.EndOfLinePreference.LF) ?? "";
    const eol = this.model?.eol ?? "LF";
    return eol === "LF" ? text : text.replace(/\n/g, eolChars(eol));
  }

  /**
   * The Result with every change the editor has NOT settled put back to its
   * base lines (POLISH A1.1), in the model's line ending:
   *
   * - a conflict with one side taken, or one side ignored, and the other still
   *   to decide. Its Result holds that side's text, which reads exactly like a
   *   conflict settled as that side — and the host's document rule wrote it to
   *   the file as settled, no markers, one accept after opening;
   * - a region seeded from the file (seedResult.ts) that nothing has touched
   *   since: the host keeps the file's own lines there.
   *
   * What the host writes to the file before Apply is built from THIS text
   * (documentSync.ts); Apply still writes getResultText().
   */
  public getUnsettledText(): string {
    const model = this.result?.getModel();
    if (!model || !this.model) {
      return this.getResultText();
    }
    const lines = model.getValue(monaco.editor.EndOfLinePreference.LF).split("\n");
    const edits: Array<{ from: number; to: number; lines: string[] }> = [];
    const covered = new Set<number>();
    const byId = new Map(this.model.blocks.map((b) => [b.id, b]));
    for (const region of this.seed?.regions ?? []) {
      const blocks = region.blockIds.map((id) => byId.get(id)).filter((b): b is ChangeBlock => !!b);
      if (blocks.length === 0 || blocks.some((b) => this.isResolved(b) || (this.blockState.get(b.id)?.applied ?? false))) {
        continue;
      }
      const spans = blocks.map((b) => this.currentResultSpan(b));
      const from = Math.min(...spans.map((s) => s.start)) - 1;
      const to = Math.max(...spans.map((s) => s.endExclusive)) - 1;
      const now = lines.slice(from, to);
      if (now.length !== region.lines.length || now.some((l, i) => l !== region.lines[i])) {
        continue;
      }
      edits.push({ from, to, lines: this.baseLines.slice(region.baseFrom, region.baseTo) });
      for (const b of blocks) covered.add(b.id);
    }
    for (const block of this.model.blocks) {
      if (covered.has(block.id) || category(block) !== "conflict" || this.isResolved(block)) {
        continue;
      }
      const state = this.blockState.get(block.id);
      if (!state || (!state.applied && !state.doneLeft && !state.doneRight)) {
        continue;
      }
      if (state.applied || this.halfDone(block)) {
        const span = this.currentResultSpan(block);
        edits.push({
          from: span.start - 1,
          to: span.endExclusive - 1,
          lines: this.baseLines.slice(block.baseSpan.start - 1, block.baseSpan.endExclusive - 1),
        });
      }
    }
    edits.sort((a, b) => b.from - a.from || b.to - a.to);
    let lastFrom = Infinity;
    for (const edit of edits) {
      if (edit.to > lastFrom) {
        continue; // overlapping: never guess
      }
      lines.splice(edit.from, edit.to - edit.from, ...edit.lines);
      lastFrom = edit.from;
    }
    const text = lines.join("\n");
    const eol = this.model.eol ?? "LF";
    return eol === "LF" ? text : text.replace(/\n/g, eolChars(eol));
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
        // Typing is progress too (the shell asks before a whitespace change
        // discards it), and it can take a conflict out of the wand's reach.
        this.notifyCounts();
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

  /**
   * Back to the baseline — the auto-applied state when that was on, else
   * base. Undoable: block ids are deterministic for the same payload +
   * options, so pre-reset snapshots stay valid against the rebuilt model.
   */
  public reset(): void {
    if (this.payload) {
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
          live.tookLeft = saved.tookLeft;
          live.tookRight = saved.tookRight;
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
    //
    // And the rules are GLOBAL: with no when-clause, F7 and ⌘Z/⌘Y in ANY
    // Monaco editor on the page (the desktop's diff, a message box) drove this
    // merge's navigation and history. Each rule is scoped by a context key
    // only this view's editors carry, so it fires only while one of them has
    // the keyboard. The key is set again on every build — rebuilt editors are
    // new editors.
    for (const editor of this.editors) {
      editor.createContextKey(this.keyScope, true);
    }
    if (this.navKeysInstalled) {
      return;
    }
    this.navKeysInstalled = true;
    const when = this.keyScope;
    for (const editor of this.editors) {
      editor.addCommand(monaco.KeyCode.F7, () => this.goToNextChange(), when);
      editor.addCommand(
        monaco.KeyMod.Shift | monaco.KeyCode.F7,
        () => this.goToPrevChange(),
        when,
      );
      // Shadow Monaco's native undo/redo: text-only undo desyncs blockState
      // and the tracked spans, so the merge owns its own history.
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyZ,
        () => this.undo(),
        when,
      );
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyZ,
        () => this.redo(),
        when,
      );
      editor.addCommand(
        monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY,
        () => this.redo(),
        when,
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
      this.result.onDidLayoutChange(() => this.scheduleButtons()),
      this.result.onDidChangeModelContent(() => {
        if (!this.suppressHistory) {
          this.onUserEdit(); // manual typing — make it undoable
          // The FIRST keystroke is progress now, not after the re-align
          // debounce: a shell that asks "is there work to lose?" in the same
          // tick (the whitespace confirm, D7) must hear yes. Later keystrokes
          // cannot change the answer, so they wait for the debounce.
          if (!this.lastCounts.hasProgress) {
            this.notifyCounts();
          }
        }
        this.ribbons?.scheduleDraw();
        this.map?.scheduleDraw();
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
      // The map's colours are read from the live palette as it draws, and a
      // high contrast theme draws points twice as thick (mergePointPx).
      this.decorate();
      this.ribbons?.scheduleDraw();
    });
    this.themeObserver.observe(document.body, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  /** Tears the view down for good: the editors, and the legend it mounted. */
  public dispose(): void {
    this.teardown();
    this.legend?.dispose();
    this.legend = undefined;
  }

  /** Releases the editors and overlays — every build starts here. */
  private teardown(): void {
    if (this.realignTimer) {
      window.clearTimeout(this.realignTimer);
      this.realignTimer = 0;
    }
    if (this.typingTimer) {
      window.clearTimeout(this.typingTimer);
      this.typingTimer = 0;
    }
    this.cancelButtons?.();
    this.cancelButtons = undefined;
    this.resizeObserver?.disconnect();
    this.resizeObserver = undefined;
    this.themeObserver?.disconnect();
    this.themeObserver = undefined;
    this.ribbons?.dispose();
    this.ribbons = undefined;
    this.map?.dispose();
    this.map = undefined;
    this.decorations?.clear();
    this.decorations = undefined;
    this.model = undefined;
    for (const sub of this.viewSubs) {
      sub.dispose();
    }
    this.viewSubs = [];
    this.zoneIds.clear();
    this.trackers.clear();
    this.eofKind.clear();
    this.blockState.clear();
    this.ordinals.clear();
    for (const editor of this.editors) {
      // `editor.dispose()` ONLY.
      //
      // These editors were built with `monaco.editor.create(dom, { value,
      // language })` — no model passed — so Monaco creates the model itself and
      // the STANDALONE EDITOR OWNS IT (`_ownsModel`), disposing it in
      // `_postDetachModelCleanup`. Disposing it here first re-entered Monaco's
      // emitter (`onWillDispose` → `setModel(null)` → `_postDetachModelCleanup`
      // → `dispose()` again) and threw
      // `Cannot read properties of undefined (reading '0')` on EVERY teardown —
      // every mode toggle, every file switch, every panel dispose — which
      // aborted the rest of that emitter's listener delivery, including the
      // model service's and the worker sync's unregistration. A diff editor
      // whose worker sync was never unregistered is a diff editor whose worker
      // can stop answering, which is what "the diff sometimes doesn't show"
      // looked like from the outside.
      //
      // The asymmetry is real and worth stating: the INLINE path in
      // desktop/diffPanel.ts calls `monaco.editor.createModel` itself and
      // therefore must dispose those models by hand. Ownership follows who
      // created the model, not who used it. If this ever switches to
      // `create(dom, { model })`, the model becomes ours again and must be
      // disposed AFTER `editor.dispose()`, never before.
      editor.dispose();
    }
    this.editors = [];
    this.left = this.result = this.right = undefined;
    this.buttonLayerA = this.buttonLayerB = undefined;
    this.gutterA = this.gutterB = undefined;
  }
}
