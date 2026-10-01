// The Worktrees list — host-agnostic: it renders WorktreeRow messages and
// posts WorktreesToHost ones; the VS Code webview entry (main.ts) wires it to
// acquireVsCodeApi, and the desktop can mount the same class.
//
// A row is one line, as a VS Code tree's is: the folder's name, what it has
// checked out in quieter ink, and — on the right, only when there is one —
// the one state that matters most, in words ("3 changed", "2 to push",
// "folder missing"). Everything else it knows is in its tooltip. The
// worktree this window has open is its bold name, never a label.
//
// It opens — click, Enter, Space, → — to what it has and nothing else: its
// uncommitted files, its commits not pushed, what it has to pull, drawn by
// the shared rows the push review uses (changeRows.ts); with none of those,
// one quiet line says so. Hovered, it shows at most two buttons — Open in
// New Window and More — over its state; More lists only what can run now.
//
// Nothing is rebuilt that did not change: a row belongs to its path for life,
// a new list patches the rows that differ in place, and the row with the
// keyboard keeps it. A one-click change (Unlock) is painted at once and put
// back if the host says it failed.

import {
  WORKTREE_FILTER_AFTER,
  headWords,
  orderWorktreeRows,
  prunableCount,
  worktreeCaps,
  worktreeFacts,
  worktreeState,
  worktreeTip,
  type Gate,
  type WorktreeAction,
  type WorktreeDetails,
  type WorktreeRow,
  type WorktreesToHost,
  type WorktreesToPage,
} from "@gitstudio/host-bridge/worktreesProtocol";
import type { ChangeCommit, ChangeFile } from "@gitstudio/host-bridge/changeRows";
import { commitRow, emptyNote, fileRow, isCommitOpen, moreLine, sectionLabel, setCommitFiles } from "../changeRows/changeRows";
import * as l10n from "@vscode/l10n";

/** What the host says about the platform — how Reveal reads. */
export interface WorktreesLabels {
  reveal: string;
}

interface RowState {
  row: WorktreeRow;
  el: HTMLElement;
  /** The row line (the treeitem). */
  line: HTMLElement;
  details: HTMLElement;
  open: boolean;
  /** The details as last posted, while open. */
  loaded?: WorktreeDetails;
  busy?: string;
  /** Sig of what is painted, to skip unchanged rows. */
  sig: string;
}

/** For ids a row's group is owned by (aria-owns). */
let groupSeq = 0;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function codicon(name: string): HTMLElement {
  const i = el("i", `codicon codicon-${name}`);
  i.setAttribute("aria-hidden", "true");
  return i;
}

/** An icon button that says what it does in words (tooltip + accessible name). */
function iconButton(icon: string, label: string, cls = ""): HTMLButtonElement {
  const b = el("button", `wt-icon-btn${cls ? ` ${cls}` : ""}`);
  b.type = "button";
  b.appendChild(codicon(icon));
  b.dataset.tip = label;
  b.setAttribute("aria-label", label);
  return b;
}

