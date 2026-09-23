#!/usr/bin/env node
// Measure what a screen COSTS, and say which line of source spends it.
//
//   node harness/perf.mjs '<scene>' [--extra=k=v] [--top=20] [--json]
//   node harness/perf.mjs '<scene>' --repeat='<js>' [--times=3]
//
// The first form profiles one scene: layout reads attributed to source lines,
// DOM churn, IPC calls, and what is alive at the end.
//
// The second form is the leak form, and it is the more useful one. `--repeat`
// is a snippet run `--times` over, with `snapshot()` taken between each pass;
// the report shows what did NOT come back down. A view that leaves 40 listeners
// and 900 nodes behind on every visit is a view that gets slower the longer the
// app is open, which no single-pass measurement can see. Example:
//
//   node harness/perf.mjs changes --times=4 \
//     --repeat='$(`[data-view="issues"]`).click(); await settle(400);
//               $(`[data-view="changes"]`).click(); await settle(400);'
//
// WHAT THIS DOES NOT REPORT: milliseconds. The harness runs Chrome under
// --virtual-time-budget, so in-page clocks measure the harness, not the app.
// Everything here is a count, and counts are what survive that. For real
// timings, drive the packaged app over CDP instead.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE_DIR = process.env.GS_HARNESS_PAGE ? resolve(process.env.GS_HARNESS_PAGE) : resolve(HERE, "page");
const PAGE = resolve(PAGE_DIR, "harness.html");
// GS_CHROME first (as webview-ui's test/headless.ts): the machine's Chrome is
// not always in /Applications, and a Chrome for Testing build works as well.
const CHROME = process.env.GS_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const argv = process.argv.slice(2);
const flags = Object.fromEntries(
  argv
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const raw = a.slice(2);
      const at = raw.indexOf("=");
      return at < 0 ? [raw, "true"] : [raw.slice(0, at), raw.slice(at + 1)];
    }),
);
const scene = argv.filter((a) => !a.startsWith("--"))[0];
if (!scene) {
  console.error("usage: node harness/perf.mjs '<scene>' [--extra=k=v] [--repeat='<js>'] [--times=N] [--top=N] [--json]");
  process.exit(2);
}
if (!existsSync(PAGE)) {
  console.error("harness/page is not built — run: node esbuild.js && harness/gen.sh");
  process.exit(2);
}

const top = Number(flags.top ?? 20);
const times = Number(flags.times ?? 3);

// ── the probe body ─────────────────────────────────────────────────────────
// Churn counters are reset AFTER the scene's steps have played, so what is
// measured is the repeat, not the boot. In the single-pass form there is
// nothing to repeat, so the reset is skipped and the whole boot is the subject.
const body = flags.repeat
  ? `
const before = __gsPerf.snapshot();
const passes = [];
for (let i = 0; i < ${times}; i++) {
  __gsPerf.reset();
  ${flags.repeat}
  passes.push({ pass: i + 1, live: __gsPerf.snapshot(), report: __gsPerf.report(${top}) });
}
return { mode: "repeat", before, passes };
`
  : `
return { mode: "once", report: __gsPerf.report(${top}) };
`;

const PRELUDE = `
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const _el = (x) => (typeof x === "string" ? $(x) : x);
const box = (x) => { const n = _el(x); if (!n) return null; const r = n.getBoundingClientRect();
  return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; };
const text = (x) => { const n = _el(x); return n ? (n.textContent || "").trim() : null; };
const settle = (ms = 200) => new Promise((r) => setTimeout(r, ms));
if (!window.__gsPerf) return { error: "perf.js did not install — is the page built by a gen.sh that copies it?" };
`;

const probe = encodeURIComponent(PRELUDE + "\n" + body);
const extra = flags.extra ? `&${flags.extra}` : "";
const url = `file://${PAGE}?scene=${scene}&theme=${flags.theme ?? "dark"}&perf=1${flags.gc ? "&gc=1" : ""}&probe=${probe}${extra}`;

