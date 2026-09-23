// The merge / diff page and the CSP nonce, from the one implementation the
// shared merge experience uses (@gitstudio/merge-vscode/webviewHtml).
//
// This file used to build the merge page itself and redeclare the 3-pane grid
// inline (64 px gutters, a 28 px header) on top of webview-ui's diff.css,
// which the desktop app draws from with different numbers — the same merge,
// two geometries, misaligned (PLAN §3.6). The grid now has ONE definition,
// in packages/webview-ui/src/styles/diff.css.
export {
  mergeWebviewHtml as getWebviewHtml,
  getNonce,
} from "@gitstudio/merge-vscode/webviewHtml";