export class WorktreesView {
  private readonly top: HTMLElement;
  private readonly filterBox: HTMLElement;
  private readonly filter: HTMLInputElement;
  private readonly pruneBtn: HTMLButtonElement;
  private readonly foot: HTMLElement;
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private readonly rows = new Map<string, RowState>();
  private order: string[] = [];
  private state: "ok" | "noRepo" | "discovering" | "failed" | "pending" = "pending";
  private labels: WorktreesLabels = { reveal: l10n.t("Reveal in File Manager") };
  private query = "";
  private observer: IntersectionObserver | undefined;
  /** The rows in view now — the host reads tier 1 for these. */
  private readonly inView = new Set<string>();
  private visibleTimer: ReturnType<typeof setTimeout> | undefined;
  private menu: HTMLElement | undefined;
  private menuFor: RowState | undefined;
  private readonly tip: HTMLElement;
  private tipTarget: HTMLElement | null = null;
  private tipTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly root: HTMLElement,
    private readonly post: (msg: WorktreesToHost) => void,
  ) {
    root.classList.add("wt-view");
    this.top = el("div", "wt-top");
    this.filterBox = el("label", "wt-filter");
    this.filterBox.appendChild(codicon("filter"));
    this.filter = el("input", "wt-filter-input");
    this.filter.type = "text";
    this.filter.spellcheck = false;
    this.filter.setAttribute("aria-label", l10n.t("Filter worktrees"));
    this.filterBox.appendChild(this.filter);
    this.top.append(this.filterBox);
    this.list = el("div", "wt-list");
    this.list.setAttribute("role", "tree");
    this.list.setAttribute("aria-label", l10n.t("Worktrees"));
    // Prune is a quiet link under the list — where the rows it forgets are
    // (the missing sort last) — and there only when git would prune one.
    this.foot = el("div", "wt-foot");
    this.pruneBtn = el("button", "wt-prune");
    this.pruneBtn.type = "button";
    this.foot.append(this.pruneBtn);
    this.note = el("div", "wt-note");
    root.replaceChildren(this.top, this.list, this.foot, this.note);

    this.filter.addEventListener("input", () => {
      this.query = this.filter.value.trim().toLowerCase();
      this.applyFilter();
    });
    this.filter.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        this.focusIndex(0);
      } else if (e.key === "Escape" && this.filter.value) {
        e.preventDefault();
        this.filter.value = "";
        this.query = "";
        this.applyFilter();
      }
    });
    this.pruneBtn.addEventListener("click", () => this.post({ type: "prune" }));
    this.list.addEventListener("keydown", (e) => this.onKey(e));
    this.list.addEventListener("focusin", (e) => this.onFocusIn(e));

    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver((entries) => {
        let changed = false;
        for (const en of entries) {
          const path = (en.target as HTMLElement).dataset.path;
          if (!path) continue;
          if (en.isIntersecting && !this.inView.has(path)) {
            this.inView.add(path);
            changed = true;
          } else if (!en.isIntersecting && this.inView.delete(path)) {
            changed = true;
          }
        }
        if (changed) this.flushVisible();
      });
    }

    if (typeof ResizeObserver !== "undefined") {
      let lastWidth = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      new ResizeObserver(() => {
        const w = this.list.clientWidth;
        if (w === lastWidth) return;
        lastWidth = w;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => this.refitAll(), 16);
      }).observe(this.list);
    }

    this.tip = el("div", "gs-tip");
    this.tip.setAttribute("aria-hidden", "true");
    document.body.appendChild(this.tip);
    document.addEventListener("pointerover", (e) => this.onPointerOver(e));
    document.addEventListener("pointerout", (e) => {
      const t = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
      if (t && t === this.tipTarget) this.hideTip();
    });
    document.addEventListener("pointerdown", () => this.hideTip());
    document.addEventListener("scroll", () => this.hideTip(), true);
  }

  /** A message from the host. */
  receive(msg: WorktreesToPage & { labels?: WorktreesLabels }): void {
    switch (msg.type) {
      case "rows":
        if (msg.labels) this.labels = msg.labels;
        this.setRows(msg.rows, msg.state);
        return;
      case "status": {
        const s = this.rows.get(msg.path);
        if (!s) return;
        this.patchRow(s, { ...s.row, status: msg.status ?? undefined });
        return;
      }
      case "details": {
        const s = this.rows.get(msg.path);
        if (!s || !s.open) return;
        // The same details again (a refresh that found nothing new) change nothing.
        if (s.loaded && JSON.stringify(s.loaded) === JSON.stringify(msg.details)) return;
        s.loaded = msg.details;
        this.paintDetails(s);
        return;
      }
      case "commitFiles": {
        const s = this.rows.get(msg.path);
        if (!s) return;
        const item = s.details.querySelector<HTMLElement>(`.cr-commit-item[data-sha="${CSS.escape(msg.sha)}"]`);
        if (item) {
          setCommitFiles(item, msg.files);
          this.syncTreeItems();
        }
        return;
      }
      case "busy": {
        const s = this.rows.get(msg.path);
        if (!s) return;
        s.busy = msg.busy ? (msg.label ?? l10n.t("Working…")) : undefined;
        if (s.busy && this.menuFor === s) {
          // Its menu offers nothing while it runs: gone, the keyboard back on the row.
          const had = !!this.menu?.contains(document.activeElement);
          this.closeMenu();
          if (had) s.line.focus();
        }
        this.paintRow(s, true);
        return;
      }
      case "patch": {
        const s = this.rows.get(msg.path);
        if (!s) return;
        this.patchRow(s, { ...s.row, ...msg.row });
        return;
      }
      case "drop": {
        this.dropRow(msg.path);
        this.paintChrome();
        return;
      }
    }
  }

  // ── The list ──────────────────────────────────────────────────────────────

  private setRows(rows: WorktreeRow[], state: "ok" | "noRepo" | "discovering" | "failed"): void {
    this.state = state;
    const ordered = orderWorktreeRows(rows);
    const keep = new Set(ordered.map((r) => r.path));
    const focused = this.focusedRow();
    let focusAt = -1;
    this.order.forEach((path, i) => {
      if (keep.has(path)) return;
      if (focused && focused.row.path === path) focusAt = i;
      this.dropRow(path);
    });
    let prev: HTMLElement | null = null;
    const made: RowState[] = [];
    for (const r of ordered) {
      let s = this.rows.get(r.path);
      if (!s) {
        s = this.makeRow(r);
        this.rows.set(r.path, s);
        this.observer?.observe(s.line);
        made.push(s);
      } else {
        // A new list does not know what tier 1 read since: keep it until
        // the host sends a fresh one.
        const row = r.status === undefined && s.row.status !== undefined ? { ...r, status: s.row.status } : r;
        this.patchRow(s, row, true);
      }
      const want: ChildNode | null = prev ? prev.nextSibling : this.list.firstChild;
      if (s.el !== want) this.list.insertBefore(s.el, want);
      prev = s.el;
    }
    this.order = ordered.map((r) => r.path);
    if (focusAt >= 0) this.focusIndex(Math.min(focusAt, this.visibleLines().length - 1));
    this.paintChrome();
    this.applyFilter();
    for (const s of made) this.fitRow(s);
    this.syncTreeItems();
  }

  private dropRow(path: string): void {
    const s = this.rows.get(path);
    if (!s) return;
    if (this.menuFor === s) this.closeMenu();
    const hadFocus = s.el.contains(document.activeElement);
    const lines = this.visibleLines();
    const idx = lines.indexOf(s.line);
    this.observer?.unobserve(s.line);
    s.el.remove();
    this.rows.delete(path);
    this.order = this.order.filter((p) => p !== path);
    this.inView.delete(path);
    if (hadFocus) this.focusIndex(Math.max(0, Math.min(idx, this.visibleLines().length - 1)));
  }

  /** The filter, Prune, the explainer, and the "nothing here" states. */
  private paintChrome(): void {
    const rows = [...this.rows.values()].map((s) => s.row);
    const n = rows.filter((r) => r.kind !== "bare").length;
    this.filterBox.hidden = n <= WORKTREE_FILTER_AFTER;
    this.filter.placeholder = l10n.t("Filter {0} worktrees", n);
    this.top.hidden = this.filterBox.hidden;
    const prunable = prunableCount(rows);
    // In whole words, as the view's title menu ("Prune Missing Worktrees…")
    // and the question it asks say it. Its tooltip says which kind: folders
    // that are gone, or folders that aren't worktrees any more.
    const allGone = rows.every((r) => !r.unlinked || r.locked);
    this.foot.hidden = prunable === 0;
    this.pruneBtn.textContent = prunable === 1
      ? l10n.t("Prune 1 missing worktree…")
      : l10n.t("Prune {0} missing worktrees…", prunable);
    this.pruneBtn.dataset.tip = allGone
      ? l10n.t("Forget the {0} whose folder is gone", prunable === 1 ? l10n.t("worktree") : l10n.t("{0} worktrees", prunable))
      : l10n.t("Forget the {0} git can prune: {1}", prunable === 1 ? l10n.t("worktree") : l10n.t("{0} worktrees", prunable), prunable === 1 ? l10n.t("its folder is gone, or isn't a worktree any more") : l10n.t("their folders are gone, or aren't worktrees any more"));
    this.pruneBtn.setAttribute("aria-label", this.pruneBtn.dataset.tip);

    this.note.replaceChildren();
    this.note.hidden = false;
    if (this.state === "noRepo" || this.state === "discovering" || (this.state === "failed" && n === 0)) {
      const title =
        this.state === "discovering"
          ? l10n.t("Looking for a repository…")
          : this.state === "failed"
            ? l10n.t("Couldn't read the worktrees")
            : l10n.t("No repository open");
      const hint =
        this.state === "discovering"
          ? ""
          : this.state === "failed"
            ? l10n.t("Something interrupted reading them — they refresh on their own.")
            : l10n.t("Open a folder that is a git repository to see its worktrees.");
      this.note.append(el("div", "wt-note-title", title));
      if (hint) this.note.append(el("div", "wt-note-hint", hint));
      return;
    }
    if (this.state === "ok" && n === 1) {
      this.note.append(
        el("div", "wt-note-title", l10n.t("Work on another branch, side by side")),
        el(
          "div",
          "wt-note-hint",
          l10n.t("A worktree is a second folder of this repository with its own branch checked out — no stashing, no switching."),
        ),
      );
      const add = el("button", "gs-btn gs-btn--primary wt-add");
      add.type = "button";
      add.append(codicon("add"), el("span", undefined, l10n.t("New Worktree…")));
      add.addEventListener("click", () => this.post({ type: "add" }));
      this.note.append(add);
      return;
    }
    this.note.hidden = true;
  }

  private applyFilter(): void {
    const q = this.query;
    let shown = 0;
    for (const s of this.rows.values()) {
      const hit =
        !q ||
        s.row.name.toLowerCase().includes(q) ||
        (s.row.branch ?? "").toLowerCase().includes(q) ||
        s.row.relPath.toLowerCase().includes(q);
      const was = s.el.hidden;
      s.el.hidden = !hit;
      if (hit) shown++;
      if (hit && was) this.fitRow(s);
    }
    this.list.classList.toggle("wt-filtered", !!q);
    if (q && shown === 0) {
      this.note.hidden = false;
      this.note.replaceChildren(el("div", "wt-note-hint", l10n.t("No worktree matches “{0}”.", this.filter.value.trim())));
    } else if (q) {
      this.note.hidden = true;
    }
    this.syncTreeItems();
  }

  // ── A row ─────────────────────────────────────────────────────────────────

  private makeRow(r: WorktreeRow): RowState {
    const item = el("div", "wt-item");
    item.dataset.path = r.path;
    const line = el("div", "wt-row");
    line.dataset.path = r.path;
    line.setAttribute("role", "treeitem");
    line.setAttribute("aria-level", "1");
    line.tabIndex = -1;
    const details = el("div", "wt-details cr-list");
    details.setAttribute("role", "group");
    details.hidden = true;
    // The row OWNS its group: a screen reader hears its files and commits as
    // the row's, not as more items of the tree beside it.
    details.id = `wt-group-${++groupSeq}`;
    line.setAttribute("aria-owns", details.id);
    item.append(line, details);
    const s: RowState = { row: r, el: item, line, details, open: false, sig: "" };
    line.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button")) return;
      this.toggle(s);
    });
    line.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.openMenu(s, line);
    });
    this.paintRow(s);
    return s;
  }

  /**
   * A row's data changed (a status, a patch, a new list): its line is painted
   * again if what it shows changed. Its files and commits are NOT: they
   * change only when the host sends its details, so an open commit keeps its
   * files and the row the keyboard is on keeps it. `inList`: part of a new
   * list, whose chrome is painted once at the end.
   */
  private patchRow(s: RowState, row: WorktreeRow, inList = false): void {
    s.row = row;
    this.paintRow(s);
    if (s.open && !worktreeCaps(row).expand) this.toggle(s, false);
    if (inList) return;
    this.paintChrome();
    this.applyFilter();
  }

  /** Paint a row's line from its data — only when what it shows changed. */
  private paintRow(s: RowState, force = false): void {
    const r = s.row;
    const caps = worktreeCaps(r);
    const sig = JSON.stringify([r, s.busy, s.open]);
    if (!force && sig === s.sig) return;
    s.sig = sig;
    const line = s.line;
    const hadFocus = line.contains(document.activeElement) && document.activeElement !== line;
    const focusedAction = hadFocus ? (document.activeElement as HTMLElement).dataset.action : undefined;
    line.replaceChildren();
    line.classList.toggle("is-current", r.current);
    line.classList.toggle("is-missing", r.missing || r.unlinked);
    line.classList.toggle("is-busy", !!s.busy);
    line.classList.toggle("has-menu", this.menuFor === s);
    s.el.classList.toggle("open", s.open);
    line.setAttribute("aria-busy", s.busy ? "true" : "false");
    if (caps.expand) line.setAttribute("aria-expanded", s.open ? "true" : "false");
    else line.removeAttribute("aria-expanded");

    const chev = el("span", "wt-chevron");
    if (caps.expand) chev.appendChild(codicon("chevron-right"));
    // A worktree row is a stash row's shape: two lines — its folder, then
    // what it has checked out and how it stands ("⎇ fix/cart · 2 changed") —
    // beside codicons' own worktree, as large as a stash's icon. The one this
    // window has open is its bold name; which is the repository's own is in
    // the tooltip.
    const icon = el("span", "wt-icon");
    icon.appendChild(codicon("worktree"));
    const text = el("span", "wt-text");
    const meta = el("span", "wt-meta");
    // The branch wears git's branch symbol, so it reads as a branch and not a
    // second name; a detached HEAD, a commit's.
    const head = el("span", "wt-head");
    head.append(codicon(r.branch ? "git-branch" : "git-commit"), el("span", "wt-head-text", headWords(r)));
    const state = el("span", "wt-state");
    const st = worktreeState(r);
    if (s.busy) {
      state.textContent = s.busy;
      state.classList.add("wt-busy");
    } else if (st) {
      state.textContent = st.text;
      state.dataset.state = st.id;
      state.dataset.tone = st.tone;
      if (st.short) state.dataset.short = st.short;
    }
    state.dataset.full = state.textContent ?? "";
    meta.append(head, state);
    text.append(el("span", "wt-name", r.name), meta);
    line.append(chev, icon, text);

    // Hovered, the buttons sit over the row's end, on its hover's fill; at
    // rest they take no room.
    const actions = el("span", "wt-actions");
    if (caps.openNew.ok) {
      const open = iconButton("empty-window", l10n.t("Open in New Window"));
      open.dataset.action = "openNew";
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        this.act(s, "openNew");
      });
      actions.appendChild(open);
    }
    const more = iconButton("ellipsis", l10n.t("More actions for {0}", r.name), "wt-more");
    more.dataset.action = "more";
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openMenu(s, more);
    });
    actions.appendChild(more);
    for (const b of actions.querySelectorAll("button")) {
      b.tabIndex = -1;
      if (s.busy) b.disabled = true;
    }
    line.appendChild(actions);

    const said = (t: string) => t.replace(/\.$/, "");
    const label = [`${r.name}, ${headWords(r)}`, ...(s.busy ? [s.busy] : []), ...worktreeFacts(r).map((f) => said(f.tip)), r.shownPath];
    line.setAttribute("aria-label", label.join(". "));
    if (focusedAction) {
      const again = line.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`);
      (again ?? line).focus();
    }
    this.fitRow(s);
  }

  /**
   * Fit a row to its width without making two rows read alike. Its name has
   * the first line to itself and gives way only in its MIDDLE ("wf_4b…cc2-3"):
   * worktrees' names share their start (agent-…, wf_4b651e91-cc2-…), and
   * their end is what tells them apart. On the second line the state is never
   * cut: the branch gives way first — to an ellipsis after four letters of
   * it — then a state with a short word ("merging") says it, and then the
   * branch goes whole, never a lone symbol. The tooltip names whatever the
   * row cannot show whole.
   */
  private fitRow(s: RowState): void {
    const line = s.line;
    if (!s.el.isConnected) return;
    const name = line.querySelector<HTMLElement>(".wt-name");
    const meta = line.querySelector<HTMLElement>(".wt-meta");
    const head = line.querySelector<HTMLElement>(".wt-head");
    const headText = head?.querySelector<HTMLElement>(".wt-head-text") ?? null;
    const state = line.querySelector<HTMLElement>(".wt-state");
    const over = (n: HTMLElement | null) => !!n && n.clientWidth > 0 && n.scrollWidth > n.clientWidth + 1;
    // The name to the fraction of a pixel: an overflow of 0.4px is below
    // scrollWidth's whole pixels, and still draws the ellipsis that cuts a letter.
    const nameOver = () => !!name && name.clientWidth > 0 && textOver(name);
    const metaOver = () => !!meta && meta.clientWidth > 0 && meta.scrollWidth > meta.clientWidth + 1;
    const branchShort = () => !!head && !head.hidden && !!headText && headText.clientWidth + 0.5 < leadWidth(headText, 4);
    if (name) name.textContent = s.row.name;
    const full = state?.dataset.full ?? "";
    if (state) state.textContent = full;
    if (head) head.hidden = false;
    if (meta && meta.clientWidth > 0 && state && full) {
      if ((branchShort() || metaOver()) && state.dataset.short) state.textContent = state.dataset.short;
      if (branchShort() || metaOver()) {
        if (head) head.hidden = true;
        // Alone on its line, the state takes its whole words again if they fit.
        state.textContent = full;
        if (metaOver() && state.dataset.short) state.textContent = state.dataset.short;
      }
    } else if (head && meta && meta.clientWidth > 0 && branchShort()) {
      head.hidden = true;
    }
    const clipped = !!name && nameOver() && clipMiddle(name, s.row.name);
    const tip = worktreeTip(s.row);
    const cut = !!head && (head.hidden || over(headText));
    line.dataset.tip = [clipped ? s.row.name : "", cut ? headWords(s.row) : "", tip].filter(Boolean).join("\n");
  }

  /** The list's width changed: every row is fitted again. */
  private refitAll(): void {
    for (const s of this.rows.values()) {
      if (!s.el.hidden) this.fitRow(s);
    }
    // The width the rows were last fitted to: tests wait on it after a resize.
    this.list.dataset.fitted = String(this.list.clientWidth);
  }

  private toggle(s: RowState, open?: boolean): void {
    if (!worktreeCaps(s.row).expand) return;
    const next = open ?? !s.open;
    if (next === s.open) return;
    s.open = next;
    s.el.classList.toggle("open", next);
    s.line.setAttribute("aria-expanded", next ? "true" : "false");
    s.details.hidden = !next;
    if (next) {
      s.loaded = undefined;
      this.paintDetails(s);
      this.post({ type: "expand", path: s.row.path });
    } else {
      s.details.replaceChildren();
      this.post({ type: "collapse", path: s.row.path });
    }
    s.sig = JSON.stringify([s.row, s.busy, s.open]);
    this.syncTreeItems();
  }

  // ── A row's details ───────────────────────────────────────────────────────

  /**
   * An open row's details, from what the host last sent — only what there
   * is: its uncommitted files, its commits not pushed, what it has to pull,
   * each under a quiet label; with none of them, one line that says so. A
   * list that is empty is not shown at all, label and all.
   *
   * Commit items already on screen are kept whole — open or not, with the
   * files they loaded — so a repaint never asks for those files again, never
   * shows "Loading files…" over them, and never moves the row the keyboard
   * is on.
   */
  private paintDetails(s: RowState): void {
    const r = s.row;
    const d = s.details;
    const kept = new Map<string, HTMLElement>();
    for (const item of d.querySelectorAll<HTMLElement>(".cr-commit-item")) {
      if (item.dataset.sha) kept.set(item.dataset.sha, item);
    }
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && d.contains(active) ? keyOf(active) : undefined;

    const parts: HTMLElement[] = [];
    const det = s.loaded;
    if (!det) {
      d.replaceChildren(el("div", "cr-loading wt-loading", l10n.t("Loading…")));
      this.syncTreeItems();
      return;
    }
    if (det.filesUnread) {
      parts.push(emptyNote(l10n.t("Couldn't read its uncommitted changes.")));
    } else if (det.files.length > 0) {
      // Grouped as VS Code's Source Control groups them — the label says
      // which side a file is on, so no file wears a tag for it.
      for (const [label, areas] of FILE_GROUPS) {
        const files = det.files.filter((f) => areas.includes(f.area ?? "unstaged"));
        if (files.length === 0) continue;
        parts.push(sectionLabel(label, files.length));
        for (const f of files) {
          parts.push(
            fileRow(f, {
              onOpen: (file) => this.post({ type: "openFile", path: r.path, file }),
              role: "treeitem",
              tabIndex: -1,
            }),
          );
        }
      }
      if (det.filesTotal > det.files.length) {
        parts.push(moreLine(`and ${det.filesTotal - det.files.length} more`));
      }
    }
    for (const sec of [det.unpushed, det.toPull]) {
      if (!sec || sec.commits.length === 0) continue;
      parts.push(sectionLabel(sec.title, sec.more ? undefined : sec.commits.length));
      for (const c of sec.commits) {
        // A sha is the commit's content: the item on screen for it is it.
        const item =
          kept.get(c.sha) ??
          commitRow(c, {
            loadFiles: (commit: ChangeCommit) => this.post({ type: "commitFiles", path: r.path, sha: commit.sha }),
            onOpenFile: (commit: ChangeCommit, file: ChangeFile) =>
              this.post({ type: "openCommitFile", path: r.path, sha: commit.sha, parent: commit.parents?.[0], file }),
            role: "treeitem",
            tabIndex: -1,
          });
        kept.delete(c.sha);
        parts.push(item);
      }
      if (sec.more) parts.push(moreLine(l10n.t("and more — the Commit Graph shows them all")));
    }
    if (parts.length === 0) parts.push(emptyNote(l10n.t("Nothing to commit or push.")));
    const verbs = this.verbs(s);
    if (verbs) parts.push(verbs);
    d.replaceChildren(...parts);
    this.syncTreeItems();
    if (focusKey) {
      const again = [...d.querySelectorAll<HTMLElement>("[role=treeitem], button")].find((n) => keyOf(n) === focusKey);
      again?.focus();
    }
  }

  /**
   * An open worktree's Pull and Push…, under what they would move — only
   * when there is something to move and it can run: a button that can't,
   * or has nothing to do, is not drawn (the menu keeps both).
   */
  private verbs(s: RowState): HTMLElement | undefined {
    const r = s.row;
    const caps = worktreeCaps(r);
    const out = r.ahead > 0 || (r.status?.unpublished ?? 0) > 0;
    const shown: [WorktreeAction, string, string, string][] = [];
    if (caps.pull.ok && r.behind > 0) {
      shown.push(["pull", "repo-pull", l10n.t("Pull"), r.behind === 1
        ? l10n.t("Pull 1 commit into {0}, in its own folder", r.name)
        : l10n.t("Pull {0} commits into {1}, in its own folder", r.behind, r.name)]);
    }
    if (caps.push.ok && out) shown.push(["push", "repo-push", l10n.t("Push…"), l10n.t("Review what {0} would push", r.name)]);
    if (shown.length === 0) return undefined;
    const strip = el("div", "wt-verbs");
    strip.setAttribute("role", "none");
    for (const [action, icon, label, tip] of shown) {
      // Each one an item of the row's group, as its files and commits are:
      // one tree for a screen reader, ↑/↓ reach it, Enter presses it.
      const b = el("button", "gs-btn wt-verb");
      b.type = "button";
      b.setAttribute("role", "treeitem");
      b.dataset.action = action;
      b.dataset.tip = tip;
      b.setAttribute("aria-label", tip);
      b.append(codicon(icon), el("span", undefined, label));
      b.tabIndex = -1;
      if (s.busy) b.disabled = true;
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        this.act(s, action);
      });
      strip.appendChild(b);
    }
    return strip;
  }

  private act(s: RowState, action: WorktreeAction): void {
    if (s.busy) return;
    // Unlock needs no question: painted now, put back if the host says so.
    if (action === "unlock") {
      this.patchRow(s, { ...s.row, locked: false, lockReason: undefined });
    }
    this.post({ type: "action", path: s.row.path, action });
  }

  // ── The More menu ─────────────────────────────────────────────────────────

  /**
   * A row's More menu: only what it can do now, in words — an action that
   * can't run is not listed (Pull and Push with no remote, Remove on the
   * main worktree, Open on the one this window has open). The host refuses
   * by the same capabilities, so a stale page can't ask for more.
   */
  private openMenu(s: RowState, anchor: HTMLElement): void {
    // A row running an action takes no second one — its menu included.
    if (s.busy) return;
    this.closeMenu();
    this.hideTip();
    const r = s.row;
    const caps = worktreeCaps(r);
    const menu = el("div", "wt-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", l10n.t("Actions for {0}", r.name));
    const ok = (gate: Gate | boolean): boolean => gate === true || (typeof gate === "object" && gate.ok);
    type Item = [WorktreeAction, string, string, Gate | boolean, boolean?];
    const groups: Item[][] = [
      [
        // A window, not a folder: Reveal's folder is two items down.
        ["openHere", "window", l10n.t("Open in This Window"), r.kind === "bare" ? false : caps.openHere],
        ["openNew", "empty-window", l10n.t("Open in New Window"), r.kind === "bare" ? false : caps.openNew],
        ["reveal", "folder", this.labels.reveal, caps.reveal],
        ["terminal", "terminal", l10n.t("Open in Terminal"), caps.terminal],
        ["copyPath", "copy", l10n.t("Copy Path"), true],
      ],
      [
        ["pull", "repo-pull", l10n.t("Pull"), caps.pull],
        ["push", "repo-push", l10n.t("Push…"), caps.push],
      ],
      [
        r.locked ? ["unlock", "unlock", l10n.t("Unlock"), caps.unlock] : ["lock", "lock", l10n.t("Lock…"), caps.lock],
        caps.forget ? ["forget", "close", l10n.t("Forget Worktree…"), true, true] : ["remove", "trash", l10n.t("Remove Worktree…"), caps.remove, true],
      ],
    ];
    for (const group of groups) {
      const items = group.filter(([, , , gate]) => ok(gate));
      if (items.length === 0) continue;
      if (menu.childElementCount > 0) menu.appendChild(el("div", "wt-menu-sep"));
      for (const [action, icon, label, , danger] of items) {
        const b = el("button", `wt-menu-item${danger ? " danger" : ""}`);
        b.type = "button";
        b.setAttribute("role", "menuitem");
        b.dataset.action = action;
        b.append(codicon(icon), el("span", "wt-menu-label", label));
        b.addEventListener("click", () => {
          this.closeMenu();
          s.line.focus();
          this.act(s, action);
        });
        menu.appendChild(b);
      }
    }
    document.body.appendChild(menu);
    this.menu = menu;
    this.menuFor = s;
    s.line.classList.add("has-menu");
    const PAD = 6;
    const m = menu.getBoundingClientRect();
    const a = anchor.getBoundingClientRect();
    const left = Math.max(PAD, Math.min(a.right - m.width, window.innerWidth - m.width - PAD));
    let top = a.bottom + 2;
    if (top + m.height > window.innerHeight - PAD) top = Math.max(PAD, a.top - m.height - 2);
    menu.style.left = `${Math.round(left)}px`;
    menu.style.top = `${Math.round(top)}px`;
    menu.addEventListener("keydown", (e) => this.onMenuKey(e));
    setTimeout(() => document.addEventListener("mousedown", this.onDocDown, true), 0);
    menu.querySelector<HTMLElement>(".wt-menu-item")?.focus();
  }

  private readonly onDocDown = (e: MouseEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  private closeMenu(): void {
    this.menuFor?.line.classList.remove("has-menu");
    this.menu?.remove();
    this.menu = undefined;
    this.menuFor = undefined;
    document.removeEventListener("mousedown", this.onDocDown, true);
  }

  private onMenuKey(e: KeyboardEvent): void {
    const items = [...(this.menu?.querySelectorAll<HTMLElement>(".wt-menu-item") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape" || e.key === "Tab") {
      e.preventDefault();
      const back = this.menuFor?.line;
      this.closeMenu();
      back?.focus();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const n = items.length;
      items[(i + (e.key === "ArrowDown" ? 1 : n - 1) + n) % n]?.focus();
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      items[e.key === "Home" ? 0 : items.length - 1]?.focus();
    }
  }

  // ── Keyboard: one tree ────────────────────────────────────────────────────

  /** Every treeitem a person can reach now, top to bottom. */
  private visibleLines(): HTMLElement[] {
    return [...this.list.querySelectorAll<HTMLElement>("[role=treeitem]")].filter((n) => n.offsetParent !== null || n === document.activeElement);
  }

  /** One tab stop for the whole tree: the focused item, else the first. */
  private syncTreeItems(): void {
    const items = this.visibleLines();
    const active = document.activeElement as HTMLElement | null;
    const current = items.find((n) => n === active) ?? items.find((n) => n.tabIndex === 0) ?? items[0];
    for (const n of items) n.tabIndex = n === current ? 0 : -1;
    // Levels for a screen reader: a row 1, its files and commits 2, a commit's files 3.
    for (const n of this.list.querySelectorAll<HTMLElement>(".wt-details [role=treeitem]")) {
      n.setAttribute("aria-level", n.closest(".cr-commit-files") ? "3" : "2");
    }
    for (const n of this.list.querySelectorAll<HTMLElement>(".cr-commit-item > .cr-commit")) {
      n.setAttribute("aria-expanded", isCommitOpen(n.parentElement as HTMLElement) ? "true" : "false");
    }
  }

  private focusIndex(i: number): void {
    const items = this.visibleLines();
    const n = items[Math.max(0, Math.min(i, items.length - 1))];
    if (!n) return;
    for (const x of items) x.tabIndex = x === n ? 0 : -1;
    n.focus();
    n.scrollIntoView({ block: "nearest" });
  }

  private onFocusIn(e: FocusEvent): void {
    const t = e.target as HTMLElement;
    if (t.getAttribute("role") === "treeitem") {
      for (const x of this.visibleLines()) x.tabIndex = x === t ? 0 : -1;
    }
  }

  private focusedRow(): RowState | undefined {
    const a = document.activeElement as HTMLElement | null;
    const item = a?.closest?.(".wt-item") as HTMLElement | null;
    return item?.dataset.path ? this.rows.get(item.dataset.path) : undefined;
  }

  private onKey(e: KeyboardEvent): void {
    const t = e.target as HTMLElement;
    if (t.getAttribute("role") !== "treeitem") return;
    const items = this.visibleLines();
    const i = items.indexOf(t);
    const rowState = t.classList.contains("wt-row") ? this.rows.get(t.dataset.path ?? "") : undefined;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        this.focusIndex(i + 1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (i === 0 && !this.filterBox.hidden) this.filter.focus();
        else this.focusIndex(i - 1);
        return;
      case "Home":
        e.preventDefault();
        this.focusIndex(0);
        return;
      case "End":
        e.preventDefault();
        this.focusIndex(items.length - 1);
        return;
      case "ArrowRight":
        if (rowState) {
          e.preventDefault();
          if (!rowState.open) this.toggle(rowState, true);
          else this.focusIndex(i + 1);
        } else if (t.classList.contains("cr-commit") && isCommitOpen(t.parentElement as HTMLElement)) {
          e.preventDefault();
          this.focusIndex(i + 1);
        }
        return;
      case "ArrowLeft": {
        if (rowState?.open) {
          e.preventDefault();
          this.toggle(rowState, false);
          return;
        }
        if (rowState) return;
        e.preventDefault();
        // To the parent: the commit a file is under, else the worktree row.
        const commit = t.closest(".cr-commit-files")?.parentElement?.querySelector<HTMLElement>(":scope > .cr-commit");
        const parent = commit ?? t.closest(".wt-item")?.querySelector<HTMLElement>(":scope > .wt-row");
        parent?.focus();
        return;
      }
      case "Enter":
      case " ":
        if (rowState) {
          e.preventDefault();
          this.toggle(rowState);
        } else if (t.classList.contains("wt-verb")) {
          e.preventDefault();
          t.click();
        }
        return;
      case "ContextMenu":
      case "F10":
        if (rowState && (e.key === "ContextMenu" || e.shiftKey)) {
          e.preventDefault();
          this.openMenu(rowState, rowState.line.querySelector<HTMLElement>(".wt-more") ?? rowState.line);
        }
        return;
      case "Delete":
      case "Backspace":
        // ⌘⌫ too — a Mac's delete key sends Backspace (VS Code's lists take it).
        if (e.key === "Backspace" && !e.metaKey) return;
        if (rowState && !rowState.busy) {
          const caps = worktreeCaps(rowState.row);
          if (caps.forget || caps.remove.ok) {
            e.preventDefault();
            this.act(rowState, caps.forget ? "forget" : "remove");
          }
        }
        return;
    }
  }

  // ── Which rows are in view (tier 1 is read for those) ─────────────────────

  /** Tell the host which rows are in view (all of them, once the list settles). */
  private flushVisible(): void {
    if (this.visibleTimer) return;
    this.visibleTimer = setTimeout(() => {
      this.visibleTimer = undefined;
      this.post({ type: "visible", paths: [...this.inView].filter((p) => this.rows.has(p)) });
    }, 40);
  }

  /** The view was hidden and shown again: say again what is in view. */
  revalidateVisible(): void {
    this.flushVisible();
  }

  // ── Tooltips (a native title is unreliable in a webview) ──────────────────

  private onPointerOver(e: PointerEvent): void {
    const t = (e.target as Element | null)?.closest?.("[data-tip]") as HTMLElement | null;
    if (t === this.tipTarget) return;
    this.hideTip();
    if (t && !this.menu?.contains(t)) {
      this.tipTarget = t;
      this.tipTimer = setTimeout(() => this.showTip(), 450);
    }
  }

  private hideTip(): void {
    if (this.tipTimer) clearTimeout(this.tipTimer);
    this.tipTimer = undefined;
    this.tipTarget = null;
    this.tip.classList.remove("show");
  }

  private showTip(): void {
    const t = this.tipTarget;
    const text = t?.dataset.tip;
    if (!t || !text || !t.isConnected) return;
    this.tip.textContent = text;
    this.tip.classList.add("show");
    const r = t.getBoundingClientRect();
    const tw = this.tip.offsetWidth;
    const th = this.tip.offsetHeight;
    const left = Math.max(4, Math.min(window.innerWidth - tw - 4, r.left + r.width / 2 - tw / 2));
    let top = r.bottom + 4;
    if (top + th > window.innerHeight - 4) top = Math.max(4, r.top - th - 4);
    this.tip.style.left = `${Math.round(left)}px`;
    this.tip.style.top = `${Math.round(top)}px`;
  }
}

/** Its text runs past its box — by any fraction of a pixel (text-overflow
 *  draws its ellipsis for that too). A range's width is the whole text's,
 *  drawn or not. */
function textOver(el: HTMLElement): boolean {
  const r = document.createRange();
  r.selectNodeContents(el);
  return r.getBoundingClientRect().width > el.getBoundingClientRect().width + 0.01;
}

/**
 * Clip an element's text in its middle to the width it has — its start, "…",
 * its end, two letters or more each side — and say whether it did. Its box
 * shrinks with its text (a flex item's basis is its content), so "fits" is
 * the element's own verdict: nothing past its edge.
 */
function clipMiddle(el: HTMLElement, full: string): boolean {
  const fits = () => !textOver(el);
  const at = (k: number) => clipAt(full, k);
  let lo = CLIP_MIN;
  let hi = full.length - 1;
  if (hi < lo) return false;
  el.textContent = at(lo);
  if (!fits()) return true; // as few letters as tell it apart; the row's end gives way before this
  while (lo < hi) {
    const k = Math.ceil((lo + hi) / 2);
    el.textContent = at(k);
    if (fits()) lo = k;
    else hi = k - 1;
  }
  el.textContent = at(lo);
  return true;
}

/** The fewest letters a clipped name keeps: two at each end. */
const CLIP_MIN = 4;

/** A name clipped in its middle to `k` letters — or whole, if it is no longer. */
function clipAt(full: string, k: number): string {
  if (full.length <= k) return full;
  return `${full.slice(0, Math.ceil(k / 2))}…${full.slice(full.length - Math.floor(k / 2))}`;
}

/** How wide the first `n` letters of an element's text are drawn (all of it, if shorter). */
function leadWidth(el: HTMLElement, n: number): number {
  const t = el.firstChild;
  if (!t || t.nodeType !== Node.TEXT_NODE) return 0;
  const r = document.createRange();
  r.setStart(t, 0);
  r.setEnd(t, Math.min(n, (t as Text).length));
  return r.getBoundingClientRect().width;
}

/** A stable key for a focusable node across a repaint of the details. */
function keyOf(n: HTMLElement): string {
  if (n.dataset.action) return `a:${n.dataset.action}`;
  const file = n.closest<HTMLElement>(".cr-file");
  const commit = n.closest<HTMLElement>(".cr-commit-item");
  if (file) return `f:${commit?.dataset.sha ?? ""}:${file.dataset.area ?? ""}:${file.dataset.path}`;
  if (commit) return `c:${commit.dataset.sha}`;
  return "";
}

/** An open row's uncommitted files, in the groups VS Code's Source Control shows. */
const FILE_GROUPS: [string, NonNullable<ChangeFile["area"]>[]][] = [
  [l10n.t("Conflicts"), ["conflicted"]],
  [l10n.t("Staged changes"), ["staged"]],
  [l10n.t("Changes"), ["unstaged", "untracked"]],
];

