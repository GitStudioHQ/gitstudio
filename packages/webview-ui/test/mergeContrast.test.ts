import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * The merge colours are readable and tell apart — measured on the COMPUTED
 * colours Chrome resolves from diff.css under each theme's body class, then
 * composited over each editor background (a tint is translucent: what the eye
 * gets is tint-over-background, not the token).
 *
 * Thresholds (PLAN §4 P1 (e)):
 * - the editor's text on every line tint, and on every word tint over it, >= 4.5:1
 *   (WCAG 1.4.3); the word tint a visible step (ΔE >= 5) over its line;
 * - every edge colour (point lines, high-contrast frames, swatch borders)
 *   >= 3:1 against the editor background (WCAG 1.4.11, non-text); a handled
 *   change's outline and a ruler mark visible but quieter than an edge;
 * - every pair of line tints >= 10 apart (CIEDE2000) with normal vision;
 * - every CATEGORY pair >= 4 apart under simulated deuteranopia and
 *   protanopia (Machado et al. 2009, severity 1), and identical (violet) vs
 *   conflict (red) >= 15 — the pair whose confusion would mislead: "safe to
 *   take" read as "needs you".
 *
 * Themes: VS Code Dark+, Dark Modern, Light+, Light Modern, High Contrast
 * dark and light, and the desktop app's own dark and light editor colours,
 * read from its app.css so they cannot drift from what ships.
 */

const CHROME = findChrome();
const DIFF_CSS = fileURLToPath(new URL("../src/styles/diff.css", import.meta.url));
const APP_CSS = fileURLToPath(
  new URL("../../../apps/desktop/src/renderer/styles/app.css", import.meta.url),
);

const TONES = ["inserted", "deleted", "modified", "same", "conflict"] as const;
type Tone = (typeof TONES)[number];

// ── The token block and the classes the views emit ────────────────────────────

test("diff.css declares every tone's tokens in both palettes; every class the views emit has a rule, and the retired marks have none", () => {
  const css = readFileSync(DIFF_CSS, "utf8");
  const block = (head: string) => {
    const start = css.indexOf(head);
    assert.ok(start >= 0, `diff.css has a "${head}" palette block`);
    return css.slice(start, css.indexOf("}", start));
  };
  for (const head of [":root {", "body.vscode-light, body.vscode-high-contrast-light {"]) {
    const b = block(head);
    for (const tone of TONES) {
      for (const kind of ["line", "inner", "edge", "done", "ruler", "half"]) {
        assert.ok(b.includes(`--jb-${kind}-${tone}:`), `${head} declares --jb-${kind}-${tone}`);
      }
    }
    assert.ok(b.includes("--jb-settled:"), `${head} declares --jb-settled`);
  }
  assert.ok(!/--jb-(line|edge)-resolved/.test(css), "no grey 'resolved' wash");
  // Every class the merge and diff views put on the page has a rule — a class
  // with no rule fails silently (memory: dead CSS class names).
  const selectors: string[] = [];
  for (const tone of TONES) {
    selectors.push(
      `.jb-line-${tone}`, `.jb-inner-${tone}`, `.jb-ribbon-${tone}`, `.jb-point-${tone}`,
      `.jb-done-${tone}`, `.jb-frame-${tone}`, `.jb-ribbon-done-${tone}`, `.jb-ribbon-frame-${tone}`,
      `.jb-btn-accept.jb-tone-${tone}:hover`, `.jb-dot-${tone}`,
    );
  }
  // The 2-way diff names its ROLE (diffView.ts): transfer arrow and point markers.
  for (const role of ["inserted", "deleted", "modified"]) {
    selectors.push(`.jb-btn-accept.jb-role-${role}:hover`, `.jb-marker-${role}`);
  }
  selectors.push(
    ".jb-ws", ".jb-done", ".jb-frame", ".jb-point", ".jb-point-after", ".jb-edge-top", ".jb-edge-bottom",
    ".jb-half", ".jb-settled",
    ".jb-ribbon-base", ".jb-ribbon-line-base", ".jb-ribbon-done", ".jb-ribbon-frame", ".jb-legend", ".jb-legend-chip",
    ".jb-legend-help", ".jb-legend-pop", ".jb-legend-row", ".jb-legend-count", ".jb-legend-sep",
    ".jb-legend-dot", ".jb-legend-note", ".jb-legend-kind", ".jb-legend-sample",
    ".jb-sample-half", ".jb-sample-done", ".jb-sample-settled", ".jb-sample-point", ".jb-sample-ws",
    ".codicon-arrow-right", ".codicon-arrow-left", ".codicon-close", ".codicon-wand", ".codicon-question",
  );
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const sel of selectors) {
    // The selector itself, not a longer class that starts with it
    // (".jb-point" must not be satisfied by ".jb-point-inserted").
    assert.ok(new RegExp(`${escape(sel)}(?![\\w-])`).test(css), `a rule names ${sel}`);
  }
  // What the owner rejected is gone for good: the invented marks, the per-change
  // wand and append icon, the dashed "applied" style.
  // And the legend's square swatches, which read as unticked checkboxes.
  for (const gone of [".jb-mark", ".jb-result-actions", ".jb-btn-append", ".jb-btn-keep-base", ".jb-btn-wand", ".jb-legend-glyph", ".jb-legend-extra", ".codicon-insert", ".codicon-sparkle", ".jb-legend-swatch", ".jb-swatch-conflict", ".jb-swatch-one-sided"]) {
    assert.ok(!new RegExp(`${escape(gone)}(?![\\w-])`).test(css), `no rule for the retired ${gone}`);
  }
  assert.ok(!/jb-applied|dasharray|\bdashed\b/.test(css), "no dashed 'applied' style anywhere");
});

