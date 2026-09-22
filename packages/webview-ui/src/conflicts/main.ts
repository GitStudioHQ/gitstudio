// Conflicts dashboard webview entry point (browser context).
//
// S0 contract seed: a STUB so hosts can wire the bundle before the dashboard
// exists. P3 owns this file and replaces the body with the ConflictsDashboard
// component (conflicts/dashboard.ts). The PAGE CONTRACT below is fixed:
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

import "../styles/conflicts.css";
import type {
  ConflictsAction,
  ConflictsHostMessage,
} from "@gitstudio/host-bridge/conflictsProtocol";

interface ConflictsVsCodeApi {
  postMessage(message: ConflictsAction): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): ConflictsVsCodeApi;

const api = acquireVsCodeApi();

// S0 STUB: accept state messages and render nothing — P3.
window.addEventListener("message", (event: MessageEvent) => {
  const message = event.data as ConflictsHostMessage | undefined;
  if (message?.type !== "state") {
    return;
  }
});

api.postMessage({ type: "ready" });
