// Runs a real component bundle in headless Chrome and brings back a verdict.
//
// The graph components are Lit elements over a virtualizer: their behaviour
// lives in shadow DOM, scroll geometry and the update cycle, none of which
// node can fake. So a check is bundled with esbuild, mounted in a page, driven
// by an inline script, and reported the way the desktop harness reports —
// the verdict JSON in `<title>`, read back from `--dump-dom`.
//
// The browser is GS_CHROME, else Playwright's windowless chrome-headless-shell,
// else its Chrome for Testing, and only then a system Chrome (the CI runners'):
// test/findChrome.mjs holds that order for this package and the desktop
// harness alike. A machine with none SKIPS these checks rather than failing
// them, and says so.
//
// Never the desktop Chrome on a Mac (/Applications/Google Chrome.app) outside
// CI: a run that fell back to it opened and closed it on the owner's screen a
// thousand times a pass, and he uninstalled it thinking it was broken. GS_CHROME
// pointing at it is refused too, the way scripts/merge-e2e/cdp.ts refuses it.
// A CI runner (CI set) keeps it as the last resort, so the macOS job still runs
// these checks.

import { build } from "esbuild";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromeCandidates } from "./findChrome.mjs";

const DESKTOP_CHROME = /Google Chrome\.app/;

/** The Chrome binary to drive, or undefined when this machine has none. */
export function findChrome(): string | undefined {
  const onCi = !!process.env.CI;
  return chromeCandidates()
    .filter((p) => onCi || !DESKTOP_CHROME.test(p))
    .find((p) => existsSync(p));
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
 * How much bigger than a frame the window around it is made. The headless
 * shell gives a page its whole --window-size, but the system Chrome the CI
 * runners have is the full browser run headless, and lays its own tab strip
 * and toolbar out inside the window, unseen: a 327px window was a 184px view
 * on the ubuntu and macOS runners and 176px on the windows one. The frame's
 * own view is exact either way: a window too short for it hides its foot
 * from the eye, and a click there still lands on what is there.
 */
const FRAME_ROOM = 200;

/** Text as the value of a double-quoted HTML attribute. */
const attr = (text: string): string => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

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
    /** The window's size — the page's view in the headless shell, but less
     *  the browser's own frame in a system Chrome (see FRAME_ROOM). */
    width?: number;
    height?: number;
    css?: string;
    /** Runs BEFORE the bundle — for an entry point that reads something at
     *  import time, like a webview entry's acquireVsCodeApi(). */
    prelude?: string;
    /** Attributes for the #root element (a webview entry reads its layout off it). */
    rootAttrs?: string;
    /**
     * Run the page in an iframe of exactly this size, the way VS Code mounts
     * a webview: its view (innerWidth × innerHeight, what fixed positioning
     * and elementFromPoint work in) is then this, whichever Chrome runs it.
     * For a check that depends on the view's own size. The window is made
     * big enough to show the frame whole; width and height are not used.
     */
    frame?: { width: number; height: number };
  } = {},
): Promise<Verdict> {
  const { js, css } = await bundle(entry);
  const dir = mkdtempSync(join(tmpdir(), "gs-webview-"));
  const page = join(dir, "page.html");
  const inner = `<!doctype html><html><head><meta charset="utf-8"><title>PENDING</title>
<style>${css}</style>
<style>html,body{margin:0;height:100%;overflow:hidden}${opts.css ?? ""}</style></head>
<body><div id="root" ${opts.rootAttrs ?? ""}></div>
<script>${opts.prelude ?? ""}</script>
<script>${js}</script>
<script>
window.verdict = (v) => {
  document.title = "CHECK " + JSON.stringify(v);
  // In a frame the verdict goes up to the page --dump-dom reads.
  if (window.parent !== window) window.parent.postMessage({ gsVerdict: v }, "*");
};
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
  const { frame } = opts;
  // The frame's page is its srcdoc; the verdict comes up from it by message.
  const html = frame
    ? `<!doctype html><html><head><meta charset="utf-8"><title>PENDING</title>
<style>html,body{margin:0;overflow:hidden}iframe{display:block;border:0;width:${frame.width}px;height:${frame.height}px}</style></head>
<body><script>
window.addEventListener("message", (e) => {
  if (e.data && e.data.gsVerdict) document.title = "CHECK " + JSON.stringify(e.data.gsVerdict);
});
</script><iframe srcdoc="${attr(inner)}"></iframe></body></html>`
    : inner;
  writeFileSync(page, html);
  const width = frame ? frame.width + FRAME_ROOM : (opts.width ?? 420);
  const height = frame ? frame.height + FRAME_ROOM : (opts.height ?? 800);
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
