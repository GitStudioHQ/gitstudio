import * as monaco from "monaco-editor";
import type { ChangeBlock, LineSpan, MergeModel } from "@gitstudio/engine/types";
import { isEmptySpan } from "@gitstudio/engine/types";
import { PAINT_TONES, paintTone, type PaintTone } from "./paint";
import { scheduleFrame } from "./ribbons";

type Editor = monaco.editor.IStandaloneCodeEditor;

/**
 * The merge's one overview strip: every pending change of the whole Result,
 * as a mark in its category's colour, and where the view is — at the view's
 * RIGHT EDGE, beside Theirs, never on a seam.
 *
 * It replaces the Result editor's own overview ruler and scrollbar, which sat
 * exactly on the Result|gutter seam and cut every band there: in a dense file
 * the ruler lane became one solid bar the height of the pane, coloured by
 * translucent marks blended into a colour no legend names, and Monaco's slider
 * laid a lighter strip over every band's end (the owner's "solid block beside
 * the result text" in another form). Here:
 *
 * - the marks are OPAQUE, one colour per legend item (the legend's own dot
 *   colours: orange a conflict, green the same on both sides, blue one side
 *   only, grey removed lines), drawn conflicts last, so a crowded stretch
 *   reads as conflicts rather than as a mix of everything;
 * - the view's extent is drawn BEHIND the marks, and outlined above them, so
 *   no mark is ever tinted by it;
 * - nothing is drawn while the whole Result fits its pane — a map of a page
 *   that is all on screen finds nothing, and one line's mark was a block;
 * - it scrolls: press anywhere to go there, drag the view, or use the wheel
 *   over it. Scrolling is synced, so the side panes follow.
 */
export interface OverviewMapOptions {
  /** A block's live span in the Result. */
  resultSpanOf(block: ChangeBlock): LineSpan;
  /** A resolved block has no mark. */
  isResolved(block: ChangeBlock): boolean;
}

/** One mark as drawn, in CSS px from the strip's top (tests read these). */
export interface OverviewMark {
  block: number;
  tone: PaintTone;
  top: number;
  height: number;
}

/** A mark is never shorter than this (CSS px): a one-line change in a long file is still findable. */
const MIN_MARK = 3;
/** Nor is the view's extent. */
const MIN_THUMB = 20;
/** Marks are inset this far from the strip's edges (CSS px). */
const MARK_INSET = 3;

/** Drawn first to last: a conflict is never hidden under another category. */
const TONE_ORDER: readonly PaintTone[] = PAINT_TONES;

export class OverviewMap {
  /** The strip, in the grid's last column (editor row). */
  readonly element: HTMLElement;
  /** The header cell above it, so the header row runs on to the edge. */
  readonly head: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly thumb: HTMLElement;
  private readonly frame: HTMLElement;
  private readonly subs: monaco.IDisposable[] = [];
  private readonly ac = new AbortController();
  private cancelDraw?: () => void;
  private marks: OverviewMark[] = [];

  constructor(
    grid: HTMLElement,
    column: number,
    private readonly result: Editor,
    private readonly getModel: () => MergeModel | undefined,
    private readonly options: OverviewMapOptions,
  ) {
    const head = document.createElement("div");
    head.className = "jb-map-head";
    head.style.gridColumn = String(column);
    head.style.gridRow = "1";
    this.head = head;

    const strip = document.createElement("div");
    strip.className = "jb-map is-empty";
    strip.style.gridColumn = String(column);
    strip.style.gridRow = "2";
    // A mouse affordance: the keyboard has F7 / Shift+F7 and the editor's own
    // scrolling, and a screen reader the legend's counts.
    strip.setAttribute("aria-hidden", "true");
    strip.title = "Overview of the changes still to resolve — press to go there";
    this.thumb = document.createElement("div");
    this.thumb.className = "jb-map-thumb";
    this.canvas = document.createElement("canvas");
    this.canvas.className = "jb-map-canvas";
    this.frame = document.createElement("div");
    this.frame.className = "jb-map-view";
    strip.append(this.thumb, this.canvas, this.frame);
    this.element = strip;
    grid.append(head, strip);

    this.subs.push(
      result.onDidScrollChange(() => this.scheduleDraw()),
      result.onDidLayoutChange(() => this.scheduleDraw()),
      result.onDidContentSizeChange(() => this.scheduleDraw()),
    );
    this.wire();
    this.scheduleDraw();
  }

  /** The marks last drawn (none while the Result fits its pane). */
  get drawn(): readonly OverviewMark[] {
    return this.marks;
  }

  public scheduleDraw(): void {
    if (this.cancelDraw) {
      return;
    }
    this.cancelDraw = scheduleFrame(() => {
      this.cancelDraw = undefined;
      this.draw();
    });
  }

