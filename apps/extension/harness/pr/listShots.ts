// Screenshots of the Pull Requests view — the sidebar list — per situation
// and per theme (Dark+, Light+, Dark High Contrast, Light High Contrast), as
// the real page is written (src/pr/prListHtml.ts) around the real bundle
// (packages/webview-ui/src/pr/list-main.ts), under its OWN Content-Security-
// Policy, in a windowless Chrome. The theme's colours reach the page the way
// VS Code hands them over — through the CSSOM, onto <html> — and the states
// are posted to it as the extension host posts them.
//
//   GS_CHROME=<chrome-headless-shell> npx tsx apps/extension/harness/pr/listShots.ts [outDir] [scene…]
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
import { SIDEBAR_EXTRA } from "./themeExtras";
import { prListHtml } from "../../src/pr/prListHtml";
import { listScenes, PEOPLE } from "../../../../packages/webview-ui/test/fixtures/prListFixtures";
import type { PrListViewState } from "@gitstudio/host-bridge/prProtocol";
import { jsLiteral } from "../../../../scripts/test/js-literal.mjs";

const ROOT = join(__dirname, "..", "..", "..", "..");
const OUT = process.argv[2] && !process.argv[2].startsWith("-") ? process.argv[2] : join(ROOT, "out", "pr-list");
const ONLY = new Set(process.argv.slice(3));
const THEMES: VsCodeTheme[] = ["dark", "light", "hc-dark", "hc-light"];

/** A scene: a state, how wide the sidebar is, and what to do before the picture. */
interface Shot {
  name: string;
  state: PrListViewState;
  width?: number;
  act?: (page: Page) => Promise<void>;
}

async function mouse(page: Page, type: "mouseMoved" | "mousePressed" | "mouseReleased", x: number, y: number): Promise<void> {
  await page.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: type === "mouseMoved" ? 0 : 1 });
}

async function centerOf(page: Page, selector: string): Promise<{ x: number; y: number }> {
  const r = await page.eval<{ x: number; y: number } | null>(
    `(() => { const e = document.querySelector(${jsLiteral(selector)}); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`,
  );
  if (!r) throw new Error(`nothing matches ${selector}`);
  return r;
}

async function click(page: Page, selector: string): Promise<void> {
  const { x, y } = await centerOf(page, selector);
  await mouse(page, "mouseMoved", x, y);
  await mouse(page, "mousePressed", x, y);
  await mouse(page, "mouseReleased", x, y);
  await new Promise((r) => setTimeout(r, 120));
}

async function hover(page: Page, selector: string): Promise<void> {
  const { x, y } = await centerOf(page, selector);
  await mouse(page, "mouseMoved", x, y);
  await new Promise((r) => setTimeout(r, 250));
}

function post(state: PrListViewState): string {
  return `window.postMessage(${jsLiteral({ type: "state", state })}, "*")`;
}

