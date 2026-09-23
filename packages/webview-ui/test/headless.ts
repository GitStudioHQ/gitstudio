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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const bundles = new Map<string, Promise<{ js: string; css: string }>>();

/** One IIFE bundle per entry, built once per test run — with the stylesheet
 *  an entry imports (a webview entry's graph.css), so the page is laid out
 *  the way the webview is. */
function bundle(entry: string): Promise<{ js: string; css: string }> {
  let b = bundles.get(entry);
  if (!b) {
    b = build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      outdir: "out",
      platform: "browser",
      format: "iife",
      loader: { ".ttf": "dataurl" },
      logLevel: "silent",
    }).then((r) => ({
      js: r.outputFiles.find((f) => f.path.endsWith(".js"))?.text ?? "",
      css: r.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "",
    }));
    bundles.set(entry, b);
  }
  return b;
}

/**
 * The page <title> as --dump-dom serialised it, back to the JSON the page
 * wrote. Each entity is decoded exactly once, `&amp;` LAST: decoding it first
 * turned the text "&lt;" (serialised "&amp;lt;") into "<".
 */
export function decodeVerdictTitle(text: string): string {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
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
  opts: {
    width?: number;
    height?: number;
    css?: string;
    /** Runs BEFORE the bundle — for an entry point that reads something at
     *  import time, like a webview entry's acquireVsCodeApi(). */
    prelude?: string;
    /** Attributes for the #root element (a webview entry reads its layout off it). */
    rootAttrs?: string;
  } = {},
): Promise<Verdict> {
  const { js, css } = await bundle(entry);
  const dir = mkdtempSync(join(tmpdir(), "gs-webview-"));
  const page = join(dir, "page.html");
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PENDING</title>
<style>${css}</style>
<style>html,body{margin:0;height:100%;overflow:hidden}${opts.css ?? ""}</style></head>
<body><div id="root" ${opts.rootAttrs ?? ""}></div>
<script>${opts.prelude ?? ""}</script>
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
        // Our own profile inside the page's temp dir, removed with it below. Left
        // to itself headless Chrome leaves a .com.google.Chrome.* profile in the
        // temp directory on every launch; a night of runs filled the disk.
        `--user-data-dir=${join(dir, "profile")}`,
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
        // The page is read; its directory goes now, whatever the verdict. It
        // used to stay — hundreds a night in $TMPDIR on a nearly full disk.
        rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
        if (err && !stdout) return res({ fails: [`chrome failed: ${err.message}`] });
        const m = /<title>CHECK ([\s\S]*?)<\/title>/.exec(stdout);
        if (!m) {
          const t = /<title>([\s\S]*?)<\/title>/.exec(stdout);
          return res({ fails: [`no verdict (title was ${JSON.stringify(t?.[1] ?? "")})`] });
        }
        try {
          res(JSON.parse(decodeVerdictTitle(m[1])));
        } catch {
          res({ fails: [`unparseable verdict: ${m[1].slice(0, 200)}`] });
        }
      },
    );
  });
}
