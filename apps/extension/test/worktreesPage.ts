// The Worktrees view's webview, rendered for real: the bundle the extension
// ships (packages/webview-ui/src/worktrees/main.ts, built here by the same
// esbuild entry), in a windowless Chrome, driven over the DevTools protocol
// with real key and mouse events. Not a test itself — worktreesWebview.test.ts
// and the screenshot harness (harness/worktrees/shots.ts) mount it.
//
// VS Code's theme arrives as it does in a real webview: --vscode-* variables
// on <html> and a theme class on <body> (scripts/merge-e2e/themes.ts, plus the
// menu / input / list tokens this view reads). The host is a stub that records
// what the page posts; the test plays the host with `send`.
//
// The browser is findChrome()'s — GS_CHROME, else Playwright's windowless
// chrome-headless-shell — never the desktop Chrome on a Mac (memory:
// headless-tests-never-drive-users-chrome). A machine with none skips.

import { build } from "esbuild";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChrome } from "../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../scripts/merge-e2e/cdp";
import {
  BODY_CLASS,
  VSCODE_MODERN_BASE,
  VSCODE_MODERN_THEMES,
  VSCODE_THEMES,
  type VsCodeModernTheme,
  type VsCodeTheme as ClassicTheme,
} from "../../../scripts/merge-e2e/themes";

/** Every theme this page is rendered in: the four built-in kinds, and Light
 *  Modern and Dark Modern — a fresh install's defaults. */
export type VsCodeTheme = ClassicTheme | VsCodeModernTheme;

const isModern = (t: VsCodeTheme): t is VsCodeModernTheme => t in VSCODE_MODERN_BASE;
/** The theme kind VS Code puts on <body> (a Modern theme is its base's kind). */
const kindOf = (t: VsCodeTheme): ClassicTheme => (isModern(t) ? VSCODE_MODERN_BASE[t] : t);

const HERE = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const ENTRY = HERE("../../../packages/webview-ui/src/worktrees/main.ts");
const CODICONS = HERE("../../../node_modules/@vscode/codicons/dist/codicon.css");

/** The menu, input and hover tokens this view reads that themes.ts has no need for. */
const VIEW_TOKENS: Record<VsCodeTheme, Record<string, string>> = {
  dark: {
    "--vscode-menu-background": "#252526",
    "--vscode-menu-foreground": "#cccccc",
    "--vscode-menu-border": "#454545",
    "--vscode-input-background": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-placeholderForeground": "#a6a6a6",
    "--vscode-toolbar-hoverBackground": "rgba(90, 93, 94, 0.31)",
    "--vscode-editorHoverWidget-background": "#252526",
    "--vscode-editorHoverWidget-border": "#454545",
    "--vscode-editorHoverWidget-foreground": "#cccccc",
  },
  light: {
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-foreground": "#616161",
    "--vscode-menu-border": "#d4d4d4",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#616161",
    "--vscode-input-border": "#cecece",
    "--vscode-input-placeholderForeground": "#767676",
    "--vscode-toolbar-hoverBackground": "rgba(184, 184, 184, 0.31)",
    "--vscode-editorHoverWidget-background": "#f3f3f3",
    "--vscode-editorHoverWidget-border": "#c8c8c8",
    "--vscode-editorHoverWidget-foreground": "#616161",
  },
  "hc-dark": {
    "--vscode-menu-background": "#000000",
    "--vscode-menu-border": "#6fc3df",
    "--vscode-menu-foreground": "#ffffff",
    "--vscode-input-background": "#000000",
    "--vscode-input-foreground": "#ffffff",
    "--vscode-input-border": "#6fc3df",
    "--vscode-contrastActiveBorder": "#f38518",
    "--vscode-contrastBorder": "#6fc3df",
    "--vscode-editorHoverWidget-background": "#0c141f",
    "--vscode-editorHoverWidget-border": "#6fc3df",
  },
  "hc-light": {
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-border": "#0f4a85",
    "--vscode-menu-foreground": "#292929",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#292929",
    "--vscode-input-border": "#0f4a85",
    "--vscode-contrastActiveBorder": "#006bbd",
    "--vscode-contrastBorder": "#0f4a85",
    "--vscode-editorHoverWidget-background": "#ffffff",
    "--vscode-editorHoverWidget-border": "#0f4a85",
  },
  // Light Modern leaves the menu, input and hover colours to its defaults:
  // the dropdown's for the menu, the widget's for the hover.
  "light-modern": {
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-foreground": "#3b3b3b",
    "--vscode-menu-border": "#cecece",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#3b3b3b",
    "--vscode-input-border": "#cecece",
    "--vscode-input-placeholderForeground": "#767676",
    "--vscode-toolbar-hoverBackground": "rgba(184, 184, 184, 0.31)",
    "--vscode-editorHoverWidget-background": "#f8f8f8",
    "--vscode-editorHoverWidget-border": "#c8c8c8",
    "--vscode-editorHoverWidget-foreground": "#3b3b3b",
  },
  "dark-modern": {
    "--vscode-menu-background": "#1f1f1f",
    "--vscode-menu-foreground": "#cccccc",
    "--vscode-menu-border": "#454545",
    "--vscode-input-background": "#313131",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-border": "#3c3c3c",
    "--vscode-input-placeholderForeground": "#989898",
    "--vscode-toolbar-hoverBackground": "rgba(90, 93, 94, 0.31)",
    "--vscode-editorHoverWidget-background": "#202020",
    "--vscode-editorHoverWidget-border": "#454545",
    "--vscode-editorHoverWidget-foreground": "#cccccc",
  },
};

