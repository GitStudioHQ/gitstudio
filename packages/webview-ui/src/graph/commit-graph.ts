// <gitstudio-graph> — the virtualized commit-graph webview surface.
//
// A GitKraken/GitLens-grade history view: a scroll container of fixed-height
// rows, only the visible window in the DOM (via @tanstack/virtual-core), each
// row a CSS grid of [gutter SVG | ref chips | subject | author | date | sha].
// Keyboard navigable, theme-native (all colors via --vscode-* or the lane
// palette), and smooth at 50k+ rows. Lit owns the shell; the hot inner list is
// rendered imperatively into a Lit-owned container so we never re-template
// thousands of nodes — only the ~visible window is touched per frame.

import { LitElement, html, css, nothing, type PropertyValues } from "lit";
import { codiconStyles } from "../styles/codicons";
import {
  Virtualizer,
  observeElementRect,
  observeElementOffset,
  elementScroll,
  type VirtualItem,
} from "@tanstack/virtual-core";
import type {
  WireRow,
  WireRef,
  RowStat,
} from "@gitstudio/host-bridge/graphProtocol";
import { renderRowGutterSVG } from "./gutter";
import {
  paletteForTheme,
  observeGraphTheme,
} from "./lanePalette";
import {
  gravatarUrl,
  avatarHue,
  authorInitials,
} from "./avatar";

// ── Layout constants (the visual contract; tuned to GitLens proportions) ─────
const ROW_HEIGHT = 24;
const COL_WIDTH = 14;
const NODE_RADIUS = 3.5;
const OVERSCAN = 12;
/** Author avatar diameter, px — sits ON the commit node, GitKraken-style. */
const AVATAR_SIZE = 18;
/** Left inset added to every lane so a node avatar at lane 0 isn't clipped. */
const NODE_INSET = 12;
/** Min gutter width so even a linear history reserves room for the avatar. */
const MIN_GUTTER_WIDTH = 34;
/** Cap the *rendered* gutter width so a pathological fan-out can't eat the row. */
const MAX_GUTTER_COLUMNS = 16;
/** Trigger a loadMore when within this many rows of the bottom. */
const LOAD_MORE_THRESHOLD = 60;
/** Cap ref chips shown inline before collapsing into a "+N" overflow pill. */
const MAX_VISIBLE_REFS = 4;

export type GraphAction =
  | { type: "select"; sha: string }
  | { type: "open"; sha: string }
  | { type: "context"; sha: string; x: number; y: number }
  | { type: "loadMore" }
  | { type: "requestStats"; shas: string[] };

export class CommitGraph extends LitElement {
  // Declared imperatively (no decorators) so the build is independent of the
  // experimental-vs-standard decorator tsconfig toggle. `attribute: false`
  // keeps these as DOM properties, set by the webview entry, never reflected.
  static properties = {
    rows: { attribute: false },
    totalColumns: { attribute: false },
    hasMore: { attribute: false },
    status: { attribute: false },
    head: { attribute: false },
    palette: { state: true },
    selectedSha: { state: true },
  };

