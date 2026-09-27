import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  decls,
  isState,
  notSelection,
  rules,
  selectionLines as sharedSelectionLines,
  topLevel,
} from "../../../packages/webview-ui/test/selectionStatic";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, "../src/renderer/styles/app.css"), "utf8");

/**
 * The analyser is shared with the webviews' static guards
 * (packages/webview-ui/test/selectionStatic.ts). Here a ring in a SURFACE
 * colour is a knockout — the rebase node's halo in its row's own fill,
 * cutting the rail under it — not a mark.
 */
const APP = { label: "app.css", surface: /^[^()]*var\(--app-(bg|panel|elevated|active|hover)\)\s*$/ };
const selectionLines = (css: string): string[] => sharedSelectionLines(css, APP);

/**
 * THE OWNER'S RULE: a selected, active or current thing is never marked with a
 * line — no bar down its edge (an inset box-shadow, a border side, a
 * ::before/::after strip, a child element two pixels wide, a gradient with a
 * hard stop), no rule on top, no underline, no ring or accent outline.
 * ("disgusting", "trash".) It is lit instead: a fill tinted with the accent,
 * and on a pill, a tab or a button a soft glow (--sel-fill, --sel-glow).
 *
 * The harness sweep (`no-selection-is-drawn-as-a-line` in harness/checks.js)
 * measures what the scenes reach. This reads the stylesheet, so a surface no
 * scene reaches — the clone dialog's picked repository, the commit page's HEAD
 * chip, a rebase preset — cannot grow a line back unseen.
 *
 * What is NOT a selected state stays out of it: keyboard focus (`:focus-visible`
 * rings are accessibility), drag-and-drop insertion markers, a native
 * checkbox's own `:checked` box, and status colours (a warning pill, an
 * approved reviewer) whose selectors name no selected state. Hover is NOT
 * exempt: the selected row under the pointer is still the selected row.
 */
test("no selected, active or current state is drawn as a line", () => {
  const found = selectionLines(CSS);
  assert.deepEqual(found, [], `selected states drawn as lines:\n  ${found.join("\n  ")}`);
});

/**
 * The guard above has to SEE every shape — the first version passed nine of
 * them that a review then appended to a copy of this sheet. Each of these is a
 * line in a way the owner has seen or the review found, and each must be
 * reported.
 */
