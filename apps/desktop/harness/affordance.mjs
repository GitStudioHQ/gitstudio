#!/usr/bin/env node
// Does every control behave like a control?
//
// contrast.mjs asks whether you can READ the app. This asks whether you can
// USE it: whether the thing you are about to click looks clickable, says what
// it is to a screen reader, lights up under the pointer, shows a ring when the
// keyboard reaches it, and is genuinely disabled rather than merely greyed.
//
// All of it is measurable in the page, which matters because these are exactly
// the defects that survive a screenshot review — a missing `cursor: pointer`
// or an icon button with no accessible name looks perfect in a picture.
//
//   node harness/affordance.mjs <scene> [--theme=dark] [--width=1600]
//   node harness/affordance.mjs --sweep
//   node harness/affordance.mjs graph --expect-shadow=gitstudio-graph
//
// Controls inside SHADOW roots are audited too (the graph, the rail, the
// commit details and the rebase view are Lit elements), with the motion
// killed in each root and each root's own :hover/:focus rules; every scene
// prints how many it reached per component, and --expect-shadow fails the
// run when a component was not reached at all.
//
// Checks, per interactive element:
//   cursor     a click target that does not say "pointer"
//   name       an icon-only control with no accessible name
//   hover      :hover changes nothing visible
//   focus      :focus-visible draws no ring
//   disabled   styled as disabled but still clickable, or vice versa
//   tiny       a hit target under 24x24 CSS px
//
// Exit code is 1 when anything fails.

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "page/harness.html");
// GS_CHROME first (as webview-ui's test/headless.ts): the machine's Chrome is
// not always in /Applications, and a Chrome for Testing build works as well.
const CHROME = process.env.GS_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
// A throwaway profile. Without --user-data-dir Chrome picks one relative to the
// cwd and leaves a ~10MB profile tree inside the repo, unignored by git.
const PROFILE = mkdtempSync(join(tmpdir(), "gs-audit-"));

// Chrome writes a full browser profile into this directory — caches, service
// workers, shader blobs — and never cleans it up. Left to itself, a night of
// sweeps put 380 of them in the temp folder, 2.2GB, on a machine whose disk
// runs at 100%. It is removed on the way out however the run ends: a clean
// finish, a Ctrl-C, or the pkill that a stalled sweep gets.
function cleanProfile() {
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* already gone, or a live Chrome still holds it — the OS reaps it later */
  }
}
process.on("exit", cleanProfile);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    cleanProfile();
    process.exit(1);
  });
}


/** Selectors that carry a :hover / :focus state, read from the built sheet. */
function statefulSelectors() {
  const css = readFileSync(resolve(HERE, "page/renderer.css"), "utf8");
  const hover = new Set();
  const focus = new Set();
  // Selector lists only: everything before each `{`, split on commas.
  for (const m of css.matchAll(/([^{}]+)\{/g)) {
    for (const part of m[1].split(",")) {
      const sel = part.trim();
      if (!sel || sel.startsWith("@") || sel.includes("%")) continue;
      if (sel.includes(":hover")) hover.add(sel.replace(/:hover/g, "").trim());
      if (sel.includes(":focus")) {
        focus.add(sel.replace(/:focus-visible/g, "").replace(/:focus-within/g, "").replace(/:focus/g, "").trim());
      }
    }
  }
  const clean = (set) => [...set].filter((x) => x && !x.includes("{") && !x.includes("*/"));
  return { hover: clean(hover), focus: clean(focus) };
}
const STATE = statefulSelectors();

const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? true];
  }),
);
const positional = argv.filter((a) => !a.startsWith("--"));
const theme = flags.theme ?? "dark";
const width = Number(flags.width ?? 1600);
const only = flags.only ? String(flags.only).split(",") : null;

