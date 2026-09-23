// Every band edge in the merge view sits on the same device pixel in the side
// pane, in its ribbon across the gutter, and in the result — measured on the
// RENDERED page, for every block of every file of every matrix scenario.
//
//   npx tsx scripts/merge-e2e/alignment.ts [--scenarios a,b] [--files a,b] [--hosts ext,desktop]
//       [--dpr 1,1.5,2] [--target <built matrix>] [--no-build] [--json out.json]
//
// Why rendered, and why device pixels: the owner saw the applied-state dashed
// lines in a side pane and in the gutter beside it sit a few pixels apart.
// Nothing in the source said so — the pane drew a CSS border INSIDE the last
// line, the gutter an SVG stroke centred half a pixel BELOW it. The browser
// snaps a box — and an SVG root — at a fractional position to a whole CSS
// pixel (half up) and then scales it to the screen (measured at 1x, 1.5x and
// 2x); an SVG edge inside the stage is antialiased where it falls. So this
// reads what the browser paints, two ways:
//
// THE MODEL (every viewport) —
// - pane:   every Monaco overlay element (content and line-number margin) that
//           names a tone, just inside the pane edge the gutter touches; its
//           background rows, snapped as the browser snaps a box
//           (round(y) × dpr), and its border rows (its CSS width × dpr from
//           that edge — at 1.5x a 1px border is one and a half device rows);
// - ribbon: every path on the ribbon stage; its vertices on that seam, in
//           device pixels (NOT snapped — an off-grid SVG edge is a defect in
//           itself); a fill's extent, a stroke's painted rows (y ± width/2).
// At every seam (both edges of both gutters), for every ribbon end:
// - it must be on the grid the panes are painted on, horizontally and
//   vertically;
// - a filled end must cover EXACTLY the rows the pane paints in that tone
//   there (±0 device px), and reach at least a device column into the pane;
// - a stroke must lie exactly on the first or last row of something the pane
//   paints in that tone there — an edge line, a point line, or a band's fill;
// - where a band meets the RESULT, the result's colour must say the state: the
//   same tint as the ribbon while the change is open, a different one once one
//   side of the conflict is in (the owner: "after Accept Yours the result still
//   wears the full conflict look").
//
// THE PIXELS (every viewport with a filled band on screen) — the model above
// cannot see a column of the gutter's border showing between a ribbon and its
// pane (the critic found one at the gutter|result seams: a half-CSS-pixel
// hairline across every band, at fractional pane widths). So text, line
// numbers, controls and scrollbars are hidden for a moment and the seams are
// photographed, in device pixels:
// - inside every band, every column across the seam is the ribbon's colour or
//   the pane band's — never a third (the gutter's border, the background);
// - where the ribbon is flat (the icon strip beside a side pane), the band's
//   first and last painted rows are the same rows in the gutter and the pane,
//   and so are a handled side's outline rows.
//
// Each file is walked through, page by page, in three states: as it opens;
// half handled — Yours taken on conflicts (Theirs left pending), one-sided
// and identical changes taken or ignored, each through its gutter control
// (handled sides, pending halves and resolved blocks side by side); and
// everything resolved (the bottom bar's Accept Yours), where nothing may be
// drawn across the gutters or in the side panes any more. Coverage is checked
// against oracle.json: every block's every side must have been measured.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { Browser, type Page } from "./cdp";
import { openMerge, type Host } from "./render";
import { buildMatrix, extensionPayload, ORACLE_PATH, type Oracle } from "./oracle";
import { decodePng, hex, pixel, same, type Image } from "./png";

type RGB = [number, number, number];

/** One ribbon end that does not meet its pane. */
export interface Mismatch {
  seam: string;
  block?: string;
  side?: string;
  tone: string;
  kind: "fill" | "stroke" | "pixels" | "state";
  problem: string;
  /** Device pixels. */
  ribbon: [number, number];
  pane: Array<[number, number]>;
}

/** A filled ribbon end on screen, for the pixel pass (device px). */
interface FillEnd {
  seam: string;
  block?: string;
  side?: string;
  tone: string;
  /** The seam's device column: the pane's first (or, left of it, last + 1). */
  x: number;
  /** +1: the gutter is right of the seam (a side pane on the left); -1: left of it. */
  gutterDir: 1 | -1;
  /** Whether the ribbon is flat for 8px into the gutter (the icon strip). */
  flat: boolean;
  top: number;
  bottom: number;
  /** The rows (device) where the band is solid for 9 device px into the gutter: the pixel test's rows. */
  topIn: number;
  bottomIn: number;
}

/** A handled side's outline end on a flat seam, for the pixel pass. */
interface StrokeEnd {
  seam: string;
  block?: string;
  side?: string;
  tone: string;
  x: number;
  gutterDir: 1 | -1;
  top: number;
  bottom: number;
}

/** What one viewport measured. */
interface ViewportReport {
  none?: boolean;
  checked: number;
  seen: string[];
  mismatches: Mismatch[];
  fills: FillEnd[];
  strokes: StrokeEnd[];
  paneTop: number;
  paneBottom: number;
  scrollTop: number;
}

// ── In the page ──────────────────────────────────────────────────────────────