test("the guard sees every shape a line can take", () => {
  const TOKENS = `body.vscode-dark { --gs-accent: #7c5cf0; --sheen: inset 0 1px 0 rgba(255, 255, 255, 0.055); --ring: 0 0 0 3px color-mix(in srgb, var(--gs-accent) 26%, transparent); --sel-fill: color-mix(in srgb, var(--gs-accent) 18%, transparent); }\n`;
  const shapes: [string, string][] = [
    ["a dropdown's current row with an inset bar", ".dropdown-item.is-current { box-shadow: inset 3px 0 0 var(--gs-accent); }"],
    ["your own reaction with an accent border", ".gh-reaction.is-mine { border-color: var(--gs-accent); }"],
    ["an outer hard underline", ".nav-item.active { box-shadow: 0 2px 0 var(--gs-accent); }"],
    ["a 1px outer ring", ".gh-subtab.active { box-shadow: 0 0 0 1px var(--gs-accent); }"],
    ["a focus-ring token worn as a selection", ".gh-subtab.active { box-shadow: var(--ring); }"],
    ["a ::before at opacity 0 switched on by the state", ".nav-item::before { content: \"\"; position: absolute; left: 0; top: 6px; bottom: 6px; width: 3px; background: var(--gs-accent); opacity: 0; }\n.nav-item.active::before { opacity: 1; }"],
    ["a ::after scaled in by the state", ".term-tab::after { content: \"\"; position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--gs-accent); transform: scaleX(0); }\n.term-tab.active::after { transform: none; }"],
    ["a gradient stripe", ".term-side-row.active { background: linear-gradient(90deg, var(--gs-accent) 0 2px, var(--sel-fill) 2px); }"],
    ["a gradient sized to a sliver", ".cmdk-row.is-selected { background: linear-gradient(var(--gs-accent), var(--gs-accent)) left / 3px 100% no-repeat; }"],
    ["a switch's accent border", ".dc-toggle[aria-checked=\"true\"] { border-color: var(--gs-accent); }"],
    ["a child made into a bar", ".gh-subtab.active .gh-subtab-bar { height: 2px; background: var(--gs-accent); }"],
    ["a child bar the state switches on", ".gh-subtab-bar { height: 2px; background: var(--gs-accent); opacity: 0; }\n.gh-subtab.active .gh-subtab-bar { opacity: 1; }"],
    ["an accent outline", ".review-verdict.is-selected { outline: 1px solid var(--gs-accent); outline-offset: -1px; }"],
    ["an underline", ".gh-subtab.active { text-decoration: underline 2px var(--gs-accent); }"],
    ["a list cursor's left bar", ".row.focused { border-left: 2px solid var(--gs-accent); }"],
    ["a checked item's side rule", ".opt.checked { border-left: 2px solid var(--gs-accent); }"],
    ["a label beside a checked input, lined", "input:checked + .opt-label { border-bottom: 2px solid var(--gs-accent); }"],
    ["a row holding a checked box, lined", ".opt-row:has(input:checked) { box-shadow: inset 2px 0 0 var(--gs-accent); }"],
    ["a selected row's bar that shows on hover", ".file-row.active:hover { box-shadow: inset 2px 0 0 var(--gs-accent); }"],
    ["an aria-current link underlined", ".crumb[aria-current=\"page\"] { text-decoration-line: underline; }"],
    // The second review's: each passed this guard (and some the harness too).
    ["an inset bar blurred 2px", ".cmdk-row.is-selected { box-shadow: inset 3px 0 2px 0 var(--gs-accent), var(--sel-glow-soft); }"],
    ["a file row's blurred bar", ".dc-file.is-selected { box-shadow: inset 3px 0 2px 0 var(--gs-accent); }"],
    ["a bar the base rule draws from a property the state sets", ".term-side-row { box-shadow: inset var(--rv-bar, 0px) 0 0 var(--gs-accent); }\n.term-side-row.active { --rv-bar: 3px; }"],
    ["a drop-shadow filter underline", ".gh-seg-btn.active { filter: drop-shadow(0 2px 0 var(--gs-accent)); }"],
    ["a search hit's bar", ".log-line.is-hit { box-shadow: inset 3px 0 0 var(--gs-accent); }"],
    ["an open picker's underline", ".gh-picker[aria-expanded=\"true\"] { box-shadow: inset 0 -2px 0 var(--gs-accent); }"],
    ["an open group's side border", ".repo-group.is-open { border-left: 2px solid var(--gs-accent); }"],
    ["a BEM modifier's underline", ".gh-tab--active { border-bottom: 2px solid var(--gs-accent); }"],
    ["a full-size overlay's border side", ".gh-subtab { position: relative; }\n.gh-subtab.active::after { content: \"\"; position: absolute; inset: 0; border-bottom: 2px solid var(--gs-accent); pointer-events: none; }"],
    ["a full-size overlay's inset bar", ".cmdk-row.is-selected::before { content: \"\"; position: absolute; inset: 0; box-shadow: inset 3px 0 0 var(--gs-accent); }"],
  ];
  for (const [what, css] of shapes) {
    assert.ok(selectionLines(TOKENS + css).length > 0, `not seen: ${what}\n  ${css}`);
  }
  // …and does not cry wolf at what is not a selection mark, or not a line.
  const fine: [string, string][] = [
    ["a drag insertion marker", ".repo-tab.is-active.drop-before { box-shadow: inset 2px 0 0 var(--gs-accent); }"],
    ["a drop target", ".gh-col.is-drop { outline: 2px dashed var(--gs-accent); }"],
    ["a keyboard focus ring", ".gh-subtab.active:focus-visible { outline: 2px solid var(--gs-accent); }"],
    ["a native checkbox's own box", ".dc-ck:checked { border-color: var(--gs-accent); background: var(--gs-accent); }"],
    ["the unselected state", ".repo-tab:not(.is-active) { border-bottom: 1px solid #333; }"],
    ["a tint and a glow", ".gh-subtab.active { background: var(--sel-fill); box-shadow: 0 0 12px -5px color-mix(in srgb, var(--gs-accent) 60%, transparent); }"],
    ["the lit-from-above sheen", ".dc-toggle.is-on { box-shadow: var(--sheen); }"],
    ["a soft wash", ".nav-item.active { background: linear-gradient(180deg, color-mix(in srgb, var(--gs-accent) 22%, transparent), color-mix(in srgb, var(--gs-accent) 15%, transparent)); }"],
    ["a check mark glyph", ".menu-item.is-on::after { content: \"✓\"; opacity: 1; }"],
    ["a knockout halo in the row's own fill", ".rb-row.is-selected .rb-node { box-shadow: 0 0 0 3px var(--app-active); }"],
    ["a soft lift", ".gh-seg-btn.active { box-shadow: 0 1px 3px color-mix(in srgb, var(--gs-accent) 32%, transparent), 0 0 12px -3px color-mix(in srgb, var(--gs-accent) 60%, transparent); }"],
    ["a soft drop-shadow filter", ".gh-seg-btn.active { filter: drop-shadow(0 2px 6px rgba(0, 0, 0, 0.4)); }"],
    ["a soft inset glow", ".rb-set.is-current { box-shadow: inset 0 0 10px -3px color-mix(in srgb, var(--gs-accent) 55%, transparent); }"],
    ["a property the state sets that draws no line", ".row { background: var(--row-fill, transparent); }\n.row.selected { --row-fill: var(--sel-fill); }"],
  ];
  for (const [what, css] of fine) {
    assert.deepEqual(selectionLines(TOKENS + css), [], `flagged, but ${what} is not a selection line\n  ${css}`);
  }
});

