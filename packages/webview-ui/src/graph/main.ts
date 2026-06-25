// Graph webview entry point (browser context). Boots the <gitstudio-graph>
// element, signals readiness to the host, feeds it the streamed graph pages,
// and forwards user intents (select / open / context menu / loadMore) back to
// the extension host.

import "../styles/graph.css";
import "./commit-graph";
import type { CommitGraph, GraphAction } from "./commit-graph";
import type {
  GraphHostMessage,
  GraphWebviewMessage,
} from "@gitstudio/host-bridge/graphProtocol";

interface VsCodeApi {
  postMessage(message: GraphWebviewMessage): void;
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
  const graph = document.createElement("gitstudio-graph") as CommitGraph;
  graph.status = "loading";
  graph.onAction = (action: GraphAction) => {
    switch (action.type) {
      case "select":
        vscode.postMessage({ type: "selectCommit", sha: action.sha });
        break;
      case "open":
        vscode.postMessage({ type: "openCommit", sha: action.sha });
        break;
      case "context":
        vscode.postMessage({
          type: "contextMenu",
          sha: action.sha,
          x: action.x,
          y: action.y,
        });
        break;
      case "loadMore":
        vscode.postMessage({ type: "loadMore" });
        break;
    }
  };
  root.replaceChildren(graph);

  window.addEventListener("message", (event: MessageEvent) => {
    handle(graph, event.data as GraphHostMessage);
  });

  vscode.postMessage({ type: "ready" });
}

function handle(graph: CommitGraph, message: GraphHostMessage): void {
  switch (message?.type) {
    case "graphInit": {
      graph.head = message.head;
      graph.rows = message.rows;
      graph.totalColumns = message.totalColumns;
      graph.hasMore = message.hasMore;
      graph.status = message.rows.length === 0 ? "empty" : "ready";
      break;
    }
    case "graphAppend": {
      // Replace the array reference so Lit's property change fires; the
      // virtualizer keeps the scroll offset stable across the append.
      graph.rows = graph.rows.concat(message.rows);
      graph.totalColumns = Math.max(graph.totalColumns, message.totalColumns);
      graph.hasMore = message.hasMore;
      if (graph.status !== "ready" && graph.rows.length > 0) {
        graph.status = "ready";
      }
      break;
    }
    case "graphConfig":
      // Reserved: host-pushed palette override. The element derives its palette
      // from the theme today, so this is a no-op hook for now.
      break;
  }
}
