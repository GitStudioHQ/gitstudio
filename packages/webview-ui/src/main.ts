// Webview front-end entry point (runs in the browser context of the webview).
// Branches on the first host message: `init` -> 3-way MergeView, `diffInit` ->
// 2-way DiffView. Builds the app shell (toolbar + surface + bottom bar) for
// whichever mode applies and wires interactions back to the extension host.

import "./styles/diff.css";
import { configureMonacoWorkers } from "./monacoEnv";
import { vscodeApi } from "./vscodeApi";
import { MergeView, type MergeCountsView } from "./mergeView";
import { DiffView } from "./diffView";
import type {
  DiffInitPayload,
  HostMessage,
  MergeInitPayload,
} from "@gitstudio/host-bridge/protocol";
import type { WhitespaceMode } from "@gitstudio/engine/lineDiff";
import {
  arrowDown,
  arrowUp,
  chevronDoubleLeft,
  chevronDoubleRight,
  chevronsInward,
  historyIcon,
  iconElement,
  magicWand,
  openExternal,
  redoIcon,
  resetIcon,
  syncScroll,
  undoIcon,
} from "./icons";

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

// --- shared toolbar helpers ---

function button(label: string, variant: "" | "primary" | "bordered" = ""): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "jb-toolbar-btn";
  if (variant === "primary") {
    btn.classList.add("jb-primary");
  } else if (variant === "bordered") {
    btn.classList.add("jb-bordered");
  }
  btn.textContent = label;
  return btn;
}

function iconButton(svg: string, title: string): HTMLButtonElement {
  const btn = button("");
  btn.classList.add("jb-icon");
  btn.title = title;
  btn.appendChild(iconElement(svg));
  return btn;
}

/** A compact icon+text action, like IntelliJ's "≫ Left / ≪≫ All / ≪ Right". */
function iconTextButton(svg: string, label: string, title: string): HTMLButtonElement {
  const btn = button("");
  btn.title = title;
  btn.appendChild(iconElement(svg));
  btn.appendChild(document.createTextNode(label));
  return btn;
}

function toolbarLabel(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "jb-toolbar-label";
  span.textContent = text;
  return span;
}

function separator(): HTMLElement {
  const sep = document.createElement("span");
  sep.className = "jb-sep";
  return sep;
}

function whitespaceSelect(onChange: (mode: WhitespaceMode) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "jb-toolbar-select";
  select.title = "Whitespace handling";
  const options: Array<[WhitespaceMode, string]> = [
    ["none", "Do not ignore"],
    ["trailing", "Trim whitespaces"],
    ["all", "Ignore whitespaces"],
  ];
  for (const [value, text] of options) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  }
  select.addEventListener("change", () =>
    onChange(select.value as WhitespaceMode),
  );
  return select;
}

function granularityToggle(onChange: (showWords: boolean) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "jb-toolbar-select";
  select.title = "Highlight granularity";
  for (const [value, text] of [
    ["words", "Highlight words"],
    ["lines", "Highlight lines"],
  ]) {
    const opt = document.createElement("option");
    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  }
  select.addEventListener("change", () => onChange(select.value === "words"));
  return select;
}

function note(): HTMLElement {
  const span = document.createElement("span");
  span.className = "jb-note";
  span.hidden = true;
  return span;
}

// --- 3-way merge mode ---