  static styles = [codiconStyles, css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      overflow: hidden;
      /* Hole color punched through graph nodes = the surface behind the row.
         Falls through to the editor bg; hover/selected rows override it so the
         node hole tracks the row tint. */
      --gs-graph-node-hole: var(--vscode-editor-background, #1e1e1e);
      --gs-accent: var(--vscode-focusBorder);
      --gs-fg-muted: var(--vscode-descriptionForeground, #9aa0a6);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size, 13px);
    }

    /* ── Header bar: current branch + loaded count + nav hints ──────────── */
    .gheader {
      display: flex;
      align-items: center;
      gap: 10px;
      flex: 0 0 auto;
      height: 36px;
      padding: 0 12px;
      border-bottom: 1px solid color-mix(in srgb,
        var(--vscode-foreground) 12%, transparent);
      background: color-mix(in srgb,
        var(--vscode-foreground) 3%, var(--vscode-editor-background));
      user-select: none;
    }
    .gh-branch {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 46%;
      height: 22px;
      padding: 0 10px 0 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
      color: var(--vscode-textLink-foreground, var(--gs-accent));
      background: color-mix(in srgb, var(--gs-accent) 13%, transparent);
      border: 1px solid color-mix(in srgb, var(--gs-accent) 30%, transparent);
    }
    .gh-branch .codicon { font-size: 13px; flex: 0 0 auto; }
    .gh-branch .nm {
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .gh-count {
      font-size: 11.5px;
      color: var(--gs-fg-muted);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .gh-spacer { flex: 1 1 auto; }
    .gh-hint {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
      white-space: nowrap;
      overflow: hidden;
    }
    .gh-hint kbd {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 10px;
      line-height: 15px;
      padding: 0 4px;
      border-radius: 4px;
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 16%, transparent);
      color: var(--gs-fg-muted);
    }
    @media (max-width: 620px) { .gh-hint { display: none; } }
    @media (max-width: 420px) { .gh-count { display: none; } }

    /* ── Column header row (aligned to the row grid) ──────────────────── */
    .colhead {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns:
        var(--gs-gutter-w, ${MIN_GUTTER_WIDTH}px)
        auto
        minmax(0, 1fr)
        108px
        132px
        56px
        62px;
      align-items: center;
      height: 24px;
      padding-right: 12px;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      background: color-mix(in srgb, var(--vscode-foreground) 2%, var(--vscode-editor-background));
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--vscode-foreground) 50%, transparent);
      user-select: none;
    }
    .colhead > span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-left: 2px;
    }
    .colhead .ch-graph { padding-left: 4px; }
    .colhead .ch-sha { text-align: right; padding-right: 0; }

