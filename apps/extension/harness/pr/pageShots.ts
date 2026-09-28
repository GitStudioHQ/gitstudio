// Screenshots of a pull request's page — per situation and per theme (Dark+,
// Light+, Dark High Contrast, Light High Contrast) — as the real page is
// written (src/pr/prPageHtml.ts) around the real bundle
// (packages/webview-ui/src/pr/page-main.ts), under its OWN Content-Security-
// Policy, in a windowless Chrome. The theme reaches the page the way VS Code
// hands it over — through the CSSOM, onto <html> — and the states are posted
// to it as the extension host posts them.
//
//   GS_CHROME=<chrome-headless-shell> npx tsx apps/extension/harness/pr/pageShots.ts [outDir] [scene…]
//
// Writes <scene>-<theme>.png, and exits non-zero if the policy refused
// anything or the page threw.

import { build } from "esbuild";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Browser, type Page } from "../../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../../scripts/merge-e2e/themes";
import { prPageHtml } from "../../src/pr/prPageHtml";
import { pageScenes } from "../../../../packages/webview-ui/test/fixtures/prPageFixtures";
import type { PrPageViewState } from "@gitstudio/host-bridge/prProtocol";
import { SIDEBAR_EXTRA } from "./themeExtras";
import { jsLiteral } from "../../../../scripts/test/js-literal.mjs";

const ROOT = join(__dirname, "..", "..", "..", "..");
const OUT = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : join(ROOT, "out", "pr-page");
const ONLY = new Set(process.argv.slice(3));
const THEMES: VsCodeTheme[] = ["dark", "light", "hc-dark", "hc-light"];

/** What an editor webview reads that the merge fixtures leave out. */
const EDITOR_EXTRA: Record<VsCodeTheme, Record<string, string>> = {
  dark: {
    "--vscode-textPreformat-background": "rgba(255, 255, 255, 0.1)",
    "--vscode-textCodeBlock-background": "rgba(10, 10, 10, 0.4)",
    "--vscode-textLink-activeForeground": "#3794ff",
    "--vscode-widget-border": "#303031",
  },
  light: {
    "--vscode-textPreformat-background": "rgba(0, 0, 0, 0.1)",
    "--vscode-textCodeBlock-background": "rgba(220, 220, 220, 0.4)",
    "--vscode-textLink-activeForeground": "#006ab1",
    "--vscode-widget-border": "#d4d4d4",
  },
  "hc-dark": {
    "--vscode-textPreformat-background": "#000000",
    "--vscode-textCodeBlock-background": "#000000",
    "--vscode-textLink-activeForeground": "#21a6ff",
  },
  "hc-light": {
    "--vscode-textPreformat-background": "#ffffff",
    "--vscode-textCodeBlock-background": "#ffffff",
    "--vscode-textLink-activeForeground": "#0f4a85",
  },
};

interface Shot {
  name: string;
  state: PrPageViewState;
  width?: number;
  act?: (page: Page) => Promise<void>;
}

async function mouse(page: Page, type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number): Promise<void> {
  await page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const r = await page.eval<{ x: number; y: number } | null>(
    `(() => { const e = document.querySelector(${jsLiteral(selector)}); if (!e) return null; e.scrollIntoView({ block: "center" }); const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${selector}`);
  return r;
}

async function click(page: Page, selector: string): Promise<void> {
  const { x, y } = await centerOf(page, selector);
  await mouse(page, "mouseMoved", x, y);
  await mouse(page, "mousePressed", x, y);
  await mouse(page, "mouseReleased", x, y);
  await new Promise((r) => setTimeout(r, 150));
}

function post(state: PrPageViewState): string {
  return `window.postMessage(${jsLiteral({ type: "state", state })}, "*")`;
}

