#!/usr/bin/env node
// Every piece of text on a screen, ranked by how hard it is to read.
//
// The app is dark-first: light theme is the same rules with a different token
// block, so its failures are not in any one view — they are in a handful of
// tokens and in one habit, `color-mix(…, transparent)`, which dims correctly
// over a dark ground and washes out over a light one. Finding those by eye
// means trusting a screenshot about a 4.3:1 ratio, which no eye can do.
//
// So: walk the rendered page, resolve each text node's colour against the
// background actually behind it (alpha-composited up the ancestor chain, not
// assumed white), and report what fails WCAG. Run it per scene, per theme, and
// diff the two — a thing that is equally poor in dark is a design decision,
// while a thing that is fine in dark and fails in light is a light-theme bug.
//
//   node harness/contrast.mjs <scene> [--theme=light] [--width=1600] [--all]
//   node harness/contrast.mjs --sweep [--theme=light]     every default scene
//
// Exit code is 1 when anything fails, so it can gate a run.

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
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


const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [k, v] = a.slice(2).split("=");
      return [k, v ?? true];
    }),
);
const positional = argv.filter((a) => !a.startsWith("--"));
const theme = flags.theme ?? "light";
const width = Number(flags.width ?? 1600);

/** The scenes worth sweeping: one per surface, plus the detail pages. */
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