const PROBE = (state: string) => `(() => {
  const STATE = ${JSON.stringify(state)};
  const dpr = window.devicePixelRatio || 1;
  // Where the browser paints a box edge at client v, in device px: it snaps
  // boxes (and SVG roots) to whole CSS px, half up, then scales — measured at
  // 1x, 1.5x and 2x. At 1.5x an odd CSS px is half a device px: that row is
  // antialiased, in the pane and in the ribbon alike.
  const snap = (v) => Math.round(v) * dpr;
  // A border's device rows from its box's snapped edge: its CSS width × dpr,
  // unrounded — at 1.5x a 1px border is one and a half rows, the second one
  // antialiased (measured), and so must a ribbon's edge be.
  const borderPx = (w) => (w > 0 ? w * dpr : 0);
  const near = (a, b) => Math.abs(a - b) < 0.02;
  const grid = document.querySelector(".jb-merge-grid");
  if (!grid) return { none: true, checked: 0, seen: [], mismatches: [], fills: [], strokes: [], paneTop: 0, paneBottom: 0, scrollTop: 0 };
  const bodies = [...grid.children].filter((e) => e.classList.contains("jb-pane-body"));
  const gA = grid.querySelector(".jb-gutter-a").getBoundingClientRect();
  const gB = grid.querySelector(".jb-gutter-b").getBoundingClientRect();
  const stage = grid.querySelector(".jb-ribbon-stage");
  const sr = stage.getBoundingClientRect();
  // (The "applied" names are the rejected builds' dashed style: kept so the
  // proof that this fails on them can still read what they drew.)
  const TONE = /jb-(?:ribbon-(?:done-|frame-|applied-)?|line-|applied-|point-|marker-|frame-|done-)(inserted|deleted|modified|same|conflict)(?![\\w-])/;
  const alpha = (c) => {
    if (!c || c === "none" || c === "transparent") return 0;
    let m = /rgba?\\(([^)]*)\\)/.exec(c);
    if (m) { const p = m[1].split(/[\\s,\\/]+/).filter(Boolean); return p.length > 3 ? parseFloat(p[3]) : 1; }
    m = /color\\([^)]*?\\/\\s*([\\d.]+)\\s*\\)/.exec(c);
    return m ? parseFloat(m[1]) : 1;
  };
  // What a pane paints at client x, per tone: [top, bottom) rows in device px.
  const paneAt = (body, x) => {
    const clip = body.getBoundingClientRect();
    const out = [];
    for (const el of body.querySelectorAll(".view-overlays div, .margin-view-overlays div")) {
      const cls = typeof el.className === "string" ? el.className : "";
      const m = TONE.exec(cls);
      if (!m) continue;
      const r = el.getBoundingClientRect();
      if (r.height <= 0 || x < r.left || x > r.right || r.bottom <= clip.top || r.top >= clip.bottom) continue;
      const cs = getComputedStyle(el);
      const top = snap(r.top), bottom = snap(r.bottom);
      if (alpha(cs.backgroundColor) > 0) out.push({ tone: m[1], kind: "fill", top, bottom, color: cs.backgroundColor });
      const bt = borderPx(parseFloat(cs.borderTopWidth)), bb = borderPx(parseFloat(cs.borderBottomWidth));
      if (cs.borderTopStyle !== "none" && bt > 0 && alpha(cs.borderTopColor) > 0)
        out.push({ tone: m[1], kind: "stroke", top, bottom: top + bt });
      if (cs.borderBottomStyle !== "none" && bb > 0 && alpha(cs.borderBottomColor) > 0)
        out.push({ tone: m[1], kind: "stroke", top: bottom - bb, bottom });
    }
    return { out, top: snap(clip.top), bottom: snap(clip.bottom), left: snap(clip.left), right: snap(clip.right) };
  };
  // flat: the ribbon keeps its rows for 8px into the gutter — the icon strip
  // hugging a side pane.
  const seams = [
    { name: "yours|gutter", x: gA.left, body: bodies[0], sample: gA.left - 2, paneEdge: "right", gutterDir: 1, flat: true },
    { name: "gutter|result", x: gA.right, body: bodies[1], sample: gA.right + 2, paneEdge: "left", gutterDir: -1, flat: false },
    { name: "result|gutter", x: gB.left, body: bodies[1], sample: gB.left - 2, paneEdge: "right", gutterDir: 1, flat: false },
    { name: "gutter|theirs", x: gB.right, body: bodies[2], sample: gB.right + 2, paneEdge: "left", gutterDir: -1, flat: true },
  ];
  for (const s of seams) s.pane = paneAt(s.body, s.sample);
  const vertices = (d) => {
    const nums = d.replace(/[MLQZ]/g, " ").trim().split(/\\s+/).filter(Boolean).map(Number);
    const cmds = d.match(/[MLQZ]/g) || [];
    const pts = [];
    let i = 0;
    for (const c of cmds) {
      if (c === "M" || c === "L") { pts.push([nums[i], nums[i + 1]]); i += 2; }
      else if (c === "Q") { pts.push([nums[i + 2], nums[i + 3]]); i += 4; }
    }
    return pts;
  };
  const originX = snap(sr.left), originY = snap(sr.top);
  // On the grid boxes are painted on: a whole CSS px.
  const onGrid = (v) => Math.abs(v / dpr - Math.round(v / dpr)) < 0.02 / dpr;
  // How far a ribbon end reaches into its pane (ribbons.ts: two device px).
  const OVERLAP = 2; // ribbons.ts reaches two device px into a pane, then on to the next whole one
  const mismatches = [];
  const fills = [];
  const strokes = [];
  const seen = new Set();
  let checked = 0;
  const paths = [...stage.querySelectorAll("path")];
  if (STATE === "resolve") {
    // Everything is settled: nothing across the gutters, nothing in the side panes.
    const drawn = paths.filter((p) => { const cs = getComputedStyle(p); return (cs.fill !== "none" && alpha(cs.fill) > 0) || (cs.stroke !== "none" && alpha(cs.stroke) > 0); });
    if (drawn.length) mismatches.push({ seam: "gutters", tone: "?", kind: "state", problem: "a resolved change still draws across a gutter (" + drawn.length + " paths)", ribbon: [0, 0], pane: [] });
    const side = [bodies[0], bodies[2]].flatMap((b) => [...b.querySelectorAll(".view-overlays div, .margin-view-overlays div")].filter((el) => TONE.test(typeof el.className === "string" ? el.className : "")));
    if (side.length) mismatches.push({ seam: "side panes", tone: "?", kind: "state", problem: "a resolved change still marks a side pane (" + side.length + " overlays)", ribbon: [0, 0], pane: [] });
  }
  const doneBlocks = new Set(paths.filter((p) => p.dataset.state === "done").map((p) => p.dataset.block));
  for (const path of paths) {
    const cs = getComputedStyle(path);
    const cls = path.getAttribute("class") || "";
    if (/jb-ribbon-base|jb-ribbon-line-base/.test(cls)) continue;
    const fill = cs.fill !== "none" && alpha(cs.fill) > 0;
    const stroke = !fill && cs.stroke !== "none" && alpha(cs.stroke) > 0 && parseFloat(cs.strokeWidth) > 0;
    if (!fill && !stroke) continue;
    const m = TONE.exec(cls);
    const tone = m ? m[1] : "?";
    const block = path.dataset.block, side = path.dataset.side;
    const pts = vertices(path.getAttribute("d") || "");
    const dev = pts.map(([x, y]) => [originX + x * dpr, originY + y * dpr]);
    const w = parseFloat(cs.strokeWidth) * dpr;
    for (const s of seams) {
      const sx = snap(s.x);
      const at = dev.filter(([x]) => Math.abs(x - sx) < OVERLAP + 2.01);
      if (!at.length) continue;
      const pane = s.pane;
      const xs = at.map(([x]) => x);
      const report = (problem, rib, panes, kind) => mismatches.push({ seam: s.name, block, side, tone, kind: kind || (fill ? "fill" : "stroke"), problem, ribbon: rib, pane: panes });
      // A vertex exactly on the seam, as the browser paints the gutter's edge.
      if (!xs.some((x) => near(x, sx))) report("off the pixel grid the panes are painted on, horizontally (x " + xs.map((x) => x.toFixed(2)).join("/") + ", seam " + sx + ")", [xs[0], xs[0]], []);
      const ys = at.map(([, y]) => y);
      const intervals = fill ? [[Math.min(...ys), Math.max(...ys)]] : ys.slice(0, 1).map((y) => [y - w / 2, y + w / 2]);
      for (const [t, b] of intervals) {
        // Only an edge on screen in this pane can be compared: a band taller
        // than the view, or cut by its top or bottom, has one edge checked here
        // and the other in another view.
        const inTop = t > pane.top + 1 && t < pane.bottom - 1;
        const inBottom = b > pane.top + 1 && b < pane.bottom - 1;
        if (fill ? !inTop && !inBottom : !(inTop && inBottom)) continue;
        checked++;
        if (block !== undefined && side) seen.add(block + ":" + side);
        // A band starts on a snapped box edge, so its first row is on the
        // grid; a bottom edge line ENDS on the band's snapped bottom.
        const gridEdge = !fill && path.dataset.edge === "bottom" ? b : t;
        if ((fill ? inTop : true) && !onGrid(gridEdge)) { report("off the pixel grid the panes are painted on, vertically", [t, b], []); continue; }
        const sameTone = pane.out.filter((p) => p.tone === tone);
        if (fill) {
          const lo0 = inTop ? t : pane.top, hi0 = inBottom ? b : pane.bottom;
          const over = sameTone.filter((p) => p.bottom > lo0 + 0.02 && p.top < hi0 - 0.02);
          const lo = over.length ? Math.min(...over.map((p) => p.top)) : NaN;
          const hi = over.length ? Math.max(...over.map((p) => p.bottom)) : NaN;
          if ((inTop && !near(lo, t)) || (inBottom && !near(hi, b))) {
            report("the pane paints this band on other rows", [t, b], over.map((p) => [p.top, p.bottom]));
            continue;
          }
          // The band continues into the pane with no column between them:
          // the ribbon reaches over the pane's first device column.
          const reach = s.paneEdge === "right" ? Math.min(...xs) <= pane.right - 1 + 0.02 : Math.max(...xs) >= pane.left + 1 - 0.02;
          if (!reach) report("the ribbon stops short of the pane (pane edge " + (s.paneEdge === "right" ? pane.right : pane.left) + ", ribbon " + xs.map((x) => x.toFixed(2)).join("/") + ")", [t, b], []);
          // Where it meets the RESULT, the result's colour says the state.
          if (s.body === bodies[1]) {
            const fills0 = over.filter((p) => p.kind === "fill");
            const paneColor = fills0.length ? fills0[0].color : "";
            const half = doneBlocks.has(block);
            if (half && paneColor === cs.fill) report("one side of this conflict is in, but the result wears the open conflict's tint (" + paneColor + ")", [t, b], [], "state");
            if (!half && paneColor && paneColor !== cs.fill) report("the band changes colour where it meets the result (" + cs.fill + " → " + paneColor + ")", [t, b], [], "state");
          }
          // For the pixels: the rows where the band is on screen, and where
          // the whole stretch 8 device px into the gutter is inside it (the
          // ribbon may slant there, and a pixel its edge crosses is partly
          // covered) — asked of the path itself, corner by corner.
          const ox = Math.round(sr.left), oy = Math.round(sr.top);
          const inFill = (xd, yd) => path.isPointInFill(new DOMPoint(xd / dpr - ox, yd / dpr - oy));
          // The gutter's columns 5 to 8 px from the seam, where the ribbon's
          // colour is sampled. Its edges run straight from there to the seam,
          // where the band is [t, b): so a row inside the band at both is
          // inside it all the way — in a ribbon that REACHES the seam. One
          // that stops short leaves those seam columns to whatever is under
          // them, which is exactly what the pixels are then asked about.
          const xs8 = [5, 6, 7, 8].map((k) => (s.gutterDir > 0 ? Math.round(sx) + k : Math.round(sx) - 1 - k));
          const top0 = Math.ceil(Math.max(t, pane.top)) + 1, bottom0 = Math.floor(Math.min(b, pane.bottom)) - 1;
          const rowIn = (y) => y >= top0 && y + 1 <= bottom0 && xs8.every((x) => inFill(x - 0.95, y - 1.95) && inFill(x + 1.95, y - 1.95) && inFill(x - 0.95, y + 2.95) && inFill(x + 1.95, y + 2.95));
          let topIn = NaN, bottomIn = NaN;
          const midRow = Math.floor((top0 + bottom0) / 2);
          if (bottom0 - top0 >= 6 && rowIn(midRow)) {
            topIn = midRow;
            while (topIn - 1 >= top0 && rowIn(topIn - 1)) topIn--;
            bottomIn = midRow;
            while (bottomIn + 1 < bottom0 && rowIn(bottomIn + 1)) bottomIn++;
          }
          fills.push({ seam: s.name, block, side, tone, x: Math.round(sx), gutterDir: s.gutterDir, flat: s.flat,
            top: Math.round(Math.max(t, pane.top)), bottom: Math.round(Math.min(b, pane.bottom)), topIn, bottomIn });
        } else {
          // On the pane's own edge rows: the top rows of something the pane
          // paints in this tone (a line, or a band's fill), or its bottom rows.
          // (A point's line carries both of a handled ribbon's edges.)
          const ok = sameTone.some((p) =>
            (near(p.top, t) && b <= p.bottom + 0.02) || (near(p.bottom, b) && t >= p.top - 0.02));
          if (!ok) report("the pane draws no edge of this band on these rows", [t, b], sameTone.map((p) => [+p.top.toFixed(2), +p.bottom.toFixed(2)]));
          if (s.flat) strokes.push({ seam: s.name, block, side, tone, x: Math.round(sx), gutterDir: s.gutterDir, top: Math.floor(t + 0.02), bottom: Math.ceil(b - 0.02) });
        }
      }
    }
  }
  const result = bodies[1];
  const content = result.querySelector(".lines-content");
  const top = content ? 0 - parseFloat(content.style.top || "0") + 0 : 0;
  const pr = result.getBoundingClientRect();
  return { checked, seen: [...seen], mismatches, fills, strokes, paneTop: Math.ceil(snap(pr.top)), paneBottom: Math.floor(snap(pr.bottom)), scrollTop: top };
})()`;