// ── colour maths (contrast: WCAG 2; distance: CIEDE2000; CVD: Machado 2009) ───

type RGB = [number, number, number];
type RGBA = [number, number, number, number];

function parseColor(value: string): RGBA {
  const s = value.trim();
  let m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
  m = /^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/.exec(s);
  if (m) return [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255, m[4] === undefined ? 1 : Number(m[4])];
  m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return [0, 2, 4].map((i) => parseInt(m![1].slice(i, i + 2), 16)).concat(1) as RGBA;
  throw new Error(`unparseable colour ${JSON.stringify(value)}`);
}

const over = (c: RGBA, bg: RGB): RGB => [0, 1, 2].map((i) => c[i] * c[3] + bg[i] * (1 - c[3])) as RGB;
const lin = (v: number): number => {
  v /= 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const unlin = (v: number): number => 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const lum = (c: RGB): number => {
  const [r, g, b] = c.map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: RGB, b: RGB): number => {
  const la = lum(a);
  const lb = lum(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
};
const CVD = {
  protan: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  deutan: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
};
const simulate = (c: RGB, m: number[][]): RGB => {
  const l = c.map(lin);
  return m.map((row) => unlin(Math.max(0, Math.min(1, row[0] * l[0] + row[1] * l[1] + row[2] * l[2])))) as RGB;
};
const lab = (c: RGB): [number, number, number] => {
  const [r, g, b] = c.map(lin);
  let x = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
  let y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
  const f = (t: number) => (t > 216 / 24389 ? Math.cbrt(t) : ((24389 / 27) * t + 16) / 116);
  [x, y, z] = [f(x), f(y), f(z)];
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
};
function deltaE2000(c1: RGB, c2: RGB): number {
  const [L1, a1, b1] = lab(c1);
  const [L2, a2, b2] = lab(c2);
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Cb ** 7 / (Cb ** 7 + 25 ** 7)));
  const a1p = a1 * (1 + G);
  const a2p = a2 * (1 + G);
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const hue = (a: number, b: number) => {
    if (a === 0 && b === 0) return 0;
    const v = Math.atan2(b, a) * deg;
    return v < 0 ? v + 360 : v;
  };
  const h1p = hue(a1p, b1);
  const h2p = hue(a2p, b2);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp / 2) * rad);
  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp = h1p + h2p;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1p - h2p) > 180) hbp += h1p + h2p < 360 ? 360 : -360;
    hbp /= 2;
  }
  const T = 1 - 0.17 * Math.cos((hbp - 30) * rad) + 0.24 * Math.cos(2 * hbp * rad) + 0.32 * Math.cos((3 * hbp + 6) * rad) - 0.2 * Math.cos((4 * hbp - 63) * rad);
  const dTh = 30 * Math.exp(-(((hbp - 275) / 25) ** 2));
  const RC = 2 * Math.sqrt(Cbp ** 7 / (Cbp ** 7 + 25 ** 7));
  const SL = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const SC = 1 + 0.045 * Cbp;
  const SH = 1 + 0.015 * Cbp * T;
  const RT = -Math.sin(2 * dTh * rad) * RC;
  return Math.sqrt((dLp / SL) ** 2 + (dCp / SC) ** 2 + (dHp / SH) ** 2 + RT * (dCp / SC) * (dHp / SH));
}

