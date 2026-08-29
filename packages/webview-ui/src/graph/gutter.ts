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
  /**
   * Max vertical px a diagonal's bend occupies, centered in the row, with
   * straight vertical lead-in/lead-out to the row edges. Keeps transitions
   * taut in TALL rows (the sidebar rail's 40px two-line rows) — without it a
   * one-lane shift stretches its S-curve over the full height and reads as a
   * droopy wobble. Omit (default) = the bend spans the full rowHeight, the
   * editor graph's original geometry.
   */
  curveSpan?: number;
  /** Lane stroke width override, px (default 1.75). */
  strokeWidth?: number;
  /**
   * Last lane that fits in `width`. Lanes beyond it are FOLDED onto it rather
   * than drawn past the edge — the gutter clips its overflow, so an unclamped
   * deep lane meant the commit had no node at all: a row of text with nothing
   * in the graph, which reads as "this commit isn't in the history". Folded
   * nodes are marked (see `foldedNode`) so a stacked lane is never mistaken for
   * a real one. Omit for no clamping.
   */
  maxColumn?: number;
}

/** Lane stroke width — thin enough to feel native, thick enough to read. */
const STROKE_WIDTH = 2.1;
/**
 * How far right of a node's centre the FOLD marker reaches, in px, measured
 * from the node's edge: the chevron starts 3.5px out, is 3.2px wide, and its
 * 1.6px stroke adds a further 0.8px.
 *
 * Exported because the caller has to reserve this space when it decides which
 * lane is the last one that fits. Reserving only the node's radius clipped the
 * marker away at roughly one gutter width in four — and a folded node with no
 * marker is indistinguishable from a real lane, which is worse than the
 * clipping this whole mechanism exists to prevent.
 */
export const FOLD_MARKER_REACH = 3.5 + 3.2 + 0.8;

/**
 * The deepest lane whose node AND fold marker fit inside `width`.
 *
 * Lives here, beside the drawing it constrains, and is derived by asking
 * `laneCenterX` itself rather than inverting it arithmetically — that function
 * half-pixel-aligns (`round(...) + 0.5`), so a closed-form estimate disagreed
 * with the real centre and clipped the marker at about one gutter width in
 * four. One implementation, so the renderer and its caller cannot drift.
 */
export function lastDrawableLane(
  width: number,
  colWidth: number,
  inset: number,
  nodeRadius: number,
): number {
  const reach = nodeRadius + FOLD_MARKER_REACH;
  const est = Math.floor((width - inset - colWidth / 2 - reach) / colWidth) + 1;
  for (let c = Math.max(0, est); c > 0; c--) {
    if (laneCenterX(c, colWidth, inset) + reach <= width) return c;
  }
  return 0;
}
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
 *
 * `curveSpan` (optional) confines the bend to a centered vertical span with
 * straight lead-in/lead-out — both joints keep vertical tangents, so rows
 * still chain seamlessly. Omitted or >= rowHeight yields the original
 * full-height sweep.
 */
export function segmentPath(
  seg: WireSegment,
  colWidth: number,
  rowHeight: number,
  inset = 0,
  curveSpan?: number,
  nodeColumn?: number,
): string {
  const x0 = laneCenterX(seg.fromColumn, colWidth, inset);
  const x1 = laneCenterX(seg.toColumn, colWidth, inset);
  const y0 = 0;
  const y1 = rowHeight;
  if (seg.fromColumn === seg.toColumn) {
    return `M${x0} ${y0}V${y1}`;
  }
  const midY = rowHeight / 2;
  // Route edges that TOUCH the commit node through the node point
  // (nodeColumn, midY) so the node always sits ON its own lines. Without this a
  // node whose first parent shifts columns floats off to the side of the curve
  // that sweeps past it (the "lines end up nowhere / node not on its line" bug).
  //   • from === nodeColumn → an edge LEAVING the node (first-parent lane shift
  //     or a branch fork): drop straight to the node, then peel out to its lane.
  //   • to   === nodeColumn → an edge MERGING into the node: curve from the side
  //     INTO the node and stop there (the merged branch ends at the node).
  if (nodeColumn !== undefined) {
    if (seg.fromColumn === nodeColumn) {
      const cy = (midY + y1) / 2;
      return `M${x0} ${y0}V${midY}C${x0} ${cy} ${x1} ${cy} ${x1} ${y1}`;
    }
    if (seg.toColumn === nodeColumn) {
      const cy = midY / 2;
      return `M${x0} ${y0}C${x0} ${cy} ${x1} ${cy} ${x1} ${midY}`;
    }
  }
  if (curveSpan !== undefined && curveSpan < rowHeight) {
    const c0 = (rowHeight - curveSpan) / 2;
    const c1 = rowHeight - c0;
    // Vertical to the bend, the same mid-pinned S across it, vertical out.
    return (
      `M${x0} ${y0}V${c0}` +
      `C${x0} ${midY} ${x1} ${midY} ${x1} ${c1}` +
      `V${y1}`
    );
  }
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
  const strokeWidth = opts.strokeWidth ?? STROKE_WIDTH;
  // Fold lanes deeper than the gutter can show onto its last one. Everything
  // below draws through `lane`, never a raw column, so a deep-fan-out commit
  // keeps a node and its edges instead of being clipped into nothing.
  const cap = opts.maxColumn;
  const lane = (c: number): number => (cap === undefined ? c : Math.min(c, cap));
  const folded = cap !== undefined && row.column > cap;
  const cx = laneCenterX(lane(row.column), colWidth, inset);
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
    const clamped =
      cap === undefined || (seg.fromColumn <= cap && seg.toColumn <= cap)
        ? seg
        : { ...seg, fromColumn: lane(seg.fromColumn), toColumn: lane(seg.toColumn) };
    const d = segmentPath(clamped, colWidth, rowHeight, inset, opts.curveSpan, lane(row.column));
    const markup =
      `<path d="${d}" fill="none" stroke="${color(palette, seg.color)}" ` +
      `stroke-width="${strokeWidth}" stroke-linecap="round" ` +
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
      `stroke="${nodeColor}" stroke-width="2.4"${nodeOpacity}/>`;
  } else {
    // Filled dot with a faint same-background halo so adjacent lane lines never
    // visually fuse into the node.
    node =
      `<circle cx="${cx}" cy="${cy}" r="${halo}" ` +
      `fill="var(--gs-graph-node-hole)"${nodeOpacity}/>` +
      `<circle cx="${cx}" cy="${cy}" r="${nodeRadius}" fill="${nodeColor}"${nodeOpacity}/>`;
  }

  // A folded node sits on a lane that is not really its own, so say so: a small
  // outward chevron past the node, in the lane colour. Without it two commits
  // on genuinely different lanes look like they share one.
  const beyond = !folded
    ? ""
    : `<path d="M${cx + nodeRadius + 3.5} ${cy - 3.5}l3.2 3.5l-3.2 3.5" ` +
      `fill="none" stroke="${nodeColor}" stroke-width="1.6" ` +
      `stroke-linecap="round" stroke-linejoin="round"${nodeOpacity}/>`;

  return (
    `<svg class="gs-gutter-svg" width="${width}" height="${rowHeight}" ` +
    `viewBox="0 0 ${width} ${rowHeight}" preserveAspectRatio="none" ` +
    `aria-hidden="true">${paths}${node}${beyond}</svg>`
  );
}