function shots(): Shot[] {
  const s = listScenes();
  const withOptions = (st: PrListViewState): PrListViewState => ({
    ...st,
    seq: st.seq + 1,
    facetOptions: {
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "dependencies", color: "0366d6" },
        { name: "documentation", color: "0075ca" },
        { name: "good first issue", color: "7057ff" },
        { name: "performance", color: "fbca04" },
      ],
      people: [PEOPLE.alice, PEOPLE.bob, PEOPLE.dana, PEOPLE.eli, PEOPLE.me],
      truncated: false,
    },
  });
  return [
    { name: "open", state: s.open },
    { name: "all", state: s.all },
    { name: "filtered", state: s.filtered },
    { name: "loading", state: s.loading },
    { name: "refreshing", state: s.refreshing },
    { name: "refresh-failed", state: s.refreshFailed },
    { name: "empty-merged", state: s.emptyMerged },
    { name: "empty-open", state: s.emptyOpen },
    { name: "empty-filtered", state: s.emptyFiltered },
    { name: "signed-out", state: s.signedOut },
    { name: "not-github", state: s.notGitHub },
    { name: "expired", state: s.expired },
    { name: "offline", state: s.offline },
    { name: "fork", state: s.fork },
    { name: "narrow", state: s.open, width: 220 },
    { name: "wide", state: s.open, width: 420 },
    {
      name: "row-hover",
      state: s.open,
      act: async (page) => hover(page, '.prl-row[data-number="476"] .prl-title'),
    },
    {
      name: "row-focus",
      state: s.open,
      act: async (page) => {
        await page.eval(`document.querySelector('.prl-row[data-number="479"] .prl-row-main').focus()`);
        await new Promise((r) => setTimeout(r, 150));
      },
    },
    {
      name: "row-menu",
      state: s.open,
      act: async (page) => {
        await hover(page, '.prl-row[data-number="476"] .prl-title');
        await click(page, '.prl-row[data-number="476"] [data-act="more"]');
      },
    },
    {
      name: "filter-menu",
      state: s.open,
      act: async (page) => click(page, ".prl-filter-btn"),
    },
    {
      name: "filter-author",
      state: s.open,
      act: async (page) => {
        await page.eval(post(withOptions(s.open)));
        await click(page, ".prl-filter-btn");
        await click(page, '.prl-menu-item[data-label="Author"]');
      },
    },
    {
      name: "filter-label",
      state: s.filtered,
      act: async (page) => {
        await page.eval(post(withOptions(s.filtered)));
        await click(page, ".prl-filter-btn");
        await click(page, '.prl-menu-item[data-label="Label"]');
      },
    },
    {
      name: "target-menu",
      state: s.fork,
      act: async (page) => click(page, ".prl-target"),
    },
  ];
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const dir = mkdtempSync(join(tmpdir(), "gs-pr-list-"));
  const bundle = await build({
    entryPoints: [join(ROOT, "packages", "webview-ui", "src", "pr", "list-main.ts")],
    bundle: true,
    write: false,
    outdir: "out",
    platform: "browser",
    format: "iife",
    logLevel: "silent",
  });
  const js = bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css = bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  writeFileSync(join(dir, "pr-list.js"), js);
  writeFileSync(join(dir, "pr-list.css"), css);
  const codicons = dirname(require.resolve("@vscode/codicons/dist/codicon.css"));
  copyFileSync(join(codicons, "codicon.css"), join(dir, "codicon.css"));
  copyFileSync(join(codicons, "codicon.ttf"), join(dir, "codicon.ttf"));

  const browser = await Browser.launch({ width: 800, height: 1000 });
  let refused = 0;
  try {
    for (const theme of THEMES) {
      const vars = { ...VSCODE_THEMES[theme], ...SIDEBAR_EXTRA[theme] };
      const nonce = "harnessnonce0123456789abcdefABCDEF";
      // The theme, as VS Code hands it over: through the CSSOM, before the
      // bundle runs — never an inline style the page's own policy refuses.
      const boot = `<script nonce="${nonce}">
        const vars = ${jsLiteral(vars)};
        for (const [k, v] of Object.entries(vars)) document.documentElement.style.setProperty(k, v);
        document.body.className = ${jsLiteral(BODY_CLASS[theme])};
        window.__posted = [];
        window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState: () => undefined });
      </script>`;
      const html = prListHtml({ cspSource: "file:", nonce, codiconCss: "codicon.css", listCss: "pr-list.css", listJs: "pr-list.js" }).replace(
        '<div id="root"></div>',
        `<div id="root"></div>\n  ${boot}`,
      );
      const file = join(dir, `page-${theme}.html`);
      writeFileSync(file, html);
      for (const shot of shots()) {
        if (ONLY.size > 0 && !ONLY.has(shot.name)) continue;
        const width = shot.width ?? 300;
        const page = await browser.newPage(width, 900, 2);
        const csp: string[] = [];
        await page.send("Log.enable");
        page.on("Log.entryAdded", (p) => {
          const text = String((p as { entry?: { text?: string } }).entry?.text ?? "");
          if (/Content Security Policy|Refused/i.test(text)) csp.push(text);
        });
        await browser.goto(page, pathToFileURL(file).href);
        await page.eval(`document.fonts.ready.then(() => true)`);
        await page.eval(post(shot.state));
        await page.waitFor(`document.querySelector(".prl-head, .prl-message")`, 5000, "the list to paint");
        await new Promise((r) => setTimeout(r, 150));
        await shot.act?.(page);
        const height = await page.eval<number>(
          `Math.max(document.documentElement.scrollHeight, ...[...document.querySelectorAll(".prl-menu")].map((m) => m.getBoundingClientRect().bottom + 8))`,
        );
        const h = Math.min(Math.max(Math.ceil(height), 160), 900);
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
