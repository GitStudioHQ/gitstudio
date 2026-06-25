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
const STROKE_WIDTH = 1.6;
/** Dimmed opacity for unrelated lanes when a lane is focused. */
const DIM_OPACITY = 0.22;

/** Center x of a lane column. Half-pixel aligned so verticals stay crisp. */
function laneCenterX(column: number, colWidth: number): number {
  return Math.round(column * colWidth + colWidth / 2) + 0.5;
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
): string {
  const x0 = laneCenterX(seg.fromColumn, colWidth);
  const x1 = laneCenterX(seg.toColumn, colWidth);
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
  const cx = laneCenterX(row.column, colWidth);
  const cy = Math.round(rowHeight / 2) + 0.5;

  let paths = "";
  for (const seg of row.segments) {
    const dim = focusColor !== undefined && seg.color !== focusColor;
    const opacity = dim ? ` opacity="${DIM_OPACITY}"` : "";
    paths +=
      `<path d="${segmentPath(seg, colWidth, rowHeight)}" ` +
      `fill="none" stroke="${color(palette, seg.color)}" ` +
      `stroke-width="${STROKE_WIDTH}" stroke-linecap="round"${opacity}/>`;
  }

  const nodeColor = color(palette, row.color);
  const nodeDim = focusColor !== undefined && row.color !== focusColor;
  const nodeOpacity = nodeDim ? ` opacity="${DIM_OPACITY}"` : "";
  let node: string;
  if (row.isMerge) {
    // Hollow ring: a circle stroked in the lane color over a punched-out hole,
    // so merge commits read as junctions and stand apart from ordinary nodes.
    // A faint hole-colored halo first keeps crossing lanes from fusing into it.
    const r = nodeRadius + 0.6;
    node =
      `<circle cx="${cx}" cy="${cy}" r="${r + 1}" ` +
      `fill="var(--gs-graph-node-hole)"${nodeOpacity}/>` +
      `<circle cx="${cx}" cy="${cy}" r="${r}" fill="var(--gs-graph-node-hole)" ` +
      `stroke="${nodeColor}" stroke-width="2"${nodeOpacity}/>`;
  } else {
    // Filled dot with a faint same-background halo so adjacent lane lines never
    // visually fuse into the node, then a hairline lane-colored ring for crisp
    // edge definition against the hole.
    node =
      `<circle cx="${cx}" cy="${cy}" r="${nodeRadius + 1.4}" ` +
      `fill="var(--gs-graph-node-hole)"${nodeOpacity}/>` +
      `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${nodeColor}"${nodeOpacity}/>`;
  }

  return (
    `<svg class="gs-gutter-svg" width="${width}" height="${rowHeight}" ` +
    `viewBox="0 0 ${width} ${rowHeight}" preserveAspectRatio="none" ` +
    `aria-hidden="true">${paths}${node}</svg>`
  );
}