// Runs inside the page. Kept as a string because it is injected, and written
// without modern syntax the older bundled Chrome might not parse in eval.
const AUDIT = `
function parseColor(c) {
  if (!c) return null;
  var m = c.match(/^rgba?\\(([^)]+)\\)/);
  if (m) {
    var p = m[1].split(",").map(function (x) { return parseFloat(x); });
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  if (c.charAt(0) === "#") {
    var h = c.slice(1);
    if (h.length === 3) h = h[0]+h[0]+h[1]+h[1]+h[2]+h[2];
    return { r: parseInt(h.substr(0,2),16), g: parseInt(h.substr(2,2),16), b: parseInt(h.substr(4,2),16), a: 1 };
  }
  // A color-mix() ground COMPUTES to "color(srgb 0.93 0.93 0.94)", not to an
  // rgb() triple. Unparsed, every chip and popover tinted that way dropped out
  // of the background walk, so their text was scored against the page — the
  // remote chip's prefix read 2.25:1 "on white" while the chip is grey, and
  // the chip's own name, 4.19:1 on that grey, was never reported at all.
  var s = c.match(/^color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+%?))?\\)/);
  if (s) {
    var sa = s[4] === undefined ? 1 : s[4].slice(-1) === "%" ? parseFloat(s[4]) / 100 : parseFloat(s[4]);
    return { r: parseFloat(s[1]) * 255, g: parseFloat(s[2]) * 255, b: parseFloat(s[3]) * 255, a: sa };
  }
  return null;
}
function over(fg, bg) {
  var a = fg.a;
  return { r: fg.r*a + bg.r*(1-a), g: fg.g*a + bg.g*(1-a), b: fg.b*a + bg.b*(1-a), a: 1 };
}
function lum(c) {
  function f(v) { v = v/255; return v <= 0.03928 ? v/12.92 : Math.pow((v+0.055)/1.055, 2.4); }
  return 0.2126*f(c.r) + 0.7152*f(c.g) + 0.0722*f(c.b);
}
function ratio(a, b) {
  var l1 = lum(a), l2 = lum(b);
  return (Math.max(l1,l2) + 0.05) / (Math.min(l1,l2) + 0.05);
}
/** The colour actually painted behind an element: composite every translucent
 *  ancestor background down onto the page's own, nearest last. */
function behind(el) {
  var stack = [];
  var n = el;
  var depth = 0;
  while (n && n !== document.documentElement) {
    depth++;
    // parentElement is null at a shadow boundary; step out through the host so
    // the walk reaches the page background rather than stopping in the dark.
    if (!n.parentElement && n.parentNode && n.parentNode.host) {
      var bgh = parseColor(getComputedStyle(n).backgroundColor);
      if (bgh && bgh.a > 0) stack.push(bgh);
      n = n.parentNode.host;
      continue;
    }
    var st = getComputedStyle(n);
    var bg = parseColor(st.backgroundColor);
    var grad = st.backgroundImage && st.backgroundImage !== "none";
    if (grad && (!bg || bg.a < 1) && depth <= 2) {
      // A gradient painted on the CONTROL itself — a primary button, a chip —
      // cannot be reduced to one colour, so text on it is not measurable this
      // way. Saying so beats reporting a primary button at 1.13:1 because only
      // its transparent backgroundColor was read. A gradient further up is a
      // page wash over an opaque canvas, which measures close enough to its
      // base, so the walk continues through it.
      return null;
    }
    if (bg && bg.a > 0) stack.push(bg);
    // A gradient OVER an opaque colour (the page canvas is exactly this: a
    // faint radial wash on --app-bg) is close enough to its base to measure,
    // and stopping here keeps the rail's own labels visible to the audit.
    if (grad && bg && bg.a >= 1) break;
    n = n.parentElement;
  }
  var root = parseColor(getComputedStyle(document.body).backgroundColor) || { r:255,g:255,b:255,a:1 };
  var acc = root.a >= 1 ? root : { r:255,g:255,b:255,a:1 };
  for (var i = stack.length - 1; i >= 0; i--) acc = over(stack[i], acc);
  return acc;
}
/** The effective opacity an element inherits, which is how most of this app
 *  dims things — and the reason a "muted" colour can measure fine and still
 *  be unreadable on screen. */
function chainOpacity(el) {
  var o = 1, n = el;
  while (n && n !== document.documentElement) {
    var v = parseFloat(getComputedStyle(n).opacity);
    if (!isNaN(v)) o *= v;
    n = n.parentElement;
  }
  return o;
}
function ownText(el) {
  var t = "";
  for (var i = 0; i < el.childNodes.length; i++) {
    var n = el.childNodes[i];
    if (n.nodeType === 3) t += n.nodeValue;
  }
  return t.trim();
}
function pathOf(el) {
  var parts = [], n = el, hops = 0;
  while (n && hops < 3) {
    var s = n.tagName.toLowerCase();
    var cls = (n.className && n.className.toString ? n.className.toString() : "").trim().split(/\\s+/).filter(Boolean).slice(0,2);
    if (cls.length) s += "." + cls.join(".");
    parts.unshift(s);
    n = n.parentElement; hops++;
  }
  return parts.join(" > ");
}
// Headless Chrome runs a virtual clock, so a view captured mid-entrance is
// still at gs-view-in's opening 0.3 opacity, which made a third of the
// first sweep read as 1.51:1 "failures" that are really one animation frame.
// Remove the animation rather than wait for it; the audit wants the resting
// state, not the journey. Same rule the geometry checks already follow.
var _kill = document.createElement("style");
_kill.textContent = "*,*::before,*::after{animation:none!important;transition:none!important}";
document.head.appendChild(_kill);
void document.body.offsetHeight;

var out = [];
var seen = {};
// SHADOW DOM TOO. The commit graph is a Lit element, so a plain
// querySelectorAll over the document walks straight past its column headers,
// sha column and ref chips — every one of which turned out to carry the same
// mix-into-transparent bug the light document had, and none of which this
// audit could see until it descended.
function collectAll(root, acc) {
  var kids = root.querySelectorAll("*");
  for (var q = 0; q < kids.length; q++) {
    acc.push(kids[q]);
    if (kids[q].shadowRoot) collectAll(kids[q].shadowRoot, acc);
  }
  return acc;
}
var all = collectAll(document.body, []);
for (var i = 0; i < all.length; i++) {
  var el = all[i];
  var txt = ownText(el);
  if (!txt) continue;
  var r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) continue;
  var cs = getComputedStyle(el);
  if (cs.visibility === "hidden" || cs.display === "none") continue;
  var fg = parseColor(cs.color);
  if (!fg) continue;
  var op = chainOpacity(el);
  if (op < 0.06) continue;
  // A DISABLED control is explicitly exempt from the contrast minimum (WCAG
  // 1.4.3 excludes inactive components), and reporting it buries the real
  // findings under every greyed-out button on the page.
  var dis = el.closest("[disabled], [aria-disabled='true']");
  if (dis) continue;
  var bg = behind(el);
  if (!bg) continue;
  // The inherited opacity fades the INK toward its background, so fold it in.
  var ink = over({ r: fg.r, g: fg.g, b: fg.b, a: fg.a * op }, bg);
  var cr = ratio(ink, bg);
  var size = parseFloat(cs.fontSize);
  var weight = parseInt(cs.fontWeight, 10) || 400;
  // WCAG "large text": >=24px, or >=18.66px when bold.
  var large = size >= 24 || (size >= 18.66 && weight >= 700);
  var need = large ? 3 : 4.5;
  if (cr >= need) continue;
  var key = pathOf(el) + "|" + Math.round(cr * 100);
  if (seen[key]) continue;
  seen[key] = 1;
  out.push({
    sel: pathOf(el),
    text: txt.slice(0, 40),
    ratio: Math.round(cr * 100) / 100,
    need: need,
    px: Math.round(size),
    opacity: Math.round(op * 100) / 100,
    color: cs.color,
    on: "rgb(" + Math.round(bg.r) + ", " + Math.round(bg.g) + ", " + Math.round(bg.b) + ")",
  });
}
out.sort(function (a, b) { return a.ratio - b.ratio; });
return JSON.stringify(out.slice(0, 40));
`;

