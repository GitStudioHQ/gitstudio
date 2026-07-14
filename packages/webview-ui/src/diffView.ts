import * as monaco from "monaco-editor";
import type { DiffInitPayload } from "@gitstudio/host-bridge/protocol";
import type { DiffBlock, DiffModel } from "@gitstudio/engine/types";
import { isEmptySpan } from "@gitstudio/engine/types";
import { buildDiffModel } from "@gitstudio/engine/diffModel";
import type { WhitespaceMode } from "@gitstudio/engine/lineDiff";
import { splitLines } from "@gitstudio/engine/lineDiff";
import { languageForFile } from "./language";
import { ensureNativeTheme, nativeFontOptions } from "./theme";
import { DiffDecorationManager } from "./decorations";
import { chevronDoubleRight, iconElement, lockIcon } from "./icons";
import { computeDiffAlignment, type Spacer } from "@gitstudio/engine/alignment";
import { DiffRibbonOverlay } from "./ribbons";
import { LARGE_FILE_LINE_THRESHOLD } from "./limits";

type Editor = monaco.editor.IStandaloneCodeEditor;

/** Pixel height of the transfer action drawn in the gutter strip. */
const ACTION_ROW_HEIGHT = 16;

/** Debounce for re-running the diff while the right pane is being edited. */
const REDIFF_DELAY_MS = 200;

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
  // Lockstep with the gutter overlay — see SHARED_OPTIONS in mergeView.ts.
  smoothScrolling: false,
};

export interface DiffRenderOptions {
  whitespace: WhitespaceMode;
  showInner: boolean;
}

/**
 * Two-pane JetBrains-style diff surface: Left (original, read-only), one
 * gutter strip with flat connector bands + transfer arrows, Right (modified;
 * editable when the payload allows).
 *
 * The diff is LIVE, like IntelliJ's: edits in the right pane (and refreshed
 * payloads pushed by the host when the backing documents change) re-run the
 * diff against the editors' current text, so highlights, bands, and buttons
 * never go stale.
 */
export class DiffView {
  private editors: Editor[] = [];
  private resizeObserver?: ResizeObserver;
  private themeObserver?: MutationObserver;
  private decorations?: DiffDecorationManager;
  private ribbons?: DiffRibbonOverlay;
  private zoneIds = new Map<Editor, string[]>();
  private viewSubs: monaco.IDisposable[] = [];
  private syncingScroll = false;
  private rediffTimer = 0;
  private buttonsRaf = 0;
  /** Timestamp of the last local right-pane edit (typing / transfer). */
  private lastLocalEdit = 0;
  /** Guards the content listener while WE write external text into a pane. */
  private applyingExternal = false;

  private gutter?: HTMLElement;
  private buttonLayer?: HTMLElement;

  private leftLines: string[] = [];
  private payload?: DiffInitPayload;
  private renderOptions: DiffRenderOptions = {
    whitespace: "none",
    showInner: true,
  };
  private largeFile = false;

  public left?: Editor;
  public right?: Editor;
  public model?: DiffModel;

  /** Notified whenever the right (editable) document content changes. */
  public onRightChanged?: () => void;
  /** Notified when the large-file fallback kicks in (line-level only). */
  public onLargeFile?: (large: boolean) => void;
  /** Notified after every (re)diff with the current change count. */
  public onCountsChanged?: (changes: number) => void;

  constructor(private readonly container: HTMLElement) {}

