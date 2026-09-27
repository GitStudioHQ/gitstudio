// The owner's rule, read off a stylesheet: nothing selected, active, current,
// open or matched is marked with a LINE. That means no bar down an edge (an
// inset box-shadow, blurred or not; a border side; a ::before/::after strip; a
// child made two pixels wide; a gradient with a hard stop), no rule on top, no
// underline (a text-decoration, a hard outer shadow, a drop-shadow filter), and
// no ring or accent outline. A selected thing is LIT instead: a tinted fill,
// and a soft glow on a pill, a tab or a button.
//
// The runtime sweeps (the desktop harness's selectionLines(), and
// selectionProbe.js for the shared components and the extension's webviews)
// measure what their scenes reach. This reads the sheets, so a surface no
// scene reaches cannot grow a line back unseen. Three guards use it:
// apps/desktop/test/selectionIsLit.test.ts (app.css), and the
// selectionIsLitStatic tests of packages/webview-ui and apps/extension (their
// stylesheets, css`` templates and inline <style> blocks).
//
// What is NOT a selected state stays out of it: keyboard focus
// (`:focus-visible` rings are accessibility), drag-and-drop insertion markers,
// a native checkbox's own `:checked` box, and status colours whose selectors
// name no state. Hover is NOT exempt: the selected row under the pointer is
// still the selected row. In a webview a High Contrast theme paints no fills,
// so there VS Code's whole ring (an outline, a border all round) is the mark;
// a single side or a bar is still a line.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

export type Rule = { selector: string; body: string; line: number };

