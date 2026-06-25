import * as monaco from "monaco-editor";
import type {
  ChangeBlock,
  DiffModel,
  LineSpan,
  MergeModel,
  Side,
} from "@gitstudio/engine/types";
import { blockRole, isEmptySpan } from "@gitstudio/engine/types";
import type { DiffEditors, MergeEditors } from "./decorations";

const SVG_NS = "http://www.w3.org/2000/svg";

/**
 * Width of the straight, rectangular segment of a merge-gutter band that hugs
 * the side pane. The accept/ignore icons live inside this segment, and the
 * slanted connection to the result pane only starts after it — IntelliJ's
 * layout, and what keeps the icons inside the color at every scroll offset.
 * Must fit the action row built in mergeView.makeActions (2 buttons + gaps).
 */
export const MERGE_ICON_STRIP = 46;

/** Same idea for the 2-way diff's single transfer button (left-anchored). */
export const DIFF_ICON_STRIP = 24;

/** Which edge of the gutter carries the rectangular icon segment. */
type StripSide = "a" | "b";

interface IconStrip {
  side: StripSide;
  width: number;
}

/** Corner radius for the frame-line and band bends. */
const BEND_RADIUS = 7;

export interface RibbonOptions {
  /** Current result-pane span for a block (defaults to its base span). */
  resultSpanOf?: (block: ChangeBlock) => LineSpan;
  /** Fully resolved blocks are not drawn. */
  isResolved?: (block: ChangeBlock) => boolean;
  /** Already-processed sides of a partially resolved block are not drawn. */
  isSideDone?: (block: ChangeBlock, side: Side) => boolean;
}

/** A gutter's horizontal placement on the stage. */
interface GutterRange {
  left: number;
  width: number;
}

/**
 * Draws the JetBrains-style connecting bands and the conflict frame lines on
 * ONE full-width SVG stage that spans all five columns (a late sibling of the
 * panes, covering the editor-row area of the grid). Everything — gutter
 * bands, icon strips, and the frame lines running across the panes — lives
 * inside this single viewport in absolute stage coordinates, so nothing
 * depends on overflow, clip-path, or per-gutter stacking behavior, and each
 * frame edge is one continuous path by construction.
 */
export class RibbonOverlay {
  private readonly svg: SVGSVGElement;
  private readonly subs: monaco.IDisposable[] = [];
  private rafHandle = 0;

  constructor(
    private readonly gutterA: HTMLElement,
    private readonly gutterB: HTMLElement,
    private readonly editors: MergeEditors,
    private readonly getModel: () => MergeModel | undefined,
    private readonly options: RibbonOptions = {},
  ) {
    this.svg = createStage();
    // Last child of the grid: paints above the panes' z-auto content while
    // the gutter button layers (z-index 2) stay above the lines.
    (gutterA.parentElement ?? gutterA).appendChild(this.svg);

    for (const editor of [editors.left, editors.result, editors.right]) {
      this.subs.push(editor.onDidScrollChange(() => this.scheduleDraw()));
      this.subs.push(editor.onDidLayoutChange(() => this.scheduleDraw()));
    }
    this.scheduleDraw();
  }