/** Hides everything but the colours for the pixel pass (and shows it again). */
const PIXEL_MODE = (on: boolean) => `(() => {
  let s = document.getElementById("gs-align-pixels");
  if (!s) {
    s = document.createElement("style");
    s.id = "gs-align-pixels";
    s.textContent = ".gs-align-pixels .view-lines, .gs-align-pixels .line-numbers, .gs-align-pixels .jb-button-layer, " +
      ".gs-align-pixels .decorationsOverviewRuler, .gs-align-pixels .scrollbar, .gs-align-pixels .cursors-layer, " +
      ".gs-align-pixels .view-zones, .gs-align-pixels .margin-view-zones { visibility: hidden !important; }";
    document.head.appendChild(s);
  }
  const g = document.querySelector(".jb-merge-grid");
  if (g) g.classList.toggle("gs-align-pixels", ${on});
  return !!g;
})()`;

/**
 * The half-handled state: on screen, take Yours on each conflict (so Theirs
 * stays pending), take every Yours-only and identical change, ignore every
 * Theirs-only one — each through its own gutter control. Only controls on
 * screen exist, so the walk presses a page's worth at a time, every page.
 */
const PRESS_HALF = `(async () => {
  const press = (b) => b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const pick = () =>
    document.querySelector('.jb-gutter-a .jb-change-actions:not([data-category="theirs-only"]) .jb-btn-accept') ||
    document.querySelector('.jb-gutter-b .jb-change-actions[data-category="theirs-only"] .jb-btn-ignore');
  let n = 0;
  for (let b = pick(); b && n < 5000; b = pick()) { press(b); n++; }
  if (n) await new Promise((r) => setTimeout(r, 250));
  return n;
})()`;

