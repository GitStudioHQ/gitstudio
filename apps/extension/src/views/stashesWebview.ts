import * as vscode from "vscode";
import type { StashEntry } from "@gitstudio/git-service/index";
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
  ref: string;
  message: string;
  sha: string;
  timeRel: string;
  timeAbs: string;
}

/** Messages the stashes webview posts back to the host. */
type StashMessage =
  | { type: "ready" }
  | { type: "save" }
  | { type: "refresh" }
  | { type: "show"; ref: string; sha?: string }
  | { type: "apply"; ref: string }
  | { type: "pop"; ref: string }
  | { type: "drop"; ref: string }
  | { type: "branch"; ref: string };

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
        await showStash(this.repos, msg.ref, msg.sha);
        return;
      case "apply":
        await applyStash(this.repos, msg.ref, refresh);
        return;
      case "pop":
        await popStash(this.repos, msg.ref, refresh);
        return;
      case "drop":
        await dropStash(this.repos, msg.ref, refresh);
        return;
      case "branch":
        await branchFromStash(this.repos, msg.ref, refresh);
        return;
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
        ref: e.ref,
        message: e.message || e.ref,
        sha: e.sha.slice(0, 7),
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
  <div class="list" id="list"></div>
  <div class="empty" id="empty" hidden>
    <span class="title" id="empty-title">No stashes</span>
    <span class="hint" id="empty-hint">Shelve your working changes with the button above — they'll show up here to apply, pop, or branch.</span>
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
    function iconBtn(icon, title, cls, onClick) {
      const b = el("button", "icon-btn" + (cls ? " " + cls : ""),
        '<i class="codicon codicon-' + icon + '" aria-hidden="true"></i>');
      b.type = "button";
      b.dataset.tip = title; // snappy custom tooltip; native title is flaky in webviews
      b.setAttribute("aria-label", title);
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        // Stash actions key on the volatile stash@{n} index. A drop/pop reindexes
        // the remaining stashes, so a second click before the list refreshes would
        // hit a DIFFERENT stash than the user sees. Latch the whole list busy on
        // the first action and ignore further clicks until render() rebuilds it
        // with fresh refs. (A 6s safety timer re-enables if no refresh arrives.)
        if (listEl.dataset.busy === "1") return;
        listEl.dataset.busy = "1";
        listEl.querySelectorAll(".row-actions button").forEach((x) => { x.disabled = true; });
        setTimeout(() => { if (listEl.dataset.busy === "1") { listEl.dataset.busy = ""; listEl.querySelectorAll(".row-actions button").forEach((x) => { x.disabled = false; }); } }, 6000);
        onClick();
      });
      return b;
    }

    function render(items, hasRepo, ok) {
      // A fresh list means any in-flight stash op finished; clear the busy latch
      // so the rebuilt rows (with up-to-date refs) are actionable again.
      listEl.dataset.busy = "";
      listEl.textContent = "";
      const n = items ? items.length : 0;
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
      if (!items) return;
      for (const s of items) {
        const row = el("div", "row");
        row.tabIndex = 0;
        row.title = s.message + " — " + s.timeAbs;

        const sicon = el("span", "sicon", '<i class="codicon codicon-git-stash" aria-hidden="true"></i>');
        const body = el("div", "body");
        const msg = el("div", "msg");
        msg.textContent = s.message;
        const meta = el("div", "meta");
        meta.textContent = s.ref + " · " + s.timeRel + " · " + s.sha;
        body.append(msg, meta);

        const actions = el("span", "row-actions");
        actions.appendChild(iconBtn("arrow-down", "Apply", "", () => vscode.postMessage({ type: "apply", ref: s.ref })));
        actions.appendChild(iconBtn("inbox", "Pop (apply & drop)", "", () => vscode.postMessage({ type: "pop", ref: s.ref })));
        actions.appendChild(iconBtn("git-branch", "Create branch from stash", "", () => vscode.postMessage({ type: "branch", ref: s.ref })));
        actions.appendChild(iconBtn("trash", "Drop", "danger", () => vscode.postMessage({ type: "drop", ref: s.ref })));

        const open = () => vscode.postMessage({ type: "show", ref: s.ref, sha: s.sha });
        const menu = (ev) => {
          ev.preventDefault();
          openStashMenu(s, row);
        };
        row.addEventListener("click", open);
        // Double-click OR right-click a stash → an actions menu (Apply/Pop/Branch/Drop).
        row.addEventListener("dblclick", menu);
        row.addEventListener("contextmenu", menu);
        row.addEventListener("keydown", (ev) => {
          if (ev.target !== row) return;
          if (ev.key === "Enter") { ev.preventDefault(); open(); }
          else if (ev.key === "ContextMenu" || (ev.shiftKey && ev.key === "F10")) menu(ev);
        });

        row.append(sicon, body, actions);
        listEl.appendChild(row);
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
    function closeMenu() {
      if (menuEl) { menuEl.remove(); menuEl = null; }
      document.removeEventListener("mousedown", onMenuDown, true);
      document.removeEventListener("keydown", onMenuKey, true);
    }
    function onMenuDown(e) { if (menuEl && !menuEl.contains(e.target)) closeMenu(); }
    function onMenuKey(e) {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); closeMenu(); }
    }
    function openStashMenu(s, anchor) {
      closeMenu();
      hideTip();
      const menu = el("div", "gs-menu");
      const head = el("div", "gs-menu-head");
      head.appendChild(el("i", "codicon codicon-git-stash"));
      const nm = el("span"); nm.textContent = s.message; head.appendChild(nm);
      menu.appendChild(head);
      const item = (icon, label, danger, act) => {
        const b = el("button", "gs-menu-item" + (danger ? " danger" : ""),
          '<i class="codicon codicon-' + icon + '" aria-hidden="true"></i><span></span>');
        b.type = "button";
        b.querySelector("span").textContent = label;
        b.addEventListener("click", () => { closeMenu(); vscode.postMessage({ type: act, ref: s.ref }); });
        menu.appendChild(b);
      };
      item("arrow-down", "Apply", false, "apply");
      item("inbox", "Pop (apply & drop)", false, "pop");
      item("git-branch", "Create branch from stash", false, "branch");
      menu.appendChild(el("div", "gs-menu-sep"));
      item("trash", "Drop", true, "drop");
      document.body.appendChild(menu);
      menuEl = menu;
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
      if (m && m.type === "stashes") render(m.items, m.hasRepo, m.ok);
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
