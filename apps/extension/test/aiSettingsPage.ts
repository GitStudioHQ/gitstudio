// The GitStudio · AI settings panel, rendered for real: the page its html()
// returns, in a windowless Chrome, with VS Code's theme tokens on <html> and
// the theme's class on <body>, as a webview gets them. Not a test itself —
// aiSettingsTheme.test.ts and harness/ai-settings/shots.ts mount it.
//
// html() is private and needs a Webview for its URIs: it runs here against a
// stand-in webview under the vscode stub, with tokens.css loaded as text the
// way esbuild inlines it. The browser is findChrome()'s (GS_CHROME, else
// Playwright's chrome-headless-shell) — never the desktop Chrome.

import Module from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChrome } from "../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
const STUB = fileURLToPath(new URL("./vscodeStub.cjs", import.meta.url));
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : resolve.call(this, request, ...rest);
};
const loaders = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })
  ._extensions;
loaders[".css"] = (m, f) => {
  m.exports = readFileSync(f, "utf8");
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { AiSettingsPanel } = require("../src/ai/aiSettingsPanel") as typeof import("../src/ai/aiSettingsPanel");
/* eslint-enable @typescript-eslint/no-require-imports */

const CODICONS = fileURLToPath(new URL("../../../node_modules/@vscode/codicons/dist/codicon.css", import.meta.url));

/** A few tokens the panel reads that themes.ts has no need for. */
const EXTRA: Record<VsCodeTheme, Record<string, string>> = {
  dark: {
    "--vscode-input-background": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-placeholderForeground": "#a6a6a6",
  },
  light: {
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#616161",
    "--vscode-input-border": "#cecece",
    "--vscode-input-placeholderForeground": "#767676",
  },
  "hc-dark": {
    "--vscode-input-background": "#000000",
    "--vscode-input-foreground": "#ffffff",
    "--vscode-input-border": "#6fc3df",
    "--vscode-contrastBorder": "#6fc3df",
    "--vscode-contrastActiveBorder": "#f38518",
  },
  "hc-light": {
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#292929",
    "--vscode-input-border": "#0f4a85",
    "--vscode-contrastBorder": "#0f4a85",
    "--vscode-contrastActiveBorder": "#006bbd",
  },
};

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

/** The panel's page for `theme`, with its CSP opened to file: for the codicon font. */
/** `over`: variables laid over the theme's — Cursor Dark's, say (test/fixtures/cursorDarkTheme.json). */
export function aiSettingsHtml(theme: VsCodeTheme, over: Record<string, string> = {}): string {
  const webview = {
    cspSource: "file:",
    asWebviewUri: () => pathToFileURL(CODICONS).href,
  };
  const html = (AiSettingsPanel.prototype as unknown as {
    html: (w: unknown, u: unknown) => string;
  }).html.call({}, webview, { fsPath: "/ext", path: "/ext" });
  const vars = { ...VSCODE_THEMES[theme], ...EXTRA[theme], ...over };
  const style = Object.entries(vars)
    .map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`)
    .join(";");
  // Each swap names its tag in context: tokens.css (inlined into <head>)
  // mentions a bare <body> in its comments.
  const swaps: [string | RegExp, string][] = [
    [/<meta http-equiv="Content-Security-Policy"[^>]*>/, ""],
    ['<!DOCTYPE html><html lang="en"><head>', `<!DOCTYPE html><html lang="en" style="${style}"><head><script>${HOST_STUB}</script>`],
    ["</head>\n<body>", `</head>\n<body class="${BODY_CLASS[theme]}">`],
  ];
  let out = html;
  for (const [from, to] of swaps) {
    const n = typeof from === "string" ? out.split(from).length - 1 : (out.match(from) ?? []).length;
    if (n !== 1) throw new Error(`aiSettingsPanel html(): expected exactly one ${String(from)}, found ${n}`);
    out = out.replace(from, () => to);
  }
  return out;
}

/** What the host's connectionStatus() answers (gitBrain.ts). */
export function aiStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "auto",
    ready: false,
    hasAnthropicKey: false,
    hasOpenaiKey: false,
    copilotAvailable: true,
    openaiBaseUrl: "https://api.openai.com/v1",
    openaiModel: "",
    cliAgent: "",
    commitStyle: "conventional",
    ...over,
  };
}

export class AiSettingsPage {
  private constructor(
    private readonly browser: Browser,
    readonly page: Page,
    private readonly dir: string,
  ) {}

  static chrome(): string | undefined {
    return findChrome();
  }

  static async open(theme: VsCodeTheme, opts: { width?: number; height?: number; scale?: number; over?: Record<string, string> } = {}): Promise<AiSettingsPage> {
    const chrome = findChrome();
    if (!chrome) throw new Error("no windowless Chrome on this machine (set GS_CHROME)");
    process.env.GS_CHROME = chrome;
    const width = opts.width ?? 760;
    const height = opts.height ?? 900;
    const browser = await Browser.launch({ width, height });
    const page = await browser.newPage(width, height, opts.scale ?? 1);
    const dir = mkdtempSync(join(tmpdir(), "gs-ai-page-"));
    const file = join(dir, "ai.html");
    writeFileSync(file, aiSettingsHtml(theme, opts.over));
    await browser.goto(page, pathToFileURL(file).href);
    await page.waitFor(`typeof window.__send === "function" && window.__posted.some(function (m) { return m.type === "ready"; })`);
    return new AiSettingsPage(browser, page, dir);
  }

  eval<T = unknown>(expression: string): Promise<T> {
    return this.page.eval<T>(expression);
  }

  async send(msg: unknown): Promise<void> {
    await this.page.eval(`window.__send(${JSON.stringify(msg)})`);
  }

  async screenshot(path: string): Promise<void> {
    writeFileSync(path, await this.page.screenshot());
  }

  async close(): Promise<void> {
    await this.browser.close();
    try {
      rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* swept with the temp directory */
    }
  }
}
