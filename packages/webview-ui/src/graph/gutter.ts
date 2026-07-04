// Renders ONE commit-graph row's gutter to an SVG markup string: the lane
// segments crossing the row (straight verticals + smooth bezier S-curves for
// lane shifts and merge/branch diagonals) and the commit node itself (a filled
// circle, hollow-ringed for merges). Pure string output so the virtualizer can
// drop it into each row's innerHTML cheaply — no per-segment DOM nodes.

import type { WireRow, WireSegment } from "@gitstudio/host-bridge/graphProtocol";

export interface GutterOptions {
  /** Horizontal pitch between lanes, px. */
  colWidth: number;
  /** Row height, px (segments span the full height, top→bottom). */
  rowHeight: number;
  /** Commit node radius, px. */
  nodeRadius: number;
  /** Left inset (px) added to every lane x — leaves room for node avatars. */
  nodeInset?: number;
  /** Lane palette; `segment.color` / `row.color` index into it. */
  palette: readonly string[];
  /**
   * Optional focus filter: when set, only segments/colors matching the focused
   * lane color render at full opacity; the rest are dimmed. Used for the
   * hover "focus this lane" affordance. `undefined` = everything full.
   */
  focusColor?: number;
}

/** Lane stroke width — thin enough to feel native, thick enough to read. */
const STROKE_WIDTH = 1.75;
/** Dimmed opacity for unrelated lanes when a lane is focused. */
const DIM_OPACITY = 0.2;

/** Center x of a lane column. Half-pixel aligned so verticals stay crisp. */
export function laneCenterX(
  column: number,
  colWidth: number,
  inset = 0,
): number {
  return Math.round(column * colWidth + colWidth / 2 + inset) + 0.5;
}

function color(palette: readonly string[], index: number): string {
  return palette[index % palette.length] ?? palette[0] ?? "#888";
}

/**
 * Path data for one segment from its top edge column to its bottom edge column.
 * Straight vertical when the columns match; a vertically-symmetric cubic bezier
 * S-curve (control points pinned at mid-height) when they differ, so merges and
 * lane shifts sweep smoothly instead of kinking.
 */
export function segmentPath(
  seg: WireSegment,
  colWidth: number,
  rowHeight: number,
  inset = 0,
): string {
  const x0 = laneCenterX(seg.fromColumn, colWidth, inset);
  const x1 = laneCenterX(seg.toColumn, colWidth, inset);
  const y0 = 0;
  const y1 = rowHeight;
  if (seg.fromColumn === seg.toColumn) {
    return `M${x0} ${y0}V${y1}`;
  }
  const midY = rowHeight / 2;
  // Control points at mid-height on each lane's x: a smooth S whose tangents
  // are vertical at both edges, so it joins the rows above/below seamlessly.
  return `M${x0} ${y0}C${x0} ${midY} ${x1} ${midY} ${x1} ${y1}`;
}

/**
 * Renders the row's gutter as an `<svg>…</svg>` markup string sized to
 * `width × rowHeight`. Segments are drawn first (so the node sits on top),
 * each as a stroked path in its lane color; then the commit node — a filled
 * circle for ordinary commits, a thicker hollow ring with a hole punched
 * through (via the background) for merges, which distinguishes them at a glance.
 */
export function renderRowGutterSVG(
  row: WireRow,
  opts: GutterOptions,
  width: number,
): string {
  const { colWidth, rowHeight, nodeRadius, palette, focusColor } = opts;
  const inset = opts.nodeInset ?? 0;
  const cx = laneCenterX(row.column, colWidth, inset);
  const cy = Math.round(rowHeight / 2) + 0.5;

  // Draw diagonals (lane shifts / merges) first, then straight verticals on top
  // — a vertical through-lane should read as continuous over a curve that peels
  // off it, which gives clean GitKraken-style junctions instead of muddy
  // crossings. Within each group, dimmed (unfocused) lanes render first so the
  // focused lane always wins the z-order.
  const diagonals: string[] = [];
  const verticals: string[] = [];
  const dimDiagonals: string[] = [];
  const dimVerticals: string[] = [];
  for (const seg of row.segments) {
    const dim = focusColor !== undefined && seg.color !== focusColor;
    const opacity = dim ? ` opacity="${DIM_OPACITY}"` : "";
    const d = segmentPath(seg, colWidth, rowHeight, inset);
    const markup =
      `<path d="${d}" fill="none" stroke="${color(palette, seg.color)}" ` +
      `stroke-width="${STROKE_WIDTH}" stroke-linecap="round" ` +
      `stroke-linejoin="round"${opacity}/>`;
    const straight = seg.fromColumn === seg.toColumn;
    if (dim) (straight ? dimVerticals : dimDiagonals).push(markup);
    else (straight ? verticals : diagonals).push(markup);
  }
  const paths =
    dimDiagonals.join("") +
    dimVerticals.join("") +
    diagonals.join("") +
    verticals.join("");

  const nodeColor = color(palette, row.color);
  const nodeDim = focusColor !== undefined && row.color !== focusColor;
  const nodeOpacity = nodeDim ? ` opacity="${DIM_OPACITY}"` : "";
  // The hole-colored halo radius: large enough that crossing lanes never fuse
  // into the node, scaled to the avatar that sits on top of ordinary nodes.
  const halo = nodeRadius + 1.6;
  let node: string;
  if (row.isMerge) {
    // Merge = a hollow ring stroked in the lane color over a punched-out hole,
    // so merges read as junctions and stand apart from ordinary nodes. The
    // hole-colored halo first keeps crossing lanes from fusing into it.
    const r = nodeRadius + 0.7;
    node =
      `<circle cx="${cx}" cy="${cy}" r="${halo + 0.4}" ` +
      `fill="var(--gs-graph-node-hole)"${nodeOpacity}/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--gs-graph-node-hole)" ` +
      `stroke="${nodeColor}" stroke-width="2.1"${nodeOpacity}/>`;
  } else {
    // Filled dot with a faint same-background halo so adjacent lane lines never
    // visually fuse into the node.
    node =
      `<circle cx="${cx}" cy="${cy}" r="${halo}" ` +
      `fill="var(--gs-graph-node-hole)"${nodeOpacity}/>` +
      `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${nodeColor}"${nodeOpacity}/>`;
  }

  return (
    `<svg class="gs-gutter-svg" width="${width}" height="${rowHeight}" ` +
    `viewBox="0 0 ${width} ${rowHeight}" preserveAspectRatio="none" ` +
    `aria-hidden="true">${paths}${node}</svg>`
  );
}