function startMerge(root: HTMLElement, first: MergeInitPayload & { type: "init" }): void {
  const app = document.createElement("div");
  app.className = "jb-app";

  // Top toolbar, laid out like the IntelliJ merge window header.
  const toolbar = document.createElement("div");
  toolbar.className = "jb-toolbar";

  const isMac = navigator.platform.toUpperCase().includes("MAC");
  const undoBtn = iconButton(undoIcon, `Undo (${isMac ? "⌘Z" : "Ctrl+Z"})`);
  const redoBtn = iconButton(
    redoIcon,
    `Redo (${isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"})`,
  );
  undoBtn.disabled = true;
  redoBtn.disabled = true;

  // History dropdown: every merge action this session, newest first.
  const historyWrap = document.createElement("span");
  historyWrap.className = "jb-history-wrap";
  const historyBtn = iconButton(historyIcon, "Action history");
  historyBtn.disabled = true;
  const historyPop = document.createElement("div");
  historyPop.className = "jb-history-pop";
  historyPop.hidden = true;
  historyWrap.append(historyBtn, historyPop);

  const prevBtn = iconButton(arrowUp, "Previous change (Shift+F7)");
  const nextBtn = iconButton(arrowDown, "Next change (F7)");

  const applyLeftBtn = iconTextButton(
    chevronDoubleRight,
    "Left",
    "Apply non-conflicting changes from the left side",
  );
  const applyAllBtn = iconTextButton(
    chevronsInward,
    "All",
    "Apply all non-conflicting changes",
  );
  const applyRightBtn = iconTextButton(
    chevronDoubleLeft,
    "Right",
    "Apply non-conflicting changes from the right side",
  );
  const magicBtn = iconButton(
    magicWand,
    "Resolve simple conflicts (both sides made the same change)",
  );
  magicBtn.disabled = true;

  const wsSelect = whitespaceSelect((mode) =>
    view.setRenderOptions({ whitespace: mode }),
  );
  const granSelect = granularityToggle((showWords) =>
    view.setRenderOptions({ showInner: showWords }),
  );

  const syncBtn = iconButton(syncScroll, "Synchronized scrolling");
  syncBtn.classList.add("jb-toggled");
  const resetBtn = iconButton(resetIcon, "Reset the merge to its initial state");

  const largeNote = note();

  const spacer = document.createElement("span");
  spacer.className = "jb-spacer";

  const counter = document.createElement("span");
  counter.className = "jb-counter";
  counter.textContent = "Loading…";

  toolbar.append(
    undoBtn,
    redoBtn,
    historyWrap,
    separator(),
    prevBtn,
    nextBtn,
    separator(),
    toolbarLabel("Apply non-conflicting changes:"),
    applyLeftBtn,
    applyAllBtn,
    applyRightBtn,
    magicBtn,
    separator(),
    wsSelect,
    granSelect,
    separator(),
    syncBtn,
    resetBtn,
    largeNote,
    spacer,
    counter,
  );

  const content = document.createElement("div");
  content.className = "jb-merge-content";

  // Bottom bar, like the IntelliJ dialog footer.
  const bottomBar = document.createElement("div");
  bottomBar.className = "jb-bottom-bar";

  const acceptLeftBtn = button("Accept Left", "bordered");
  acceptLeftBtn.title = "Resolve everything using the left version";
  const acceptRightBtn = button("Accept Right", "bordered");
  acceptRightBtn.title = "Resolve everything using the right version";

  const bottomSpacer = document.createElement("span");
  bottomSpacer.className = "jb-spacer";

  const cancelBtn = button("Cancel", "bordered");
  cancelBtn.title = "Exit the viewer, or cancel the whole merge request";
  const applyBtn = button("Apply", "primary");
  applyBtn.title = "Save the result and mark the conflict resolved";

  bottomBar.append(acceptLeftBtn, acceptRightBtn, bottomSpacer);

  // Escape hatch to the real IDE merge window; only offered when one exists.
  // Tucked away right of the spacer, with a gap before Cancel/Apply so it
  // can't be hit when aiming at the resolution buttons.
  if (first.jetbrainsName) {
    const jetbrainsBtn = button(`Open in ${first.jetbrainsName}`);
    jetbrainsBtn.classList.add("jb-external");
    jetbrainsBtn.prepend(iconElement(openExternal));
    jetbrainsBtn.title =
      "Close this editor and resolve the conflict in the real " +
      `${first.jetbrainsName} merge window`;
    jetbrainsBtn.addEventListener("click", () => {
      vscodeApi.postMessage({ type: "openInJetBrains" });
    });
    bottomBar.append(jetbrainsBtn);
  }

  bottomBar.append(cancelBtn, applyBtn);

  app.append(toolbar, content, bottomBar);
  root.replaceChildren(app);

  const view = new MergeView(content);

  let counts: MergeCountsView = { total: 0, pending: 0, conflictsPending: 0 };
  view.onCountsChanged = (next) => {
    counts = next;
    updateMergeToolbar(counter, counts);
    magicBtn.disabled = !view.hasSimpleConflicts();
    // Resolution buttons deactivate once they have nothing left to do (and
    // re-activate on undo/reset, since this fires on every state change).
    const nothingPending = counts.pending === 0;
    acceptLeftBtn.disabled = nothingPending;
    acceptRightBtn.disabled = nothingPending;
    // Pending work again (undo, reset, re-diff) revokes the green
    // confirmation; it is granted in the Accept click handlers, which run
    // after the (synchronous) bulk accept settles the counts.
    if (!nothingPending) {
      acceptLeftBtn.classList.remove("jb-confirmed");
      acceptRightBtn.classList.remove("jb-confirmed");
    }
    const nonConflictingPending = counts.pending - counts.conflictsPending;
    applyLeftBtn.disabled = nonConflictingPending === 0;
    applyAllBtn.disabled = nonConflictingPending === 0;
    applyRightBtn.disabled = nonConflictingPending === 0;
    // Any new resolution activity (including Reset) re-arms Apply after a
    // completed merge and clears a pending two-step confirmation.
    applyBtn.disabled = false;
    disarmApply();
  };

  view.onLargeFile = (large) => {
    largeNote.hidden = !large;
    largeNote.textContent = large
      ? "Large file: word-level highlights disabled"
      : "";
  };

  let syncTimer = 0;
  view.onResultChanged = () => {
    if (syncTimer) {
      window.clearTimeout(syncTimer);
    }
    syncTimer = window.setTimeout(() => {
      syncTimer = 0;
      vscodeApi.postMessage({ type: "resultChanged", text: view.getResultText() });
    }, 250);
  };

  undoBtn.addEventListener("click", () => view.undo());
  redoBtn.addEventListener("click", () => view.redo());

  const refreshHistoryUi = () => {
    undoBtn.disabled = !view.canUndo();
    redoBtn.disabled = !view.canRedo();
    const history = view.getHistory();
    historyBtn.disabled =
      history.undo.length === 0 && history.redo.length === 0;
    if (!historyPop.hidden) {
      renderHistoryPop();
    }
  };
  view.onHistoryChanged = refreshHistoryUi;

  function renderHistoryPop(): void {
    const history = view.getHistory();
    historyPop.replaceChildren();
    if (history.undo.length === 0 && history.redo.length === 0) {
      const empty = document.createElement("div");
      empty.className = "jb-history-empty";
      empty.textContent = "No actions yet";
      historyPop.appendChild(empty);
      return;
    }
    // Undone actions on top (dim, clickable to re-apply), next redo first.
    for (let i = history.redo.length - 1; i >= 0; i--) {
      const steps = history.redo.length - i;
      const item = document.createElement("div");
      item.className = "jb-history-item jb-history-redo";
      item.textContent = history.redo[i];
      item.title = "Undone — click to re-apply up to here";
      item.addEventListener("click", () => {
        for (let n = 0; n < steps; n++) {
          view.redo();
        }
        historyPop.hidden = true;
      });
      historyPop.appendChild(item);
    }
    // Applied actions, newest first; clicking one undoes it and what followed.
    for (let i = history.undo.length - 1; i >= 0; i--) {
      const index = i;
      const item = document.createElement("div");
      item.className = "jb-history-item";
      item.textContent = history.undo[i];
      item.title = "Click to undo back to before this action";
      item.addEventListener("click", () => {
        view.undoTo(index);
        historyPop.hidden = true;
      });
      historyPop.appendChild(item);
    }
  }

  historyBtn.addEventListener("click", (event) => {
    event.stopPropagation();
    historyPop.hidden = !historyPop.hidden;
    if (!historyPop.hidden) {
      const rect = historyBtn.getBoundingClientRect();
      historyPop.style.top = `${rect.bottom + 4}px`;
      historyPop.style.left = `${rect.left}px`;
      renderHistoryPop();
    }
  });
  document.addEventListener("click", (event) => {
    if (!historyPop.hidden && !historyWrap.contains(event.target as Node)) {
      historyPop.hidden = true;
    }
  });

  // Cmd+Z (mac) / Ctrl+Z (win/linux) outside the editors (toolbar focus
  // etc.). Inside Monaco the editor-level commands in MergeView handle the
  // same keys — KeyMod.CtrlCmd resolves to ⌘ on mac automatically.
  window.addEventListener("keydown", (event) => {
    const mod = isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.altKey) {
      return;
    }
    const target = event.target as HTMLElement | null;
    if (target?.closest?.(".monaco-editor")) {
      return;
    }
    const key = event.key.toLowerCase();
    if (key === "z") {
      event.preventDefault();
      if (event.shiftKey) {
        view.redo();
      } else {
        view.undo();
      }
    } else if (key === "y") {
      event.preventDefault();
      view.redo();
    }
  });

  prevBtn.addEventListener("click", () => view.goToPrevChange());
  nextBtn.addEventListener("click", () => view.goToNextChange());
  applyLeftBtn.addEventListener("click", () => view.applyNonConflictingSide("left"));
  applyAllBtn.addEventListener("click", () => view.applyAllNonConflicting());
  applyRightBtn.addEventListener("click", () => view.applyNonConflictingSide("right"));
  magicBtn.addEventListener("click", () => view.resolveSimpleConflicts());
  acceptLeftBtn.addEventListener("click", () => {
    view.acceptAllLeft();
    acceptLeftBtn.classList.toggle("jb-confirmed", counts.pending === 0);
  });
  acceptRightBtn.addEventListener("click", () => {
    view.acceptAllRight();
    acceptRightBtn.classList.toggle("jb-confirmed", counts.pending === 0);
  });

  syncBtn.addEventListener("click", () => {
    const enabled = !view.getSyncScroll();
    view.setSyncScroll(enabled);
    syncBtn.classList.toggle("jb-toggled", enabled);
  });
  resetBtn.addEventListener("click", () => view.reset());

  cancelBtn.addEventListener("click", () => {
    vscodeApi.postMessage({ type: "cancel" });
  });

  // Applying with unresolved changes is allowed (as in IntelliJ) but asks for
  // a second click since webviews cannot show a native confirm dialog.
  let applyArmTimer = 0;
  const disarmApply = () => {
    if (applyArmTimer) {
      window.clearTimeout(applyArmTimer);
      applyArmTimer = 0;
    }
    applyBtn.classList.remove("jb-warn");
    applyBtn.textContent = "Apply";
  };
  applyBtn.addEventListener("click", () => {
    if (applyBtn.disabled) {
      return;
    }
    if (counts.pending > 0 && !applyArmTimer) {
      applyBtn.classList.add("jb-warn");
      applyBtn.textContent = `Apply with ${counts.pending} unresolved?`;
      applyArmTimer = window.setTimeout(disarmApply, 4000);
      return;
    }
    disarmApply();
    vscodeApi.postMessage({ type: "apply", text: view.getResultText() });
  });

  window.addEventListener("message", (event: MessageEvent) => {
    const message = event.data as HostMessage;
    if (message?.type === "init") {
      view.render(message);
    } else if (message?.type === "applied") {
      counter.textContent = message.staged
        ? "Merge applied and staged"
        : "Merge applied";
      counter.classList.add("jb-done");
      applyBtn.disabled = true;
    }
  });

  view.render(first);
}

