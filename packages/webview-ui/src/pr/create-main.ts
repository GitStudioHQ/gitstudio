// A new pull request's form — the webview entry point (browser context).
//
// THE FORM CONTRACT (the extension's PrCreatePage builds against it):
// - Bundle: esbuild entry `packages/webview-ui/src/pr/create-main.ts` →
//   `dist/webview/pr-create.js` (IIFE, browser); its CSS import emits
//   `dist/webview/pr-create.css` beside it. The host page links both, plus
//   the codicon stylesheet, under the webview's CSP.
// - DOM: the host page provides `<div id="root"></div>`.
// - Messages: host-bridge/prProtocol — `ready` from the form once it listens,
//   then a full `{ type: "state", state }` from the host after every change.
//
// The component itself (prCreate.ts) is host-agnostic; the desktop can mount
// the same class.

import { installSolidAccent } from "../styles/solidAccent";
import "../styles/pr-create.css";
import type { PrCreateHostMessage, PrCreateMessageToHost } from "@gitstudio/host-bridge/prProtocol";
import { PullRequestCreate } from "./prCreate";

// A see-through theme focus colour (Cursor Dark) gets an opaque accent.
installSolidAccent();

interface PrCreateVsCodeApi {
  postMessage(message: PrCreateMessageToHost): void;
}
declare function acquireVsCodeApi(): PrCreateVsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById("root");

if (root) {
  // VS Code's webview stylesheet pads the body; the form lays out its own
  // margins, on the editor's ground. Through the CSSOM: the CSP allows no
  // inline style.
  for (const e of [document.documentElement, document.body]) {
    e.style.margin = "0";
    e.style.padding = "0";
  }
  document.body.style.backgroundColor = "var(--vscode-editor-background)";
  // Listen BEFORE the component announces itself: its constructor posts
  // `ready`, and a host that answers at once must not be missed.
  let form: PullRequestCreate | undefined;
  const queued: PrCreateHostMessage[] = [];
  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as PrCreateHostMessage | undefined;
    if (message?.type !== "state") return;
    if (form) form.render(message.state);
    else queued.push(message);
  });
  form = new PullRequestCreate(root, { post: (msg) => api.postMessage(msg) });
  for (const q of queued.splice(0)) form.render(q.state);
}
