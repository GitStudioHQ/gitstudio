import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { findChrome, runMergePage } from "./fixtures/mergeViewPage";

/**
 * The merge colours are the owner's, readable, and tell apart — measured on
 * the COMPUTED colours Chrome resolves from diff.css under each theme's body
 * class, then composited over each editor background (a tint is translucent:
 * what the eye gets is tint-over-background, not the token).
 *
 * The owner, 24 Sep 2026: JetBrains' merge colours — orange a conflict (you
 * choose), green the same change on both sides (either arrow takes it), blue
 * one side only (safe to take), grey lines removed without a conflict — each
 * in two strengths, as JetBrains paints them: "#C2D7F2 highlights the diffs
 * in text and uses this colour in the columns, #E6EFFA is used in the lines".
 * So:
 *
 * - light: the full colours land EXACTLY on #fed5cc #c2d7f2 #d6d6d6, the
 *   lighter ones on #ffeeeb #e6effa #efefef (grey's derived by JetBrains' 40%
 *   rule, which both measured pairs follow); the green is the leaf green that
 *   replaced JetBrains' mint (the owner found it too washed out), #9edcaa and
 *   #d8f1dd; and a changed word over a lighter line lands on the full colour;
 * - every theme: the lighter colour visibly off the background and a visible
 *   step below the full one; a word on the full colour; the editor's text
 *   >= 4.5:1 (WCAG AA) on all of them, and the syntax colours no worse than
 *   measured here (the dark full colours are about JetBrains' own lightness,
 *   where Dark+'s keyword blue sits near 2.5:1 as it does in JetBrains);
 * - each full colour its hue: orange, green, blue, a neutral grey;
 * - every edge colour (legend dots, overview marks, high-contrast frames)
 *   >= 3:1 against the editor background (WCAG 1.4.11, non-text);
 * - the four apart, as ΔE in OKLab, on the full colours (the columns and the
 *   words: what names a change) and on the edges, with normal vision and
 *   under simulated deuteranopia, protanopia and tritanopia (Machado et al.
 *   2009, severity 1). The owner's pastels bring orange and green close for
 *   deuteranopes (JetBrains ships separate colour-blind schemes instead): the
 *   floors pin what is measured, and the legend says every colour in words.
 *   The lighter line tints are pale by design and not held apart — the
 *   column beside them names the change;
 * - a settled change's trace and a half-decided Result wear the lighter
 *   colour; a point's line and a discarded side's outline the full colour
 *   (the edge colour in high contrast), frames only in high contrast.
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

/** The merge's four colours (paint.ts PAINT_TONES, in the legend's order). */
const TONES = ["conflict", "same", "one-sided", "removed"] as const;
type Tone = (typeof TONES)[number];
/** The 2-way diff's roles: it has no decision to make, and colours by what a change did. */
const ROLES = ["inserted", "deleted", "modified"] as const;

// ── The token block and the classes the views emit ────────────────────────────

