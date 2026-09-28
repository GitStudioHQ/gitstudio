// Sidebar Commits webview entry point (browser context). Boots the
// <gitstudio-commit-rail> element — the sidebar-native commit log — and wires
// it to the SAME host protocol the editor-area graph speaks. The sidebar
// deliberately has no docked details pane: activating a commit posts
// `openInGraph`, which promotes it to the full Commit Graph panel.

import { installSolidAccent } from "../styles/solidAccent";
import "../styles/graph-sidebar.css";
import "./commit-rail";
import { applyGraphInitRefs } from "./graphInit";
import { setGravatarEnabled } from "./avatar";
import type { CommitRail, RailAction } from "./commit-rail";
import type {
  GraphHostMessage,
  GraphWebviewMessage,
} from "@gitstudio/host-bridge/graphProtocol";

// A see-through theme focus colour (Cursor Dark) gets an opaque accent.
installSolidAccent();

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
  const rail = document.createElement("gitstudio-commit-rail") as CommitRail;
  rail.status = "loading";
  root.replaceChildren(rail);

  rail.onAction = (action: RailAction) => {
    switch (action.type) {
      case "open":
        vscode.postMessage({ type: "openInGraph", sha: action.sha });
        break;
      case "context":
        vscode.postMessage({
          type: "contextMenu",
          sha: action.sha,
          // A selection of several (issue #32): the menu is for all of them.
          ...(action.shas ? { shas: action.shas } : {}),
          x: action.x,
          y: action.y,
        });
        break;
      case "menuAction":
        vscode.postMessage({
          type: "commitMenuAction",
          sha: action.sha,
          ...(action.shas ? { shas: action.shas } : {}),
          id: action.id,
        });
        break;
      case "copy":
        vscode.postMessage({ type: "copyText", text: action.text });
        break;
      case "loadMore":
        vscode.postMessage({ type: "loadMore" });
        break;
      case "refresh":
        vscode.postMessage({ type: "refresh" });
        break;
      case "setRefFilter":
        vscode.postMessage({ type: "setRefFilter", refs: action.refs });
        break;
      case "checkoutRef":
        vscode.postMessage({
          type: "checkoutRef",
          sha: action.sha,
          name: action.name,
          kind: action.kind,
          fullName: action.fullName,
        });
        break;
    }
  };

  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as GraphHostMessage;
    switch (message?.type) {
      case "graphInit":
        rail.head = message.head;
        rail.rows = message.rows;
        rail.totalColumns = message.totalColumns;
        rail.hasMore = message.hasMore;
        applyGraphInitRefs(rail, message);
        rail.status = message.noRepo
          ? "no-repo"
          : message.discovering
            ? "discovering"
            : message.rows.length === 0
              ? "empty"
              : "ready";
        break;
      case "graphAppend":
        rail.rows = rail.rows.concat(message.rows);
        rail.totalColumns = Math.max(rail.totalColumns, message.totalColumns);
        rail.hasMore = message.hasMore;
        if (rail.status !== "ready" && rail.rows.length > 0) {
          rail.status = "ready";
        }
        break;
      case "revealCommit":
        rail.reveal(message.sha);
        break;
      case "commitMenu":
        rail.showCommitMenu(
          message.sha,
          message.x,
          message.y,
          message.title,
          message.items,
          message.shas,
        );
        break;
      case "graphError":
        rail.errorMessage = message.message ?? "";
        rail.status = "error";
        break;
      case "authorAvatars":
        // Host-resolved author photos (e.g. GitHub) — repaint nodes in place.
        rail.authorAvatars = message.avatars;
        break;
      case "avatarPrefs":
        // `gitstudio.avatars.gravatar`: the rail repaints itself on a change.
        setGravatarEnabled(message.gravatar !== false);
        break;
      // The sidebar renders no details dock or CHANGES bars — these host
      // pushes are for the editor-area graph.
      case "commitDetails":
      case "commitsSummary":
      case "rowStats":
        break;
    }
  });

  vscode.postMessage({ type: "ready" });
}
