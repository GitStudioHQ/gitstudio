// The Changes view's webview, rendered for real: the page commitView.ts's
// html() returns, in a windowless Chrome, driven over the DevTools protocol
// with real key and mouse events. Not a test itself — the branch menu's
// keyboard test (branchMenuKeyboard.test.ts) and its screenshot harness
// (harness/branch-menu/shots.ts) both mount it.
//
// The page's script is a String.raw template literal inside commitView.ts,
// so nothing type-checks it and nothing but a browser runs it. The template
// is lifted out of the source with the TypeScript parser — never re-typed —
// and its four holes are filled the way the extension fills them: the
// shared tokens.css, the codicon stylesheet, a nonce and a CSP. VS Code's
// theme arrives as it does in a real webview: --vscode-* variables on <html>
// and a theme class on <body>, per built-in theme (scripts/merge-e2e/themes.ts
// plus the few menu / input / list tokens this view reads that it lacks).
//
// The browser is findChrome()'s — GS_CHROME, else Playwright's windowless
// chrome-headless-shell — and never the desktop Chrome on a Mac (memory:
// headless-tests-never-drive-users-chrome). A machine with none skips.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { findChrome } from "../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";

export type { VsCodeTheme };

const HERE = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SRC = HERE("../src/changes/commitView.ts");
const TOKENS = HERE("../../../packages/webview-ui/src/styles/tokens.css");
const CODICONS = HERE("../../../node_modules/@vscode/codicons/dist/codicon.css");

