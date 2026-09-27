// The Worktrees list — host-agnostic: it renders WorktreeRow messages and
// posts WorktreesToHost ones; the VS Code webview entry (main.ts) wires it to
// acquireVsCodeApi, and the desktop can mount the same class.
//
// A row is two lines: the folder's name and what it has checked out; then its
// badges (in words) and where the folder is. It opens — click, Enter, Space,
// → — to its uncommitted files and its commits not pushed, drawn by the shared
// rows the push review uses (changeRows.ts). Each row's actions are an Open in
// New Window button and a More menu of labelled items; an action it cannot
// take is shown disabled with the reason beside it.
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
  unpublishedTitle,
  worktreeBadges,
  worktreeCaps,
  type Gate,
  type WorktreeAction,
  type WorktreeDetails,
  type WorktreeRow,
  type WorktreesToHost,
  type WorktreesToPage,
} from "@gitstudio/host-bridge/worktreesProtocol";
import type { ChangeCommit, ChangeFile } from "@gitstudio/host-bridge/changeRows";
import {
  commitRow,
  emptyNote,
  fileRow,
  isCommitOpen,
  moreLine,
  sectionLabel,
  setCommitFiles,
} from "../changeRows/changeRows";

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
  private readonly list: HTMLElement;
  private readonly note: HTMLElement;
  private readonly rows = new Map<string, RowState>();
  private order: string[] = [];
  private state: "ok" | "noRepo" | "discovering" | "failed" | "pending" = "pending";
  private labels: WorktreesLabels = { reveal: "Reveal in File Manager" };
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
    this.filter.setAttribute("aria-label", "Filter worktrees");
    this.filterBox.appendChild(this.filter);
    this.pruneBtn = el("button", "gs-btn wt-prune");
    this.pruneBtn.type = "button";
    this.top.append(this.filterBox, this.pruneBtn);
    this.list = el("div", "wt-list");
    this.list.setAttribute("role", "tree");
    this.list.setAttribute("aria-label", "Worktrees");
    this.note = el("div", "wt-note");
    root.replaceChildren(this.top, this.list, this.note);

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
        s.busy = msg.busy ? (msg.label ?? "Working…") : undefined;
        this.paintRow(s, true);
        if (s.open) this.paintStrip(s);
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
    for (const s of made) this.fitBadges(s);
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

  /** The top bar, the explainer, and the "nothing here" states. */
  private paintChrome(): void {
    const rows = [...this.rows.values()].map((s) => s.row);
    const n = rows.filter((r) => r.kind !== "bare").length;
    this.filterBox.hidden = n <= WORKTREE_FILTER_AFTER;
    this.filter.placeholder = `Filter ${n} worktrees`;
    const prunable = prunableCount(rows);
    // "missing" while every one of them is a folder that is gone; "stale"
    // once one is a folder still there that isn't a worktree any more.
    const allGone = rows.every((r) => !r.unlinked || r.locked);
    this.pruneBtn.hidden = prunable === 0;
    this.pruneBtn.replaceChildren(codicon("trash"), el("span", undefined, `Prune ${prunable} ${allGone ? "missing" : "stale"}`));
    this.pruneBtn.dataset.tip = allGone
      ? `Forget the ${prunable === 1 ? "worktree" : `${prunable} worktrees`} whose folder is gone`
      : `Forget the ${prunable === 1 ? "worktree" : `${prunable} worktrees`} git can prune: ${prunable === 1 ? "its folder is gone, or isn't a worktree any more" : "their folders are gone, or aren't worktrees any more"}`;
    this.pruneBtn.setAttribute("aria-label", this.pruneBtn.dataset.tip);
    this.top.hidden = this.filterBox.hidden && this.pruneBtn.hidden;

    this.note.replaceChildren();
    this.note.hidden = false;
    if (this.state === "noRepo" || this.state === "discovering" || (this.state === "failed" && n === 0)) {
      const title =
        this.state === "discovering"
          ? "Looking for a repository…"
          : this.state === "failed"
            ? "Couldn't read the worktrees"
            : "No repository open";
      const hint =
        this.state === "discovering"
          ? ""
          : this.state === "failed"
            ? "Something interrupted reading them — they refresh on their own."
            : "Open a folder that is a git repository to see its worktrees.";
      this.note.append(el("div", "wt-note-title", title));
      if (hint) this.note.append(el("div", "wt-note-hint", hint));
      return;
    }
    if (this.state === "ok" && n === 1) {
      this.note.append(
        el("div", "wt-note-title", "Work on another branch, side by side"),
        el(
          "div",
          "wt-note-hint",
          "A worktree is a second folder of this repository with its own branch checked out — no stashing, no switching.",
        ),
      );
      const add = el("button", "gs-btn gs-btn--primary wt-add");
      add.type = "button";
      add.append(codicon("add"), el("span", undefined, "New Worktree…"));
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
      if (hit && was) this.fitBadges(s);
    }
    this.list.classList.toggle("wt-filtered", !!q);
    if (q && shown === 0) {
      this.note.hidden = false;
      this.note.replaceChildren(el("div", "wt-note-hint", `No worktree matches “${this.filter.value.trim()}”.`));
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
   * again if what it shows changed, and an open row's strip — its upstream and
   * Pull / Push… — likewise. Its files and commits are NOT: they change only
   * when the host sends its details, so an open commit keeps its files and
   * the row the keyboard is on keeps it. `inList`: part of a new list, whose
   * chrome is painted once at the end.
   */
  private patchRow(s: RowState, row: WorktreeRow, inList = false): void {
    s.row = row;
    this.paintRow(s);
    if (s.open && !worktreeCaps(row).expand) this.toggle(s, false);
    else if (s.open) this.paintStrip(s);
    if (inList) return;
    this.paintChrome();
    this.applyFilter();
  }

  /** Paint a row's line from its data — only when what it shows changed. */
  private paintRow(s: RowState, force = false): void {
    const r = s.row;
    const badges = worktreeBadges(r);
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
    s.el.classList.toggle("open", s.open);
    line.setAttribute("aria-busy", s.busy ? "true" : "false");
    if (caps.expand) line.setAttribute("aria-expanded", s.open ? "true" : "false");
    else line.removeAttribute("aria-expanded");

    const chev = el("span", "wt-chevron");
    if (caps.expand) chev.appendChild(codicon("chevron-right"));
    const icon = el("span", "wt-icon");
    icon.appendChild(codicon(r.kind === "bare" ? "repo" : "worktree"));
    const body = el("div", "wt-body");
    const l1 = el("div", "wt-line1");
    const name = el("span", "wt-name", r.name);
    l1.append(name);
    // The folder named for its branch says it once.
    if (r.branch !== r.name) {
      const head = el("span", "wt-head");
      head.append(codicon(r.kind === "bare" ? "repo" : r.branch ? "git-branch" : "git-commit"), el("span", "wt-head-text", headWords(r)));
      l1.append(head);
    }
    const l2 = el("div", "wt-line2");
    if (s.busy) {
      l2.append(el("span", "wt-busy", s.busy));
    } else {
      for (const b of badges) {
        const pill = el("span", `wt-badge wt-badge--${b.tone}`, b.text);
        pill.dataset.badge = b.id;
        pill.dataset.tip = b.tip;
        l2.appendChild(pill);
      }
    }
    const where = el("span", "wt-path", r.relPath);
    l2.appendChild(where);
    body.append(l1, l2);

    const actions = el("span", "wt-actions");
    if (caps.forget) {
      const forget = iconButton("close", "Forget Worktree…", "wt-danger");
      forget.dataset.action = "forget";
      forget.addEventListener("click", (e) => {
        e.stopPropagation();
        this.act(s, "forget");
      });
      actions.appendChild(forget);
    } else if (caps.openNew.ok) {
      const open = iconButton("empty-window", "Open in New Window");
      open.dataset.action = "openNew";
      open.addEventListener("click", (e) => {
        e.stopPropagation();
        this.act(s, "openNew");
      });
      actions.appendChild(open);
    } else {
      // Holds the place, so every row's More sits in the same column.
      actions.appendChild(el("span", "wt-icon-spacer"));
    }
    const more = iconButton("ellipsis", `More actions for ${r.name}`, "wt-more");
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
    line.append(chev, icon, body, actions);

    const label = [
      r.name,
      headWords(r),
      ...badges.map((b) => b.text),
      r.relPath,
    ].join(", ");
    line.setAttribute("aria-label", label);
    line.dataset.tip = `${r.name} — ${r.shownPath}`;
    if (focusedAction) {
      const again = line.querySelector<HTMLElement>(`[data-action="${focusedAction}"]`);
      (again ?? line).focus();
    }
    this.fitBadges(s);
  }

  /**
   * The badges that do not fit on the line go into one "+N more" badge that
   * names them on hover — never clipped mid-word at the edge. The folder,
   * last on the line, gives way first (it is in the tooltip too). The line's
   * accessible name lists every badge either way.
   */
  private fitBadges(s: RowState): void {
    const l2 = s.line.querySelector<HTMLElement>(".wt-line2");
    if (!l2 || !s.el.isConnected) return;
    l2.querySelector(".wt-badge--more")?.remove();
    const badges = [...l2.querySelectorAll<HTMLElement>(".wt-badge")];
    for (const b of badges) {
      b.hidden = false;
      b.classList.remove("wt-badge--squeezed");
    }
    const fits = () => l2.scrollWidth <= l2.clientWidth + 1;
    if (l2.clientWidth === 0 || fits()) return;
    const more = el("span", "wt-badge wt-badge--more");
    more.dataset.badge = "more";
    more.setAttribute("aria-hidden", "true");
    l2.insertBefore(more, l2.querySelector(".wt-path"));
    const hidden: HTMLElement[] = [];
    for (let i = badges.length - 1; i > 0; i--) {
      badges[i].hidden = true;
      hidden.unshift(badges[i]);
      more.textContent = `+${hidden.length} more`;
      more.dataset.tip = hidden.map((h) => h.textContent).join(" · ");
      if (fits()) return;
    }
    // Still too wide: the one badge left gives way (its words end in an
    // ellipsis, whole on hover) so "+N more" is never the thing cut off.
    if (hidden.length === 0) more.remove();
    badges[0]?.classList.add("wt-badge--squeezed");
  }

  /** The list's width changed: every row's badges are fitted again. */
  private refitAll(): void {
    for (const s of this.rows.values()) {
      if (!s.el.hidden) this.fitBadges(s);
    }
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

  /** What an open row's strip shows, to repaint it only when that changed. */
  private stripSig(s: RowState): string {
    const r = s.row;
    const caps = worktreeCaps(r);
    return JSON.stringify([r.name, r.branch, r.upstream, r.upstreamGone, r.hasRemotes, headWords(r), caps.pull, caps.push, s.busy]);
  }

  /** The way to this worktree's remote: its upstream and the two verbs. */
  private strip(s: RowState): HTMLElement {
    const r = s.row;
    const caps = worktreeCaps(r);
    const strip = el("div", "wt-strip");
    strip.dataset.sig = this.stripSig(s);
    const where = el("span", "wt-upstream");
    if (r.branch && r.upstream) {
      where.append(codicon("cloud"), el("span", undefined, r.upstreamGone ? `${r.upstream} (gone)` : r.upstream));
    } else if (r.branch && r.hasRemotes) {
      where.append(codicon("cloud"), el("span", undefined, "No upstream — Push publishes it"));
    } else if (r.branch) {
      where.append(codicon("cloud"), el("span", undefined, "No remote"));
    } else {
      where.append(codicon("git-commit"), el("span", undefined, `No branch — ${headWords(r)}`));
    }
    where.dataset.tip = where.textContent ?? "";
    strip.appendChild(where);
    const verbs = el("span", "wt-verbs");
    verbs.append(
      this.verb(s, "pull", "repo-pull", "Pull", caps.pull),
      this.verb(s, "push", "repo-push", "Push…", caps.push),
    );
    strip.appendChild(verbs);
    return strip;
  }

  /** An open row's strip, painted again in place — only when what it shows changed. */
  private paintStrip(s: RowState): void {
    const old = s.details.querySelector<HTMLElement>(":scope > .wt-strip");
    if (!old || old.dataset.sig === this.stripSig(s)) return;
    const active = document.activeElement as HTMLElement | null;
    const focusKey = active && old.contains(active) ? keyOf(active) : undefined;
    const next = this.strip(s);
    old.replaceWith(next);
    this.syncTreeItems();
    if (focusKey) [...next.querySelectorAll<HTMLElement>("[data-action]")].find((n) => keyOf(n) === focusKey)?.focus();
  }

  /**
   * An open row's details, from what the host last sent. Commit items already
   * on screen are kept whole — open or not, with the files they loaded — so a
   * repaint never asks for those files again, never shows "Loading files…"
   * over them, and never moves the row the keyboard is on.
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

    const parts: HTMLElement[] = [this.strip(s)];

    const det = s.loaded;
    if (!det) {
      parts.push(el("div", "cr-loading wt-loading", "Loading…"));
      d.replaceChildren(...parts);
      this.syncTreeItems();
      return;
    }
    // Uncommitted.
    parts.push(sectionLabel("Uncommitted", det.filesUnread ? undefined : det.filesTotal));
    if (det.filesUnread) {
      parts.push(emptyNote("Couldn't read its uncommitted changes."));
    } else if (det.files.length === 0) {
      parts.push(emptyNote("No uncommitted changes."));
    } else {
      for (const f of det.files) {
        parts.push(
          fileRow(f, {
            onOpen: (file) => this.post({ type: "openFile", path: r.path, file }),
            role: "treeitem",
            tabIndex: -1,
          }),
        );
      }
      if (det.filesTotal > det.files.length) {
        parts.push(moreLine(`and ${det.filesTotal - det.files.length} more`));
      }
    }
    // Not pushed, then to pull.
    for (const sec of [det.unpushed, det.toPull]) {
      if (!sec) continue;
      parts.push(sectionLabel(sec.title, sec.more ? undefined : sec.commits.length));
      if (sec.commits.length === 0) {
        parts.push(emptyNote(sec === det.unpushed ? unpublishedEmpty(r) : "Nothing to pull."));
        continue;
      }
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
      if (sec.more) parts.push(moreLine("and more — the Commit Graph shows them all"));
    }
    d.replaceChildren(...parts);
    this.syncTreeItems();
    if (focusKey) {
      const again = [...d.querySelectorAll<HTMLElement>("[role=treeitem], button")].find((n) => keyOf(n) === focusKey);
      again?.focus();
    }
  }

  /** Pull or Push… in a row's strip: a labelled button, or a disabled one that says why. */
  private verb(s: RowState, action: WorktreeAction, icon: string, label: string, gate: Gate): HTMLButtonElement {
    const b = el("button", "gs-btn wt-verb");
    b.type = "button";
    b.dataset.action = action;
    b.append(codicon(icon), el("span", undefined, label));
    if (gate.ok) {
      b.dataset.tip = action === "pull" ? `Pull into ${s.row.name}, in its own folder` : `Review what ${s.row.name} would push`;
      b.addEventListener("click", () => this.act(s, action));
    } else {
      // Not `disabled`: a disabled button takes no hover, so its reason could
      // never be read. It says it is unavailable, and why.
      b.setAttribute("aria-disabled", "true");
      b.classList.add("is-disabled");
      b.dataset.tip = `${label.replace("…", "")} isn't available: ${gate.why}`;
    }
    b.setAttribute("aria-label", b.dataset.tip);
    if (s.busy) b.disabled = true;
    return b;
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

  private openMenu(s: RowState, anchor: HTMLElement): void {
    this.closeMenu();
    this.hideTip();
    const r = s.row;
    const caps = worktreeCaps(r);
    const menu = el("div", "wt-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", `Actions for ${r.name}`);
    const head = el("div", "wt-menu-head");
    // The row's own symbol: the menu is about the worktree, not its branch.
    head.append(codicon(r.kind === "bare" ? "repo" : "worktree"), el("span", undefined, r.name));
    menu.appendChild(head);
    const item = (action: WorktreeAction, icon: string, label: string, gate: Gate | boolean, danger = false): void => {
      const ok = gate === true || (typeof gate === "object" && gate.ok);
      if (gate === false) return;
      const b = el("button", `wt-menu-item${danger ? " danger" : ""}`);
      b.type = "button";
      b.setAttribute("role", "menuitem");
      b.dataset.action = action;
      const text = el("span", "wt-menu-text");
      text.appendChild(el("span", "wt-menu-label", label));
      if (!ok && typeof gate === "object" && !gate.ok) {
        text.appendChild(el("span", "wt-menu-why", gate.why));
        b.setAttribute("aria-disabled", "true");
        b.classList.add("is-disabled");
      }
      b.append(codicon(icon), text);
      b.addEventListener("click", () => {
        if (!ok) return;
        this.closeMenu();
        s.line.focus();
        this.act(s, action);
      });
      menu.appendChild(b);
    };
    const sep = (): void => {
      if (menu.lastElementChild && !menu.lastElementChild.classList.contains("wt-menu-sep") && menu.lastElementChild !== head) {
        menu.appendChild(el("div", "wt-menu-sep"));
      }
    };
    // A folder that is gone, or that isn't a worktree any more, has nothing
    // to open, pull or push: its menu is about git's record of it.
    const there = !r.missing && !r.unlinked;
    if (there && r.kind !== "bare") {
      item("openHere", "folder-opened", "Open in This Window", caps.openHere);
      item("openNew", "empty-window", "Open in New Window", caps.openNew);
    }
    item("reveal", "folder", this.labels.reveal, caps.reveal);
    item("terminal", "terminal", "Open in Terminal", caps.terminal);
    item("copyPath", "copy", "Copy Path", true);
    if (r.kind !== "bare" && there) {
      sep();
      item("pull", "repo-pull", "Pull", caps.pull);
      item("push", "repo-push", "Push…", caps.push);
    }
    // One of the two, as it stands: Unlock when it is locked, Lock… when not
    // — and when that one can't run (the main worktree, a missing folder),
    // it is there, disabled, saying why. A bare repository's entry is not a
    // working tree: none of its working-tree actions are listed.
    if (r.kind !== "bare") {
      sep();
      if (r.locked) item("unlock", "unlock", "Unlock", caps.unlock);
      else item("lock", "lock", "Lock…", caps.lock);
    }
    if (r.kind !== "bare") {
      sep();
      if (caps.forget) item("forget", "close", "Forget Worktree…", true, true);
      else item("remove", "trash", "Remove Worktree…", caps.remove, true);
    }
    document.body.appendChild(menu);
    this.menu = menu;
    this.menuFor = s;
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
    const first = menu.querySelector<HTMLElement>(".wt-menu-item:not(.is-disabled)") ?? menu.querySelector<HTMLElement>(".wt-menu-item");
    first?.focus();
  }

  private readonly onDocDown = (e: MouseEvent): void => {
    if (this.menu && !this.menu.contains(e.target as Node)) this.closeMenu();
  };

  private closeMenu(): void {
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

/** A stable key for a focusable node across a repaint of the details. */
function keyOf(n: HTMLElement): string {
  if (n.dataset.action) return `a:${n.dataset.action}`;
  const file = n.closest<HTMLElement>(".cr-file");
  const commit = n.closest<HTMLElement>(".cr-commit-item");
  if (file) return `f:${commit?.dataset.sha ?? ""}:${file.dataset.area ?? ""}:${file.dataset.path}`;
  if (commit) return `c:${commit.dataset.sha}`;
  return "";
}

/** What an empty "not pushed" section says, by its rule. */
function unpublishedEmpty(r: WorktreeRow): string {
  const title = unpublishedTitle(r);
  if (r.branch && r.upstream && !r.upstreamGone) return `Everything is on ${r.upstream}.`;
  if (r.hasRemotes) return "Every commit is on a remote.";
  return title ? `Every commit is on ${r.defaultBranch}.` : "";
}
