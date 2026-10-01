// The Interactive Rebase workspace's webview, rendered for real: the page
// RebaseWorkspacePanel.render() returns, in a windowless Chrome, driven over
// the DevTools protocol with real key and mouse events. Not a test itself —
// rebasePanelSelection.test.ts and harness/rebase-panel/shots.ts mount it.
//
// The page is a template literal inside rebaseWorkspacePanel.ts and its
// script a String.raw one, so nothing type-checks either and nothing but a
// browser runs them. Both are lifted out of the source with the TypeScript
// parser — never re-typed — and the holes are filled the way the extension
// fills them: the shared tokens.css, the codicon stylesheet, a nonce, a CSP,
// the plan data, and the shared plan rules (engine/rebase/planEdit) built
// into rebase-plan.js by the same entry the extension's esbuild uses.
//
// The browser is findChrome()'s — GS_CHROME, else Playwright's windowless
// chrome-headless-shell — and never the desktop Chrome on a Mac (memory:
// headless-tests-never-drive-users-chrome). A machine with none skips.

import { build } from "esbuild";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

import { fillHole, l10nHoles } from "./pageHoles";
import { findChrome } from "../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";
import { describeRebaseBase } from "../src/rebase/rebaseBase";

export type { VsCodeTheme };

const HERE = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SRC = HERE("../src/rebase/rebaseWorkspacePanel.ts");
const TOKENS = HERE("../../../packages/webview-ui/src/styles/tokens.css");
const CODICONS = HERE("../../../node_modules/@vscode/codicons/dist/codicon.css");
const PLAN_ENTRY = HERE("../../../packages/webview-ui/src/rebase/plan-global.ts");

