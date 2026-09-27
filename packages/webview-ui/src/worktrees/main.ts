// Worktrees webview entry point (browser context).
//
// PAGE CONTRACT: esbuild entry `packages/webview-ui/src/worktrees/main.ts` →
// `dist/webview/worktrees.js` (IIFE); its CSS import emits
// `dist/webview/worktrees.css` beside it. The host page (the extension's
// views/worktreesWebview.ts) links both and the codicon stylesheet, and gives
// `<div id="root">`. Messages: host-bridge/worktreesProtocol.ts — the page
// posts `ready` on load and the host answers with `rows`.

import { installSolidAccent } from "../styles/solidAccent";
import "./worktrees.css";
import type { WorktreesToHost, WorktreesToPage } from "@gitstudio/host-bridge/worktreesProtocol";
import { WorktreesView, type WorktreesLabels } from "./view";

// A see-through theme focus colour (Cursor Dark) gets an opaque accent.
installSolidAccent();

interface WorktreesVsCodeApi {
  postMessage(message: WorktreesToHost): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): WorktreesVsCodeApi;

const api = acquireVsCodeApi();
const root = document.getElementById("root");

if (root) {
  const view = new WorktreesView(root, (msg) => api.postMessage(msg));
  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data as (WorktreesToPage & { labels?: WorktreesLabels }) | { type: "revalidate" } | undefined;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "revalidate") {
      view.revalidateVisible();
      return;
    }
    view.receive(msg);
  });
  api.postMessage({ type: "ready" });
}
