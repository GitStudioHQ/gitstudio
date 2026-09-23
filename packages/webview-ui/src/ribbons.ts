import * as monaco from "monaco-editor";
import type {
  ChangeBlock,
  DiffModel,
  LineSpan,
  MergeModel,
  Side,
} from "@gitstudio/engine/types";
import { blockTone, isEmptySpan, sideBlockSpan } from "@gitstudio/engine/types";
import type { DiffEditors, MergeEditors } from "./decorations";
import { OVERLAY_FALLBACK_MS } from "./limits";

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
 * How tall an insertion or deletion POINT is drawn, in CSS px: the pane's
 * marker line (`jb-point` in diff.css, `jb-marker-*` in the 2-way diff) and
 * the ribbon's end at that point are both exactly this, on the same rows —
 * the line below the boundary, or above it for the point after the last line.
 */
export const POINT_PX = 2;

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
  /** Fully resolved blocks keep only a faint outline, never a fill. */
  isResolved?: (block: ChangeBlock) => boolean;
  /** A handled (applied or ignored) side keeps only a faint outline, never a fill. */
  isSideDone?: (block: ChangeBlock, side: Side) => boolean;
}

/** A gutter's horizontal extent on the stage, snapped to device pixels. */
interface GutterRange {
  left: number;
  right: number;
}

/** A band's [top, bottom] on the stage, snapped to device pixels. */
type Band = [number, number];

/**
 * Stage geometry. Every coordinate a ribbon uses is a CLIENT coordinate
 * rounded to the device-pixel grid, less the stage's own (rounded) origin —
 * because that is where the browser paints the pane's line highlights: a box
 * at a fractional position is snapped to whole device pixels, while an SVG
 * edge at the same fractional position is antialiased across two rows. Both
 * rounded the same way, every band edge in a pane, its ribbon and the result
 * sits on the same device row (scripts/merge-e2e/alignment.ts measures it).
 */
class Frame {
  private readonly dpr = window.devicePixelRatio || 1;
  readonly originX: number;
  readonly originY: number;
  readonly width: number;
  readonly height: number;

  constructor(stage: SVGSVGElement) {
    const rect = stage.getBoundingClientRect();
    this.originX = this.snap(rect.left);
    this.originY = this.snap(rect.top);
    this.width = rect.width;
    this.height = rect.height;
  }