    .scroller {
      flex: 1 1 auto;
      width: 100%;
      overflow: auto;
      contain: strict;
      outline: none;
    }
    /* Keyboard focus must stay visible even though we suppress the default
       outline (the scroller is the roving-focus container for arrow-key nav). */
    .scroller:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }

    .sizer {
      position: relative;
      width: 100%;
    }

    .row {
      position: absolute;
      left: 0;
      top: 0;
      width: 100%;
      height: ${ROW_HEIGHT}px;
      display: grid;
      grid-template-columns:
        var(--gs-gutter-w, ${MIN_GUTTER_WIDTH}px)
        auto
        minmax(0, 1fr)
        108px
        132px
        56px
        62px;
      align-items: center;
      column-gap: 0;
      box-sizing: border-box;
      padding-right: 12px;
      cursor: default;
      user-select: none;
      border-left: 2px solid transparent;
      --gs-graph-node-hole: var(--vscode-editor-background, #1e1e1e);
      will-change: transform;
    }
    .row:hover {
      background: var(--vscode-list-hoverBackground);
      --gs-graph-node-hole: var(--vscode-list-hoverBackground,
        var(--vscode-editor-background));
    }
    .row.selected {
      background: var(--vscode-list-activeSelectionBackground);
      color: var(--vscode-list-activeSelectionForeground, inherit);
      border-left-color: var(--vscode-focusBorder, var(--vscode-list-focusOutline,
        #007fd4));
      --gs-graph-node-hole: var(--vscode-list-activeSelectionBackground,
        var(--vscode-editor-background));
    }
    .row.selected:hover {
      background: var(--vscode-list-activeSelectionBackground);
    }

    /* ── Author avatar — sits ON the commit node (GitKraken-style) ──────── */
    .avatar {
      position: absolute;
      left: var(--gs-av-x, 12px);
      top: 50%;
      width: ${AVATAR_SIZE}px;
      height: ${AVATAR_SIZE}px;
      transform: translate(-50%, -50%);
      border-radius: 50%;
      overflow: hidden;
      /* A lane-colored ring, then a hole-colored ring so crossing lanes never
         visually fuse into the avatar. */
      box-shadow:
        0 0 0 1.5px var(--gs-av-ring, var(--vscode-focusBorder)),
        0 0 0 3px var(--gs-graph-node-hole);
      pointer-events: none;
      z-index: 1;
    }
    .row.selected .avatar {
      box-shadow:
        0 0 0 1.5px var(--gs-av-ring, var(--vscode-focusBorder)),
        0 0 0 3px var(--vscode-list-activeSelectionBackground, var(--gs-graph-node-hole));
    }
    .avatar img {
      width: 100%;
      height: 100%;
      display: block;
      object-fit: cover;
      background: transparent;
    }
    .avatar .fallback {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 8.5px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: #fff;
      font-family: var(--vscode-font-family);
      background: hsl(var(--gs-av-hue, 210) 48% 42%);
    }

    .gutter {
      position: relative;
      height: ${ROW_HEIGHT}px;
      overflow: hidden;
      align-self: stretch;
    }
    .gutter svg {
      display: block;
    }

    .refs {
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 0 8px 0 6px;
      max-width: 320px;
      overflow: hidden;
      white-space: nowrap;
    }
    /* Ref chips — radius 4px, 11px, subtle tinted bg, per the design system. */
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 16px;
      padding: 0 6px;
      border-radius: 4px;
      font-size: 11px;
      line-height: 16px;
      max-width: 150px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      border: 1px solid transparent;
      flex: 0 0 auto;
    }
    .chip .ico {
      font-size: 11px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    /* current HEAD = filled accent with a leading "you are here" dot. */
    .chip-current {
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background,
        var(--vscode-focusBorder));
      border-color: var(--vscode-button-background, var(--vscode-focusBorder));
      font-weight: 600;
    }
    .chip-current .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: currentColor;
      box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 35%, transparent);
    }
    /* local branch = accent-tinted. */
    .chip-head {
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      border-color: color-mix(in srgb,
        var(--vscode-focusBorder) 38%, transparent);
      background: color-mix(in srgb,
        var(--vscode-focusBorder) 14%, transparent);
    }
    /* remote = muted with a cloud glyph. */
    .chip-remote {
      color: var(--vscode-descriptionForeground, #9aa0a6);
      border-color: color-mix(in srgb, currentColor 26%, transparent);
      background: color-mix(in srgb, currentColor 10%, transparent);
    }
    /* tag = amber / charts-yellow tinted with a tag glyph. */
    .chip-tag {
      color: var(--vscode-charts-yellow, #e5a73c);
      border-color: color-mix(in srgb,
        var(--vscode-charts-yellow, #e5a73c) 34%, transparent);
      background: color-mix(in srgb,
        var(--vscode-charts-yellow, #e5a73c) 14%, transparent);
    }
    .chip-overflow {
      color: var(--vscode-descriptionForeground, #9aa0a6);
      background: color-mix(in srgb, currentColor 10%, transparent);
      border-color: color-mix(in srgb, currentColor 22%, transparent);
      padding: 0 5px;
      font-variant-numeric: tabular-nums;
    }

    .subject {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      padding-right: 12px;
      font-size: 13px;
      transition: opacity 150ms ease;
    }
    .refs,
    .avatar,
    .meta {
      transition: opacity 150ms ease;
    }
    .meta {
      color: var(--vscode-descriptionForeground, #9aa0a6);
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 11.5px;
    }
    /* ── CHANGES column: file count + add/del proportion bar ──────────── */
    .changes {
      display: flex;
      align-items: center;
      gap: 7px;
      padding-right: 12px;
      overflow: hidden;
      color: var(--vscode-descriptionForeground, #9aa0a6);
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      transition: opacity 150ms ease;
    }
    .changes .ch-count {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      flex: 0 0 auto;
    }
    .changes .ch-count .codicon { font-size: 12px; opacity: 0.75; }
    .changes .ch-bar {
      display: inline-flex;
      gap: 1.5px;
      flex: 0 0 auto;
    }
    .changes .ch-bar i {
      width: 9px;
      height: 8px;
      border-radius: 1.5px;
      background: color-mix(in srgb, currentColor 22%, transparent);
    }
    .changes .ch-bar i.a {
      background: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #89d185));
    }
    .changes .ch-bar i.d {
      background: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red, #f14c4c));
    }
    .author {
      padding-right: 10px;
    }
    .date {
      text-align: right;
      padding-right: 12px;
      font-variant-numeric: tabular-nums;
    }
    .sha {
      text-align: right;
      font-family: var(--vscode-editor-font-family, monospace);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      opacity: 0.8;
    }
    .row.selected .meta {
      color: inherit;
      opacity: 0.85;
    }

    /* Reduce the visual weight of unrelated rows on hover-focus. */
    .scroller.focusing .row:not(.focus-on) .subject,
    .scroller.focusing .row:not(.focus-on) .refs,
    .scroller.focusing .row:not(.focus-on) .avatar,
    .scroller.focusing .row:not(.focus-on) .changes,
    .scroller.focusing .row:not(.focus-on) .meta {
      opacity: 0.5;
    }

    .placeholder {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 10px;
      color: var(--vscode-descriptionForeground, #9aa0a6);
      font-size: 13px;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
      border-top-color: currentColor;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }
    @media (prefers-reduced-motion: reduce) {
      .spinner {
        animation: none;
        border-top-color: color-mix(in srgb, currentColor 30%, transparent);
      }
      .subject,
      .refs,
      .avatar,
      .meta {
        transition: none;
      }
    }
  `];

  // Reactive properties are `declare`d (no field initializer) so they never
  // shadow Lit's generated accessors under ES2022 `[[Define]]` field semantics;
  // their defaults are assigned in the constructor instead.
  /** The loaded rows (host appends pages in place). */
  declare rows: WireRow[];
  /** Total columns across loaded rows (drives gutter sizing). */
  declare totalColumns: number;
  /** Whether more pages remain to be loaded on scroll. */
  declare hasMore: boolean;
  /** Lifecycle phase for the placeholder states. */
  declare status: "loading" | "ready" | "empty";
  /** Sha of the current HEAD commit. */
  declare head: string;

  private declare palette: readonly string[];
  private declare selectedSha: string | undefined;

  /** Emits user intents the host should act on. */
  onAction: (action: GraphAction) => void = () => {};

  private get scroller(): HTMLDivElement | null {
    return this.renderRoot.querySelector(".scroller");
  }

  private virtualizer:
    | Virtualizer<HTMLDivElement, HTMLDivElement>
    | undefined;
  /** The scroll element the live virtualizer is bound to (identity check). */
  private boundScroller: HTMLDivElement | undefined;
  private cleanupVirtualizer: (() => void) | undefined;
  private disposeTheme: (() => void) | undefined;
  private shaToIndex = new Map<string, number>();
  /** CHANGES-column stats by sha (lazily fetched for visible rows). */
  private rowStats = new Map<string, RowStat>();
  /** Shas whose stats have been requested but not yet returned. */
  private pendingStats = new Set<string>();
  private loadMoreArmed = true;
  /** lane color the pointer is hovering, for the focus-dim affordance. */
  private focusColor: number | undefined;

  constructor() {
    super();
    this.rows = [];
    this.totalColumns = 1;
    this.hasMore = false;
    this.status = "loading";
    this.head = "";
    this.palette = paletteForTheme();
    this.selectedSha = undefined;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.disposeTheme = observeGraphTheme((palette) => {
      this.palette = palette;
      this.renderRows();
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    this.teardownVirtualizer();
    this.disposeTheme?.();
    this.disposeTheme = undefined;
  }

  updated(changed: PropertyValues): void {
    if (changed.has("rows")) {
      this.rebuildIndex();
      // New page arrived: re-arm the loader so the next near-bottom fires.
      this.loadMoreArmed = true;
    }
    // The `.scroller` only exists once we leave the placeholder states, and a
    // status flip swaps the whole subtree. Lazily (re)bind the virtualizer to
    // whatever scroller is live now, then paint the visible window. Doing this
    // every update also re-syncs the count after an append and re-fills the
    // sizer after any Lit re-render (e.g. a selection change).
    const scroller = this.scroller;
    if (scroller) {
      if (!this.virtualizer || this.boundScroller !== scroller) {
        this.setupVirtualizer(scroller);
      } else {
        this.virtualizer.setOptions(this.virtualizerOptions());
      }
      this.applyGutterWidth();
      this.renderRows();
    } else {
      // Back to a placeholder: drop the stale virtualizer binding.
      this.teardownVirtualizer();
    }
  }

  // ── Virtualizer wiring ─────────────────────────────────────────────────────

  private virtualizerOptions() {
    return {
      count: this.rows.length,
      getScrollElement: () => this.boundScroller ?? null,
      estimateSize: () => ROW_HEIGHT,
      overscan: OVERSCAN,
      observeElementRect,
      observeElementOffset,
      scrollToFn: elementScroll,
      onChange: () => this.renderRows(),
    };
  }

  private setupVirtualizer(scroller: HTMLDivElement): void {
    this.teardownVirtualizer();
    this.boundScroller = scroller;
    const v = new Virtualizer<HTMLDivElement, HTMLDivElement>(
      this.virtualizerOptions(),
    );
    this.virtualizer = v;
    this.cleanupVirtualizer = v._didMount();
    v._willUpdate();
  }

  private teardownVirtualizer(): void {
    this.cleanupVirtualizer?.();
    this.cleanupVirtualizer = undefined;
    this.virtualizer = undefined;
    this.boundScroller = undefined;
  }

  private rebuildIndex(): void {
    this.shaToIndex.clear();
    for (let i = 0; i < this.rows.length; i++) {
      this.shaToIndex.set(this.rows[i].sha, i);
    }
  }

  /** Gutter render width: capped columns × pitch + inset + avatar half-width. */
  private gutterWidth(): number {
    const cols = Math.min(
      Math.max(this.totalColumns, 1),
      MAX_GUTTER_COLUMNS,
    );
    return Math.max(
      MIN_GUTTER_WIDTH,
      NODE_INSET + cols * COL_WIDTH + COL_WIDTH / 2 + AVATAR_SIZE / 2 + 2,
    );
  }

  private applyGutterWidth(): void {
    this.style.setProperty("--gs-gutter-w", `${this.gutterWidth()}px`);
  }

  // ── The hot path: render only the visible window into the sizer ────────────

  private renderRows(): void {
    const v = this.virtualizer;
    const sizer = this.renderRoot.querySelector(".sizer") as HTMLElement | null;
    if (!v || !sizer) {
      return;
    }
    v._willUpdate();
    const items = v.getVirtualItems();
    const total = v.getTotalSize();
    sizer.style.height = `${total}px`;

    const gutterW = this.gutterWidth();
    let lastIndex = -1;
    let htmlOut = "";
    const needStats: string[] = [];
    for (const item of items) {
      lastIndex = Math.max(lastIndex, item.index);
      const row = this.rows[item.index];
      if (row && !this.rowStats.has(row.sha) && !this.pendingStats.has(row.sha)) {
        needStats.push(row.sha);
      }
      htmlOut += this.rowHtml(item, gutterW);
    }
    sizer.innerHTML = htmlOut;

    // Lazily request CHANGES-column stats for the just-rendered visible rows.
    if (needStats.length) {
      for (const sha of needStats) this.pendingStats.add(sha);
      this.onAction({ type: "requestStats", shas: needStats });
    }

    // Infinite scroll: when the rendered window reaches near the tail, ask the
    // host for more — once per page until a new page resets the arm.
    if (
      this.hasMore &&
      this.loadMoreArmed &&
      lastIndex >= this.rows.length - LOAD_MORE_THRESHOLD
    ) {
      this.loadMoreArmed = false;
      this.onAction({ type: "loadMore" });
    }
  }

  /** Merge in CHANGES-column stats and repaint the visible rows. */
  setRowStats(stats: RowStat[]): void {
    for (const s of stats) {
      this.rowStats.set(s.sha, s);
      this.pendingStats.delete(s.sha);
    }
    this.renderRows();
  }

  /** The CHANGES cell: file count + a green/red add/del proportion bar. */
  private changesHtml(sha: string): string {
    const s = this.rowStats.get(sha);
    if (!s || s.files === 0) {
      return "";
    }
    const total = s.additions + s.deletions;
    const cells = 5;
    let greens = total === 0 ? 0 : Math.round((s.additions / total) * cells);
    if (s.additions > 0 && greens === 0) greens = 1;
    if (s.deletions > 0 && greens === cells) greens = cells - 1;
    let bar = "";
    for (let i = 0; i < cells; i++) {
      const c = total === 0 ? "n" : i < greens ? "a" : "d";
      bar += `<i class="${c}"></i>`;
    }
    return (
      `<span class="ch-count" title="${s.files} file${s.files === 1 ? "" : "s"} changed">` +
      `<span class="codicon codicon-file"></span>${s.files}</span>` +
      `<span class="ch-bar" title="+${Math.max(0, s.additions)} -${Math.max(0, s.deletions)}">${bar}</span>`
    );
  }

  private rowHtml(item: VirtualItem, gutterW: number): string {
    const row = this.rows[item.index];
    if (!row) {
      return "";
    }
    const selected = row.sha === this.selectedSha;
    const focusOn =
      this.focusColor === undefined || row.color === this.focusColor;
    const cls =
      "row" +
      (selected ? " selected" : "") +
      (focusOn ? " focus-on" : "");
    const gutter = renderRowGutterSVG(
      row,
      {
        colWidth: COL_WIDTH,
        rowHeight: ROW_HEIGHT,
        nodeRadius: NODE_RADIUS,
        nodeInset: NODE_INSET,
        palette: this.palette,
        focusColor: this.focusColor,
      },
      gutterW,
    );
    const refs = row.refs.length ? this.refsHtml(row.refs) : "";
    // The avatar sits ON the commit node (GitKraken-style), positioned at the
    // node's lane x and ringed in the lane color.
    const cx = Math.round(row.column * COL_WIDTH + COL_WIDTH / 2 + NODE_INSET);
    const ring = this.palette[row.color % this.palette.length] ?? "#888";
    const avatar = avatarHtml(row.author, row.authorEmail, cx, ring);
    const label = esc(
      `${row.shortSha}: ${row.subject} — ${row.author}, ${relTime(row.authorDate)}`,
    );
    return (
      `<div class="${cls}" role="row" data-sha="${row.sha}" ` +
      `aria-selected="${selected ? "true" : "false"}" aria-label="${label}" ` +
      `style="transform:translateY(${item.start}px)">` +
      `<div class="gutter">${gutter}${avatar}</div>` +
      `<div class="refs">${refs}</div>` +
      `<div class="subject" title="${esc(row.subject)}">${esc(row.subject)}</div>` +
      `<div class="changes">${this.changesHtml(row.sha)}</div>` +
      `<div class="meta author" title="${esc(row.author)} <${esc(row.authorEmail)}>">${esc(row.author)}</div>` +
      `<div class="meta date" title="${esc(absTime(row.authorDate))}">${esc(relTime(row.authorDate))}</div>` +
      `<div class="meta sha">${esc(row.shortSha)}</div>` +
      `</div>`
    );
  }

  private refsHtml(refs: WireRef[]): string {
    const visible = refs.slice(0, MAX_VISIBLE_REFS);
    const overflow = refs.length - visible.length;
    let out = "";
    for (const ref of visible) {
      out += chipHtml(ref);
    }
    if (overflow > 0) {
      out += `<span class="chip chip-overflow">+${overflow}</span>`;
    }
    return out;
  }

  // ── Interaction ────────────────────────────────────────────────────────────

  private rowShaFromEvent(e: Event): string | undefined {
    const el = (e.target as HTMLElement | null)?.closest(
      ".row",
    ) as HTMLElement | null;
    return el?.dataset.sha;
  }

  private onClick = (e: MouseEvent): void => {
    const sha = this.rowShaFromEvent(e);
    if (!sha) {
      return;
    }
    this.select(sha, false);
  };

  private onDblClick = (e: MouseEvent): void => {
    const sha = this.rowShaFromEvent(e);
    if (!sha) {
      return;
    }
    this.select(sha, false);
    this.onAction({ type: "open", sha });
  };

  private onContextMenu = (e: MouseEvent): void => {
    const sha = this.rowShaFromEvent(e);
    if (!sha) {
      return;
    }
    e.preventDefault();
    this.select(sha, false);
    this.onAction({ type: "context", sha, x: e.clientX, y: e.clientY });
  };

  private onPointerMove = (e: PointerEvent): void => {
    const el = (e.target as HTMLElement | null)?.closest(
      ".row",
    ) as HTMLElement | null;
    const sha = el?.dataset.sha;
    const idx = sha ? this.shaToIndex.get(sha) : undefined;
    const next = idx !== undefined ? this.rows[idx]?.color : undefined;
    if (next !== this.focusColor) {
      this.focusColor = next;
      this.scroller?.classList.toggle("focusing", next !== undefined);
      this.renderRows();
    }
  };

  // Delegated, capture-phase avatar load-failure handler. `error` events from
  // <img> don't bubble, so we listen in the capture phase (Lit accepts an
  // object listener with `capture`). A failed Gravatar image is hidden so the
  // colored initials disc behind it shows through.
  private onImgError = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    if (t && t instanceof HTMLImageElement && t.classList.contains("av-img")) {
      t.style.display = "none";
    }
  };
  private onImgErrorOptions = {
    handleEvent: (e: Event) => this.onImgError(e),
    capture: true,
  };

  private onPointerLeave = (): void => {
    if (this.focusColor !== undefined) {
      this.focusColor = undefined;
      this.scroller?.classList.remove("focusing");
      this.renderRows();
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.rows.length === 0) {
      return;
    }
    const current =
      this.selectedSha !== undefined
        ? this.shaToIndex.get(this.selectedSha)
        : undefined;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      const base = current ?? (delta > 0 ? -1 : this.rows.length);
      const next = Math.max(0, Math.min(this.rows.length - 1, base + delta));
      this.select(this.rows[next].sha, true);
    } else if (e.key === "Home") {
      e.preventDefault();
      this.select(this.rows[0].sha, true);
    } else if (e.key === "End") {
      e.preventDefault();
      this.select(this.rows[this.rows.length - 1].sha, true);
    } else if (e.key === "Enter" && this.selectedSha) {
      e.preventDefault();
      this.onAction({ type: "open", sha: this.selectedSha });
    }
  };

  private select(sha: string, scrollIntoView: boolean): void {
    if (this.selectedSha === sha && !scrollIntoView) {
      return;
    }
    this.selectedSha = sha;
    this.onAction({ type: "select", sha });
    if (scrollIntoView) {
      const idx = this.shaToIndex.get(sha);
      if (idx !== undefined && this.virtualizer) {
        this.virtualizer.scrollToIndex(idx, { align: "auto" });
      }
    }
    this.renderRows();
  }

  /** Public: select + center on a sha (e.g. the host revealing a commit). */
  reveal(sha: string): void {
    const idx = this.shaToIndex.get(sha);
    if (idx === undefined) {
      return;
    }
    this.selectedSha = sha;
    this.virtualizer?.scrollToIndex(idx, { align: "center" });
    this.renderRows();
  }

  /** Current branch name, derived from the HEAD row's currentHead ref. */
  private currentBranchName(): string {
    for (const row of this.rows) {
      const ref = row.refs.find((r) => r.kind === "currentHead");
      if (ref) {
        return ref.name;
      }
    }
    return "";
  }

  private headerHtml() {
    const branch = this.currentBranchName();
    const n = this.rows.length;
    const count =
      n === 0
        ? ""
        : `${n.toLocaleString()}${this.hasMore ? "+" : ""} commit${n === 1 ? "" : "s"}`;
    return html`<div class="gheader">
      <span
        class="gh-branch"
        title=${branch ? `${branch} (current branch)` : "Detached HEAD"}
      >
        <span class="codicon codicon-git-branch" aria-hidden="true"></span>
        <span class="nm">${branch || "detached HEAD"}</span>
      </span>
      ${count ? html`<span class="gh-count">${count}</span>` : nothing}
      <span class="gh-spacer"></span>
      <span class="gh-hint">
        <kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>↵</kbd> open · right-click for
        actions
      </span>
    </div>`;
  }

  render() {
    const header = this.headerHtml();
    if (this.status === "empty") {
      return html`${header}<div class="placeholder">
          <div>No commits yet</div>
        </div>${nothing}`;
    }
    if (this.status === "loading" && this.rows.length === 0) {
      return html`${header}<div class="placeholder">
          <div class="spinner"></div>
          <div>Loading history…</div>
        </div>${nothing}`;
    }
    return html`${header}${this.colHeadHtml()}<div
        class="scroller"
        tabindex="0"
        role="grid"
        aria-label="Commit graph"
        @click=${this.onClick}
        @dblclick=${this.onDblClick}
        @contextmenu=${this.onContextMenu}
        @keydown=${this.onKeyDown}
        @pointermove=${this.onPointerMove}
        @pointerleave=${this.onPointerLeave}
        @error=${this.onImgErrorOptions}
      >
        <div class="sizer"></div>
      </div>${nothing}`;
  }

  /** GitLens-style column headers, aligned to the row grid. */
  private colHeadHtml() {
    return html`<div class="colhead" aria-hidden="true">
      <span class="ch-graph">Graph</span>
      <span>Branch / Tag</span>
      <span>Commit message</span>
      <span>Changes</span>
      <span>Author</span>
      <span>Date</span>
      <span class="ch-sha">SHA</span>
    </div>`;
  }
}

// ── Small pure helpers (self-contained so the bundle has no extra deps) ───────

// Ref glyphs: the real VS Code codicon font (registered document-wide via the
// page stylesheet's @font-face; class rules live in codiconStyles).
const TAG_ICON = '<span class="ico codicon codicon-tag" aria-hidden="true"></span>';
const REMOTE_ICON = '<span class="ico codicon codicon-cloud" aria-hidden="true"></span>';
const BRANCH_ICON = '<span class="ico codicon codicon-git-branch" aria-hidden="true"></span>';
/** "You are here" target dot for the current HEAD chip. */
const CURRENT_DOT = '<span class="dot" aria-hidden="true"></span>';

function chipHtml(ref: WireRef): string {
  switch (ref.kind) {
    case "currentHead":
      return `<span class="chip chip-current" title="${esc(ref.name)} (HEAD)">${CURRENT_DOT}${esc(ref.name)}</span>`;
    case "head":
      return `<span class="chip chip-head" title="${esc(ref.name)}">${BRANCH_ICON}${esc(ref.name)}</span>`;
    case "remoteHead":
      return `<span class="chip chip-remote" title="${esc(ref.name)}">${REMOTE_ICON}${esc(ref.name)}</span>`;
    case "tag":
      return `<span class="chip chip-tag" title="${esc(ref.name)}">${TAG_ICON}${esc(ref.name)}</span>`;
  }
}

/**
 * One author avatar cell: a Gravatar image layered over a deterministic
 * initials disc. If the remote image fails (offline / blocked / no Gravatar),
 * a delegated capture-phase `error` listener on the scroller hides the <img>,
 * revealing the colored fallback underneath. (Inline `onerror` would violate
 * the page CSP; a single delegated listener is also cheaper than per-row JS on
 * the virtualized hot path.) Alt is intentionally empty so a broken image never
 * flashes alt text over the disc.
 */
function avatarHtml(
  author: string,
  email: string,
  cx: number,
  ring: string,
): string {
  const hue = avatarHue(email);
  const initials = esc(authorInitials(author, email));
  const url = esc(gravatarUrl(email, 40));
  return (
    `<span class="avatar" style="--gs-av-hue:${hue};--gs-av-x:${cx}px;` +
    `--gs-av-ring:${esc(ring)}" aria-hidden="true">` +
    `<span class="fallback">${initials}</span>` +
    `<img class="av-img" src="${url}" alt="" loading="lazy" decoding="async" />` +
    `</span>`
  );
}

/** HTML-escape user-controlled text before splicing into innerHTML. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** Compact relative age, mirroring the extension's relativeTime util. */
function relTime(epochSeconds: number, now = Date.now() / 1000): string {
  const delta = Math.floor(now - epochSeconds);
  if (delta < MINUTE) {
    return "now";
  }
  if (delta < HOUR) {
    return `${Math.floor(delta / MINUTE)}m`;
  }
  if (delta < DAY) {
    return `${Math.floor(delta / HOUR)}h`;
  }
  if (delta < MONTH) {
    return `${Math.floor(delta / DAY)}d`;
  }
  if (delta < YEAR) {
    return `${Math.floor(delta / MONTH)}mo`;
  }
  return `${Math.floor(delta / YEAR)}y`;
}

/** Full local timestamp for the date column's hover tooltip. */
function absTime(epochSeconds: number): string {
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return "";
  }
}

if (!customElements.get("gitstudio-graph")) {
  customElements.define("gitstudio-graph", CommitGraph);
}

declare global {
  interface HTMLElementTagNameMap {
    "gitstudio-graph": CommitGraph;
  }
}