/** Stands in for the host: records every message the page posts, and delivers the host's. */
const HOST_STUB = `
window.__posted = [];
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (m) { window.__posted.push(JSON.parse(JSON.stringify(m))); },
    getState: function () { return undefined; },
    setState: function () {},
  };
};
window.__send = function (msg) { window.dispatchEvent(new MessageEvent("message", { data: msg })); };
`;

let bundled: Promise<{ js: string; css: string }> | undefined;

/** The worktrees bundle, built once per run from the extension's own entry. */
export function worktreesBundle(): Promise<{ js: string; css: string }> {
  bundled ??= build({
    entryPoints: [ENTRY],
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
  return bundled;
}

/** The page VS Code would show, with the theme's variables and the host stub. */
export async function worktreesHtml(theme: VsCodeTheme): Promise<string> {
  const { js, css } = await worktreesBundle();
  const vars = { ...(isModern(theme) ? VSCODE_MODERN_THEMES[theme] : VSCODE_THEMES[theme]), ...VIEW_TOKENS[theme] };
  const style = Object.entries(vars)
    .map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`)
    .join(";");
  const safe = (s: string) => s.replace(/<\/script/gi, "<\\/script");
  return `<!DOCTYPE html><html lang="en" style="${style}"><head><meta charset="UTF-8" />
<script>${HOST_STUB}</script>
<link href="${pathToFileURL(CODICONS).href}" rel="stylesheet" />
<style>${css}</style>
</head><body class="${BODY_CLASS[kindOf(theme)]}"><div id="root"></div>
<script>${safe(js)}</script>
</body></html>`;
}

const KEYS: Record<string, { code: string; vk: number }> = {
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Enter: { code: "Enter", vk: 13 },
  Escape: { code: "Escape", vk: 27 },
  Tab: { code: "Tab", vk: 9 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  Delete: { code: "Delete", vk: 46 },
  Backspace: { code: "Backspace", vk: 8 },
  " ": { code: "Space", vk: 32 },
  F10: { code: "F10", vk: 121 },
};
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;

/** The Worktrees view in a browser tab, with the ways a person reaches it. */
export class WorktreesPage {
  private constructor(
    private readonly browser: Browser,
    readonly page: Page,
    private readonly dir: string,
  ) {}

  static chrome(): string | undefined {
    return findChrome();
  }

  static async open(
    theme: VsCodeTheme,
    opts: { width?: number; height?: number; scale?: number } = {},
  ): Promise<WorktreesPage> {
    const chrome = findChrome();
    if (!chrome) throw new Error("no windowless Chrome on this machine (set GS_CHROME)");
    process.env.GS_CHROME = chrome;
    const width = opts.width ?? 300;
    const height = opts.height ?? 640;
    const browser = await Browser.launch({ width: Math.max(width, 500), height });
    const page = await browser.newPage(width, height, opts.scale ?? 1);
    const dir = mkdtempSync(join(tmpdir(), "gs-worktrees-page-"));
    const file = join(dir, "worktrees.html");
    writeFileSync(file, await worktreesHtml(theme));
    await browser.goto(page, pathToFileURL(file).href);
    await page.waitFor(`typeof window.__send === "function" && window.__posted.some(function (m) { return m.type === "ready"; })`);
    // No motion: a transition caught mid-way reads as a colour nobody sees.
    await page.eval(`(function () { var s = document.createElement("style");
      s.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
      document.head.appendChild(s); })()`);
    await page.eval(`document.fonts ? document.fonts.ready.then(function () { return true; }) : true`);
    return new WorktreesPage(browser, page, dir);
  }

  eval<T = unknown>(expression: string): Promise<T> {
    return this.page.eval<T>(expression);
  }

  async send(msg: unknown): Promise<void> {
    await this.page.eval(`window.__send(${JSON.stringify(msg)})`);
  }

  posted(): Promise<Record<string, unknown>[]> {
    return this.page.eval("window.__posted");
  }

  async clearPosted(): Promise<void> {
    await this.page.eval("window.__posted.length = 0");
  }

  /** A real key press on whatever has focus. */
  async key(name: keyof typeof KEYS | string, opts: { with?: (keyof typeof MODIFIERS)[] } = {}): Promise<void> {
    const k = KEYS[name];
    if (!k) throw new Error(`no key mapping for ${name}`);
    const modifiers = (opts.with ?? []).reduce((m, x) => m | MODIFIERS[x], 0);
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, modifiers };
    const text = name === " " ? { text: " " } : name === "Enter" ? { text: "\r" } : {};
    await this.page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    if ("text" in text) await this.page.send("Input.dispatchKeyEvent", { type: "char", ...base, ...text });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  async type(text: string): Promise<void> {
    await this.page.send("Input.insertText", { text });
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async click(x: number, y: number, button: "left" | "right" = "left"): Promise<void> {
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await this.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button, clickCount: 1 });
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button, clickCount: 1 });
  }

  /** Click the middle of the first element `selector` matches. */
  async clickOn(selector: string, button: "left" | "right" = "left"): Promise<void> {
    const r = await this.page.eval<{ x: number; y: number } | null>(`(function () {
      var n = document.querySelector(${JSON.stringify(selector)});
      if (!n) return null;
      n.scrollIntoView({ block: "nearest" });
      var b = n.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    })()`);
    if (!r) throw new Error(`nothing matches ${selector}`);
    await this.click(r.x, r.y, button);
  }

  /**
   * Resize the page, then wait until the rows are fitted to the new width.
   * The view refits on a debounced ResizeObserver, and a scrollbar coming or
   * going resizes it once more: a fixed wait measured half-fitted rows on
   * slow CI runners.
   */
  async resize(width: number, height = 900): Promise<void> {
    await this.page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
    const deadline = Date.now() + 10_000;
    for (let steady = 0; steady < 3; ) {
      if (Date.now() > deadline) throw new Error(`the rows were never fitted to ${width}px`);
      const fitted = await this.page.eval<boolean>(`(function () { var l = document.querySelector(".wt-list"); return !!l && l.dataset.fitted === String(l.clientWidth); })()`);
      steady = fitted ? steady + 1 : 0;
      await this.settle(30);
    }
  }

  /** Let the page settle: a macrotask, and a frame. */
  async settle(ms = 40): Promise<void> {
    await this.page.eval(`new Promise(function (r) { setTimeout(function () { r(true); }, ${ms}); })`);
  }

  async screenshot(path: string): Promise<void> {
    writeFileSync(path, await this.page.screenshot());
  }

  errors(): string[] {
    return this.page.errors;
  }

  async close(): Promise<void> {
    await this.browser.close();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* the OS tmpdir is swept anyway */
    }
  }
}
