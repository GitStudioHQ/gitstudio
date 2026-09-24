import * as monaco from "monaco-editor";
import type {
  ChangeBlock,
  DiffModel,
  LineSpan,
  MergeModel,
  Side,
} from "@gitstudio/engine/types";
import { isEmptySpan, sideBlockSpan } from "@gitstudio/engine/types";
import type { DiffEditors, MergeEditors } from "./decorations";
import { OVERLAY_FALLBACK_MS } from "./limits";
import { paintTone, type SideFate } from "./paint";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Runs `fn` on the next animation frame — or after OVERLAY_FALLBACK_MS when no
 * frame comes. Headless Chrome under a virtual-time budget services no frames
 * at all, and an occluded or minimised window is served none either; an
 * overlay repaint that waits on requestAnimationFrame alone then never lands
 * (the ribbons and the gutter buttons stay where they last were). Whichever
 * fires first runs `fn`, once. Returns a cancel.
 */
export function scheduleFrame(fn: () => void, fallbackMs = OVERLAY_FALLBACK_MS): () => void {
  let done = false;
  let raf = 0;
  let timer = 0;
  const run = (): void => {
    if (done) {
      return;
    }
    done = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
    fn();
  };
  raf = requestAnimationFrame(run);
  timer = window.setTimeout(run, fallbackMs);
  return () => {
    done = true;
    cancelAnimationFrame(raf);
    window.clearTimeout(timer);
  };
}

/**
 * Width of the straight, rectangular segment of a merge-gutter band that hugs
 * the side pane. The accept/ignore icons live inside this segment, and the
 * slanted connection to the result pane only starts after it — IntelliJ's
 * layout, and what keeps the icons inside the colour at every scroll offset.
 * Must fit the action row built in mergeView.makeActions (2 buttons + gaps).
 */
export const MERGE_ICON_STRIP = 46;

/** Same idea for the 2-way diff's single transfer button (left-anchored). */
export const DIFF_ICON_STRIP = 24;

/**
 * How tall the 2-way diff draws an insertion or deletion POINT, in CSS px: its
 * marker line (`jb-marker-*` in diff.css) and the ribbon's end at that point
 * are both exactly this, on the same rows — the line below the boundary, or
 * above it for the point after the last line.
 */
export const POINT_PX = 2;

/**
 * The merge's POINT line, in CSS px: 1, and 2 in a high contrast theme (where
 * every edge is a solid line in the edge colour). The pane's line (`jb-point`
 * in diff.css) and the ribbon's end are both exactly this, on the same rows.
 * It was 2px of the full-strength edge colour everywhere — a bright wire
 * across the Result that the ribbons, in their tint, ended at as a dull strip.
 * Now the line and the ribbon's end are one colour (`--jb-point-<tone>`: the
 * tint at a higher strength): the ribbon's end at a point is capped in it
 * (RibbonOverlay's `jb-ribbon-cap`).
 */
export function mergePointPx(): number {
  return document.body.classList.contains("vscode-high-contrast") ? 2 : 1;
}

/**
 * How far a point's cap runs into the gutter from its seam, in CSS px, where
 * the band slants (at the Result): the pane's point line carries on into the
 * ribbon's end in its own colour. Beside a side pane the band is flat across
 * the whole icon strip, and so is its cap.
 */
const CAP_PX = 2;

/** Which edge of the gutter carries the rectangular icon segment. */
type StripSide = "a" | "b";

interface IconStrip {
  side: StripSide;
  width: number;
}

/** Corner radius for the band bends inside a gutter. */
const BEND_RADIUS = 7;

export interface RibbonOptions {
  /** Current result-pane span for a block (defaults to its base span). */
  resultSpanOf?: (block: ChangeBlock) => LineSpan;
  /** Whether every side of a block is settled. */
  isResolved?: (block: ChangeBlock) => boolean;
  /** Whether a side has been handled (taken or discarded). */
  isSideDone?: (block: ChangeBlock, side: Side) => boolean;
  /**
   * What became of a side: a TAKEN side keeps its ribbon, muted; a DISCARDED
   * side draws none. Without it, every handled side counts as taken.
   */
  sideFate?: (block: ChangeBlock, side: Side) => SideFate;
  /**
   * Whether this pending change's Result already holds text merged outside
   * the conflict markers (the view seeded it from the file). Its Result is
   * painted like a half-settled one, so its bands meet it as they meet one:
   * phase "half", and a settled cap on a Result point.
   */
  isSeeded?: (block: ChangeBlock) => boolean;
}

