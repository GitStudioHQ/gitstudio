// A reusable collapsible bottom panel, VS-Code-panel style. Collapsed, only a
// tiny status-bar-like tab BAR sits at the very bottom. Expanded, the whole panel
// floats UP and ON TOP of the view content (never reflowing it): the bar rises to
// sit above the body (tabs-on-top), and the body fills beneath it down to the
// window bottom. Closing drops the bar back down to the base.
//
// The terminal dock is the first consumer, but the component is deliberately
// content-agnostic: a caller fills `tabsEl` (the footer's left side) + `actionsEl`
// (the footer's right side, before the chevron) and mounts whatever it likes into
// `bodyEl`. Any screen that wants a draggable, collapsible bottom split can reuse
// it.
//
// Layout contract: the host must be a `display:flex; flex-direction:column`
// container whose other child(ren) carry `flex: 1` and `min-height: 0`. Only the
// footer sits in the flex flow (the dock-mount stays footer-height always); when
// expanded, the resizer + body float in an absolutely-positioned overlay ABOVE
// the footer (anchored to the position:relative dock-mount), ON TOP of the
// content — so opening the dock never shrinks the view above it.

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
    // Clamp the RESTORED height against the CURRENT window. A height dragged
    // out for the terminal was replayed verbatim, so opening the dock later
    // (e.g. the Diff tab) could leave the graph three rows tall on a smaller
    // window — or on the same window, simply be far more than the content needs.
    this.heightPx = BottomDock.clampHeight(opts.height, opts.minHeight ?? 120);

    // The body pops UP above a permanently-pinned footer bar, so the resizer
    // (drag the body's top edge) and the body sit ABOVE the footer; the footer
    // bar is the bottom-most, always-visible element — like a status bar.
    this.resizer = el("div", "dock-resizer");
    this.resizer.append(el("div", "dock-resizer-grip"));
    this.resizer.addEventListener("pointerdown", (e) => this.startResize(e));
    wireResizerKeys(this.resizer, {
      orientation: "horizontal",
      // Sentence case, like every other control in the app ("Resize sidebar",
      // "Resize file list"). `label` is a region name — "Panel", "Terminal" —
      // and interpolating it verbatim produced the app's only Title Case
      // accessible name, "Resize Panel".
      label: opts.label
        ? `Resize ${opts.label.charAt(0).toLowerCase()}${opts.label.slice(1)}`
        : "Resize panel",
      min: opts.minHeight ?? 120,
      max: () => BottomDock.clampHeight(Number.MAX_SAFE_INTEGER, opts.minHeight ?? 120),
      get: () => this.heightPx,
      set: (h) => {
        this.heightPx = h;
        this.bodyEl.style.height = `${h}px`;
        this.publishReserve();
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
    this.syncChevron();
    this.chevron.addEventListener("click", () => this.toggle());
    footer.append(this.tabsEl, el("div", "dock-spacer"), this.actionsEl, this.chevron);
    // Clicking empty footer space expands a collapsed dock (collapse is the
    // chevron's job — so a stray click on the bar never hides your terminal).
    footer.addEventListener("pointerdown", (e) => {
      const target = e.target as HTMLElement;
      if (this.collapsed && !target.closest("button, .term-tab")) this.toggle();
    });

    // The whole panel floats in an overlay anchored to the window bottom, so
    // opening it never reflows the content above (the dock-mount always reserves
    // just the bar height). Order top→bottom: resizer · BAR · body. When open the
    // bar sits ON TOP of the body (VS-Code-panel style); when collapsed only the
    // bar remains, dropped to the base.
    this.panel = el("div", "dock-overlay");
    this.panel.append(this.resizer, footer, this.bodyEl);

    this.root = el("div", "dock-mount" + (this.collapsed ? " collapsed" : ""));
    this.root.append(this.panel);
    host.appendChild(this.root);
    this.publishReserve();
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
    this.publishReserve();
    this.opts.onResize?.();
  }

  isCollapsed(): boolean {
    return this.collapsed;
  }

  /**
   * Publish how much vertical space the dock is taking, as `--dock-reserve` on
   * its host.
   *
   * The dock is an overlay footer: it does not shrink the scrollers above it,
   * so with it open the last card of a long page sat behind it with nowhere
   * left to scroll — Settings' final section was simply unreachable. Long
   * scrollers add this to their bottom padding, so the end of the content
   * always clears the dock.
   */
  private publishReserve(): void {
    const host = this.root.parentElement ?? this.root;
    host.style.setProperty(
      "--dock-reserve",
      this.collapsed ? "0px" : `${this.heightPx}px`,
    );
  }

  get height(): number {
    return this.heightPx;
  }

  /** Point the chevron the right way (up = expand, down = collapse). */
  private syncChevron(): void {
    this.chevron.replaceChildren(glyph(this.collapsed ? "chevron-up" : "chevron-down"));
    const what = this.collapsed ? "Expand panel" : "Collapse panel";
    this.chevron.title = what;
    // The label moves with the state, and the state is announced.
    //
    // It was a fixed "Toggle panel" while the tooltip changed underneath it, so
    // a screen reader heard the same three words whether the dock was open or
    // shut — and was never told which. `aria-expanded` is the part that makes
    // the answer available without operating the control to find out.
    this.chevron.setAttribute("aria-label", what);
    this.chevron.setAttribute("aria-expanded", String(!this.collapsed));
    // A collapsed dock has nothing to resize, and `wireResizerKeys` already
    // refuses the keys (`disabled: () => this.collapsed`). Say so, and stop
    // being a tab stop: a focusable separator that answers no key at all is a
    // dead stop in the tab order and a value a screen reader reads out as
    // adjustable when it is not.
    this.resizer.setAttribute("aria-disabled", String(this.collapsed));
    this.resizer.tabIndex = this.collapsed ? -1 : 0;
  }

  /**
   * The dock may never take more than this share of the window.
   *
   * It was 0.6, on the reasoning that below 40% the view above stops being
   * usable. That is the wrong party's decision: a person reading a long diff in
   * the dock is not using the graph behind it at that moment, and stopping
   * their drag at 60% reads as the app refusing. What the ceiling is really for
   * is making sure there is always a way BACK — enough of the view above to
   * aim at, and the dock's own footer to collapse from. 0.9 gives that with a
   * tenth of the window to spare, and `reclamp()` still snaps a dock that no
   * longer fits after the window shrinks.
   */
  private static readonly MAX_SHARE = 0.9;

  static clampHeight(h: number, min = 120): number {
    const ceiling = Math.max(min, Math.round(window.innerHeight * BottomDock.MAX_SHARE));
    return Math.max(min, Math.min(ceiling, Math.round(h)));
  }

  /** Re-clamp after a window resize so a shrunk window can't leave the dock
   *  covering everything. */
  /** Set the body height (clamped). Used when a surface is opened
   *  programmatically and the stored height is unsuitable for it. */
  setHeight(h: number): void {
    this.heightPx = BottomDock.clampHeight(h, this.opts.minHeight ?? 120);
    this.bodyEl.style.height = `${this.heightPx}px`;
    this.publishReserve();
    this.opts.onResize?.();
    this.opts.onHeightChange?.(this.heightPx);
  }

  reclamp(): void {
    const next = BottomDock.clampHeight(this.heightPx, this.opts.minHeight ?? 120);
    if (next !== this.heightPx) {
      this.heightPx = next;
      this.bodyEl.style.height = `${next}px`;
      this.publishReserve();
      this.opts.onResize?.();
    }
  }

  /** Drag the top edge to resize the body height (clamped), then relayout. */
  private startResize(e: PointerEvent): void {
    if (this.collapsed) return;
    e.preventDefault();
    document.body.classList.add("resizing-v");
    const startY = e.clientY;
    const startH = this.heightPx;
    const min = this.opts.minHeight ?? 120;
    const max = BottomDock.clampHeight(Number.MAX_SAFE_INTEGER, min);
    const move = (ev: PointerEvent): void => {
      const h = Math.max(min, Math.min(max, startH + (startY - ev.clientY)));
      this.heightPx = h;
      this.bodyEl.style.height = `${h}px`;
      // The DRAG path was the one place the reserve was not republished — the
      // keyboard resizer, collapse, setHeight and reclamp all did. So dragging
      // the dock taller left `--dock-reserve` at its old value and put the end
      // of every long list back behind the dock, which is the whole thing the
      // reserve exists to prevent.
      this.publishReserve();
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