/** One theme's custom properties: :root, then body, then body.vscode-<theme>. */
function themeTokens(css: string, theme: "dark" | "light"): Map<string, string> {
  const out = new Map<string, string>();
  for (const sel of [":root", "body", `body.vscode-${theme}`]) {
    for (const r of rules(css)) {
      if (r.selector.trim() !== sel) continue;
      for (const [name, value] of decls(r.body)) if (name.startsWith("--")) out.set(name, value);
    }
  }
  return out;
}

type Rgba = { r: number; g: number; b: number; a: number };

/** A colour value — hex, rgb(), transparent, color-mix(in srgb, …) — or null. */
function colourOf(v: string, defs: Map<string, string>, depth = 0): Rgba | null {
  const s = v.trim();
  if (depth > 8) return null;
  const vm = /^var\(\s*(--[\w-]+)\s*(?:,(.*))?\)$/.exec(s);
  if (vm) {
    const d = defs.get(vm[1]) ?? vm[2];
    return d === undefined ? null : colourOf(d, defs, depth + 1);
  }
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  const hex = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (hex) {
    let x = hex[1];
    if (x.length <= 4) x = [...x].map((c) => c + c).join("");
    const n = [0, 2, 4, 6].map((i) => parseInt(x.slice(i, i + 2) || "ff", 16) / 255);
    return { r: n[0], g: n[1], b: n[2], a: n[3] };
  }
  const rgb = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)$/.exec(s);
  if (rgb) return { r: +rgb[1] / 255, g: +rgb[2] / 255, b: +rgb[3] / 255, a: rgb[4] === undefined ? 1 : +rgb[4] };
  const mix = /^color-mix\(\s*in srgb\s*,([\s\S]*)\)$/.exec(s);
  if (mix) {
    const [a, b] = topLevel(mix[1]);
    if (b === undefined) return null;
    const part = (t: string): [string, number | null] => {
      const m = /^([\s\S]*?)\s+([\d.]+)%$/.exec(t.trim());
      return m ? [m[1], +m[2] / 100] : [t.trim(), null];
    };
    const [ca, pa] = part(a);
    const [cb, pb] = part(b);
    const x = colourOf(ca, defs, depth + 1);
    const y = colourOf(cb, defs, depth + 1);
    if (!x || !y) return null;
    const p = pa ?? (pb === null ? 0.5 : 1 - pb);
    const q = pb ?? 1 - p;
    const alpha = x.a * p + y.a * q;
    if (!alpha) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k: "r" | "g" | "b"): number => (x[k] * x.a * p + y[k] * y.a * q) / alpha;
    return { r: ch("r"), g: ch("g"), b: ch("b"), a: alpha };
  }
  return null;
}