/** A gutter's horizontal extent on the stage, snapped as its box is painted. */
interface GutterRange {
  left: number;
  right: number;
}

/** A band's [top, bottom] on the stage, snapped as the pane's boxes are painted. */
type Band = [number, number];

/**
 * Stage geometry. Every coordinate a ribbon uses is a CLIENT coordinate
 * rounded the way the browser snaps the boxes it is drawn against, less the
 * stage's own snapped origin — because that is where the browser paints the
 * pane's line highlights, the gutters' borders and the stage itself. Measured
 * (headless Chrome at 1x, 1.5x and 2x): a box — and an SVG root — at a
 * fractional position is snapped to whole CSS pixels (half up), and only then
 * scaled to the screen. So an edge at 490.66 is painted at 491 (982 device
 * rows at 2x), and a ribbon rounded to DEVICE pixels ended at 981: one device
 * column short of the pane, which is how the gutter's border came to show
 * through every band. Snapped the same way, every band edge in a pane, its
 * ribbon and the result sits on the same row (scripts/merge-e2e/alignment.ts
 * measures it, pixels included).
 *
 * A browser that snaps to device pixels instead agrees wherever the panes
 * sit on whole CSS pixels at a whole scale — rows always do (Monaco's lines
 * are whole pixels) — and where it does not, the OVERLAP covers it: each ribbon
 * end reaches two device pixels into its pane (see bandGeometry).
 *
 * Line widths are the panes' own CSS widths, from the same snapped edge: a 1px
 * border at 1.5x is one and a half device rows (the second antialiased), and a
 * 1px stroke drawn inside the band from that edge covers the same rows.
 */
class Frame {
  readonly dpr = window.devicePixelRatio || 1;
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;
  /** How far a ribbon end reaches into its pane: two device pixels, in CSS px. */
  readonly overlap: number;

  constructor(stage: SVGSVGElement) {
    const rect = stage.getBoundingClientRect();
    this.originX = this.snap(rect.left);
    this.originY = this.snap(rect.top);
    this.width = rect.width;
    this.height = rect.height;
    this.overlap = 2 / this.dpr;
  }

  snap(v: number): number {
    return Math.round(v);
  }

  /**
   * Where a ribbon's ends stop inside the panes, left and right of `gutter`:
   * at least `overlap` beyond each edge, on a whole DEVICE pixel — that end is
   * the one vertical edge a band has there, and a band end on a fraction of a
   * pixel is antialiased twice (its base, then its tint), which left a
   * one-pixel-dark column inside the pane's band at 1.25x.
   *
   * Measured from the EDITORS' painted edges where they stop short of the
   * gutter (`before`, `after`: the panes' Monaco editors). Monaco lays an
   * editor out at a whole CSS width, so in a pane of fractional width (the
   * desktop, beside its file list) the editor ends up to a pixel before its
   * gutter begins; a reach measured from the gutter alone then ended on the
   * editor's own antialiased edge, and at 1.5x that column came out darker
   * than both — a hairline down the Result|gutter seam of every band, and of
   * every trace once no gutter button was left above it.
   */
  reach(gutter: GutterRange, before?: HTMLElement | null, after?: HTMLElement | null): { left: number; right: number } {
    const d = this.dpr;
    const leftEdge = before ? Math.min(gutter.left, this.snap(before.getBoundingClientRect().right) - this.originX) : gutter.left;
    const rightEdge = after ? Math.max(gutter.right, this.snap(after.getBoundingClientRect().left) - this.originX) : gutter.right;
    const left = Math.floor((this.originX + leftEdge - this.overlap) * d + 1e-6) / d - this.originX;
    const right = Math.ceil((this.originX + rightEdge + this.overlap) * d - 1e-6) / d - this.originX;
    return { left, right };
  }

  gutter(el: HTMLElement): GutterRange {
    const r = el.getBoundingClientRect();
    return { left: this.snap(r.left) - this.originX, right: this.snap(r.right) - this.originX };
  }

