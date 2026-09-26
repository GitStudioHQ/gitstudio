import * as vscode from "vscode";
import type { StashEntry } from "@gitstudio/git-service/index";
import { isStashSha } from "@gitstudio/git-service/StashProvider";
import type { RepoManager } from "../git/repoManager";
import { getNonce } from "../webview/html";
import { relativeTime } from "../util/relativeTime";
// Shared design tokens, inlined as text by esbuild (see esbuild.js .css loader),
// so the Stashes view matches every other GitStudio surface — its buttons are
// real GitStudio-violet controls, not the native tree's theme-grey icons.
import tokensCss from "../../../../packages/webview-ui/src/styles/tokens.css";
import {
  saveStash,
  applyStash,
  popStash,
  dropStash,
  branchFromStash,
  showStash,
} from "./stashesView";

/** One stash row, as sent to the webview (host formats the display strings). */
interface StashDto {
  /** The stash's FULL sha — what every action names it by. */
  sha: string;
  /** Its short sha, for display. */
  short: string;
  /** Its `stash@{n}` as the list stands now, for display only. */
  ref: string;
  message: string;
  timeRel: string;
  timeAbs: string;
}

/**
 * Messages the stashes webview posts back to the host. Every action names the
 * stash by its full sha, never by `stash@{n}`: that is a position, and a list
 * renumbered while a question was up made Drop and Pop act on another stash.
 */
type StashMessage =
  | { type: "ready" }
  | { type: "save" }
  | { type: "refresh" }
  | { type: "show"; sha: string; focus?: boolean }
  | { type: "apply"; sha: string }
  | { type: "pop"; sha: string }
  | { type: "drop"; sha: string }
  | { type: "branch"; sha: string };

/** The row actions, by the message that asks for them. */
const ACTIONS = {
  apply: applyStash,
  pop: popStash,
  drop: dropStash,
  branch: branchFromStash,
} as const;

/**
 * The Stashes pillar as a branded webview view (replacing the native tree). Each
 * row is one `git stash` entry; a violet "Stash Changes" button sits at the top,
 * and every row carries Apply / Pop / Drop / Branch actions styled on-brand.
 * Clicking a row opens its diff. Pop/Drop route through the universal Undo.
 */
