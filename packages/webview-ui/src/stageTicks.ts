import * as monaco from "monaco-editor";
import type { DiffBlock } from "@gitstudio/engine/types";
import { ariaChecked, nextStaged, tickLabel, type BlockState } from "./tickState";

type Editor = monaco.editor.IStandaloneCodeEditor;

/**
 * The staging ticks drawn in the diff's centre gutter — one per change, each a
 * real tri-state checkbox.
 *
 * WHY THE CENTRE GUTTER AND NOT A GLYPH MARGIN. A pure deletion has no line on
 * the right, and a pure insertion none on the left, so no single pane's margin
 * can host a tick for every change without putting some of them somewhere the
 * eye does not expect. The alignment pass already gives the shorter side a
 * spacer view-zone for exactly those cases, so every change occupies a vertical
 * band in BOTH panes — and a control in the gutter between them is beside its
 * change whichever side the change lives on. Asking for the top of a line
 * WITH view zones included is what makes the band land on the deleted lines
 * rather than beside them.
 */

/** How many pixels of slack before a band is considered off-screen. */
const CULL_MARGIN = 40;

/**
 * Below this the reported viewport is not believable — layout has not settled —
 * and culling is skipped rather than trusted.
 */
const CREDIBLE_VIEWPORT = 60;

/** Minimum band height, so a single-line change is still a comfortable target. */
const MIN_BAND = 18;

export interface TickRow {
  /** The rendered diff block this tick belongs to. */
  block: DiffBlock;
  /** Its index in the model's block list — what the host round-trips. */
  index: number;
  state: BlockState;
}

export interface StageTickLayerOptions {
  /** The left editor, which owns the scroll position the bands are placed against. */
  left: () => Editor | undefined;
  /** The right editor, so hover can paint the change's extent on both sides. */
  right: () => Editor | undefined;
  /** The absolutely-positioned layer inside the gutter. */
  layer: () => HTMLElement | undefined;
  /** Called when the user toggles a tick. */
  onToggle: (row: TickRow, staged: boolean) => void;
}

/**
 * Renders and owns the tick controls. Geometry only — every question about what
 * a tick MEANS is answered in tickState.ts, and every question about what a
 * click DOES is answered by the host.
 */
export class StageTickLayer {
  private rows: TickRow[] = [];
  /** Which tick holds the tab stop, so the group is one stop and not fifty. */
  private focusedIndex = 0;
  /** Disabled while a toggle is in flight, so a double click cannot double-stage. */
  private busy = false;
  private hoverLeft: monaco.editor.IEditorDecorationsCollection | undefined;
  private hoverRight: monaco.editor.IEditorDecorationsCollection | undefined;

  constructor(private readonly opts: StageTickLayerOptions) {}

  /** Replaces the tick set. Call whenever the diff or the index changes. */
  setRows(rows: TickRow[]): void {
    this.rows = rows;
    if (this.focusedIndex >= rows.length) {
      this.focusedIndex = Math.max(0, rows.length - 1);
    }
  }

  get length(): number {
    return this.rows.length;
  }

  /** Blocks input while a stage/unstage round trip is outstanding. */
  setBusy(busy: boolean): void {
    this.busy = busy;
  }

  /**
   * Repaints every visible tick. Cheap enough to call on each scroll frame — it
   * is what the transfer arrows already do — because only on-screen bands are
   * built at all.
   */
  render(): void {
    const layer = this.opts.layer();
    const left = this.opts.left();
    if (!layer || !left) return;

    layer.replaceChildren();
    const scrollTop = left.getScrollTop();

    // Culling is an optimisation, so it only runs when the viewport height is
    // CREDIBLE. Before layout settles both the layer and the editor can report a
    // few pixels, and culling against that silently drops every tick below the
    // first — the change is tickable, the control just is not there. Drawing a
    // handful of off-screen buttons costs nothing; hiding a staging control the
    // user is looking at costs correctness.
    const height = Math.max(
      left.getLayoutInfo().height,
      layer.clientHeight,
      layer.parentElement?.clientHeight ?? 0,
    );
    const cull = height >= CREDIBLE_VIEWPORT;

    for (const row of this.rows) {
      const geom = this.bandFor(left, row.block, scrollTop);
      if (cull && (geom.bottom < -CULL_MARGIN || geom.top > height + CULL_MARGIN)) {
        continue;
      }
      layer.appendChild(this.makeTick(row, geom));
    }
  }