/**
 * "Hovering a selected thing deepens it" — the hover block's own contract.
 * The Go-to-file cursor was raised to --sel-fill-strong (28% dark) while its
 * hover stayed at the list's 26%, so the row the keyboard was on went LIGHTER
 * under the pointer in dark, and did nothing in light. Every selected state's
 * :hover fill is compared with its resting fill, per theme, composited over
 * that theme's raised surface: the hover has to stand further from it, by a
 * step you can see (2% more contrast against it — 25% → 26% is not one).
 */
test("hovering a selected thing deepens its fill, never lightens it", () => {
  const all = rules(CSS);
  const bad: string[] = [];
  for (const theme of ["dark", "light"] as const) {
    const defs = themeTokens(CSS, theme);
    const ground = colourOf("var(--app-elevated)", defs);
    assert.ok(ground, `${theme} declares --app-elevated`);
    const other = theme === "dark" ? "light" : "dark";
    // The winning background per selector: a theme-prefixed rule outranks a
    // plain one; among equals the later one wins.
    const bg = new Map<string, { value: string; rank: number; line: number }>();
    for (const r of all) {
      const value = [...decls(r.body)].reverse().find(([n]) => n === "background" || n === "background-color")?.[1];
      if (!value) continue;
      for (const raw of topLevel(r.selector).map((p) => p.trim())) {
        if (raw.startsWith(`body.vscode-${other} `)) continue;
        const prefixed = raw.startsWith(`body.vscode-${theme} `);
        const sel = prefixed ? raw.slice(`body.vscode-${theme} `.length) : raw;
        const rank = prefixed ? 1 : 0;
        const had = bg.get(sel);
        if (!had || rank >= had.rank) bg.set(sel, { value, rank, line: r.line });
      }
    }
    for (const [sel, hover] of bg) {
      if (!sel.endsWith(":hover")) continue;
      const restSel = sel.slice(0, -":hover".length);
      if (!isState(restSel) || notSelection(restSel)) continue;
      const rest = bg.get(restSel);
      if (!rest) continue;
      const h = colourOf(hover.value, defs);
      const r = colourOf(rest.value, defs);
      if (!h || !r || !ground) continue;
      const on = (c: Rgba): Rgba => ({
        r: c.r * c.a + ground.r * (1 - c.a),
        g: c.g * c.a + ground.g * (1 - c.a),
        b: c.b * c.a + ground.b * (1 - c.a),
        a: 1,
      });
      // How far it stands from the surface, as a contrast ratio: deeper is
      // lighter on dark and darker on light, whatever the hue does.
      const lum = (c: Rgba): number => {
        const lin = (v: number): number => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
      };
      const away = (c: Rgba): number => {
        const x = lum(on(c)) + 0.05;
        const y = lum(ground) + 0.05;
        return x > y ? x / y : y / x;
      };
      if (away(h) < away(r) * 1.02) {
        bad.push(`${theme}: ${sel} (app.css:${hover.line}, ${hover.value}) is no deeper than ${restSel} (app.css:${rest.line}, ${rest.value})`);
      }
    }
  }
  assert.deepEqual(bad, [], `a selected thing lightens (or stays put) under the pointer:\n  ${bad.join("\n  ")}`);
});

/** The replacement exists, so the rule above cannot pass by painting nothing. */
test("the selected state has a tint, a glow and an ink in both themes", () => {
  const css = CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const theme of ["dark", "light"]) {
    const block = new RegExp(`body\\.vscode-${theme}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(css)?.[1] ?? "";
    for (const token of ["--sel-fill", "--sel-fill-strong", "--sel-glow", "--sel-glow-soft", "--sel-ink"]) {
      assert.match(block, new RegExp(`${token}\\s*:[^;]*gs-accent`), `${theme} declares ${token} from the accent`);
    }
  }
});