  /** Draws now (the view calls it after every state change it already batches). */
  public draw(): void {
    const strip = this.element;
    const width = strip.clientWidth;
    const height = strip.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    const scrollHeight = this.result.getScrollHeight();
    const viewHeight = this.result.getLayoutInfo().height;
    const overflows = height > 0 && viewHeight > 0 && scrollHeight > viewHeight + 1;
    strip.classList.toggle("is-empty", !overflows);

    const pxW = Math.max(1, Math.round(width * dpr));
    const pxH = Math.max(1, Math.round(height * dpr));
    if (this.canvas.width !== pxW) this.canvas.width = pxW;
    if (this.canvas.height !== pxH) this.canvas.height = pxH;
    const ctx = this.canvas.getContext("2d");
    ctx?.clearRect(0, 0, pxW, pxH);
    this.marks = [];
    if (!overflows) {
      strip.dataset.marks = "0";
      this.thumb.hidden = true;
      this.frame.hidden = true;
      return;
    }

    const scale = height / scrollHeight;
    const top = this.result.getScrollTop() * scale;
    const extent = Math.max(MIN_THUMB, viewHeight * scale);
    const thumbTop = Math.min(Math.max(0, top), Math.max(0, height - extent));
    for (const el of [this.thumb, this.frame]) {
      el.hidden = false;
      el.style.top = `${Math.round(thumbTop)}px`;
      el.style.height = `${Math.round(extent)}px`;
    }

    const model = this.getModel();
    const editorModel = this.result.getModel();
    if (!model || !editorModel) {
      return;
    }
    const lineCount = editorModel.getLineCount();
    const lineHeight = this.result.getOption(monaco.editor.EditorOption.lineHeight);
    const at = (line: number): number =>
      line > lineCount
        ? this.result.getTopForLineNumber(lineCount) + lineHeight
        : this.result.getTopForLineNumber(Math.max(1, line));
    for (const block of model.blocks) {
      if (this.options.isResolved(block)) {
        continue;
      }
      const span = this.options.resultSpanOf(block);
      const y0 = at(span.start);
      const y1 = isEmptySpan(span) ? y0 : at(span.endExclusive - 1) + lineHeight;
      const h = Math.max(MIN_MARK, (y1 - y0) * scale);
      // A point sits across its boundary, not below it.
      const y = isEmptySpan(span) ? y0 * scale - h / 2 : y0 * scale;
      this.marks.push({
        block: block.id,
        tone: paintTone(block),
        top: Math.min(Math.max(0, y), height - h),
        height: h,
      });
    }
    strip.dataset.marks = String(this.marks.length);
    if (!ctx) {
      return;
    }
    const colours = this.palette();
    const x0 = Math.round(MARK_INSET * dpr);
    const x1 = Math.max(x0 + 1, pxW - Math.round(MARK_INSET * dpr));
    for (const tone of TONE_ORDER) {
      ctx.fillStyle = colours[tone];
      for (const mark of this.marks) {
        if (mark.tone !== tone) continue;
        const a = Math.round(mark.top * dpr);
        const b = Math.max(a + 1, Math.round((mark.top + mark.height) * dpr));
        ctx.fillRect(x0, a, x1 - x0, b - a);
      }
    }
  }

  public dispose(): void {
    this.cancelDraw?.();
    this.cancelDraw = undefined;
    this.ac.abort();
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.subs.length = 0;
    this.element.remove();
    this.head.remove();
  }

  /** Each paint tone's opaque colour, resolved from the live theme (`--jb-map-<tone>`). */
  private palette(): Record<PaintTone, string> {
    const probe = document.createElement("span");
    probe.style.display = "none";
    this.element.appendChild(probe);
    const read = (tone: PaintTone): string => {
      probe.style.color = `var(--jb-map-${tone})`;
      return getComputedStyle(probe).color;
    };
    const out = Object.fromEntries(PAINT_TONES.map((tone) => [tone, read(tone)])) as Record<PaintTone, string>;
    probe.remove();
    return out;
  }

  /** Press to go there, drag the view, wheel to scroll. */
  private wire(): void {
    const signal = this.ac.signal;
    const strip = this.element;
    let grab: number | undefined;
    const scrollTo = (clientY: number): void => {
      const rect = strip.getBoundingClientRect();
      const height = rect.height;
      if (height <= 0 || grab === undefined) return;
      const scrollHeight = this.result.getScrollHeight();
      const y = clientY - rect.top - grab;
      this.result.setScrollTop((y / height) * scrollHeight);
    };
    strip.addEventListener(
      "mousedown",
      (event) => {
        if (event.button !== 0 || strip.classList.contains("is-empty")) return;
        event.preventDefault();
        const t = this.thumb.getBoundingClientRect();
        const y = event.clientY;
        // On the view's extent: drag it from where it was taken. Elsewhere:
        // centre the view there, then drag from its middle.
        grab = y >= t.top && y <= t.bottom ? y - t.top : t.height / 2;
        if (!(y >= t.top && y <= t.bottom)) scrollTo(y);
        strip.classList.add("is-dragging");
        const move = (e: MouseEvent): void => scrollTo(e.clientY);
        const up = (): void => {
          grab = undefined;
          strip.classList.remove("is-dragging");
          window.removeEventListener("mousemove", move, true);
          window.removeEventListener("mouseup", up, true);
        };
        window.addEventListener("mousemove", move, true);
        window.addEventListener("mouseup", up, true);
      },
      { signal },
    );
    strip.addEventListener(
      "wheel",
      (event) => {
        const lineHeight = this.result.getOption(monaco.editor.EditorOption.lineHeight);
        const dy = event.deltaMode === 1 ? event.deltaY * lineHeight : event.deltaMode === 2 ? event.deltaY * strip.clientHeight : event.deltaY;
        if (dy === 0) return;
        event.preventDefault();
        this.result.setScrollTop(this.result.getScrollTop() + dy);
      },
      { signal, passive: false },
    );
  }
}