/** The list and key-label tokens this page reads that themes.ts has no need for (VS Code's defaults). */
const VIEW_TOKENS: Record<VsCodeTheme, Record<string, string>> = {
  dark: {
    "--vscode-list-inactiveSelectionBackground": "#37373d",
    "--vscode-keybindingLabel-background": "rgba(128, 128, 128, 0.17)",
    "--vscode-keybindingLabel-foreground": "#cccccc",
    "--vscode-keybindingLabel-border": "rgba(51, 51, 51, 0.6)",
    "--vscode-keybindingLabel-bottomBorder": "rgba(68, 68, 68, 0.6)",
    "--vscode-input-background": "#3c3c3c",
    "--vscode-input-foreground": "#cccccc",
  },
  light: {
    "--vscode-list-inactiveSelectionBackground": "#e4e6f1",
    "--vscode-keybindingLabel-background": "rgba(221, 221, 221, 0.4)",
    "--vscode-keybindingLabel-foreground": "#555555",
    "--vscode-keybindingLabel-border": "rgba(204, 204, 204, 0.4)",
    "--vscode-keybindingLabel-bottomBorder": "rgba(187, 187, 187, 0.4)",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#616161",
  },
  "hc-dark": {
    "--vscode-keybindingLabel-foreground": "#ffffff",
    "--vscode-keybindingLabel-border": "#6fc3df",
    "--vscode-contrastActiveBorder": "#f38518",
    "--vscode-input-background": "#000000",
    "--vscode-input-foreground": "#ffffff",
  },
  "hc-light": {
    "--vscode-keybindingLabel-foreground": "#292929",
    "--vscode-keybindingLabel-border": "#0f4a85",
    "--vscode-contrastActiveBorder": "#006bbd",
    "--vscode-input-background": "#ffffff",
    "--vscode-input-foreground": "#292929",
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

export interface PanelCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  rel: string;
}

/** Twelve commits, newest first — the "e.g. 10 commits" of issue #32. */
export function twelveCommits(): PanelCommit[] {
  const subjects = [
    "fixup! staging: keep the selection across a refresh",
    "fixup! staging: keep the selection across a refresh",
    "fixup! staging: keep the selection across a refresh",
    "staging: keep the selection across a refresh",
    "wip",
    "wip",
    "changes: stage the lines a selection touches",
    "changes: a row per hunk",
    "typo",
    "engine: split a hunk on a selection boundary",
    "engine: hunk splitting groundwork",
    "docs: the staging model",
  ];
  return subjects.map((subject, i) => {
    const sha = (i + 1).toString(16).padStart(4, "0").repeat(10);
    return { sha, shortSha: sha.slice(0, 7), subject, author: i % 3 ? "Anton Arnaudov" : "Mira Holt", rel: `${i + 1}h ago` };
  });
}

/** Every template/string literal in the source, by the name of the const it initialises. */
function literals(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      out.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

let planJs: Promise<string> | undefined;
/** rebase-plan.js, built from the extension's own entry. */
function planBundle(): Promise<string> {
  planJs ??= build({
    entryPoints: [PLAN_ENTRY],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    logLevel: "silent",
  }).then((r) => r.outputFiles[0].text);
  return planJs;
}

/** render()'s page, holes filled, as the extension would serve it. */
export async function rebasePanelHtml(
  theme: VsCodeTheme,
  dir: string,
  data: { branch: string; base: string; commits: PanelCommit[]; baseCommit: { shortSha: string; subject: string } | null },
): Promise<string> {
  const source = readFileSync(SRC, "utf8");
  const sf = ts.createSourceFile(SRC, source, ts.ScriptTarget.Latest, true);
  const lits = literals(sf);

  const cssNode = lits.get("REBASE_CSS");
  if (!cssNode || !ts.isNoSubstitutionTemplateLiteral(cssNode)) throw new Error("REBASE_CSS is not a plain template literal");
  const jsNode = lits.get("REBASE_JS");
  if (!jsNode || !ts.isTaggedTemplateExpression(jsNode) || !ts.isNoSubstitutionTemplateLiteral(jsNode.template)) {
    throw new Error("REBASE_JS is not a String.raw literal without holes");
  }
  // String.raw: the characters between the backticks, exactly.
  const js = jsNode.template.getText(sf).slice(1, -1);

  let tpl: ts.TemplateExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (!tpl && ts.isTemplateExpression(node) && node.head.text.includes("<!DOCTYPE html>")) tpl = node;
    ts.forEachChild(node, visit);
  };
  visit(sf);
  if (!tpl) throw new Error("rebaseWorkspacePanel.ts: could not find render()'s template");

  const planFile = join(dir, "rebase-plan.js");
  writeFileSync(planFile, await planBundle());
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const holes: Record<string, string> = {
    csp: "default-src 'none'; style-src 'unsafe-inline' file:; font-src file: data:; script-src 'unsafe-inline' file:",
    codiconUri: pathToFileURL(CODICONS).href,
    nonce: "n",
    tokensCss: readFileSync(TOKENS, "utf8"),
    REBASE_CSS: cssNode.text,
    "esc(this.branch)": esc(data.branch),
    // The header names the base as the page does: a sha shortened (rebaseBase.ts).
    "esc(describeRebaseBase(this.base))": esc(describeRebaseBase(data.base)),
    planUri: pathToFileURL(planFile).href,
    dataJson: JSON.stringify({ base: data.base, branch: data.branch, baseCommit: data.baseCommit, commits: data.commits }).replace(/</g, "\\u003c"),
    REBASE_JS: js,
    // The words and the bundle: see pageHoles.ts.
    ...l10nHoles("n"),
  };
  // A cooked template: .text is each part with its escapes applied. The
  // theme goes onto the page's OWN tags, so the skeleton is edited before the
  // holes are filled (the script and the stylesheets mention <body> too).
  const parts = [tpl.head.text, ...tpl.templateSpans.map((s) => s.literal.text)];
  const vars = { ...VSCODE_THEMES[theme], ...VIEW_TOKENS[theme] };
  const style = Object.entries(vars)
    .map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`)
    .join(";");
  const swaps: [string, string][] = [
    ['<html lang="en">', `<html lang="en" style="${style}">`],
    ["<head>", `<head><script>${HOST_STUB}</script>`],
    ["<body>", `<body class="${BODY_CLASS[theme]}">`],
  ];
  for (const [from, to] of swaps) {
    const at = parts.map((p) => p.split(from).length - 1);
    if (at.reduce((a, b) => a + b, 0) !== 1) {
      throw new Error(`rebaseWorkspacePanel.ts render(): expected exactly one ${from} in the page itself`);
    }
    const i = at.indexOf(1);
    parts[i] = parts[i].replace(from, to);
  }
  let html = parts[0];
  tpl.templateSpans.forEach((span, i) => {
    html += fillHole("rebaseWorkspacePanel.ts render()", span, sf, holes) + parts[i + 1];
  });
  return html;
}

const KEYS: Record<string, { code: string; vk: number }> = {
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  Escape: { code: "Escape", vk: 27 },
  Enter: { code: "Enter", vk: 13 },
};

/** CDP's modifier bits. */
export interface Mods {
  alt?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}
const bits = (m: Mods = {}): number => (m.alt ? 1 : 0) | (m.ctrl ? 2 : 0) | (m.meta ? 4 : 0) | (m.shift ? 8 : 0);

/** The platform's add-to-selection key, as the page sees the platform. */
export const MOD: Mods = process.platform === "darwin" ? { meta: true } : { ctrl: true };

/** The workspace in a browser tab, with the ways a person reaches it. */
export class RebasePanelPage {
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
    opts: { width?: number; height?: number; scale?: number; commits?: PanelCommit[] } = {},
  ): Promise<RebasePanelPage> {
    const chrome = findChrome();
    if (!chrome) throw new Error("no windowless Chrome on this machine (set GS_CHROME)");
    process.env.GS_CHROME = chrome;
    const width = opts.width ?? 1100;
    const height = opts.height ?? 820;
    const dir = mkdtempSync(join(tmpdir(), "gs-rebase-panel-"));
    const file = join(dir, "rebase.html");
    writeFileSync(
      file,
      await rebasePanelHtml(theme, dir, {
        branch: "feat/line-staging",
        base: "origin/main",
        commits: opts.commits ?? twelveCommits(),
        baseCommit: { shortSha: "9f8e7d6", subject: "release: extension 1.11.1" },
      }),
    );
    const browser = await Browser.launch({ width, height });
    try {
      const page = await browser.newPage(width, height, opts.scale ?? 1);
      await browser.goto(page, pathToFileURL(file).href);
      await page.waitFor(`!!window.GsRebasePlan && document.querySelectorAll(".rb-row").length > 1`, 15_000);
      return new RebasePanelPage(browser, page, dir);
    } catch (err) {
      // A page that never came up must not leave a browser behind, or the
      // run never exits.
      await browser.close();
      throw err;
    }
  }

  eval<T = unknown>(expression: string): Promise<T> {
    return this.page.eval<T>(expression);
  }

  posted(): Promise<Record<string, unknown>[]> {
    return this.page.eval("window.__posted");
  }

  /** A real key press on whatever has focus. A single character types it. */
  async key(name: string, mods: Mods = {}): Promise<void> {
    const k = KEYS[name];
    const ch = name.length === 1 ? name : "";
    const code = k?.code ?? (ch ? `Key${ch.toUpperCase()}` : name);
    const vk = k?.vk ?? (ch ? ch.toUpperCase().charCodeAt(0) : 0);
    const plain = !mods.meta && !mods.ctrl && !mods.alt;
    const base = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers: bits(mods) };
    await this.page.send("Input.dispatchKeyEvent", {
      type: ch && plain ? "keyDown" : "rawKeyDown",
      ...base,
      ...(ch && plain ? { text: ch, unmodifiedText: ch } : {}),
    });
    await this.page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
    await this.settle();
  }

  /** The centre of the first element the selector matches (on row `i` when given). */
  async centre(selector: string, i?: number): Promise<{ x: number; y: number }> {
    return this.eval(`(function () {
      var rows = document.querySelectorAll(".rb-list .rb-row:not(.rb-base)");
      var root = ${i === undefined ? "document" : `rows[${i}]`};
      var el = root && (root.matches && root.matches(${JSON.stringify(selector)}) ? root : root.querySelector(${JSON.stringify(selector)}));
      if (!el) return null;
      el.scrollIntoView({ block: "nearest" });
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + Math.min(r.width / 2, 60)), y: Math.round(r.top + r.height / 2) };
    })()`);
  }

  /** A real click at a point, with modifiers. */
  async clickAt(x: number, y: number, mods: Mods = {}): Promise<void> {
    const m = bits(mods);
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, modifiers: m });
    await this.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1, modifiers: m });
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1, modifiers: m });
    // Then off the list, so a row's hover (and its easing out) is not read
    // as its selection.
    await this.page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: 2, y: 2 });
    await this.settle(250);
  }

  /** Click row i (on its subject). */
  async clickRow(i: number, mods: Mods = {}): Promise<void> {
    const p = await this.centre(".rb-subj", i);
    if (!p) throw new Error(`no row ${i}`);
    await this.clickAt(p.x, p.y, mods);
  }

  /** Let a repaint land. */
  settle(ms = 60): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

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
