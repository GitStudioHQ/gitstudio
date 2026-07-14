import * as vscode from "vscode";

/**
 * Builds the webview HTML for the shared merge/diff front-end: a locked-down CSP
 * with a per-load nonce, the bundled webview entry (Monaco) + its stylesheet,
 * and the worker URI injected on the `window.__JBMERGE__` global the webview's
 * monacoEnv.ts reads.
 *
 * Note: never hardcode the URI scheme returned by asWebviewUri — it is opaque.
 */
export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
): string {
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
  <title>GitStudio</title>
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
    .jb-merge-grid {
      display: grid;
      /* 64px gutters: a 46px rectangular icon strip hugging each side pane
         (see MERGE_ICON_STRIP in webview/ribbons.ts) + an 18px slant zone. */
      grid-template-columns: 1fr 64px 1fr 64px 1fr;
      grid-template-rows: 28px 1fr;
      height: 100%;
      width: 100%;
      /* Anchors the full-width ribbon stage (.jb-ribbon-stage). */
      position: relative;
    }
    .jb-diff-grid {
      display: grid;
      grid-template-columns: 1fr 44px 1fr;
      grid-template-rows: 28px 1fr;
      height: 100%;
      width: 100%;
      position: relative;
    }
    /* Pane headers sit on the editor background, like IntelliJ's quiet
       "Your version / Result / Changes from server" captions. */
    .jb-pane-title {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 0 10px;
      font-size: 11px;
      color: var(--vscode-descriptionForeground, var(--vscode-foreground));
      white-space: nowrap;
      overflow: hidden;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .jb-title-result { justify-content: center; }
    .jb-pane-label {
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .jb-pane-title .jb-lock { opacity: 0.7; }
    /* The header row must be continuous across the gutter strips too. */
    .jb-merge-grid::before,
    .jb-merge-grid::after,
    .jb-diff-grid::before {
      content: "";
      grid-row: 1;
      border-bottom: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }
    .jb-merge-grid::before { grid-column: 2; }
    .jb-merge-grid::after { grid-column: 4; }
    .jb-diff-grid::before { grid-column: 2; }
    .jb-pane-body {
      min-width: 0;
      min-height: 0;
      position: relative;
      overflow: hidden;
    }
    /* Gutter strips share the editor background so the change bands read as
       one continuous stripe from pane to pane. */
    .jb-gutter {
      position: relative;
      grid-row: 2;
      min-width: 0;
      overflow: hidden;
      background: var(--vscode-editor-background);
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

/** A 32-char alphanumeric nonce for the strict CSP. */
export function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
