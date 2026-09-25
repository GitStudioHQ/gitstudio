// The repository tab row (issue #32) — one tab per open repository, across
// the top of the window, the place Fork and GitKraken put theirs. On macOS it
// is the title bar: the traffic lights sit at its left and its empty space
// drags the window.
//
// This module is the ROW only: it draws what it is told and reports what was
// asked of it. Which tab is open, what a switch preserves and what an answer
// arriving for a background tab does are the shell's (renderer.ts) and the
// bridge's (bridge.ts); the rules are tabModel.ts; the design is
// docs/desktop-repo-tabs.md.
//
// Words and existing codicons only: `close` to close (named in its tooltip),
// `add` to open another, `loading` spinning while an operation runs, and the
// `●N` change mark Home and Repositories already wear.

import { el, glyph, span } from "./ui";
import { changeMark, tabLabel } from "./tabModel";

export interface TabStripItem {
  root: string;
  name: string;
  /** Changed files in its working tree, when known. */
  dirty?: number;
  /** The operation running in it, in words ("a push"), when one is. */
  running?: string;
}

export interface TabStripHandlers {
  activate(root: string): void;
  close(root: string): void;
  /** The `+`: open a repository in a new tab (the anchor is for its menu). */
  add(anchor: HTMLElement): void;
  /** Dragged to a new place in the row. */
  move?(root: string, index: number): void;
  /** Right-click: the tab's own menu. */
  menu?(root: string, anchor: HTMLElement): void;
}

const MOD = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl+";

export class RepoTabStrip {
  readonly el: HTMLElement;
  private readonly scroller: HTMLElement;
  private readonly addBtn: HTMLButtonElement;
  private readonly addLabel: HTMLElement;
  private readonly byRoot = new Map<string, HTMLElement>();
  private items: TabStripItem[] = [];
  private active: string | undefined;
  private dragRoot: string | undefined;
  private tabSeq = 0;
  /** The id of the panel the tabs control — the stage the tab in front is shown on. */
  static readonly PANEL_ID = "repo-tab-panel";

  constructor(private readonly on: TabStripHandlers) {
    this.el = el("div", "repo-tabs");
    this.el.setAttribute("role", "navigation");
    this.el.setAttribute("aria-label", "Open repositories");
    this.scroller = el("div", "repo-tabs-scroller");
    this.scroller.setAttribute("role", "tablist");
    this.scroller.setAttribute("aria-label", "Repositories");
    this.scroller.setAttribute("aria-orientation", "horizontal");
    // A mouse wheel scrolls the row sideways — it has no other direction.
    this.scroller.addEventListener(
      "wheel",
      (e) => {
        if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
        if (this.scroller.scrollWidth <= this.scroller.clientWidth) return;
        this.scroller.scrollLeft += e.deltaY;
        e.preventDefault();
      },
      { passive: false },
    );
    this.scroller.addEventListener("keydown", (e) => this.onKey(e));

    this.addBtn = el("button", "repo-tabs-add") as HTMLButtonElement;
    this.addBtn.type = "button";
    this.addLabel = span("Open a repository", "repo-tabs-add-label");
    this.addBtn.append(glyph("add"), this.addLabel);
    this.addBtn.title = `Open a repository in a new tab  (${MOD}O)`;
    this.addBtn.setAttribute("aria-label", "Open a repository in a new tab");
    this.addBtn.addEventListener("click", () => this.on.add(this.addBtn));

    // What is left of the row is the window's title bar: it drags the window.
    const grip = el("div", "repo-tabs-drag");
    grip.setAttribute("aria-hidden", "true");
    this.el.append(this.scroller, this.addBtn, grip);
  }

  /** Draw the row. Tabs are kept by root and moved, never rebuilt, so a
   *  focused tab keeps the keyboard through a repaint. */
  render(items: TabStripItem[], active: string | undefined): void {
    this.items = items;
    const activeChanged = active !== this.active;
    this.active = active;
    const seen = new Set<string>();
    items.forEach((it, i) => {
      seen.add(it.root);
      let tab = this.byRoot.get(it.root);
      if (!tab) {
        tab = this.buildTab(it.root);
        this.byRoot.set(it.root, tab);
      }
      this.paintTab(tab, it, i);
      // Keep DOM order = row order without re-inserting nodes that are
      // already in place (moving the focused node would drop its focus).
      if (this.scroller.children[i] !== tab) this.scroller.insertBefore(tab, this.scroller.children[i] ?? null);
    });
    for (const [root, tab] of this.byRoot) {
      if (seen.has(root)) continue;
      tab.remove();
      this.byRoot.delete(root);
    }
    // With nothing open the + says what it does in words, not just a glyph.
    this.el.classList.toggle("is-empty", items.length === 0);
    this.addLabel.hidden = items.length > 0;
    if (activeChanged) this.revealActive();
  }