const SCENES = [
  "dashboard", "repositories", "branches", "changes", "changes~click:.dc-file",
  "code", "graph", "compare", "issues", "issues~open31", "prs", "prs~open106",
  "mywork", "notifications", "explore", "actions", "actions~open9100",
  "releases", "releases~open50", "projects", "orgs", "gists", "settings",
  // The other shadow-DOM surfaces, and the two pages reached only by driving:
  // rebase-view, the Assistant, and a GitHub repository browsed in place.
  "rebase", "assistant~click:.topbar-assistant",
  "explore~type:git~key:Enter~text:libgit2/libgit2",
];

const AUDIT = `
// Headless Chrome's virtual clock leaves a view mid-entrance: a fading popover
// sits near opacity 0, which vis() below reads as "not there", and a control
// caught mid-transition reports the wrong hover snapshot. Remove the motion
// first — in the document AND in every shadow root, which a document
// stylesheet does not reach (the graph's popovers animate in there). The same
// rule contrast.mjs and fit.mjs follow.
var KILL = "*,*::before,*::after{animation:none!important;transition:none!important}";
var _kill = document.createElement("style");
_kill.textContent = KILL;
document.head.appendChild(_kill);
(function killInShadows(root) {
  var kids = root.querySelectorAll("*");
  for (var k = 0; k < kids.length; k++) {
    var sr = kids[k].shadowRoot;
    if (!sr) continue;
    var st = document.createElement("style");
    st.textContent = KILL;
    sr.appendChild(st);
    killInShadows(sr);
  }
})(document);
void document.body.offsetHeight;

function vis(el) {
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  var cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  if (parseFloat(cs.opacity) < 0.05) return false;
  return true;
}
/** The shadow host an element lives under, or null in the document. */
function hostOf(el) {
  var root = el.getRootNode && el.getRootNode();
  return root && root.host ? root.host : null;
}
function pathOf(el) {
  var parts = [], n = el, hops = 0;
  while (n && hops < 3) {
    var s = n.tagName.toLowerCase();
    var cls = (n.className && n.className.toString ? n.className.toString() : "")
      .trim().split(/\\s+/).filter(Boolean).slice(0, 2);
    if (cls.length) s += "." + cls.join(".");
    parts.unshift(s); n = n.parentElement; hops++;
  }
  // Inside a component, say which one: the graph's ".gh-menuitem" is not the
  // document's.
  var host = hostOf(el);
  return (host ? host.tagName.toLowerCase() + " ▸ " : "") + parts.join(" > ");
}
/** Every element matching sel under root — and inside every shadow root,
 *  which querySelectorAll does not enter. The graph, the rail, the commit
 *  details and the rebase view are all Lit elements. */
function collectAll(root, sel, acc) {
  var hits = root.querySelectorAll(sel);
  for (var h = 0; h < hits.length; h++) acc.push(hits[h]);
  var kids = root.querySelectorAll("*");
  for (var q = 0; q < kids.length; q++) {
    if (kids[q].shadowRoot) collectAll(kids[q].shadowRoot, sel, acc);
  }
  return acc;
}
function accName(el) {
  var a = el.getAttribute("aria-label");
  if (a && a.trim()) return a.trim();
  var lb = el.getAttribute("aria-labelledby");
  if (lb) {
    // An id resolves in the element's own tree — a shadow root, for a component.
    var scope = el.getRootNode && el.getRootNode().getElementById ? el.getRootNode() : document;
    var t = scope.getElementById(lb);
    if (t && t.textContent.trim()) return t.textContent.trim();
  }
  if (el.title && el.title.trim()) return el.title.trim();
  var txt = (el.textContent || "").trim();
  if (txt) return txt;
  var img = el.querySelector("img[alt]");
  if (img && img.getAttribute("alt").trim()) return img.getAttribute("alt").trim();
  return "";
}
/** A snapshot of the properties a hover or focus state would plausibly move. */
function snap(el) {
  var cs = getComputedStyle(el);
  return [cs.backgroundColor, cs.color, cs.borderColor, cs.boxShadow, cs.outlineColor,
          cs.outlineWidth, cs.opacity, cs.textDecorationLine, cs.filter, cs.transform].join("|");
}
var CLICKABLE = 'button, a[href], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="switch"], [role="checkbox"], input, select, textarea, summary, [tabindex]:not([tabindex="-1"]), .is-clickable, [onclick]';
var out = [];
var seen = {};
var els = collectAll(document, CLICKABLE, []);
/** What was measured inside each component — the proof the audit reached it. */
var coverage = {};
var EXPECT = __EXPECT__;
var expectHits = EXPECT.map(function () { return 0; });
for (var i = 0; i < els.length && i < 600; i++) {
  var el = els[i];
  if (!vis(el)) continue;
  var elHost = hostOf(el);
  if (elHost) {
    var hn = elHost.tagName.toLowerCase();
    coverage[hn] = (coverage[hn] || 0) + 1;
    for (var x = 0; x < EXPECT.length; x++) {
      if (EXPECT[x][0] === hn && (!EXPECT[x][1] || el.closest(EXPECT[x][1]))) expectHits[x]++;
    }
  }
  // Monaco owns its own accessibility and paints its own widgets; auditing its
  // internals reports its hidden IME textarea as an unlabelled field on every
  // scene that shows a diff, which is noise, not a finding.
  if (el.closest(".monaco-editor, .monaco-workbench, .overflow-guard")) continue;
  if (el.getAttribute("aria-hidden") === "true") continue;
  var tag = el.tagName.toLowerCase();
  var cs = getComputedStyle(el);
  var sel = pathOf(el);
  var isField = tag === "input" || tag === "textarea" || tag === "select";
  var disabled = el.disabled === true || el.getAttribute("aria-disabled") === "true";
  var name = accName(el);
  var rect = el.getBoundingClientRect();
  var add = function (kind, detail) {
    var key = sel + "|" + kind;
    if (seen[key]) return;
    seen[key] = 1;
    out.push({ kind: kind, sel: sel, name: name.slice(0, 32), detail: detail });
  };

  // 1. cursor — a click target should say so. Fields legitimately use text,
  // and a drag handle legitimately says which way it drags.
  var DRAG = { "col-resize":1, "row-resize":1, "ew-resize":1, "ns-resize":1,
               "nwse-resize":1, "nesw-resize":1, "grab":1, "grabbing":1, "move":1,
               "text":1, "zoom-in":1, "zoom-out":1, "copy":1, "not-allowed":1 };
  var isHandle = !!DRAG[cs.cursor];
  if (!isField && !disabled && !isHandle && cs.cursor !== "pointer") {
    add("cursor", cs.cursor === "default" ? "default (not pointer)" : cs.cursor);
  }

  // 2. accessible name — an icon-only control with nothing to announce.
  if (!name && !isField) add("name", tag + " has no text, aria-label or title");
  if (isField && !name && !el.getAttribute("placeholder")) add("name", tag + " field unlabelled");

  // 3. hit size — 24x24 is the WCAG 2.2 minimum for a pointer target. A drag
  // handle is exempt: it is meant to be a thin edge, and widening it would eat
  // the pane it borders.
  if (!isField && !isHandle && Math.min(rect.width, rect.height) < 24) {
    add("tiny", Math.round(rect.width) + "x" + Math.round(rect.height));
  }

  // 4. disabled honesty — greyed but live, or live but inert.
  if (!disabled && parseFloat(cs.opacity) <= 0.55 && cs.pointerEvents !== "none") {
    add("disabled", "looks disabled (opacity " + cs.opacity + ") but is not");
  }
  if (disabled && cs.cursor === "pointer") {
    add("disabled", "disabled but still shows the pointer cursor");
  }
}

// 5 & 6. hover and focus states.
//
// The selectors come from node, NOT from document.styleSheets: the harness
// page is file:// and reading cssRules off a file:// stylesheet throws a
// SecurityError, which the first version swallowed — so it found no rules at
// all and reported every control in the top bar as having neither state.
var HOVER_SELS = __HOVER__;
var FOCUS_SELS = __FOCUS__;
/**
 * The :hover / :focus selectors for the tree an element lives in. The
 * document's come from node (above). A component's live in its shadow root's
 * constructed stylesheets — readable from the page, unlike a file:// sheet —
 * so they are read here, once per root. Without them every control inside
 * the graph reported "nothing changes on hover" against the app's CSS.
 */
function selectorsFor(el) {
  var root = el.getRootNode ? el.getRootNode() : document;
  if (!root || !root.host) return { hover: HOVER_SELS, focus: FOCUS_SELS };
  if (root.__gsStateSels) return root.__gsStateSels;
  var hover = [], focus = [];
  var sheets = [].slice.call(root.adoptedStyleSheets || []);
  var styles = root.querySelectorAll("style");
  for (var si = 0; si < styles.length; si++) if (styles[si].sheet) sheets.push(styles[si].sheet);
  var walk = function (rules) {
    for (var ri = 0; ri < rules.length; ri++) {
      var rule = rules[ri];
      if (rule.selectorText) {
        var parts = rule.selectorText.split(",");
        for (var pi = 0; pi < parts.length; pi++) {
          var sel = parts[pi].trim();
          if (sel.indexOf(":hover") >= 0) hover.push(sel.replace(/:hover/g, "").trim());
          if (sel.indexOf(":focus") >= 0) {
            focus.push(sel.replace(/:focus-visible/g, "").replace(/:focus-within/g, "").replace(/:focus/g, "").trim());
          }
        }
      } else if (rule.cssRules) {
        walk(rule.cssRules); // @media, @supports
      }
    }
  };
  for (var sh = 0; sh < sheets.length; sh++) {
    try { walk(sheets[sh].cssRules); } catch (e) {}
  }
  root.__gsStateSels = { hover: hover.filter(Boolean), focus: focus.filter(Boolean) };
  return root.__gsStateSels;
}
function anyMatch(el, sels) {
  for (var q = 0; q < sels.length; q++) {
    try { if (el.matches(sels[q])) return true; } catch (e) {}
  }
  // A field is very often styled through its WRAPPER, as focus-within on the
  // search box rather than focus-visible on the input, which is a correct
  // pattern — so an ancestor carrying the state counts as the control having it.
  var n = el.parentElement, hops = 0;
  while (n && hops < 3) {
    for (var w = 0; w < sels.length; w++) {
      try { if (n.matches(sels[w])) return true; } catch (e) {}
    }
    n = n.parentElement; hops++;
  }
  return false;
}
var byClass = {};
for (var j2 = 0; j2 < els.length; j2++) {
  var e2 = els[j2];
  if (!vis(e2)) continue;
  if (e2.disabled) continue;
  var k = (e2.className && e2.className.toString ? e2.className.toString() : e2.tagName).trim();
  if (!k) k = e2.tagName;
  // Per tree: the graph's ".gh-menuitem" and a document ".gh-menuitem" are
  // styled by different sheets.
  var h2 = hostOf(e2);
  if (h2) k = h2.tagName + "|" + k;
  if (!byClass[k]) byClass[k] = e2;
}
var keys = Object.keys(byClass).slice(0, 120);
for (var m = 0; m < keys.length; m++) {
  var el2 = byClass[keys[m]];
  var sel2 = pathOf(el2);
  var sels2 = selectorsFor(el2);
  if (!anyMatch(el2, sels2.hover)) {
    var kh = sel2 + "|hover";
    if (!seen[kh]) { seen[kh] = 1; out.push({ kind: "hover", sel: sel2, name: accName(el2).slice(0,32), detail: "nothing changes on hover" }); }
  }
  if (!anyMatch(el2, sels2.focus)) {
    var kf = sel2 + "|focus";
    if (!seen[kf]) { seen[kf] = 1; out.push({ kind: "focus", sel: sel2, name: accName(el2).slice(0,32), detail: "no focus ring when the keyboard reaches it" }); }
  }
}
return JSON.stringify({
  rows: out.slice(0, 120),
  coverage: coverage,
  expect: EXPECT.map(function (e, i) { return { host: e[0], within: e[1] || "", count: expectHits[i] }; }),
});
`;

