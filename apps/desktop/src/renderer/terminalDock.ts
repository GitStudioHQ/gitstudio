// The bottom dock's content: three top-level tabs in the bar — "Commit details"
// (only on the commits view), "Output" (the live git-command log), and a single
// "Terminal" view. The Terminal is ONE tab (VS-Code style): its multiple shells
// are managed by a side list (right of the terminal) with a "New terminal" button
// and a per-terminal kill button — not by extra top tabs.
//
// Sessions persist for the whole repo session: collapsing the dock or switching
// the top tab keeps every PTY alive (surfaces are hidden, not disposed). A PTY is
// opened lazily — only when its terminal first becomes visible.

import { BottomDock } from "./bottomDock";
import { TerminalPanel } from "./terminalPanel";
import { OutputsPanel } from "./outputsPanel";
import { el, span, glyph } from "./ui";

interface TermSession {
  id: string;
  label: string;
  surface: HTMLElement;
  panel: TerminalPanel;
  /** True once the PTY has been opened (lazy). */
  opened: boolean;
}

type TopTab = "commit-details" | "output" | "terminal";

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

  /** The active TOP tab. */
  private active: TopTab = "terminal";

  // Commit-details (added only on the commits view; surface owned by renderer).
  private detailsVisible = false;
  private detailsEl?: HTMLElement;

  // The single Terminal view: a stage (the shell surfaces) + a side tab list.
  private readonly termGroup: HTMLElement;
  private readonly termStage: HTMLElement;
  private readonly termEmpty: HTMLElement;
  private readonly termSide: HTMLElement;
  private terminals: TermSession[] = [];
  private activeTermId = "";
  private termSeq = 0;

  constructor(host: HTMLElement, private readonly opts: TerminalDockOptions) {
    this.dock = new BottomDock(host, {
      collapsed: !opts.expanded,
      height: opts.height,
      minHeight: 120,
      label: "Panel",
      onResize: () => this.layoutActive(),
      onToggle: (collapsed) => {
        if (!collapsed) this.revealActive();
        this.persist();
      },
      onHeightChange: () => this.persist(),
    });

    // Top tab strip (Commit details · Output · Terminal).
    this.tabStrip = el("div", "term-tabs");
    this.dock.tabsEl.appendChild(this.tabStrip);

    // ── Output surface (subscribes to git:log immediately, even while collapsed). ──
    this.outputs = new OutputsPanel();
    this.outputs.el.style.display = "none";
    this.dock.bodyEl.appendChild(this.outputs.el);

    // ── Terminal group: stage (surfaces) + side list. ──
    this.termGroup = el("div", "term-group");
    this.termStage = el("div", "term-stage");
    this.termEmpty = el("div", "term-empty");
    this.termEmpty.append(glyph("terminal"), span("No terminals — start one from the list.", "term-empty-text"));
    this.termSide = el("div", "term-side");
    this.termStage.appendChild(this.termEmpty);
    this.termGroup.append(this.termStage, this.termSide);
    this.termGroup.style.display = "none";
    this.dock.bodyEl.appendChild(this.termGroup);

    // One terminal to start, made active so opening the Terminal lands on a shell.
    const first = this.createTerminal();
    this.activeTermId = first.id;

    this.renderTabs();
    this.renderSide();
    this.showActive();
  }

  // ── Terminal sessions ───────────────────────────────────────────────────────

  /** Build a terminal session (surface + panel) into the stage; return it. */
  private createTerminal(): TermSession {
    const n = ++this.termSeq;
    const surface = el("div", "term-surface");
    surface.style.display = "none";
    const t: TermSession = {
      id: `term-${n}`,
      label: `Terminal ${n}`,
      surface,
      panel: new TerminalPanel(surface),
      opened: false,
    };
    this.terminals.push(t);
    this.termStage.appendChild(surface);
    return t;
  }

  /** Public: add a terminal, focus it, switch to the Terminal tab + expand. */
  newTerminal(): void {
    const t = this.createTerminal();
    this.activeTermId = t.id;
    this.active = "terminal";
    this.expand();
    this.renderTabs();
    this.renderSide();
    this.showActive();
  }

  private closeTerminal(id: string): void {
    const idx = this.terminals.findIndex((t) => t.id === id);
    if (idx < 0) return;
    this.terminals[idx].panel.dispose();
    this.terminals[idx].surface.remove();
    this.terminals.splice(idx, 1);
    if (this.activeTermId === id) {
      const next = this.terminals[Math.min(idx, this.terminals.length - 1)];
      this.activeTermId = next ? next.id : "";
    }
    this.renderSide();
    this.showActive();
  }

  private setActiveTerm(id: string): void {
    this.activeTermId = id;
    this.expand();
    this.renderSide();
    this.showActive();
  }

  // ── Top tabs ────────────────────────────────────────────────────────────────

  private topTabs(): { id: TopTab; label: string; icon: string }[] {
    const tabs: { id: TopTab; label: string; icon: string }[] = [];
    if (this.detailsVisible) tabs.push({ id: "commit-details", label: "Commit details", icon: "git-commit" });
    tabs.push({ id: "output", label: "Output", icon: "output" });
    tabs.push({ id: "terminal", label: "Terminal", icon: "terminal" });
    return tabs;
  }

  private setActiveTab(id: TopTab): void {
    this.active = id;
    this.expand();
    this.renderTabs();
    this.showActive();
  }

  private renderTabs(): void {
    this.tabStrip.replaceChildren();
    this.tabStrip.setAttribute("role", "tablist");
    this.tabStrip.setAttribute("aria-label", "Panel tabs");
    for (const t of this.topTabs()) {
      const sel = t.id === this.active;
      const btn = el("button", "term-tab" + (sel ? " active" : "") + (t.id === "output" ? " is-output" : ""));
      btn.append(glyph(t.icon), span(t.label, "term-tab-label"));
      btn.title = t.label;
      btn.setAttribute("role", "tab");
      btn.setAttribute("aria-label", t.label);
      btn.setAttribute("aria-selected", sel ? "true" : "false");
      btn.tabIndex = sel ? 0 : -1;
      btn.addEventListener("click", () => this.setActiveTab(t.id));
      btn.addEventListener("keydown", (e) => this.onTabKey(e, t.id));
      this.tabStrip.appendChild(btn);
    }
  }

  /** Left/right roving navigation across the top tabs. */
  private onTabKey(e: KeyboardEvent, id: TopTab): void {
    const order = this.topTabs().map((t) => t.id);
    const idx = order.indexOf(id);
    let next = -1;
    if (e.key === "ArrowRight") next = (idx + 1) % order.length;
    else if (e.key === "ArrowLeft") next = (idx - 1 + order.length) % order.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = order.length - 1;
    else return;
    e.preventDefault();
    this.setActiveTab(order[next]);
    (this.tabStrip.children[next] as HTMLElement | undefined)?.focus();
  }

  // ── Terminal side list (VS-Code-style tabs on the right) ─────────────────────

  private renderSide(): void {
    this.termSide.replaceChildren();
    const addBtn = el("button", "term-side-add");
    addBtn.append(glyph("add"), span("New terminal"));
    addBtn.title = "New terminal";
    addBtn.setAttribute("aria-label", "New terminal");
    addBtn.addEventListener("click", () => this.newTerminal());
    this.termSide.appendChild(addBtn);

    const list = el("div", "term-side-list");
    list.setAttribute("role", "tablist");
    list.setAttribute("aria-orientation", "vertical");
    list.setAttribute("aria-label", "Terminals");
    for (const t of this.terminals) {
      const sel = t.id === this.activeTermId;
      const row = el("button", "term-side-row" + (sel ? " active" : ""));
      row.setAttribute("role", "tab");
      row.setAttribute("aria-selected", sel ? "true" : "false");
      row.append(glyph("terminal"), span(t.label, "term-side-label"));
      row.title = t.label;
      row.addEventListener("click", () => this.setActiveTerm(t.id));
      const kill = el("span", "term-side-close");
      kill.append(glyph("trash"));
      kill.title = `Kill ${t.label}`;
      kill.setAttribute("role", "button");
      kill.setAttribute("aria-label", `Kill ${t.label}`);
      kill.tabIndex = -1;
      const doKill = (e: Event): void => {
        e.stopPropagation();
        this.closeTerminal(t.id);
      };
      kill.addEventListener("click", doKill);
      kill.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") doKill(e);
      });
      row.appendChild(kill);
      list.appendChild(row);
    }
    this.termSide.appendChild(list);
  }

  // ── Visibility / layout ──────────────────────────────────────────────────────

  /** Show the active top surface; within the Terminal, the active shell. */
  private showActive(): void {
    this.outputs.el.style.display = this.active === "output" ? "" : "none";
    if (this.detailsEl) this.detailsEl.style.display = this.active === "commit-details" ? "" : "none";
    this.termGroup.style.display = this.active === "terminal" ? "" : "none";

    for (const t of this.terminals) {
      t.surface.style.display = t.id === this.activeTermId ? "" : "none";
    }
    this.termEmpty.style.display = this.terminals.length === 0 ? "" : "none";

    if (this.dock.isCollapsed()) this.layoutActive();
    else this.revealActive();
  }

  /** Open the active shell's PTY (lazily) and re-fit it once laid out. */
  private revealActive(): void {
    if (this.active === "terminal") {
      const t = this.terminals.find((x) => x.id === this.activeTermId);
      if (t) this.openTerm(t);
    }
    requestAnimationFrame(() => this.layoutActive());
  }

  private openTerm(t: TermSession): void {
    if (t.opened) {
      t.panel.focus();
      return;
    }
    t.opened = true;
    void t.panel.open().then(() => {
      t.panel.layout();
      t.panel.focus();
    });
  }

  private layoutActive(): void {
    if (this.dock.isCollapsed() || this.active !== "terminal") return;
    const t = this.terminals.find((x) => x.id === this.activeTermId);
    if (t && t.opened) t.panel.layout();
    // The commit-details diff (DiffView) relayouts via its own ResizeObserver.
  }

  // ── Commit-details tab (present only on the commits/graph view) ──────────────

  setDetailsVisible(visible: boolean): void {
    if (visible) {
      if (this.detailsVisible) return;
      this.detailsVisible = true;
      this.detailsEl = el("div", "dock-details-surface");
      this.detailsEl.style.display = "none";
      this.dock.bodyEl.appendChild(this.detailsEl);
      this.renderTabs();
      return;
    }
    if (!this.detailsVisible) return;
    this.detailsVisible = false;
    this.detailsEl?.remove();
    this.detailsEl = undefined;
    if (this.active === "commit-details") {
      this.active = "terminal";
      this.showActive();
    }
    this.renderTabs();
  }

  /** The element the renderer renders commit details into (when the tab exists). */
  detailsSurface(): HTMLElement | undefined {
    return this.detailsEl;
  }

  /** Activate the commit-details tab and expand the dock (on commit click). */
  openDetails(): void {
    if (!this.detailsVisible) return;
    this.setActiveTab("commit-details");
  }

  private persist(): void {
    this.opts.onStateChange({ expanded: !this.dock.isCollapsed(), height: this.dock.height });
  }

  // ── Public controls (driven by the nav button / shortcut / host) ────────────

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
    for (const t of this.terminals) t.panel.applyTheme();
  }

  dispose(): void {
    for (const t of this.terminals) t.panel.dispose();
    this.terminals = [];
    this.outputs.dispose();
    this.dock.dispose();
  }
}
