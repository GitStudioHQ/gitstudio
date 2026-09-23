#!/usr/bin/env node
// Does the app survive being made small, and use itself when made large?
//
// contrast.mjs asks if you can read it, affordance.mjs if you can operate it.
// This asks whether the layout holds: nothing pushed off the side, no label
// ellipsised into meaninglessness, no control overlapping another, and no
// stranded band of empty pane on a large display.
//
//   node harness/fit.mjs <scene> [--widths=900,1280,2560] [--theme=dark]
//   node harness/fit.mjs --sweep
//   node harness/fit.mjs graph --expect-shadow=gitstudio-graph
//
// Elements inside SHADOW roots are laid out and checked too (the graph, the
// rail, the commit details and the rebase view are Lit elements), with the
// motion killed in each root; every scene prints how many it reached per
// component, and --expect-shadow fails the run when one was not reached.
//
// Reports, per width:
//   sideways   the page itself scrolls horizontally (never acceptable)
//   clipped    text cut off with no title/aria to recover it
//   overlap    two controls in the same row occupying the same pixels
//   stranded   a main content column leaving >25% of its pane empty
//
// Exit code is 1 when anything fails.

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = resolve(HERE, "page/harness.html");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PROFILE = mkdtempSync(join(tmpdir(), "gs-fit-"));

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


const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith("--")).map((a) => {
    const [k, v] = a.slice(2).split("=");
    return [k, v ?? true];
  }),
);
const positional = argv.filter((a) => !a.startsWith("--"));
const theme = flags.theme ?? "dark";
const widths = String(flags.widths ?? "900,1280,2560").split(",").map(Number);

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
// Motion off — in the document AND in every shadow root, which a document
// stylesheet does not reach (the graph's popovers and rows animate in there):
// a layout measured mid-entrance is a layout nobody sees at rest. The same
// rule contrast.mjs and affordance.mjs follow.
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
  var host = hostOf(el);
  return (host ? host.tagName.toLowerCase() + " ▸ " : "") + parts.join(" > ");
}
/** Every element under root, and inside every shadow root — which
 *  querySelectorAll does not enter. */
function collectAll(root, acc) {
  var kids = root.querySelectorAll("*");
  for (var q = 0; q < kids.length; q++) {
    acc.push(kids[q]);
    if (kids[q].shadowRoot) collectAll(kids[q].shadowRoot, acc);
  }
  return acc;
}
/** One step up the tree, out through a shadow boundary to its host. */
function up(n) {
  return n.parentElement || (n.parentNode && n.parentNode.host) || null;
}
var coverage = {};
var EXPECT = __EXPECT__;
var expectHits = EXPECT.map(function () { return 0; });
function vis(el) {
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  var cs = getComputedStyle(el);
  return cs.visibility !== "hidden" && cs.display !== "none" && parseFloat(cs.opacity) > 0.05;
}
var out = [];
var seen = {};
function add(kind, sel, detail) {
  var k = kind + "|" + sel;
  if (seen[k]) return;
  seen[k] = 1;
  out.push({ kind: kind, sel: sel, detail: detail });
}

// 1. The page must never scroll sideways.
var de = document.documentElement;
if (de.scrollWidth > de.clientWidth + 1) {
  add("sideways", "html", de.scrollWidth + " > " + de.clientWidth);
}

// 2. Text clipped with nothing to recover it. Ellipsis is fine when the full
//    string is available on hover or to a screen reader; it is a defect when
//    the only copy of the text is the truncated one.
var all = collectAll(document.body, []);
for (var i = 0; i < all.length; i++) {
  var el = all[i];
  if (!vis(el)) continue;
  var elHost = hostOf(el);
  if (elHost) {
    var hn = elHost.tagName.toLowerCase();
    coverage[hn] = (coverage[hn] || 0) + 1;
    for (var x = 0; x < EXPECT.length; x++) {
      if (EXPECT[x][0] === hn && (!EXPECT[x][1] || el.closest(EXPECT[x][1]))) expectHits[x]++;
    }
  }
  if (el.children.length) continue;
  var txt = (el.textContent || "").trim();
  if (txt.length < 4) continue;
  var cs = getComputedStyle(el);
  if (cs.overflow === "visible" && cs.textOverflow !== "ellipsis") continue;
  var over = el.scrollWidth - el.clientWidth;
  if (over <= 1) continue;
  // The recovery: a title or an accessible name on it or just above it —
  // or a data-more / data-text the component's own hover card reads (the
  // graph's chips and subjects open refTip's card from those).
  var rec = el.title || el.getAttribute("aria-label") || el.getAttribute("data-more") || el.getAttribute("data-text");
  var n = el, hops = 0;
  while (!rec && n && hops < 3) {
    rec = n.title || (n.getAttribute && (n.getAttribute("aria-label") || n.getAttribute("data-more") || n.getAttribute("data-text")));
    n = up(n); hops++;
  }
  if (rec) continue;
  add("clipped", pathOf(el), Math.round(over) + "px cut, no title or aria-label — \\"" + txt.slice(0, 30) + "\\"");
}

