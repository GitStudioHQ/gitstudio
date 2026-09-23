// The merge shell: everything around the three-pane merge view — the toolbar,
// the operation strip, the notices, the legend slot, the no-text panel and the
// bottom bar — mounted identically by the GitStudio extension, Merge Studio and
// the desktop app.
//
// Extracted from main.ts, where it was the extension's alone: the desktop drew
// three buttons of its own over the same view ("Take ours / Take theirs / Mark
// resolved"), so the two products offered different moves, different words and
// different Apply rules for the same conflict (PLAN §2 rows 17–19, 23).
//
// The shell talks to its host through ONE seam, `MergeHostAdapter.post`, in the
// WebviewMessage vocabulary (host-bridge/protocol.ts). The extension adapter is
// `vscodeApi.postMessage`; the desktop's maps each message onto IPC. Host
// answers come back through `handle(HostMessage)`. The view comes from a
// `MergeViewFactory`, so the shell never imports Monaco and a test can hand it
// a fake.
//
// Rules the shell owns for every host:
// - Labels come from `payload.op` (PLAN §3.1): "Accept Yours" / "Accept Theirs",
//   pills with real branch names, the direction, the step, the commit. With no
//   `op` there is no strip, no Continue and no "Cancel <operation>".
// - Apply with unresolved changes asks once, inline, and says what the
//   unresolved changes will contain (D3). Auto-applying non-conflicting changes
//   is the host's setting, passed to render() — default OFF (D3 override).
// - "Continue <Op>" appears once the host reports no conflicts left and git
//   would accept it; an emptied commit asks before it is dropped.
// - A whitespace change that would throw away resolutions asks first (D7).
// - Anything but a text conflict shows the no-text panel, never the editor.

import type {
  HostMessage,
  MergeInitPayload,
  WebviewMessage,
} from "@gitstudio/host-bridge/protocol";
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import type { WhitespaceMode } from "@gitstudio/engine/lineDiff";
import {
  emptyMergeCounts,
  type EolMismatchInfo,
  type MergeCountsView,
  type MergeViewApi,
  type MergeViewFactory,
} from "./mergeViewApi";
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
import {
  abortIcon,
  arrowRightIcon,
  checkIcon,
  closeIcon,
  continueIcon,
  errorIcon,
  glyphEl,
  infoIcon,
  warningIcon,
} from "./shellIcons";
import { buildNoTextPanel, type NoTextPanel } from "./noTextPanel";
import {
  abortConfirm,
  abortLabel,
  appendName,
  continueBlockedText,
  directionParts,
  hasText,
  roleWord,
  sha7,
  stepText,
  willDropText,
} from "./conflicts/opText";

/** The one seam between the shell and whatever hosts it. */
export interface MergeHostAdapter {
  /** Deliver a message to the host (VS Code's postMessage, or the desktop's IPC mapping). */
  post(message: WebviewMessage): void;
}

export interface MergeShellOptions {
  adapter: MergeHostAdapter;
  /** How the shell gets its view: `(c) => new MergeView(c)`, or a test fake. */
  createView: MergeViewFactory;
  /** ⌘ vs Ctrl in tooltips and key handling; defaults to the platform. */
  isMac?: boolean;
  /**
   * Also take ⌘Z / ⇧⌘Z when focus is on nothing in particular (the page body).
   * True for a webview that IS the merge editor; false for the desktop, where
   * the app's own undo owns the key outside the merge surface.
   */
  windowUndoKeys?: boolean;
  /** How long the Apply confirm stays armed (ms). */
  armMs?: number;
}

/** A menu undo and a key undo landing this close together are one keypress. */
const HISTORY_DEDUPE_MS = 400;

// ── toolbar parts (shared with the diff mode in main.ts) ─────────────────────

export function toolbarButton(label: string, variant: "" | "primary" | "bordered" = ""): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "jb-toolbar-btn";
  if (variant === "primary") btn.classList.add("jb-primary");
  else if (variant === "bordered") btn.classList.add("jb-bordered");
  btn.textContent = label;
  return btn;
}

export function toolbarIconButton(svg: string, title: string): HTMLButtonElement {
  const btn = toolbarButton("");
  btn.classList.add("jb-icon");
  btn.title = title;
  btn.setAttribute("aria-label", title);
  btn.appendChild(iconElement(svg));
  return btn;
}

/** A compact icon+text action, like IntelliJ's "≫ Left / ≪≫ All / ≪ Right". */
export function toolbarIconTextButton(svg: string, label: string, title: string): HTMLButtonElement {
  const btn = toolbarButton("");
  btn.title = title;
  btn.appendChild(iconElement(svg));
  btn.appendChild(document.createTextNode(label));
  return btn;
}

export function toolbarLabel(text: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "jb-toolbar-label";
  span.textContent = text;
  return span;
}

export function toolbarSeparator(): HTMLElement {
  const sep = document.createElement("span");
  sep.className = "jb-sep";
  return sep;
}

export function whitespaceSelect(onChange: (mode: WhitespaceMode) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "jb-toolbar-select";
  select.title = "Whitespace handling";
  select.setAttribute("aria-label", "Whitespace handling");
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
  select.addEventListener("change", () => onChange(select.value as WhitespaceMode));
  return select;
}

