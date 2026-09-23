import "./support/useVscodeStub";
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as vscode from "vscode";
import { conflictsWebviewHtml } from "../src/webviewHtml";

// The conflicts dashboard's page contract (P3 → P4): the page links the codicon
// stylesheet (conflicts.css only declares codepoints; without the font every
// row icon is a blank box), links conflicts.css, gives the component its
// #root, and loads conflicts.js under the nonce. The component posts `ready`
// itself (conflicts/main.ts). And GitStudio's build emits that bundle.

test("the dashboard page links codicon.css and conflicts.css, and mounts conflicts.js on #root", () => {
  const webview = {
    cspSource: "vscode-webview-resource:",
    asWebviewUri: (u: vscode.Uri) => u,
  } as unknown as vscode.Webview;
  const html = conflictsWebviewHtml(webview, vscode.Uri.file("/ext"));
  assert.match(html, /<link href="[^"]*\/dist\/codicons\/codicon\.css" rel="stylesheet"/);
  assert.match(html, /<link href="[^"]*\/dist\/webview\/conflicts\.css" rel="stylesheet"/);
  assert.match(html, /<div id="root"><\/div>/);
  const nonce = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(html)?.[1];
  assert.ok(nonce, "a strict CSP with a nonce");
  assert.match(html, new RegExp(`<script nonce="${nonce}" src="[^"]*/dist/webview/conflicts\\.js"></script>`));
});

test("the page's script posts `ready` on load (the host answers it with the state)", () => {
  const main = readFileSync(join(__dirname, "../../webview-ui/src/conflicts/main.ts"), "utf8");
  const dash = readFileSync(join(__dirname, "../../webview-ui/src/conflicts/dashboard.ts"), "utf8");
  assert.match(main, /new ConflictsDashboard\(root/);
  assert.match(dash, /this\.post\(\{ type: "ready" \}\)/);
});

test("GitStudio's build emits dist/webview/conflicts.js from the shared entry", () => {
  const build = readFileSync(join(__dirname, "../../../apps/extension/esbuild.js"), "utf8");
  assert.match(build, /conflicts\/main\.ts/);
  assert.match(build, /dist\/webview\/conflicts\.js/);
});