  public scheduleDraw(): void {
    if (this.rafHandle) {
      return;
    }
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.draw();
    });
  }

  private draw(): void {
    clearChildren(this.svg);
    const model = this.getModel();
    if (!model) {
      return;
    }
    const lineHeight = this.editors.left.getOption(
      monaco.editor.EditorOption.lineHeight,
    );
    const stageRect = this.svg.getBoundingClientRect();
    const rectA = this.gutterA.getBoundingClientRect();
    const rectB = this.gutterB.getBoundingClientRect();
    const gutterA: GutterRange = {
      left: rectA.left - stageRect.left,
      width: rectA.width,
    };
    const gutterB: GutterRange = {
      left: rectB.left - stageRect.left,
      width: rectB.width,
    };
    const stageWidth = stageRect.width;
    const height = stageRect.height;

    for (const block of model.blocks) {
      if (this.options.isResolved?.(block)) {
        continue;
      }
      const role = blockRole(block);
      const resultSpan = this.options.resultSpanOf?.(block) ?? block.baseSpan;
      const leftPending =
        !!block.left && !this.options.isSideDone?.(block, "left");
      const rightPending =
        !!block.right && !this.options.isSideDone?.(block, "right");

      const sideL =
        leftPending && block.left
          ? spanY(this.editors.left, block.left.sideSpan, lineHeight)
          : undefined;
      const sideR =
        rightPending && block.right
          ? spanY(this.editors.right, block.right.sideSpan, lineHeight)
          : undefined;
      const result = spanY(this.editors.result, resultSpan, lineHeight);

      if (sideL) {
        appendRibbon(this.svg, gutterA, height, sideL, result, role, {
          side: "a",
          width: MERGE_ICON_STRIP,
        });
      }
      if (sideR) {
        appendRibbon(this.svg, gutterB, height, result, sideR, role, {
          side: "b",
          width: MERGE_ICON_STRIP,
        });
      }

      // Conflict frame: ONE path per edge spanning every covered column, so
      // every bend (strip boundaries AND pane junctions) is an interior
      // vertex and gets rounded — path endpoints can't be.
      if (role === "conflict" && (sideL || sideR)) {
        appendFrame(this.svg, height, {
          top: framePolyline(
            sideL?.[0],
            result[0],
            sideR?.[0],
            gutterA,
            gutterB,
            stageWidth,
          ),
          bottom: framePolyline(
            sideL?.[1],
            result[1],
            sideR?.[1],
            gutterA,
            gutterB,
            stageWidth,
          ),
        });
      }
    }
  }

  public dispose(): void {
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
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
  private rafHandle = 0;

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
    if (this.rafHandle) {
      return;
    }
    this.rafHandle = requestAnimationFrame(() => {
      this.rafHandle = 0;
      this.draw();
    });
  }

  private draw(): void {
    clearChildren(this.svg);
    const model = this.getModel();
    if (!model) {
      return;
    }
    const lineHeight = this.editors.left.getOption(
      monaco.editor.EditorOption.lineHeight,
    );
    const stageRect = this.svg.getBoundingClientRect();
    const rect = this.gutter.getBoundingClientRect();
    const gutter: GutterRange = {
      left: rect.left - stageRect.left,
      width: rect.width,
    };
    const height = stageRect.height;

    for (const block of model.blocks) {
      const left = spanY(this.editors.left, block.leftSpan, lineHeight);
      const right = spanY(this.editors.right, block.rightSpan, lineHeight);
      appendRibbon(this.svg, gutter, height, left, right, block.role, {
        side: "a",
        width: DIFF_ICON_STRIP,
      });
    }
  }

  public dispose(): void {
    if (this.rafHandle) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = 0;
    }
    for (const sub of this.subs) {
      sub.dispose();
    }
    this.subs.length = 0;
    this.svg.remove();
  }
}

/** Returns [topY, bottomY] of a span in the editor's viewport coordinates. */
function spanY(
  editor: monaco.editor.IStandaloneCodeEditor,
  span: LineSpan,
  lineHeight: number,
): [number, number] {
  const scrollTop = editor.getScrollTop();
  const top = editor.getTopForLineNumber(span.start) - scrollTop;
  if (isEmptySpan(span)) {
    return [top, top];
  }
  const bottom =
    editor.getTopForLineNumber(span.endExclusive - 1) + lineHeight - scrollTop;
  return [top, bottom];
}

/**
 * Draws one flat connector band (and, for conflicts, its frame lines) onto
 * the stage. `a` is the gutter's left edge (the pane before it), `b` its
 * right edge. With an icon strip, the band stays RECTANGULAR across the
 * strip — the gutter action icons live there, glued to the color — and only
 * slants toward the other pane in the remaining width. Frame lines run from
 * `frame.fromX` to `frame.toX` across the panes as one continuous path.
 */
