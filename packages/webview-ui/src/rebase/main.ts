// Interactive-rebase webview entry point (browser context). Boots the
// <gitstudio-rebase> element, signals readiness, renders the host-supplied todo
// rows, and forwards the user's Start/Abort intent back to the extension host
// (which serializes via the engine and writes the git-rebase-todo).

import "./rebase.css";
import "./rebase-view";
import type { RebaseView, RebaseIntent } from "./rebase-view";
import type {
  RebaseHostMessage,
  RebaseWebviewMessage,
} from "@gitstudio/host-bridge/rebaseProtocol";

interface VsCodeApi {
  postMessage(message: RebaseWebviewMessage): void;
  getState(): unknown;
  setState(state: unknown): void;
}
declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

const root = document.getElementById("root");
if (root) {
  start(root);
}

function start(root: HTMLElement): void {
  const view = document.createElement("gitstudio-rebase") as RebaseView;
  view.onIntent = (intent: RebaseIntent) => {
    if (intent.type === "start") {
      vscode.postMessage({ type: "start", rows: intent.rows });
    } else {
      vscode.postMessage({ type: "abort" });
    }
  };
  root.replaceChildren(view);

  window.addEventListener("message", (event: MessageEvent) => {
    handle(view, event.data as RebaseHostMessage);
  });

  vscode.postMessage({ type: "ready" });
}

function handle(view: RebaseView, message: RebaseHostMessage): void {
  switch (message?.type) {
    case "rebaseInit":
      view.headerComment = message.headerComment;
      view.rows = message.rows;
      break;
  }
}