  /** Keep the tab in front on screen when the row scrolls. */
  revealActive(): void {
    const tab = this.active ? this.byRoot.get(this.active) : undefined;
    if (!tab) return;
    const s = this.scroller;
    const left = tab.offsetLeft - s.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < s.scrollLeft) s.scrollLeft = left;
    else if (right > s.scrollLeft + s.clientWidth) s.scrollLeft = right - s.clientWidth;
  }

  /** The tab element for a root — the checks and the context menu anchor. */
  tabFor(root: string): HTMLElement | undefined {
    return this.byRoot.get(root);
  }

  private buildTab(root: string): HTMLElement {
    const tab = el("div", "repo-tab");
    tab.setAttribute("role", "tab");
    tab.dataset.root = root;
    tab.id = `repo-tab-${++this.tabSeq}`;
    tab.setAttribute("aria-controls", RepoTabStrip.PANEL_ID);
    tab.draggable = true;
    const spin = glyph("loading");
    spin.classList.add("spin", "repo-tab-busy");
    const name = span("", "repo-tab-name");
    // Its own class, not repo-state-bit: the rows that wear that cluster are
    // counted by it, and a tab is not a row.
    const mark = span("", "repo-tab-mark");
    const close = el("button", "repo-tab-close") as HTMLButtonElement;
    close.type = "button";
    close.tabIndex = -1; // one tab stop per tab; Delete is not a shortcut we teach
    close.append(glyph("close"));
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      this.on.close(root);
    });
    // A close is not an activation: the press must not reach the tab.
    close.addEventListener("mousedown", (e) => e.stopPropagation());
    tab.append(spin, name, mark, close);

    tab.addEventListener("click", (e) => {
      if (e.button !== 0) return;
      this.on.activate(root);
    });
    // Middle-click closes — the browser's gesture, and VS Code's.
    tab.addEventListener("auxclick", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      this.on.close(root);
    });
    tab.addEventListener("mousedown", (e) => {
      if (e.button === 1) e.preventDefault(); // no autoscroll cursor
    });
    tab.addEventListener("contextmenu", (e) => {
      if (!this.on.menu) return;
      e.preventDefault();
      this.on.menu(root, tab);
    });

    // Drag to reorder. The drop lands BEFORE or AFTER the tab under the
    // pointer by its midpoint, and the line that shows where is the tab's own
    // edge in the accent colour.
    tab.addEventListener("dragstart", (e) => {
      this.dragRoot = root;
      tab.classList.add("is-dragging");
      e.dataTransfer?.setData("text/plain", root);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
    });
    tab.addEventListener("dragend", () => {
      this.dragRoot = undefined;
      tab.classList.remove("is-dragging");
      this.clearDropMarks();
    });
    tab.addEventListener("dragover", (e) => {
      if (!this.dragRoot || this.dragRoot === root) return;
      e.preventDefault();
      const r = tab.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      this.clearDropMarks();
      tab.classList.add(after ? "drop-after" : "drop-before");
    });
    tab.addEventListener("dragleave", () => tab.classList.remove("drop-before", "drop-after"));
    tab.addEventListener("drop", (e) => {
      const from = this.dragRoot;
      if (!from || from === root) return;
      e.preventDefault();
      const r = tab.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      const order = this.items.map((i) => i.root).filter((x) => x !== from);
      const at = order.indexOf(root) + (after ? 1 : 0);
      this.clearDropMarks();
      this.on.move?.(from, at);
    });
    return tab;
  }

  private clearDropMarks(): void {
    for (const t of this.byRoot.values()) t.classList.remove("drop-before", "drop-after");
  }

  private paintTab(tab: HTMLElement, it: TabStripItem, index: number): void {
    const isActive = it.root === this.active;
    tab.classList.toggle("is-active", isActive);
    tab.classList.toggle("is-busy", !!it.running);
    tab.setAttribute("aria-selected", isActive ? "true" : "false");
    // Roving tab stop: the tab in front is the one Tab reaches.
    tab.tabIndex = isActive ? 0 : -1;
    const words = tabLabel(it.name, it.dirty, it.running);
    tab.setAttribute("aria-label", words);
    // The path (two clones can share a folder name), what is running, and the
    // key that brings it to the front.
    const n = index < 8 ? index + 1 : index === this.items.length - 1 ? 9 : 0;
    const key = n ? `${MOD === "⌘" ? "⌃" : "Alt+"}${n}` : "";
    tab.title = [it.root, it.running ? `${cap(it.running)} is running` : "", key ? `Switch to it: ${key}` : ""]
      .filter(Boolean)
      .join("\n");
    const name = tab.querySelector<HTMLElement>(".repo-tab-name");
    if (name && name.textContent !== it.name) name.textContent = it.name;
    const mark = tab.querySelector<HTMLElement>(".repo-tab-mark");
    if (mark) {
      const m = changeMark(it.dirty);
      if (mark.textContent !== m) mark.textContent = m;
      mark.hidden = !m;
      mark.title = m ? `${it.dirty} changed ${it.dirty === 1 ? "file" : "files"} in the working tree` : "";
    }
    const close = tab.querySelector<HTMLButtonElement>(".repo-tab-close");
    if (close) {
      const what = `Close ${it.name}`;
      close.title = isActive ? `${what}  (${MOD}W)` : what;
      close.setAttribute("aria-label", what);
    }
  }

  /** ←/→/Home/End move between tabs; Enter or Space brings one to the front. */
  private onKey(e: KeyboardEvent): void {
    const tabs = [...this.scroller.querySelectorAll<HTMLElement>(".repo-tab")];
    const i = tabs.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") next = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = tabs.length - 1;
    else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      const root = tabs[i].dataset.root;
      if (root) this.on.activate(root);
      return;
    }
    if (next < 0) return;
    e.preventDefault();
    for (const t of tabs) t.tabIndex = -1;
    tabs[next].tabIndex = 0;
    tabs[next].focus();
    tabs[next].scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function cap(s: string): string {
  const t = s.replace(/^(a|an) /, "");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