  /**
   * The vertical band a block occupies, in layer coordinates.
   *
   * View zones are included deliberately: a deletion has no line of its own on
   * the right, and the alignment spacer standing in for it is a view zone. Ask
   * for the top without them and the band for every deletion collapses onto the
   * following line.
   */
  private bandFor(
    left: Editor,
    block: DiffBlock,
    scrollTop: number,
  ): { top: number; height: number; bottom: number } {
    const lineCount = left.getModel()?.getLineCount() ?? 1;
    const startLine = Math.min(Math.max(1, block.leftSpan.start), lineCount);
    const endLine = Math.min(Math.max(startLine, block.leftSpan.endExclusive), lineCount + 1);

    const top = left.getTopForLineNumber(startLine, true) - scrollTop;
    const bottom =
      endLine > lineCount
        ? top + left.getOption(monaco.editor.EditorOption.lineHeight)
        : left.getTopForLineNumber(endLine, false) - scrollTop;

    const height = Math.max(MIN_BAND, bottom - top);
    return { top, height, bottom: top + height };
  }

  private makeTick(row: TickRow, geom: { top: number; height: number }): HTMLElement {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `jb-stage-tick jb-tick-${row.state}`;
    btn.style.top = `${Math.round(geom.top)}px`;
    btn.style.height = `${Math.round(geom.height)}px`;

    // A real tri-state checkbox rather than a button that looks like one, so it
    // is announced and operated the way users of assistive tech expect.
    btn.setAttribute("role", "checkbox");
    btn.setAttribute("aria-checked", ariaChecked(row.state));
    btn.setAttribute("aria-label", tickLabel(row.state));
    btn.title = tickLabel(row.state);
    btn.disabled = this.busy;

    // Roving tabindex: the whole rail is ONE tab stop, and arrow keys move
    // within it. Fifty ticks each taking a tab stop would make the diff
    // unnavigable by keyboard.
    btn.tabIndex = row.index === this.focusedIndex ? 0 : -1;

    btn.addEventListener("mousedown", (event) => {
      // Take the click without moving the caret in either editor — a tick is not
      // a place in the text.
      event.preventDefault();
    });
    btn.addEventListener("click", () => this.toggle(row));
    btn.addEventListener("keydown", (event) => this.onKey(event, row));
    btn.addEventListener("focus", () => {
      this.focusedIndex = row.index;
    });
    btn.addEventListener("mouseenter", () => this.paintExtent(row.block));
    btn.addEventListener("mouseleave", () => this.clearExtent());
    btn.addEventListener("blur", () => this.clearExtent());

    return btn;
  }

  private toggle(row: TickRow): void {
    if (this.busy) return;
    this.opts.onToggle(row, nextStaged(row.state));
  }

  private onKey(event: KeyboardEvent, row: TickRow): void {
    // Space is the checkbox idiom; Enter is accepted too because the control
    // looks like a button and people press it.
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      this.toggle(row);
      return;
    }
    const delta = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (delta === 0) return;
    event.preventDefault();
    const next = row.index + delta;
    if (next < 0 || next >= this.rows.length) return;
    this.focusedIndex = next;
    this.render();
    const layer = this.opts.layer();
    const target = layer?.children[
      Array.from(layer.children).findIndex(
        (c) => (c as HTMLElement).tabIndex === 0,
      )
    ] as HTMLElement | undefined;
    target?.focus();
  }

  /** Highlights the block's full extent in both panes while a tick is hovered. */
  private paintExtent(block: DiffBlock): void {
    const left = this.opts.left();
    const right = this.opts.right();
    if (left) {
      this.hoverLeft ??= left.createDecorationsCollection();
      this.hoverLeft.set(spanDecorations(left, block.leftSpan));
    }
    if (right) {
      this.hoverRight ??= right.createDecorationsCollection();
      this.hoverRight.set(spanDecorations(right, block.rightSpan));
    }
  }

  private clearExtent(): void {
    this.hoverLeft?.clear();
    this.hoverRight?.clear();
  }

  dispose(): void {
    this.clearExtent();
    this.hoverLeft = undefined;
    this.hoverRight = undefined;
    this.opts.layer()?.replaceChildren();
    this.rows = [];
  }
}

/** Whole-line decorations covering `span`, clamped to the model's real extent. */
function spanDecorations(
  editor: Editor,
  span: { start: number; endExclusive: number },
): monaco.editor.IModelDeltaDecoration[] {
  const model = editor.getModel();
  if (!model) return [];
  const lineCount = model.getLineCount();
  // A zero-width span is an insertion point with no lines of its own; there is
  // nothing to paint on this side, and the other side carries the highlight.
  if (span.endExclusive <= span.start) return [];
  const start = Math.min(Math.max(1, span.start), lineCount);
  const end = Math.min(Math.max(start, span.endExclusive - 1), lineCount);
  return [
    {
      range: new monaco.Range(start, 1, end, model.getLineMaxColumn(end)),
      options: { isWholeLine: true, className: "jb-tick-extent" },
    },
  ];
}
