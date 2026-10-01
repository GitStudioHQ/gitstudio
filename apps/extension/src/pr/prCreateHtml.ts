import * as l10n from "@vscode/l10n";
import { l10nWebviewScript } from "@gitstudio/l10n/index";
// A new pull request's form, as its editor tab loads it: the shared form's
// bundle (packages/webview-ui/src/pr/create-main.ts → dist/webview/pr-create.js
// + .css), the codicons, and a `#root` for it — under a strict CSP.
//
// No `vscode` import: the page is built from plain strings, so a test and the
// screenshot harness (harness/pr/createShots.ts) render exactly this document.
//
// The CSP allows no inline style: the form sets its few computed values (a
// label's colour, an avatar's hue) through the CSSOM. Images: GitHub's avatar
// host only — the form shows no one's prose.

export interface PrCreateHtmlParts {
  /** The webview's own source, e.g. `webview.cspSource`. */
  cspSource: string;
  nonce: string;
  codiconCss: string;
  formCss: string;
  formJs: string;
  /** The tab's title, for a screen reader. */
  title: string;
}

function attr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function text(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function prCreateCsp(cspSource: string, nonce: string): string {
  return [
    "default-src 'none'",
    `img-src ${cspSource} https://avatars.githubusercontent.com data:`,
    `style-src ${cspSource}`,
    `font-src ${cspSource} data:`,
    `script-src 'nonce-${nonce}' ${cspSource}`,
  ].join("; ");
}

export function prCreateHtml(p: PrCreateHtmlParts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${attr(prCreateCsp(p.cspSource, p.nonce))}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${attr(p.codiconCss)}" rel="stylesheet" />
  <link href="${attr(p.formCss)}" rel="stylesheet" />
  <title>${text(p.title)}</title>
</head>
<body>
  <div id="root"></div>
  ${l10nWebviewScript(p.nonce)}
  <script nonce="${attr(p.nonce)}" src="${attr(p.formJs)}"></script>
</body>
</html>`;
}
