// The integrated terminal panel that lives in the permanent bottom dock. It owns
// a tab strip with:
//   • a pinned "Output" tab — the live git-command log (never closeable), and
//   • any number of terminal tabs — each its own xterm + PTY session.
//
// Tabs are remembered for the whole repo session: collapsing the dock or routing
// to another view keeps every PTY alive (the surfaces are hidden, not disposed),
// so you return to exactly the shells you left. They are only torn down when the
// user closes a tab, switches repo, or quits the app.
//
// A terminal's PTY is opened lazily — only when its tab first becomes visible —
// so a session that never opens the panel never spawns a shell.

import { BottomDock } from "./bottomDock";
import { TerminalPanel } from "./terminalPanel";
import { OutputsPanel } from "./outputsPanel";
import { el, span, glyph } from "./ui";

interface TermTab {
  kind: "term";
  id: string;
  label: string;
  surface: HTMLElement;
  panel: TerminalPanel;
  /** True once the PTY has been opened (lazy). */
  opened: boolean;
}

interface OutTab {
  kind: "out";
  id: "output";
  label: string;
  surface: HTMLElement;
  panel: OutputsPanel;
}

type Tab = TermTab | OutTab;

export interface TerminalDockOptions {
  /** Start expanded vs collapsed-to-footer. */
  expanded: boolean;
  /** Body height in px when expanded. */
  height: number;
  /** Persist the dock's expanded + height state. */
  onStateChange: (s: { expanded: boolean; height: number }) => void;
}

export class TerminalDock {
  private readonly dock: BottomDock;
  private readonly outputs: OutputsPanel;
  private readonly tabStrip: HTMLElement;
  private tabs: Tab[] = [];
  private activeId = "output";
  private termSeq = 0;

  constructor(host: HTMLElement, private readonly opts: TerminalDockOptions) {
    this.dock = new BottomDock(host, {
      collapsed: !opts.expanded,
      height: opts.height,
      minHeight: 120,
      label: "Terminal panel",
      onResize: () => this.layoutActive(),
      onToggle: (collapsed) => {
        if (!collapsed) this.revealActive();
        this.persist();
      },
      onHeightChange: () => this.persist(),
    });

    // The tab strip fills the dock header's left region.
    this.tabStrip = el("div", "term-tabs");
    this.dock.tabsEl.appendChild(this.tabStrip);

    // "New terminal" action button (right side of the header).
    const addBtn = el("button", "dock-icon-btn");
    addBtn.title = "New terminal";
    addBtn.setAttribute("aria-label", "New terminal");
    addBtn.append(glyph("add"));
    addBtn.addEventListener("click", () => this.newTerminal());
    this.dock.actionsEl.appendChild(addBtn);

    // The pinned Output tab — subscribes to git:log immediately so it captures
    // commands even while the dock stays collapsed.
    this.outputs = new OutputsPanel();
    this.tabs.push({
      kind: "out",
      id: "output",
      label: "Output",
      surface: this.outputs.el,
      panel: this.outputs,
    });
    this.dock.bodyEl.appendChild(this.outputs.el);

    // One terminal to start, made active so expanding lands on a shell.
    const first = this.createTerminal();
    this.activeId = first.id;

    this.renderTabs();
    this.showActive();
  }

  // ── Tab model ──────────────────────────────────────────────────────────────

  /** Build a terminal tab (surface + panel), append its surface, return it. */
  private createTerminal(): TermTab {
    const n = ++this.termSeq;
    const surface = el("div", "term-surface");
    surface.style.display = "none";
    const tab: TermTab = {
      kind: "term",
      id: `term-${n}`,
      label: `Terminal ${n}`,
      surface,
      panel: new TerminalPanel(surface),
      opened: false,
    };
    this.tabs.push(tab);
    this.dock.bodyEl.appendChild(surface);
    return tab;
  }

  /** Public: add a terminal tab, focus it, and expand the dock. */
  newTerminal(): void {
    const tab = this.createTerminal();
    this.renderTabs();
    this.setActive(tab.id);
    this.expand();
  }

