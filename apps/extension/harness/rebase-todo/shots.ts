// Screenshots of the git-rebase-todo editor (<gitstudio-rebase>, what opens
// for a `git rebase -i` run in a terminal) with a selection (issue #32) — per
// theme, its real webview entry bundled as the extension bundles it, fed the
// host's init message, in a windowless Chrome, driven with real keys.
//
//   npx tsx apps/extension/harness/rebase-todo/shots.ts [outDir]
//
// Writes to <repo>/out/rebase-todo by default:
//   selection-<theme>.png  the three fixup! lines set to Fixup at once
//   refused-<theme>.png    every line squashed at once: the first stays, and
//                          the footer says why
//   edit-todo-<theme>.png  a paused rebase's `git rebase --edit-todo`: the
//                          todo starts with fixups of the commit git stopped
//                          at, and Start rebase is open

import { build } from "esbuild";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { findChrome } from "../../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../../scripts/merge-e2e/themes";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/rebase-todo/", import.meta.url));
const MAIN = fileURLToPath(new URL("../../../../packages/webview-ui/src/rebase/main.ts", import.meta.url));

const EXTRA: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    "--vscode-list-inactiveSelectionBackground": "#37373d",
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-keybindingLabel-background": "rgba(128, 128, 128, 0.17)",
    "--vscode-keybindingLabel-foreground": "#cccccc",
  },
  light: {
    "--vscode-list-inactiveSelectionBackground": "#e4e6f1",
    "--vscode-editor-background": "#ffffff",
    "--vscode-keybindingLabel-background": "rgba(221, 221, 221, 0.4)",
    "--vscode-keybindingLabel-foreground": "#555555",
  },
};

const SUBJECTS = [
  "docs: the staging model",
  "engine: hunk splitting groundwork",
  "engine: split a hunk on a selection boundary",
  "typo",
  "changes: a row per hunk",
  "changes: stage the lines a selection touches",
  "wip",
  "wip",
  "staging: keep the selection across a refresh",
  "fixup! staging: keep the selection across a refresh",
  "fixup! staging: keep the selection across a refresh",
  "fixup! staging: keep the selection across a refresh",
];

async function key(page: Page, name: string, mods: { shift?: boolean; meta?: boolean; ctrl?: boolean } = {}): Promise<void> {
  const bits = (mods.ctrl ? 2 : 0) | (mods.meta ? 4 : 0) | (mods.shift ? 8 : 0);
  const vk: Record<string, number> = { ArrowDown: 40, ArrowUp: 38 };
  const code = vk[name] ?? name.toUpperCase().charCodeAt(0);
  const base = { key: name, code: name.length === 1 ? `Key${name.toUpperCase()}` : name, windowsVirtualKeyCode: code, modifiers: bits };
  await page.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await page.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
  await new Promise((r) => setTimeout(r, 120));
}

async function main(): Promise<void> {
  const chrome = findChrome();
  if (!chrome) {
    console.error("no windowless Chrome on this machine (set GS_CHROME)");
    process.exit(2);
  }
  process.env.GS_CHROME = chrome;
  mkdirSync(OUT, { recursive: true });
  const bundle = await build({
    entryPoints: [MAIN],
    bundle: true,
    write: false,
    outdir: "out",
    platform: "browser",
    format: "iife",
    loader: { ".ttf": "dataurl" },
    logLevel: "silent",
  });
  const js = bundle.outputFiles.find((f) => f.path.endsWith(".js"))!.text;
  const css = bundle.outputFiles.find((f) => f.path.endsWith(".css"))?.text ?? "";
  const dir = mkdtempSync(join(tmpdir(), "gs-rebase-todo-"));
  const mod = process.platform === "darwin" ? { meta: true } : { ctrl: true };
  try {
    for (const theme of ["dark", "light"] as const) {
      const vars = { ...VSCODE_THEMES[theme as VsCodeTheme], ...EXTRA[theme] };
      const style = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(";");
      const file = join(dir, `${theme}.html`);
      writeFileSync(
        file,
        `<!doctype html><html style="${style.replace(/"/g, "&quot;")}"><head><meta charset="utf-8"><style>${css}</style></head>
<body class="${BODY_CLASS[theme as VsCodeTheme]}"><div id="root"></div>
<script>window.acquireVsCodeApi = function () { return { postMessage: function () {}, getState: function () {}, setState: function () {} }; };</script>
<script>${js}</script></body></html>`,
      );
      const browser = await Browser.launch({ width: 1000, height: 720 });
      try {
        const page = await browser.newPage(1000, 720, 2);
        await browser.goto(page, pathToFileURL(file).href);
        const rows = SUBJECTS.map((subject, i) => {
          const sha = (i + 1).toString(16).padStart(7, "0");
          return { id: i * 2, action: "pick", sha, shortSha: sha, subject };
        });
        await page.eval(`window.dispatchEvent(new MessageEvent("message", { data: { type: "rebaseInit", headerComment: null, rows: ${JSON.stringify(rows)} } }))`);
        await page.waitFor(`document.querySelector("gitstudio-rebase").shadowRoot.querySelectorAll(".row").length === ${rows.length}`);
        await page.eval(`(function () {
          var r = document.querySelector("gitstudio-rebase").shadowRoot.querySelectorAll(".row")[${rows.length - 3}];
          r.querySelector(".subject").click();
        })()`);
        await new Promise((r) => setTimeout(r, 150));
        await key(page, "ArrowDown", { shift: true });
        await key(page, "ArrowDown", { shift: true });
        await key(page, "f");
        await new Promise((r) => setTimeout(r, 250));
        writeFileSync(join(OUT, `selection-${theme}.png`), await page.screenshot());
        await key(page, "a", mod);
        await key(page, "s");
        await new Promise((r) => setTimeout(r, 250));
        writeFileSync(join(OUT, `refused-${theme}.png`), await page.screenshot());
        // Stopped (edit) at "staging: keep the selection across a refresh",
        // with its three fixup! lines still to go: git keeps the commit it
        // stopped at above the first line, so they fold into it.
        const rest = rows.slice(9).map((r) => ({ ...r, action: "fixup" }));
        // A fresh editor, as a new --edit-todo opens one.
        await browser.goto(page, pathToFileURL(file).href);
        await page.eval(`window.dispatchEvent(new MessageEvent("message", { data: { type: "rebaseInit", headerComment: null, continuing: true, rows: ${JSON.stringify(rest)} } }))`);
        await page.waitFor(`document.querySelector("gitstudio-rebase").shadowRoot.querySelectorAll(".row").length === ${rest.length}`);
        await new Promise((r) => setTimeout(r, 250));
        writeFileSync(join(OUT, `edit-todo-${theme}.png`), await page.screenshot());
        console.log(`wrote ${theme}`);
      } finally {
        await browser.close();
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

void main();