// ── source maps ────────────────────────────────────────────────────────────
// A frame reads `renderer.js:12345:67`. Without this it names the bundle, which
// is the same answer for every finding and therefore no answer at all.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeVlq(segment) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64.indexOf(ch);
    if (digit < 0) return out;
    const cont = digit & 32;
    value += (digit & 31) << shift;
    if (cont) {
      shift += 5;
    } else {
      const negative = value & 1;
      value >>= 1;
      out.push(negative ? (value === 0 ? -0x80000000 : -value) : value);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

function loadMap() {
  const path = resolve(PAGE_DIR, "renderer.js.map");
  if (!existsSync(path)) return null;
  const map = JSON.parse(readFileSync(path, "utf8"));
  // lines[generatedLine] = sorted [genCol, sourceIndex, sourceLine, sourceCol]
  const lines = [];
  let sourceIndex = 0;
  let sourceLine = 0;
  let sourceCol = 0;
  map.mappings.split(";").forEach((groupText, generatedLine) => {
    let genCol = 0;
    if (!groupText) return;
    const entries = [];
    for (const seg of groupText.split(",")) {
      if (!seg) continue;
      const f = decodeVlq(seg);
      genCol += f[0];
      if (f.length >= 4) {
        sourceIndex += f[1];
        sourceLine += f[2];
        sourceCol += f[3];
        entries.push([genCol, sourceIndex, sourceLine, sourceCol]);
      }
    }
    if (entries.length) lines[generatedLine] = entries;
  });
  return { sources: map.sources, lines };
}

function originOf(map, frame) {
  if (!map || !frame) return frame;
  const m = /renderer\.js:(\d+):(\d+)/.exec(frame);
  if (!m) return frame;
  const line = Number(m[1]) - 1;
  const col = Number(m[2]) - 1;
  const entries = map.lines[line];
  if (!entries || !entries.length) return frame;
  // The mapping that starts at or before this column.
  let best = entries[0];
  for (const e of entries) {
    if (e[0] <= col) best = e;
    else break;
  }
  const src = (map.sources[best[1]] || "?").replace(/^(\.\.\/)+/, "");
  return `${src}:${best[2] + 1}`;
}

// ── run ────────────────────────────────────────────────────────────────────
execFile(
  CHROME,
  [
    "--headless",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1600,1000",
    "--virtual-time-budget=30000",
    // Lets the census collect before it counts, which is the difference between
    // "this is retained" and "this has not been collected yet".
    "--js-flags=--expose-gc",
    "--dump-dom",
    url,
  ],
  { maxBuffer: 128 * 1024 * 1024, timeout: 180_000, killSignal: "SIGKILL" },
  (err, stdout) => {
    if (err && !stdout) {
      console.error("chrome failed:", err.message);
      process.exit(1);
    }
    const m = /<title>PROBE ([\s\S]*?)<\/title>/.exec(stdout);
    if (!m) {
      const t = /<title>([\s\S]*?)<\/title>/.exec(stdout);
      console.error(`no perf result (title was ${JSON.stringify(t?.[1] ?? "")})`);
      process.exit(1);
    }
    const decoded = m[1]
      .replace(/&quot;/g, '"')
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&");
    let data;
    try {
      data = JSON.parse(decoded);
    } catch {
      console.error(decoded);
      process.exit(1);
    }
    if (data && data.error) {
      console.error(data.error);
      process.exit(1);
    }

    const map = loadMap();
    const resolveSites = (report) => {
      for (const s of report.layout.bySite) s.at = originOf(map, s.at);
      for (const o of report.observerSites || []) o.at = originOf(map, o.at);
      // Two bundle frames can map to one source line; fold them.
      const folded = new Map();
      for (const s of report.layout.bySite) {
        const cur = folded.get(s.at) || { at: s.at, count: 0, dirty: 0, props: new Set() };
        cur.count += s.count;
        cur.dirty += s.dirty;
        String(s.props).split(",").forEach((p) => cur.props.add(p));
        folded.set(s.at, cur);
      }
      report.layout.bySite = [...folded.values()]
        .map((s) => ({ ...s, props: [...s.props].join(",") }))
        .sort((a, b) => b.count - a.count);
      return report;
    };

    if (data.mode === "once") resolveSites(data.report);
    else data.passes.forEach((p) => resolveSites(p.report));

    if (flags.json) {
      console.log(JSON.stringify(data, null, 2));
      return;
    }

    const n = (x) => String(x).padStart(7);
    if (data.mode === "once") {
      const r = data.report;
      console.log(`\nscene: ${scene}${flags.extra ? "  (" + flags.extra + ")" : ""}`);
      console.log(`\nALIVE   nodes ${r.live.nodes}   listeners: ${r.live.onGlobals} on window/document, ${r.live.onLive} on live elements, ${r.live.onDetached} on detached   intervals ${r.live.intervals}   observers ${r.live.observers}   monaco ${r.live.editors}`);
      console.log(`CHURN   created ${r.churn.created}   inserted ${r.churn.inserted}   removed ${r.churn.removed}   writes ${r.churn.writes}   innerHTML ${r.churn.htmlWrites}`);
      console.log(`LAYOUT  reads ${r.layout.reads}   of which dirty (forced sync layout) ${r.layout.dirtyReads}${r.layout.truncated ? "   [stack capture hit its cap]" : ""}`);
      console.log(`IPC     calls ${r.ipc.calls}   channels ${Object.keys(r.ipc.byChannel).length}`);
      const rep = Object.entries(r.ipc.repeated);
      if (rep.length) console.log(`        repeated: ${rep.slice(0, 8).map(([c, k]) => `${c} x${k}`).join(", ")}`);
      console.log(`\nlayout reads by source line:`);
      for (const s of r.layout.bySite.slice(0, top)) {
        console.log(`  ${n(s.count)}${s.dirty ? `  (${String(s.dirty).padStart(6)} forced)` : "".padStart(17)}  ${s.at}   [${s.props}]`);
      }
      console.log(`\nlayout reads by property:`);
      for (const [p, c] of Object.entries(r.layout.byProp).slice(0, 12)) console.log(`  ${n(c)}  ${p}`);
    } else {
      console.log(`\nscene: ${scene}   repeat x${times}${flags.extra ? "  (" + flags.extra + ")" : ""}`);
      console.log(`\nWHAT IS ALIVE, pass by pass (a rising column is a leak):`);
      const cols = ["nodes", "onGlobals", "onLive", "onDetached", "intervals", "observers", "editors"];
      console.log(`  pass  ${cols.map((c) => c.padStart(11)).join("")}`);
      console.log(`  boot  ${cols.map((c) => String(data.before[c]).padStart(11)).join("")}`);
      for (const p of data.passes) console.log(`  ${String(p.pass).padStart(4)}  ${cols.map((c) => String(p.live[c]).padStart(11)).join("")}`);
      const first = data.passes[0].live;
      const last = data.passes[data.passes.length - 1].live;
      const per = (c) => ((last[c] - first[c]) / Math.max(1, data.passes.length - 1)).toFixed(1);
      console.log(`\n  per additional pass: ${cols.map((c) => `${c} ${per(c) >= 0 ? "+" : ""}${per(c)}`).join("   ")}`);
      const lastR = data.passes[data.passes.length - 1].report;
      console.log(`\nCOST OF ONE PASS (the last one):`);
      console.log(`  created ${lastR.churn.created}   inserted ${lastR.churn.inserted}   removed ${lastR.churn.removed}   writes ${lastR.churn.writes}`);
      console.log(`  layout reads ${lastR.layout.reads}   of which dirty ${lastR.layout.dirtyReads}   ipc ${lastR.ipc.calls}`);
      if (lastR.observerSites?.length) {
        console.log(`\n  observers never disconnected:`);
        for (const o of lastR.observerSites) console.log(`  ${String(o.leaked).padStart(7)}  ${o.kind.padEnd(11)} ${o.at}`);
      }
      const rep2 = Object.entries(lastR.ipc.repeated);
      if (rep2.length) console.log(`  repeated ipc: ${rep2.slice(0, 8).map(([c, k]) => `${c} x${k}`).join(", ")}`);
      console.log(`\n  layout reads by source line:`);
      for (const s of lastR.layout.bySite.slice(0, top)) {
        console.log(`  ${n(s.count)}${s.dirty ? `  (${String(s.dirty).padStart(6)} forced)` : "".padStart(17)}  ${s.at}   [${s.props}]`);
      }
    }
    console.log("");
  },
);
