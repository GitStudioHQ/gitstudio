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
// GS_CHROME points the harness at another Chrome (a Chrome for Testing build,
// when there is no /Applications copy); the app bundle is the default.
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
function vis(el) {
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  var cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") return false;
  if (parseFloat(cs.opacity) < 0.05) return false;
  return true;
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
  return parts.join(" > ");
}
function accName(el) {
  var a = el.getAttribute("aria-label");
  if (a && a.trim()) return a.trim();
  var lb = el.getAttribute("aria-labelledby");
  if (lb) { var t = document.getElementById(lb); if (t && t.textContent.trim()) return t.textContent.trim(); }
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
var els = [].slice.call(document.querySelectorAll(CLICKABLE));
for (var i = 0; i < els.length && i < 400; i++) {
  var el = els[i];
  if (!vis(el)) continue;
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
  if (!byClass[k]) byClass[k] = e2;
}
var keys = Object.keys(byClass).slice(0, 80);
for (var m = 0; m < keys.length; m++) {
  var el2 = byClass[m] || byClass[keys[m]];
  var sel2 = pathOf(el2);
  if (!anyMatch(el2, HOVER_SELS)) {
    var kh = sel2 + "|hover";
    if (!seen[kh]) { seen[kh] = 1; out.push({ kind: "hover", sel: sel2, name: accName(el2).slice(0,32), detail: "nothing changes on hover" }); }
  }
  if (!anyMatch(el2, FOCUS_SELS)) {
    var kf = sel2 + "|focus";
    if (!seen[kf]) { seen[kf] = 1; out.push({ kind: "focus", sel: sel2, name: accName(el2).slice(0,32), detail: "no focus ring when the keyboard reaches it" }); }
  }
}
return JSON.stringify(out.slice(0, 120));
`;

function run(scene) {
  const body = AUDIT
    .replace("__HOVER__", JSON.stringify(STATE.hover))
    .replace("__FOCUS__", JSON.stringify(STATE.focus));
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
          done({ scene, rows: v || [] });
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
  if (res.error) { console.log(`\n${scene}: ${res.error}`); continue; }
  const rows = only ? res.rows.filter((r) => only.includes(r.kind)) : res.rows;
  for (const r of rows) tally[r.kind] = (tally[r.kind] || 0) + 1;
  if (!rows.length) { console.log(`\n\x1b[32mOK\x1b[0m   ${scene}`); continue; }
  total += rows.length;
  console.log(`\n\x1b[31m${String(rows.length).padStart(3)}\x1b[0m  ${scene}`);
  for (const r of rows.slice(0, 14)) {
    console.log(`      \x1b[33m${r.kind.padEnd(9)}\x1b[0m ${r.sel}\n         ${r.detail}${r.name ? `  — "${r.name}"` : ""}`);
  }
}
console.log(`\n${total} affordance findings  ${JSON.stringify(tally)}`);
process.exit(total ? 1 : 0);
