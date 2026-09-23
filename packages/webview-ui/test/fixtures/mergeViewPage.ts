// Runs the REAL merge view (mergeViewEntry.ts) in headless Chrome and brings
// back a verdict — the same contract as test/headless.ts (verdict JSON in the
// page <title>, read back from --dump-dom), with two differences the merge view
// needs:
//
// - Monaco imports its own CSS, and so does the entry (diff.css). esbuild
//   cannot bundle a CSS import without an output path, so this builds into a
//   temp directory and links the emitted page.css — runInChrome's in-memory
//   bundle cannot carry it.
// - The page is themed: the body class (vscode-dark / -light / -high-contrast)
//   and the --vscode-* editor colours the host would supply.
//
// Scripts must never wait on requestAnimationFrame alone: headless Chrome under
// a virtual-time budget may service no frame at all. `sleep(ms)` is a timer.

import { build } from "esbuild";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeVerdictTitle, type Verdict } from "../headless";

export { findChrome } from "../headless";
export type { Verdict } from "../headless";

const ENTRY = fileURLToPath(new URL("./mergeViewEntry.ts", import.meta.url));

export type PageTheme = "dark" | "light" | "hc-dark" | "hc-light";

export interface PageOptions {
  theme?: PageTheme;
  /** --vscode-* variables for the body (editor background / foreground …). */
  vars?: Record<string, string>;
  width?: number;
  height?: number;
  /** Extra page CSS. */
  css?: string;
}

const BODY_CLASS: Record<PageTheme, string> = {
  dark: "vscode-dark",
  light: "vscode-light",
  "hc-dark": "vscode-high-contrast",
  "hc-light": "vscode-high-contrast vscode-high-contrast-light",
};

/** VS Code Dark+ / Light+ editor colours — the defaults when a test sets none. */
const DEFAULT_VARS: Record<PageTheme, Record<string, string>> = {
  dark: { "--vscode-editor-background": "#1e1e1e", "--vscode-editor-foreground": "#d4d4d4", "--vscode-foreground": "#cccccc" },
  light: { "--vscode-editor-background": "#ffffff", "--vscode-editor-foreground": "#000000", "--vscode-foreground": "#616161" },
  "hc-dark": { "--vscode-editor-background": "#000000", "--vscode-editor-foreground": "#ffffff", "--vscode-foreground": "#ffffff" },
  "hc-light": { "--vscode-editor-background": "#ffffff", "--vscode-editor-foreground": "#292929", "--vscode-foreground": "#292929" },
};

let bundleDir: Promise<string> | undefined;

/** Builds page.js + page.css once per test process. */
function bundle(): Promise<string> {
  bundleDir ??= (async () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-merge-page-"));
    process.on("exit", () => rmSync(dir, { recursive: true, force: true }));
    await build({
      entryPoints: { page: ENTRY },
      bundle: true,
      outdir: dir,
      platform: "browser",
      format: "iife",
      loader: { ".ttf": "dataurl" },
      logLevel: "silent",
    });
    return dir;
  })();
  return bundleDir;
}

let pageCount = 0;

/**
 * Mount the merge-view page and run `script` in it. The script has `gsMerge`
 * (the entry's exports), `expect(cond, what)`, `notes`, `sleep(ms)` and
 * `mountView(payload, init)` (a MergeView in a 1400×600 container, rendered).
 */
export async function runMergePage(
  chrome: string,
  script: string,
  opts: PageOptions = {},
): Promise<Verdict> {
  const dir = await bundle();
  const theme = opts.theme ?? "dark";
  const vars = { ...DEFAULT_VARS[theme], ...(opts.vars ?? {}) };
  const style = Object.entries(vars)
    .map(([k, v]) => `${k}:${v}`)
    .join(";");
  const page = join(dir, `page-${process.pid}-${pageCount++}.html`);
  const width = opts.width ?? 1400;
  const height = opts.height ?? 800;
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>PENDING</title>
<link rel="stylesheet" href="page.css">
<style>html,body{margin:0;height:100%;overflow:hidden;background:var(--vscode-editor-background);color:var(--vscode-foreground)}
#host{position:relative;width:1400px;height:600px}${opts.css ?? ""}</style></head>
<body class="${BODY_CLASS[theme]}" style="${style}"><div id="slot"></div><div id="host"></div>
<script src="page.js"></script>
<script>
window.verdict = (v) => { document.title = "CHECK " + JSON.stringify(v); };
window.addEventListener("error", (e) => window.verdict({ fails: ["page error: " + (e.message || e.error)] }));
window.addEventListener("unhandledrejection", (e) => {
  // Monaco's CancellationError: disposing an editor cancels its word
  // highlighter's pending Delayer, whose promise nobody awaits. It is Monaco's
  // own noise on every teardown (the desktop lists it in benignErrors.ts);
  // anything else is a real failure.
  const r = e.reason;
  if (r && r.name === "Canceled" && r.message === "Canceled") return;
  window.verdict({ fails: ["rejection: " + (r && r.message || r)] });
});
(async () => {
  const fails = [];
  const notes = {};
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = document.getElementById("host");
  const mountView = (payload, init) => {
    const view = new gsMerge.MergeView(host);
    view.render(payload, init);
    return view;
  };
  try {
    ${script}
  } catch (err) {
    fails.push("threw: " + (err && err.stack || err));
  }
  window.verdict({ fails, notes });
})();
</script></body></html>`;
  writeFileSync(page, html);
  return new Promise((res) => {
    execFile(
      chrome,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        "--no-sandbox",
        "--allow-file-access-from-files",
        `--window-size=${width},${height}`,
        "--virtual-time-budget=20000",
        "--dump-dom",
        `file://${page}`,
      ],
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        rmSync(page, { force: true });
        if (err && !stdout) return res({ fails: [`chrome failed: ${err.message}`] });
        const m = /<title>CHECK ([\s\S]*?)<\/title>/.exec(stdout);
        if (!m) {
          const t = /<title>([\s\S]*?)<\/title>/.exec(stdout);
          return res({ fails: [`no verdict (title was ${JSON.stringify(t?.[1] ?? "")})`] });
        }
        try {
          // One decoder for both harnesses (it decodes &amp; last).
          res(JSON.parse(decodeVerdictTitle(m[1])));
        } catch {
          res({ fails: [`unparseable verdict: ${m[1].slice(0, 200)}`] });
        }
      },
    );
  });
}
