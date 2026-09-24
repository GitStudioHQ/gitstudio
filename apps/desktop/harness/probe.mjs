#!/usr/bin/env node
// Ask a rendered scene a question.
//
// shot.sh shows you what a surface LOOKS like; check.mjs asserts a named
// invariant. Neither lets you simply measure something — "how wide is that
// column", "does that button have an accessible name", "what does the focus
// ring compute to in light theme" — without first editing the shared checks
// file, which is impossible when several people are investigating at once.
//
//   node harness/probe.mjs '<scene>' '<js>' [--theme=light] [--width=1150]
//                                            [--extra=staging=checkboxes]
//
// The <js> body runs INSIDE the driven page after its steps have played, with
// `await` available; whatever it returns is JSON-printed. Helpers in scope:
//
//   $(sel[, root])   querySelector
//   $$(sel[, root])  querySelectorAll as an array
//   box(sel|el)      {x,y,w,h,right,bottom} rounded, or null
//   css(sel|el, ...props)  computed styles as an object
//   text(sel|el)     trimmed textContent
//   settle(ms)       await a repaint/timeout
//
// Examples:
//   node harness/probe.mjs issues 'return $$(".sec-row").length'
//   node harness/probe.mjs 'prs~open106' 'return box(".det-title")'
//   node harness/probe.mjs changes 'return css(".dc-file", "color", "font-size")' --theme=light
//   node harness/probe.mjs code 'return $$("button").filter(b=>!b.textContent.trim()&&!b.title).length'

import { harnessChrome } from "./chrome.mjs";
import { execFile } from "node:child_process";
import { chromeProfile } from "./profile.mjs";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.GS_HARNESS_PAGE
  ? resolve(process.env.GS_HARNESS_PAGE, "harness.html")
  : resolve(HERE, "page/harness.html");
// GS_CHROME, else Playwright's windowless chrome-headless-shell — never the
// owner's own Chrome while a Playwright build exists (see chrome.mjs).
const CHROME = harnessChrome();

const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv.filter((a) => a.startsWith("--")).map((a) => {
    // Split on the FIRST "=" only: --extra=staging=checkboxes is one flag whose
    // value is itself a query fragment.
    const raw = a.slice(2);
    const at = raw.indexOf("=");
    return at < 0 ? [raw, "true"] : [raw.slice(0, at), raw.slice(at + 1)];
  }),
);
const positional = argv.filter((a) => !a.startsWith("--"));
const scene = positional[0];
const body = positional[1];

if (!scene || !body) {
  console.error("usage: node harness/probe.mjs '<scene>' '<js body>' [--theme=light] [--width=N]");
  process.exit(2);
}
if (!existsSync(PAGE)) {
  console.error("harness/page is not built — run: node esbuild.js && harness/gen.sh");
  process.exit(2);
}

const theme = flags.theme ?? "dark";
const width = Number(flags.width ?? 1600);
const height = Number(flags.height ?? 1000);

// The helpers are prepended to the probe body so every caller has the same
// vocabulary; keeping them here (not in the shim) means the shim stays the
// scene DRIVER and this file owns the inspection language.
const PRELUDE = `
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const _el = (x) => (typeof x === "string" ? $(x) : x);
const box = (x) => {
  const n = _el(x); if (!n) return null;
  const r = n.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width),
           h: Math.round(r.height), right: Math.round(r.right), bottom: Math.round(r.bottom) };
};
const css = (x, ...props) => {
  const n = _el(x); if (!n) return null;
  const s = getComputedStyle(n); const o = {};
  for (const p of props) o[p] = s.getPropertyValue(p) || s[p];
  return o;
};
const text = (x) => { const n = _el(x); return n ? (n.textContent || "").trim() : null; };
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
`;

const probe = encodeURIComponent(PRELUDE + "\n" + body);
// --extra=k=v[&k=v] appends the shim's own scene switches (staging=checkboxes,
// many=1, ask=1) so a mode reachable only through a pref can still be measured.
const extra = flags.extra ? `&${flags.extra}` : "";
const url = `file://${PAGE}?scene=${scene}&theme=${theme}&probe=${probe}${extra}`;

const profile = chromeProfile("gs-probe-");
execFile(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    profile.flag,
    `--window-size=${width},${height}`,
    "--virtual-time-budget=12000",
    "--dump-dom",
    url,
  ],
  // Same guard check.mjs carries: a page that never lets virtual time run out
  // hangs headless Chrome forever, and a probe that never returns is worse than
  // one that fails — it hangs whatever asked the question.
  { maxBuffer: 64 * 1024 * 1024, timeout: 90_000, killSignal: "SIGKILL" },
  (err, stdout) => {
    profile.cleanup();
    if (err && !stdout) {
      console.error("chrome failed:", err.message);
      process.exit(1);
    }
    const m = /<title>PROBE ([\s\S]*?)<\/title>/.exec(stdout);
    if (!m) {
      const t = /<title>([\s\S]*?)<\/title>/.exec(stdout);
      console.error(`no probe result (title was ${JSON.stringify(t?.[1] ?? "")})`);
      process.exit(1);
    }
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    try {
      const v = JSON.parse(decoded);
      if (v && typeof v === "object" && v.error) {
        console.error(v.error);
        process.exit(1);
      }
      console.log(JSON.stringify(v, null, 2));
    } catch {
      console.log(decoded);
    }
  },
);
