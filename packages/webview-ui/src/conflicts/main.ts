// Conflicts dashboard webview entry point (browser context).
//
// The PAGE CONTRACT (fixed with the S0 seed; the VS Code host package builds
// against it):
//
// - Bundle: esbuild entry `packages/webview-ui/src/conflicts/main.ts` →
//   `dist/webview/conflicts.js` (IIFE, browser); its CSS import emits
//   `dist/webview/conflicts.css` beside it. The host page links both, plus the
//   codicon stylesheet the other webviews use, under the usual webview CSP.
// - DOM: the host page provides `<div id="root"></div>`; the dashboard renders
//   inside it and nowhere else.
// - Messages: on load the page posts `{ type: "ready" }` (a ConflictsAction);
//   the host answers with ConflictsHostMessage `{ type: "state", state }` and
//   re-sends a full state after every change. Every user action is posted as a
//   ConflictsAction (host-bridge/conflictsProtocol.ts). The page keeps no git
//   state of its own.
//
// The component itself (dashboard.ts) is host-agnostic; the desktop mounts the
// same class natively in its Changes view.

import "../styles/conflicts.css";
import type {
  ConflictsAction,
  ConflictsHostMessage,
} from "@gitstudio/host-bridge/conflictsProtocol";
import { ConflictsDashboard } from "./dashboard";

interface ConflictsVsCodeApi {
  postMessage(message: ConflictsAction): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): ConflictsVsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById("root");

if (root) {
  // The page is the dashboard's whole height, so its list scrolls and its
  // footer (Abort, Continue) stays on screen (.cd-host-fill). Set through the
  // CSSOM: the page's CSP allows no inline style, and conflicts.css is also
  // the desktop's, where a bare html/body rule would restyle the app.
  //
  // And the page's ground is the editor's, the dashboard's own: VS Code's
  // webview stylesheet gives the body 20px of padding each side and no
  // background, and what shows there was the browser's canvas — near-black
  // beside a light theme's dashboard on a Mac in dark mode.
  for (const el of [document.documentElement, document.body]) {
    el.style.height = "100%";
    el.style.margin = "0";
    el.style.backgroundColor = "var(--vscode-editor-background)";
  }
  root.classList.add("cd-host-fill");
  // Listen BEFORE the component announces itself: its constructor posts
  // `ready`, and a host that answers synchronously must not be missed.
  let dashboard: ConflictsDashboard | undefined;
  const queued: ConflictsHostMessage[] = [];
  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as ConflictsHostMessage | undefined;
    if (message?.type !== "state") return;
    if (dashboard) dashboard.render(message.state);
    else queued.push(message);
  });
  dashboard = new ConflictsDashboard(root, { post: (action) => api.postMessage(action) });
  for (const m of queued.splice(0)) dashboard.render(m.state);
}