/** Everything resolved at once, through the bottom bar's Accept Yours. */
const RESOLVE_ALL = `(async () => {
  const b = document.querySelector(".ms-accept-yours");
  if (!b || b.disabled) return false;
  b.click();
  await new Promise((r) => setTimeout(r, 400));
  return true;
})()`;

// ── The pixels ───────────────────────────────────────────────────────────────

/** Reads the seams' pixels for one viewport's fill and stroke ends; each problem once. */
async function checkPixels(page: Page, r: ViewportReport, state: string): Promise<{ checked: number; problems: Mismatch[] }> {
  const problems: Mismatch[] = [];
  const dpr = await page.eval<number>("window.devicePixelRatio || 1");
  const xs = [...new Set([...r.fills.map((f) => f.x), ...r.strokes.map((s) => s.x)])];
  if (!xs.length) return { checked: 0, problems };
  await page.eval(PIXEL_MODE(true));
  const strips = new Map<number, Image>();
  const y0 = r.paneTop;
  try {
    for (const x of xs) {
      const clip = { x: (x - 12) / dpr, y: y0 / dpr, width: 24 / dpr, height: (r.paneBottom - y0) / dpr };
      strips.set(x, decodePng(await page.screenshot(clip)));
    }
  } finally {
    await page.eval(PIXEL_MODE(false));
  }
  // Strip column c is device column x - 12 + c; strip row j is device row y0 + j.
  const at = (img: Image, x: number, dx: number, y: number) => pixel(img, 12 + dx, y - y0);
  const rows = (img: Image) => img.height;
  // The ribbon's colour, the pane band's, or a mix of the two (the antialiased
  // column where one ends over the other) — never a third colour. Within 6
  // levels a channel: where a ribbon's end is antialiased over the pane's own
  // band (its base, then its tint, each covering part of that one column) the
  // column comes out a few levels darker — measured 4 at most, on the desktop
  // at 1.5x — while the hairline this exists to catch, the gutter's border
  // showing through, is 20 or more levels off in every theme.
  const TOL = 6;
  const between = (c: RGB, a: RGB, b: RGB): boolean => {
    if (same(c, a, TOL) || same(c, b, TOL)) return true;
    const span = [0, 1, 2].map((i) => b[i] - a[i]);
    const len2 = span.reduce((s, v) => s + v * v, 0);
    if (len2 === 0) return false;
    const t = Math.max(0, Math.min(1, [0, 1, 2].reduce((s, i) => s + (c[i] - a[i]) * span[i], 0) / len2));
    return same(c, [0, 1, 2].map((i) => a[i] + t * span[i]) as RGB, TOL);
  };
  // At a fractional scale an edge on half a device pixel is antialiased, and
  // an SVG edge and a box edge cover that half row differently (measured: a
  // half-covered row is 25% in the one and 50% in the other). So there, the
  // first and last FULLY painted rows may differ by that one row; at 1x and 2x
  // they may not differ at all.
  const slack = Number.isInteger(dpr) ? 0 : 1;
  let checked = 0;
  for (const f of r.fills) {
    const img = strips.get(f.x)!;
    const report = (problem: string, ribbon: [number, number]) =>
      problems.push({ seam: f.seam, block: f.block, side: f.side, tone: f.tone, kind: "pixels", problem: `[${state}] ${problem}`, ribbon, pane: [] });
    // Rows well inside the band on both sides of the seam (the ribbon may
    // slant within 8px of it, so both its ends are taken into account).
    const lo = Number.isFinite(f.topIn) ? f.topIn : Infinity;
    const hi = Number.isFinite(f.bottomIn) ? f.bottomIn : -Infinity;
    for (let y = Math.max(lo, y0); y <= hi && y - y0 < rows(img); y++) {
      checked++;
      const cG = at(img, f.x, 8 * f.gutterDir, y);
      const cP = at(img, f.x, -8 * f.gutterDir, y);
      let bad: string | undefined;
      for (let dx = -7; dx <= 7; dx++) {
        const c = at(img, f.x, dx, y);
        if (!between(c, cG, cP)) {
          bad = `column ${f.x + dx} is #${hex(c)}, neither the ribbon's #${hex(cG)} nor the pane's #${hex(cP)}`;
          break;
        }
      }
      if (bad) {
        report(`a column of another colour crosses the band at the seam: ${bad} (row ${y})`, [f.top, f.bottom]);
        break;
      }
    }
    // The flat side: the band's first and last painted rows, gutter vs pane.
    if (f.flat && f.top > y0 + 4 && f.bottom < r.paneBottom - 4 && f.bottom - f.top >= 3) {
      // The band's colour is the one most of its rows wear — not simply its
      // middle row's, which can be where two of the pane's lines meet: on half
      // a device row at 1.5x, each line's overlay covering half of it, a row a
      // level or two off the band's own colour. The middle row's colour wins a
      // tie: a point's thin end, antialiased over three rows at 1.5x, has no
      // two rows alike.
      const mid = Math.floor((f.top + f.bottom) / 2);
      const edges = (dx: number): [number, number] => {
        const tally = new Map<string, { c: RGB; n: number }>();
        for (let y = f.top; y < f.bottom; y++) {
          const c = at(img, f.x, dx, y);
          const k = hex(c);
          const e = tally.get(k);
          if (e) e.n++;
          else tally.set(k, { c, n: 1 });
        }
        const most = [...tally.values()].sort((a, b) => b.n - a.n)[0];
        const middle = at(img, f.x, dx, mid);
        const band = (tally.get(hex(middle))?.n ?? 0) === most.n ? middle : most.c;
        let first = NaN;
        let last = NaN;
        for (let y = f.top - 3; y <= f.bottom + 2; y++) {
          if (same(at(img, f.x, dx, y), band, 3)) {
            if (Number.isNaN(first)) first = y;
            last = y;
          }
        }
        return [first, last + 1];
      };
      const g = edges(8 * f.gutterDir);
      const p = edges(-8 * f.gutterDir);
      checked++;
      if (Math.abs(g[0] - p[0]) > slack || Math.abs(g[1] - p[1]) > slack) {
        // A short band's rows, colour by colour, gutter over pane.
        const dump = (dx: number) => Array.from({ length: f.bottom - f.top + 6 }, (_, i) => hex(at(img, f.x, dx, f.top - 3 + i))).join(" ");
        const colours = f.bottom - f.top <= 12 ? ` (rows ${f.top - 3}–${f.bottom + 2}: gutter ${dump(8 * f.gutterDir)}; pane ${dump(-8 * f.gutterDir)})` : "";
        report(`the band is painted on rows ${g[0]}–${g[1]} in the gutter and ${p[0]}–${p[1]} in the pane${colours}`, [f.top, f.bottom]);
      }
    }
  }
  for (const s of r.strokes) {
    const img = strips.get(s.x)!;
    // The outline's rows at 8px into the gutter and into the pane: every row
    // near it that is not the background, on both sides — the same rows.
    const bg = at(img, s.x, 8 * s.gutterDir, Math.max(y0, s.top - 6));
    const painted = (dx: number) => {
      const out: number[] = [];
      for (let y = s.top - 3; y < s.bottom + 3; y++) if (y >= y0 && y - y0 < rows(img) && !same(at(img, s.x, dx, y), bg, 3)) out.push(y);
      return out;
    };
    checked++;
    const g = painted(8 * s.gutterDir);
    const p = painted(-8 * s.gutterDir);
    // Exact at a whole scale; at a fractional one the antialiased half row
    // may reach one row further in the one than the other (see `slack`).
    const off = !g.length || !p.length
      ? g.length !== p.length
      : Math.abs(g[0] - p[0]) > slack || Math.abs(g[g.length - 1] - p[p.length - 1]) > slack || (slack === 0 && g.join() !== p.join());
    if (off) {
      problems.push({ seam: s.seam, block: s.block, side: s.side, tone: s.tone, kind: "pixels", problem: `[${state}] the outline is painted on rows ${g.join(",") || "none"} in the gutter and ${p.join(",") || "none"} in the pane`, ribbon: [s.top, s.bottom], pane: [] });
    }
  }
  return { checked, problems };
}

