// The Changes view's REAL document, mounted in headless Chrome.
//
// Its HTML, CSS and script are one template literal in commitView.ts, which
// no compiler looks inside — so the only honest check of what it does is to
// run it. This lifts that literal out of the source verbatim (it is a
// String.raw, so the text in the file IS the text the webview gets), fills its
// four holes, stubs acquireVsCodeApi to record what the page posts, and paints
// it in VS Code's Default Dark+ / Light+ colours.
//
// The browser is test/findChrome.mjs's choice via packages/webview-ui's
// headless.ts: GS_CHROME, then Playwright's windowless chrome-headless-shell —
// never the desktop Chrome on a Mac.

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeVerdictTitle, findChrome } from "../../../packages/webview-ui/test/headless";

export { findChrome };

const ROOT = join(__dirname, "..", "..", "..");

/** VS Code's Default Dark+ / Light+ values for what the Changes view reads. */
export const THEMES = {
  dark: {
    bodyClass: "vscode-dark",
    vars: {
      "--vscode-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "--vscode-font-size": "13px",
      "--vscode-editor-font-family": "Menlo, Monaco, 'Courier New', monospace",
      "--vscode-foreground": "#cccccc",
      "--vscode-descriptionForeground": "rgba(204, 204, 204, 0.7)",
      "--vscode-sideBar-background": "#252526",
      "--vscode-editor-background": "#1e1e1e",
      "--vscode-editorWidget-background": "#252526",
      "--vscode-focusBorder": "#007fd4",
      "--vscode-list-hoverBackground": "#2a2d2e",
      "--vscode-input-background": "#3c3c3c",
      "--vscode-input-foreground": "#cccccc",
      "--vscode-button-background": "#0e639c",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-textLink-foreground": "#3794ff",
      "--vscode-badge-background": "#4d4d4d",
      "--vscode-badge-foreground": "#ffffff",
      "--vscode-menu-background": "#252526",
      "--vscode-menu-border": "#454545",
      "--vscode-errorForeground": "#f48771",
      "--vscode-charts-green": "#89d185",
      "--vscode-charts-blue": "#3794ff",
      "--vscode-charts-red": "#f14c4c",
      "--vscode-charts-yellow": "#cca700",
      "--vscode-charts-purple": "#b180d7",
    },
  },
  light: {
    bodyClass: "vscode-light",
    vars: {
      "--vscode-font-family": "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
      "--vscode-font-size": "13px",
      "--vscode-editor-font-family": "Menlo, Monaco, 'Courier New', monospace",
      "--vscode-foreground": "#616161",
      "--vscode-descriptionForeground": "#717171",
      "--vscode-sideBar-background": "#f3f3f3",
      "--vscode-editor-background": "#ffffff",
      "--vscode-editorWidget-background": "#f3f3f3",
      "--vscode-focusBorder": "#0090f1",
      "--vscode-list-hoverBackground": "#e8e8e8",
      "--vscode-input-background": "#ffffff",
      "--vscode-input-foreground": "#616161",
      "--vscode-button-background": "#007acc",
      "--vscode-button-foreground": "#ffffff",
      "--vscode-textLink-foreground": "#006ab1",
      "--vscode-badge-background": "#c4c4c4",
      "--vscode-badge-foreground": "#333333",
      "--vscode-menu-background": "#ffffff",
      "--vscode-menu-border": "#d4d4d4",
      "--vscode-errorForeground": "#a1260d",
      "--vscode-charts-green": "#388a34",
      "--vscode-charts-blue": "#1a85ff",
      "--vscode-charts-red": "#e51400",
      "--vscode-charts-yellow": "#bf8803",
      "--vscode-charts-purple": "#652d90",
    },
  },
} as const;

export type ThemeName = keyof typeof THEMES;

/** The Changes view's document template, exactly as commitView.ts holds it. */
function template(): string {
  const src = readFileSync(join(__dirname, "..", "src", "changes", "commitView.ts"), "utf8");
  const open = "return String.raw`";
  const start = src.indexOf(open + "<!DOCTYPE html>");
  const end = src.indexOf("</html>`;", start);
  if (start < 0 || end < 0) throw new Error("the Changes view's HTML template was not found");
  return src.slice(start + open.length, end + "</html>".length);
}

