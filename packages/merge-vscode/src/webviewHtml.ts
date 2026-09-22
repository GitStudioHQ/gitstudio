// The two pages this package serves, both from the product's own `dist/`:
//
// 1. The merge / diff page — the shared webview-ui entry (Monaco) at
//    dist/webview/main.js + main.css, with the editor worker injected on
//    `window.__JBMERGE__` for monacoEnv.ts. Layout comes from main.css alone:
//    the grid is defined ONCE, in webview-ui's styles/diff.css (PLAN §3.6).
//    The GitStudio extension used to redeclare it inline here with different
//    gutters than the desktop's, which is how the two drew the same merge
//    misaligned.
// 2. The conflicts dashboard — dist/webview/conflicts.js + conflicts.css (the
//    webview-ui conflicts entry's page contract: a `#root` div, the codicon
//    stylesheet, `ready` → `state`).
//
// Both use a strict CSP with a per-load nonce. Never hardcode the scheme
// asWebviewUri returns; it is opaque.

import * as vscode from "vscode";

export function mergeWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const dist = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", ...parts));
  const scriptUri = dist("webview", "main.js");
  const styleUri = dist("webview", "main.css");
  const workerUri = dist("webview", "editor.worker.js");
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    // Monaco injects styles at runtime; the bundled stylesheet is same-origin.
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    // cspSource lets the blob worker importScripts() the bundled worker.
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    `worker-src blob:`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Merge</title>
  <style>
    html, body, #root { height: 100%; margin: 0; padding: 0; }
    body {
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      background: var(--vscode-editor-background);
      overflow: hidden;
    }
    #placeholder {
      display: flex;
      align-items: center;
      justify-content: center;
      height: 100%;
      opacity: 0.6;
    }
  </style>
</head>
<body>
  <div id="root"><div id="placeholder">Loading editor…</div></div>
  <script nonce="${nonce}">
    window.__JBMERGE__ = { workerUri: "${workerUri}" };
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function conflictsWebviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = getNonce();
  const dist = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", ...parts));
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${dist("codicons", "codicon.css")}" rel="stylesheet" />
  <link href="${dist("webview", "conflicts.css")}" rel="stylesheet" />
  <title>Conflicts</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}" src="${dist("webview", "conflicts.js")}"></script>
</body>
</html>`;
}

/** A 32-character alphanumeric nonce for the strict CSP. */
export function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
