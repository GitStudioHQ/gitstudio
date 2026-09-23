// Every band edge in the merge view sits on the same device pixel in the side
// pane, in its ribbon across the gutter, and in the result — measured on the
// RENDERED page, for every block of every file of every matrix scenario.
//
//   npx tsx scripts/merge-e2e/alignment.ts [--scenarios a,b] [--files a,b] [--hosts ext,desktop]
//       [--dpr 1,2] [--target <built matrix>] [--no-build] [--json out.json]
//
// Why rendered, and why device pixels: the owner saw the applied-state dashed
// lines in a side pane and in the gutter beside it sit a few pixels apart.
// Nothing in the source said so — the pane drew a CSS border INSIDE the last
// line, the gutter an SVG stroke centred half a pixel BELOW it. A box edge is
// painted snapped to whole device pixels; an SVG edge is antialiased where it
// falls. So this reads what the browser paints:
//
// - pane:   every Monaco overlay element (content and line-number margin) that
//           names a tone, just inside the pane edge the gutter touches; its
//           background rows and its border rows, snapped as the browser snaps
//           a box (round(y × dpr));
// - ribbon: every path on the ribbon stage; its vertices on that seam, in
//           device pixels (NOT snapped — an off-grid SVG edge is a defect in
//           itself); a fill's extent, a stroke's painted rows (y ± width/2).
//
// Then, at every seam (both edges of both gutters), for every ribbon end:
// - it must be on the device-pixel grid, horizontally and vertically;
// - a filled end must cover EXACTLY the rows the pane paints in that tone
//   there (±0 device px), and start exactly where the pane's band stops;
// - a stroke must lie exactly on the first or last row of something the pane
//   paints in that tone there — an edge line, a point line, or a band's fill.
//
// Each file is walked through, page by page, in three states: as it opens;
// half handled — Yours taken on conflicts (Theirs left pending), one-sided
// and identical changes taken or ignored, each through its gutter control
// (handled sides, pending halves and resolved blocks side by side); and
// everything resolved (the bottom bar's Accept Yours). Coverage is checked
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

/** One ribbon end that does not meet its pane. */
export interface Mismatch {
  seam: string;
  block?: string;
  side?: string;
  tone: string;
  kind: "fill" | "stroke";
  problem: string;
  /** Device pixels. */
  ribbon: [number, number];
  pane: Array<[number, number]>;
}

/** What one viewport measured. */
interface ViewportReport {
  none?: boolean;
  checked: number;
  seen: string[];
  mismatches: Mismatch[];
  scrollTop: number;
  scrollMax: number;
}

// ── In the page ──────────────────────────────────────────────────────────────

