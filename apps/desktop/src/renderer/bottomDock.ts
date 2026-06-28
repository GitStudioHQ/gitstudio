// A reusable collapsible bottom panel that splits its host into two horizontal
// parts. A tiny, status-bar-like footer is pinned permanently to the very bottom;
// the body pops UP above it when expanded (and the host's existing content fills
// whatever's left above). Collapsed, only the footer remains — so the panel can
// always be re-opened, VS-Code-panel style.
//
// The terminal dock is the first consumer, but the component is deliberately
// content-agnostic: a caller fills `tabsEl` (the footer's left side) + `actionsEl`
// (the footer's right side, before the chevron) and mounts whatever it likes into
// `bodyEl`. Any screen that wants a draggable, collapsible bottom split can reuse
// it.
//
// Layout contract: the host must be a `display:flex; flex-direction:column`
// container whose other child(ren) carry `flex: 1` and `min-height: 0`. The dock
// itself is `flex: 0 0 auto`, so it sizes to its content (just the footer when
// collapsed; resizer + body + footer when expanded).

import { el, glyph, wireResizerKeys } from "./ui";

export interface BottomDockOptions {
  /** Start collapsed (just the footer bar) vs expanded (footer + body). */
  collapsed: boolean;
  /** Body height in px when expanded. */
  height: number;
  /** Minimum body height while dragging (px). Defaults to 120. */
  minHeight?: number;
  /** Fires continuously while the body resizes and on collapse/expand, so the
   *  consumer can relayout its content (e.g. re-fit an xterm). */
  onResize?: () => void;
  /** Fires when the user toggles collapse — persist the new state. */
  onToggle?: (collapsed: boolean) => void;
  /** Fires when a drag-resize settles — persist the new height. */
  onHeightChange?: (height: number) => void;
  /** Accessible label for the panel region. */
  label?: string;
}

export class BottomDock {
  /** The whole dock (resizer + popped-up body + footer) — appended to the host. */
  readonly root: HTMLElement;
  /** Footer's left region — the consumer fills this (e.g. with tabs). */
  readonly tabsEl: HTMLElement;
  /** Footer's right region (before the chevron) — consumer action buttons. */
  readonly actionsEl: HTMLElement;
  /** The panel body — hidden when collapsed. Consumer mounts content here. */
  readonly bodyEl: HTMLElement;

  private readonly panel: HTMLElement;
  private readonly resizer: HTMLElement;
  private readonly chevron: HTMLElement;
  private readonly opts: BottomDockOptions;
  private collapsed: boolean;
  private heightPx: number;

  constructor(host: HTMLElement, opts: BottomDockOptions) {
    this.opts = opts;
    this.collapsed = opts.collapsed;
    this.heightPx = Math.max(opts.minHeight ?? 120, opts.height);

    // The body pops UP above a permanently-pinned footer bar, so the resizer
    // (drag the body's top edge) and the body sit ABOVE the footer; the footer
    // bar is the bottom-most, always-visible element — like a status bar.
    this.resizer = el("div", "dock-resizer");
    this.resizer.append(el("div", "dock-resizer-grip"));
    this.resizer.addEventListener("pointerdown", (e) => this.startResize(e));
    wireResizerKeys(this.resizer, {
      orientation: "horizontal",
      label: opts.label ? `Resize ${opts.label}` : "Resize panel",
      min: opts.minHeight ?? 120,
      max: () => Math.max(opts.minHeight ?? 120, window.innerHeight - 220),
      get: () => this.heightPx,
      set: (h) => {
        this.heightPx = h;
        this.bodyEl.style.height = `${h}px`;
        this.opts.onResize?.();
      },
      onCommit: () => this.opts.onHeightChange?.(this.heightPx),
      disabled: () => this.collapsed,
    });

    this.bodyEl = el("div", "dock-body");
    this.bodyEl.style.height = `${this.heightPx}px`;

    // ── The footer bar (always visible): tabs · actions · collapse chevron. ──
    const footer = el("div", "dock-footer");
    if (opts.label) footer.setAttribute("aria-label", opts.label);
    this.tabsEl = el("div", "dock-tabs");
    this.actionsEl = el("div", "dock-actions");
    this.chevron = el("button", "dock-chevron");
    this.chevron.setAttribute("aria-label", "Toggle panel");
    this.syncChevron();
    this.chevron.addEventListener("click", () => this.toggle());
    footer.append(this.tabsEl, el("div", "dock-spacer"), this.actionsEl, this.chevron);
    // Clicking empty footer space expands a collapsed dock (collapse is the
    // chevron's job — so a stray click on the bar never hides your terminal).
    footer.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement;
      if (this.collapsed && !target.closest("button, .term-tab")) this.toggle();
    });

    this.panel = el("div", "bottom-dock");
    this.panel.append(this.bodyEl, footer);

    this.root = el("div", "dock-mount" + (this.collapsed ? " collapsed" : ""));
    this.root.append(this.resizer, this.panel);
    host.appendChild(this.root);
  }

  /** Collapse to just the footer bar, or expand back to footer + body. */
  toggle(): void {
    this.setCollapsed(!this.collapsed);
    this.opts.onToggle?.(this.collapsed);
  }

  setCollapsed(collapsed: boolean): void {
    if (this.collapsed === collapsed) return;
    this.collapsed = collapsed;
    this.root.classList.toggle("collapsed", collapsed);
    this.syncChevron();
    this.opts.onResize?.();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  get height(): number {
    return this.heightPx;
  }

  /** Point the chevron the right way (up = expand, down = collapse). */
  private syncChevron(): void {
    this.chevron.replaceChildren(glyph(this.collapsed ? "chevron-up" : "chevron-down"));
    this.chevron.title = this.collapsed ? "Expand panel" : "Collapse panel";
  }

  /** Drag the top edge to resize the body height (clamped), then relayout. */
  private startResize(e: PointerEvent): void {
    if (this.collapsed) return;
    e.preventDefault();
    document.body.classList.add("resizing-v");
    const startY = e.clientY;
    const startH = this.heightPx;
    const min = this.opts.minHeight ?? 120;
    const max = Math.max(min, window.innerHeight - 220);
    const move = (ev: PointerEvent): void => {
      const h = Math.max(min, Math.min(max, startH + (startY - ev.clientY)));
      this.heightPx = h;
      this.bodyEl.style.height = `${h}px`;
      this.opts.onResize?.();
    };
    const up = (): void => {
      document.body.classList.remove("resizing-v");
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      this.opts.onResize?.();
      this.opts.onHeightChange?.(this.heightPx);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  dispose(): void {
    this.root.remove();
  }
}