  /**
   * Initial render builds the editors; subsequent renders for the same pane
   * pair update the text in place (preserving scroll, cursor, and undo) and
   * re-diff, so host-pushed refreshes don't flash or reset the view.
   */
  public render(payload: DiffInitPayload): void {
    const samePanes =
      this.left &&
      this.right &&
      this.payload &&
      this.payload.fileName === payload.fileName &&
      this.payload.leftLabel === payload.leftLabel &&
      this.payload.rightLabel === payload.rightLabel &&
      this.payload.rightEditable === payload.rightEditable;

    this.payload = payload;
    if (!samePanes) {
      this.build();
      return;
    }
    this.setEditorText(this.left!, payload.leftText);
    // Never clobber in-flight typing: right after a local edit (or while the
    // right editor is focused), a differing external text is either our own
    // sync echo (identical, a no-op) or older than what the user has — the
    // outgoing sync reconciles the backing document to the webview shortly.
    const recentlyEdited = Date.now() - this.lastLocalEdit < 1000;
    if (
      this.getRightText() === payload.rightText ||
      (!this.right!.hasTextFocus() && !recentlyEdited)
    ) {
      this.setEditorText(this.right!, payload.rightText);
    }
    this.refreshDiff();
  }

  /** Re-runs the diff with new whitespace / granularity options. */
  public setRenderOptions(options: Partial<DiffRenderOptions>): void {
    this.renderOptions = { ...this.renderOptions, ...options };
    if (this.left && this.right) {
      this.refreshDiff();
    } else if (this.payload) {
      this.build();
    }
  }

  private build(): void {
    const payload = this.payload;
    if (!payload) {
      return;
    }
    this.dispose();

    const language = languageForFile(payload.fileName);
    const theme = ensureNativeTheme();
    const font = nativeFontOptions();

    const grid = document.createElement("div");
    grid.className = "jb-diff-grid";
    this.container.replaceChildren(grid);

    const leftBody = this.addPane(grid, 1, payload.leftLabel, true);
    this.gutter = this.addGutter(grid, 2);
    const rightBody = this.addPane(
      grid,
      3,
      payload.rightLabel,
      !payload.rightEditable,
    );

    this.left = monaco.editor.create(leftBody, {
      ...SHARED_OPTIONS,
      ...font,
      theme,
      language,
      value: payload.leftText,
      readOnly: true,
      domReadOnly: true,
      scrollbar: { useShadows: false, vertical: "hidden", horizontal: "auto" },
    });
    this.right = monaco.editor.create(rightBody, {
      ...SHARED_OPTIONS,
      ...font,
      theme,
      language,
      value: payload.rightText,
      readOnly: !payload.rightEditable,
      domReadOnly: !payload.rightEditable,
      // IntelliJ's "error stripe": colored change marks beside the scrollbar.
      overviewRulerLanes: 1,
      overviewRulerBorder: false,
    });
    this.editors = [this.left, this.right];

    this.decorations = new DiffDecorationManager({
      left: this.left,
      right: this.right,
    });
    this.buttonLayer = this.addButtonLayer(this.gutter);
    this.ribbons = new DiffRibbonOverlay(
      this.gutter,
      { left: this.left, right: this.right },
      () => this.model,
    );

    this.installViewListeners();
    this.installNavigationKeys();
    this.installSyncScroll();
    this.observeResize();
    this.observeTheme();

    this.refreshDiff();
  }

  // --- live re-diff ---

  private scheduleRediff(): void {
    if (this.rediffTimer) {
      window.clearTimeout(this.rediffTimer);
    }
    this.rediffTimer = window.setTimeout(() => {
      this.rediffTimer = 0;
      this.refreshDiff();
    }, REDIFF_DELAY_MS);
  }

  /**
   * Recomputes the diff from the editors' CURRENT text and reapplies all
   * derived rendering (decorations, alignment spacers, bands, buttons).
   */
  private refreshDiff(): void {
    if (!this.left || !this.right) {
      return;
    }
    if (this.rediffTimer) {
      window.clearTimeout(this.rediffTimer);
      this.rediffTimer = 0;
    }
    const leftText = this.left.getModel()?.getValue() ?? "";
    const rightText = this.right.getModel()?.getValue() ?? "";
    this.leftLines = splitLines(leftText);

    const totalLines = this.leftLines.length + splitLines(rightText).length;
    this.largeFile = totalLines > LARGE_FILE_LINE_THRESHOLD;
    this.onLargeFile?.(this.largeFile);

    this.model = buildDiffModel(leftText, rightText, {
      whitespace: this.renderOptions.whitespace,
    });
    this.installAlignment(this.model);
    this.decorations?.apply(this.model, {
      showInner: this.renderOptions.showInner && !this.largeFile,
    });
    this.ribbons?.scheduleDraw();
    this.rebuildButtons();
    this.onCountsChanged?.(this.model.blocks.length);
  }