export class StashesWebviewViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewId = "gitstudio.stashes";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Last successfully-read list, so a transient read failure keeps showing the
   * real stashes instead of blanking them into a false "No stashes". */
  private lastItems: StashDto[] = [];

  constructor(
    private readonly repos: RepoManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    // The repo firehose fires on every ref write; stashes change rarely, so a
    // passive change just re-posts the (cheap) list to a live view.
    this.disposables.push(
      this.repos.onDidChange(() => void this.postList()),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage(
      (msg: StashMessage) => void this.onMessage(msg),
      undefined,
      this.disposables,
    );
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
      }
    });
    // Re-post whenever the view becomes visible again (it may have been hidden).
    view.onDidChangeVisibility(
      () => {
        if (view.visible) {
          void this.postList();
        }
      },
      undefined,
      this.disposables,
    );
  }

  /** Re-pull the stash list and repaint (called by stash ops + the firehose). */
  refresh(): void {
    void this.postList();
  }

  private async onMessage(msg: StashMessage): Promise<void> {
    const refresh = (): void => this.refresh();
    switch (msg.type) {
      case "ready":
      case "refresh":
        await this.postList();
        return;
      case "save":
        await saveStash(this.repos, refresh);
        return;
      case "show":
        // A row for a stash that has since left the list goes with it.
        if (!(await showStash(this.repos, msg.sha, msg.focus === true))) {
          await this.postList();
        }
        return;
      case "apply":
      case "pop":
      case "drop":
      case "branch": {
        if (typeof msg.sha !== "string" || !isStashSha(msg.sha)) {
          return;
        }
        try {
          // The list is re-posted once the action is over, whatever its
          // outcome; the page patches only the rows that changed.
          await ACTIONS[msg.type](this.repos, msg.sha, () => {});
          await this.postList();
        } finally {
          // The row went busy when it was clicked; this releases it — at
          // once on a Cancel, rather than after a timer.
          void this.view?.webview.postMessage({ type: "done", sha: msg.sha });
        }
        return;
      }
    }
  }

  private async postList(): Promise<void> {
    const view = this.view;
    if (!view) {
      return;
    }
    const active = this.repos.getActive();
    if (!active) {
      this.lastItems = [];
      void view.webview.postMessage({
        type: "stashes",
        items: [],
        hasRepo: false,
        ok: true,
      });
      return;
    }
    try {
      const entries: StashEntry[] = await active.ctx.stashes.list();
      const items: StashDto[] = entries.map((e) => ({
        sha: e.sha,
        short: e.sha.slice(0, 7),
        ref: e.ref,
        message: e.message || e.ref,
        timeRel: relativeTime(e.time),
        timeAbs: new Date(e.time * 1000).toLocaleString(),
      }));
      this.lastItems = items;
      void view.webview.postMessage({
        type: "stashes",
        items,
        hasRepo: true,
        ok: true,
      });
    } catch {
      // Transient read failure — keep showing the last good list rather than
      // blanking it into a false "No stashes". ok:false lets a first-load
      // failure read as "couldn't load" instead of "empty".
      void view.webview.postMessage({
        type: "stashes",
        items: this.lastItems,
        hasRepo: true,
        ok: false,
      });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${codiconUri}" rel="stylesheet" />
<style nonce="${nonce}">${tokensCss}</style>
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 0;
    color: var(--gs-fg); font-family: var(--gs-font-ui);
    font-size: 13px; background: var(--gs-bg);
    /* Opaque row-hover so the on-hover action strip can cleanly occlude the
       message tail (a semi-transparent hover would let text bleed through). */
    --row-hover: color-mix(in srgb, var(--gs-fg) 7%, var(--gs-bg));
  }
  .codicon { line-height: 1; color: inherit; display: inline-block; }
  /* Compact action bar: one slim, full-width branded button — no splash. */
  .head { padding: 6px 8px 4px; position: sticky; top: 0; z-index: 2; background: var(--gs-bg); }
  .head .gs-btn--primary { width: 100%; height: 26px; font-size: 12px; letter-spacing: 0; }
  .head .gs-btn--primary .codicon { font-size: 14px; }

  .list { padding: 2px 4px 10px; }
  .row {
    position: relative; display: flex; align-items: center; gap: 8px;
    min-height: 34px; padding: 3px 8px; border-radius: var(--gs-radius-sm);
    cursor: pointer; user-select: none;
  }
  .row:hover, .row:focus-within { background: var(--row-hover); }
  .row:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  /* A row whose action is running: dimmed, its buttons off, until the host
     says it is over. Only that row; the rest of the list stays usable. */
  .row.busy { opacity: 0.55; cursor: progress; }
  .row.busy .icon-btn { cursor: progress; }
  .row .sicon {
    flex: 0 0 auto; width: 16px; height: 16px;
    display: inline-flex; align-items: center; justify-content: center;
    color: var(--gs-brand);
  }
  .row .sicon .codicon { font-size: 14px; }
  .row .body { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
  .row .msg {
    font-size: 12.5px; font-weight: 600; line-height: 1.25;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .row .meta {
    font-size: 11px; color: var(--gs-fg-muted); line-height: 1.2;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    font-variant-numeric: tabular-nums;
  }
  /* Actions sit inline at the row's right, ALWAYS visible (discoverable — the
     old hover-only strip hid what you could do); the message + meta truncate
     before them. A touch bolder on hover/focus. */
  .row-actions {
    flex: 0 0 auto; display: flex; align-items: center; gap: 1px;
    opacity: 0.72; transition: opacity var(--gs-motion-fast) var(--gs-ease);
  }
  .row:hover .row-actions,
  .row:focus-within .row-actions { opacity: 1; }
  .icon-btn {
    display: inline-flex; align-items: center; justify-content: center;
    width: 22px; height: 22px; padding: 0; border: none;
    border-radius: var(--gs-radius-sm); background: transparent;
    color: var(--gs-fg-muted); cursor: pointer;
    transition: color var(--gs-motion-fast) var(--gs-ease),
                background var(--gs-motion-fast) var(--gs-ease);
  }
  .icon-btn .codicon { font-size: 14px; }
  .icon-btn:hover { color: var(--gs-brand); background: var(--vscode-toolbar-hoverBackground, var(--gs-hover)); }
  .icon-btn.danger:hover { color: var(--gs-status-deleted, var(--vscode-errorForeground)); }
  .icon-btn:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  /* Minimal empty state — a quiet line near the top, not a splash screen. */
  .empty {
    display: flex; flex-direction: column; align-items: center; gap: 3px;
    padding: 16px 14px 8px; text-align: center; color: var(--gs-fg-muted);
  }
  .empty .title { font-size: 12.5px; font-weight: 600; color: var(--gs-fg); }
  .empty .hint { font-size: 11.5px; line-height: 1.45; max-width: 218px; }
  [hidden] { display: none !important; }
  /* Shared custom tooltip (native title is unreliable/clipped in webviews). */
  .gs-tip {
    position: fixed; z-index: 99999; pointer-events: none;
    transform: translate(-50%, -100%);
    max-width: 280px; padding: 3px 7px; border-radius: var(--gs-radius-sm);
    border: 1px solid var(--gs-border);
    background: var(--gs-surface-2, var(--vscode-editorHoverWidget-background, #2b2b2b));
    color: var(--gs-fg); font-family: var(--gs-font-ui);
    font-size: 11.5px; line-height: 1.35;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: var(--gs-shadow-2);
    opacity: 0; transition: opacity var(--gs-motion-fast) var(--gs-ease);
  }
  .gs-tip.below { transform: translate(-50%, 0); }
  .gs-tip.show { opacity: 1; }
  /* In-sidebar action popover (double/right-click a stash) — NOT a quick-pick. */
  .gs-menu {
    position: fixed; z-index: 60; min-width: 190px; max-width: 300px;
    display: flex; flex-direction: column; padding: 4px;
    background: var(--vscode-menu-background, var(--gs-surface));
    border: 1px solid var(--vscode-menu-border, var(--gs-border));
    border-radius: var(--gs-radius); box-shadow: var(--gs-shadow-2);
  }
  .gs-menu-head {
    display: flex; align-items: center; gap: 6px; padding: 3px 8px 6px;
    font-size: 11px; color: var(--gs-fg-muted); font-weight: 600;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    border-bottom: 1px solid var(--gs-border); margin-bottom: 4px;
  }
  .gs-menu-item {
    display: flex; align-items: center; gap: 8px; width: 100%;
    padding: 5px 8px; border: none; background: transparent;
    color: var(--gs-fg); font-family: var(--gs-font-ui); font-size: 12.5px;
    text-align: left; border-radius: var(--gs-radius-sm); cursor: pointer;
  }
  .gs-menu-item .codicon { font-size: 14px; color: var(--gs-fg-muted); flex: 0 0 auto; }
  .gs-menu-item span { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .gs-menu-item:hover, .gs-menu-item:focus-visible { background: var(--gs-hover); outline: none; }
  .gs-menu-item.danger { color: var(--gs-status-deleted, var(--vscode-errorForeground, #e15a5a)); }
  .gs-menu-item.danger .codicon { color: inherit; }
  .gs-menu-item.danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 14%, transparent); }
  .gs-menu-sep { height: 1px; margin: 4px 6px; background: var(--gs-border); }
</style>
</head>
<body>
  <div class="head">
    <button class="gs-btn gs-btn--primary" id="stash-btn" type="button" data-tip="Stash your working changes">
      <i class="codicon codicon-archive" aria-hidden="true"></i>
      <span>Stash Changes</span>
    </button>
  </div>
  <div class="list" id="list" role="list"></div>
  <div class="empty" id="empty" hidden>
    <span class="title" id="empty-title">No stashes</span>
    <span class="hint" id="empty-hint">Stash your working changes with the button above — they'll show up here to apply, pop, or branch.</span>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const listEl = document.getElementById("list");
    const emptyEl = document.getElementById("empty");
    const emptyTitle = document.getElementById("empty-title");
    const emptyHint = document.getElementById("empty-hint");
    const stashBtn = document.getElementById("stash-btn");
    const EMPTY_HINT = emptyHint.innerHTML;

    stashBtn.addEventListener("click", () => vscode.postMessage({ type: "save" }));

    function el(tag, cls, html) {
      const n = document.createElement(tag);
      if (cls) n.className = cls;
      if (html != null) n.innerHTML = html;
      return n;
    }

    // One row per stash, keyed by its full sha. A stash never changes, so a
    // row belongs to its sha for life: the host re-posts the list on every
    // repository change (every save), and an identical list touches nothing,
    // while a pop or a drop removes one row and leaves the others, and the
    // keyboard focus, where they were. Every action names the stash by that
    // sha; the host finds it in the list just before git runs.
    const rows = new Map();
    let lastSig = "";

    /**
     * Ask the host to act on a stash. Only THAT row goes busy, until the host
     * says the action is over (a "done" message, which a Cancel sends at
     * once): a second press on it, from its buttons, its menu or a key, is
     * ignored meanwhile, and every other row stays usable.
     */
    function act(type, sha) {
      const row = rows.get(sha);
      if (!row || row.classList.contains("busy")) return;
      // The keyboard waits on the row while it is busy. Going busy disables
      // the button that had it (a mouse press focuses it, as Tab does), and
      // it fell to the page: a Pop that then removed the row had no row to
      // hand it on from.
      const at = document.activeElement;
      if (at && at !== row && row.contains(at)) row.focus();
      setBusy(row, true);
      vscode.postMessage({ type: type, sha: sha });
    }
    function setBusy(row, on) {
      row.classList.toggle("busy", on);
      row.setAttribute("aria-busy", on ? "true" : "false");
      row.querySelectorAll(".row-actions button").forEach((b) => { b.disabled = on; });
    }
    function iconBtn(icon, title, cls, type, row) {
      const b = el("button", "icon-btn" + (cls ? " " + cls : ""),
        '<i class="codicon codicon-' + icon + '" aria-hidden="true"></i>');
      b.type = "button";
      b.dataset.tip = title; // snappy custom tooltip; native title is flaky in webviews
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        act(type, row.dataset.sha);
      });
      return b;
    }

    /** Arrow keys move the keyboard to the next or previous row; Home and End to the first or last. */
    function focusRow(from, key) {
      const all = Array.from(listEl.children);
      const i = all.indexOf(from);
      const j = key === "Home" ? 0
        : key === "End" ? all.length - 1
        : key === "ArrowDown" ? Math.min(all.length - 1, i + 1)
        : Math.max(0, i - 1);
      if (all[j]) all[j].focus();
    }

    function makeRow(sha) {
      const row = el("div", "row");
      row.tabIndex = 0;
      row.setAttribute("role", "listitem");
      row.dataset.sha = sha;

      const sicon = el("span", "sicon", '<i class="codicon codicon-git-stash" aria-hidden="true"></i>');
      const body = el("div", "body");
      body.append(el("div", "msg"), el("div", "meta"));

      const actions = el("span", "row-actions");
      actions.appendChild(iconBtn("git-stash-apply", "Apply", "", "apply", row));
      actions.appendChild(iconBtn("git-stash-pop", "Pop (apply & drop)", "", "pop", row));
      actions.appendChild(iconBtn("git-branch", "Create branch from stash", "", "branch", row));
      actions.appendChild(iconBtn("trash", "Drop", "danger", "drop", row));

      // A click previews the stash and leaves the keyboard here; Enter opens
      // it and moves the keyboard to it.
      const open = (focus) => vscode.postMessage({ type: "show", sha: sha, focus: focus });
      const menu = (ev) => {
        ev.preventDefault();
        openStashMenu(row);
      };
      row.addEventListener("click", (ev) => {
        // The second click of a double-click belongs to the menu it opens,
        // not to a second preview of the same stash.
        if (ev.detail > 1) return;
        open(false);
      });
      // Double-click OR right-click a stash: an actions menu (Apply/Pop/Branch/Drop).
      row.addEventListener("dblclick", menu);
      row.addEventListener("contextmenu", menu);
      row.addEventListener("keydown", (ev) => {
        if (ev.target !== row) return;
        if (ev.key === "Enter") { ev.preventDefault(); open(true); }
        else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) menu(ev);
        // Delete; and on macOS the delete key, Backspace, and VS Code's
        // list delete, Cmd+Backspace. The Drop question still comes first.
        else if (ev.key === "Delete" || (ev.key === "Backspace" && !ev.altKey && !ev.ctrlKey && !ev.shiftKey)) {
          ev.preventDefault();
          act("drop", sha);
        }
        else if (ev.key === "ArrowDown" || ev.key === "ArrowUp" || ev.key === "Home" || ev.key === "End") {
          ev.preventDefault();
          focusRow(row, ev.key);
        }
      });

      row.append(sicon, body, actions);
      return row;
    }

    function fillRow(row, s) {
      row.stash = s;
      row.title = s.message + " — " + s.timeAbs;
      row.querySelector(".msg").textContent = s.message;
      row.querySelector(".meta").textContent = s.ref + " · " + s.timeRel + " · " + s.short;
    }

    function render(items, hasRepo, ok) {
      const list = items || [];
      // The same list again (what every save posts) changes nothing on screen,
      // so nothing is rebuilt: the row with the keyboard keeps it.
      const sig = JSON.stringify([list, hasRepo, ok]);
      if (sig === lastSig) return;
      lastSig = sig;

      const n = list.length;
      if (ok === false && n === 0) {
        // A read failed and we have nothing cached — say so, don't imply "empty".
        emptyEl.hidden = false;
        emptyTitle.textContent = "Couldn't load stashes";
        emptyHint.textContent = "Something interrupted reading your stashes — it'll refresh automatically.";
      } else {
        emptyEl.hidden = n !== 0 || !hasRepo;
        emptyTitle.textContent = "No stashes";
        emptyHint.innerHTML = EMPTY_HINT;
      }

      // Rows whose stash has left the list go; when one of them had the
      // keyboard, the row that takes its place gets it.
      const keep = new Set(list.map((s) => s.sha));
      const active = document.activeElement;
      const focused = active && active.closest ? active.closest(".row") : null;
      let focusAt = -1;
      Array.from(listEl.children).forEach((row, i) => {
        if (keep.has(row.dataset.sha)) return;
        if (row === focused) focusAt = i;
        if (menuEl && menuRow === row) closeMenu();
        rows.delete(row.dataset.sha);
        row.remove();
      });
      // The rest are patched in place, and a new stash is inserted where it
      // belongs; a row already in its place is never moved (moving the row
      // with the keyboard would drop it).
      let prev = null;
      for (const s of list) {
        let row = rows.get(s.sha);
        if (!row) {
          row = makeRow(s.sha);
          rows.set(s.sha, row);
        }
        fillRow(row, s);
        const want = prev ? prev.nextSibling : listEl.firstChild;
        if (row !== want) listEl.insertBefore(row, want);
        prev = row;
      }
      if (focusAt >= 0 && listEl.children.length > 0) {
        listEl.children[Math.min(focusAt, listEl.children.length - 1)].focus();
      }
    }

    // Snappy, never-clipped tooltips (native title is unreliable in webviews).
    const tipEl = el("div", "gs-tip");
    tipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipEl);
    let tipTarget = null, tipTimer = 0;
    function hideTip() { clearTimeout(tipTimer); tipTarget = null; tipEl.classList.remove("show"); }
    function showTip() {
      if (!tipTarget) return;
      const text = tipTarget.getAttribute("data-tip");
      if (!text) return;
      tipEl.textContent = text;
      tipEl.classList.add("show");
      const r = tipTarget.getBoundingClientRect(), tw = tipEl.offsetWidth;
      const left = Math.max(tw / 2 + 5, Math.min(window.innerWidth - tw / 2 - 5, r.left + r.width / 2));
      let top = r.top - 6;
      const below = top - tipEl.offsetHeight < 2;
      tipEl.classList.toggle("below", below);
      if (below) top = r.bottom + 6;
      tipEl.style.left = Math.round(left) + "px";
      tipEl.style.top = Math.round(top) + "px";
    }
    document.addEventListener("pointerover", (e) => {
      const t = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (t === tipTarget) return;
      hideTip();
      if (t) { tipTarget = t; tipTimer = setTimeout(showTip, 300); }
    });
    document.addEventListener("pointerout", (e) => {
      const t = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (t && t === tipTarget) hideTip();
    });
    document.addEventListener("pointerdown", hideTip);

    // ---- In-sidebar action popover (double/right-click a stash) --------------
    let menuEl = null;
    let menuRow = null;
    function closeMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; }
      menuRow = null;
      document.removeEventListener("mousedown", onMenuDown, true);
      document.removeEventListener("keydown", onMenuKey, true);
    }
    function onMenuDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
    function onMenuKey(e) {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        const back = menuRow;
        closeMenu();
        if (back && back.isConnected) back.focus();
      }
    }
    function openStashMenu(anchor) {
      closeMenu();
      hideTip();
      const s = anchor.stash;
      const menu = el("div", "gs-menu");
      const head = el("div", "gs-menu-head");
      head.appendChild(el("i", "codicon codicon-git-stash"));
      const nm = el("span"); nm.textContent = s ? s.message : ""; head.appendChild(nm);
      menu.appendChild(head);
      const item = (icon, label, danger, type) => {
        const b = el("button", "gs-menu-item" + (danger ? " danger" : ""),
          '<i class="codicon codicon-' + icon + '" aria-hidden="true"></i><span></span>');
        b.type = "button";
        b.querySelector("span").textContent = label;
        // Through act(), like the row's buttons: a busy row takes no second
        // action from its menu either. The item that had the keyboard goes
        // with the menu, so the keyboard goes back to the row, as on Escape.
        b.addEventListener("click", () => {
          closeMenu();
          if (anchor.isConnected) anchor.focus();
          act(type, anchor.dataset.sha);
        });
        menu.appendChild(b);
      };
      item("git-stash-apply", "Apply", false, "apply");
      item("git-stash-pop", "Pop (apply & drop)", false, "pop");
      item("git-branch", "Create branch from stash", false, "branch");
      menu.appendChild(el("div", "gs-menu-sep"));
      item("trash", "Drop", true, "drop");
      document.body.appendChild(menu);
      menuEl = menu;
      menuRow = anchor;
      const PAD = 6, r = menu.getBoundingClientRect(), a = anchor.getBoundingClientRect();
      const left = Math.max(PAD, Math.min(a.left, window.innerWidth - r.width - PAD));
      let top = a.bottom + 2;
      if (top + r.height > window.innerHeight - PAD) top = Math.max(PAD, a.top - r.height - 2);
      menu.style.left = Math.round(left) + "px";
      menu.style.top = Math.round(top) + "px";
      document.addEventListener("mousedown", onMenuDown, true);
      document.addEventListener("keydown", onMenuKey, true);
      const first = menu.querySelector(".gs-menu-item");
      if (first) first.focus();
    }

    window.addEventListener("message", (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === "stashes") render(m.items, m.hasRepo, m.ok);
      else if (m.type === "done") {
        const row = rows.get(m.sha);
        if (row) setBusy(row, false);
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body></html>`;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
