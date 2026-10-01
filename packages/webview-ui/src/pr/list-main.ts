// The Pull Requests list's webview entry point (browser context).
//
// THE PAGE CONTRACT (the extension's PullRequestsViewProvider builds against it):
// - Bundle: esbuild entry `packages/webview-ui/src/pr/list-main.ts` →
//   `dist/webview/pr-list.js` (IIFE, browser); its CSS import emits
//   `dist/webview/pr-list.css` beside it. The host page links both, plus the
//   codicon stylesheet the other webviews use, under the usual webview CSP
//   (img-src allows GitHub's avatar host).
// - DOM: the host page provides `<div id="root"></div>`; the list renders
//   inside it and nowhere else.
// - Messages: host-bridge/prProtocol — `ready` from the page once it listens,
//   then a full `{ type: "state", state }` from the host after every change.
//
// The component itself (prList.ts) is host-agnostic; the desktop can mount the
// same class in its own Pull Requests section.

import "@gitstudio/l10n/webview";

import { installSolidAccent } from "../styles/solidAccent";
import "../styles/pr-list.css";
import type { PrListHostMessage, PrListMessageToHost } from "@gitstudio/host-bridge/prProtocol";
import { PullRequestList } from "./prList";

// A see-through theme focus colour (Cursor Dark) gets an opaque accent.
installSolidAccent();

interface PrListVsCodeApi {
  postMessage(message: PrListMessageToHost): void;
}
declare function acquireVsCodeApi(): PrListVsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById("root");

if (root) {
  // VS Code's webview stylesheet pads the body 20px each side; the list runs
  // edge to edge, as the sidebar's own lists do, on the sidebar's ground. Set
  // through the CSSOM: the page's CSP allows no inline style, and pr-list.css
  // is also a host's that must not restyle a bare body.
  for (const e of [document.documentElement, document.body]) {
    e.style.margin = "0";
    e.style.padding = "0";
  }
  document.body.style.backgroundColor = "var(--vscode-sideBar-background, var(--vscode-editor-background))";
  // Listen BEFORE the component announces itself: its constructor posts
  // `ready`, and a host that answers at once must not be missed.
  let list: PullRequestList | undefined;
  const queued: PrListHostMessage[] = [];
  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as PrListHostMessage | undefined;
    if (message?.type !== "state") return;
    if (list) list.render(message.state);
    else queued.push(message);
  });
  list = new PullRequestList(root, { post: (m) => api.postMessage(m) });
  for (const m of queued.splice(0)) list.render(m.state);
}
