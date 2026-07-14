import * as vscode from "vscode";

/**
 * Builds the interactive-rebase webview HTML with a locked-down CSP and the
 * bundled rebase entry + its stylesheet. Mirrors the graph webview's pattern:
 * a per-load nonce gates inline + bundled scripts, cspSource scopes the bundled
 * assets, and Lit injects component styles into shadow roots at runtime.
 *
 * Never hardcode the URI scheme returned by asWebviewUri — it is opaque.
 */
export function getRebaseHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
): string {
  const dist = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", ...parts));

  const scriptUri = dist("webview", "rebase.js");
  const styleUri = dist("webview", "rebase.css");

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}' ${webview.cspSource}`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Interactive Rebase</title>
</head>
<body>
  <div id="root"><div id="boot">Loading rebase plan…</div></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

export function getNonce(): string {
  let text = "";
  const possible =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