function run(scene) {
  // Same contract probe.mjs uses: the body is encoded into ?probe=, the page
  // runs it and puts the JSON result in its own <title>. Matching it exactly
  // matters — the page has one injection path, not two.
  // NOT wrapped in an IIFE: the page already wraps the body in a function, so
  // wrapping here produced an expression statement whose value was discarded
  // and every scene came back null.
  const probe = encodeURIComponent(AUDIT);
  const url = `file://${PAGE}?scene=${encodeURIComponent(scene)}&theme=${theme}&probe=${probe}`;
  return new Promise((done) => {
    execFile(
      CHROME,
      [
        "--headless", "--disable-gpu", "--hide-scrollbars",
       `--user-data-dir=${PROFILE}`,
        `--window-size=${width},1000`, "--virtual-time-budget=12000",
        "--dump-dom", url,
      ],
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
          done({ scene, rows: v });
        } catch (e) {
          done({ scene, error: String(e).slice(0, 140) });
        }
      },
    );
  });
}

const scenes = flags.sweep ? SCENES : positional.length ? positional : [SCENES[0]];
let failures = 0;
for (const scene of scenes) {
  const res = await run(scene);
  if (res.error) {
    console.log(`\n${scene}: ${res.error}`);
    continue;
  }
  const rows = res.rows.filter((r) => flags.all || r.ratio < r.need);
  if (!rows.length) {
    console.log(`\n\x1b[32mOK\x1b[0m   ${scene} (${theme})`);
    continue;
  }
  failures += rows.length;
  console.log(`\n\x1b[31m${String(rows.length).padStart(3)}\x1b[0m  ${scene} (${theme})`);
  for (const r of rows.slice(0, 12)) {
    const tag = r.ratio < 3 ? "\x1b[31m" : "\x1b[33m";
    console.log(
      `      ${tag}${r.ratio.toFixed(2)}\x1b[0m need ${r.need}  ${r.px}px` +
        (r.opacity < 1 ? ` op${r.opacity}` : "") +
        `  ${r.sel}\n         "${r.text}"  ${r.color} on ${r.on}`,
    );
  }
}
console.log(`\n${failures} text elements below AA in ${theme}`);
process.exit(failures ? 1 : 0);