function appendRibbon(
  target: SVGElement,
  gutter: GutterRange,
  height: number,
  a: [number, number],
  b: [number, number],
  role: string,
  strip?: IconStrip,
): void {
  const [aTop, aBottom] = a;
  const [bTop, bBottom] = b;
  if ((aBottom < 0 && bBottom < 0) || (aTop > height && bTop > height)) {
    return; // fully outside the viewport
  }

  const x0 = gutter.left;
  const x1 = gutter.left + gutter.width;
  // x of the strip boundary; degrade to a plain trapezoid when the gutter is
  // too narrow for a meaningful slant region.
  const stripWidth = strip ? Math.min(strip.width, gutter.width - 8) : 0;
  const topPoints: Array<[number, number]> = [];
  const bottomPoints: Array<[number, number]> = [];
  if (strip && stripWidth > 0 && strip.side === "a") {
    topPoints.push([x0, aTop], [x0 + stripWidth, aTop], [x1, bTop]);
    bottomPoints.push([x0, aBottom], [x0 + stripWidth, aBottom], [x1, bBottom]);
  } else if (strip && stripWidth > 0 && strip.side === "b") {
    topPoints.push([x0, aTop], [x1 - stripWidth, bTop], [x1, bTop]);
    bottomPoints.push([x0, aBottom], [x1 - stripWidth, bBottom], [x1, bBottom]);
  } else {
    topPoints.push([x0, aTop], [x1, bTop]);
    bottomPoints.push([x0, aBottom], [x1, bBottom]);
  }

  // Band fill: a closed ring of the top run + reversed bottom run, with the
  // interior bends rounded. The corners at the gutter edges stay sharp —
  // they must sit flush against the pane line-highlights.
  const ring = [...topPoints, ...bottomPoints.slice().reverse()];
  const d =
    roundedPath(ring, 0, (x) => x > x0 + 0.5 && x < x1 - 0.5) + " Z";

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", d);
  path.setAttribute("class", `jb-ribbon jb-ribbon-${role}`);
  target.appendChild(path);
}

/**
 * One conflict frame edge (top or bottom) as a single polyline across every
 * column the conflict still covers: left pane → gutter A (strip, then
 * slant) → result pane → gutter B (slant, then strip) → right pane. Sides
 * already resolved (undefined y) shorten the line accordingly.
 */
function framePolyline(
  leftY: number | undefined,
  resultY: number,
  rightY: number | undefined,
  gutterA: GutterRange,
  gutterB: GutterRange,
  stageWidth: number,
): Array<[number, number]> {
  const points: Array<[number, number]> = [];
  const aRight = gutterA.left + gutterA.width;
  const bRight = gutterB.left + gutterB.width;
  if (leftY !== undefined) {
    const stripEnd =
      gutterA.left + Math.min(MERGE_ICON_STRIP, gutterA.width - 8);
    points.push(
      [0, leftY],
      [gutterA.left, leftY],
      [stripEnd, leftY],
      [aRight, resultY],
    );
  } else {
    points.push([aRight, resultY]);
  }
  points.push([gutterB.left, resultY]);
  if (rightY !== undefined) {
    const stripStart =
      bRight - Math.min(MERGE_ICON_STRIP, gutterB.width - 8);
    points.push([stripStart, rightY], [bRight, rightY], [stageWidth, rightY]);
  }
  return points;
}

/** Draws a block's two frame edges, culled when fully outside the viewport. */
function appendFrame(
  target: SVGElement,
  height: number,
  frame: {
    top: Array<[number, number]>;
    bottom: Array<[number, number]>;
  },
): void {
  const ys = [...frame.top, ...frame.bottom].map(([, y]) => y);
  if (Math.max(...ys) < 0 || Math.min(...ys) > height) {
    return;
  }
  // +0.5 keeps the 1px stroke crisp on its pixel row.
  appendEdge(target, roundedPath(frame.top, 0.5));
  appendEdge(target, roundedPath(frame.bottom, 0.5));
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

/** One solid conflict-boundary line (pane + gutter + pane, one path). */
function appendEdge(target: SVGElement, d: string): void {
  const edge = document.createElementNS(SVG_NS, "path");
  edge.setAttribute("d", d);
  edge.setAttribute("class", "jb-ribbon-edge");
  target.appendChild(edge);
}

/** The full-width drawing stage covering the grid's editor-row area. */
function createStage(): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg") as SVGSVGElement;
  svg.setAttribute("class", "jb-ribbon-stage");
  svg.setAttribute("preserveAspectRatio", "none");
  return svg;
}

function clearChildren(node: Element): void {
  while (node.firstChild) {
    node.removeChild(node.firstChild);
  }
}

function fmt(value: number): string {
  return value.toFixed(1);
}
