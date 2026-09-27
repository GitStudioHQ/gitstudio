// The Pull Requests view's page: the shared list's bundle
// (packages/webview-ui/src/pr/list-main.ts → dist/webview/pr-list.js + .css),
// the codicons, and a `#root` for it — under a strict CSP.
//
// No `vscode` import: the page is built from plain strings, so a test and the
// screenshot harness (harness/pr/listShots.ts) render exactly this document.
//
// The CSP allows no inline style: the list sets its few computed values (a
// label's colour, an avatar's hue) through the CSSOM, which a policy without
// 'unsafe-inline' lets through; a style ATTRIBUTE it would drop. Images come
// from GitHub's avatar host only (and data: for the initials fallback's
// absence of one).

export interface PrListHtmlParts {
  /** The webview's own source, e.g. `webview.cspSource`. */
  cspSource: string;
  nonce: string;
  codiconCss: string;
  listCss: string;
  listJs: string;
}

/** Text as an HTML attribute value. */
function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function prListCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} https://avatars.githubusercontent.com data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
  ].join("; ");
}

export function prListHtml(p: PrListHtmlParts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${attr(prListCsp(p.cspSource, p.nonce))}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${attr(p.codiconCss)}" rel="stylesheet" />
  <link href="${attr(p.listCss)}" rel="stylesheet" />
  <title>Pull Requests</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${attr(p.nonce)}" src="${attr(p.listJs)}"></script>
</body>
</html>`;
}
