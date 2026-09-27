// Screenshots of the Compare panel's page, per theme: the real render() of
// comparePanel.ts (its markup, COMPARE_CSS and COMPARE_JS) over a comparison
// of a feature branch with main, under the vscode stand-in, in a windowless
// Chrome (GS_CHROME — never the desktop Chrome).
//
//   npx tsx apps/extension/harness/compare/shots.ts [outDir]
//   THEMES=dark,light,hc-dark,hc-light

import Module from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Browser } from "../../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../../scripts/merge-e2e/themes";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
const STUB = fileURLToPath(new URL("../../test/vscodeStub.cjs", import.meta.url));
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : resolve.call(this, request, ...rest);
};
const loaders = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })
  ._extensions;
loaders[".css"] = (m, f) => {
  m.exports = readFileSync(f, "utf8");
};
/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { ComparePanel } = require("../../src/compare/comparePanel") as typeof import("../../src/compare/comparePanel");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { CompareResult } from "../../src/compare/refCompare";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/compare/", import.meta.url));
mkdirSync(OUT, { recursive: true });
const CODICONS = fileURLToPath(new URL("../../../../node_modules/@vscode/codicons/dist/codicon.css", import.meta.url));

const now = Math.floor(Date.now() / 1000);
const result = {
  commits: [
    { sha: "1".repeat(40), subject: "feat(checkout): validate the card before posting it", author: "Maya Chen", authorDate: now - 3600 * 5 },
    { sha: "2".repeat(40), subject: "feat(checkout): the checkout form", author: "Maya Chen", authorDate: now - 86400 * 2 },
  ],
  files: [
    { path: "src/checkout.ts", status: "M", additions: 12, deletions: 3 },
    { path: "src/checkout/api.ts", status: "A", additions: 40, deletions: 0 },
  ],
  additions: 52,
  deletions: 3,
  ahead: 2,
  behind: 1,
  filesLeftRef: "b".repeat(40),
  baseKind: "branch",
  headKind: "branch",
} as unknown as CompareResult;

function page(theme: VsCodeTheme): string {
  const self = {
    base: "main",
    head: "feature/checkout-flow",
    threeDot: true,
    extensionUri: {},
    panel: { webview: { asWebviewUri: () => pathToFileURL(CODICONS).href, cspSource: "file:" } },
  };
  const html = (ComparePanel.prototype as unknown as { render: (r: CompareResult) => string }).render.call(self, result);
  const vars = Object.entries(VSCODE_THEMES[theme]).map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`).join(";");
  const stub = `window.acquireVsCodeApi = function () { return { postMessage: function () {}, getState: function () { return undefined; }, setState: function () {} }; };`;
  return html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace('<!DOCTYPE html><html lang="en"><head>', `<!DOCTYPE html><html lang="en" style="${vars}"><head><script>${stub}</script>`)
    .replace("</head>\n<body>", `</head>\n<body class="${BODY_CLASS[theme]}">`);
}

(async () => {
  const themes: VsCodeTheme[] = process.env.THEMES
    ? (process.env.THEMES.split(",") as VsCodeTheme[])
    : ["dark", "light", "hc-dark", "hc-light"];
  const browser = await Browser.launch({ width: 900, height: 420 });
  const tmp = mkdtempSync(join(tmpdir(), "gs-compare-page-"));
  try {
    for (const theme of themes) {
      const p = await browser.newPage(900, 420, 2);
      const file = join(tmp, `compare-${theme}.html`);
      writeFileSync(file, page(theme));
      await browser.goto(p, pathToFileURL(file).href);
      await new Promise((r) => setTimeout(r, 400));
      const out = join(OUT, `compare-${theme}.png`);
      writeFileSync(out, await p.screenshot());
      console.log(out, p.errors.length ? "ERRORS " + p.errors.join(" | ") : "");
      await browser.closePage(p);
    }
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