  /** Full-range in-place replacement that survives readOnly and keeps undo. */
  private setEditorText(editor: Editor, text: string): void {
    const model = editor.getModel();
    if (!model || model.getValue() === text) {
      return;
    }
    const lastLine = model.getLineCount();
    this.applyingExternal = true;
    try {
      model.pushEditOperations(
        [],
        [
          {
            range: new monaco.Range(1, 1, lastLine, model.getLineMaxColumn(lastLine)),
            text,
          },
        ],
        () => null,
      );
    } finally {
      this.applyingExternal = false;
    }
  }

  private installNavigationKeys(): void {
    for (const editor of this.editors) {
      editor.addCommand(monaco.KeyCode.F7, () => this.goToNextChange());
      editor.addCommand(
        monaco.KeyMod.Shift | monaco.KeyCode.F7,
        () => this.goToPrevChange(),
      );
    }
  }

  // --- layout helpers ---

  private addPane(
    grid: HTMLElement,
    column: number,
    titleText: string,
    locked: boolean,
  ): HTMLElement {
    const title = document.createElement("div");
    title.className = "jb-pane-title";
    title.style.gridColumn = String(column);
    title.style.gridRow = "1";
    title.title = titleText;
    if (locked) {
      title.appendChild(iconElement(lockIcon, "jb-svg jb-lock"));
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

  private addGutter(grid: HTMLElement, column: number): HTMLElement {
    const gutter = document.createElement("div");
    // jb-gutter-a anchors the transfer arrows against the left pane, like
    // IntelliJ's diff gutter.
    gutter.className = "jb-gutter jb-gutter-a";
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

  // --- transfer arrows (copy left change into the editable right pane) ---

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
    if (!this.model || !this.left || !this.buttonLayer) {
      return;
    }
    this.buttonLayer.replaceChildren();
    if (!this.payload?.rightEditable) {
      return;
    }

    const scrollTop = this.left.getScrollTop();
    const height = this.gutter?.clientHeight ?? 0;
    const lineHeight = this.left.getOption(monaco.editor.EditorOption.lineHeight);
    const centerOffset = Math.max(0, (lineHeight - ACTION_ROW_HEIGHT) / 2);

    for (const block of this.model.blocks) {
      const y = this.left.getTopForLineNumber(block.leftSpan.start) - scrollTop;
      if (y < -24 || y > height + 24) {
        continue;
      }
      this.buttonLayer.appendChild(this.makeTransfer(block, y + centerOffset));
    }
  }

  private makeTransfer(block: DiffBlock, y: number): HTMLElement {
    const group = document.createElement("div");
    group.className = "jb-change-actions";
    group.style.top = `${Math.round(y)}px`;

    const accept = document.createElement("button");
    accept.type = "button";
    accept.className = `jb-gutter-btn jb-btn-accept jb-role-${block.role}`;
    accept.appendChild(iconElement(chevronDoubleRight));
    accept.title = "Replace with the left side's text";
    accept.setAttribute("aria-label", "Replace with the left side's text");
    accept.addEventListener("mousedown", (event) => {
      event.preventDefault();
      this.transferBlock(block);
    });

    group.append(accept);
    return group;
  }

  /** Replaces the right span with the left span's text. */
  private transferBlock(block: DiffBlock): void {
    const editor = this.right;
    const model = editor?.getModel();
    if (!editor || !model || !this.payload?.rightEditable) {
      return;
    }
    // If edits are still awaiting the debounced re-diff, the clicked block's
    // right span may be stale. Re-diff now and re-locate the change via its
    // left span, which is stable (the left pane is read-only).
    if (this.rediffTimer) {
      this.refreshDiff();
      const fresh = this.model?.blocks.find(
        (b) =>
          b.leftSpan.start === block.leftSpan.start &&
          b.leftSpan.endExclusive === block.leftSpan.endExclusive,
      );
      if (!fresh) {
        return; // the change no longer exists in the updated diff
      }
      block = fresh;
    }
    const leftText = this.leftLines
      .slice(block.leftSpan.start - 1, block.leftSpan.endExclusive - 1)
      .join("\n");

    const span = block.rightSpan;
    const lineCount = model.getLineCount();
    let range: monaco.Range;
    let text: string;
    if (isEmptySpan(span)) {
      // Pure insertion point on the right: insert the left lines there.
      range = new monaco.Range(span.start, 1, span.start, 1);
      text = leftText.length ? `${leftText}\n` : "";
    } else if (span.endExclusive > lineCount) {
      range = new monaco.Range(
        span.start,
        1,
        lineCount,
        model.getLineMaxColumn(lineCount),
      );
      text = leftText;
    } else {
      range = new monaco.Range(span.start, 1, span.endExclusive, 1);
      text = leftText.length ? `${leftText}\n` : "";
    }
    editor.executeEdits("jbDiff", [{ range, text, forceMoveMarkers: true }]);
    // Re-diff immediately so the applied change's band/button vanish in step.
    this.refreshDiff();
  }

  /** Current text of the right (modified) pane, for write-back. */
  public getRightText(): string {
    return this.right?.getModel()?.getValue() ?? "";
  }


  // --- alignment / scrolling / observers ---

  private installAlignment(model: DiffModel): void {
    if (!this.left || !this.right) {
      return;
    }
    const zones = computeDiffAlignment(model);
    this.installZones(this.left, zones.left);
    this.installZones(this.right, zones.right);
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

  private installSyncScroll(): void {
    for (const editor of this.editors) {
      const sub = editor.onDidScrollChange(() => {
        if (this.syncingScroll) {
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

  private installViewListeners(): void {
    if (!this.left || !this.right) {
      return;
    }
    this.viewSubs.push(
      this.left.onDidScrollChange(() => this.scheduleButtons()),
      this.right.onDidChangeModelContent(() => {
        // Keep overlays tracking the text instantly; the model catches up
        // via the debounced re-diff.
        this.ribbons?.scheduleDraw();
        this.scheduleButtons();
        if (this.applyingExternal) {
          return; // host-pushed text; render() re-diffs synchronously next
        }
        this.lastLocalEdit = Date.now();
        this.scheduleRediff();
        if (this.payload?.rightEditable) {
          this.onRightChanged?.();
        }
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

  // --- change navigation (F7 / Shift+F7) ---

  /** Scrolls the right pane to the next change after the current viewport top. */
  public goToNextChange(): void {
    this.navigate(1);
  }

  public goToPrevChange(): void {
    this.navigate(-1);
  }

  private navigate(direction: 1 | -1): void {
    if (!this.model || !this.right || this.model.blocks.length === 0) {
      return;
    }
    const blocks = this.model.blocks;
    const current = this.right.getPosition()?.lineNumber ?? 1;

    let target: DiffBlock;
    if (direction === 1) {
      target = blocks.find((b) => b.rightSpan.start > current) ?? blocks[0];
    } else {
      const before = blocks.filter((b) => b.rightSpan.start < current);
      target = before.length ? before[before.length - 1] : blocks[blocks.length - 1];
    }
    this.revealBlock(target);
  }

  private revealBlock(block: DiffBlock): void {
    if (!this.right) {
      return;
    }
    const line = block.rightSpan.start;
    this.right.revealLineInCenter(line);
    this.right.setPosition({ lineNumber: line, column: 1 });
    this.right.focus();
  }

  public dispose(): void {
    if (this.rediffTimer) {
      window.clearTimeout(this.rediffTimer);
      this.rediffTimer = 0;
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
    for (const editor of this.editors) {
      editor.getModel()?.dispose();
      editor.dispose();
    }
    this.editors = [];
    this.left = this.right = undefined;
    this.buttonLayer = undefined;
    this.gutter = undefined;
  }
}