  private closeTerminal(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    if (tab.kind !== "term") return;
    tab.panel.dispose();
    tab.surface.remove();
    this.tabs.splice(idx, 1);

    if (this.activeId === id) {
      // Activate the tab that slid into this slot (or the one before it) — the
      // Output tab at index 0 is the ultimate fallback, so there's always one.
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)] ?? this.tabs[0];
      this.activeId = next ? next.id : "output";
      this.showActive();
    }
    this.renderTabs();
  }

  private setActive(id: string): void {
    if (this.activeId === id) return;
    this.activeId = id;
    this.renderTabs();
    this.showActive();
  }

  // ── Rendering ───────────────────────────────────────────────────────────────

  private renderTabs(): void {
    this.tabStrip.replaceChildren();
    this.tabStrip.setAttribute("role", "tablist");
    this.tabStrip.setAttribute("aria-label", "Terminal tabs");
    for (const t of this.tabs) {
      const btn = el(
        "button",
        "term-tab" + (t.id === this.activeId ? " active" : "") + (t.kind === "out" ? " is-output" : ""),
      );
      btn.append(glyph(t.kind === "out" ? "output" : "terminal"), span(t.label, "term-tab-label"));
      btn.title = t.label;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-label", t.label);
      btn.setAttribute("aria-selected", t.id === this.activeId ? "true" : "false");
      // Roving tabindex: only the active tab is in the Tab order; arrows move within.
      btn.tabIndex = t.id === this.activeId ? 0 : -1;
      btn.addEventListener("click", () => {
        this.setActive(t.id);
        this.expand();
      });
      btn.addEventListener("keydown", (e) => this.onTabKey(e, t.id));
      if (t.kind === "term") {
        const close = el("span", "term-tab-close");
        close.append(glyph("close"));
        close.title = "Close terminal";
        close.setAttribute("role", "button");
        close.setAttribute("aria-label", `Close ${t.label}`);
        close.tabIndex = -1;
        const doClose = (e: Event): void => {
          e.stopPropagation();
          this.closeTerminal(t.id);
        };
        close.addEventListener("click", doClose);
        close.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") doClose(e);
        });
        btn.appendChild(close);
      }
      this.tabStrip.appendChild(btn);
    }
  }

  /** Arrow-key navigation across the terminal tab strip (roving focus). */
  private onTabKey(e: KeyboardEvent, id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id);
    if (idx < 0) return;
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % this.tabs.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + this.tabs.length) % this.tabs.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = this.tabs.length - 1;
    else if ((e.key === "Delete" || e.key === "Backspace") && this.tabs[idx]?.kind === "term") {
      e.preventDefault();
      this.closeTerminal(id);
      // closeTerminal re-renders the strip (destroying the focused button), so
      // move focus to whatever tab now sits where the closed one was.
      const fallback = Math.min(idx, this.tabs.length - 1);
      (this.tabStrip.children[fallback] as HTMLElement | undefined)?.focus();
      return;
    } else return;
    e.preventDefault();
    const target = this.tabs[next];
    if (!target) return;
    this.setActive(target.id);
    this.expand();
    (this.tabStrip.children[next] as HTMLElement | undefined)?.focus();
  }

  /** Show only the active tab's surface. While the dock is expanded, lazily open
   *  the active terminal's PTY (so switching to a never-opened tab spawns it). */
  private showActive(): void {
    for (const t of this.tabs) {
      t.surface.style.display = t.id === this.activeId ? "" : "none";
    }
    if (this.dock.isCollapsed()) {
      this.layoutActive();
    } else {
      this.revealActive();
    }
  }

  /** Open the active terminal's PTY (lazily) and re-fit it once laid out. */
  private revealActive(): void {
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (tab && tab.kind === "term") this.openTerm(tab);
    // Defer the fit until the body has its expanded height.
    requestAnimationFrame(() => this.layoutActive());
  }

  private openTerm(tab: TermTab): void {
    if (tab.opened) {
      tab.panel.focus();
      return;
    }
    tab.opened = true;
    void tab.panel.open().then(() => {
      tab.panel.layout();
      tab.panel.focus();
    });
  }

  private layoutActive(): void {
    if (this.dock.isCollapsed()) return;
    const tab = this.tabs.find((t) => t.id === this.activeId);
    if (tab && tab.kind === "term" && tab.opened) tab.panel.layout();
  }

  private persist(): void {
    this.opts.onStateChange({ expanded: !this.dock.isCollapsed(), height: this.dock.height });
  }

  // ── Public controls (driven by the nav button / shortcut / host) ────────────

  /** Expand ⇄ collapse the dock (used by the Terminal nav button + Cmd/Ctrl+`). */
  toggle(): void {
    this.dock.toggle();
  }

  expand(): void {
    if (this.dock.isCollapsed()) this.dock.toggle();
  }

  collapse(): void {
    if (!this.dock.isCollapsed()) this.dock.toggle();
  }

  isExpanded(): boolean {
    return !this.dock.isCollapsed();
  }

  /** Re-fit the active terminal (after a sibling layout change, e.g. rail collapse). */
  layout(): void {
    this.layoutActive();
  }

  /** Re-read the CSS-token theme for every terminal (on light/dark flips). */
  applyTheme(): void {
    for (const t of this.tabs) {
      if (t.kind === "term") t.panel.applyTheme();
    }
  }

  dispose(): void {
    for (const t of this.tabs) t.panel.dispose();
    this.tabs = [];
    this.dock.dispose();
  }
}