test("diff.css declares every colour's tokens in both palettes; every class the views emit has a rule; the retired looks are gone", () => {
  const css = readFileSync(DIFF_CSS, "utf8");
  const block = (head: string) => {
    const start = css.indexOf(head);
    assert.ok(start >= 0, `diff.css has a "${head}" block`);
    return css.slice(start, css.indexOf("}", start));
  };
  for (const head of [":root {", "body.vscode-light, body.vscode-high-contrast-light {"]) {
    const b = block(head);
    for (const tone of TONES) {
      for (const kind of ["full", "line", "inner", "edge"]) {
        assert.ok(b.includes(`--jb-${kind}-${tone}:`), `${head} declares --jb-${kind}-${tone}`);
      }
    }
    for (const role of ROLES) {
      for (const kind of ["line", "inner", "ruler"]) {
        assert.ok(b.includes(`--jb-${kind}-${role}:`), `${head} declares the 2-way diff's --jb-${kind}-${role}`);
      }
    }
  }
  // The trace, the half-done Result, a point and an outline are DERIVED from
  // each theme's own two strengths, where that theme declares them.
  const derived = block(":root, body.vscode-light, body.vscode-high-contrast-light {");
  const hcDark = block("body.vscode-high-contrast:not(.vscode-high-contrast-light) {");
  for (const tone of TONES) {
    for (const [kind, from] of [["muted", "line"], ["half", "line"], ["done", "full"], ["point", "full"]]) {
      assert.ok(derived.includes(`--jb-${kind}-${tone}: var(--jb-${from}-${tone})`), `the derived block sets --jb-${kind}-${tone} to the ${from} colour`);
    }
    for (const kind of ["full", "line", "inner"]) {
      assert.ok(hcDark.includes(`--jb-${kind}-${tone}:`), `high contrast dark declares its own --jb-${kind}-${tone}`);
    }
    for (const [kind, from] of [["muted", "line"], ["half", "line"]]) {
      assert.ok(hcDark.includes(`--jb-${kind}-${tone}: var(--jb-${from}-${tone})`), `high contrast dark derives --jb-${kind}-${tone} from its own ${from} colour`);
    }
  }
  // The merge's per-type paint is gone: no trace, outline, point or half of
  // an "inserted" / "modified" / "deleted" merge change.
  for (const role of ROLES) {
    for (const kind of ["done", "muted", "point", "half", "full"]) {
      assert.ok(!css.includes(`--jb-${kind}-${role}:`), `no --jb-${kind}-${role}`);
    }
  }
  assert.ok(!/--jb-(line|edge)-resolved/.test(css), "no grey 'resolved' wash");
  assert.ok(!/--jb-settled|jb-settled/.test(css), "no disconnected grey line");
  // Every class the merge and diff views put on the page has a rule — a class
  // with no rule fails silently (memory: dead CSS class names).
  const selectors: string[] = [];
  for (const tone of TONES) {
    selectors.push(
      `.jb-line-${tone}`, `.jb-margin-${tone}`, `.jb-inner-${tone}`, `.jb-ribbon-${tone}`,
      `.jb-point-${tone}`, `.jb-done-${tone}`, `.jb-frame-${tone}`, `.jb-ribbon-frame-${tone}`,
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
    ".jb-done", ".jb-frame", ".jb-point", ".jb-point-after", ".jb-edge-top", ".jb-edge-bottom",
    ".jb-half", ".jb-trace", ".jb-trace-note",
    ".jb-ribbon-base", ".jb-ribbon-trace", ".jb-ribbon-cap", ".jb-ribbon-frame", ".jb-legend", ".jb-legend-chip",
    ".jb-legend-help", ".jb-legend-pop", ".jb-legend-row", ".jb-legend-count", ".jb-legend-sep",
    ".jb-legend-dot", ".jb-legend-note", ".jb-legend-dash", ".jb-legend-sample",
    ".jb-sample-column", ".jb-sample-half", ".jb-sample-done", ".jb-sample-trace", ".jb-sample-point", ".jb-sample-word",
    ".jb-map", ".jb-map-canvas", ".jb-map-thumb", ".jb-map-view",
    ".codicon-arrow-right", ".codicon-arrow-left", ".codicon-close", ".codicon-wand", ".codicon-question",
  );
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const sel of selectors) {
    // The selector itself, not a longer class that starts with it
    // (".jb-point" must not be satisfied by ".jb-point-inserted").
    assert.ok(new RegExp(`${escape(sel)}(?![\\w-])`).test(css), `a rule names ${sel}`);
  }
  // What the owner rejected is gone for good: the invented marks, the
  // per-change wand and append icon, the dashed "applied" style, the square
  // swatches that read as unticked checkboxes, the merge's per-type paint —
  // and the bar beside the line numbers and the dotted whitespace edge (no
  // vertical per-line bars between the numbers and the code).
  const gone = [
    ".jb-settled", ".jb-sample-settled", ".jb-ribbon-done", ".jb-ribbon-line-base", ".jb-mark", ".jb-result-actions",
    ".jb-btn-append", ".jb-btn-keep-base", ".jb-btn-wand", ".jb-legend-glyph", ".jb-legend-extra", ".codicon-insert",
    ".codicon-sparkle", ".jb-legend-swatch", ".jb-swatch-conflict", ".jb-swatch-one-sided", ".jb-legend-kind",
    ".jb-conflict-bar", ".jb-sample-bar", ".jb-ws", ".jb-sample-ws",
    // …and the solid full-colour block an insertion or a deletion was: the
    // part the owner found not pale enough.
    ".jb-solid",
  ];
  for (const role of ROLES) {
    gone.push(
      `.jb-trace-${role}`, `.jb-done-${role}`, `.jb-point-${role}`, `.jb-frame-${role}`, `.jb-trace-edge-${role}`,
      `.jb-ribbon-trace-${role}`, `.jb-ribbon-cap-${role}`, `.jb-ribbon-cap-trace-${role}`, `.jb-ribbon-frame-${role}`,
      `.jb-btn-accept.jb-tone-${role}`, `.jb-dot-${role}`, `.jb-margin-${role}`,
    );
  }
  for (const g of gone) {
    assert.ok(!new RegExp(`${escape(g)}(?![\\w-])`).test(css), `no rule for the retired ${g}`);
  }
  assert.ok(!/jb-applied|dasharray|\bdashed\b/.test(css), "no dashed 'applied' style anywhere");
});