// ── Walking a file ───────────────────────────────────────────────────────────

const SCROLL_TOP = `(() => {
  const b = document.querySelectorAll(".jb-merge-grid > .jb-pane-body")[1];
  const c = b && b.querySelector(".lines-content");
  return c ? 0 - parseFloat(c.style.top || "0") + 0 : 0; // never -0: CDP returns it as no value
})()`;

async function settle(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export interface FileAlignment {
  checked: number;
  /** Seam pixels compared. */
  pixels: number;
  seen: Set<string>;
  mismatches: Mismatch[];
  noText: boolean;
  steps: number;
}

export interface WalkOptions {
  /** Read the seams' pixels as well as the model (default true). */
  pixels?: boolean;
}

/** Walks the open file top to bottom in the three states; everything it measured. */
export async function walkFile(page: Page, o: WalkOptions = {}): Promise<FileAlignment> {
  const out: FileAlignment = { checked: 0, pixels: 0, seen: new Set(), mismatches: [], noText: false, steps: 0 };
  const geo = await page.eval<{ x: number; y: number; h: number } | null>(`(() => {
    const b = document.querySelectorAll(".jb-merge-grid > .jb-pane-body")[1];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width * 0.6, y: r.top + 12, h: r.height };
  })()`);
  if (!geo) {
    out.noText = true;
    return out;
  }
  // Into the result the way a user does — a click in its text; the wheel then
  // scrolls it, and sync-scroll moves the side panes with it.
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: geo.x, y: geo.y, button: "left", clickCount: 1 });
  }
  const seenMismatch = new Set<string>();
  const note = (state: string, m: Mismatch) => {
    const key = `${state}|${m.seam}|${m.block}|${m.side}|${m.kind}|${m.problem.replace(/\d+/g, "#")}`;
    if (!seenMismatch.has(key)) {
      seenMismatch.add(key);
      out.mismatches.push(m.problem.startsWith("[") ? m : { ...m, problem: `[${state}] ${m.problem}` });
    }
  };
  // Down as it opens, up while taking every change, down again once resolved:
  // each pass starts where the last one stopped. Views step by the mouse
  // wheel, a pane's height less a 160px overlap, so no block — and no band
  // edge — ever falls between two of them. (The page keys did not: a page key
  // moves the CARET a page and reveals it, 1933px in an 1837px pane, and every
  // 25th block of the load file sat in the 96px nobody saw.)
  const notch = await wheelStep(page, geo);
  if (process.env.GS_ALIGN_DEBUG) process.stderr.write(`  one wheel notch scrolls ${notch}px; a view is ${geo.h}px\n`);
  const passes = [
    ["open", 1],
    ["half", -1],
    ["resolve", 1],
  ] as const;
  for (const [state, dir] of passes) {
    if (state === "resolve") await page.eval(RESOLVE_ALL);
    for (let step = 0; step < 20000; step++) {
      if (state === "half") await page.eval<number>(PRESS_HALF);
      await settle(90);
      const r = await page.eval<ViewportReport>(PROBE(state));
      if (process.env.GS_ALIGN_DEBUG) process.stderr.write(`  ${state} step ${step}: top ${r.scrollTop}, ${r.checked} edges, ${r.fills.length} fills\n`);
      out.steps++;
      out.checked += r.checked;
      for (const k of r.seen) out.seen.add(k);
      for (const m of r.mismatches) note(state, m);
      if (o.pixels !== false && (r.fills.length || r.strokes.length)) {
        const px = await checkPixels(page, r, state);
        out.pixels += px.checked;
        for (const m of px.problems) note(state, m);
      }
      // The end of the document: the wheel moved nothing.
      if (!(await scrollBy(page, geo, dir * (geo.h - 160), notch))) break;
    }
  }
  return out;
}