export function granularitySelect(onChange: (showWords: boolean) => void): HTMLSelectElement {
  const select = document.createElement("select");
  select.className = "jb-toolbar-select";
  select.title = "Highlight granularity";
  select.setAttribute("aria-label", "Highlight granularity");
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

export function toolbarNote(): HTMLElement {
  const span = document.createElement("span");
  span.className = "jb-note";
  span.hidden = true;
  return span;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** The counter's words — unchanged from the extension's toolbar. */
export function counterText(counts: MergeCountsView): { text: string; done: boolean } {
  if (counts.total === 0) return { text: "No changes", done: false };
  if (counts.pending === 0) return { text: "All changes have been processed", done: true };
  const changes = `${plural(counts.pending, "change")}.`;
  const conflicts = counts.conflictsPending ? ` ${plural(counts.conflictsPending, "conflict")}.` : "";
  return { text: changes + conflicts, done: false };
}

/** The EOL notice's sentence ("Yours uses CRLF, theirs LF: the result keeps CRLF"). */
export function eolText(info: EolMismatchInfo): string {
  const says = (e: EolMismatchInfo["yours"]): string => (e === "none" ? "has no line breaks" : `uses ${e}`);
  const theirs = info.theirs === "none" ? "has none" : info.theirs;
  return `Yours ${says(info.yours)}, theirs ${theirs}: the result keeps ${info.result}.`;
}

/** The one-line note for a conflict with no common ancestor. */
function conflictTypeNote(payload: MergeInitPayload): string {
  if (payload.conflictType === "add-add" || payload.shape === "added-both") {
    return "Added on both sides, with no earlier version: every line is compared against an empty file.";
  }
  if (!payload.hasBase) {
    return "No common version was found, so both sides are compared against an empty file.";
  }
  return "";
}

// ── the shell ────────────────────────────────────────────────────────────────

export class MergeShell {
  /** The shell's root. Carries `data-merge-surface`, which the desktop's ⌘Z routing looks for. */
  readonly element: HTMLElement;

  private readonly adapter: MergeHostAdapter;
  private readonly createView: MergeViewFactory;
  private readonly isMac: boolean;
  private readonly armMs: number;
  private readonly ac = new AbortController();

  private payload: MergeInitPayload;
  private op?: OperationView;
  /** Unmerged paths the host last reported (opChanged); undefined until it has. */
  private remaining?: number;
  private viewApi?: MergeViewApi;
  private panel?: NoTextPanel;
  private counts: MergeCountsView = emptyMergeCounts();
  private wsMode: WhitespaceMode = "none";
  /** What the shell is waiting on the host for; every mutating control is locked meanwhile. */
  private busy: "" | "apply" | "take" | "continue" | "abort" = "";
  private busyTimer = 0;
  /** This file's result was written (Apply) or a whole side taken. */
  private applied = false;
  private appliedWarn = "";
  private lastTake?: "yours" | "theirs" | "delete";
  private armTimer = 0;
  private syncTimer = 0;
  private keyHistoryAt = -Infinity;
  private menuHistoryAt = -Infinity;
  private dropConfirming = false;
  private wsPending?: WhitespaceMode;
  /** The operation finished here (an outcome "done"): nothing is left to end. */
  private ended = false;
  /**
   * Apply disabled the button that had the keyboard (it is spent, or busy):
   * hand focus on to the next thing to press once the host has answered,
   * rather than leave it on <body>.
   */
  private applyHadFocus = false;

  // chrome
  private readonly toolbar: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly outcomeLine: HTMLElement;
  private readonly notices: HTMLElement;
  private readonly wsConfirm: HTMLElement;
  private readonly legendSlot: HTMLElement;
  private readonly content: HTMLElement;
  private readonly bottom: HTMLElement;
  private readonly bottomNote: HTMLElement;

  private readonly undoBtn: HTMLButtonElement;
  private readonly redoBtn: HTMLButtonElement;
  private readonly historyWrap: HTMLElement;
  private readonly historyBtn: HTMLButtonElement;
  private readonly historyPop: HTMLElement;
  private readonly prevBtn: HTMLButtonElement;
  private readonly nextBtn: HTMLButtonElement;
  private readonly applyYoursBtn: HTMLButtonElement;
  private readonly applyAllBtn: HTMLButtonElement;
  private readonly applyTheirsBtn: HTMLButtonElement;
  private readonly wandBtn: HTMLButtonElement;
  private readonly wsSelect: HTMLSelectElement;
  private readonly granSelect: HTMLSelectElement;
  private readonly syncBtn: HTMLButtonElement;
  private readonly resetBtn: HTMLButtonElement;
  private readonly largeNote: HTMLElement;
  private readonly counter: HTMLElement;

  private readonly acceptYoursBtn: HTMLButtonElement;
  private readonly acceptTheirsBtn: HTMLButtonElement;
  private readonly jetbrainsBtn: HTMLButtonElement;
  private readonly cancelWrap: HTMLElement;
  private readonly cancelBtn: HTMLButtonElement;
  private readonly cancelPop: HTMLElement;
  private readonly applyBtn: HTMLButtonElement;
  private readonly continueBtn: HTMLButtonElement;

  constructor(root: HTMLElement, first: MergeInitPayload, options: MergeShellOptions) {
    this.adapter = options.adapter;
    this.createView = options.createView;
    this.isMac = options.isMac ?? /mac/i.test(navigator.platform);
    this.armMs = options.armMs ?? 4000;
    this.payload = first;
    const signal = this.ac.signal;

    const app = document.createElement("div");
    app.className = "jb-app ms-shell";
    app.dataset.mergeSurface = "";
    this.element = app;

    // ── toolbar ──
    const toolbar = document.createElement("div");
    toolbar.className = "jb-toolbar";
    toolbar.setAttribute("role", "toolbar");
    toolbar.setAttribute("aria-label", "Merge");
    this.toolbar = toolbar;
    const mod = this.isMac ? "⌘" : "Ctrl+";
    this.undoBtn = toolbarIconButton(undoIcon, `Undo (${mod}Z)`);
    this.redoBtn = toolbarIconButton(redoIcon, `Redo (${this.isMac ? "⇧⌘Z" : "Ctrl+Shift+Z"})`);
    this.undoBtn.disabled = true;
    this.redoBtn.disabled = true;

    this.historyWrap = document.createElement("span");
    this.historyWrap.className = "jb-history-wrap";
    this.historyBtn = toolbarIconButton(historyIcon, "Action history");
    this.historyBtn.disabled = true;
    this.historyPop = document.createElement("div");
    this.historyPop.className = "jb-history-pop";
    this.historyPop.hidden = true;
    this.historyWrap.append(this.historyBtn, this.historyPop);

    this.prevBtn = toolbarIconButton(arrowUp, "Previous change (Shift+F7)");
    this.nextBtn = toolbarIconButton(arrowDown, "Next change (F7)");
    // Left is always Yours (D1), so the toolbar can name the roles.
    this.applyYoursBtn = toolbarIconTextButton(chevronDoubleRight, "Yours", "Apply non-conflicting changes from yours");
    this.applyAllBtn = toolbarIconTextButton(chevronsInward, "All", "Apply all non-conflicting changes");
    this.applyTheirsBtn = toolbarIconTextButton(chevronDoubleLeft, "Theirs", "Apply non-conflicting changes from theirs");
    this.applyYoursBtn.classList.add("ms-apply-yours");
    this.applyAllBtn.classList.add("ms-apply-all");
    this.applyTheirsBtn.classList.add("ms-apply-theirs");
    this.wandBtn = toolbarIconButton(
      magicWand,
      "Resolve simple conflicts (apply both sides where their edits don't overlap)",
    );
    this.wandBtn.classList.add("ms-wand");
    this.wandBtn.disabled = true;

    this.wsSelect = whitespaceSelect((mode) => this.requestWhitespace(mode));
    this.wsSelect.classList.add("ms-ws");
    this.granSelect = granularitySelect((showWords) => this.viewApi?.setRenderOptions({ showInner: showWords }));
    this.syncBtn = toolbarIconButton(syncScroll, "Synchronized scrolling");
    this.syncBtn.classList.add("jb-toggled");
    this.syncBtn.setAttribute("aria-pressed", "true");
    this.resetBtn = toolbarIconButton(resetIcon, "Reset the merge to where it started");
    this.largeNote = toolbarNote();
    const spacer = document.createElement("span");
    spacer.className = "jb-spacer";
    this.counter = document.createElement("span");
    this.counter.className = "jb-counter";
    this.counter.textContent = "Loading…";
    this.counter.setAttribute("role", "status");

    toolbar.append(
      this.undoBtn,
      this.redoBtn,
      this.historyWrap,
      toolbarSeparator(),
      this.prevBtn,
      this.nextBtn,
      toolbarSeparator(),
      toolbarLabel("Apply non-conflicting changes:"),
      this.applyYoursBtn,
      this.applyAllBtn,
      this.applyTheirsBtn,
      this.wandBtn,
      toolbarSeparator(),
      this.wsSelect,
      this.granSelect,
      toolbarSeparator(),
      this.syncBtn,
      this.resetBtn,
      this.largeNote,
      spacer,
      this.counter,
    );

    // ── operation strip, outcome, notices, whitespace confirm, legend ──
    this.strip = document.createElement("div");
    this.strip.className = "ms-opstrip";
    this.strip.setAttribute("role", "group");
    this.strip.setAttribute("aria-label", "Operation in progress");
    this.strip.hidden = true;

    this.outcomeLine = document.createElement("div");
    this.outcomeLine.className = "ms-outcome";
    this.outcomeLine.setAttribute("role", "status");
    this.outcomeLine.hidden = true;

    this.notices = document.createElement("div");
    this.notices.className = "ms-notices";

    this.wsConfirm = document.createElement("div");
    this.wsConfirm.className = "ms-confirm ms-ws-confirm";
    this.wsConfirm.setAttribute("role", "alert");
    this.wsConfirm.hidden = true;

    this.legendSlot = document.createElement("div");
    this.legendSlot.className = "ms-legend-slot";

    this.content = document.createElement("div");
    this.content.className = "jb-merge-content";

    // ── bottom bar ──
    this.bottom = document.createElement("div");
    this.bottom.className = "jb-bottom-bar";
    this.acceptYoursBtn = toolbarButton("Accept Yours", "bordered");
    this.acceptYoursBtn.classList.add("ms-accept-yours");
    this.acceptTheirsBtn = toolbarButton("Accept Theirs", "bordered");
    this.acceptTheirsBtn.classList.add("ms-accept-theirs");
    const bottomSpacer = document.createElement("span");
    bottomSpacer.className = "jb-spacer";
    this.bottomNote = document.createElement("span");
    this.bottomNote.className = "ms-bottom-note";
    this.bottomNote.setAttribute("role", "status");
    this.bottomNote.hidden = true;

    this.jetbrainsBtn = toolbarButton("");
    this.jetbrainsBtn.classList.add("jb-external");
    this.jetbrainsBtn.hidden = true;

    this.cancelWrap = document.createElement("span");
    this.cancelWrap.className = "ms-cancel-wrap";
    this.cancelBtn = toolbarButton("Cancel", "bordered");
    this.cancelBtn.classList.add("ms-cancel");
    this.cancelPop = document.createElement("div");
    this.cancelPop.className = "ms-pop";
    this.cancelPop.setAttribute("role", "dialog");
    this.cancelPop.hidden = true;
    this.cancelWrap.append(this.cancelBtn, this.cancelPop);

    this.applyBtn = toolbarButton("Apply", "primary");
    this.applyBtn.classList.add("ms-apply");
    this.applyBtn.title = "Save the result and mark the conflict resolved";
    this.continueBtn = toolbarButton("", "primary");
    this.continueBtn.classList.add("ms-continue");
    this.continueBtn.hidden = true;

    this.bottom.append(
      this.acceptYoursBtn,
      this.acceptTheirsBtn,
      bottomSpacer,
      this.bottomNote,
      this.jetbrainsBtn,
      this.cancelWrap,
      this.applyBtn,
      this.continueBtn,
    );

    app.append(
      toolbar,
      this.strip,
      this.outcomeLine,
      this.notices,
      this.wsConfirm,
      this.legendSlot,
      this.content,
      this.bottom,
    );
    root.replaceChildren(app);

    this.wire(signal, options.windowUndoKeys ?? false);
    this.load(first);
  }

  /** The mounted view (undefined while the no-text panel shows). */
  get view(): MergeViewApi | undefined {
    return this.viewApi;
  }

  // ── host messages ──

  handle(message: HostMessage): void {
    switch (message?.type) {
      case "init":
        this.load(message);
        break;
      case "applied":
        this.onApplied(message.staged, message.message);
        break;
      case "opChanged":
        this.op = message.op;
        this.remaining = message.remainingConflicts;
        this.renderStrip();
        this.syncBottom();
        this.passFocusOnFromApply();
        break;
      case "outcome":
        this.onOutcome(message.kind, message.text);
        break;
      default:
        break;
    }
  }

  /** The host's menu undo (desktop Edit ▸ Undo). One keypress never undoes twice. */
  undo(): void {
    this.menuHistory(false);
  }

  /** The host's menu redo. */
  redo(): void {
    this.menuHistory(true);
  }

  layout(): void {
    this.viewApi?.layout();
  }

  /**
   * Put the keyboard in the merge editor — for a host that opened it from a
   * button the editor then covers (the desktop dashboard's Merge…), which
   * otherwise leaves it on <body>. Text: on Next change, one Enter from the
   * first change (and that lands in the Result). No text: on the panel's
   * first answer. Else the first live control.
   */
  focus(): void {
    const live = (b: HTMLButtonElement | null | undefined): b is HTMLButtonElement =>
      !!b && !b.disabled && !b.hidden && !b.closest("[hidden]");
    const target =
      (this.panel ? this.panel.element.querySelector<HTMLButtonElement>("button:not([disabled])") : undefined) ??
      [this.nextBtn].find(live) ??
      [...this.element.querySelectorAll<HTMLButtonElement>("button")].find(live);
    target?.focus();
  }

  dispose(): void {
    this.ac.abort();
    window.clearTimeout(this.armTimer);
    window.clearTimeout(this.syncTimer);
    window.clearTimeout(this.busyTimer);
    this.viewApi?.dispose();
    this.viewApi = undefined;
  }

  // ── loading a payload (first mount and every re-init) ──

  private load(payload: MergeInitPayload): void {
    this.payload = payload;
    this.op = payload.op;
    this.remaining = undefined;
    this.applied = false;
    this.appliedWarn = "";
    this.lastTake = undefined;
    this.ended = false;
    this.applyHadFocus = false;
    this.setBusy("");
    this.disarmApply();
    this.dropConfirming = false;
    this.closeCancelPop();
    this.hideWsConfirm();

    // The JetBrains escape hatch, only when the host found an IDE — and only
    // for text: the IDE merges lines, and the hosts refuse to hand it a
    // binary, a deleted side or a file too large to read (syncBottom).
    this.jetbrainsBtn.replaceChildren();
    if (payload.jetbrainsName) {
      this.jetbrainsBtn.append(iconElement(openExternal), document.createTextNode(`Open in ${payload.jetbrainsName}`));
      this.jetbrainsBtn.title =
        `Close this editor and resolve the conflict in the ${payload.jetbrainsName} merge window`;
    }

    this.labelSides();
    this.renderStrip();
    this.renderNotices(undefined);

    if (hasText(payload.shape)) {
      this.panel = undefined;
      this.element.classList.remove("ms-no-text");
      if (!this.viewApi) {
        this.content.replaceChildren();
        this.viewApi = this.createView(this.content);
        this.wireView(this.viewApi);
      }
      this.viewApi.render(payload, { autoApplyNonConflicting: payload.autoApplyNonConflicting ?? false });
    } else {
      // No line-by-line merge exists for this file: dispose the editor rather
      // than leave three panes of decoded bytes (or of nothing) under the panel.
      this.viewApi?.dispose();
      this.viewApi = undefined;
      this.counts = emptyMergeCounts();
      this.element.classList.add("ms-no-text");
      this.panel = buildNoTextPanel(
        {
          path: payload.fileName,
          shape: payload.shape ?? "text",
          missingRole: payload.missingRole,
          op: payload.op,
          yoursLabel: payload.oursLabel,
          theirsLabel: payload.theirsLabel,
        },
        {
          takeRole: (role) => {
            if (this.busy) return;
            this.lastTake = role;
            this.setBusy("take");
            this.clearOutcome();
            this.adapter.post({ type: "takeRole", role });
          },
          deleteFile: () => {
            if (this.busy) return;
            this.lastTake = "delete";
            this.setBusy("take");
            this.clearOutcome();
            this.adapter.post({ type: "deleteFile" });
          },
        },
      );
      this.content.replaceChildren(this.panel.element);
      this.counter.textContent = "";
    }
    this.syncBottom();
  }

  private wireView(view: MergeViewApi): void {
    view.onCountsChanged = (next) => this.onCounts(next);
    view.onLargeFile = (large) => {
      this.largeNote.hidden = !large;
      this.largeNote.textContent = large ? "Large file: word-level highlights disabled" : "";
    };
    view.onEolMismatch = (info) => this.renderNotices(info);
    view.onResultChanged = () => {
      window.clearTimeout(this.syncTimer);
      this.syncTimer = window.setTimeout(() => {
        this.syncTimer = 0;
        if (this.viewApi) this.adapter.post({ type: "resultChanged", text: this.viewApi.getResultText() });
      }, 250);
    };
    view.onHistoryChanged = () => this.refreshHistory();
    view.attachLegend(this.legendSlot);
  }

  // ── side names ──

  private labelSides(): void {
    const op = this.op;
    const yours = op?.yours;
    const theirs = op?.theirs;
    const named = (role: "yours" | "theirs", name: string | undefined): string =>
      name ? `${role} (${name})` : role;
    this.acceptYoursBtn.title = yours?.description
      ? `Resolve every change with yours — ${yours.description}`
      : `Resolve every change with ${this.payload.oursLabel || "the left version"}`;
    this.acceptTheirsBtn.title = theirs?.description
      ? `Resolve every change with theirs — ${theirs.description}`
      : `Resolve every change with ${this.payload.theirsLabel || "the right version"}`;
    this.applyYoursBtn.title = `Apply non-conflicting changes from ${named("yours", yours?.name)}`;
    this.applyTheirsBtn.title = `Apply non-conflicting changes from ${named("theirs", theirs?.name)}`;
  }

  // ── the operation strip ──

  private renderStrip(): void {
    const op = this.op;
    this.strip.replaceChildren();
    if (!op || op.kind === "none" && !op.title) {
      this.strip.hidden = true;
      return;
    }
    this.strip.hidden = false;
    const dir = directionParts(op);
    if (dir) {
      const bar = document.createElement("span");
      bar.className = "ms-op-dir";
      bar.append(pill(dir.from.role, dir.from.name, dir.from.description));
      const verb = document.createElement("span");
      verb.className = "ms-op-verb";
      verb.append(glyphEl(arrowRightIcon), document.createTextNode(dir.verb), glyphEl(arrowRightIcon));
      bar.append(verb, pill(dir.to.role, dir.to.name, dir.to.description));
      this.strip.appendChild(bar);
    } else {
      // No direction (stash / none): still name the two sides.
      const bar = document.createElement("span");
      bar.className = "ms-op-dir";
      bar.append(pill("yours", op.yours.name, op.yours.description), pill("theirs", op.theirs.name, op.theirs.description));
      this.strip.appendChild(bar);
    }
    const title = document.createElement("span");
    title.className = "ms-op-title";
    title.textContent = op.title;
    title.title = op.title;
    this.strip.appendChild(title);
    // The header already carries the step and the commit for every kind P2
    // names; only add them when this one does not, so nothing is said twice.
    const step = stepText(op);
    if (step && !op.title.includes(step)) {
      const s = document.createElement("span");
      s.className = "ms-op-step";
      s.textContent = step;
      this.strip.appendChild(s);
    }
    if (op.commit && op.commit.sha && !op.title.includes(sha7(op.commit.sha))) {
      const c = document.createElement("span");
      c.className = "ms-op-commit";
      const sha = document.createElement("code");
      sha.textContent = sha7(op.commit.sha);
      c.append(sha, document.createTextNode(` ${op.commit.subject}`));
      c.title = op.commit.author ? `${op.commit.subject} — ${op.commit.author}` : op.commit.subject;
      this.strip.appendChild(c);
    }
    const note = conflictTypeNote(this.payload);
    if (note && hasText(this.payload.shape)) {
      const n = document.createElement("span");
      n.className = "ms-op-note";
      n.textContent = note;
      this.strip.appendChild(n);
    }
  }

  private renderNotices(eol: EolMismatchInfo | undefined): void {
    this.notices.replaceChildren();
    // Without an operation strip the conflict-type note has nowhere else to go.
    const note = !this.op ? conflictTypeNote(this.payload) : "";
    if (note && hasText(this.payload.shape)) this.notices.appendChild(notice("info", note, "ms-note-type"));
    if (eol) this.notices.appendChild(notice("warn", eolText(eol), "ms-note-eol"));
    this.notices.hidden = this.notices.childElementCount === 0;
  }

  // ── counts & toolbar state ──

  private onCounts(next: MergeCountsView): void {
    this.counts = next;
    const c = counterText(next);
    this.counter.textContent = c.text;
    this.counter.classList.toggle("jb-done", c.done);
    this.wandBtn.disabled = !this.viewApi?.hasSimpleConflicts();
    const nothingPending = next.pending === 0;
    this.acceptYoursBtn.disabled = nothingPending || !!this.busy;
    this.acceptTheirsBtn.disabled = nothingPending || !!this.busy;
    if (!nothingPending) {
      this.acceptYoursBtn.classList.remove("jb-confirmed");
      this.acceptTheirsBtn.classList.remove("jb-confirmed");
    }
    // Per side when the view reports categories; the overall count otherwise.
    const cat = next.byCategory;
    const catTotal = cat.conflict.total + cat.same.total + cat["yours-only"].total + cat["theirs-only"].total;
    const nonConflicting = next.pending - next.conflictsPending;
    const yoursPending = catTotal ? cat["yours-only"].pending + cat.same.pending : nonConflicting;
    const theirsPending = catTotal ? cat["theirs-only"].pending + cat.same.pending : nonConflicting;
    this.applyYoursBtn.disabled = yoursPending === 0;
    this.applyTheirsBtn.disabled = theirsPending === 0;
    this.applyAllBtn.disabled = nonConflicting === 0 && yoursPending === 0 && theirsPending === 0;
    // New resolution activity (including Reset) re-arms Apply after a completed
    // merge and clears a pending two-step confirmation.
    if (this.applied && !this.busy) {
      this.applied = false;
      this.appliedWarn = "";
    }
    this.disarmApply();
    this.syncBottom();
  }

  private refreshHistory(): void {
    const view = this.viewApi;
    if (!view) return;
    this.undoBtn.disabled = !view.canUndo();
    this.redoBtn.disabled = !view.canRedo();
    const history = view.getHistory();
    this.historyBtn.disabled = history.undo.length === 0 && history.redo.length === 0;
    if (!this.historyPop.hidden) this.renderHistoryPop();
  }

  private renderHistoryPop(): void {
    const view = this.viewApi;
    if (!view) return;
    const history = view.getHistory();
    this.historyPop.replaceChildren();
    if (history.undo.length === 0 && history.redo.length === 0) {
      const empty = document.createElement("div");
      empty.className = "jb-history-empty";
      empty.textContent = "No actions yet";
      this.historyPop.appendChild(empty);
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
        for (let n = 0; n < steps; n++) view.redo();
        this.historyPop.hidden = true;
      });
      this.historyPop.appendChild(item);
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
        this.historyPop.hidden = true;
      });
      this.historyPop.appendChild(item);
    }
  }

  // ── whitespace (D7) ──

  private requestWhitespace(mode: WhitespaceMode): void {
    if (mode === this.wsMode) return;
    if (!this.counts.hasProgress) {
      this.wsMode = mode;
      this.viewApi?.setRenderOptions({ whitespace: mode });
      return;
    }
    // Rebuilding under a new whitespace rule re-diffs the file, and the
    // resolutions made so far do not survive it. Ask, and put the select back
    // until the answer is yes.
    this.wsPending = mode;
    this.wsSelect.value = this.wsMode;
    this.wsConfirm.replaceChildren();
    const text = document.createElement("span");
    text.className = "ms-confirm-text";
    text.append(
      glyphEl(warningIcon),
      document.createTextNode(
        "Changing whitespace handling compares the files again, and the changes you have resolved so far " +
          "start over.",
      ),
    );
    const keep = toolbarButton("Keep my changes", "bordered");
    keep.classList.add("ms-ws-keep");
    keep.addEventListener("click", () => this.hideWsConfirm(true));
    const go = toolbarButton("Change anyway", "bordered");
    go.classList.add("ms-ws-go", "ms-danger");
    go.addEventListener("click", () => {
      const next = this.wsPending;
      this.hideWsConfirm(true);
      if (!next) return;
      this.wsMode = next;
      this.wsSelect.value = next;
      this.viewApi?.setRenderOptions({ whitespace: next });
    });
    this.wsConfirm.append(text, keep, go);
    this.wsConfirm.hidden = false;
    keep.focus();
  }

  /**
   * Put the whitespace question away. Answered (a button, or Escape), the
   * keyboard goes back to the select that asked it — removing the focused
   * button otherwise dropped it on <body>.
   */
  private hideWsConfirm(returnFocus = false): void {
    const had = !this.wsConfirm.hidden;
    this.wsPending = undefined;
    this.wsConfirm.hidden = true;
    this.wsConfirm.replaceChildren();
    if (returnFocus && had) this.wsSelect.focus();
  }

  // ── Apply (D3) ──

  private disarmApply(): void {
    if (this.armTimer) {
      window.clearTimeout(this.armTimer);
      this.armTimer = 0;
    }
    this.applyBtn.classList.remove("jb-warn");
    this.applyBtn.textContent = "Apply";
    this.applyBtn.removeAttribute("aria-describedby");
  }

  private clickApply(): void {
    const view = this.viewApi;
    if (!view || this.applyBtn.disabled || this.busy) return;
    const pending = this.counts.pending;
    if (pending > 0 && !this.armTimer) {
      // Allowed, as in IntelliJ — but only once the reader has been told what
      // they are saving: every unresolved block still holds the ORIGINAL text.
      this.applyBtn.classList.add("jb-warn");
      this.applyBtn.textContent = `Apply with ${pending} unresolved`;
      this.armTimer = window.setTimeout(() => {
        this.armTimer = 0;
        this.disarmApply();
        this.syncBottom();
      }, this.armMs);
      this.syncBottom();
      return;
    }
    this.disarmApply();
    this.dropConfirming = false;
    // Apply is about to be disabled under the keyboard (busy, then spent).
    this.applyHadFocus = document.activeElement === this.applyBtn;
    this.setBusy("apply");
    this.clearOutcome();
    this.syncBottom();
    this.adapter.post({ type: "apply", text: view.getResultText() });
  }

  /**
   * After an Apply that had the keyboard: once the host has answered, hand it
   * to the next thing to press — Continue when it has appeared, else Apply
   * again if it is live, else Cancel — instead of leaving it on <body>. Only
   * when the keyboard is still nowhere (or on the spent button): a user who
   * has moved on keeps their place.
   */
  private passFocusOnFromApply(): void {
    if (!this.applyHadFocus) return;
    const active = document.activeElement;
    if (active && active !== document.body && active !== this.applyBtn) {
      this.applyHadFocus = false;
      return;
    }
    const next = [this.continueBtn, this.applyBtn, this.cancelBtn].find(
      (b) => b.isConnected && !b.hidden && !b.disabled && !b.closest("[hidden]"),
    );
    if (!next || next === active) return;
    this.applyHadFocus = false;
    next.focus();
  }

  private onApplied(staged: boolean, message?: string): void {
    this.setBusy("");
    this.applied = true;
    this.appliedWarn = staged ? "" : message || "The file was saved but could not be staged.";
    if (this.panel) {
      const take = this.lastTake;
      const done =
        take === "delete"
          ? "Deleted the file and staged the deletion."
          : take
            ? `Kept ${take}${this.op ? ` (${take === "yours" ? this.op.yours.name : this.op.theirs.name})` : ""} and staged it.`
            : "Resolved.";
      this.panel.setResolved(staged ? (message ? `${done} ${message}` : done) : this.appliedWarn, staged);
    } else {
      this.counter.textContent = staged ? "Merge applied and staged" : "Merge applied";
      this.counter.classList.add("jb-done");
    }
    this.syncBottom();
    // A host that knows an operation follows with opChanged (which may bring
    // Continue); one that does not has said all it will.
    if (!this.op) this.passFocusOnFromApply();
  }

  // ── Continue / Cancel ──

  private continueVisible(): boolean {
    const op = this.op;
    return !!op && !!op.verbs.continue && this.remaining === 0 && op.canContinue && !op.pause;
  }

  private clickContinue(): void {
    const op = this.op;
    if (!op || this.busy || !this.continueVisible()) return;
    if (op.willDrop && !this.dropConfirming) {
      this.dropConfirming = true;
      this.syncBottom();
      this.element.querySelector<HTMLButtonElement>(".ms-drop-keep")?.focus();
      return;
    }
    const confirmDrop = !!op.willDrop;
    this.dropConfirming = false;
    this.setBusy("continue");
    this.clearOutcome();
    this.syncBottom();
    this.adapter.post(confirmDrop ? { type: "continueOperation", confirmDrop: true } : { type: "continueOperation" });
  }

  private onOutcome(kind: "done" | "stopped" | "failed", text: string): void {
    this.setBusy("");
    this.outcomeLine.replaceChildren(
      glyphEl(kind === "done" ? checkIcon : kind === "failed" ? errorIcon : infoIcon),
      document.createTextNode(text),
    );
    this.outcomeLine.className = `ms-outcome is-${kind}`;
    this.outcomeLine.hidden = false;
    if (kind === "done") {
      // The operation is over: nothing here can act on it any more.
      this.remaining = undefined;
      this.ended = true;
      if (this.op) this.op = { ...this.op, canContinue: false };
    }
    this.syncBottom();
    // An Apply that failed (nothing written) leaves Apply live: the keyboard
    // goes back to it.
    this.passFocusOnFromApply();
  }

  /**
   * Is there still an operation for Cancel to end? Not once it has finished
   * here (an outcome "done"), and not when the host reports no operation and
   * no unmerged file left: "Cancel the merge" then runs `git reset --merge`
   * over nothing — which still unstages whatever is staged. Unmerged files
   * with no operation around them (kind "none" while any remain) ARE
   * something to reset.
   */
  private endable(): boolean {
    const op = this.op;
    if (!op || this.ended) return false;
    return !(op.kind === "none" && this.remaining === 0);
  }

  private clearOutcome(): void {
    this.outcomeLine.hidden = true;
    this.outcomeLine.replaceChildren();
  }

  private toggleCancelPop(): void {
    const op = this.op;
    // No operation known, or none left to end: Cancel means one thing, so it
    // does it.
    if (!op || !this.endable()) {
      this.closeCancelPop();
      this.adapter.post({ type: "cancel", mode: "exit" });
      return;
    }
    if (!this.cancelPop.hidden) {
      this.closeCancelPop();
      return;
    }
    this.renderCancelChoices(op);
    this.cancelPop.hidden = false;
    this.placeCancelPop();
    this.cancelBtn.setAttribute("aria-expanded", "true");
    this.cancelPop.querySelector<HTMLButtonElement>("button")?.focus();
  }

  /**
   * Keep the Cancel choices inside the shell. They open above Cancel, aligned
   * to its right edge — until the pane is narrow: once the bottom bar wraps,
   * Cancel can sit anywhere along it, and a 300px popover pinned to either of
   * its edges ran out of a 443px pane. Slide it along until it fits.
   */
  private placeCancelPop(): void {
    const pop = this.cancelPop;
    pop.style.left = "";
    pop.style.right = "";
    if (pop.hidden) return;
    const shell = this.element.getBoundingClientRect();
    const wrap = this.cancelWrap.getBoundingClientRect();
    const box = pop.getBoundingClientRect();
    const margin = 8;
    const min = shell.left + margin;
    const max = shell.right - margin - box.width;
    if (box.left >= min && box.left <= max) return;
    const left = Math.max(min, Math.min(max, box.left));
    pop.style.right = "auto";
    pop.style.left = `${Math.round(left - wrap.left)}px`;
  }

  private renderCancelChoices(op: OperationView): void {
    this.cancelPop.replaceChildren();
    const exit = toolbarButton("Exit viewer", "bordered");
    exit.classList.add("ms-exit");
    exit.prepend(glyphEl(closeIcon));
    exit.title = "Close the merge editor and keep the conflict in the file, to resolve later";
    exit.addEventListener("click", () => {
      this.closeCancelPop();
      this.adapter.post({ type: "cancel", mode: "exit" });
    });
    const end = toolbarButton(`${abortLabel(op)}…`, "bordered");
    end.classList.add("ms-abort", "ms-danger");
    end.prepend(glyphEl(abortIcon));
    end.disabled = !!this.busy;
    end.title = abortConfirm(op).detail;
    end.addEventListener("click", () => this.renderAbortConfirm(op));
    const hint = document.createElement("div");
    hint.className = "ms-pop-hint";
    hint.textContent = "Leave this file for later, or end the whole operation.";
    this.cancelPop.append(hint, exit, end);
  }

  private renderAbortConfirm(op: OperationView): void {
    const ask = abortConfirm(op);
    this.cancelPop.replaceChildren();
    const q = document.createElement("div");
    q.className = "ms-pop-question";
    q.textContent = ask.question;
    const d = document.createElement("div");
    d.className = "ms-pop-detail";
    d.textContent = ask.detail;
    const keep = toolbarButton("Keep resolving", "bordered");
    keep.classList.add("ms-abort-keep");
    keep.addEventListener("click", () => this.closeCancelPop(true));
    const go = toolbarButton(ask.confirm, "bordered");
    go.classList.add("ms-abort-go", "ms-danger");
    go.addEventListener("click", () => {
      if (this.busy) return;
      this.closeCancelPop();
      this.setBusy("abort");
      this.clearOutcome();
      this.syncBottom();
      this.adapter.post({ type: "cancel", mode: "abort" });
    });
    const row = document.createElement("div");
    row.className = "ms-pop-actions";
    row.append(keep, go);
    this.cancelPop.append(q, d, row);
    this.placeCancelPop();
    // A destructive question starts on the safe answer.
    keep.focus();
  }

  /** Close the Cancel choices; answered from inside, the keyboard goes back to Cancel. */
  private closeCancelPop(returnFocus = false): void {
    if (this.cancelPop.hidden) return;
    this.cancelPop.hidden = true;
    this.cancelPop.replaceChildren();
    this.cancelPop.style.left = "";
    this.cancelPop.style.right = "";
    this.cancelBtn.setAttribute("aria-expanded", "false");
    if (returnFocus) this.cancelBtn.focus();
  }

  // ── bottom bar ──

  private setBusy(what: MergeShell["busy"]): void {
    this.busy = what;
    window.clearTimeout(this.busyTimer);
    this.busyTimer = 0;
    this.element.classList.toggle("is-busy", !!what);
    this.panel?.setBusy(what === "take");
    if (what) {
      // A host that never answers must not leave the shell locked for good.
      this.busyTimer = window.setTimeout(() => {
        this.busyTimer = 0;
        this.setBusy("");
        this.syncBottom();
      }, 30_000);
    }
  }

  private syncBottom(): void {
    const noText = !!this.panel;
    const busy = !!this.busy;
    this.toolbar.hidden = noText;
    this.legendSlot.hidden = noText;
    this.acceptYoursBtn.hidden = noText;
    this.acceptTheirsBtn.hidden = noText;
    this.applyBtn.hidden = noText;
    if (!noText) {
      const nothingPending = this.counts.pending === 0;
      this.acceptYoursBtn.disabled = nothingPending || busy;
      this.acceptTheirsBtn.disabled = nothingPending || busy;
      this.applyBtn.disabled = busy || this.applied;
    }
    // The IDE merges lines: never offered over a panel with no text, nor once
    // the operation is over and there is no conflict left to hand it.
    this.jetbrainsBtn.hidden = !this.payload.jetbrainsName || noText || (!!this.op && !this.endable());
    this.cancelBtn.disabled = busy;
    const endable = this.endable();
    this.cancelBtn.title = endable
      ? "Exit the viewer, or end the whole operation"
      : "Close the merge editor and keep the conflict in the file";
    this.cancelBtn.setAttribute("aria-haspopup", endable ? "dialog" : "false");

    const showContinue = this.continueVisible();
    this.continueBtn.hidden = !showContinue;
    this.continueBtn.disabled = busy;
    if (showContinue && this.op) {
      this.continueBtn.replaceChildren(glyphEl(continueIcon), document.createTextNode(this.op.verbs.continue ?? "Continue"));
      this.continueBtn.title = this.op.title ? `${this.op.verbs.continue} — ${this.op.title}` : (this.op.verbs.continue ?? "");
    } else {
      this.dropConfirming = false;
    }
    // Apply stops being THE primary action once it has done its job.
    this.applyBtn.classList.toggle("jb-primary", !showContinue);
    this.applyBtn.classList.toggle("jb-bordered", showContinue);

    // One line of status beside the buttons, most urgent first.
    const note = this.bottomNote;
    note.replaceChildren();
    note.className = "ms-bottom-note";
    let text = "";
    let kind: "warn" | "info" | "" = "";
    if (this.dropConfirming && this.op?.willDrop) {
      this.renderDropConfirm(this.op);
      note.hidden = false;
      return;
    }
    if (this.armTimer) {
      const n = this.counts.pending;
      text = `${plural(n, "unresolved change")} will keep the original text. Click Apply again to save anyway.`;
      kind = "warn";
    } else if (this.appliedWarn) {
      text = this.appliedWarn;
      kind = "warn";
    } else if (this.op && this.applied && this.remaining !== undefined && this.remaining > 0) {
      text = `This file is done. ${plural(this.remaining, "file")} still ${this.remaining === 1 ? "has" : "have"} conflicts.`;
      kind = "info";
    } else if (this.op && this.remaining === 0 && !this.op.canContinue && this.op.verbs.continue) {
      text = continueBlockedText(this.op, 0);
      kind = "warn";
    }
    if (text) {
      note.append(glyphEl(kind === "warn" ? warningIcon : infoIcon), document.createTextNode(text));
      note.classList.add(`is-${kind}`);
      note.hidden = false;
      if (this.armTimer) {
        note.id = note.id || `ms-note-${Math.random().toString(36).slice(2, 8)}`;
        this.applyBtn.setAttribute("aria-describedby", note.id);
      }
    } else {
      note.hidden = true;
    }
  }

  private renderDropConfirm(op: OperationView): void {
    const note = this.bottomNote;
    note.classList.add("is-warn", "ms-drop-confirm");
    const text = document.createElement("span");
    text.className = "ms-confirm-text";
    text.append(glyphEl(warningIcon), document.createTextNode(willDropText(op)));
    const keep = toolbarButton("Keep editing", "bordered");
    keep.classList.add("ms-drop-keep");
    keep.addEventListener("click", () => this.closeDropConfirm());
    const go = toolbarButton("Drop it and continue", "bordered");
    go.classList.add("ms-drop-go", "ms-danger");
    go.addEventListener("click", () => this.clickContinue());
    note.append(text, keep, go);
  }

  /** Keep editing (or Escape): the question goes, the keyboard goes back to Continue. */
  private closeDropConfirm(): void {
    this.dropConfirming = false;
    this.syncBottom();
    if (!this.continueBtn.hidden && !this.continueBtn.disabled) this.continueBtn.focus();
  }

  // ── keys & wiring ──

  private keyHistory(redo: boolean): void {
    this.keyHistoryAt = performance.now();
    if (this.keyHistoryAt - this.menuHistoryAt < HISTORY_DEDUPE_MS) return;
    if (redo) this.viewApi?.redo();
    else this.viewApi?.undo();
  }

  private menuHistory(redo: boolean): void {
    this.menuHistoryAt = performance.now();
    if (this.menuHistoryAt - this.keyHistoryAt < HISTORY_DEDUPE_MS) return;
    if (redo) this.viewApi?.redo();
    else this.viewApi?.undo();
  }

  private undoKey(event: KeyboardEvent): "undo" | "redo" | undefined {
    const mod = this.isMac ? event.metaKey : event.ctrlKey;
    if (!mod || event.altKey) return undefined;
    const key = event.key.toLowerCase();
    if (key === "z") return event.shiftKey ? "redo" : "undo";
    if (key === "y" && !event.shiftKey) return "redo";
    return undefined;
  }

  private wire(signal: AbortSignal, windowKeys: boolean): void {
    const on = <K extends keyof HTMLElementEventMap>(
      el: HTMLElement,
      type: K,
      fn: (e: HTMLElementEventMap[K]) => void,
    ): void => el.addEventListener(type, fn, { signal });

    on(this.undoBtn, "click", () => this.viewApi?.undo());
    on(this.redoBtn, "click", () => this.viewApi?.redo());
    on(this.historyBtn, "click", (event) => {
      event.stopPropagation();
      this.historyPop.hidden = !this.historyPop.hidden;
      if (!this.historyPop.hidden) {
        const rect = this.historyBtn.getBoundingClientRect();
        this.historyPop.style.top = `${rect.bottom + 4}px`;
        this.historyPop.style.left = `${rect.left}px`;
        this.renderHistoryPop();
      }
    });
    on(this.prevBtn, "click", () => this.viewApi?.goToPrevChange());
    on(this.nextBtn, "click", () => this.viewApi?.goToNextChange());
    on(this.applyYoursBtn, "click", () => this.viewApi?.applyNonConflictingSide("left"));
    on(this.applyAllBtn, "click", () => this.viewApi?.applyAllNonConflicting());
    on(this.applyTheirsBtn, "click", () => this.viewApi?.applyNonConflictingSide("right"));
    on(this.wandBtn, "click", () => this.viewApi?.resolveSimpleConflicts());
    on(this.syncBtn, "click", () => {
      const view = this.viewApi;
      if (!view) return;
      const enabled = !view.getSyncScroll();
      view.setSyncScroll(enabled);
      this.syncBtn.classList.toggle("jb-toggled", enabled);
      this.syncBtn.setAttribute("aria-pressed", String(enabled));
    });
    on(this.resetBtn, "click", () => this.viewApi?.reset());
    on(this.acceptYoursBtn, "click", () => {
      if (this.busy) return;
      this.viewApi?.acceptAllLeft();
      this.acceptYoursBtn.classList.toggle("jb-confirmed", this.counts.pending === 0);
    });
    on(this.acceptTheirsBtn, "click", () => {
      if (this.busy) return;
      this.viewApi?.acceptAllRight();
      this.acceptTheirsBtn.classList.toggle("jb-confirmed", this.counts.pending === 0);
    });
    on(this.jetbrainsBtn, "click", () => this.adapter.post({ type: "openInJetBrains" }));
    on(this.cancelBtn, "click", (event) => {
      event.stopPropagation();
      if (this.busy) return;
      this.toggleCancelPop();
    });
    on(this.applyBtn, "click", () => this.clickApply());
    on(this.continueBtn, "click", () => this.clickContinue());

    // Popovers close on an outside click and on Escape. "Outside" is decided
    // from the event's PATH, fixed when it was dispatched: a click that
    // rebuilds the popover's own content (Abort → its confirm) has a detached
    // target by the time it bubbles here, and `contains()` would call that
    // click outside and close the question it had just asked.
    document.addEventListener(
      "click",
      (event) => {
        const path = event.composedPath();
        if (!this.historyPop.hidden && !path.includes(this.historyWrap)) this.historyPop.hidden = true;
        if (!this.cancelPop.hidden && !path.includes(this.cancelWrap)) this.closeCancelPop();
      },
      { signal },
    );
    on(this.element, "keydown", (event) => {
      if (event.key !== "Escape") return;
      if (!this.cancelPop.hidden) {
        event.stopPropagation();
        this.closeCancelPop();
        this.cancelBtn.focus();
      } else if (!this.wsConfirm.hidden) {
        event.stopPropagation();
        this.hideWsConfirm(true);
      } else if (this.dropConfirming) {
        event.stopPropagation();
        this.closeDropConfirm();
      }
    });

    // ⌘Z / ⇧⌘Z / ⌘Y anywhere inside the shell drive the MERGE history — in the
    // editors too. Capture phase, so it is decided here once: the editors'
    // own bindings, a text undo, and an app-wide undo underneath never see it.
    this.element.addEventListener(
      "keydown",
      (event) => {
        const which = this.undoKey(event);
        if (!which) return;
        event.preventDefault();
        event.stopPropagation();
        this.keyHistory(which === "redo");
      },
      { capture: true, signal },
    );
    if (windowKeys) {
      // Focus on nothing in particular (the page body) in a webview that IS
      // the merge editor: the keys still mean the merge.
      window.addEventListener(
        "keydown",
        (event) => {
          if (event.defaultPrevented) return;
          const t = event.target as HTMLElement | null;
          if (t && this.element.contains(t)) return;
          const which = this.undoKey(event);
          if (!which) return;
          event.preventDefault();
          this.keyHistory(which === "redo");
        },
        { signal },
      );
    }
  }
}

function pill(role: "yours" | "theirs", name: string, description: string): HTMLElement {
  const p = document.createElement("span");
  p.className = `ms-pill ms-pill-${role}`;
  const r = document.createElement("span");
  r.className = "ms-pill-role";
  r.textContent = role === "yours" ? "YOURS" : "THEIRS";
  const n = document.createElement("span");
  n.className = "ms-pill-name";
  appendName(n, name || roleWord(role));
  p.append(r, n);
  p.title = description || `${roleWord(role)}: ${name}`;
  return p;
}

function notice(kind: "info" | "warn", text: string, cls: string): HTMLElement {
  const n = document.createElement("div");
  n.className = `ms-notice is-${kind} ${cls}`;
  n.append(glyphEl(kind === "warn" ? warningIcon : infoIcon), document.createTextNode(text));
  return n;
}