// ── colour maths (contrast: WCAG 2; distance: OKLab, CIEDE2000; CVD: Machado 2009)

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

/** OKLab (Ottosson 2020) of an sRGB colour: [L 0..1, a, b]. */
const oklab = (c: RGB): [number, number, number] => {
  const [r, g, b] = c.map(lin);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
};
/** OKLCH: [L, C, h in degrees]. */
const oklch = (c: RGB): [number, number, number] => {
  const [L, a, b] = oklab(c);
  const h = (Math.atan2(b, a) * 180) / Math.PI;
  return [L, Math.hypot(a, b), h < 0 ? h + 360 : h];
};
/** ΔE in OKLab, x100 (a just-noticeable difference is about 2). */
const deltaEok = (c1: RGB, c2: RGB): number => {
  const [L1, a1, b1] = oklab(c1);
  const [L2, a2, b2] = oklab(c2);
  return 100 * Math.hypot(L1 - L2, a1 - a2, b1 - b2);
};
/** ΔE in OKLab as seen by one eye: N normal, or D / P / T simulated. */
const seen = (a: RGB, b: RGB, eye: "N" | "D" | "P" | "T"): number =>
  eye === "N" ? deltaEok(a, b) : deltaEok(simulate(a, CVD[eye]), simulate(b, CVD[eye]));
/** Hue distance in degrees. */
const hueGap = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