const PROBE = `(() => {
  const dpr = window.devicePixelRatio || 1;
  const snap = (v) => Math.round(v * dpr);
  const grid = document.querySelector(".jb-merge-grid");
  if (!grid) return { none: true, checked: 0, seen: [], mismatches: [], scrollTop: 0, scrollMax: 0 };
  const bodies = [...grid.children].filter((e) => e.classList.contains("jb-pane-body"));
  const gA = grid.querySelector(".jb-gutter-a").getBoundingClientRect();
  const gB = grid.querySelector(".jb-gutter-b").getBoundingClientRect();
  const stage = grid.querySelector(".jb-ribbon-stage");
  const sr = stage.getBoundingClientRect();
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
      if (alpha(cs.backgroundColor) > 0) out.push({ tone: m[1], kind: "fill", top, bottom });
      const bt = parseFloat(cs.borderTopWidth), bb = parseFloat(cs.borderBottomWidth);
      if (cs.borderTopStyle !== "none" && bt > 0 && alpha(cs.borderTopColor) > 0)
        out.push({ tone: m[1], kind: "stroke", top, bottom: top + Math.round(bt * dpr) });
      if (cs.borderBottomStyle !== "none" && bb > 0 && alpha(cs.borderBottomColor) > 0)
        out.push({ tone: m[1], kind: "stroke", top: bottom - Math.round(bb * dpr), bottom });
    }
    return { out, top: snap(clip.top), bottom: snap(clip.bottom), left: snap(clip.left), right: snap(clip.right) };
  };
  const seams = [
    { name: "yours|gutter", x: gA.left, body: bodies[0], sample: gA.left - 2, paneEdge: "right" },
    { name: "gutter|result", x: gA.right, body: bodies[1], sample: gA.right + 2, paneEdge: "left" },
    { name: "result|gutter", x: gB.left, body: bodies[1], sample: gB.left - 2, paneEdge: "right" },
    { name: "gutter|theirs", x: gB.right, body: bodies[2], sample: gB.right + 2, paneEdge: "left" },
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
  const onGrid = (v) => Math.abs(v - Math.round(v)) < 0.02;
  const mismatches = [];
  const seen = new Set();
  let checked = 0;
  for (const path of stage.querySelectorAll("path")) {
    const cs = getComputedStyle(path);
    const cls = path.getAttribute("class") || "";
    const fill = cs.fill !== "none" && alpha(cs.fill) > 0 && !/jb-ribbon-base/.test(cls);
    const stroke = !fill && cs.stroke !== "none" && alpha(cs.stroke) > 0 && parseFloat(cs.strokeWidth) > 0;
    if (!fill && !stroke) continue;
    const m = TONE.exec(cls);
    const tone = m ? m[1] : /jb-ribbon-edge/.test(cls) ? "conflict" : "?";
    const block = path.dataset.block, side = path.dataset.side;
    const pts = vertices(path.getAttribute("d") || "");
    const w = parseFloat(cs.strokeWidth) * dpr;
    for (const s of seams) {
      const at = pts.filter(([x]) => Math.abs(originX + x * dpr - snap(s.x)) < 1.01);
      if (!at.length) continue;
      const pane = s.pane;
      const devX = originX + at[0][0] * dpr;
      const report = (problem, rib, panes) => mismatches.push({ seam: s.name, block, side, tone, kind: fill ? "fill" : "stroke", problem, ribbon: rib, pane: panes });
      if (!onGrid(devX)) report("off the device-pixel grid horizontally (x " + devX.toFixed(2) + ")", [devX, devX], []);
      const ys = at.map(([, y]) => originY + y * dpr);
      const intervals = fill
        ? [[Math.min(...ys), Math.max(...ys)]]
        : ys.map((y) => [y - w / 2, y + w / 2]);
      for (const [t, b] of intervals) {
        // Only an edge on screen in this pane can be compared: a band taller
        // than the view, or cut by its top or bottom, has one edge checked here
        // and the other in another view.
        const inTop = t > pane.top + 1 && t < pane.bottom - 1;
        const inBottom = b > pane.top + 1 && b < pane.bottom - 1;
        if (fill ? !inTop && !inBottom : !(inTop && inBottom)) continue;
        checked++;
        if (block !== undefined && side) seen.add(block + ":" + side);
        if ((inTop && !onGrid(t)) || (inBottom && !onGrid(b))) { report("off the device-pixel grid vertically", [t, b], []); continue; }
        const same = pane.out.filter((p) => p.tone === tone);
        if (fill) {
          const lo0 = inTop ? t : pane.top, hi0 = inBottom ? b : pane.bottom;
          const over = same.filter((p) => p.bottom > lo0 && p.top < hi0);
          const lo = over.length ? Math.min(...over.map((p) => p.top)) : NaN;
          const hi = over.length ? Math.max(...over.map((p) => p.bottom)) : NaN;
          if ((inTop && lo !== Math.round(t)) || (inBottom && hi !== Math.round(b))) {
            report("the pane paints this band on other rows", [t, b], over.map((p) => [p.top, p.bottom]));
            continue;
          }
          // The band continues into the gutter with no gap and no overlap.
          const edge = s.paneEdge === "right" ? pane.right : pane.left;
          if (Math.round(devX) !== edge) report("a gap between the pane's band and the ribbon (pane edge " + edge + ", ribbon " + devX.toFixed(2) + ")", [t, b], []);
        } else {
          const T = Math.round(t), B = Math.round(b);
          // On the pane's own edge row: the top row of something the pane
          // paints in this tone (a line, or a band's fill), or its bottom row.
          // (A point's 2px line carries both of a handled ribbon's 1px edges.)
          const ok = same.some((p) =>
            (p.top === T && B <= p.bottom) || (p.bottom === B && T >= p.top));
          if (!ok) report("the pane draws no edge of this band on these rows", [t, b], same.map((p) => [p.top, p.bottom]));
        }
      }
    }
  }
  // Scroll position of the result, from Monaco's own scrollbar.
  const result = bodies[1];
  const slider = result.querySelector(".scrollbar.vertical .slider");
  const content = result.querySelector(".lines-content");
  const top = content ? 0 - parseFloat(content.style.top || "0") + 0 : 0;
  return { checked, seen: [...seen], mismatches, scrollTop: top, scrollMax: -1, slider: slider ? slider.style.top : null };
})()`;

/**
 * The half-handled state: on screen, take Yours on each conflict (so Theirs
 * stays pending), take every Yours-only and identical change, ignore every
 * Theirs-only one — each through its own gutter control, up to `budget`
 * presses. Returns how many it pressed.
 */
