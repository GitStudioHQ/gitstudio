// Graph webview entry point (browser context). Boots the <gitstudio-graph>
// element with a docked <gitstudio-commit-details> panel below it — the
// GitKraken/GitLens "graph + inspect" layout. Selecting a commit shows its
// details; the details panel's file-open / action / copy events and the
// graph's select/open/context/loadMore intents are forwarded to the host.

import "../styles/graph.css";
import "./commit-graph";
import "../commit-details";
import type { CommitGraph, GraphAction } from "./commit-graph";
import type { CommitDetails } from "../commit-details";
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
  // Layout shell: graph pane (flex) + drag divider + details pane.
  const shell = document.createElement("div");
  shell.className = "gs-shell";

  const graphPane = document.createElement("div");
  graphPane.className = "gs-graph-pane";
  const graph = document.createElement("gitstudio-graph") as CommitGraph;
  graph.status = "loading";
  graphPane.appendChild(graph);

  const divider = document.createElement("div");
  divider.className = "gs-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", "horizontal");

  const details = document.createElement("gitstudio-commit-details") as CommitDetails;
  details.className = "gs-details-pane";

  shell.append(graphPane, divider, details);
  shell.dataset.detailsOpen = "false";
  root.replaceChildren(shell);

  // ── Graph intents → host ──────────────────────────────────────────────────
  graph.onAction = (action: GraphAction) => {
    switch (action.type) {
      case "select":
        vscode.postMessage({ type: "selectCommit", sha: action.sha });
        openDetails();
        break;
      case "open":
        vscode.postMessage({ type: "selectCommit", sha: action.sha });
        openDetails();
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
      case "refresh":
        vscode.postMessage({ type: "refresh" });
        break;
      case "requestStats":
        vscode.postMessage({ type: "requestStats", shas: action.shas });
        break;
    }
  };

  // ── Details panel events → host ───────────────────────────────────────────
  details.addEventListener("gs-file-open", (e) => {
    const d = (e as CustomEvent).detail as { path: string; wip?: boolean };
    const sha = details.details?.sha ?? "";
    vscode.postMessage({ type: "openFile", sha, path: d.path, wip: d.wip });
  });
  details.addEventListener("gs-action", (e) => {
    const d = (e as CustomEvent).detail as { id: string; sha: string };
    vscode.postMessage({ type: "commitAction", action: d.id, sha: d.sha });
  });
  details.addEventListener("gs-copy", (e) => {
    const d = (e as CustomEvent).detail as { text: string };
    vscode.postMessage({ type: "copyText", text: d.text });
  });

  // ── Resizable divider ─────────────────────────────────────────────────────
  let dragging = false;
  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    document.body.style.cursor = "row-resize";
  });
  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = shell.getBoundingClientRect();
    const fromBottom = rect.bottom - e.clientY;
    const h = Math.max(140, Math.min(rect.height - 120, fromBottom));
    shell.style.setProperty("--gs-details-h", `${h}px`);
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    try { divider.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    document.body.style.cursor = "";
  };
  divider.addEventListener("pointerup", endDrag);
  divider.addEventListener("pointercancel", endDrag);

  function openDetails(): void {
    shell.dataset.detailsOpen = "true";
  }

  // ── Host → webview ────────────────────────────────────────────────────────
  window.addEventListener("message", (event: MessageEvent) => {
    handle(graph, details, shell, event.data as GraphHostMessage);
  });

  vscode.postMessage({ type: "ready" });
}

function handle(
  graph: CommitGraph,
  details: CommitDetails,
  shell: HTMLElement,
  message: GraphHostMessage,
): void {
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
      graph.rows = graph.rows.concat(message.rows);
      graph.totalColumns = Math.max(graph.totalColumns, message.totalColumns);
      graph.hasMore = message.hasMore;
      if (graph.status !== "ready" && graph.rows.length > 0) {
        graph.status = "ready";
      }
      break;
    }
    case "commitDetails": {
      details.details = message.details;
      if (message.details) {
        shell.dataset.detailsOpen = "true";
      }
      break;
    }
    case "rowStats": {
      graph.setRowStats(message.stats);
      break;
    }
    case "revealCommit": {
      graph.reveal(message.sha);
      shell.dataset.detailsOpen = "true";
      break;
    }
    case "graphConfig":
      break;
  }
}
