// Graph webview entry point (browser context). Boots the <gitstudio-graph>
// element with a docked <gitstudio-commit-details> panel below it — the
// GitKraken/GitLens "graph + inspect" layout. Selecting a commit shows its
// details; the details panel's file-open / action / copy events and the
// graph's select/open/context/loadMore intents are forwarded to the host.

import "@gitstudio/l10n/webview";

import { installSolidAccent } from "../styles/solidAccent";
import "../styles/graph.css";
import "./commit-graph";
import "../commit-details";
import { applyGraphInitRefs } from "./graphInit";
import { setGravatarEnabled } from "./avatar";
import type { CommitGraph, GraphAction } from "./commit-graph";
import type { CommitDetails, RefMenuRequest, SelectionActionRequest } from "../commit-details";
import { summaryCommits } from "./selectionSummary";
import type {
  GraphHostMessage,
  GraphWebviewMessage,
  WireRef,
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
  // Layout shell: graph pane (flex) + drag divider + details pane.
  const shell = document.createElement("div");
  shell.className = "gs-shell";

  const graphPane = document.createElement("div");
  graphPane.className = "gs-graph-pane";
  const graph = document.createElement("gitstudio-graph") as CommitGraph;
  graph.status = "loading";
  graphPane.appendChild(graph);

  // "side" splits graph | details left/right (the wide, short bottom panel);
  // the default docks details under the graph (the tall editor tab).
  const side = root.dataset.layout === "side";
  shell.dataset.layout = side ? "side" : "dock";

  const divider = document.createElement("div");
  divider.className = "gs-divider";
  divider.setAttribute("role", "separator");
  divider.setAttribute("aria-orientation", side ? "vertical" : "horizontal");

  const details = document.createElement("gitstudio-commit-details") as CommitDetails;
  details.className = "gs-details-pane";

  // The bottom panel is short and wide: run both surfaces in compact density
  // (leaner columns, no SHA track, smaller chrome) so the message leads.
  // NB: set after `details` is constructed — referencing it earlier is a TDZ
  // crash that blanks the whole webview.
  if (side) {
    graph.setAttribute("compact", "");
    details.setAttribute("compact", "");
  }

  shell.append(graphPane, divider, details);
  shell.dataset.detailsOpen = "false";
  // Once the user closes the dock it stays closed while they browse (selecting
  // commits just highlights them); a double-click / parent-reveal re-opens it.
  shell.dataset.detailsDismissed = "false";
  root.replaceChildren(shell);

  // ── Graph intents → host ──────────────────────────────────────────────────
  graph.onAction = (action: GraphAction) => {
    switch (action.type) {
      case "select":
        // One commit again: its details, not a summary of a selection.
        details.selection = null;
        vscode.postMessage({ type: "selectCommit", sha: action.sha });
        // Clicking a commit IS a request to see it, so it always reopens the
        // dock. Closing it used to be sticky, which left no way back short of
        // reloading the window.
        openDetails();
        break;
      case "selection":
        // Several commits (issue #32): the dock says so and offers what can
        // be done to all of them. The rows name them now; the host answers
        // which actions apply (commitsSummary). None selected: the dock's
        // empty state.
        if (action.shas.length > 1) {
          details.selection = { commits: summaryCommits(graph, action.shas) };
          openDetails();
        } else {
          details.selection = null;
          details.details = null;
        }
        vscode.postMessage({ type: "selectCommits", shas: action.shas });
        break;
      case "showDetails":
        // Same commit, dock closed: just bring it back. The host already has
        // this commit's payload, so no selectCommit and no git work.
        openDetails();
        break;
      case "open":
        // An explicit open (double-click) always shows the details — of one
        // commit, so never under a summary of several.
        details.selection = null;
        shell.dataset.detailsDismissed = "false";
        vscode.postMessage({ type: "selectCommit", sha: action.sha });
        openDetails();
        break;
      case "context":
        vscode.postMessage({
          type: "contextMenu",
          sha: action.sha,
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
      case "reorder": {
        // Which local branches sit on the commits being rewritten. Sent with
        // the request so the host can offer to carry them along without asking
        // git a second time for something the graph already knows.
        const branches = graph.rebaseBranches;
        const touched = action.order.some((sha) => (branches[sha] ?? []).length > 0);
        vscode.postMessage({
          type: "reorderCommits",
          order: action.order,
          // The host asks; this only says whether the question is worth asking.
          updateRefs: touched,
        });
        break;
      }
      case "loadMore":
        vscode.postMessage({ type: "loadMore" });
        break;
      case "refresh":
        vscode.postMessage({ type: "refresh" });
        break;
      case "requestStats":
        vscode.postMessage({ type: "requestStats", shas: action.shas });
        break;
      case "refClick":
        // A chip is a link to its ref. The desktop has a page for one (its
        // Branches view); the extension has none, and dropped the click — a
        // pointer cursor over a chip that did nothing, while the Commits
        // rail beside it selected the row. It is the chip's own menu here:
        // Show only / Add / Remove / Checkout, the same one a right-click or
        // ⌥-click opens. From a "+N" card row (no pointer position), at the
        // top-left of the list, clamped in like any menu.
        graph.openRefMenu(
          { name: action.name, fullName: action.fullName, kind: action.kind as WireRef["kind"] },
          action.x ?? 24,
          action.y ?? 48,
          action.sha,
          { twins: action.twins },
        );
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

  // ── Details panel events → host ───────────────────────────────────────────
  details.addEventListener("gs-file-open", (e) => {
    const d = (e as CustomEvent).detail as { path: string; oldPath?: string; status?: string; wip?: boolean };
    const sha = details.details?.sha ?? "";
    // oldPath too: a renamed file's parent side is read under its old name.
    vscode.postMessage({ type: "openFile", sha, path: d.path, oldPath: d.oldPath, status: d.status, wip: d.wip });
  });
  details.addEventListener("gs-action", (e) => {
    const d = (e as CustomEvent).detail as { id: string; sha: string };
    vscode.postMessage({ type: "commitAction", action: d.id, sha: d.sha });
  });
  details.addEventListener("gs-copy", (e) => {
    const d = (e as CustomEvent).detail as { text: string };
    vscode.postMessage({ type: "copyText", text: d.text });
  });
  details.addEventListener("gs-close", () => closeDetails());
  // An action from the "N commits selected" summary: the same item the
  // selection's right-click menu offers, run the same way (issue #32).
  details.addEventListener("gs-selection-action", (e) => {
    const d = (e as CustomEvent<SelectionActionRequest>).detail;
    if (d.shas.length < 2) return;
    vscode.postMessage({ type: "commitMenuAction", sha: d.shas[0], shas: d.shas, id: d.id });
  });
  // Clicking a parent sha jumps to that commit. This was emitted by the details
  // pane but only ever handled by the DESKTOP app — in the extension the click
  // did nothing at all. Reveal it locally and ask the host for its details.
  details.addEventListener("gs-reveal", (e) => {
    const d = (e as CustomEvent).detail as { sha: string };
    // From the "N commits selected" summary too: that commit, alone.
    details.selection = null;
    graph.reveal(d.sha);
    openDetails();
    vscode.postMessage({ type: "selectCommit", sha: d.sha });
  });
  // A ref chip in the pane is the same shortcut it is in the graph's rows
  // (issue #30): its menu is the graph's own, which owns the filter and the
  // ref list the chip is resolved through.
  details.refMenu = true;
  details.addEventListener("gs-ref-menu", (e) => {
    const d = (e as CustomEvent<RefMenuRequest>).detail;
    graph.openRefMenu({ name: d.name, fullName: d.fullName, kind: d.kind }, d.x, d.y, d.sha, {
      opener: d.opener,
      keyboard: d.keyboard,
    });
  });
  // "in N branches" — a history walk, so it is only requested on demand.
  details.addEventListener("gs-contains", (e) => {
    const d = (e as CustomEvent).detail as { sha: string };
    vscode.postMessage({ type: "requestContains", sha: d.sha });
  });
  // Escape collapses the dock too (only when it's open, so it doesn't swallow
  // Escape elsewhere).
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && shell.dataset.detailsOpen === "true") {
      e.preventDefault();
      closeDetails();
    }
  });

  // ── Resizable divider ─────────────────────────────────────────────────────
  let dragging = false;
  divider.addEventListener("pointerdown", (e) => {
    dragging = true;
    divider.setPointerCapture(e.pointerId);
    document.body.style.cursor = side ? "col-resize" : "row-resize";
  });
  divider.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const rect = shell.getBoundingClientRect();
    // Clamp so BOTH panes keep a usable size — and compute the upper bound with
    // a max() so a very small pane can never invert the range (min > max, which
    // would pin the details pane to its minimum and swallow the graph).
    if (side) {
      // Details sit on the RIGHT, so size them from the shell's right edge.
      const fromRight = rect.right - e.clientX;
      const maxW = Math.max(260, rect.width - 320);
      const w = Math.max(260, Math.min(maxW, fromRight));
      shell.style.setProperty("--gs-details-w", `${w}px`);
      return;
    }
    const fromBottom = rect.bottom - e.clientY;
    const maxH = Math.max(140, rect.height - 120);
    const h = Math.max(140, Math.min(maxH, fromBottom));
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
    shell.dataset.detailsDismissed = "false";
    vscode.postMessage({ type: "detailsVisibility", open: true });
  }
  function closeDetails(): void {
    shell.dataset.detailsOpen = "false";
    shell.dataset.detailsDismissed = "true";
    // Tell the host, or it will think this commit is still fully on screen and
    // dedupe away the very click meant to bring the details back.
    vscode.postMessage({ type: "detailsVisibility", open: false });
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
      applyGraphInitRefs(graph, message);
      graph.status = message.noRepo
        ? "no-repo"
        : message.discovering
          ? "discovering"
          : message.rows.length === 0
            ? "empty"
            : "ready";
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
      // Fill the dock's content, but don't force it open if the user dismissed
      // it — they're browsing with the dock collapsed.
      if (message.details) {
        shell.dataset.detailsOpen = "true";
      }
      break;
    }
    case "rowStats": {
      graph.setRowStats(message.stats);
      // A batch the host could not run at all: released, not recorded, so
      // the next repaint asks again — a zero here would be an answer.
      if (message.unanswered?.length) graph.failRowStats(message.unanswered, false);
      break;
    }
    case "rebaseChain": {
      graph.setRebaseChain({
        shas: message.shas,
        stop: message.stop,
        branches: message.branches,
      });
      break;
    }
    case "revealCommit": {
      // One commit, whatever was selected before: the reveal selects it alone,
      // and a "N commits selected" summary left in the dock would go on
      // offering Drop and Squash for commits the graph no longer shows as
      // selected (and take the late answer for them, commitsSummary below).
      details.selection = null;
      graph.reveal(message.sha);
      // An explicit reveal (e.g. clicking a parent) re-opens the dock.
      shell.dataset.detailsDismissed = "false";
      shell.dataset.detailsOpen = "true";
      break;
    }
    case "authorAvatars": {
      graph.authorAvatars = message.avatars;
      // The details pane shows the same person — give it the same photos.
      details.authorAvatars = message.avatars;
      break;
    }
    case "avatarPrefs": {
      // `gitstudio.avatars.gravatar`. The graph, its author card and the
      // details header all ask gravatarUrl(), and each repaints on a change.
      setGravatarEnabled(message.gravatar !== false);
      break;
    }
    case "commitMenu": {
      graph.showCommitMenu(
        message.sha,
        message.x,
        message.y,
        message.title,
        message.items,
        message.shas,
      );
      break;
    }
    case "commitsSummary": {
      // Only for the selection on screen: a late answer for one the user has
      // since changed is dropped.
      const on = details.selection?.commits.map((c) => c.sha) ?? [];
      if (on.length === message.shas.length && on.every((sha, i) => sha === message.shas[i])) {
        details.selection = { ...details.selection!, actions: message.items };
      }
      break;
    }
    case "commitContains": {
      details.setContains(message.sha, message.branches, message.truncated);
      break;
    }
    case "graphError": {
      graph.errorMessage = message.message ?? "";
      graph.status = "error";
      break;
    }
  }
}