function shots(): Shot[] {
  const s = pageScenes();
  return [
    { name: "open", state: s.open },
    { name: "ready", state: s.ready },
    { name: "behind", state: s.behind },
    { name: "conflicts", state: s.conflicts },
    { name: "draft", state: s.draft },
    { name: "merged", state: s.merged },
    { name: "closed", state: s.closed },
    { name: "reader", state: s.reader },
    { name: "loading", state: s.loading },
    { name: "failed", state: s.failed },
    { name: "refresh-failed", state: s.refreshFailed },
    { name: "merge-box", state: s.mergeBox },
    // The list's Merge… on a page still loading: the box once it has loaded —
    // or, when it can't be merged, the keyboard on the line that says why.
    {
      name: "merge-asked-ready",
      state: { ...s.loading, focus: { seq: 5, open: "merge" } },
      act: async (page) => {
        await page.eval(post({ ...s.ready, seq: 50, focus: { seq: 5, open: "merge" } }));
        await new Promise((r) => setTimeout(r, 200));
      },
    },
    {
      name: "merge-asked-draft",
      state: { ...s.loading, focus: { seq: 5, open: "merge" } },
      act: async (page) => {
        await page.eval(post({ ...s.draft, seq: 50, focus: { seq: 5, open: "merge" } }));
        await new Promise((r) => setTimeout(r, 200));
      },
    },
    {
      name: "merge-asked-blocked",
      state: { ...s.loading, focus: { seq: 5, open: "merge" } },
      act: async (page) => {
        await page.eval(post({ ...s.open, seq: 50, focus: { seq: 5, open: "merge" } }));
        await new Promise((r) => setTimeout(r, 200));
      },
    },
    { name: "merging", state: s.merging },
    { name: "review-box", state: s.reviewBox },
    { name: "review-own", state: s.reviewOwn },
    { name: "review-stale", state: s.reviewStale },
    {
      name: "discard-confirm",
      state: s.reviewBox,
      act: async (page) => click(page, '[data-act="discard"]'),
    },
    {
      name: "commits",
      state: s.commits,
      act: async (page) => click(page, `[data-key="commit-row-${"1".repeat(40)}"]`),
    },
    { name: "checks", state: s.checks },
    { name: "files", state: s.files },
    { name: "files-empty", state: s.filesEmpty },
    { name: "no-description", state: s.noDescription },
    {
      name: "more-menu",
      state: s.open,
      act: async (page) => click(page, '[data-act="more"]'),
    },
    {
      name: "resolved-shown",
      state: s.open,
      act: async (page) => click(page, '[data-act="toggleThread"]'),
    },
    { name: "narrow", state: s.open, width: 480 },
    { name: "narrow-files", state: s.files, width: 480 },
    { name: "wide", state: s.open, width: 1440 },
  ];
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "gs-pr-page-"));
  const bundle = await build({
    entryPoints: [join(ROOT, "packages", "webview-ui", "src", "pr", "page-main.ts")],
    bundle: true,
    write: false,
    outdir: "out",
    platform: "browser",
    format: "iife",
    logLevel: "silent",
  });
  writeFileSync(join(dir, "pr-page.js"), bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text);
  writeFileSync(join(dir, "pr-page.css"), bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "");
  const codicons = dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
  copyFileSync(join(codicons, "codicon.css"), join(dir, "codicon.css"));
  copyFileSync(join(codicons, "codicon.ttf"), join(dir, "codicon.ttf"));

  const browser = await Browser.launch({ width: 1000, height: 1000 });
  let refused = 0;
  try {
    for (const theme of THEMES) {
      const vars = { ...VSCODE_THEMES[theme], ...SIDEBAR_EXTRA[theme], ...EDITOR_EXTRA[theme] };
      const nonce = "harnessnonce0123456789abcdefABCDEF";
      const boot = `<script nonce="${nonce}">
        const vars = ${jsLiteral(vars)};
        for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
        document.body.className = ${jsLiteral(BODY_CLASS[theme])};
        window.__posted = [];
        window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => undefined });
      </script>`;
      const html = prPageHtml({ cspSource: "file:", nonce, codiconCss: "codicon.css", pageCss: "pr-page.css", pageJs: "pr-page.js", mergeMethod: "squash", title: "acme/webapp#482" }).replace(
        /<div id="root"([^>]*)><\/div>/,
        (m) => `${m}\n  ${boot}`,
      );
      const file = join(dir, `page-${theme}.html`);
      writeFileSync(file, html);
      for (const shot of shots()) {
        if (ONLY.size > 0 && !ONLY.has(shot.name)) continue;
        const width = shot.width ?? 1000;
        const page = await browser.newPage(width, 1000, 1);
        const csp: string[] = [];
        await page.send("Log.enable");
        page.on("Log.entryAdded", (p) => {
          const text = String((p as { entry?: { text?: string } }).entry?.text ?? "");
          if (/Content Security Policy|Refused/i.test(text)) csp.push(text);
        });
        await browser.goto(page, pathToFileURL(file).href);
        await page.eval(`document.fonts.ready.then(() => true)`);
        await page.eval(post(shot.state));
        await page.waitFor(`document.querySelector(".prp-head, .prp-message")`, 5000, "the page to paint");
        await new Promise((r) => setTimeout(r, 200));
        // The whole page in one picture: the view grows to it first (a
        // capture stops at the view's edge, and a resize closes a menu), then
        // the scene is acted, then it is taken.
        const fit = async () => {
          const height = await page.eval<number>(`document.documentElement.scrollHeight`);
          const h = Math.min(Math.max(Math.ceil(height), 300), 2600);
          await page.send("Emulation.setDeviceMetricsOverride", { width, height: h, deviceScaleFactor: 1, mobile: false });
          await new Promise((r) => setTimeout(r, 150));
          return h;
        };
        await fit();
        await shot.act?.(page);
        const h = shot.act && (await page.eval<boolean>(`!!document.querySelector(".prp-menu")`)) ? await page.eval<number>(`window.innerHeight`) : await fit();
        const png = join(OUT, `${shot.name}-${theme}.png`);
        writeFileSync(png, await page.screenshot({ x: 0, y: 0, width, height: h }));
        const problems = [...csp, ...page.errors];
        console.log(`${png}${problems.length ? `\n  REFUSED/ERRORS: ${JSON.stringify(problems)}` : ""}`);
        refused += problems.length;
        await browser.closePage(page);
      }
    }
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
  if (refused > 0) process.exitCode = 1;
}

void main();
