#!/usr/bin/env node
// Measure the REAL app, on a real repository, with a real clock.
//
//   node harness/live.mjs                      # every view, switch latency + scroll smoothness
//   node harness/live.mjs --views=graph,code   # just these
//   node harness/live.mjs --repeat=3 --json
//   node harness/live.mjs --launch             # start the packaged app itself first
//
// The headless harness (perf.mjs) runs Chrome under --virtual-time-budget, so
// its clock is virtual and it can only report COUNTS. That is the right tool
// for "this render creates 40,000 elements" and for leak deltas. It is the
// wrong tool for the word the owner actually used, which was "smooth".
//
// This one attaches to the packaged Electron app over the DevTools protocol and
// measures what a person would feel:
//
//   • switch latency — from the click to the view having painted content,
//     measured with the page's own performance.now(), which here is real;
//   • frame times while scrolling — p50/p95/worst, and how many frames missed
//     16.7ms and 50ms. Dropped frames ARE the stutter; an average cannot show
//     them because stutter is entirely a tail phenomenon;
//   • long tasks — anything holding the main thread over 50ms, which is the
//     window where a click stops responding.
//
// It needs the app running with --remote-debugging-port (or pass --launch).
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = resolve(HERE, "../release/mac-arm64/GitStudio.app/Contents/MacOS/GitStudio");

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
const PORT = Number(flags.port ?? 9333);
const REPEAT = Number(flags.repeat ?? 3);
const VIEWS = (flags.views
  ? String(flags.views)
  : "changes,graph,branches,compare,code,notifications,mywork,prs,issues,actions,releases,projects,orgs,gists,settings"
).split(",");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function targets() {
  const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return res.json();
}

async function connect() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await targets();
      const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error(`nothing listening on ${PORT} — start the app with --remote-debugging-port=${PORT}, or pass --launch`);
}

