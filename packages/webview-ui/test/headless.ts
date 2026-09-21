// Runs a real component bundle in headless Chrome and brings back a verdict.
//
// The graph components are Lit elements over a virtualizer: their behaviour
// lives in shadow DOM, scroll geometry and the update cycle, none of which
// node can fake. So a check is bundled with esbuild, mounted in a page, driven
// by an inline script, and reported the way the desktop harness reports —
// the verdict JSON in `<title>`, read back from `--dump-dom`.
//
// Chrome is found through GS_CHROME, the desktop harness's path, or PATH; a
// machine with none SKIPS these checks rather than failing them, and says so.

import { build } from "esbuild";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CANDIDATES = [
  process.env.GS_CHROME,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
].filter((p): p is string => !!p);

/** The Chrome binary to drive, or undefined when this machine has none. */
export function findChrome(): string | undefined {
  return CANDIDATES.find((p) => existsSync(p));
}

export interface Verdict {
  fails: string[];
  /** Anything the page chose to report alongside its verdict. */
  notes?: Record<string, unknown>;
}

const bundles = new Map<string, Promise<string>>();

/** One IIFE bundle per entry, built once per test run. */
function bundle(entry: string): Promise<string> {
  let b = bundles.get(entry);
  if (!b) {
    b = build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      loader: { ".ttf": "dataurl" },
      logLevel: "silent",
    }).then((r) => r.outputFiles[0].text);
    bundles.set(entry, b);
  }
  return b;
}

/**
 * Mount `entry`'s bundle in a page and run `script` against it. The script
 * ends by calling `verdict({fails: [...]})`; assertions it throws on the way
 * become fails too, so a broken page never reads as a passing one.
 */
export async function runInChrome(
  chrome: string,
  entry: string,
  script: string,
  opts: { width?: number; height?: number; css?: string } = {},
): Promise<Verdict> {
  const js = await bundle(entry);
  const dir = mkdtempSync(join(tmpdir(), "gs-webview-"));
  const page = join(dir, "page.html");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PENDING</title>
<style>html,body{margin:0;height:100%;overflow:hidden}${opts.css ?? ""}</style></head>
<body><div id="root"></div>
<script>${js}</script>
<script>
window.verdict = (v) => { document.title = "CHECK " + JSON.stringify(v); };
window.addEventListener("error", (e) => window.verdict({ fails: ["page error: " + (e.message || e.error)] }));
window.addEventListener("unhandledrejection", (e) => window.verdict({ fails: ["rejection: " + (e.reason && e.reason.message || e.reason)] }));
(async () => {
  const fails = [];
  const notes = {};
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  try {
    ${script}
  } catch (err) {
    fails.push("threw: " + (err && err.stack || err));
  }
  window.verdict({ fails, notes });
})();
</script></body></html>`;
  writeFileSync(page, html);
  const width = opts.width ?? 420;
  const height = opts.height ?? 800;
  return new Promise((res) => {
    execFile(
      chrome,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        `--window-size=${width},${height}`,
        // Virtual time: Chrome fast-forwards timers, so a generous budget costs
        // nothing on a page that finishes early — and a paging test on a slow
        // runner does not run out of it.
        "--virtual-time-budget=20000",
        "--dump-dom",
        `file://${page}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        if (err && !stdout) return res({ fails: [`chrome failed: ${err.message}`] });
        const m = /<title>CHECK ([\s\S]*?)<\/title>/.exec(stdout);
        if (!m) {
          const t = /<title>([\s\S]*?)<\/title>/.exec(stdout);
          return res({ fails: [`no verdict (title was ${JSON.stringify(t?.[1] ?? "")})`] });
        }
        try {
          const decoded = m[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'");
          res(JSON.parse(decoded));
        } catch {
          res({ fails: [`unparseable verdict: ${m[1].slice(0, 200)}`] });
        }
      },
    );
  });
}