interface Geo {
  x: number;
  y: number;
  h: number;
}

/**
 * One real wheel event over the result's text, with Alt held: the editor's
 * fast scroll (five lines' worth a notch), so a view is a dozen notches, not
 * sixty.
 */
async function wheel(page: Page, geo: Geo, deltaY: number): Promise<void> {
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: geo.x, y: geo.y + 40, deltaX: 0, deltaY, modifiers: 1 });
}

/**
 * How far one wheel notch scrolls the result, in px, measured from where it
 * is and put back. The editor moves a fixed step per event (measured: the
 * same for a delta of 60 or of 5000), so a view is stepped notch by notch.
 * 0 when the document does not scroll.
 */
async function wheelStep(page: Page, geo: Geo): Promise<number> {
  const from = await page.eval<number>(SCROLL_TOP);
  await wheel(page, geo, 100);
  let moved = 0;
  for (let t = 0; t < 20 && moved === 0; t++) {
    await settle(50);
    moved = (await page.eval<number>(SCROLL_TOP)) - from;
  }
  if (moved > 0) {
    await wheel(page, geo, -100);
    for (let t = 0; t < 20 && (await page.eval<number>(SCROLL_TOP)) !== from; t++) await settle(50);
  }
  return Math.max(0, moved);
}

/** Scrolls the result by about `px`, notch by notch; false when it could not move at all (an end). */
async function scrollBy(page: Page, geo: Geo, px: number, step: number): Promise<boolean> {
  if (step <= 0) return false;
  const from = await page.eval<number>(SCROLL_TOP);
  const target = from + px;
  let cur = from;
  for (let round = 0; round < 4; round++) {
    const notches = Math.round((target - cur) / step);
    if (notches === 0) break;
    for (let n = 0; n < Math.abs(notches); n++) {
      await wheel(page, geo, notches > 0 ? 100 : -100);
      await settle(6);
    }
    await settle(60);
    const next = await page.eval<number>(SCROLL_TOP);
    if (process.env.GS_ALIGN_DEBUG) process.stderr.write(`    ${notches} notches: ${cur} → ${next}\n`);
    if (next === cur) break;
    cur = next;
  }
  return cur !== from;
}

