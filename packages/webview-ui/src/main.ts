// Webview front-end entry point (runs in the browser context of the webview).
// Branches on the first host message: `init` -> the merge shell around a
// 3-way MergeView, `diffInit` -> the 2-way DiffView. The merge shell is shared
// with Merge Studio and the desktop app (mergeShell.ts); this file only
// connects it to VS Code's messaging.

import "./styles/diff.css";
import "./styles/shell.css";
import { configureMonacoWorkers } from "./monacoEnv";
import { vscodeApi } from "./vscodeApi";
import { MergeView } from "./mergeView";
import { DiffView } from "./diffView";
import { MergeShell, toolbarIconButton, toolbarNote, toolbarSeparator, granularitySelect, whitespaceSelect } from "./mergeShell";
import type {
  DiffInitPayload,
  HostMessage,
  MergeInitPayload,
} from "@gitstudio/host-bridge/protocol";
import { arrowDown, arrowUp } from "./icons";

configureMonacoWorkers();

const root = document.getElementById("root");
if (root) {
  start(root);
}

function start(root: HTMLElement): void {
  let started = false;

  const onFirst = (event: MessageEvent) => {
    const message = event.data as HostMessage;
    if (started) {
      return;
    }
    if (message?.type === "init") {
      started = true;
      window.removeEventListener("message", onFirst);
      startMerge(root, message);
    } else if (message?.type === "diffInit") {
      started = true;
      window.removeEventListener("message", onFirst);
      startDiff(root, message);
    }
  };
  window.addEventListener("message", onFirst);

  // Signal the extension host that the webview is ready to receive content.
  vscodeApi.postMessage({ type: "ready" });
}

// --- 3-way merge mode ---

function startMerge(root: HTMLElement, first: MergeInitPayload & { type: "init" }): void {
  const shell = new MergeShell(root, first, {
    adapter: { post: (message) => vscodeApi.postMessage(message) },
    createView: (container) => new MergeView(container),
    // This webview IS the merge editor: ⌘Z with focus on the page body still
    // means the merge's history.
    windowUndoKeys: true,
  });
  window.addEventListener("message", (event: MessageEvent) => {
    shell.handle(event.data as HostMessage);
  });
}

// --- 2-way diff mode ---

function startDiff(root: HTMLElement, first: DiffInitPayload & { type: "diffInit" }): void {
  const app = document.createElement("div");
  app.className = "jb-app";

  const toolbar = document.createElement("div");
  toolbar.className = "jb-toolbar";

  const prevBtn = toolbarIconButton(arrowUp, "Previous change (Shift+F7)");
  const nextBtn = toolbarIconButton(arrowDown, "Next change (F7)");

  const wsSelect = whitespaceSelect((mode) =>
    view.setRenderOptions({ whitespace: mode }),
  );
  const granSelect = granularitySelect((showWords) =>
    view.setRenderOptions({ showInner: showWords }),
  );

  const largeNote = toolbarNote();
  const spacer = document.createElement("span");
  spacer.className = "jb-spacer";

  const status = document.createElement("span");
  status.className = "jb-counter";
  status.textContent = "Loading…";

  const label = document.createElement("span");
  label.className = "jb-toolbar-label";
  label.textContent = "Diff";

  toolbar.append(
    prevBtn,
    nextBtn,
    toolbarSeparator(),
    wsSelect,
    granSelect,
    largeNote,
    spacer,
    status,
    toolbarSeparator(),
    label,
  );

  const content = document.createElement("div");
  content.className = "jb-merge-content";

  app.append(toolbar, content);
  root.replaceChildren(app);

  const view = new DiffView(content);

  view.onLargeFile = (large) => {
    largeNote.hidden = !large;
    largeNote.textContent = large
      ? "Large file: word-level highlights disabled"
      : "";
  };

  view.onCountsChanged = (changes) => {
    if (changes === 0) {
      status.textContent = "Contents are identical";
      status.classList.add("jb-done");
    } else {
      status.textContent = `${changes} difference${changes === 1 ? "" : "s"}`;
      status.classList.remove("jb-done");
    }
    prevBtn.disabled = changes === 0;
    nextBtn.disabled = changes === 0;
  };

  let syncTimer = 0;
  view.onRightChanged = () => {
    if (syncTimer) {
      window.clearTimeout(syncTimer);
    }
    syncTimer = window.setTimeout(() => {
      syncTimer = 0;
      vscodeApi.postMessage({ type: "diffChanged", text: view.getRightText() });
    }, 250);
  };

  prevBtn.addEventListener("click", () => view.goToPrevChange());
  nextBtn.addEventListener("click", () => view.goToNextChange());

  // A tick asks the HOST to change the index; the webview never guesses the
  // outcome. The host writes, re-reads, and pushes a fresh stagingState — so
  // what the ticks show is always what git actually holds.
  view.onToggleTick = (row, staged) => {
    view.setTicksBusy(true);
    vscodeApi.postMessage({
      type: "toggleTick",
      block: {
        head: { start: row.block.leftSpan.start, end: row.block.leftSpan.endExclusive },
        working: { start: row.block.rightSpan.start, end: row.block.rightSpan.endExclusive },
        state: row.state,
      },
      staged,
    });
  };

  const handle = (message: HostMessage) => {
    if (message?.type === "diffInit") {
      label.textContent = message.fileName
        ? message.fileName.split(/[\\/]/).pop() ?? "Diff"
        : "Diff";
      view.render(message);
    } else if (message?.type === "stagingState") {
      view.setStagingState(message.indexText);
      view.setTicksBusy(false);
    } else if (message?.type === "persistState") {
      // Persist so the panel can be reconstructed after a window reload.
      vscodeApi.setState(message.state);
    }
  };

  window.addEventListener("message", (event: MessageEvent) =>
    handle(event.data as HostMessage),
  );

  handle(first);
}