/** A minimal CDP client: send a command, await its reply. */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  /** Evaluate an async body in the page and return its value. */
  async eval(body) {
    const r = await this.send("Runtime.evaluate", {
      expression: `(async () => { ${body} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

// The measurement agent, installed once in the page.
const AGENT = `
window.__gsLive = (() => {
  const $ = (s) => document.querySelector(s);
  const raf = () => new Promise((r) => requestAnimationFrame(r));

  // Long tasks are collected continuously, so any measurement can ask what the
  // main thread was doing while it ran.
  const long = [];
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries()) long.push(Math.round(e.duration)); })
      .observe({ entryTypes: ["longtask"] });
  } catch {}

  /** Frame intervals over n frames, while \`drive\` runs each frame. */
  async function frames(n, drive) {
    const out = [];
    let last = performance.now();
    for (let i = 0; i < n; i++) {
      if (drive) { try { drive(i); } catch {} }
      const t = await raf();
      out.push(t - last);
      last = t;
    }
    return out;
  }

  /** Click a rail destination and wait until the view has painted content. */
  async function switchTo(view, settleFrames = 90) {
    const btn = document.querySelector('[data-view="' + view + '"]');
    if (!btn) return { error: "no rail button for " + view };
    const host = $(".view-host") || $("#root");
    const before = performance.now();
    btn.click();
    // "Painted" is the first frame on which the host has real content and has
    // stopped changing size — not merely the first frame after the click, which
    // any spinner satisfies.
    let painted = null;
    let stableFrom = null;
    let lastH = -1;
    for (let i = 0; i < settleFrames; i++) {
      const t = await raf();
      const h = host ? host.scrollHeight : 0;
      const has = host && host.querySelector("*") && h > 0;
      if (has && painted === null) painted = t;
      if (has && h === lastH) { if (stableFrom === null) stableFrom = t; }
      else { stableFrom = null; lastH = h; }
      if (stableFrom !== null && t - stableFrom > 100) break;
    }
    return {
      firstPaintMs: painted === null ? null : Math.round(painted - before),
      settledMs: stableFrom === null ? null : Math.round(stableFrom - before),
      nodes: document.getElementsByTagName("*").length,
    };
  }

  /** The tallest element that can actually scroll in the current view. */
  function scroller() {
    let best = null;
    for (const el of document.querySelectorAll("*")) {
      const over = el.scrollHeight - el.clientHeight;
      if (over < 40) continue;
      const oy = getComputedStyle(el).overflowY;
      if (oy !== "auto" && oy !== "scroll" && oy !== "overlay") continue;
      if (!best || over > best.scrollHeight - best.clientHeight) best = el;
    }
    return best;
  }

  /** What the app is actually looking at — a measurement of an empty list is a
   *  measurement of nothing, and that has to be visible in the report. */
  function context() {
    const host = $(".view-host") || $("#root");
    return {
      rows: document.querySelectorAll(".sec-row, .dc-file, .row[data-sha]").length,
      scrollable: (() => { const s = scroller(); return s ? s.scrollHeight - s.clientHeight : 0; })(),
      nodes: document.getElementsByTagName("*").length,
    };
  }

  async function scrollTest(n = 120, step = 40) {
    const el = scroller();
    if (!el) return { skipped: "nothing scrollable" };
    el.scrollTop = 0;
    await raf();
    const before = long.length;
    const f = await frames(n, () => {
      el.scrollTop += step;
      el.dispatchEvent(new Event("scroll"));
    });
    return { frames: f.map((x) => Math.round(x * 100) / 100), longTasks: long.slice(before), height: el.scrollHeight };
  }

  return { switchTo, scrollTest, frames, context, longTasks: () => long.slice(), reset: () => { long.length = 0; } };
})();
return "ok";
`;

const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 100) / 100;
};

async function main() {
  if (flags.launch) {
    if (!existsSync(APP)) {
      console.error(`no packaged app at ${APP} — run: npm run package`);
      process.exit(2);
    }
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    spawn(APP, [`--remote-debugging-port=${PORT}`], { env, detached: true, stdio: "ignore" }).unref();
    await sleep(6000);
  }

  const url = await connect();
  const ws = new WebSocket(url);
  await new Promise((r, j) => {
    ws.addEventListener("open", r, { once: true });
    ws.addEventListener("error", j, { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send("Runtime.enable");
  await cdp.eval(AGENT);

  const results = [];
  for (const view of VIEWS) {
    const switches = [];
    for (let i = 0; i < REPEAT; i++) {
      // Always arrive from somewhere else, so a switch is a real switch and not
      // a no-op re-route the app is entitled to skip.
      await cdp.eval(`document.querySelector('[data-view="changes"]')?.click(); await new Promise(r=>setTimeout(r,250)); return 1;`);
      const s = await cdp.eval(`return await window.__gsLive.switchTo(${JSON.stringify(view)});`);
      switches.push(s);
      await sleep(200);
    }
    const ctx = await cdp.eval(`return window.__gsLive.context();`);
    const scroll = await cdp.eval(`return await window.__gsLive.scrollTest();`);
    const f = scroll.frames || [];
    results.push({
      view,
      firstPaintMs: switches.map((s) => s.firstPaintMs).filter((x) => x != null),
      settledMs: switches.map((s) => s.settledMs).filter((x) => x != null),
      nodes: switches[switches.length - 1]?.nodes ?? null,
      rows: ctx.rows,
      scrollable: ctx.scrollable,
      scroll: f.length
        ? {
            p50: pct(f, 50),
            p95: pct(f, 95),
            worst: Math.round(Math.max(...f) * 100) / 100,
            over17: f.filter((x) => x > 17).length,
            over50: f.filter((x) => x > 50).length,
            of: f.length,
            longTasks: scroll.longTasks || [],
          }
        : { skipped: scroll.skipped || "no frames" },
    });
    process.stderr.write(".");
  }
  process.stderr.write("\n");
  ws.close();

  if (flags.json) {
    console.log(JSON.stringify(results, null, 2));
    return;
  }
  const med = (xs) => (xs.length ? xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
  console.log("\nview            paint   settled   nodes   rows    scroll p50 / p95 / worst   >17ms  >50ms  longtasks");
  console.log("─".repeat(104));
  for (const r of results) {
    const s = r.scroll;
    const scrollCol = s.skipped
      ? String(s.skipped).padEnd(26)
      : `${String(s.p50).padStart(6)} /${String(s.p95).padStart(6)} /${String(s.worst).padStart(7)}   `;
    console.log(
      r.view.padEnd(14) +
        String(med(r.firstPaintMs) ?? "-").padStart(6) +
        String(med(r.settledMs) ?? "-").padStart(10) +
        String(r.nodes ?? "-").padStart(8) +
        String(r.rows ?? "-").padStart(7) +
        "   " +
        scrollCol +
        (s.skipped ? "" : String(s.over17).padStart(6) + String(s.over50).padStart(7) + "  " + (s.longTasks?.length ? s.longTasks.join(",") : "-")),
    );
  }
  console.log("\nms, median of " + REPEAT + " switches. paint = click → content on screen; settled = click → layout stops moving.");
  console.log("scroll = frame intervals over 120 driven frames. >17ms is a dropped frame at 60Hz; >50ms is a visible hitch.\n");
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exit(1);
});