  /**
   * A span's band in `editor`, on the stage. An empty span (an insertion or
   * deletion point) is POINT_PX tall: below the boundary, or above it for the
   * point after the last line — exactly the rows the pane's marker paints.
   */
  band(editor: monaco.editor.IStandaloneCodeEditor, span: LineSpan, lineHeight: number, pointPx = POINT_PX): Band {
    const top = editor.getContainerDomNode().getBoundingClientRect().top;
    const [y0, y1] = spanY(editor, span, lineHeight);
    const a = this.snap(top + y0) - this.originY;
    if (!isEmptySpan(span)) {
      return [a, this.snap(top + y1) - this.originY];
    }
    const count = editor.getModel()?.getLineCount() ?? 1;
    return span.start > count ? [a - pointPx, a] : [a, a + pointPx];
  }
}

/**
 * Draws the JetBrains-style connecting bands on ONE full-width SVG stage that
 * spans all five columns (a late sibling of the panes, covering the
 * editor-row area of the grid), in absolute stage coordinates.
 *
 * A PENDING side is one continuous band: its line tint in the side pane, a
 * polygon FILLED with the same tint across the gutter, and the tint in the
 * result — every edge on the same row (see Frame), and each end two
 * device pixels INTO the pane it meets, so no column of the gutter's border
 * can show between them at any zoom. A side that was TAKEN keeps its ribbon,
 * muted (`jb-ribbon-trace`, the muted tint its pane and the Result wear) —
 * the trace of where the Result's text came from, half done or resolved. A
 * side that was DISCARDED draws none: its pane keeps an outline, and nothing
 * joins it to the Result. High contrast themes add a solid edge to every
 * band (the `jb-ribbon-frame` paths; diff.css shows them only there).
 *
 * A band that ends at a POINT (an insertion or deletion point, in the result
 * or in a side pane) meets a line in the point's colour, and so its ribbon's
 * end is that colour too — a cap on the point's own rows (`jb-ribbon-cap`),
 * never a bright line ending in a dull strip.
 *
 * Every path says what it draws: `data-block`, `data-side`, `data-tone`,
 * `data-state` ("pending" / "took") and `data-phase` — whether its change is
 * "open", "half" (one side in) or "resolved".
 */
export class RibbonOverlay {
  private readonly svg: SVGSVGElement;
  private readonly subs: monaco.IDisposable[] = [];
  private cancelDraw?: () => void;