/** The menu, input and list tokens the Changes view reads that themes.ts has no need for. */
const VIEW_TOKENS: Record<VsCodeTheme, Record<string, string>> = {
  dark: {
    "--vscode-menu-background": "#252526",
    "--vscode-menu-foreground": "#cccccc",
    "--vscode-input-background": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
    "--vscode-input-placeholderForeground": "#a6a6a6",
    "--vscode-list-focusOutline": "#007fd4",
    "--vscode-list-inactiveSelectionBackground": "#37373d",
    "--vscode-toolbar-hoverBackground": "rgba(90, 93, 94, 0.31)",
  },
  light: {
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-foreground": "#616161",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#616161",
    "--vscode-input-placeholderForeground": "#767676",
    "--vscode-list-focusOutline": "#0090f1",
    "--vscode-list-inactiveSelectionBackground": "#e4e6f1",
    "--vscode-toolbar-hoverBackground": "rgba(184, 184, 184, 0.31)",
  },
  // The high-contrast themes define no selection background at all — a
  // selection is its outline (list.focusOutline = contrastActiveBorder).
  "hc-dark": {
    "--vscode-menu-background": "#000000",
    "--vscode-menu-border": "#6fc3df",
    "--vscode-menu-foreground": "#ffffff",
    "--vscode-input-background": "#000000",
    "--vscode-input-foreground": "#ffffff",
    "--vscode-input-border": "#6fc3df",
    "--vscode-list-focusOutline": "#f38518",
    "--vscode-contrastActiveBorder": "#f38518",
    "--vscode-contrastBorder": "#6fc3df",
  },
  "hc-light": {
    "--vscode-menu-background": "#ffffff",
    "--vscode-menu-border": "#0f4a85",
    "--vscode-menu-foreground": "#292929",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#292929",
    "--vscode-input-border": "#0f4a85",
    "--vscode-list-focusOutline": "#006bbd",
    "--vscode-contrastActiveBorder": "#006bbd",
    "--vscode-contrastBorder": "#0f4a85",
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

/** The html() template's text, exactly as String.raw hands it over, with its holes filled. */
export function changesViewHtml(theme: VsCodeTheme): string {
  const source = readFileSync(SRC, "utf8");
  const sf = ts.createSourceFile(SRC, source, ts.ScriptTarget.Latest, true);
  let tpl: ts.TemplateExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (
      !tpl &&
      ts.isTaggedTemplateExpression(node) &&
      node.tag.getText(sf) === "String.raw" &&
      ts.isTemplateExpression(node.template) &&
      node.template.head.getText(sf).includes("<!DOCTYPE html>")
    ) {
      tpl = node.template;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!tpl) throw new Error("commitView.ts: could not find html()'s String.raw template");

  const holes: Record<string, string> = {
    // Everything the page needs, and nothing it would not get in VS Code:
    // inline style and script (the nonce stays on the tags), the codicon font.
    csp: "default-src 'none'; style-src 'unsafe-inline' file:; font-src file: data:; script-src 'unsafe-inline'",
    codiconUri: pathToFileURL(CODICONS).href,
    nonce: "n",
    tokensCss: readFileSync(TOKENS, "utf8"),
  };
  // head "`…${", middle "}…${", tail "}…`" — the delimiters come off.
  let html = tpl.head.getText(sf).slice(1, -2);
  for (const span of tpl.templateSpans) {
    const name = span.expression.getText(sf);
    if (!(name in holes)) throw new Error(`commitView.ts html(): a hole this page cannot fill: \${${name}}`);
    html += holes[name];
    const lit = span.literal.getText(sf);
    html += ts.isTemplateTail(span.literal) ? lit.slice(1, -1) : lit.slice(1, -2);
  }

  const vars = { ...VSCODE_THEMES[theme], ...VIEW_TOKENS[theme] };
  const style = Object.entries(vars)
    .map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`)
    .join(";");
  const swaps: [string, string][] = [
    ['<html lang="en">', `<html lang="en" style="${style}">`],
    ["<head>", `<head><script>${HOST_STUB}</script>`],
    ['<body class="layout-list">', `<body class="layout-list ${BODY_CLASS[theme]}">`],
  ];
  for (const [from, to] of swaps) {
    if (html.split(from).length !== 2) throw new Error(`commitView.ts html(): expected exactly one ${from}`);
    html = html.replace(from, to);
  }
  return html;
}

/** One branch row of the menu's payload (commitView's BranchRefPayload). */
export interface LocalBranch {
  name: string;
  current?: boolean;
  upstream?: string;
  upstreamOnRemote?: boolean;
  favorite?: boolean;
  ahead?: number;
  behind?: number;
}

/** A host "state" push carrying `branches`, with an ordinary repo around it. */
export function stateMessage(branches: {
  local: LocalBranch[];
  remote?: string[];
  recent?: string[];
  tags?: string[];
}): Record<string, unknown> {
  const current = branches.local.find((b) => b.current);
  return {
    type: "state",
    hasRepo: true,
    merge: [],
    staged: [],
    unstaged: [{ path: "src/app.ts", status: "M" }],
    stagedCount: 0,
    stagingModel: "split",
    branch: current?.name ?? "main",
    upstream: current?.upstream,
    ahead: current?.ahead ?? 0,
    behind: current?.behind ?? 0,
    unpushed: 0,
    canPublish: true,
    repoName: "demo",
    signoffDefault: false,
    aiEnabled: false,
    layout: "list",
    busy: false,
    branches: {
      local: branches.local.map((b) => ({ current: false, favorite: false, ...b })),
      remote: branches.remote ?? [],
      recent: branches.recent ?? [],
      tags: branches.tags ?? [],
    },
  };
}

const KEYS: Record<string, { code: string; vk: number }> = {
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Enter: { code: "Enter", vk: 13 },
  Escape: { code: "Escape", vk: 27 },
};

/** The Changes view in a browser tab, with the ways a person reaches it. */
export class ChangesPage {
  private constructor(
    private readonly browser: Browser,
    readonly page: Page,
    private readonly dir: string,
  ) {}

  /** The windowless browser this machine has, or undefined (then a check skips). */
  static chrome(): string | undefined {
    return findChrome();
  }

  static async open(
    theme: VsCodeTheme,
    opts: { width?: number; height?: number; scale?: number } = {},
  ): Promise<ChangesPage> {
    const chrome = findChrome();
    if (!chrome) throw new Error("no windowless Chrome on this machine (set GS_CHROME)");
    // cdp.ts launches GS_CHROME; hand it the one findChrome chose.
    process.env.GS_CHROME = chrome;
    const width = opts.width ?? 520;
    const height = opts.height ?? 640;
    const browser = await Browser.launch({ width, height });
    const page = await browser.newPage(width, height, opts.scale ?? 1);
    const dir = mkdtempSync(join(tmpdir(), "gs-changes-page-"));
    const file = join(dir, "changes.html");
    writeFileSync(file, changesViewHtml(theme));
    await browser.goto(page, pathToFileURL(file).href);
    await page.waitFor(`typeof window.__send === "function" && !!document.getElementById("branch-pill")`);
    return new ChangesPage(browser, page, dir);
  }

  eval<T = unknown>(expression: string): Promise<T> {
    return this.page.eval<T>(expression);
  }

  /** Deliver a host message to the page. */
  async send(msg: unknown): Promise<void> {
    await this.page.eval(`window.__send(${JSON.stringify(msg)})`);
  }

  /** Everything the page has posted to the host so far. */
  posted(): Promise<Record<string, unknown>[]> {
    return this.page.eval("window.__posted");
  }

  /** A real key press on whatever has focus. `repeat` marks it as a held key's repeat. */
  async key(name: keyof typeof KEYS | string, opts: { repeat?: boolean } = {}): Promise<void> {
    const k = KEYS[name];
    if (!k) throw new Error(`no key mapping for ${name}`);
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, autoRepeat: !!opts.repeat };
    await this.page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  }

  /** Type text into whatever has focus, as an IME commit would — `input` events and all. */
  async type(text: string): Promise<void> {
    await this.page.send("Input.insertText", { text });
  }

  async mouseMove(x: number, y: number): Promise<void> {
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  }

  async click(x: number, y: number): Promise<void> {
    await this.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  }

  /** A PNG of the whole view. */
  async screenshot(path: string): Promise<void> {
    writeFileSync(path, await this.page.screenshot());
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