/**
 * The Changes view document with `harness` run after its own script. The
 * harness sees `post(data)` (a host message), `posted` (what the page sent),
 * `tick()` (a macrotask), `expect(cond, what)`, `fails`, `notes`, and ends
 * the run by the verdict it returns. `width` narrows the body to a sidebar.
 */
export function changesViewPage(opts: { theme: ThemeName; harness: string; width?: number }): string {
  const theme = THEMES[opts.theme];
  const codicons = pathToFileURL(join(ROOT, "node_modules", "@vscode", "codicons", "dist", "codicon.css")).href;
  const tokens = readFileSync(join(ROOT, "packages", "webview-ui", "src", "styles", "tokens.css"), "utf8");
  const vars = Object.entries(theme.vars).map(([k, v]) => `${k}:${v};`).join("");
  const width = opts.width ? `body{width:${opts.width}px;min-height:100vh}` : "";
  const prelude = `<style>:root{${vars}} html{background:${theme.vars["--vscode-sideBar-background"]}} ${width}</style>
<script>
  window.posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.posted.push(JSON.parse(JSON.stringify(m === undefined ? null : m))),
    getState: () => undefined,
    setState: () => undefined,
  });
</script>`;
  const harness = `<script>
(async () => {
  const fails = [];
  const notes = {};
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    ${opts.harness}
  } catch (err) {
    fails.push("threw: " + (err && err.stack || err));
  }
  document.title = "CHECK " + JSON.stringify({ fails, notes });
})();
</script>`;
  return template()
    .replace("${csp}", "default-src * 'unsafe-inline' file: data:")
    .replace("${codiconUri}", () => codicons)
    .replace("${tokensCss}", () => tokens)
    .split("${nonce}").join("harness")
    .replace('<body class="layout-list">', () => `<body class="layout-list ${theme.bodyClass}">`)
    .replace("</head>", () => `${prelude}\n</head>`)
    .replace("</body>", () => `${harness}\n</body>`);
}

/** A "state" message as doPushState posts it, for a clean repository. */
export function statePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "state",
    hasRepo: true,
    merge: [],
    staged: [],
    unstaged: [{ path: "src/server.ts", status: "M" }, { path: "src/routes/login.ts", status: "M" }, { path: "README.md", status: "M" }],
    stagedCount: 0,
    stagingModel: "split",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    unpushed: 0,
    canPublish: true,
    repoName: "api",
    repoCount: 3,
    repoPath: "code/api",
    signoffDefault: false,
    aiEnabled: false,
    layout: "list",
    busy: false,
    ...over,
  };
}

function launch(chrome: string, page: string, args: string[], size: { width: number; height: number }) {
  const dir = mkdtempSync(join(tmpdir(), "gs-changes-view-"));
  const file = join(dir, "page.html");
  writeFileSync(file, page);
  return {
    dir,
    run: (extra: string[]) =>
      new Promise<string>((resolve, reject) => {
        execFile(
          chrome,
          [
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--no-sandbox",
            "--allow-file-access-from-files",
            `--user-data-dir=${join(dir, "profile")}`,
            `--window-size=${size.width},${size.height}`,
            "--virtual-time-budget=5000",
            ...args,
            ...extra,
            pathToFileURL(file).href,
          ],
          { maxBuffer: 64 * 1024 * 1024, timeout: 60_000, killSignal: "SIGKILL" },
          (err, stdout) => (err && !stdout ? reject(err) : resolve(stdout)),
        );
      }),
  };
}

/** Run the page and bring back the harness's verdict. */
export async function runChangesView(
  chrome: string,
  page: string,
  size = { width: 520, height: 560 },
): Promise<{ fails: string[]; notes: Record<string, unknown> }> {
  const { dir, run } = launch(chrome, page, [], size);
  try {
    const dom = await run(["--dump-dom"]);
    const m = /<title>CHECK ([\s\S]*?)<\/title>/.exec(dom);
    if (!m) {
      const t = /<title>([\s\S]*?)<\/title>/.exec(dom);
      return { fails: [`no verdict (title was ${JSON.stringify(t?.[1] ?? "")})`], notes: {} };
    }
    return JSON.parse(decodeVerdictTitle(m[1]));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}

/** Screenshot the page after its harness has run. */
export async function screenshotChangesView(
  chrome: string,
  page: string,
  out: string,
  size = { width: 520, height: 560 },
): Promise<void> {
  const { dir, run } = launch(chrome, page, [], size);
  try {
    await run([`--screenshot=${out}`]);
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  }
}
