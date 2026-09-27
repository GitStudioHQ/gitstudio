import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const CSS = readFileSync(resolve(HERE, "../src/renderer/styles/app.css"), "utf8");

type Rule = { selector: string; body: string; line: number };

/** Every plain style rule in the sheet, @media/@supports bodies included. */
function rules(css: string): Rule[] {
  // Comments blanked, not removed, so a rule keeps its line number.
  const s = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out: Rule[] = [];
  const walk = (start: number, end: number): void => {
    let i = start;
    let from = start;
    while (i < end) {
      const c = s[i];
      if (c === ";") from = i + 1;
      if (c !== "{") {
        i++;
        continue;
      }
      const selector = s.slice(from, i).trim();
      let depth = 1;
      let j = i + 1;
      while (j < end && depth) {
        if (s[j] === "{") depth++;
        else if (s[j] === "}") depth--;
        j++;
      }
      const body = s.slice(i + 1, j - 1);
      if (/^@(keyframes|font-face)/.test(selector)) {
        // not style rules
      } else if (selector.startsWith("@") || body.includes("{")) {
        walk(i + 1, j - 1);
      } else {
        out.push({ selector, body, line: s.slice(0, i).split("\n").length });
      }
      i = j;
      from = j;
    }
  };
  walk(0, s.length);
  return out;
}

/** A value split at its top-level commas (not inside a colour or a :not()). */
function topLevel(v: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of v) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** A complex selector's compound selectors, combinators dropped. */
function compounds(sel: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of sel) {
    if (ch === "(" || ch === "[") depth++;
    if (ch === ")" || ch === "]") depth--;
    if (depth === 0 && /[\s>+~]/.test(ch)) {
      if (cur) out.push(cur);
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A declaration block as [name, value] pairs, whitespace collapsed. */
function decls(body: string): [string, string][] {
  return body
    .split(";")
    .map((d) => d.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .map((d) => {
      const [prop, ...rest] = d.split(":");
      return [prop.trim(), rest.join(":").replace(/\s*!important$/, "").trim()] as [string, string];
    });
}

/** Removes every :not(…) — `.tab:not(.is-active)` names the UNselected state. */
function withoutNot(s: string): string {
  let out = s;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/:not\([^()]*\)/g, "");
  }
  return out;
}

/**
 * The selected states: a class, or what aria says. `.is-mine` (your own
 * reaction), `.focused` (a list's cursor row), `.checked`, and a switch's
 * `[aria-checked]` are states too; so is anything derived from `:checked` —
 * `input:checked + label`, `.row:has(:checked)` — though a native checkbox's
 * OWN `:checked` box (the subject itself) is its glyph, not a selection mark.
 */
const STATE =
  /\.(active|is-active|is-selected|is-sel|selected|is-current|current|is-on|row-landed|is-currentHead|is-mine|focused|checked|is-checked)(?![\w-])|\[aria-(selected|current|pressed|checked)(?!\s*=\s*["']?false)/;

function isState(part: string): boolean {
  const s = withoutNot(part);
  if (STATE.test(s)) return true;
  if (/:has\([^)]*:checked/.test(s)) return true;
  const cs = compounds(s);
  return cs.slice(0, -1).some((c) => /:checked\b/.test(c));
}

/**
 * Not a selection: keyboard focus (`:focus-visible` rings are accessibility),
 * the pressed `:active` flash, and drag-and-drop insertion markers. A drag or
 * drop marker is a class with "drag" or "drop" as a WHOLE hyphen-separated
 * word — `.drop-before`, `.drag-over`, `.is-dragging`, `.dc-stash-drop` — and
 * never `.dropdown-item`, whose current row is a selection like any other. The
 * rebase verb classes `.a-drop`/`.g-drop` name an action, not a drag.
 */
function notSelection(part: string): boolean {
  const s = withoutNot(part);
  if (/:(focus|focus-visible|focus-within)(?![\w-])/.test(s)) return true;
  if (/:active(?![\w-])/.test(s.replace(/\.[\w-]+/g, ""))) return true;
  for (const m of s.matchAll(/\.([\w-]+)/g)) {
    const cls = m[1];
    if (cls === "a-drop" || cls === "g-drop") continue;
    if (cls.split("-").some((w) => /^(drag|dragging|dragged|drop|dropping)$/.test(w))) return true;
  }
  return false;
}

/** Custom property definitions, every theme's, for var() resolution. */
function tokens(css: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rules(css)) {
    for (const [name, value] of decls(r.body)) {
      if (!name.startsWith("--")) continue;
      out.set(name, [...(out.get(name) ?? []), value]);
    }
  }
  return out;
}

/** A value with its var()s substituted — one variant per definition, capped. */
function resolveVars(value: string, defs: Map<string, string[]>, depth = 0): string[] {
  const m = /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\([^()]*\))*))?\)/.exec(value);
  if (!m || depth > 6) return [value];
  const found = defs.get(m[1]);
  const choices = found?.length ? found : m[2] !== undefined ? [m[2].trim()] : [`unresolved(${m[1]})`];
  const out: string[] = [];
  for (const c of choices.slice(0, 4)) {
    for (const v of resolveVars(value.slice(0, m.index) + c + value.slice(m.index + m[0].length), defs, depth + 1)) {
      out.push(v);
      if (out.length >= 24) return out;
    }
  }
  return out;
}