/** Every plain style rule in a sheet, @media/@supports bodies included. */
export function rules(css: string): Rule[] {
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
      if (/^@(keyframes|font-face|-webkit-keyframes)/.test(selector)) {
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
export function topLevel(v: string): string[] {
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
export function compounds(sel: string): string[] {
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
export function decls(body: string): [string, string][] {
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
export function withoutNot(s: string): string {
  let out = s;
  for (let prev = ""; prev !== out; ) {
    prev = out;
    out = out.replace(/:not\([^()]*\)/g, "");
  }
  return out;
}

/**
 * The selected states: a class, or what aria says. `.is-mine` (your own
 * reaction), `.focused` (a list's cursor row), `.checked`, `.is-open` (the row
 * whose submenu is open), `.is-hit`, `.is-match` and `.is-cursor` (a search's
 * results), `.on`/`.sel` (the webviews' short forms), a switch's
 * `[aria-checked]`, an open trigger's `[aria-expanded]`, a pressed toggle
 * (`.jb-toggled`) and a BEM modifier (`.gh-tab--active`) are states too; so
 * is anything derived from `:checked` — `input:checked + label`,
 * `.row:has(:checked)` — though a native checkbox's OWN `:checked` box (the
 * subject itself) is its glyph, not a selection mark.
 */
export const STATE =
  /\.(active|is-active|is-selected|is-sel|selected|is-current|current|is-on|row-landed|is-currentHead|is-mine|focused|checked|is-checked|is-open|is-hit|is-match|is-cursor|is-checked-out|on|sel|scoped)(?![\w-])|\.[\w-]+--(active|selected|current|on|open|checked)(?![\w-])|\.(?:[\w-]+-)?toggled(?![\w-])|\[aria-(selected|current|pressed|checked|expanded)(?!\s*=\s*["']?false)/;

export function isState(part: string): boolean {
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
export function notSelection(part: string): boolean {
  const s = withoutNot(part);
  if (/:(focus|focus-visible|focus-within)(?![\w-])/.test(s)) return true;
  if (/:active(?![\w-])/.test(s.replace(/\.[\w-]+/g, ""))) return true;
  for (const m of s.matchAll(/\.([\w-]+)/g)) {
    const cls = m[1];
    if (cls === "a-drop" || cls === "g-drop") continue;
    if (cls.split("-").some((w) => /^(drag|dragging|dragged|drop|dropping|over-before|over-after)$/.test(w))) return true;
  }
  if (/\.(over-before|over-after)(?![\w-])/.test(s)) return true;
  return false;
}

/** Custom property definitions, every theme's, for var() resolution. */
export function tokens(all: Rule[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of all) {
    for (const [name, value] of decls(r.body)) {
      if (!name.startsWith("--")) continue;
      out.set(name, [...(out.get(name) ?? []), value]);
    }
  }
  return out;
}

/** A value with its var()s substituted — one variant per definition, capped. */
export function resolveVars(value: string, defs: Map<string, string[]>, depth = 0): string[] {
  const m = /var\(\s*(--[\w-]+)\s*(?:,((?:[^()]|\((?:[^()]|\([^()]*\))*\))*))?\)/.exec(value);
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
export function hued(v: string): boolean {
  if (/currentcolor/i.test(v)) return true;
  if (/unresolved\(--[\w-]*(accent|status|danger|warn|brand|focus|amber|link|charts|error|highlight|sel)/i.test(v)) return true;
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
export const nothing = (v: string): boolean => /^(none|0|0px|transparent|initial|unset|inherit)$/.test(v.trim());

/** The lengths in a value with its colours (and their parentheses) cut out. */
function lengths(v: string): number[] {
  let bare = v.replace(/#[0-9a-f]{3,8}\b/gi, "").replace(/\b(transparent|currentcolor|white|black)\b/gi, "");
  for (let prev = ""; prev !== bare; ) {
    prev = bare;
    bare = bare.replace(/[a-z-]+\([^()]*\)/gi, "");
  }
  return (bare.match(/-?[\d.]+(px|em|rem)?/g) ?? []).map((x) => parseFloat(x));
}

/**
 * What one shadow draws: "bar" (an inset band down a side), "rule" (an outer
 * band beyond a side), "ring" (a hard band all round), or "" (a glow, a soft
 * lift, the neutral 1px sheen a raised surface wears). A band is a line while
 * its blur is narrower than it would take to dissolve it: an inset 3px bar
 * blurred 2px is still a bar.
 */
export function shadowKind(s: { inset: boolean; x: number; y: number; blur: number; spread: number; hued: boolean }): string {
  const off = Math.max(Math.abs(s.x), Math.abs(s.y));
  if (off > 0) {
    if (off <= 1 && s.spread <= 0 && !s.hued) return "";
    if (s.inset) {
      const band = off + Math.min(s.spread, 0);
      return band >= 0.5 && s.blur < 3 * band + 4 ? "bar" : "";
    }
    const band = off + s.spread;
    return band >= 1 && s.blur < band ? "rule" : "";
  }
  if (s.spread > 0 && s.spread < 8 && s.blur < 2 * s.spread + 1.5) return "ring";
  return "";
}

/** A box-shadow list's lines: bars, rings, and hard outer rules. */
export function shadowLines(value: string, opts: { rings?: boolean } = {}): string[] {
  const out: string[] = [];
  for (const s of topLevel(value)) {
    if (nothing(s) || /^\s*(none|transparent)\s*$/.test(s)) continue;
    if (/\btransparent\b/.test(s) && !hued(s.replace(/transparent/g, ""))) {
      // A shadow in transparent (a declared-but-off slot) paints nothing.
      const col = s.replace(/-?[\d.]+(px|em|rem)?|\binset\b/g, "").trim();
      if (/^transparent$/.test(col)) continue;
    }
    const inset = /\binset\b/.test(s);
    const [x = 0, y = 0, blur = 0, spread = 0] = lengths(s.replace(/\binset\b/, ""));
    const k = shadowKind({ inset, x, y, blur, spread, hued: hued(s) });
    if (!k || (k === "ring" && opts.rings)) continue;
    if (k === "bar") out.push(`an inset bar (${s.trim()})`);
    else if (k === "rule") out.push(`a hard outer line (${s.trim()})`);
    else out.push(`${inset ? "an inset" : "an outer"} ring (${s.trim()})`);
  }
  return out;
}

/** The lines a filter's drop-shadow()s draw: a hard one under a thing is an underline. */
export function dropShadowLines(value: string): string[] {
  const out: string[] = [];
  for (const m of value.matchAll(/drop-shadow\(((?:[^()]|\((?:[^()]|\([^()]*\))*\))*)\)/g)) {
    const [x = 0, y = 0, blur = 0] = lengths(m[1]);
    const k = shadowKind({ inset: false, x, y, blur, spread: 0, hued: hued(m[1]) });
    if (k) out.push(`a ${k} drawn by a filter (${m[0]})`);
  }
  return out;
}

/** A gradient drawn as a bar: a hard stop, or sized to a sliver. */
export function gradientLine(value: string, size = ""): string {
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
const LINE_PROPS = /^(box-shadow|filter|outline(-color|-width|-style)?|text-decoration(-line)?|border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color|-width|-style)?|background(-image)?)$/;

export interface Options {
  /** The file the rules came from, for the report ("app.css"). */
  label?: string;
  /** A shadow item in a SURFACE colour is a knockout (a node's halo in its row's own fill), not a mark. */
  surface?: RegExp;
  /** A webview: in a High Contrast rule, VS Code's whole ring (an outline, a border all round, a ring) is the mark. */
  hcWholeRings?: boolean;
}

/**
 * The lines one declaration draws, every variant of its var()s considered.
 * `hc`: the declaration is in a High Contrast rule of a webview, where whole
 * rings are allowed.
 */
function declLines(
  name: string,
  value: string,
  all: [string, string][],
  defs: Map<string, string[]>,
  opts: Options,
  hc: boolean,
  grounds: string[] = [],
): string[] {
  const why = new Set<string>();
  const variants = resolveVars(value, defs);
  if (name === "box-shadow") {
    // A ring in a surface colour, or in the very fill the selected thing
    // wears (a node's halo in its row's own tint), is a knockout: it cuts
    // what runs under the part and shows as nothing on the row.
    const knockout = (sh: string): boolean =>
      (!!opts.surface && opts.surface.test(sh.trim())) || grounds.some((g) => sh.trim().endsWith(" " + g));
    const marks = topLevel(value).filter((sh) => !knockout(sh));
    for (const v of resolveVars(marks.join(","), defs)) for (const l of shadowLines(v, { rings: hc })) why.add(l);
  } else if (name === "filter") {
    for (const v of variants) for (const l of dropShadowLines(v)) why.add(l);
  } else if (/^border(-(top|right|bottom|left|block|inline)(-start|-end)?)?(-color|-width|-style)?$/.test(name) && !nothing(value)) {
    const whole = /^border(-color|-width|-style)?$/.test(name);
    if (!(hc && whole) && !variants.every((v) => /^(none|0|0px|transparent)\b|\btransparent\s*$|^\S+\s+\S+\s+transparent$/.test(v.trim()))) {
      why.add(`a border (${name}: ${value})`);
    }
  } else if (name === "border-image" && !nothing(value)) {
    why.add(`a border image (${value})`);
  } else if (/^outline(-color|-width|-style)?$/.test(name) && !nothing(value) && !/^(none|0)\b/.test(value) && !(/transparent/.test(value) && !hued(value))) {
    if (!hc) why.add(`an outline (${name}: ${value})`);
  } else if (/^text-decoration(-line)?$/.test(name) && /underline|overline/.test(value)) {
    why.add(`a line under or over its text (${name}: ${value})`);
  } else if (/^background(-image)?$/.test(name)) {
    const size = all.find(([n]) => n === "background-size")?.[1] ?? "";
    for (const v of variants) {
      const g = gradientLine(v, size);
      if (g) why.add(g);
    }
  } else if (name === "background-size" && all.some(([n, v]) => /^background(-image)?$/.test(n) && /gradient/.test(v))) {
    if ((value.match(/[\d.]+px/g) ?? []).some((n) => parseFloat(n) > 0 && parseFloat(n) <= 4)) why.add(`a gradient sized to a sliver (${value})`);
  }
  return [...why];
}

/**
 * Every line a stylesheet draws on a selected, active, current, open or
 * matched state, as "<label>:<line> <selector> — <why>".
 */
export function selectionLines(css: string, opts: Options = {}): string[] {
  const label = opts.label ?? "css";
  const all = rules(css);
  const defs = tokens(all);
  // Base rules by the first class of their subject — what a state rule on a
  // descendant or a pseudo-element may be switching on — and the custom
  // properties the unselected states define (what a var() reads when the
  // state has not set it).
  const base = new Map<string, [string, string][]>();
  const baseRules: Rule[] = [];
  for (const r of all) {
    const plain = topLevel(r.selector).map((x) => x.trim()).filter((p) => !isState(p));
    if (plain.length) baseRules.push({ ...r, selector: plain.join(", ") });
    for (const p of plain) {
      const subj = compounds(p).at(-1) ?? "";
      const key = (/\.[\w-]+/.exec(subj)?.[0] ?? "") + (/::?(before|after)\b/.exec(subj)?.[0].replace(/^:+/, "::") ?? "");
      if (!key) continue;
      base.set(key, [...(base.get(key) ?? []), ...decls(r.body)]);
    }
  }
  const baseDefs = tokens(baseRules);
  // What each state's own compound is filled with (`.rb-row.is-selected` →
  // var(--rb-sel)), for the knockouts drawn in it.
  const fills = new Map<string, string[]>();
  for (const r of all) {
    const bg = [...decls(r.body)].reverse().find(([n]) => n === "background" || n === "background-color")?.[1];
    if (!bg) continue;
    for (const p of topLevel(r.selector).map((x) => x.trim())) {
      const subj = (compounds(withoutNot(p)).at(-1) ?? "").replace(/:hover$/, "");
      fills.set(subj, [...(fills.get(subj) ?? []), bg]);
    }
  }
  const baseDecls = baseRules.map((b) => ({ rule: b, decls: decls(b.body) }));
  const kinds = (ls: string[]): Set<string> => new Set(ls.map((l) => l.split(" (")[0]));
  const found: string[] = [];
  for (const r of all) {
    const parts = topLevel(r.selector)
      .map((p) => p.trim())
      .filter((p) => isState(p) && !notSelection(p));
    if (!parts.length) continue;
    const d = decls(r.body);
    const why = new Set<string>();
    for (const p of parts) {
      const hc = !!opts.hcWholeRings && /high-contrast/.test(p);
      const cs = compounds(withoutNot(p));
      const subj = cs.at(-1) ?? "";
      const subjectIsState = STATE.test(subj) || /\[aria-(selected|current|pressed|checked|expanded)/.test(subj);
      const pseudo = /::?(before|after)\b/.test(subj);
      const holder = [...cs].reverse().find((c) => STATE.test(c)) ?? "";
      const grounds = fills.get(holder.replace(/:hover$/, "")) ?? [];
      const key = (/\.[\w-]+/.exec(subj.replace(new RegExp(STATE.source, "g"), ""))?.[0] ?? /\.[\w-]+/.exec(subj)?.[0] ?? "") +
        (/::?(before|after)\b/.exec(subj)?.[0].replace(/^:+/, "::") ?? "");
      const mine = base.get(key) ?? [];
      // A native checkbox's own box (`input:checked`, `.dc-ck:checked::after`)
      // is its glyph.
      const own = subj.replace(/:has\((?:[^()]|\([^()]*\))*\)/g, "");
      if (/:(checked|indeterminate)\b/.test(own) && !subjectIsState) continue;
      for (const [name, value] of d) {
        if (name.startsWith("--")) {
          // A line switched on through a custom property the state sets: a
          // base rule's `box-shadow: inset var(--bar, 0) 0 0 accent` with the
          // state setting --bar: 3px. Only a line that is not there while the
          // property keeps its unselected value counts.
          const esc = name.replace(/-/g, "\\-");
          const uses = new RegExp(`var\\(\\s*${esc}(?![\\w-])`);
          const call = new RegExp(`var\\(\\s*${esc}\\s*(?:,((?:[^()]|\\([^()]*\\))*))?\\)`, "g");
          for (const b of baseDecls) {
            for (const [bn, bv] of b.decls) {
              if (!LINE_PROPS.test(bn) || !uses.test(bv)) continue;
              const before = kinds(declLines(bn, bv, b.decls, baseDefs, opts, false));
              for (const l of declLines(bn, bv.replace(call, value), b.decls, baseDefs, opts, hc)) {
                if (!before.has(l.split(" (")[0])) why.add(`${l} switched on through ${name}: ${value} (${label}:${b.rule.line} ${b.rule.selector.slice(0, 60)})`);
              }
            }
          }
          continue;
        }
        // The same declaration the unselected thing already wears (an avatar's
        // lane ring, restated for the selected row) is not a mark of the state.
        if (mine.some(([bn, bv]) => bn === name && bv === value)) continue;
        for (const l of declLines(name, value, d, defs, opts, hc, grounds)) why.add(l);
      }
      // A ::before/::after switched on by the state: a strip, unless it is a
      // text glyph (a check mark's content is a character).
      if (pseudo) {
        const merged = [...mine, ...d];
        const content = [...merged].reverse().find(([n]) => n === "content")?.[1] ?? "";
        const glyph = /^["'].*\S.*["']$/.test(content);
        // What draws or moves it; hiding it (display: none, opacity: 0) is fine.
        const hides = ([n, v]: [string, string]): boolean =>
          (n === "display" && v === "none") || (n === "visibility" && v === "hidden") || (n === "opacity" && parseFloat(v) === 0) || (n === "content" && nothing(v));
        const reveals = d.filter((x) => !hides(x) && (REVEALS.test(x[0]) || x[0] === "content" || /^border/.test(x[0])));
        // A dot (a badge's 4px disc) is a dot, not a line: small both ways.
        const px = (n: string): number => {
          const v = [...merged].reverse().find(([k]) => k === n)?.[1] ?? "";
          return /^[\d.]+px$/.test(v) ? parseFloat(v) : NaN;
        };
        const dot = px("width") <= 8 && px("height") <= 8;
        if (!glyph && !dot && reveals.length) {
          why.add(`a ::before/::after it switches on (${reveals.map(([n, v]) => `${n}: ${v}`).join("; ")})`);
        }
      } else if (!subjectIsState) {
        // A part of the selected thing made into a bar: thin and painted,
        // here or in its base rule, and switched on or painted here.
        const merged = [...mine, ...d];
        if (thin(merged) && painted(merged, defs) && d.some(([n]) => REVEALS.test(n) || /^border/.test(n))) {
          why.add(`a child bar (${d.map(([n, v]) => `${n}: ${v}`).join("; ")})`);
        }
      }
    }
    for (const w of why) found.push(`${label}:${r.line} ${parts.join(", ")} — ${w}`);
  }
  return found;
}

/**
 * The CSS a TypeScript source carries — css`` templates, template literals
 * bound to a name ending in "css" (COMPARE_CSS, REBASE_CSS), and every
 * <style> block inside a template — as a sheet with the file's own line
 * numbers (everything else blanked). A ${…} inside it becomes "24", so
 * `${ROW_HEIGHT}px` still reads as a length.
 */
export function cssOfSource(file: string): string {
  const text = readFileSync(file, "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const out = text.replace(/[^\n]/g, " ").split("");
  const copy = (from: number, to: number, subs: [number, number][]): void => {
    for (let i = from; i < to; i++) if (text[i] !== "\n") out[i] = text[i];
    for (const [a, b] of subs) {
      if (b <= from || a >= to) continue;
      const s = Math.max(a, from), e = Math.min(b, to);
      for (let i = s; i < e; i++) if (text[i] !== "\n") out[i] = " ";
      // "24" just before the end, so a unit written after it still attaches.
      if (e - s >= 2) {
        out[e - 2] = "2";
        out[e - 1] = "4";
      }
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateExpression(n)) {
      const start = n.getStart(sf) + 1;
      const end = n.getEnd() - 1;
      const subs: [number, number][] = ts.isTemplateExpression(n)
        ? n.templateSpans.map((sp) => [sp.expression.getFullStart() - 2, sp.literal.getStart(sf) + 1] as [number, number])
        : [];
      const p = n.parent;
      const tagged = p && ts.isTaggedTemplateExpression(p) && /^(css|unsafeCSS)$/.test(p.tag.getText(sf));
      const named = p && ts.isVariableDeclaration(p) && /css$/i.test(p.name.getText(sf));
      if (tagged || named) {
        copy(start, end, subs);
      } else {
        const raw = text.slice(start, end);
        for (const m of raw.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/g)) {
          const a = start + (m.index ?? 0) + m[0].indexOf(">") + 1;
          copy(a, a + m[1].length, subs);
        }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.join("");
}

/**
 * A webview's options: in a High Contrast rule VS Code's whole ring is the
 * mark, and a ring in a surface colour (an avatar's hole, a node's halo) is a
 * knockout.
 */
export const WEBVIEW: Options = {
  hcWholeRings: true,
  surface: /^[^()]*var\(--(gs-(bg|surface|graph-node-hole|row-fill)|vscode-[\w-]*-background)(\s*,[^()]*(\([^()]*\))?[^()]*)?\)\s*$/,
};

const ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(css|ts)$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

/** Every line the webview sources under `dirs` (from the repository root) draw on a selected state. */
export function linesUnder(dirs: string[]): string[] {
  const found: string[] = [];
  for (const dir of dirs) {
    for (const f of sources(join(ROOT, dir))) {
      const css = f.endsWith(".css") ? readFileSync(f, "utf8") : cssOfSource(f);
      if (!/\{/.test(css)) continue;
      found.push(...selectionLines(css, { ...WEBVIEW, label: relative(ROOT, f) }));
    }
  }
  return found;
}