// ── The matrix ───────────────────────────────────────────────────────────────

/** The scales every run measures by default: whole, fractional, and retina. */
export const DEFAULT_DPRS = [1, 1.5, 2];

export interface AlignmentOptions {
  target?: string;
  scenarios?: string[];
  files?: string[];
  hosts?: Host[];
  dprs?: number[];
  noBuild?: boolean;
  width?: number;
  height?: number;
  pixels?: boolean;
  log?: (line: string) => void;
}

export interface FileResult {
  host: Host;
  dpr: number;
  scenario: string;
  file: string;
  /** The measurement this file shares with every scenario whose three texts are identical. */
  key: string;
  expected: string[];
  seen: string[];
  missing: string[];
  checked: number;
  pixels: number;
  mismatches: Mismatch[];
  noText: boolean;
  errors: string[];
}

/** The (block, side) pairs a file's merge must draw a ribbon for, from oracle.json's engine letters. */
export function expectedSides(letters: string): string[] {
  const out: string[] = [];
  [...letters].forEach((c, i) => {
    if (c !== "t") out.push(`${i}:left`);
    if (c !== "y") out.push(`${i}:right`);
  });
  return out;
}

export async function measureAlignment(o: AlignmentOptions = {}): Promise<FileResult[]> {
  const oracle = JSON.parse(readFileSync(ORACLE_PATH, "utf8")) as Oracle;
  const log = o.log ?? (() => {});
  let target = o.target;
  let temp: string | undefined;
  if (!target) {
    temp = mkdtempSync(join(tmpdir(), "gs-merge-align-"));
    const ops = [...new Set((o.scenarios ?? Object.keys(oracle.scenarios)).map((s) => s.split(".")[0]))];
    const styles = [...new Set((o.scenarios ?? Object.keys(oracle.scenarios)).map((s) => s.split(".")[1]))];
    buildMatrix(temp, o.scenarios ? { ops, styles } : undefined);
    target = temp;
  }
  const scenarios = o.scenarios ?? Object.keys(oracle.scenarios);
  const results: FileResult[] = [];
  // Tall: fewer pages to walk; the geometry is the same at any height.
  const width = o.width ?? 1600;
  const height = o.height ?? 4000;
  const browser = await Browser.launch({ width, height });
  // Identical texts render identically: measure each once per host and DPR,
  // and credit it to every scenario and file that has those texts.
  const measured = new Map<string, FileAlignment & { errors: string[] }>();
  try {
    for (const host of o.hosts ?? (["ext", "desktop"] as Host[])) {
      for (const dpr of o.dprs ?? DEFAULT_DPRS) {
        for (const scenario of scenarios) {
          const s = oracle.scenarios[scenario];
          if (!s) throw new Error(`no scenario ${scenario} in oracle.json`);
          const root = join(target, s.dir);
          const ctx = new GitContext({ root });
          try {
            const op = await ctx.operation.view();
            for (const [file, f] of Object.entries(s.files)) {
              if (o.files && !o.files.includes(file)) continue;
              const letters = f.engine?.blocks ?? "";
              const expected = f.engine ? expectedSides(letters) : [];
              const payload = await extensionPayload(ctx, root, file, op);
              const key = createHash("sha1")
                .update(JSON.stringify([host, dpr, payload.base, payload.ours, payload.theirs, payload.shape ?? "", file.split(".").pop()]))
                .digest("hex")
                .slice(0, 12);
              let m = measured.get(key);
              if (!m) {
                const t0 = Date.now();
                const { page, failure } = await openMerge(browser, {
                  host,
                  root,
                  file,
                  theme: "dark",
                  width,
                  height,
                  scale: dpr,
                  noBuild: o.noBuild,
                });
                try {
                  const walked = await walkFile(page, { pixels: o.pixels });
                  m = { ...walked, errors: [...(failure ? [failure] : []), ...page.errors] };
                } finally {
                  await browser.closePage(page);
                }
                measured.set(key, m);
                log(`${host} @${dpr}x ${scenario} ${file}: ${m.checked} edges and ${m.pixels} seam rows in ${m.steps} views, ${m.mismatches.length} off, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
              }
              const seen = [...m.seen].sort();
              results.push({
                host,
                dpr,
                scenario,
                file,
                key,
                expected,
                seen,
                missing: expected.filter((k) => !m!.seen.has(k)),
                checked: m.checked,
                pixels: m.pixels,
                mismatches: m.mismatches,
                noText: m.noText,
                errors: m.errors,
              });
            }
          } finally {
            ctx.dispose();
          }
        }
      }
    }
  } finally {
    await browser.close();
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
  return results;
}

/** Every problem in a result set, one line each (empty: aligned everywhere, every block seen). */
export function alignmentProblems(results: FileResult[]): string[] {
  const out: string[] = [];
  for (const r of results) {
    const where = `${r.host} @${r.dpr}x ${r.scenario} ${r.file}`;
    for (const e of r.errors) out.push(`${where}: page error ${e}`);
    if (r.noText !== (r.expected.length === 0)) {
      out.push(`${where}: ${r.noText ? "no merge view" : "a merge view"} but oracle.json expects ${r.expected.length} ribbon ends`);
    }
    if (r.missing.length) out.push(`${where}: never measured ${r.missing.length} of ${r.expected.length} block sides (${r.missing.slice(0, 6).join(", ")}${r.missing.length > 6 ? ", …" : ""})`);
    for (const m of r.mismatches) {
      out.push(
        `${where}: block ${m.block ?? "?"} ${m.side ?? ""} ${m.tone} ${m.kind} at ${m.seam}: ${m.problem} — ribbon rows ${m.ribbon.map((v) => +v.toFixed(2)).join("–")}, pane ${m.pane.map((p) => p.join("–")).join(" ") || "none"}`,
      );
    }
  }
  return out;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const flag = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const list = (v?: string) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);
  const results = await measureAlignment({
    target: flag("target") ? resolve(flag("target")!) : undefined,
    scenarios: list(flag("scenarios")),
    files: list(flag("files")),
    hosts: list(flag("hosts")) as Host[] | undefined,
    dprs: list(flag("dpr"))?.map(Number),
    noBuild: argv.includes("--no-build"),
    pixels: !argv.includes("--no-pixels"),
    log: (l) => process.stderr.write(l + "\n"),
  });
  const problems = alignmentProblems(results);
  if (flag("json")) writeFileSync(flag("json")!, JSON.stringify(results, null, 1));
  const sides = results.reduce((n, r) => n + r.expected.length, 0);
  const pixels = results.reduce((n, r) => n + r.pixels, 0);
  process.stdout.write(
    `${results.length} file renders, ${new Set(results.map((r) => r.key)).size} distinct; ${sides} block sides expected; ${pixels} seam rows read; ${problems.length} problems\n`,
  );
  for (const p of problems.slice(0, 200)) process.stdout.write(p + "\n");
  if (problems.length > 200) process.stdout.write(`… and ${problems.length - 200} more\n`);
  process.exit(problems.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    process.stderr.write(`${err instanceof Error ? err.stack : String(err)}\n`);
    process.exit(1);
  });
}