/** Has a hue: the accent, a status colour, currentColor — rather than a grey. */
function hued(v: string): boolean {
  if (/currentcolor/i.test(v)) return true;
  if (/unresolved\(--[\w-]*(accent|status|danger|warn|brand|focus|amber)/.test(v)) return true;
  for (const h of v.matchAll(/#([0-9a-f]{3,8})\b/gi)) {
    let x = h[1];
    if (x.length <= 4) x = [...x].map((c) => c + c).join("");
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(x.slice(i, i + 2), 16) / 255);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 0.08) return true;
  }
  for (const c of v.matchAll(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/g)) {
    const [r, g, b] = [c[1], c[2], c[3]].map((n) => Number(n) / 255);
    if (Math.max(r, g, b) - Math.min(r, g, b) > 0.08) return true;
  }
  return false;
}

/** Paints nothing: none, zero, transparent. */
const nothing = (v: string): boolean => /^(none|0|0px|transparent|initial|unset)$/.test(v.trim());

/** The lengths in a value with its colours (and their parentheses) cut out. */
function lengths(v: string): number[] {
  let bare = v.replace(/#[0-9a-f]{3,8}\b/gi, "").replace(/\b(transparent|currentcolor|white|black)\b/gi, "");
  for (let prev = ""; prev !== bare; ) {
    prev = bare;
    bare = bare.replace(/[a-z-]+\([^()]*\)/gi, "");
  }
  return (bare.match(/-?[\d.]+(px|em|rem)?/g) ?? []).map((x) => parseFloat(x));
}

/** A box-shadow list's lines: bars, rings, and hard outer rules. */
function shadowLines(value: string): string[] {
  const out: string[] = [];
  for (const s of topLevel(value)) {
    if (nothing(s)) continue;
    const inset = /\binset\b/.test(s);
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths(s.replace(/\binset\b/, ""));
    const hard = blur <= 1;
    if (!hard || (!x && !y && !spread)) continue;
    // A neutral 1px sheen or lift — the "lit from above" bevel a raised
    // surface wears — is not a mark; a ring never is exempt.
    if (!spread && Math.max(Math.abs(x), Math.abs(y)) <= 1 && !hued(s)) continue;
    if (inset && (x || y)) out.push(`an inset bar (${s.trim()})`);
    else if (inset) out.push(`an inset ring (${s.trim()})`);
    else if (x || y) out.push(`a hard outer line (${s.trim()})`);
    else out.push(`an outer ring (${s.trim()})`);
  }
  return out;
}

/** A gradient drawn as a bar: a hard stop, or sized to a sliver. */
function gradientLine(value: string, size = ""): string {
  if (!/gradient\(/.test(value) || !hued(value)) return "";
  // background-size, or the "/ size" inside a background shorthand.
  const sizes = [size, ...[...value.matchAll(/\/\s*((?:-?[\d.]+(?:px|%)|auto)(?:\s+(?:-?[\d.]+(?:px|%)|auto))?)/g)].map((m) => m[1])];
  for (const sz of sizes) {
    if ((sz.match(/[\d.]+px/g) ?? []).some((n) => parseFloat(n) > 0 && parseFloat(n) <= 4)) return `a gradient sized to a sliver (${sz})`;
  }
  for (const g of value.matchAll(/gradient\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)) {
    const stops: { col: string; at: string }[] = [];
    for (const part of topLevel(g[1])) {
      const col = (/(color-mix\((?:[^()]|\([^()]*\))*\)|rgba?\([^)]*\)|#[0-9a-f]{3,8}\b|transparent|unresolved\([^)]*\)|currentcolor)/i.exec(part) ?? [""])[0];
      if (!col) continue;
      const pos = part.replace(col, "").match(/-?[\d.]+(px|%)?/g) ?? [];
      for (const at of pos.length ? pos : [""]) stops.push({ col, at });
    }
    for (let i = 1; i < stops.length; i++) {
      const a = stops[i - 1];
      const b = stops[i];
      if (!a.at || !b.at || a.col === b.col) continue;
      const unit = (x: string): string => (x.endsWith("%") ? "%" : "px");
      if (unit(a.at) !== unit(b.at) && parseFloat(a.at) && parseFloat(b.at)) continue;
      if (Math.abs(parseFloat(b.at) - parseFloat(a.at)) <= (unit(b.at) === "%" ? 1 : 2)) {
        return `a gradient with a hard stop at ${b.at} (${g[0].slice(0, 90)})`;
      }
    }
  }
  return "";
}

const THIN = /^(width|height|min-width|min-height|max-width|max-height|block-size|inline-size|flex-basis)$/;
const thin = (d: [string, string][]): boolean =>
  d.some(([n, v]) => THIN.test(n) && /^[\d.]+px$/.test(v) && parseFloat(v) > 0 && parseFloat(v) <= 4);
const painted = (d: [string, string][], defs: Map<string, string[]>): boolean =>
  d.some(
    ([n, v]) =>
      /^(background|background-color|background-image|border(-[a-z]+)*)$/.test(n) &&
      !nothing(v) &&
      resolveVars(v, defs).some((x) => hued(x) || /gradient\(/.test(x)),
  );
const REVEALS = /^(opacity|display|visibility|transform|scale|width|height|background|background-color|background-image|clip-path|inset|top|right|bottom|left)$/;

/**
 * Every line a stylesheet draws on a selected, active or current state, as
 * "app.css:<line> <selector> — <why>". Exported shape for the tests below.
 */
function selectionLines(css: string): string[] {
  const defs = tokens(css);
  const all = rules(css);
  const found: string[] = [];
  // Base rules by the first class of their subject — what a state rule on a
  // descendant or a pseudo-element may be switching on.
  const base = new Map<string, [string, string][]>();
  for (const r of all) {
    for (const p of topLevel(r.selector).map((x) => x.trim())) {
      if (isState(p)) continue;
      const subj = compounds(p).at(-1) ?? "";
      const key = (/\.[\w-]+/.exec(subj)?.[0] ?? "") + (/::?(before|after)\b/.exec(subj)?.[0].replace(/^:+/, "::") ?? "");
      if (!key) continue;
      base.set(key, [...(base.get(key) ?? []), ...decls(r.body)]);
    }
  }
  for (const r of all) {
    const parts = topLevel(r.selector)
      .map((p) => p.trim())
      .filter((p) => isState(p) && !notSelection(p));
    if (!parts.length) continue;
    const d = decls(r.body);
    const why = new Set<string>();
    for (const p of parts) {
      const cs = compounds(withoutNot(p));
      const subj = cs.at(-1) ?? "";
      const subjectIsState = STATE.test(subj) || /\[aria-(selected|current|pressed|checked)/.test(subj);
      const pseudo = /::?(before|after)\b/.test(subj);
      // A native checkbox's own box (`input:checked`, `.dc-ck:checked::after`)
      // is its glyph.
      const own = subj.replace(/:has\((?:[^()]|\([^()]*\))*\)/g, "");
      if (/:(checked|indeterminate)\b/.test(own) && !subjectIsState) continue;
      for (const [name, value] of d) {
        if (name.startsWith("--")) continue;
        const variants = resolveVars(value, defs);
        if (name === "box-shadow") {
          // A ring in a SURFACE colour is a knockout — the rebase node's halo
          // in its row's own fill, cutting the rail under it — not a mark.
          const marks = topLevel(value).filter((sh) => !/^[^()]*var\(--app-(bg|panel|elevated|active|hover)\)\s*$/.test(sh.trim()));
          for (const v of resolveVars(marks.join(","), defs)) for (const l of shadowLines(v)) why.add(l);
        } else if (/^border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color|-width|-style)?$/.test(name) && !nothing(value)) {
          why.add(`a border (${name}: ${value})`);
        } else if (name === "border-image" && !nothing(value)) {
          why.add(`a border image (${value})`);
        } else if (/^outline(-color|-width|-style)?$/.test(name) && !nothing(value) && !/^(none|0)\b/.test(value) && !(/transparent/.test(value) && !hued(value))) {
          why.add(`an outline (${name}: ${value})`);
        } else if (/^text-decoration(-line)?$/.test(name) && /underline|overline/.test(value)) {
          why.add(`a line under or over its text (${name}: ${value})`);
        } else if (/^background(-image)?$/.test(name)) {
          const size = d.find(([n]) => n === "background-size")?.[1] ?? "";
          for (const v of variants) {
            const g = gradientLine(v, size);
            if (g) why.add(g);
          }
        } else if (name === "background-size" && d.some(([n, v]) => /^background(-image)?$/.test(n) && /gradient/.test(v))) {
          if ((value.match(/[\d.]+px/g) ?? []).some((n) => parseFloat(n) > 0 && parseFloat(n) <= 4)) why.add(`a gradient sized to a sliver (${value})`);
        }
      }
      // A ::before/::after switched on by the state: a strip, unless it is a
      // text glyph (a check mark's content is a character).
      if (pseudo) {
        const key = (/\.[\w-]+/.exec(subj.replace(STATE, ""))?.[0] ?? "") + (/::?(before|after)\b/.exec(subj)?.[0].replace(/^:+/, "::") ?? "");
        const merged = [...(base.get(key) ?? []), ...d];
        const content = [...merged].reverse().find(([n]) => n === "content")?.[1] ?? "";
        const glyph = /^["'].*\S.*["']$/.test(content);
        // What draws or moves it; hiding it (display: none, opacity: 0) is fine.
        const hides = ([n, v]: [string, string]): boolean =>
          (n === "display" && v === "none") || (n === "visibility" && v === "hidden") || (n === "opacity" && parseFloat(v) === 0) || (n === "content" && nothing(v));
        const reveals = d.filter((x) => !hides(x) && (REVEALS.test(x[0]) || x[0] === "content" || /^border/.test(x[0])));
        if (!glyph && reveals.length) {
          why.add(`a ::before/::after it switches on (${reveals.map(([n, v]) => `${n}: ${v}`).join("; ")})`);
        }
      } else if (!subjectIsState) {
        // A part of the selected thing made into a bar: thin and painted,
        // here or in its base rule, and switched on or painted here.
        const key = /\.[\w-]+/.exec(subj)?.[0] ?? "";
        const merged = [...(base.get(key) ?? []), ...d];
        if (thin(merged) && painted(merged, defs) && d.some(([n]) => REVEALS.test(n) || /^border/.test(n))) {
          why.add(`a child bar (${d.map(([n, v]) => `${n}: ${v}`).join("; ")})`);
        }
      }
    }
    for (const w of why) found.push(`app.css:${r.line} ${parts.join(", ")} — ${w}`);
  }
  return found;
}

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