// 3. Controls overlapping each other. Same-parent siblings only: a popover
//    deliberately covers what is under it, a toolbar button must not.
var rows = document.querySelectorAll(".topbar-left, .topbar-right, .gh-head-tools, .det-tb-actions, .gh-head-verbs, .dc-toolbar");
for (var r2 = 0; r2 < rows.length; r2++) {
  var kids = [];
  var cc = rows[r2].children;
  for (var c2 = 0; c2 < cc.length; c2++) if (vis(cc[c2])) kids.push(cc[c2]);
  for (var a = 0; a < kids.length; a++) {
    for (var b = a + 1; b < kids.length; b++) {
      var ra = kids[a].getBoundingClientRect(), rb = kids[b].getBoundingClientRect();
      var ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      var oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 2 && oy > 2) {
        add("overlap", pathOf(kids[a]) + " / " + pathOf(kids[b]), Math.round(ox) + "x" + Math.round(oy) + "px");
      }
    }
  }
}

// 4. A main column stranding its pane. Only meaningful on a wide window, and
//    only for the content column — a deliberate reading measure on prose is
//    correct design, so this reports and lets a human judge.
if (window.innerWidth >= 2000) {
  var host = document.querySelector(".view-host-inner") || document.querySelector(".view-host");
  var col = document.querySelector(".det-body") || document.querySelector(".dash") ||
            document.querySelector(".gh-view") || document.querySelector(".list-view");
  if (host && col) {
    var hw = host.getBoundingClientRect().width, cw = col.getBoundingClientRect().width;
    if (hw > 0 && cw / hw < 0.75) {
      add("stranded", pathOf(col), Math.round(cw) + " of " + Math.round(hw) + "px (" + Math.round((1 - cw / hw) * 100) + "% empty)");
    }
  }
}
return JSON.stringify({
  rows: out.slice(0, 40),
  coverage: coverage,
  expect: EXPECT.map(function (e, i) { return { host: e[0], within: e[1] || "", count: expectHits[i] }; }),
});
`;

/**
 * `--expect-shadow=<host>[@<selector>]` (repeatable, comma-separated): FAIL
 * unless the audit laid out at least one element inside that component's
 * shadow root — inside `selector` when given. The proof that a component is
 * audited at all: "body *" never entered one, and a clean report over
 * nothing reads as a pass.
 */
const EXPECT = String(flags["expect-shadow"] ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => {
    const at = s.indexOf("@");
    return at < 0 ? [s, ""] : [s.slice(0, at), s.slice(at + 1)];
  });

function run(scene, width) {
  const probe = encodeURIComponent(AUDIT.replace("__EXPECT__", JSON.stringify(EXPECT)));
  const url = `file://${PAGE}?scene=${encodeURIComponent(scene)}&theme=${theme}&probe=${probe}`;
  return new Promise((done) => {
    execFile(
      CHROME,
      ["--headless", "--disable-gpu", "--hide-scrollbars", `--user-data-dir=${PROFILE}`,
       `--window-size=${width},1000`, "--virtual-time-budget=12000", "--dump-dom", url],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        const m = /<title>PROBE ([\s\S]*?)<\/title>/.exec(stdout || "");
        // A scene that measured nothing has not passed: say so.
        if (!m) return done({ error: "no probe output" });
        const decode = (t) =>
          t.replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">").replace(/&amp;/g, "&");
        try {
          let v = JSON.parse(decode(m[1]));
          if (typeof v === "string") v = JSON.parse(v);
          // The page reports a probe that THREW as { error } — which used to
          // parse as "no rows" and pass.
          if (!v || v.error || !Array.isArray(v.rows)) return done({ error: String((v && v.error) || "no result").slice(0, 200) });
          done({ rows: v.rows, coverage: v.coverage || {}, expect: v.expect || [] });
        } catch (e) { done({ error: String(e).slice(0, 140) }); }
      },
    );
  });
}

const scenes = flags.sweep ? SCENES : positional.length ? positional : [SCENES[0]];
let total = 0;
const tally = {};
for (const scene of scenes) {
  const lines = [];
  for (const w of widths) {
    const res = await run(scene, w);
    if (res.error) {
      tally.error = (tally.error || 0) + 1;
      lines.push(`      \x1b[31merror    \x1b[0m @${w}  ${res.error}`);
      continue;
    }
    // Which components were reached, so a clean report is not silence.
    const reached = Object.entries(res.coverage).map(([h, n]) => `${h} ${n}`).join(", ");
    console.log(`     ${scene} @${w}: elements laid out inside shadow roots — ${reached || "none"}`);
    for (const e of res.expect) {
      if (e.count > 0) continue;
      tally.shadow = (tally.shadow || 0) + 1;
      lines.push(`      \x1b[31mshadow   \x1b[0m @${w}  nothing measured inside ${e.host}${e.within ? ` (${e.within})` : ""} — the audit did not reach it`);
    }
    for (const r of res.rows) {
      tally[r.kind] = (tally[r.kind] || 0) + 1;
      lines.push(`      \x1b[33m${r.kind.padEnd(9)}\x1b[0m @${w}  ${r.sel}\n         ${r.detail}`);
    }
  }
  if (!lines.length) { console.log(`\n\x1b[32mOK\x1b[0m   ${scene}`); continue; }
  total += lines.length;
  console.log(`\n\x1b[31m${String(lines.length).padStart(3)}\x1b[0m  ${scene}`);
  for (const l of lines.slice(0, 14)) console.log(l);
}
console.log(`\n${total} fit findings  ${JSON.stringify(tally)}`);
process.exit(total ? 1 : 0);
