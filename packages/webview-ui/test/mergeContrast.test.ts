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
 * The merge paints by DECISION (paint.ts): red a conflict (you choose), green
 * the same change on both sides (either arrow takes it), blue one side only
 * (safe to take) — the owner's rule of 24 Sep 2026. So the three tones are
 * what must tell apart, for everyone:
 *
 * - the editor's text on every line tint, and on every word tint over it,
 *   >= 4.5:1 (WCAG 1.4.3); the word tint a visible step (ΔE >= 5) over its line;
 * - the syntax colours of Dark+ / Light+ on every tint and word tint no worse
 *   than on the per-type palette this replaced (its floor was 2.9 dark, 2.8
 *   light; the decision palette holds 2.95 / 2.82);
 * - every edge colour (legend dots, overview marks, high-contrast frames)
 *   >= 3:1 against the editor background (WCAG 1.4.11, non-text); a handled
 *   change's outline >= 3:1 and quieter than an edge;
 * - every pair of the three tones apart (CIEDE2000) with normal vision AND
 *   under simulated deuteranopia, protanopia and tritanopia (Machado et al.
 *   2009, severity 1) — on the bands, on the word tints, on the dots and
 *   marks, and on the traces a decision leaves;
 * - red and green apart in LIGHTNESS as well as hue — the pair deuteranopia
 *   and protanopia lose: the conflict stands further from the background than
 *   the same change, on the band, the word tint and the dot;
 * - a settled change's TRACE (the muted tint a taken side, its ribbon and
 *   the Result keep) readable, visibly quieter than the open band, and still
 *   there against the background.
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

/** The merge's three decisions (paint.ts PAINT_TONES). */
const TONES = ["conflict", "same", "one-sided"] as const;
type Tone = (typeof TONES)[number];
/** The 2-way diff's roles: it has no decision to make, and colours by what a change did. */
const ROLES = ["inserted", "deleted", "modified"] as const;

// ── The token block and the classes the views emit ────────────────────────────

