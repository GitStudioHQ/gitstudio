import * as l10n from "@vscode/l10n";
import { l10nWebviewScript } from "@gitstudio/l10n/index";
// A pull request's page, as its editor tab loads it: the shared page's bundle
// (packages/webview-ui/src/pr/page-main.ts → dist/webview/pr-page.js + .css),
// the codicons, and a `#root` for it — under a strict CSP.
//
// No `vscode` import: the page is built from plain strings, so a test and the
// screenshot harness (harness/pr/pageShots.ts) render exactly this document.
//
// The CSP allows no inline style: the page sets its few computed values (a
// label's colour, an avatar's hue, a tree row's depth) through the CSSOM,
// which a policy without 'unsafe-inline' lets through; a style ATTRIBUTE it
// would drop. Images: GitHub's avatar host, and any https image a pull
// request's description embeds (the shared renderer lets only http(s) and
// data: sources through its sanitiser).

export interface PrPageHtmlParts {
  /** The webview's own source, e.g. `webview.cspSource`. */
  cspSource: string;
  nonce: string;
  codiconCss: string;
  pageCss: string;
  pageJs: string;
  /** The merge method offered first (gitstudio.pr.defaultMergeMethod). */
  mergeMethod?: string;
  /** The tab's title, for a screen reader. */
  title: string;
}

/** Text as an HTML attribute value. */
function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** Text as HTML text. */
function text(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function prPageCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} https: data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
  ].join("; ");
}

export function prPageHtml(p: PrPageHtmlParts): string {
  const method = p.mergeMethod === "merge" || p.mergeMethod === "squash" || p.mergeMethod === "rebase" ? p.mergeMethod : "";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${attr(prPageCsp(p.cspSource, p.nonce))}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${attr(p.codiconCss)}" rel="stylesheet" />
  <link href="${attr(p.pageCss)}" rel="stylesheet" />
  <title>${text(p.title)}</title>
</head>
<body>
  <div id="root"${method ? ` data-merge-method="${method}"` : ""}></div>
  ${l10nWebviewScript(p.nonce)}
  <script nonce="${attr(p.nonce)}" src="${attr(p.pageJs)}"></script>
</body>
</html>`;
}