function updateMergeToolbar(counter: HTMLElement, counts: MergeCountsView): void {
  if (counts.total === 0) {
    counter.classList.remove("jb-done");
    counter.textContent = "No changes";
  } else if (counts.pending === 0) {
    counter.textContent = "All changes have been processed";
    counter.classList.add("jb-done");
  } else {
    counter.classList.remove("jb-done");
    const changes = `${counts.pending} change${counts.pending === 1 ? "" : "s"}`;
    const conflicts = counts.conflictsPending
      ? ` ${counts.conflictsPending} conflict${counts.conflictsPending === 1 ? "" : "s"}.`
      : "";
    counter.textContent = `${changes}.${conflicts}`;
  }
}

// --- 2-way diff mode ---

function startDiff(root: HTMLElement, first: DiffInitPayload & { type: "diffInit" }): void {
  const app = document.createElement("div");
  app.className = "jb-app";

  const toolbar = document.createElement("div");
  toolbar.className = "jb-toolbar";

  const prevBtn = iconButton(arrowUp, "Previous change (Shift+F7)");
  const nextBtn = iconButton(arrowDown, "Next change (F7)");

  const wsSelect = whitespaceSelect((mode) =>
    view.setRenderOptions({ whitespace: mode }),
  );
  const granSelect = granularityToggle((showWords) =>
    view.setRenderOptions({ showInner: showWords }),
  );

  const largeNote = note();
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
    separator(),
    wsSelect,
    granSelect,
    largeNote,
    spacer,
    status,
    separator(),
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

  const handle = (message: HostMessage) => {
    if (message?.type === "diffInit") {
      label.textContent = message.fileName
        ? message.fileName.split(/[\\/]/).pop() ?? "Diff"
        : "Diff";
      view.render(message);
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