test("the colour maths is the standard one", () => {
  // Reference points: WCAG's black on white, and a CIEDE2000 pair from
  // Sharma, Wu & Dalal's test data expressed in sRGB (≈ identity check).
  assert.equal(contrast([0, 0, 0], [255, 255, 255]).toFixed(2), "21.00");
  assert.equal(deltaE2000([128, 128, 128], [128, 128, 128]), 0);
  assert.ok(deltaE2000([255, 0, 0], [0, 0, 255]) > 50);
  // OKLab: white is L 1 with no chroma; sRGB red is oklch(0.628 0.258 29.2).
  const [wL, wa, wb] = oklab([255, 255, 255]);
  assert.ok(Math.abs(wL - 1) < 1e-4 && Math.abs(wa) < 1e-4 && Math.abs(wb) < 1e-4);
  const red = oklch([255, 0, 0]);
  assert.deepEqual([red[0].toFixed(3), red[1].toFixed(3), red[2].toFixed(1)], ["0.628", "0.258", "29.2"]);
  assert.equal(deltaEok([255, 255, 255], [0, 0, 0]).toFixed(1), "100.0");
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
  full: string;
  line: string;
  inner: string;
  edge: string;
  done: string;
  point: string;
  frame: string;
  half: string;
  muted: string;
  dot: string;
}

/** The owner's light colours (JetBrains', measured): full, and lighter. */
const OWNER: Record<Tone, { full: string; lighter: string }> = {
  conflict: { full: "#fed5cc", lighter: "#ffeeeb" },
  same: { full: "#9edcaa", lighter: "#d8f1dd" },
  "one-sided": { full: "#c2d7f2", lighter: "#e6effa" },
  removed: { full: "#d6d6d6", lighter: "#efefef" },
};

/** Each full colour's hue family, in OKLCH degrees (grey: no hue, chroma < 0.015). */
const HUE: Record<Exclude<Tone, "removed">, [number, number]> = {
  conflict: [25, 65],
  same: [135, 160],
  "one-sided": [240, 262],
};

type Surface = "full" | "edge";
type Eye = "N" | "D" | "P" | "T";
/**
 * The floors every PAIR of the four holds, as ΔE in OKLab (x100), with normal
 * vision (N) and under simulated deuteranopia (D), protanopia (P) and
 * tritanopia (T) — on the full colours (the columns and the words) and on the
 * edges (dots and marks). Measured on the owner's palette, worst case over the
 * eight themes: full N 4.4 (blue~grey), D 2.35 (orange~green), P 2.2
 * (orange~grey), T 2.3 (green~blue); edges N 12.1, D 5.3, P 5.9, T 5.8.
 */
const FLOORS: Record<Surface, Record<Eye, number>> = {
  full: { N: 4, D: 2, P: 2, T: 2 },
  edge: { N: 12, D: 5, P: 5.5, T: 5.5 },
};

const hexOf = (c: RGB): string => "#" + c.map((v) => Math.round(v).toString(16).padStart(2, "0")).join("");
/** Two colours the same to within a rounding step per channel. */
const sameColour = (a: RGB, b: RGB): boolean => a.every((v, i) => Math.abs(v - b[i]) <= 1.01);

test("the owner's colours in light, text readable on every tint, each colour its hue, edges on every background, and the four apart — in every theme", { skip: !CHROME && "no Chrome on this machine" }, async (t) => {
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
          // What the views paint: the line-number column, the lighter lines,
          // a line with nothing to compare, and a word.
          full: probe("jb-margin-" + t).bg,
          line: probe("jb-line-" + t).bg,
          inner: probe("jb-inner-" + t).bg,
          edge: probe("", "color:var(--jb-edge-" + t + ")").color,
          done: probe("", "color:var(--jb-done-" + t + ")").color,
          point: probe("", "color:var(--jb-point-" + t + ")").color,
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
  const measured = v.notes?.measured as Record<BodyClass, Record<Tone, Measured>>;
  assert.ok(measured, "the page reported its colours");

  const problems: string[] = [];
  const report: string[] = [];
  const f = (n: number, d = 1) => n.toFixed(d);
  for (const theme of THEMES) {
    const bg = parseColor(theme.bg).slice(0, 3) as RGB;
    const fg = parseColor(theme.fg).slice(0, 3) as RGB;
    const tones = measured[theme.body];
    const cols = { full: {}, edge: {} } as Record<Surface, Record<Tone, RGB>>;
    const row: string[] = [];
    const hc = theme.body === "hcDark" || theme.body === "hcLight";
    const dark = theme.body === "dark" || theme.body === "hcDark";
    for (const tone of TONES) {
      const m = tones[tone];
      if (parseColor(m.full)[3] === 0 || parseColor(m.line)[3] === 0) {
        problems.push(`${theme.name}: the ${tone} colours resolve to nothing (${m.full} / ${m.line})`);
        continue;
      }
      const full = over(parseColor(m.full), bg);
      const line = over(parseColor(m.line), bg);
      const word = over(parseColor(m.inner), line);
      const edge = over(parseColor(m.edge), bg);
      cols.full[tone] = full;
      cols.edge[tone] = edge;
      const [L, C, h] = oklch(full);
      row.push(`${tone} ${hexOf(full)}/${hexOf(line)} oklch(${f(L, 3)} ${f(C, 3)} ${f(h, 0)}) text ${f(contrast(fg, full), 2)}/${f(contrast(fg, line), 2)} edge ${f(contrast(edge, bg), 2)}`);

      // The owner's exact values, on a white editor.
      if (!dark && hexOf(bg) === "#ffffff") {
        const want = OWNER[tone];
        const wf = parseColor(want.full).slice(0, 3) as RGB;
        const wl = parseColor(want.lighter).slice(0, 3) as RGB;
        if (!sameColour(full, wf)) problems.push(`${theme.name}: the ${tone} full colour is ${hexOf(full)}, not the owner's ${want.full}`);
        if (!sameColour(line, wl)) problems.push(`${theme.name}: the ${tone} lighter colour is ${hexOf(line)}, not ${want.lighter}`);
      }
      // A word over the lighter line lands on the full colour.
      if (deltaEok(word, full) > 1) problems.push(`${theme.name}: a ${tone} word lands on ${hexOf(word)}, not the full ${hexOf(full)} (ΔE ${f(deltaEok(word, full), 2)})`);
      // Two strengths: the lighter one visibly off the background, and a
      // visible step below the full one.
      if (deltaEok(line, bg) < 4) problems.push(`${theme.name}: the lighter ${tone} is only ΔE ${f(deltaEok(line, bg))} off the background (< 4)`);
      if (deltaEok(full, line) < 6) problems.push(`${theme.name}: the ${tone} full colour is only ΔE ${f(deltaEok(full, line))} from the lighter one (< 6)`);
      if (deltaEok(line, bg) >= deltaEok(full, bg)) problems.push(`${theme.name}: the lighter ${tone} stands further off the background than the full one`);

      // Text: AA on the full colour, the lighter one and the word.
      for (const [what, c] of [["full colour", full], ["lighter colour", line], ["word tint", word]] as const) {
        if (contrast(fg, c) < 4.5) problems.push(`${theme.name}: text on the ${tone} ${what} is ${f(contrast(fg, c), 2)}:1 (< 4.5)`);
      }
      // The theme's SYNTAX colours: no worse than measured on this palette
      // (Dark Modern's comment green on the green, 2.5:1; Light+'s type teal
      // and number green on the leaf green, 2.9:1).
      const floor = dark ? 2.45 : 2.85;
      for (const [token, hexColor] of Object.entries(SYNTAX[theme.name] ?? {})) {
        const tok = parseColor(hexColor).slice(0, 3) as RGB;
        const worst = Math.min(contrast(tok, full), contrast(tok, line));
        if (worst < floor) problems.push(`${theme.name}: ${token} (${hexColor}) on the ${tone} colours is ${f(worst, 2)}:1 (< ${floor})`);
      }

      // Each full colour its hue.
      if (tone === "removed") {
        if (C >= 0.015) problems.push(`${theme.name}: the removed grey has chroma ${f(C, 3)} (want a neutral grey, < 0.015)`);
      } else {
        const [lo, hi] = HUE[tone];
        if (h < lo || h > hi) problems.push(`${theme.name}: the ${tone} full colour's hue is ${f(h, 0)}° (want ${lo}–${hi}°)`);
      }

      // Edges: the legend's dot IS the edge, >= 3:1 on the background.
      if (m.dot !== m.edge) problems.push(`${theme.name}: the legend's ${tone} dot (${m.dot}) is not the ${tone} edge colour (${m.edge})`);
      if (contrast(edge, bg) < 3) problems.push(`${theme.name}: the ${tone} edge is ${f(contrast(edge, bg), 2)}:1 against the background (< 3)`);

      // What settles and marks: the trace and the half-done Result the lighter
      // colour; a point's line and a discarded side's outline the full colour
      // — the edge colour in high contrast; frames only in high contrast.
      if (m.muted !== m.line) problems.push(`${theme.name}: the ${tone} trace (${m.muted}) is not the lighter colour (${m.line})`);
      if (m.half !== m.line) problems.push(`${theme.name}: the half-done ${tone} Result (${m.half}) is not the lighter colour (${m.line}), so the taken side's ribbon changes colour where it meets it`);
      const wantMark = hc ? m.edge : m.full;
      if (m.point !== wantMark) problems.push(`${theme.name}: a ${tone} point's line is ${m.point}, want ${hc ? "the edge" : "the full colour"} ${wantMark}`);
      if (m.done !== wantMark) problems.push(`${theme.name}: a discarded ${tone} outline is ${m.done}, want ${hc ? "the edge" : "the full colour"} ${wantMark}`);
      if (hc && m.frame !== "solid") problems.push(`${theme.name}: a pending ${tone} block has no solid frame edge (${m.frame})`);
      if (!hc && m.frame !== "none") problems.push(`${theme.name}: frame edges drawn outside high contrast (${m.frame})`);
    }
    if (TONES.some((tone) => !cols.full[tone])) continue;

    // Every pair of the four, on the full colours and the edges, for every eye.
    for (const kind of Object.keys(FLOORS) as Surface[]) {
      for (let a = 0; a < TONES.length; a++) {
        for (let b = a + 1; b < TONES.length; b++) {
          const [ta, tb] = [TONES[a], TONES[b]];
          const out: string[] = [];
          for (const eye of ["N", "D", "P", "T"] as const) {
            const d = seen(cols[kind][ta], cols[kind][tb], eye);
            out.push(`${eye}${f(d)}`);
            if (d < FLOORS[kind][eye]) problems.push(`${theme.name}: ${ta} vs ${tb} ${kind} ${eye === "N" ? "with normal vision" : `under ${{ D: "deuteranopia", P: "protanopia", T: "tritanopia" }[eye]}`} is ΔE ${f(d)} (< ${FLOORS[kind][eye]})`);
          }
          if (kind === "full") row.push(`${ta}~${tb} ${out.join(" ")}`);
        }
      }
    }
    report.push(`${theme.name}: ${row.join(", ")}`);
  }
  for (const line of report) {
    t.diagnostic(line);
  }
  assert.deepEqual(problems, [], problems.join("\n") + "\n\n" + report.join("\n"));
});
