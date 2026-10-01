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
import { buildSync } from "esbuild";
import ts from "typescript";

import { fillHole, l10nHoles } from "./pageHoles";
import { findChrome } from "../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";

export type { VsCodeTheme };

/**
 * A theme a Changes page can be opened in: VS Code's four, and Cursor's own
 * default ("Cursor Dark", the --vscode-* values its webviews are given, read
 * from a live Changes view: test/fixtures/cursorDarkTheme.json). Cursor's
 * focusBorder is 15% white — GitStudio's accent was invisible there.
 */
export type PageTheme = VsCodeTheme | "cursor-dark";

const CURSOR_DARK: Record<string, string> = JSON.parse(readFileSync(join(__dirname, "fixtures", "cursorDarkTheme.json"), "utf8")).vars;

/** The VS Code theme a page theme is laid over, and what it lays over it. */
function themeParts(theme: PageTheme): { base: VsCodeTheme; over: Record<string, string> } {
  return theme === "cursor-dark" ? { base: "dark", over: CURSOR_DARK } : { base: theme, over: {} };
}

const HERE = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SRC = HERE("../src/changes/commitView.ts");
const TOKENS = HERE("../../../packages/webview-ui/src/styles/tokens.css");
const CHANGE_ROWS_CSS = HERE("../../../packages/webview-ui/src/changeRows/changeRows.css");
const CHANGE_ROWS_ENTRY = HERE("../../../packages/webview-ui/src/changeRows/global.ts");
const CODICONS = HERE("../../../node_modules/@vscode/codicons/dist/codicon.css");

let changeRowsFile: string | undefined;

/** change-rows.js (window.GsChangeRows), built once per run from the extension's entry. */
export function changeRowsScript(): string {
  if (!changeRowsFile) {
    const out = buildSync({
      entryPoints: [CHANGE_ROWS_ENTRY],
      bundle: true,
      write: false,
      platform: "browser",
      format: "iife",
      logLevel: "silent",
    });
    const dir = mkdtempSync(join(tmpdir(), "gs-change-rows-"));
    changeRowsFile = join(dir, "change-rows.js");
    writeFileSync(changeRowsFile, out.outputFiles[0].text);
  }
  return pathToFileURL(changeRowsFile).href;
}

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
    "--vscode-list-highlightForeground": "#2aaaff",
    "--vscode-list-focusHighlightForeground": "#2aaaff",
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
    "--vscode-list-highlightForeground": "#0066bf",
    // Light+ leaves list.activeSelectionBackground to the default, so the
    // registry resolves this to its own light blue for the blue row.
    "--vscode-list-focusHighlightForeground": "#bbe7ff",
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
    "--vscode-list-highlightForeground": "#f38518",
    "--vscode-list-focusHighlightForeground": "#f38518",
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
    "--vscode-list-highlightForeground": "#006bbd",
    "--vscode-list-focusHighlightForeground": "#006bbd",
  },
};

/**
 * Stands in for the host: records every message the page posts, and delivers
 * the host's. The webview's own state (getState / setState) is kept in
 * `window.__gsState` — what VS Code keeps for a view across a reload.
 */
const HOST_STUB = `
window.__posted = [];
window.acquireVsCodeApi = function () {
  return {
    postMessage: function (m) { window.__posted.push(JSON.parse(JSON.stringify(m))); },
    getState: function () { return window.__gsState === undefined ? undefined : JSON.parse(JSON.stringify(window.__gsState)); },
    setState: function (s) { window.__gsState = JSON.parse(JSON.stringify(s)); },
  };
};
window.__send = function (msg) { window.dispatchEvent(new MessageEvent("message", { data: msg })); };
`;

/**
 * The html() template's text, exactly as String.raw hands it over, with its
 * holes filled. `webviewState`: what getState() answers when the page starts,
 * as after a reload.
 */