  constructor(
    private readonly gutterA: HTMLElement,
    private readonly gutterB: HTMLElement,
    private readonly editors: MergeEditors,
    private readonly getModel: () => MergeModel | undefined,
    private readonly options: RibbonOptions = {},
  ) {
    this.svg = createStage();
    // Last child of the grid: paints above the panes' z-auto content while
    // the gutter button layers (z-index 2) stay above the bands.
    (gutterA.parentElement ?? gutterA).appendChild(this.svg);

    for (const editor of [editors.left, editors.result, editors.right]) {
      this.subs.push(editor.onDidScrollChange(() => this.scheduleDraw()));
      this.subs.push(editor.onDidLayoutChange(() => this.scheduleDraw()));
    }
    this.scheduleDraw();
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

  /** The drawing stage (tests read the bands off it). */
  public get stage(): SVGSVGElement {
    return this.svg;
  }

  private draw(): void {
    clearChildren(this.svg);
    const model = this.getModel();
    if (!model) {
      return;
    }
    const lineHeight = this.editors.left.getOption(monaco.editor.EditorOption.lineHeight);
    const frame = new Frame(this.svg);
    const gutterA = frame.gutter(this.gutterA);
    const gutterB = frame.gutter(this.gutterB);
    // Measured once a draw: each gutter's reach into the editors either side.
    const reachA = frame.reach(gutterA, this.editors.left.getDomNode(), this.editors.result.getDomNode());
    const reachB = frame.reach(gutterB, this.editors.result.getDomNode(), this.editors.right.getDomNode());
    const stripA: IconStrip = { side: "a", width: MERGE_ICON_STRIP };
    const stripB: IconStrip = { side: "b", width: MERGE_ICON_STRIP };
    const pointPx = mergePointPx();

    // A pane's edge line is a 1px border (diff.css).
    const line = 1;

    for (const block of model.blocks) {
      const tone = paintTone(block);
      const resolved = this.options.isResolved?.(block) ?? false;
      const fateOf = (side: Side): SideFate => {
        if (this.options.sideFate) return this.options.sideFate(block, side);
        return (this.options.isSideDone?.(block, side) ?? false) ? "took" : "pending";
      };
      const present = (["left", "right"] as const).filter((s) => (s === "left" ? block.left : block.right));
      const fates = new Map(present.map((s) => [s, fateOf(s)] as const));
      const handled = [...fates.values()].some((f) => f !== "pending");
      const phase = resolved ? "resolved" : handled || (this.options.isSeeded?.(block) ?? false) ? "half" : "open";
      const resultSpan = this.options.resultSpanOf?.(block) ?? block.baseSpan;
      const result = frame.band(this.editors.result, resultSpan, lineHeight, pointPx);

      // Each side's FULL region (its change plus the passthrough lines of the
      // block), so the band meets the same rows the pane highlights and the
      // alignment spacers balance.
      for (const side of present) {
        const fate = fates.get(side)!;
        if (fate === "discarded") {
          // Set aside: nothing joins it to the Result any more.
          continue;
        }
        const editor = side === "left" ? this.editors.left : this.editors.right;
        const sideSpan = sideBlockSpan(block, side);
        const region = frame.band(editor, sideSpan, lineHeight, pointPx);
        const [gutter, a, b, strip, reach] =
          side === "left"
            ? [gutterA, region, result, stripA, reachA]
            : [gutterB, result, region, stripB, reachB];
        const geometry = bandGeometry(gutter, frame.height, a, b, reach, strip);
        if (!geometry) {
          continue;
        }
        const took = fate === "took";
        const data = { block: String(block.id), side, tone, state: took ? "took" : "pending", phase };
        appendBand(this.svg, geometry, "jb-ribbon-base", data);
        appendBand(this.svg, geometry, took ? `jb-ribbon-trace jb-ribbon-trace-${tone}` : `jb-ribbon jb-ribbon-${tone}`, data);
        appendEdges(
          this.svg,
          geometry,
          took ? `jb-ribbon-frame jb-ribbon-trace-edge-${tone}` : `jb-ribbon-frame jb-ribbon-frame-${tone}`,
          data,
          line,
        );
        // An end at a POINT is capped in the colour of the point's own line,
        // on its rows: the pane's line carries on into the ribbon. An open
        // point is drawn in the point colour; a settled one (a taken side, or
        // the Result once a side of the change is in) in the faint outline
        // colour.
        const openCap = `jb-ribbon-cap jb-ribbon-cap-${tone}`;
        const settledCap = `jb-ribbon-cap jb-ribbon-cap-trace-${tone}`;
        const sideAt: "a" | "b" = side === "left" ? "a" : "b";
        const resultAt: "a" | "b" = side === "left" ? "b" : "a";
        if (isEmptySpan(sideSpan)) {
          appendCap(this.svg, gutter, reach, region, sideAt, true, took ? settledCap : openCap, data);
        }
        if (isEmptySpan(resultSpan)) {
          appendCap(this.svg, gutter, reach, result, resultAt, false, phase === "open" ? openCap : settledCap, data);
        }
      }
    }
  }

  public dispose(): void {
    this.cancelDraw?.();
    this.cancelDraw = undefined;
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.subs.length = 0;
    this.svg.remove();
  }
}

/**
 * Single-gutter ribbon overlay for the 2-way diff: each block's left span is
 * linked to its right span across the one gutter column between the panes.
 */
export class DiffRibbonOverlay {
  private readonly svg: SVGSVGElement;
  private readonly subs: monaco.IDisposable[] = [];
  private cancelDraw?: () => void;