  snap(v: number): number {
    return Math.round(v * this.dpr) / this.dpr;
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
  band(editor: monaco.editor.IStandaloneCodeEditor, span: LineSpan, lineHeight: number): Band {
    const top = editor.getContainerDomNode().getBoundingClientRect().top;
    const [y0, y1] = spanY(editor, span, lineHeight);
    const a = this.snap(top + y0) - this.originY;
    if (!isEmptySpan(span)) {
      return [a, this.snap(top + y1) - this.originY];
    }
    const count = editor.getModel()?.getLineCount() ?? 1;
    return span.start > count ? [a - POINT_PX, a] : [a, a + POINT_PX];
  }
}

/**
 * Draws the JetBrains-style connecting bands on ONE full-width SVG stage that
 * spans all five columns (a late sibling of the panes, covering the
 * editor-row area of the grid), in absolute stage coordinates.
 *
 * A PENDING side is one continuous band: its line tint in the side pane, a
 * polygon FILLED with the same tint across the gutter, and the tint in the
 * result — every edge on the same device row (see Frame). A HANDLED side
 * (applied or ignored), and every side of a resolved block, is calm: no fill,
 * only a faint 1px top and bottom line inside the band's own rows, the same
 * rows the panes draw theirs on. High contrast themes add a solid 1px edge on
 * those rows to pending bands too (the `jb-ribbon-frame` paths; diff.css shows
 * them only there).
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
    const stripA: IconStrip = { side: "a", width: MERGE_ICON_STRIP };
    const stripB: IconStrip = { side: "b", width: MERGE_ICON_STRIP };

    for (const block of model.blocks) {
      const tone = blockTone(block);
      const resolved = this.options.isResolved?.(block) ?? false;
      const resultSpan = this.options.resultSpanOf?.(block) ?? block.baseSpan;
      const result = frame.band(this.editors.result, resultSpan, lineHeight);

      // Each side's FULL region (its change plus the passthrough lines of the
      // block), so the band meets the same rows the pane highlights and the
      // alignment spacers balance.
      for (const side of ["left", "right"] as const) {
        if (!(side === "left" ? block.left : block.right)) {
          continue;
        }
        const editor = side === "left" ? this.editors.left : this.editors.right;
        const region = frame.band(editor, sideBlockSpan(block, side), lineHeight);
        const done = resolved || (this.options.isSideDone?.(block, side) ?? false);
        const [gutter, a, b, strip] =
          side === "left"
            ? [gutterA, region, result, stripA]
            : [gutterB, result, region, stripB];
        const geometry = bandGeometry(gutter, frame.height, a, b, strip);
        if (!geometry) {
          continue;
        }
        const data = { block: String(block.id), side, tone, state: done ? "done" : "pending" };
        if (done) {
          appendEdges(this.svg, geometry, `jb-ribbon-done jb-ribbon-done-${tone}`, data);
        } else {
          appendBand(this.svg, geometry, "jb-ribbon-base", data);
          appendBand(this.svg, geometry, `jb-ribbon jb-ribbon-${tone}`, data);
          appendEdges(this.svg, geometry, `jb-ribbon-frame jb-ribbon-frame-${tone}`, data);
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
    for (const block of model.blocks) {
      const left = frame.band(this.editors.left, block.leftSpan, lineHeight);
      const right = frame.band(this.editors.right, block.rightSpan, lineHeight);
      const geometry = bandGeometry(gutter, frame.height, left, right, {
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
 * slants toward the other pane in the remaining width. Both runs start and end
 * EXACTLY on the band edges of the panes they join.
 */
function bandGeometry(
  gutter: GutterRange,
  height: number,
  a: Band,
  b: Band,
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
  const top: Array<[number, number]> = [];
  const bottom: Array<[number, number]> = [];
  if (strip && stripWidth > 0 && strip.side === "a") {
    top.push([x0, aTop], [x0 + stripWidth, aTop], [x1, bTop]);
    bottom.push([x0, aBottom], [x0 + stripWidth, aBottom], [x1, bBottom]);
  } else if (strip && stripWidth > 0 && strip.side === "b") {
    top.push([x0, aTop], [x1 - stripWidth, bTop], [x1, bTop]);
    bottom.push([x0, aBottom], [x1 - stripWidth, bBottom], [x1, bBottom]);
  } else {
    top.push([x0, aTop], [x1, bTop]);
    bottom.push([x0, aBottom], [x1, bBottom]);
  }
  // The corners at the gutter edges stay sharp: they sit flush against the
  // panes' line highlights.
  return { top, bottom, roundable: (x) => x > x0 + 0.5 && x < x1 - 0.5 };
}

type PathData = Record<string, string>;

/** A filled band: a closed ring of the top run and the reversed bottom run. */
function appendBand(target: SVGElement, g: BandGeometry, className: string, data: PathData): void {
  const ring = [...g.top, ...g.bottom.slice().reverse()];
  appendPath(target, roundedPath(ring, 0, g.roundable) + " Z", className, data);
}

/**
 * A band's top and bottom edge lines, 1px, INSIDE the band: the top line on
 * its first pixel row, the bottom line on its last — the rows a pane's
 * `border-top` / `border-bottom` occupy on the band's first and last line.
 */
function appendEdges(target: SVGElement, g: BandGeometry, className: string, data: PathData): void {
  appendPath(target, roundedPath(g.top, 0.5, g.roundable), className, { ...data, edge: "top" });
  appendPath(target, roundedPath(g.bottom, -0.5, g.roundable), className, { ...data, edge: "bottom" });
}

function appendPath(target: SVGElement, d: string, className: string, data: PathData): void {
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", className);
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

