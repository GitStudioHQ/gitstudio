// A pull request's page — the webview entry point (browser context).
//
// THE PAGE CONTRACT (the extension's PrPage builds against it):
// - Bundle: esbuild entry `packages/webview-ui/src/pr/page-main.ts` →
//   `dist/webview/pr-page.js` (IIFE, browser); its CSS import emits
//   `dist/webview/pr-page.css` beside it. The host page links both, plus the
//   codicon stylesheet, under the webview's CSP.
// - DOM: the host page provides `<div id="root"></div>`, with the merge
//   method offered first in `data-merge-method` (the setting).
// - Messages: host-bridge/prProtocol — `ready` from the page once it listens,
//   then a full `{ type: "state", state }` from the host after every change.
//
// The component itself (prPage.ts) is host-agnostic; the desktop can mount
// the same class.

import "@gitstudio/l10n/webview";

import { installSolidAccent } from "../styles/solidAccent";
import "../styles/pr-page.css";
import type { PrMergeMethod, PrPageHostMessage, PrPageMessageToHost } from "@gitstudio/host-bridge/prProtocol";
import { PullRequestPage } from "./prPage";

// A see-through theme focus colour (Cursor Dark) gets an opaque accent.
installSolidAccent();

interface PrPageVsCodeApi {
  postMessage(message: PrPageMessageToHost): void;
}
declare function acquireVsCodeApi(): PrPageVsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById("root");

if (root) {
  // VS Code's webview stylesheet pads the body; the page lays out its own
  // margins, on the editor's ground. Set through the CSSOM: the page's CSP
  // allows no inline style.
  for (const e of [document.documentElement, document.body]) {
    e.style.margin = "0";
    e.style.padding = "0";
  }
  document.body.style.backgroundColor = "var(--vscode-editor-background)";
  const m = root.dataset.mergeMethod;
  const preferredMethod: PrMergeMethod | undefined = m === "merge" || m === "squash" || m === "rebase" ? m : undefined;
  // Listen BEFORE the component announces itself: its constructor posts
  // `ready`, and a host that answers at once must not be missed.
  let page: PullRequestPage | undefined;
  const queued: PrPageHostMessage[] = [];
  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as PrPageHostMessage | undefined;
    if (message?.type !== "state") return;
    if (page) page.render(message.state);
    else queued.push(message);
  });
  page = new PullRequestPage(root, { post: (msg) => api.postMessage(msg), preferredMethod });
  for (const q of queued.splice(0)) page.render(q.state);
}