const PRESS_HALF = (budget: number) => `(async () => {
  const press = (b) => b.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
  const pick = () =>
    document.querySelector('.jb-gutter-a .jb-change-actions:not([data-category="theirs-only"]) .jb-btn-accept') ||
    document.querySelector('.jb-gutter-b .jb-change-actions[data-category="theirs-only"] .jb-btn-ignore');
  let n = 0;
  for (let b = pick(); b && n < ${budget}; b = pick()) { press(b); n++; }
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

/**
 * How many changes the half pass takes by hand per file. Every block of every
 * file is measured as it opens and once resolved; this pass puts handled
 * sides next to pending halves — every file with fewer changes gets all of
 * them, the 1201-change load file its first 80 (a press re-lays the whole
 * file out, so all of them would take minutes and show nothing new).
 */
const HALF_PRESS_BUDGET = 80;

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
  seen: Set<string>;
  mismatches: Mismatch[];
  noText: boolean;
  steps: number;
}

/** Walks the open file top to bottom in the three states; everything it measured. */
export async function walkFile(page: Page): Promise<FileAlignment> {
  const out: FileAlignment = { checked: 0, seen: new Set(), mismatches: [], noText: false, steps: 0 };
  const geo = await page.eval<{ x: number; y: number } | null>(`(() => {
    const b = document.querySelectorAll(".jb-merge-grid > .jb-pane-body")[1];
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.left + r.width * 0.6, y: r.top + 12 };
  })()`);
  if (!geo) {
    out.noText = true;
    return out;
  }
  // Focus the result the way a user does — a click in its text — so the page
  // keys page it (and sync-scroll moves the side panes with it).
  for (const type of ["mousePressed", "mouseReleased"]) {
    await page.send("Input.dispatchMouseEvent", { type, x: geo.x, y: geo.y, button: "left", clickCount: 1 });
  }
  const seenMismatch = new Set<string>();
  // Down as it opens, up while taking every change, down again once resolved:
  // each pass starts where the last one stopped.
  const passes = [
    ["open", "PageDown"],
    ["half", "PageUp"],
    ["resolve", "PageDown"],
  ] as const;
  let budget = HALF_PRESS_BUDGET;
  for (const [state, pageKey] of passes) {
    if (state === "resolve") await page.eval(RESOLVE_ALL);
    let last = Number.NaN;
    for (let step = 0; step < 20000; step++) {
      if (state === "half" && budget > 0) budget -= await page.eval<number>(PRESS_HALF(budget));
      await settle(90);
      const r = await page.eval<ViewportReport>(PROBE);
      if (process.env.GS_ALIGN_DEBUG) process.stderr.write(`  ${state} step ${step}: top ${r.scrollTop}, ${r.checked} edges\n`);
      out.steps++;
      out.checked += r.checked;
      for (const k of r.seen) out.seen.add(k);
      for (const m of r.mismatches) {
        const key = `${state}|${m.seam}|${m.block}|${m.side}|${m.kind}|${m.problem}`;
        if (!seenMismatch.has(key)) {
          seenMismatch.add(key);
          out.mismatches.push({ ...m, problem: `[${state}] ${m.problem}` });
        }
      }
      await press(page, pageKey);
      await settle(30);
      const moved = await page.eval<number>(SCROLL_TOP);
      // The end of the document: the page key moved nothing, or landed where
      // it did last time (the notch below had only stepped back from there).
      if (moved === r.scrollTop || moved === last) break;
      last = moved;
      // …and one wheel notch back, so consecutive pages overlap and no band
      // edge ever sits on the seam between two of them.
      await page.send("Input.dispatchMouseEvent", {
        type: "mouseWheel", x: geo.x, y: geo.y + 40, deltaX: 0, deltaY: pageKey === "PageDown" ? -100 : 100,
      });
    }
  }
  return out;
}

const KEYS: Record<string, number> = { PageDown: 34, PageUp: 33 };

/** One real key press on the focused element. */
async function press(page: Page, key: string): Promise<void> {
  const code = KEYS[key];
  const base = { key, code: key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
}

// ── The matrix ───────────────────────────────────────────────────────────────

export interface AlignmentOptions {
  target?: string;
  scenarios?: string[];
  files?: string[];
  hosts?: Host[];
  dprs?: number[];
  noBuild?: boolean;
  width?: number;
  height?: number;
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
    buildMatrix(temp);
    target = temp;
  }
  const scenarios = o.scenarios ?? Object.keys(oracle.scenarios);
  const results: FileResult[] = [];
  // Tall: fewer pages to walk; the geometry is the same at any height.
  const width = o.width ?? 1600;
  const height = o.height ?? 2000;
  const browser = await Browser.launch({ width, height });
  // Identical texts render identically: measure each once per host and DPR,
  // and credit it to every scenario and file that has those texts.
  const measured = new Map<string, FileAlignment & { errors: string[] }>();
  try {
    for (const host of o.hosts ?? (["ext", "desktop"] as Host[])) {
      for (const dpr of o.dprs ?? [1, 2]) {
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
                  const walked = await walkFile(page);
                  m = { ...walked, errors: [...(failure ? [failure] : []), ...page.errors] };
                } finally {
                  await browser.closePage(page);
                }
                measured.set(key, m);
                log(`${host} @${dpr}x ${scenario} ${file}: ${m.checked} edges in ${m.steps} views, ${m.mismatches.length} off, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
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
    log: (l) => process.stderr.write(l + "\n"),
  });
  const problems = alignmentProblems(results);
  if (flag("json")) writeFileSync(flag("json")!, JSON.stringify(results, null, 1));
  const edges = results.reduce((n, r) => n + r.checked, 0);
  const sides = results.reduce((n, r) => n + r.expected.length, 0);
  process.stdout.write(
    `${results.length} file renders, ${new Set(results.map((r) => r.key)).size} distinct; ${sides} block sides expected; ${problems.length} problems\n`,
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

