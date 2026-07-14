import * as vscode from "vscode";

/**
 * Builds the commit-graph webview HTML with a locked-down CSP and the bundled
 * graph entry + its stylesheet. Mirrors the merge/diff webview's pattern: a
 * nonce gates inline + bundled scripts, and cspSource scopes the bundled assets.
 *
 * `bundle` picks the front-end: "graph" is the full editor-area surface,
 * "graph-sidebar" the compact sidebar rail (dist/webview/<bundle>.js + .css).
 *
 * Never hardcode the URI scheme returned by asWebviewUri — it is opaque.
 */
export function getGraphHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  nonce: string,
  bundle: "graph" | "graph-sidebar" = "graph",
): string {
  const dist = (...parts: string[]) =>
    webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", ...parts));

  const scriptUri = dist("webview", `${bundle}.js`);
  const styleUri = dist("webview", `${bundle}.css`);

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    // Lit injects component styles into shadow roots at runtime (constructed
    // stylesheets / <style>); the bundled page stylesheet is same-origin.
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
  <title>Commit Graph</title>
</head>
<body>
  <div id="root"><div id="boot">Loading history…</div></div>
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