/**
 * `--expect-shadow=<host>[@<selector>]` (repeatable, comma-separated): FAIL
 * unless the audit measured at least one control inside that component's
 * shadow root — inside `selector` when given (an open popover, say). The
 * proof that a component is audited at all; querySelectorAll alone never
 * entered one, and a clean report over nothing reads as a pass.
 */
const EXPECT = String(flags["expect-shadow"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const at = s.indexOf("@");
    return at < 0 ? [s, ""] : [s.slice(0, at), s.slice(at + 1)];
  });

function run(scene) {
  const body = AUDIT
    .replace("__HOVER__", JSON.stringify(STATE.hover))
    .replace("__FOCUS__", JSON.stringify(STATE.focus))
    .replace("__EXPECT__", JSON.stringify(EXPECT));
  const probe = encodeURIComponent(body);
  const url = `file://${PAGE}?scene=${encodeURIComponent(scene)}&theme=${theme}&probe=${probe}`;
  return new Promise((done) => {
    execFile(
      CHROME,
      ["--headless", "--disable-gpu", "--hide-scrollbars",
       `--user-data-dir=${PROFILE}`,
       `--window-size=${width},1000`, "--virtual-time-budget=12000", "--dump-dom", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        const m = /<title>PROBE ([\s\S]*?)<\/title>/.exec(stdout || "");
        if (!m) return done({ scene, error: "no probe output" });
        const decode = (t) =>
          t.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        try {
          let v = JSON.parse(decode(m[1]));
          if (typeof v === "string") v = JSON.parse(v);
          // The page reports a probe that THREW as { error }: not a pass.
          if (!v || v.error || !Array.isArray(v.rows)) return done({ scene, error: String((v && v.error) || "no result").slice(0, 200) });
          done({ scene, rows: v.rows, coverage: v.coverage || {}, expect: v.expect || [] });
        } catch (e) {
          done({ scene, error: String(e).slice(0, 140) });
        }
      },
    );
  });
}