test("diff.css declares every decision's tokens in both palettes; every class the views emit has a rule, and the per-type merge paint is gone", () => {
  const css = readFileSync(DIFF_CSS, "utf8");
  const block = (head: string) => {
    const start = css.indexOf(head);
    assert.ok(start >= 0, `diff.css has a "${head}" palette block`);
    return css.slice(start, css.indexOf("}", start));
  };
  for (const head of [":root {", "body.vscode-light, body.vscode-high-contrast-light {"]) {
    const b = block(head);
    for (const tone of TONES) {
      for (const kind of ["line", "inner", "edge", "done", "muted", "point"]) {
        assert.ok(b.includes(`--jb-${kind}-${tone}:`), `${head} declares --jb-${kind}-${tone}`);
      }
    }
    for (const role of ROLES) {
      for (const kind of ["line", "inner", "ruler"]) {
        assert.ok(b.includes(`--jb-${kind}-${role}:`), `${head} declares the 2-way diff's --jb-${kind}-${role}`);
      }
    }
    // The merge's per-type paint is gone: no trace, outline, point or half of
    // an "inserted" / "modified" / "deleted" merge change any more.
    for (const role of ROLES) {
      for (const kind of ["done", "muted", "point", "half"]) {
        assert.ok(!b.includes(`--jb-${kind}-${role}:`), `${head} no longer declares --jb-${kind}-${role}`);
      }
    }
  }
  assert.ok(!/--jb-(line|edge)-resolved/.test(css), "no grey 'resolved' wash");
  assert.ok(!/--jb-settled|jb-settled/.test(css), "no disconnected grey line");
  // Every class the merge and diff views put on the page has a rule — a class
  // with no rule fails silently (memory: dead CSS class names).
  const selectors: string[] = [];
  for (const tone of TONES) {
    selectors.push(
      `.jb-line-${tone}`, `.jb-inner-${tone}`, `.jb-ribbon-${tone}`, `.jb-point-${tone}`,
      `.jb-done-${tone}`, `.jb-frame-${tone}`, `.jb-ribbon-frame-${tone}`,
      `.jb-trace-${tone}`, `.jb-trace-edge-${tone}`, `.jb-ribbon-trace-${tone}`, `.jb-ribbon-trace-edge-${tone}`,
      `.jb-ribbon-cap-${tone}`, `.jb-ribbon-cap-trace-${tone}`,
      `.jb-btn-accept.jb-tone-${tone}:hover`, `.jb-dot-${tone}`,
    );
  }
  // The 2-way diff names its ROLE (diffView.ts): bands, word tints, ribbons,
  // the transfer arrow and point markers.
  for (const role of ROLES) {
    selectors.push(`.jb-line-${role}`, `.jb-inner-${role}`, `.jb-ribbon-${role}`, `.jb-btn-accept.jb-role-${role}:hover`, `.jb-marker-${role}`);
  }
  selectors.push(
    ".jb-ws", ".jb-done", ".jb-frame", ".jb-point", ".jb-point-after", ".jb-edge-top", ".jb-edge-bottom",
    ".jb-half", ".jb-trace", ".jb-trace-note",
    ".jb-ribbon-base", ".jb-ribbon-trace", ".jb-ribbon-cap", ".jb-ribbon-frame", ".jb-legend", ".jb-legend-chip",
    ".jb-legend-help", ".jb-legend-pop", ".jb-legend-row", ".jb-legend-count", ".jb-legend-sep",
    ".jb-legend-dot", ".jb-legend-note", ".jb-legend-dash", ".jb-legend-sample",
    ".jb-sample-half", ".jb-sample-done", ".jb-sample-trace", ".jb-sample-point", ".jb-sample-word", ".jb-sample-ws",
    ".jb-map", ".jb-map-canvas", ".jb-map-thumb", ".jb-map-view",
    ".codicon-arrow-right", ".codicon-arrow-left", ".codicon-close", ".codicon-wand", ".codicon-question",
  );
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const sel of selectors) {
    // The selector itself, not a longer class that starts with it
    // (".jb-point" must not be satisfied by ".jb-point-inserted").
    assert.ok(new RegExp(`${escape(sel)}(?![\\w-])`).test(css), `a rule names ${sel}`);
  }
  // What the owner rejected is gone for good: the invented marks, the per-change
  // wand and append icon, the dashed "applied" style, the square swatches that
  // read as unticked checkboxes — and now the merge's per-type paint (a
  // change on one side, or on both, coloured by what it did).
  const gone = [
    ".jb-settled", ".jb-sample-settled", ".jb-ribbon-done", ".jb-ribbon-line-base", ".jb-mark", ".jb-result-actions",
    ".jb-btn-append", ".jb-btn-keep-base", ".jb-btn-wand", ".jb-legend-glyph", ".jb-legend-extra", ".codicon-insert",
    ".codicon-sparkle", ".jb-legend-swatch", ".jb-swatch-conflict", ".jb-swatch-one-sided", ".jb-legend-kind",
  ];
  for (const role of ROLES) {
    gone.push(
      `.jb-trace-${role}`, `.jb-done-${role}`, `.jb-point-${role}`, `.jb-frame-${role}`, `.jb-trace-edge-${role}`,
      `.jb-ribbon-trace-${role}`, `.jb-ribbon-cap-${role}`, `.jb-ribbon-cap-trace-${role}`, `.jb-ribbon-frame-${role}`,
      `.jb-btn-accept.jb-tone-${role}`, `.jb-dot-${role}`,
    );
  }
  for (const g of gone) {
    assert.ok(!new RegExp(`${escape(g)}(?![\\w-])`).test(css), `no rule for the retired ${g}`);
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
  P: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
  D: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  T: [[1.255528, -0.076749, -0.178779], [-0.078411, 0.930809, 0.147602], [0.004733, 0.691367, 0.3039]],
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

/** Each VS Code theme's own token colours (keyword, control keyword, string, number, comment, type, function, variable). */
const DARK_PLUS = {
  keyword: "#569cd6", control: "#c586c0", string: "#ce9178", number: "#b5cea8",
  comment: "#6a9955", type: "#4ec9b0", function: "#dcdcaa", variable: "#9cdcfe",
};
const LIGHT_PLUS = {
  keyword: "#0000ff", control: "#af00db", string: "#a31515", number: "#098658",
  comment: "#008000", type: "#267f99", function: "#795e26", variable: "#001080",
};
const SYNTAX: Record<string, Record<string, string>> = {
  "VS Code Dark+": DARK_PLUS,
  "VS Code Dark Modern": DARK_PLUS,
  "VS Code Light+": LIGHT_PLUS,
  "VS Code Light Modern": LIGHT_PLUS,
};

interface Measured {
  line: string;
  inner: string;
  edge: string;
  done: string;
  frame: string;
  half: string;
  muted: string;
}

/** CIE L* (lightness) of an sRGB colour. */
const lightness = (c: RGB): number => lab(c)[0];

/**
 * The floors every PAIR of decisions holds, as ΔE (CIEDE2000) with normal
 * vision (N) and under simulated deuteranopia (D), protanopia (P) and
 * tritanopia (T): on the bands, the word tints, the dots and marks (edges),
 * and the traces a decision leaves. The red/green pair gets its own, higher
 * band floors under deuteranopia and protanopia — the pair those viewers
 * lose, and the owner's first concern. The per-type palette this replaced
 * stood its red and green bands 4.0 (D) and 4.2 (P) apart, its dots 4.0 (D).
 */
const FLOORS = {
  line: { N: 10, D: 5.5, P: 5.5, T: 5.5 },
  inner: { N: 10, D: 7, P: 7, T: 7 },
  edge: { N: 20, D: 11, P: 11, T: 11 },
  muted: { N: 5, D: 3, P: 3, T: 3 },
} as const;
const RED_GREEN_LINE = { D: 10, P: 6.5 } as const;

test("text on every tint, edges on every background, and the three decisions apart — for colour-blind eyes too — in every theme", { skip: !CHROME && "no Chrome on this machine" }, async (t) => {
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
      for (const t of ${JSON.stringify(TONES)}) {
        tones[t] = {
          line: probe("jb-line-" + t).bg,
          inner: probe("jb-inner-" + t).bg,
          edge: probe("", "color:var(--jb-edge-" + t + ")").color,
          done: probe("", "color:var(--jb-done-" + t + ")").color,
          frame: probe("jb-frame jb-frame-" + t + " jb-edge-top").border,
          // The classes a half-done conflict's result carries.
          half: probe("jb-line-" + t + " jb-half").bg,
          // A settled change's trace: a taken side, and the Result that holds it.
          muted: probe("jb-trace jb-trace-" + t).bg,
          // The legend's dot, and the overview strip's mark.
          dot: getComputedStyle(Object.assign(document.body.appendChild(document.createElement("span")), { className: "jb-legend-dot jb-dot-" + t })).backgroundColor,
        };
      }
      document.querySelectorAll("body > .jb-legend-dot").forEach((e) => e.remove());
      out[key] = tones;
    }
    notes.measured = out;
  `);
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
  const measured = v.notes?.measured as Record<BodyClass, Record<Tone, Measured & { dot: string }>>;
  assert.ok(measured, "the page reported its colours");

  const problems: string[] = [];
  const report: string[] = [];
  for (const theme of THEMES) {
    const bg = parseColor(theme.bg).slice(0, 3) as RGB;
    const fg = parseColor(theme.fg).slice(0, 3) as RGB;
    const tones = measured[theme.body];
    const cols = { line: {}, inner: {}, edge: {}, muted: {} } as Record<keyof typeof FLOORS, Record<Tone, RGB>>;
    const row: string[] = [];
    const hc = theme.body === "hcDark" || theme.body === "hcLight";
    const dark = theme.body === "dark" || theme.body === "hcDark";
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
      const muted = over(parseColor(m.muted), bg);
      cols.line[tone] = line;
      cols.inner[tone] = inner;
      cols.edge[tone] = edge;
      cols.muted[tone] = muted;
      if (m.dot !== m.edge) problems.push(`${theme.name}: the legend's ${tone} dot (${m.dot}) is not the ${tone} edge colour (${m.edge})`);
      const onLine = contrast(fg, line);
      const onInner = contrast(fg, inner);
      const edgeVsBg = contrast(edge, bg);
      const doneVsBg = contrast(done, bg);
      // "A step stronger": the word tint must be seen against its own line.
      const innerStep = deltaE2000(inner, line);
      row.push(`${tone} text ${onLine.toFixed(2)}/${onInner.toFixed(2)} L* ${lightness(line).toFixed(1)} edge ${edgeVsBg.toFixed(2)} done ${doneVsBg.toFixed(2)} word-step ΔE ${innerStep.toFixed(1)} off bg ΔE ${deltaE2000(line, bg).toFixed(1)}`);
      // The theme's SYNTAX colours on the tints: the tokens that differ in a
      // conflict — a number, a keyword, a comment — on the line tint and on
      // the word tint over it. No worse than the per-type palette this
      // replaced (its floor was 2.9 dark / 2.8 light; it measured 2.90 /
      // 2.80 at worst): 2.95 / 2.82.
      const floor = theme.body === "dark" ? 2.95 : 2.82;
      for (const [token, hexColor] of Object.entries(SYNTAX[theme.name] ?? {})) {
        const tok = parseColor(hexColor).slice(0, 3) as RGB;
        const onL = contrast(tok, line);
        const onW = contrast(tok, inner);
        if (onL < floor || onW < floor) problems.push(`${theme.name}: ${token} (${hexColor}) on the ${tone} tint is ${onL.toFixed(2)}:1, on its word tint ${onW.toFixed(2)}:1 (< ${floor})`);
      }
      if (onLine < 4.5) problems.push(`${theme.name}: text on the ${tone} line tint is ${onLine.toFixed(2)}:1 (< 4.5)`);
      if (onInner < 4.5) problems.push(`${theme.name}: text on the ${tone} word tint is ${onInner.toFixed(2)}:1 (< 4.5)`);
      if (edgeVsBg < 3) problems.push(`${theme.name}: the ${tone} edge is ${edgeVsBg.toFixed(2)}:1 against the background (< 3)`);
      if (innerStep < 5) problems.push(`${theme.name}: the ${tone} word tint is only ΔE ${innerStep.toFixed(1)} from its line (< 5)`);
      // Every band shows against the background — the quiet same change too.
      if (deltaE2000(line, bg) < 9) problems.push(`${theme.name}: the ${tone} band is only ΔE ${deltaE2000(line, bg).toFixed(1)} off the background (< 9)`);
      // A handled change's outline is quieter than an edge — but the legend
      // gives it a meaning ("an outline with no link: the side you
      // discarded"), so it is a non-text mark WCAG 1.4.11 holds to 3:1. In
      // high contrast it IS the edge colour.
      if (doneVsBg < 3 || (hc ? doneVsBg > edgeVsBg + 0.01 : doneVsBg >= edgeVsBg)) problems.push(`${theme.name}: the ${tone} handled outline is ${doneVsBg.toFixed(2)}:1 (want ≥ 3 and ${hc ? "the edge's" : "below the edge's"} ${edgeVsBg.toFixed(2)})`);
      if (tone === "conflict" && dark) {
        // The owner found the dark conflict red heavy: with six conflicts,
        // maroon dominated the page. It stood ΔE 21.9 off Dark+'s background;
        // it may stand no further than 19 in any dark theme.
        const weight = deltaE2000(line, bg);
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
        if (contrast(fg, half) < 4.5) problems.push(`${theme.name}: text on the half-done conflict tint is ${contrast(fg, half).toFixed(2)}:1 (< 4.5)`);
        if (halfStep < 5) problems.push(`${theme.name}: a half-done conflict's result is only ΔE ${halfStep.toFixed(1)} from an open one (< 5)`);
        if (halfVsBg < 2) problems.push(`${theme.name}: a half-done conflict's result is only ΔE ${halfVsBg.toFixed(1)} from the background (< 2)`);
      }
      // Every change, once settled, keeps a TRACE in its decision's colour:
      // the muted tint, readable, visibly quieter than its open band, and
      // still there on the background (the owner: which side was taken must
      // remain visible). The half-done Result wears the same tint, so the
      // taken side's ribbon runs into it.
      const mutedStep = deltaE2000(muted, line);
      const mutedVsBg = deltaE2000(muted, bg);
      if (contrast(fg, muted) < 4.5) problems.push(`${theme.name}: text on the ${tone} trace is ${contrast(fg, muted).toFixed(2)}:1 (< 4.5)`);
      if (mutedStep < 3) problems.push(`${theme.name}: the ${tone} trace is only ΔE ${mutedStep.toFixed(1)} from its open band (< 3): not calmer`);
      // Visible, not merely there: the round-1 screenshots showed a dark
      // same-change trace at ΔE 4.3 as all but gone.
      if (mutedVsBg < 4.5) problems.push(`${theme.name}: the ${tone} trace is only ΔE ${mutedVsBg.toFixed(1)} from the background (< 4.5): all but gone`);
      if (mutedVsBg >= deltaE2000(line, bg)) problems.push(`${theme.name}: the ${tone} trace stands further off the background than its open band`);
      if (m.half !== m.muted) problems.push(`${theme.name}: the half-done ${tone} Result (${m.half}) is not the trace's tint (${m.muted}), so the taken side's ribbon changes colour where it meets it`);
      if (hc && m.frame !== "solid") problems.push(`${theme.name}: a pending ${tone} block has no solid frame edge (${m.frame})`);
      if (!hc && m.frame !== "none") problems.push(`${theme.name}: frame edges drawn outside high contrast (${m.frame})`);
    }
    // Every pair of decisions, on every surface, for every eye.
    for (const kind of Object.keys(FLOORS) as Array<keyof typeof FLOORS>) {
      for (let a = 0; a < TONES.length; a++) {
        for (let b = a + 1; b < TONES.length; b++) {
          const [ta, tb] = [TONES[a], TONES[b]];
          const [ca, cb] = [cols[kind][ta], cols[kind][tb]];
          if (!ca || !cb) continue;
          const seen: string[] = [];
          for (const eye of ["N", "D", "P", "T"] as const) {
            const d = eye === "N" ? deltaE2000(ca, cb) : deltaE2000(simulate(ca, CVD[eye]), simulate(cb, CVD[eye]));
            seen.push(`${eye}${d.toFixed(1)}`);
            const redGreen = kind === "line" && ta === "conflict" && tb === "same" && (eye === "D" || eye === "P");
            const floor = redGreen ? RED_GREEN_LINE[eye] : FLOORS[kind][eye];
            if (d < floor) problems.push(`${theme.name}: ${ta} vs ${tb} ${kind} ${eye === "N" ? "with normal vision" : `under ${{ D: "deuteranopia", P: "protanopia", T: "tritanopia" }[eye]}`} is ΔE ${d.toFixed(1)} (< ${floor})`);
          }
          if (kind === "line" || kind === "edge") row.push(`${ta}~${tb} ${kind} ${seen.join(" ")}`);
        }
      }
    }
    // Red and green apart in LIGHTNESS as well as hue: the conflict stands
    // further from the background than the same change — brighter on a dark
    // ground, deeper on a light one — on its band, its word tint and its dot.
    for (const [kind, min] of [["line", 4], ["inner", 4], ["edge", 7]] as const) {
      const c = cols[kind].conflict;
      const s = cols[kind].same;
      if (!c || !s) continue;
      const gap = dark ? lightness(c) - lightness(s) : lightness(s) - lightness(c);
      row.push(`red-green ${kind} ΔL* ${gap.toFixed(1)}`);
      if (gap < min) problems.push(`${theme.name}: the conflict ${kind} stands only ${gap.toFixed(1)} L* further from the background than the same change's (< ${min})`);
    }
    report.push(`${theme.name}: ${row.join(", ")}`);
  }
  for (const line of report) {
    t.diagnostic(line);
  }
  assert.deepEqual(problems, [], problems.join("\n") + "\n\n" + report.join("\n"));
});
