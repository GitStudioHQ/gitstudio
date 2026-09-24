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
//   `op` there is no strip and no Continue.
// - Apply with unresolved changes asks once, inline, and says what the
//   unresolved changes will contain (D3). Auto-applying non-conflicting changes
//   is the host's setting, passed to render() — default OFF (D3 override).
// - "Continue <Op>" appears once the host reports no conflicts left and git
//   would accept it; an emptied commit asks before it is dropped.
// - Close ONLY closes the merge editor (the owner, after using it): the
//   operation stays paused and the file keeps its markers — nothing is
//   written. With work in the editor it asks first, inline, because that work
//   is not kept. Escape is Close. Ending the whole operation is not in this
//   bar at all: it lives in the conflicts list, which the strip links to.
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
  type SeedInfo,
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
  arrowRightIcon,
  checkIcon,
  continueIcon,
  errorIcon,
  glyphEl,
  infoIcon,
  warningIcon,
} from "./shellIcons";
import { buildNoTextPanel, type NoTextPanel } from "./noTextPanel";
import {
  appendName,
  continueBlockedText,
  directionParts,
  hasText,
  opNoun,
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

/**
 * What an Apply with unresolved changes saves, said truthfully (D3): an
 * untouched block keeps the original text, but a conflict with one side
 * already taken (or a block edited by hand) is saved as the Result shows it.
 */
export function unresolvedWords(counts: Pick<MergeCountsView, "pending" | "pendingChanged">): string {
  const n = counts.pending;
  const changed = Math.max(0, Math.min(counts.pendingChanged ?? 0, n));
  const kept = n - changed;
  const asShown = (k: number): string => `will be saved as the Result shows ${k === 1 ? "it" : "them"}`;
  if (changed === 0) return `${plural(n, "unresolved change")} will keep the original text.`;
  if (kept === 0) return `${plural(n, "unresolved change")} ${asShown(n)}.`;
  return `${plural(n, "unresolved change")}: ${kept} will keep the original text, ${changed} ${asShown(changed)}.`;
}

/**
 * The file as a sentence names it. The desktop sends a repository-relative
 * path ("rename2/by-x.txt"), which reads fine; the extension sends the
 * document's absolute path, which put three lines of the user's own home
 * folder before the explanation — the file's name says it without them.
 */
export function displayPath(fileName: string): string {
  const absolute = fileName.startsWith("/") || /^[A-Za-z]:[\\/]/.test(fileName) || fileName.startsWith("\\\\");
  if (!absolute) return fileName;
  const parts = fileName.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? fileName;
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

/**
 * The strip for a Result seeded from the file (POLISH A1.2): what it started
 * from, and that every change is still marked for checking.
 */
export function seedText(info: SeedInfo): string {
  const n = plural(info.changes, "change");
  return info.kind === "working"
    ? `This file was already resolved outside the merge editor (by hand, or by git rerere): the Result starts from it. ` +
        `Its ${n} ${info.changes === 1 ? "is" : "are"} still marked so you can check each; Apply saves the Result as shown.`
    : `${n} ${info.changes === 1 ? "was" : "were"} already settled in the file outside its conflict markers (by git's ` +
        `own merge, or by hand): the Result keeps ${info.changes === 1 ? "it" : "them"}, still marked so you can check ` +
        `each; Apply saves the Result as shown.`;
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
  /** Close asked, inline, whether to leave the work in the editor behind. */
  private closeConfirming = false;
  private wsPending?: WhitespaceMode;
  /** What the Result was seeded with from the file (A1.2), for the strip. */
  private seeded?: SeedInfo;
  /**
   * The file changed outside the merge editor (A1.3): "asked" until the user
   * answers, "kept" once they chose to keep that edit.
   */
  private outside?: "asked" | "kept";
  /** The host can undo the last Apply (`applied{undoable}`): Undo shows beside Apply. */
  private undoable = false;
  /** The last Result posted, so a repeat is not sent twice. */
  private lastPosted?: { text: string; unsettled?: string };
  private eolInfo?: EolMismatchInfo;
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
  private readonly closeBtn: HTMLButtonElement;
  private readonly undoApplyBtn: HTMLButtonElement;
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
    // The wand is JetBrains' own icon for this, but on its own it was the one
    // unexplained mark in a toolbar of words: it says what it does, like its
    // neighbours — where there is room (shell.css hides the words, never the
    // name, in a narrow shell).
    this.wandBtn = toolbarButton("");
    this.wandBtn.classList.add("ms-wand");
    this.wandBtn.title = "Resolve simple conflicts (apply both sides where their edits don't overlap)";
    this.wandBtn.setAttribute("aria-label", "Resolve simple conflicts");
    const wandLabel = document.createElement("span");
    wandLabel.className = "ms-wand-label";
    wandLabel.textContent = "Resolve simple";
    this.wandBtn.append(iconElement(magicWand), wandLabel);
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
      toolbarSeparator(),
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

    // Close: ONLY closes the merge editor. Nothing is written, and the
    // operation stays paused; ending it is the conflicts list's to offer.
    this.closeBtn = toolbarButton("Close", "bordered");
    this.closeBtn.classList.add("ms-close");

    // After an Apply the host can take back: the conflict comes back.
    this.undoApplyBtn = toolbarButton("Undo", "bordered");
    this.undoApplyBtn.classList.add("ms-undo-apply");
    this.undoApplyBtn.title = "Undo the Apply: bring the conflict back into the file";
    this.undoApplyBtn.hidden = true;

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
      this.closeBtn,
      this.undoApplyBtn,
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
        this.onApplied(message.staged, message.message, !!message.undoable);
        break;
      case "fileChanged":
        // Asked again for another outside edit, even after a Keep: that
        // answer was about other text.
        this.outside = "asked";
        this.renderNotices();
        this.syncBottom();
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
    this.closeConfirming = false;
    this.undoable = false;
    // A fresh init is the file as it is now: nothing outside left to ask about,
    // and the view says again what (if anything) it seeded the Result with.
    this.outside = undefined;
    this.seeded = undefined;
    this.eolInfo = undefined;
    this.lastPosted = undefined;
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
    this.renderNotices();

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
          path: displayPath(payload.fileName),
          shape: payload.shape ?? "text",
          missingRole: payload.missingRole,
          op: payload.op,
          yoursLabel: payload.oursLabel,
          theirsLabel: payload.theirsLabel,
          commits: payload.commits,
        },
        {
          takeRole: (role) => {
            if (this.busy) return;
            this.lastTake = role;
            // The panel's buttons lock, then go, under the keyboard — as Apply's does.
            this.applyHadFocus = !!this.panel?.element.contains(document.activeElement);
            this.setBusy("take");
            this.clearOutcome();
            this.adapter.post({ type: "takeRole", role });
          },
          deleteFile: () => {
            if (this.busy) return;
            this.lastTake = "delete";
            this.applyHadFocus = !!this.panel?.element.contains(document.activeElement);
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
    view.onCountsChanged = (next) => {
      this.onCounts(next);
      // Which changes are settled can move with no text changing at all (the
      // other side of a conflict ignored): what the file gets moves with it.
      // Not as the merge opens: opening writes nothing.
      if (next.hasProgress || this.lastPosted) this.scheduleResultPost();
    };
    view.onLargeFile = (large) => {
      const words = large ? "Large file: word-level highlights disabled" : "";
      this.largeNote.hidden = !large;
      this.largeNote.textContent = words;
      // The note gives way before the counter does (ellipsis); the whole of
      // it is its tooltip.
      this.largeNote.title = words;
    };
    view.onEolMismatch = (info) => {
      this.eolInfo = info;
      this.renderNotices();
    };
    view.onSeeded = (info) => {
      this.seeded = info;
      this.renderNotices();
    };
    view.onResultChanged = () => this.scheduleResultPost();
    view.onHistoryChanged = () => this.refreshHistory();
    view.attachLegend(this.legendSlot);
  }

  /**
   * Tell the host what the Result is now (debounced): the Result, and — when
   * the view can say it and it differs — the same text with every change the
   * editor has not settled put back to base (POLISH A1.1), which is what the
   * host marks up for the file before Apply. A repeat of the last post is
   * not sent again.
   */
  private scheduleResultPost(): void {
    window.clearTimeout(this.syncTimer);
    this.syncTimer = window.setTimeout(() => {
      this.syncTimer = 0;
      const view = this.viewApi;
      if (!view) return;
      const text = view.getResultText();
      const open = view.getUnsettledText?.();
      const unsettled = open !== undefined && open !== text ? open : undefined;
      const last = this.lastPosted;
      if (last && last.text === text && last.unsettled === unsettled) return;
      this.lastPosted = { text, unsettled };
      this.adapter.post(unsettled === undefined ? { type: "resultChanged", text } : { type: "resultChanged", text, unsettled });
    }, 250);
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
    // Ending the whole operation is not in the merge editor: it lives in the
    // conflicts list, with every other file of it. The strip says where.
    if (this.endable()) {
      const list = document.createElement("button");
      list.type = "button";
      list.className = "ms-op-list";
      list.textContent = "All conflicts";
      const noun = opNoun(op.kind);
      list.title = `The conflicts list: every conflicted file of this ${noun}, and ${op.verbs.continue ? `${op.verbs.continue} or ` : ""}${op.verbs.abort}`;
      list.addEventListener("click", () => this.adapter.post({ type: "showConflicts" }));
      this.strip.appendChild(list);
    }
  }

  private renderNotices(): void {
    this.notices.replaceChildren();
    const text = hasText(this.payload.shape);
    // Without an operation strip the conflict-type note has nowhere else to go.
    const note = !this.op ? conflictTypeNote(this.payload) : "";
    if (note && text) this.notices.appendChild(notice("info", note, "ms-note-type"));
    if (this.outside && text) this.notices.appendChild(this.outsideNotice(this.outside));
    if (this.seeded && text) this.notices.appendChild(notice("info", seedText(this.seeded), "ms-note-seed"));
    if (this.eolInfo && text) this.notices.appendChild(notice("warn", eolText(this.eolInfo), "ms-note-eol"));
    this.notices.hidden = this.notices.childElementCount === 0;
  }

  /**
   * The file changed outside the merge editor (POLISH A1.3): asked here,
   * inline, rather than in a dialog over the editor — the host writes nothing
   * to the file until it is answered. Reload the merge starts over from the
   * file as it is now; Keep what's here leaves that edit alone until Apply.
   */
  private outsideNotice(state: "asked" | "kept"): HTMLElement {
    const name = displayPath(this.payload.fileName);
    if (state === "kept") {
      return notice(
        "info",
        `${name} keeps the edit made outside the merge editor until you Apply. Apply replaces it with the Result.`,
        "ms-note-outside",
      );
    }
    const box = document.createElement("div");
    box.className = "ms-notice is-warn ms-note-outside";
    box.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.className = "ms-confirm-text";
    text.append(
      glyphEl(warningIcon),
      document.createTextNode(
        `${name} changed outside the merge editor (in another editor, by a formatter, or on disk). ` +
          `Nothing is written to it until you choose.`,
      ),
    );
    const reload = toolbarButton("Reload the merge", "bordered");
    reload.classList.add("ms-outside-reload");
    reload.title = `Start the merge over from ${name} as it is now. The work in this editor is not kept.`;
    reload.addEventListener("click", () => this.answerOutside("reload"));
    const keep = toolbarButton("Keep what's here", "bordered");
    keep.classList.add("ms-outside-keep");
    keep.title = `Leave that edit in ${name}, and keep working here. Apply replaces it with the Result.`;
    keep.addEventListener("click", () => this.answerOutside("keep"));
    box.append(text, reload, keep);
    return box;
  }

  private answerOutside(answer: "reload" | "keep"): void {
    if (this.outside !== "asked") return;
    const hadKeyboard = this.notices.contains(document.activeElement);
    this.outside = answer === "keep" ? "kept" : undefined;
    this.adapter.post({ type: "outsideEdit", answer });
    this.renderNotices();
    this.syncBottom();
    // The button that had the keyboard is gone: back to the editor's controls.
    if (hadKeyboard) this.focus();
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
    // merge and clears a pending two-step confirmation — and takes away the
    // Undo of that Apply: it would bring back a conflict over the new work.
    if (this.applied && !this.busy) {
      this.applied = false;
      this.appliedWarn = "";
    }
    this.undoable = false;
    // Work done since Close asked: ask again, about that work.
    this.closeConfirming = false;
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
      // they are saving: an untouched block keeps the ORIGINAL text, one with
      // a side already taken is saved as shown (unresolvedWords).
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
   * again if it is live, else Close — instead of leaving it on <body>. Only
   * when the keyboard is still nowhere (or on the spent button): a user who
   * has moved on keeps their place.
   */
  private passFocusOnFromApply(): void {
    if (!this.applyHadFocus) return;
    const active = document.activeElement;
    // Still nowhere, or still on the spent control (Apply, or the no-text
    // panel's answer): anything else means the user has moved on.
    const stale = active === this.applyBtn || (!!this.panel && !!active && this.panel.element.contains(active));
    if (active && active !== document.body && !stale) {
      this.applyHadFocus = false;
      return;
    }
    const next = [this.continueBtn, this.applyBtn, this.closeBtn].find(
      (b) => b.isConnected && !b.hidden && !b.disabled && !b.closest("[hidden]"),
    );
    if (!next || next === active) return;
    this.applyHadFocus = false;
    next.focus();
  }

  private onApplied(staged: boolean, message?: string, undoable = false): void {
    this.setBusy("");
    this.applied = true;
    this.appliedWarn = staged ? "" : message || "The file was saved but could not be staged.";
    // The host can take this Apply back: Undo waits beside Apply, in place,
    // until the next change in the editor.
    this.undoable = staged && undoable && !this.panel;
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
   * Is there still an operation in progress that the conflicts list could
   * continue or end? Not once it has finished here (an outcome "done"), and
   * not when the host reports no operation and no unmerged file left (the
   * walkthrough's sample among them). Unmerged files with no operation around
   * them (kind "none" while any remain) are still something to settle there.
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

  // ── Close ──

  /**
   * Close: leave the merge editor, and nothing else. The operation stays
   * paused and the file keeps its conflict markers — the host closes the
   * editor without writing (and without a save prompt that could write half a
   * merge). The work in the editor is not kept, so with any it asks first,
   * inline; with none, or once Apply has saved it, it just closes.
   */
  private clickClose(): void {
    if (this.busy) return;
    const unsaved = !this.panel && this.counts.hasProgress && !this.applied;
    if (unsaved && !this.closeConfirming) {
      this.closeConfirming = true;
      this.syncBottom();
      // A question that throws work away starts on the safe answer.
      this.element.querySelector<HTMLButtonElement>(".ms-close-keep")?.focus();
      return;
    }
    this.closeConfirming = false;
    this.syncBottom();
    this.adapter.post({ type: "cancel", mode: "exit" });
  }

  /** Keep editing (or Escape): the question goes, the keyboard goes back to Close. */
  private closeCloseConfirm(): void {
    this.closeConfirming = false;
    this.syncBottom();
    if (!this.closeBtn.hidden && !this.closeBtn.disabled) this.closeBtn.focus();
  }

  private renderCloseConfirm(): void {
    const note = this.bottomNote;
    note.classList.add("is-warn", "ms-close-confirm");
    note.setAttribute("role", "alert");
    const text = document.createElement("span");
    text.className = "ms-confirm-text";
    const where = this.op && this.endable() ? ` The ${opNoun(this.op.kind)} stays paused` : "";
    text.append(
      glyphEl(warningIcon),
      document.createTextNode(
        `Close without applying? What you resolved here is not kept.${where}${where ? " and" : ""} ` +
          `${displayPath(this.payload.fileName)} keeps its conflict markers.`,
      ),
    );
    const keep = toolbarButton("Keep editing", "bordered");
    keep.classList.add("ms-close-keep");
    keep.addEventListener("click", () => this.closeCloseConfirm());
    const go = toolbarButton("Close without applying", "bordered");
    go.classList.add("ms-close-go", "ms-danger");
    go.addEventListener("click", () => this.clickClose());
    note.append(text, keep, go);
  }

  /** The Close button's words: "Close", or what the host calls closing (the sample's "Close sample"). */
  private closeLabel(): string {
    const op = this.op;
    // The walkthrough's sample has no operation behind it (kind "none",
    // nothing unmerged); its one verb is how it closes.
    if (op && op.episode === "sample" && op.verbs.abort) return op.verbs.abort;
    return "Close";
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
    // The file changed outside the editor and nobody has said what to do about
    // it yet: Apply would write over that edit, so it waits for the answer.
    const outsideOpen = this.outside === "asked" && !noText;
    if (!noText) {
      const nothingPending = this.counts.pending === 0;
      this.acceptYoursBtn.disabled = nothingPending || busy;
      this.acceptTheirsBtn.disabled = nothingPending || busy;
      this.applyBtn.disabled = busy || this.applied || outsideOpen;
      this.applyBtn.title = outsideOpen
        ? "Answer the question above first: the file changed outside the merge editor"
        : "Save the result and mark the conflict resolved";
    }
    // The IDE merges lines: never offered over a panel with no text, nor once
    // the operation is over and there is no conflict left to hand it.
    this.jetbrainsBtn.hidden = !this.payload.jetbrainsName || noText || (!!this.op && !this.endable());
    this.closeBtn.disabled = busy;
    this.closeBtn.textContent = this.closeLabel();
    const name = displayPath(this.payload.fileName);
    this.closeBtn.title =
      this.op && this.endable()
        ? `Close the merge editor (Escape). Nothing is written: the ${opNoun(this.op.kind)} stays paused and ${name} keeps its conflict markers.`
        : `Close the merge editor (Escape). Nothing is written.`;
    this.undoApplyBtn.hidden = !this.undoable || noText;
    this.undoApplyBtn.disabled = busy;

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
    note.removeAttribute("role");
    note.setAttribute("role", "status");
    if (this.dropConfirming && this.op?.willDrop) {
      this.renderDropConfirm(this.op);
      note.hidden = false;
      return;
    }
    if (this.closeConfirming) {
      this.renderCloseConfirm();
      note.hidden = false;
      return;
    }
    if (this.armTimer) {
      text = `${unresolvedWords(this.counts)} Click Apply again to save anyway.`;
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
    on(this.closeBtn, "click", () => this.clickClose());
    on(this.undoApplyBtn, "click", () => {
      if (this.busy || !this.undoable) return;
      // Locked while the host brings the conflict back (it answers with a
      // fresh init, or says why it could not).
      this.setBusy("take");
      this.clearOutcome();
      this.syncBottom();
      this.adapter.post({ type: "undoApply" });
    });
    on(this.applyBtn, "click", () => this.clickApply());
    on(this.continueBtn, "click", () => this.clickContinue());

    // The history popover closes on an outside click and on Escape. "Outside"
    // is decided from the event's PATH, fixed when it was dispatched: a click
    // that rebuilds the popover's own content has a detached target by the
    // time it bubbles here, and `contains()` would call it outside.
    document.addEventListener(
      "click",
      (event) => {
        const path = event.composedPath();
        if (!this.historyPop.hidden && !path.includes(this.historyWrap)) this.historyPop.hidden = true;
      },
      { signal },
    );
    // Escape answers the question on screen the safe way; with none, it is
    // Close. Not when something inside claimed the key first (Monaco's find
    // widget, a suggestion list, a selection being cancelled).
    on(this.element, "keydown", (event) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (!this.historyPop.hidden) {
        event.stopPropagation();
        this.historyPop.hidden = true;
        this.historyBtn.focus();
      } else if (!this.wsConfirm.hidden) {
        event.stopPropagation();
        this.hideWsConfirm(true);
      } else if (this.dropConfirming) {
        event.stopPropagation();
        this.closeDropConfirm();
      } else if (this.closeConfirming) {
        event.stopPropagation();
        this.closeCloseConfirm();
      } else if (!this.busy && !event.repeat) {
        event.stopPropagation();
        event.preventDefault();
        this.clickClose();
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