const scenes = flags.sweep ? SCENES : positional.length ? positional : [SCENES[0]];
let total = 0;
const tally = {};
for (const scene of scenes) {
  const res = await run(scene);
  if (res.error) { total++; console.log(`\n${scene}: ${res.error}`); continue; }
  // Which components were reached, so a clean report is not silence.
  const reached = Object.entries(res.coverage).map(([h, n]) => `${h} ${n}`).join(", ");
  console.log(`\n     ${scene}: controls measured inside shadow roots — ${reached || "none"}`);
  for (const e of res.expect) {
    if (e.count > 0) continue;
    total++;
    tally.shadow = (tally.shadow || 0) + 1;
    console.log(`\x1b[31m  shadow\x1b[0m  nothing measured inside ${e.host}${e.within ? ` (${e.within})` : ""} — the audit did not reach it`);
  }
  const rows = only ? res.rows.filter((r) => only.includes(r.kind)) : res.rows;
  for (const r of rows) tally[r.kind] = (tally[r.kind] || 0) + 1;
  if (!rows.length) { console.log(`\x1b[32mOK\x1b[0m   ${scene}`); continue; }
  total += rows.length;
  console.log(`\n\x1b[31m${String(rows.length).padStart(3)}\x1b[0m  ${scene}`);
  for (const r of rows.slice(0, 14)) {
    console.log(`      \x1b[33m${r.kind.padEnd(9)}\x1b[0m ${r.sel}\n         ${r.detail}${r.name ? `  — "${r.name}"` : ""}`);
  }
}
console.log(`\n${total} affordance findings  ${JSON.stringify(tally)}`);
process.exit(total ? 1 : 0);