test("the colour maths is the standard one", () => {
  // Reference points: WCAG's black on white, and a CIEDE2000 pair from
  // Sharma, Wu & Dalal's test data expressed in sRGB (≈ identity check).
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(2), "21.00");
  assert.equal(deltaE2000([128, 128, 128], [128, 128, 128]), 0);
  assert.ok(deltaE2000([255, 0, 0], [0, 0, 255]) > 50);
  assert.deepEqual(parseColor("rgba(63, 185, 80, 0.14)"), [63, 185, 80, 0.14]);
  assert.deepEqual(parseColor("rgb(26, 127, 55)"), [26, 127, 55, 1]);
});

// ── the themes ────────────────────────────────────────────────────────────────

/** An editor background + foreground, as the desktop's app.css declares them. */
function desktopEditor(theme: "dark" | "light"): { bg: string; fg: string } {
  const css = readFileSync(APP_CSS, "utf8");
  const start = css.indexOf(`body.vscode-${theme} {`);
  assert.ok(start >= 0, `app.css has a body.vscode-${theme} block`);
  const block = css.slice(start, css.indexOf("\n}", start));
  const read = (name: string) => {
    const m = new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`).exec(block);
    assert.ok(m, `app.css body.vscode-${theme} declares ${name}`);
    return m![1];
  };
  return { bg: read("--vscode-editor-background"), fg: read("--vscode-editor-foreground") };
}

type BodyClass = "dark" | "light" | "hcDark" | "hcLight";
interface Theme {
  name: string;
  body: BodyClass;
  bg: string;
  fg: string;
}

const THEMES: Theme[] = [
  { name: "VS Code Dark+", body: "dark", bg: "#1e1e1e", fg: "#d4d4d4" },
  { name: "VS Code Dark Modern", body: "dark", bg: "#1f1f1f", fg: "#cccccc" },
  { name: "GitStudio desktop dark", body: "dark", ...desktopEditor("dark") },
  { name: "VS Code Light+", body: "light", bg: "#ffffff", fg: "#000000" },
  { name: "VS Code Light Modern", body: "light", bg: "#ffffff", fg: "#3b3b3b" },
  { name: "GitStudio desktop light", body: "light", ...desktopEditor("light") },
  { name: "VS Code High Contrast", body: "hcDark", bg: "#000000", fg: "#ffffff" },
  { name: "VS Code High Contrast Light", body: "hcLight", bg: "#ffffff", fg: "#292929" },
];

interface Measured {
  line: string;
  inner: string;
  edge: string;
  done: string;
  ruler: string;
  frame: string;
  half: string;
  settled: string;
}

/**
 * The pairs that tell a CATEGORY apart — conflict, the same on both sides, a
 * one-sided change (whichever of its three tones) — must stay apart under
 * deuteranopia and protanopia too. Inserted / modified / deleted among
 * themselves only say what a one-sided change did; the words (legend,
 * tooltips) carry that for everyone.
 */
const CATEGORY_PAIRS: Array<[Tone, Tone]> = [
  ["conflict", "same"], ["conflict", "inserted"], ["conflict", "modified"], ["conflict", "deleted"],
  ["same", "inserted"], ["same", "modified"], ["same", "deleted"],
];

test("text on every tint, edges on every background, and the categories apart — in every theme", { skip: !CHROME && "no Chrome on this machine" }, async (t) => {
  // The page resolves the tokens under each theme's BODY CLASS — the only
  // thing that picks a palette — and reports the computed colours.
  const v = await runMergePage(CHROME!, `
    const view = mountView(gsMerge.payload());
    const body = document.querySelector(".jb-pane-body");
    const probe = (cls, style) => {
      const el = document.createElement("div");
      el.className = cls;
      el.style.cssText = "position:absolute;width:20px;height:18px;" + (style || "");
      body.appendChild(el);
      const cs = getComputedStyle(el);
      const out = { bg: cs.backgroundColor, color: cs.color, border: cs.borderTopStyle };
      el.remove();
      return out;
    };
    const CLASSES = {
      dark: "vscode-dark",
      light: "vscode-light",
      hcDark: "vscode-high-contrast",
      hcLight: "vscode-high-contrast vscode-high-contrast-light",
    };
    const out = {};
    for (const [key, cls] of Object.entries(CLASSES)) {
      document.body.className = cls;
      const tones = {};
      for (const t of ["inserted", "deleted", "modified", "same", "conflict"]) {
        tones[t] = {
          line: probe("jb-line-" + t).bg,
          inner: probe("jb-inner-" + t).bg,
          edge: probe("", "color:var(--jb-edge-" + t + ")").color,
          done: probe("", "color:var(--jb-done-" + t + ")").color,
          ruler: probe("", "color:var(--jb-ruler-" + t + ")").color,
          frame: probe("jb-frame jb-frame-" + t + " jb-edge-top").border,
          // The classes a half-done conflict's result carries.
          half: probe("jb-line-" + t + " jb-half").bg,
          settled: probe("", "color:var(--jb-settled)").color,
        };
      }
      out[key] = tones;
    }
    notes.measured = out;
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
  const measured = v.notes?.measured as Record<BodyClass, Record<Tone, Measured>>;
  assert.ok(measured, "the page reported its colours");

  const problems: string[] = [];
  const report: string[] = [];
  for (const theme of THEMES) {
    const bg = parseColor(theme.bg).slice(0, 3) as RGB;
    const fg = parseColor(theme.fg).slice(0, 3) as RGB;
    const tones = measured[theme.body];
    const lines = {} as Record<Tone, RGB>;
    const row: string[] = [];
    for (const tone of TONES) {
      const m = tones[tone];
      const lineRGBA = parseColor(m.line);
      if (lineRGBA[3] === 0) {
        problems.push(`${theme.name}: .jb-line-${tone} resolves to no colour at all (${m.line})`);
        continue;
      }
      const line = over(lineRGBA, bg);
      const inner = over(parseColor(m.inner), line);
      const edge = over(parseColor(m.edge), bg);
      const done = over(parseColor(m.done), bg);
      const ruler = over(parseColor(m.ruler), bg);
      lines[tone] = line;
      const onLine = contrast(fg, line);
      const onInner = contrast(fg, inner);
      const edgeVsBg = contrast(edge, bg);
      const doneVsBg = contrast(done, bg);
      const rulerVsBg = contrast(ruler, bg);
      // "A step stronger": the word tint must be seen against its own line.
      const innerStep = deltaE2000(inner, line);
      row.push(`${tone} text ${onLine.toFixed(2)}/${onInner.toFixed(2)} edge ${edgeVsBg.toFixed(2)} done ${doneVsBg.toFixed(2)} ruler ${rulerVsBg.toFixed(2)} word-step ΔE ${innerStep.toFixed(1)}`);
      if (onLine < 4.5) problems.push(`${theme.name}: text on the ${tone} line tint is ${onLine.toFixed(2)}:1 (< 4.5)`);
      if (onInner < 4.5) problems.push(`${theme.name}: text on the ${tone} word tint is ${onInner.toFixed(2)}:1 (< 4.5)`);
      if (edgeVsBg < 3) problems.push(`${theme.name}: the ${tone} edge is ${edgeVsBg.toFixed(2)}:1 against the background (< 3)`);
      if (innerStep < 5) problems.push(`${theme.name}: the ${tone} word tint is only ΔE ${innerStep.toFixed(1)} from its line (< 5)`);
      // A handled change's outline is FAINT, but there: visible, and quieter than an edge.
      if (doneVsBg < 1.5 || doneVsBg >= edgeVsBg) problems.push(`${theme.name}: the ${tone} handled outline is ${doneVsBg.toFixed(2)}:1 (want ≥ 1.5 and below the edge's ${edgeVsBg.toFixed(2)})`);
      // A ruler mark at reduced strength: findable, never the full edge colour.
      if (rulerVsBg < 1.8 || rulerVsBg >= edgeVsBg) problems.push(`${theme.name}: the ${tone} ruler mark is ${rulerVsBg.toFixed(2)}:1 (want ≥ 1.8 and below the edge's ${edgeVsBg.toFixed(2)})`);
      if (tone === "conflict" && (theme.body === "dark" || theme.body === "hcDark")) {
        // The owner found the dark conflict red heavy: with six conflicts,
        // maroon dominated the page. It stood ΔE 21.9 off Dark+'s background;
        // it may stand no further than 19 in any dark theme (and the category
        // rules below still hold, colour-blind ones included — they are what
        // keeps it from going lighter still).
        const weight = deltaE2000(line, bg);
        row.push(`conflict weight ΔE ${weight.toFixed(1)}`);
        if (weight > 19) problems.push(`${theme.name}: the conflict band stands ΔE ${weight.toFixed(1)} off the background (> 19): heavy`);
      }
      if (tone === "conflict") {
        // A conflict with one side in: its result is a DIFFERENT, quieter
        // tint than the open conflict (the owner: "after Accept Yours the
        // result still wears the full conflict look"), still readable, still
        // there against the background.
        const half = over(parseColor(m.half), bg);
        const halfStep = deltaE2000(half, line);
        const halfVsBg = deltaE2000(half, bg);
        row.push(`half: text ${contrast(fg, half).toFixed(2)} ΔE ${halfStep.toFixed(1)} from open, ${halfVsBg.toFixed(1)} from bg`);
        if (contrast(fg, half) < 4.5) problems.push(`${theme.name}: text on the half-done conflict tint is ${contrast(fg, half).toFixed(2)}:1 (< 4.5)`);
        if (halfStep < 5) problems.push(`${theme.name}: a half-done conflict's result is only ΔE ${halfStep.toFixed(1)} from an open one (< 5)`);
        if (halfVsBg < 2) problems.push(`${theme.name}: a half-done conflict's result is only ΔE ${halfVsBg.toFixed(1)} from the background (< 2)`);
        // A resolved change's line: faint, neutral, quieter than a handled side's.
        const settled = over(parseColor(m.settled), bg);
        const settledVsBg = contrast(settled, bg);
        row.push(`settled ${settledVsBg.toFixed(2)}`);
        if (settledVsBg < 1.3 || settledVsBg > doneVsBg) problems.push(`${theme.name}: the settled line is ${settledVsBg.toFixed(2)}:1 (want ≥ 1.3 and at most the handled outline's ${doneVsBg.toFixed(2)})`);
      }
      const hc = theme.body === "hcDark" || theme.body === "hcLight";
      if (hc && m.frame !== "solid") problems.push(`${theme.name}: a pending ${tone} block has no solid frame edge (${m.frame})`);
      if (!hc && m.frame !== "none") problems.push(`${theme.name}: frame edges drawn outside high contrast (${m.frame})`);
    }
    for (let a = 0; a < TONES.length; a++) {
      for (let b = a + 1; b < TONES.length; b++) {
        const [ta, tb] = [TONES[a], TONES[b]];
        if (!lines[ta] || !lines[tb]) continue;
        const d = deltaE2000(lines[ta], lines[tb]);
        if (d < 10) problems.push(`${theme.name}: ${ta} and ${tb} tints are only ΔE ${d.toFixed(1)} apart (< 10)`);
      }
    }
    for (const [a, b] of CATEGORY_PAIRS) {
      if (!lines[a] || !lines[b]) continue;
      for (const [kind, m] of Object.entries(CVD)) {
        const d = deltaE2000(simulate(lines[a], m), simulate(lines[b], m));
        // Identical vs conflict is the pair whose confusion would mislead
        // ("safe to take" read as "needs you"): far apart. Every other
        // category pair: still visibly apart (JetBrains' own New UI palette
        // measures 3.7 for inserted vs conflict under deuteranopia).
        const floor = a === "conflict" && b === "same" ? 15 : 4;
        if (a === "conflict" && b === "same") row.push(`same~conflict ${kind} ΔE ${d.toFixed(1)}`);
        if (d < floor) problems.push(`${theme.name}: ${a} vs ${b} under ${kind} is ΔE ${d.toFixed(1)} (< ${floor})`);
      }
    }
    report.push(`${theme.name}: ${row.join(", ")}`);
  }
  for (const line of report) {
    t.diagnostic(line);
  }
  assert.deepEqual(problems, [], problems.join("\n") + "\n\n" + report.join("\n"));
});
