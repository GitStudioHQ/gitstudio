import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The muted text in the graph surfaces' popovers, MEASURED against VS Code's
 * own Light+ and Dark+ token values (issue #30's follow-up).
 *
 * The rail is extension-only, so no desktop gate (contrast.mjs sweeps the
 * desktop's scenes, in the desktop's tokens) ever looked at it — and its
 * popover headings, the "current" tag and the footnote were `--gs-fg-subtle`,
 * the foreground mixed 50% toward TRANSPARENT: it dims over a dark ground and
 * washes out over a light one. The graph's popovers mixed 70% into the EDITOR
 * background, which reads at AA on the desktop's ink and not on Light+'s
 * #616161. Every piece of text inside the open Branches picker, the chip menu
 * and the commit menu is scored here the way contrast.mjs scores a scene:
 * computed ink (color(srgb …) and oklab() included), inherited opacity folded
 * in, over the colour actually behind it — composited up through the shadow
 * root to the page — with animations off in the shadow roots, so an entrance
 * fade cannot read as a failure or hide one. Small text needs 4.5:1.
 */
const RAIL = fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url));
const GRAPH = fileURLToPath(new URL("../src/graph/commit-graph.ts", import.meta.url));
const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

/**
 * VS Code's defaults for the tokens these surfaces read, from the built-in
 * "Default Light+" and "Default Dark+" themes (vscode/extensions/theme-defaults
 * + the workbench colour registry's defaults for what those leave unset).
 */
const THEMES: Record<string, { bodyClass: string; vars: Record<string, string> }> = {
  "Light+": {
    bodyClass: "vscode-light",
    vars: {
      "--vscode-foreground": "#616161",
      "--vscode-descriptionForeground": "#717171",
      "--vscode-focusBorder": "#0090f1",
      "--vscode-textLink-foreground": "#006ab1",
      "--vscode-sideBar-background": "#f3f3f3",
      "--vscode-editor-background": "#ffffff",
      "--vscode-list-hoverBackground": "#e8e8e8",
      "--vscode-menu-background": "#ffffff",
      "--vscode-menu-foreground": "#616161",
      "--vscode-menu-selectionBackground": "#0060c0",
      "--vscode-menu-selectionForeground": "#ffffff",
      "--vscode-menu-border": "#d4d4d4",
      "--vscode-input-background": "#ffffff",
      "--vscode-input-foreground": "#616161",
      "--vscode-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
      "--vscode-editor-font-family": "Menlo, monospace",
    },
  },
  "Dark+": {
    bodyClass: "vscode-dark",
    vars: {
      "--vscode-foreground": "#cccccc",
      "--vscode-descriptionForeground": "rgba(204, 204, 204, 0.7)",
      "--vscode-focusBorder": "#007fd4",
      "--vscode-textLink-foreground": "#3794ff",
      "--vscode-sideBar-background": "#252526",
      "--vscode-editor-background": "#1e1e1e",
      "--vscode-list-hoverBackground": "#2a2d2e",
      "--vscode-menu-background": "#252526",
      "--vscode-menu-foreground": "#cccccc",
      "--vscode-menu-selectionBackground": "#04395e",
      "--vscode-menu-selectionForeground": "#ffffff",
      "--vscode-menu-border": "#454545",
      "--vscode-input-background": "#3c3c3c",
      "--vscode-input-foreground": "#cccccc",
      "--vscode-font-family": "-apple-system, BlinkMacSystemFont, sans-serif",
      "--vscode-editor-font-family": "Menlo, monospace",
    },
  },
};