export function changesViewHtml(pageTheme: PageTheme, webviewState?: unknown): string {
  const { base: theme, over } = themeParts(pageTheme);
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
    // inline style and script (the nonce stays on the tags), the codicon font,
    // and the shared change rows' script (change-rows.js, built here from the
    // extension's own entry).
    csp: "default-src 'none'; style-src 'unsafe-inline' file:; font-src file: data:; script-src 'unsafe-inline' file:",
    codiconUri: pathToFileURL(CODICONS).href,
    nonce: "n",
    tokensCss: readFileSync(TOKENS, "utf8"),
    changeRowsCss: readFileSync(CHANGE_ROWS_CSS, "utf8"),
    changeRowsUri: changeRowsScript(),
    // The words and the bundle: see pageHoles.ts.
    ...l10nHoles("n"),
  };
  // head "`…${", middle "}…${", tail "}…`" — the delimiters come off.
  let html = tpl.head.getText(sf).slice(1, -2);
  for (const span of tpl.templateSpans) {
    html += fillHole("commitView.ts html()", span, sf, holes);
    const lit = span.literal.getText(sf);
    html += ts.isTemplateTail(span.literal) ? lit.slice(1, -1) : lit.slice(1, -2);
  }

  const vars = { ...VSCODE_THEMES[theme], ...VIEW_TOKENS[theme], ...over };
  const style = Object.entries(vars)
    .map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`)
    .join(";");
  const swaps: [string, string][] = [
    ['<html lang="en">', `<html lang="en" style="${style}">`],
    [
      "<head>",
      `<head><script>${webviewState === undefined ? "" : `window.__gsState = ${JSON.stringify(webviewState)};`}${HOST_STUB}</script>`,
    ],
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
  /** The upstream was deleted from its remote. */
  gone?: boolean;
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
  Tab: { code: "Tab", vk: 9 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  " ": { code: "Space", vk: 32 },
  a: { code: "KeyA", vk: 65 },
  F10: { code: "F10", vk: 121 },
  ContextMenu: { code: "ContextMenu", vk: 93 },
  Delete: { code: "Delete", vk: 46 },
  Backspace: { code: "Backspace", vk: 8 },
};

/** The DevTools protocol's modifier bits. */
const MODIFIERS = { alt: 1, ctrl: 2, meta: 4, shift: 8 } as const;
export type Modifier = keyof typeof MODIFIERS;

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
    theme: PageTheme,
    opts: { width?: number; height?: number; scale?: number; webviewState?: unknown } = {},
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
    writeFileSync(file, changesViewHtml(theme, opts.webviewState));
    await browser.goto(page, pathToFileURL(file).href);
    await page.waitFor(`typeof window.__send === "function" && !!document.getElementById("branch-pill")`);
    return new ChangesPage(browser, page, dir);
  }

  eval<T = unknown>(expression: string): Promise<T> {
    return this.page.eval<T>(expression);
  }

  /** Load the page afresh — every piece of the script's state gone — and wait until it is up. */
  async reload(): Promise<void> {
    await this.page.eval("window.__gsStale = true");
    await this.page.send("Page.reload", { ignoreCache: true });
    // The page's own "ready" (its script's last line): the stub's __send and the
    // markup exist before the script has run, and a message sent then is lost.
    await this.page.waitFor(
      `!window.__gsStale && document.readyState === "complete" && window.__posted.some(function (m) { return m.type === "ready"; })`,
    );
  }

  /** Deliver a host message to the page. */
  async send(msg: unknown): Promise<void> {
    await this.page.eval(`window.__send(${JSON.stringify(msg)})`);
  }

  /**
   * The name a screen reader announces for the element `expression` yields,
   * as Chrome's accessibility tree computes it — what a hover-only tip or a
   * display:none word never reaches.
   */
  async accessibleName(expression: string): Promise<string> {
    await this.page.send("Accessibility.enable");
    const r = await this.page.send<{ result: { objectId?: string } }>("Runtime.evaluate", { expression });
    if (!r.result.objectId) throw new Error(`not an element: ${expression}`);
    const tree = await this.page.send<{ nodes: { name?: { value?: string } }[] }>("Accessibility.getPartialAXTree", {
      objectId: r.result.objectId,
      fetchRelatives: false,
    });
    return tree.nodes[0]?.name?.value ?? "";
  }

  /** Everything the page has posted to the host so far. */
  posted(): Promise<Record<string, unknown>[]> {
    return this.page.eval("window.__posted");
  }

  /** A real key press on whatever has focus. `repeat` marks it as a held key's repeat; `with` holds modifiers down. */
  async key(
    name: keyof typeof KEYS | string,
    opts: { repeat?: boolean; with?: Modifier[]; typed?: boolean } = {},
  ): Promise<void> {
    const k = KEYS[name];
    if (!k) throw new Error(`no key mapping for ${name}`);
    const modifiers = (opts.with ?? []).reduce((m, x) => m | MODIFIERS[x], 0);
    const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk, autoRepeat: !!opts.repeat, modifiers };
    // `typed`: the key also types its character, as a real press does — which
    // is what makes Enter or Space press a focused <button>. Without it only
    // keydown handlers see the key.
    const text = name === "Enter" ? "\r" : name.length === 1 ? name : undefined;
    if (opts.typed && text !== undefined) {
      await this.page.send("Input.dispatchKeyEvent", { type: "keyDown", text, unmodifiedText: text, ...base });
    } else {
      await this.page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
    }
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

  /** Resize the view, as dragging the sidebar's edge does, and wait for the
   *  page's `resize` (it lands a frame after the new size). */
  async resize(width: number, height: number, scale = 1): Promise<void> {
    await this.page.eval(`window.__gsResized = false;
      window.addEventListener("resize", function () { window.__gsResized = true; }, { once: true })`);
    await this.page.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: scale, mobile: false });
    await this.page.waitFor(`window.__gsResized && innerWidth === ${width} && innerHeight === ${height}`);
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