  constructor(
    private readonly gutter: HTMLElement,
    private readonly editors: DiffEditors,
    private readonly getModel: () => DiffModel | undefined,
  ) {
    this.svg = createStage();
    (gutter.parentElement ?? gutter).appendChild(this.svg);

    for (const editor of [editors.left, editors.right]) {
      this.subs.push(editor.onDidScrollChange(() => this.scheduleDraw()));
      this.subs.push(editor.onDidLayoutChange(() => this.scheduleDraw()));
    }
    this.scheduleDraw();
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

  private draw(): void {
    clearChildren(this.svg);
    const model = this.getModel();
    if (!model) {
      return;
    }
    const lineHeight = this.editors.left.getOption(monaco.editor.EditorOption.lineHeight);
    const frame = new Frame(this.svg);
    const gutter = frame.gutter(this.gutter);
    const reach = frame.reach(gutter, this.editors.left.getDomNode(), this.editors.right.getDomNode());
    for (const block of model.blocks) {
      const left = frame.band(this.editors.left, block.leftSpan, lineHeight);
      const right = frame.band(this.editors.right, block.rightSpan, lineHeight);
      const geometry = bandGeometry(gutter, frame.height, left, right, reach, {
        side: "a",
        width: DIFF_ICON_STRIP,
      });
      if (geometry) {
        appendBand(this.svg, geometry, "jb-ribbon-base", { tone: block.role });
        appendBand(this.svg, geometry, `jb-ribbon jb-ribbon-${block.role}`, { tone: block.role });
      }
    }
  }

  public dispose(): void {
    this.cancelDraw?.();
    this.cancelDraw = undefined;
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.subs.length = 0;
    this.svg.remove();
  }
}

/**
 * The viewport Y of the boundary ABOVE `line` — which, for the point after
 * the last line (line = lineCount + 1, where an insertion after an
 * unterminated last line sits), is the last line's BOTTOM edge. Monaco clamps
 * getTopForLineNumber to the last line, which drew such a point at the top of
 * the line it comes after: the preview said "above b" while the write went
 * after it.
 */
export function lineTopY(
  editor: monaco.editor.IStandaloneCodeEditor,
  line: number,
  lineHeight: number,
): number {
  const count = editor.getModel()?.getLineCount() ?? 1;
  const scrollTop = editor.getScrollTop();
  if (line > count) return editor.getTopForLineNumber(count) + lineHeight - scrollTop;
  return editor.getTopForLineNumber(line) - scrollTop;
}

/** Returns [topY, bottomY] of a span in the editor's viewport coordinates (a point: top === bottom). */
export function spanY(
  editor: monaco.editor.IStandaloneCodeEditor,
  span: LineSpan,
  lineHeight: number,
): [number, number] {
  const scrollTop = editor.getScrollTop();
  const top = lineTopY(editor, span.start, lineHeight);
  if (isEmptySpan(span)) {
    return [top, top];
  }
  const bottom =
    editor.getTopForLineNumber(span.endExclusive - 1) + lineHeight - scrollTop;
  return [top, bottom];
}

interface BandGeometry {
  top: Array<[number, number]>;
  bottom: Array<[number, number]>;
  roundable: (x: number) => boolean;
}

/**
 * The top and bottom runs of a band across one gutter, or undefined when it is
 * wholly off-screen. `a` meets the gutter's left edge (the pane before it), `b`
 * its right edge. With an icon strip, the band stays RECTANGULAR across the
 * strip — the gutter action icons live there, inside the colour — and only
 * slants toward the other pane in the remaining width. Both runs meet the
 * panes EXACTLY on their band edges, and then carry on flat for `overlap` (two
 * device pixels) into each pane: wherever the browser starts the pane's band
 * — on the CSS pixel the snap chose, or on a device pixel either side of it —
 * the gutter's border column in between is covered, never a hairline across
 * the band. Over the pane's band the overlap paints the very same colour
 * (base + tint), so it cannot show.
 */
function bandGeometry(
  gutter: GutterRange,
  height: number,
  a: Band,
  b: Band,
  reach: { left: number; right: number },
  strip?: IconStrip,
): BandGeometry | undefined {
  const [aTop, aBottom] = a;
  const [bTop, bBottom] = b;
  if ((aBottom < 0 && bBottom < 0) || (aTop > height && bTop > height)) {
    return undefined;
  }
  const x0 = gutter.left;
  const x1 = gutter.right;
  const width = x1 - x0;
  // Degrade to a plain trapezoid when the gutter is too narrow for a slant.
  const stripWidth = strip ? Math.min(strip.width, width - 8) : 0;
  const run = (ya: number, yb: number): Array<[number, number]> => {
    const pts: Array<[number, number]> = [[reach.left, ya], [x0, ya]];
    if (strip && stripWidth > 0 && strip.side === "a") pts.push([x0 + stripWidth, ya]);
    else if (strip && stripWidth > 0 && strip.side === "b") pts.push([x1 - stripWidth, yb]);
    pts.push([x1, yb], [reach.right, yb]);
    return pts;
  };
  // The corners at the gutter edges stay sharp: they sit flush against the
  // panes' line highlights.
  return { top: run(aTop, bTop), bottom: run(aBottom, bBottom), roundable: (x) => x > x0 + 0.5 && x < x1 - 0.5 };
}

type PathData = Record<string, string>;

/** A filled band: a closed ring of the top run and the reversed bottom run. */
function appendBand(target: SVGElement, g: BandGeometry, className: string, data: PathData, style?: string): void {
  const ring = [...g.top, ...g.bottom.slice().reverse()];
  appendPath(target, roundedPath(ring, 0, g.roundable) + " Z", className, data, style);
}

/**
 * The cap on a band's end at a POINT: the point's own rows (`rows`, a
 * mergePointPx-tall band), from the overlap inside the pane to CAP_PX into
 * the gutter — or across the whole icon strip beside a side pane, where the
 * band is flat — in the point's colour. `end` is the gutter edge it sits at
 * ("a" its left, "b" its right).
 */
function appendCap(
  target: SVGElement,
  gutter: GutterRange,
  reach: { left: number; right: number },
  rows: Band,
  end: "a" | "b",
  flat: boolean,
  className: string,
  data: PathData,
): void {
  const width = gutter.right - gutter.left;
  const run = flat ? Math.max(0, Math.min(MERGE_ICON_STRIP, width - 8)) : CAP_PX;
  // Through the seam itself, as every band's edge runs (a vertex exactly on
  // the gutter's edge, where the browser paints it), then on into the pane.
  const xs = end === "a" ? [reach.left, gutter.left, gutter.left + run] : [gutter.right - run, gutter.right, reach.right];
  const [y0, y1] = rows;
  const top = xs.map((x) => `${fmt(x)} ${fmt(y0)}`);
  const bottom = xs.slice().reverse().map((x) => `${fmt(x)} ${fmt(y1)}`);
  appendPath(target, `M ${top.join(" L ")} L ${bottom.join(" L ")} Z`, className, data);
}

/**
 * A band's top and bottom edge lines, `width` thick (a pane border's width in
 * whole device pixels), INSIDE the band: the top line on its first rows, the
 * bottom line on its last — the rows a pane's `border-top` / `border-bottom`
 * occupy on the band's first and last line.
 */
function appendEdges(target: SVGElement, g: BandGeometry, className: string, data: PathData, width: number): void {
  const style = `stroke-width:${fmt(width)}px`;
  appendPath(target, roundedPath(g.top, width / 2, g.roundable), className, { ...data, edge: "top" }, style);
  appendPath(target, roundedPath(g.bottom, -width / 2, g.roundable), className, { ...data, edge: "bottom" }, style);
}

function appendPath(target: SVGElement, d: string, className: string, data: PathData, style?: string): void {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", className);
  if (style) path.setAttribute("style", style);
  for (const [key, value] of Object.entries(data)) {
    path.setAttribute(`data-${key}`, value);
  }
  target.appendChild(path);
}

/**
 * SVG path through the points (with a uniform y offset), rounding the bend
 * at each interior vertex with a quadratic join. `roundable` can exempt
 * vertices that must stay sharp; first/last points are never rounded.
 */
function roundedPath(
  points: Array<[number, number]>,
  dy: number,
  roundable: (x: number) => boolean = () => true,
): string {
  const pts = points.map(([x, y]) => [x, y + dy] as [number, number]);
  let d = `M ${fmt(pts[0][0])} ${fmt(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [px, py] = pts[i];
    if (!roundable(px)) {
      d += ` L ${fmt(px)} ${fmt(py)}`;
      continue;
    }
    const [ix, iy] = pts[i - 1];
    const [ox, oy] = pts[i + 1];
    const inLen = Math.hypot(px - ix, py - iy);
    const outLen = Math.hypot(ox - px, oy - py);
    const r = Math.min(BEND_RADIUS, inLen / 2, outLen / 2);
    if (r < 0.5 || inLen === 0 || outLen === 0) {
      d += ` L ${fmt(px)} ${fmt(py)}`;
      continue;
    }
    const inX = px - ((px - ix) * r) / inLen;
    const inY = py - ((py - iy) * r) / inLen;
    const outX = px + ((ox - px) * r) / outLen;
    const outY = py + ((oy - py) * r) / outLen;
    d += ` L ${fmt(inX)} ${fmt(inY)} Q ${fmt(px)} ${fmt(py)} ${fmt(outX)} ${fmt(outY)}`;
  }
  const [lx, ly] = pts[pts.length - 1];
  d += ` L ${fmt(lx)} ${fmt(ly)}`;
  return d;
}

/** The full-width drawing stage covering the grid's editor-row area. */
function createStage(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("class", "jb-ribbon-stage");
  svg.setAttribute("preserveAspectRatio", "none");
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

function clearChildren(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

/** Enough digits for any device-pixel grid (1/3 px at 3x), none that matter beyond it. */
function fmt(value: number): string {
  return String(Math.round(value * 1000) / 1000);
}