const themeCss = (name: string): string => {
  const t = THEMES[name];
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v};`).join("");
  return `:root{${vars}} body{background:${t.vars["--vscode-sideBar-background"]};color:${t.vars["--vscode-foreground"]}}`;
};

/** contrast.mjs's scoring, in the page. */
const SCORE = `
function parseColor(c) {
  if (!c) return null;
  var m = c.match(/^rgba?\\(([^)]+)\\)/);
  if (m) { var p = m[1].split(",").map(function (x) { return parseFloat(x); }); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; }
  var s = c.match(/^color\\(srgb\\s+([\\d.e-]+)\\s+([\\d.e-]+)\\s+([\\d.e-]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\)/);
  if (s) {
    var sa = s[4] === undefined ? 1 : s[4].slice(-1) === "%" ? parseFloat(s[4]) / 100 : parseFloat(s[4]);
    return { r: parseFloat(s[1]) * 255, g: parseFloat(s[2]) * 255, b: parseFloat(s[3]) * 255, a: sa };
  }
  var ok = c.match(/^oklab\\(\\s*([-\\d.]+%?)\\s+([-\\d.]+)\\s+([-\\d.]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\s*\\)/);
  if (ok) {
    var L = ok[1].slice(-1) === "%" ? parseFloat(ok[1]) / 100 : parseFloat(ok[1]);
    var A = parseFloat(ok[2]), B = parseFloat(ok[3]);
    var l_ = L + 0.3963377774 * A + 0.2158037573 * B, m_ = L - 0.1055613458 * A - 0.0638541728 * B, s_ = L - 0.0894841775 * A - 1.2914855480 * B;
    var l3 = l_ * l_ * l_, m3 = m_ * m_ * m_, s3 = s_ * s_ * s_;
    var lin = [4.0767416621 * l3 - 3.3077115913 * m3 + 0.2309699292 * s3, -1.2684380046 * l3 + 2.6097574011 * m3 - 0.3413193965 * s3, -0.0041960863 * l3 - 0.7034186147 * m3 + 1.7076147010 * s3];
    var enc = function (v) { v = Math.max(0, Math.min(1, v)); return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * Math.pow(v, 1 / 2.4) - 0.055); };
    var oa = ok[4] === undefined ? 1 : ok[4].slice(-1) === "%" ? parseFloat(ok[4]) / 100 : parseFloat(ok[4]);
    return { r: enc(lin[0]), g: enc(lin[1]), b: enc(lin[2]), a: oa };
  }
  return null;
}
function over(fg, bg) { var a = fg.a; return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 }; }
function lum(c) { function f(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); } return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b); }
function ratio(a, b) { var l1 = lum(a), l2 = lum(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); }
function behind(el) {
  var stack = [], n = el;
  while (n && n !== document.documentElement) {
    if (!n.parentElement && n.parentNode && n.parentNode.host) {
      var bh = parseColor(getComputedStyle(n).backgroundColor);
      if (bh && bh.a > 0) stack.push(bh);
      n = n.parentNode.host;
      continue;
    }
    var bg = parseColor(getComputedStyle(n).backgroundColor);
    if (bg && bg.a > 0) stack.push(bg);
    if (bg && bg.a >= 1) break;
    n = n.parentElement;
  }
  var root = parseColor(getComputedStyle(document.body).backgroundColor) || { r: 255, g: 255, b: 255, a: 1 };
  var acc = root.a >= 1 ? root : { r: 255, g: 255, b: 255, a: 1 };
  for (var i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
  return acc;
}
function chainOpacity(el) {
  var o = 1, n = el;
  while (n && n !== document.documentElement) {
    var v = parseFloat(getComputedStyle(n).opacity);
    if (!isNaN(v)) o *= v;
    n = n.parentElement || (n.parentNode && n.parentNode.host) || null;
  }
  return o;
}
/** Kill animations in the document AND in every shadow root (contrast.mjs). */
function killAnimations(root) {
  var KILL = "*,*::before,*::after{animation:none!important;transition:none!important}";
  var st = document.createElement("style"); st.textContent = KILL;
  (root === document ? document.head : root).appendChild(st);
  root.querySelectorAll("*").forEach(function (k) { if (k.shadowRoot) killAnimations(k.shadowRoot); });
}
/** Score every text-bearing element under \`scope\` matching \`sel\`. */
function score(scope, sel, where) {
  killAnimations(document);
  void document.body.offsetHeight;
  var out = [];
  scope.querySelectorAll(sel).forEach(function (el) {
    var own = ""; el.childNodes.forEach(function (c) { if (c.nodeType === 3) own += c.nodeValue; });
    own = own.trim();
    if (!own) return;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    var cs = getComputedStyle(el);
    var fg = parseColor(cs.color);
    if (!fg) { out.push({ where: where, text: own, ratio: 0, why: "unparseable ink " + cs.color }); return; }
    var bg = behind(el);
    var ink = over({ r: fg.r, g: fg.g, b: fg.b, a: fg.a * chainOpacity(el) }, bg);
    out.push({ where: where, sel: el.className, text: own.slice(0, 40), ratio: Math.round(ratio(ink, bg) * 100) / 100, size: parseFloat(cs.fontSize) });
  });
  return out;
}
`;

const FIXTURE = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const row = (i, refs) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + i, author: "Ada Lovelace", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: refs || [],
  });
  const rows = [
    row(0, [{ name: "main", fullName: "refs/heads/main", kind: "currentHead" }]),
    row(1, [{ name: "feature/x", fullName: "refs/heads/feature/x", kind: "head" }]),
    row(2), row(3),
  ];
  const refList = [
    { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true },
    { fullName: "refs/heads/feature/x", name: "feature/x", kind: "head" },
    { fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remoteHead" },
    { fullName: "refs/tags/v1", name: "v1", kind: "tag" },
  ];
  const tick = () => new Promise((r) => setTimeout(r, 30));
`;

/** Mount `tag`, open its picker and its chip menu, score the muted text. */
const measure = (tag: string, theme: string, sel: { trigger: string; picker: string; chipMenu: string; muted: string }) => `
  document.body.className = ${JSON.stringify(THEMES[theme].bodyClass)};
  ${FIXTURE}
  ${SCORE}
  const el = document.createElement(${JSON.stringify(tag)});
  el.onAction = () => {};
  el.status = "loading";
  document.getElementById("root").replaceChildren(el);
  await el.updateComplete;
  el.head = sha(0); el.rows = rows; el.totalColumns = 1; el.hasMore = false; el.status = "ready";
  el.refFilter = null; el.refList = refList;
  await el.updateComplete; await tick();
  const sr = el.shadowRoot;
  const found = [];
  // ── The open Branches picker: its heading, group headings, "current", footnote ──
  sr.querySelector(${JSON.stringify(sel.trigger)}).click();
  await el.updateComplete; await tick();
  const picker = sr.querySelector(${JSON.stringify(sel.picker)});
  expect(!!picker, "the Branches picker opened");
  if (picker) found.push(...score(picker, ${JSON.stringify(sel.muted)}, "picker"));
  // Escape closes it (dispatched on what has focus, never on document).
  const f = sr.activeElement || picker;
  f && f.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true }));
  await el.updateComplete; await tick();
  // ── A chip's own menu: its title ──
  const chip = sr.querySelector(".chip[data-ref]");
  const b = chip.getBoundingClientRect();
  chip.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: b.left + 4, clientY: b.top + 4, button: 2 }));
  await el.updateComplete; await tick();
  const menu = sr.querySelector(${JSON.stringify(sel.chipMenu)});
  expect(!!menu, "the chip menu opened");
  if (menu) found.push(...score(menu, ${JSON.stringify(sel.muted)}, "chip menu"));
  notes.found = found;
  expect(found.length >= 4, "the muted text was found to measure (" + found.length + ")");
  for (const r of found) {
    expect(r.ratio >= 4.5, ${JSON.stringify(theme)} + " " + r.where + " \\"" + r.text + "\\" (." + r.sel + ") reads at " + r.ratio + ":1, below 4.5" + (r.why ? " — " + r.why : ""));
  }
`;

const RAIL_SEL = { trigger: ".ibtn.branches", picker: ".pop.branches", chipMenu: ".pop.chipmenu", muted: ".hd, .hint, .cur" };
const GRAPH_SEL = { trigger: ".gh-branches", picker: ".gh-branches-pop", chipMenu: ".gh-chip-menu", muted: ".gh-pop-title, .gh-pop-hint, .gh-ref-cur" };

/** Say what was measured, pass or fail — the lowest ratio is the headroom. */
function report(t: { diagnostic(m: string): void }, notes: Record<string, unknown> | undefined): void {
  const found = (notes?.found ?? []) as Array<{ where: string; text: string; ratio: number }>;
  const low = [...found].sort((a, b) => a.ratio - b.ratio)[0];
  if (low) t.diagnostic(`${found.length} measured; lowest ${low.ratio}:1 (${low.where} "${low.text}")`);
}

for (const theme of Object.keys(THEMES)) {
  test(`the rail's popover muted text reads at AA in VS Code ${theme}`, { skip }, async (t) => {
    const v = await runInChrome(CHROME!, RAIL, measure("gitstudio-commit-rail", theme, RAIL_SEL), {
      css: themeCss(theme) + `#root{height:600px;width:300px;display:flex;flex-direction:column} gitstudio-commit-rail{flex:1;min-height:0}`,
      width: 520,
      height: 600,
    });
    report(t, v.notes);
    assert.deepEqual(v.fails, [], v.fails.join("\n") + "\n" + JSON.stringify(v.notes));
  });

  test(`the graph's popover muted text reads at AA in VS Code ${theme}`, { skip }, async (t) => {
    const v = await runInChrome(CHROME!, GRAPH, measure("gitstudio-graph", theme, GRAPH_SEL), {
      css: themeCss(theme) + `#root{height:600px;width:1100px;display:flex;flex-direction:column} gitstudio-graph{flex:1;min-height:0}`,
      width: 1100,
      height: 600,
    });
    report(t, v.notes);
    assert.deepEqual(v.fails, [], v.fails.join("\n") + "\n" + JSON.stringify(v.notes));
  });
}
