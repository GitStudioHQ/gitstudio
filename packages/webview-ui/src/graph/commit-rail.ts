// <gitstudio-commit-rail> — the sidebar-native commit log.
//
// A ground-up rebuild of the Commits sidebar surface. The editor-area
// <gitstudio-graph> is a TABLE you study (columns, docked details, avatars on
// nodes); a 250–350px sidebar can't carry that, so this element is a LOG you
// scan, designed for the space:
//
//   · two-line 40px rows — the subject owns line 1 edge-to-edge; refs, author
//     and age share a muted line 2 — instead of one truncated table row
//   · the TRUE topology at sidebar scale: the exact same gutter renderer as
//     the editor graph (verticals-over-diagonals, halo-punched junctions) at
//     a 12px pitch, with MINI author avatars riding the commit nodes. Lanes
//     beyond the rendered strip clip at its edge — never remapped, so the
//     geometry is always honest (no dangling curves or orphan dots)
//   · refs as micro-chips with the graph's remote-folding (origin/x merges
//     into the local x chip as a cloud tail), capped at 2 + "+N"
//   · NO docked details pane: single-click selects, double-click / Enter /
//     the row's hover action promote the commit to the full Commit Graph
//     panel — the sidebar navigates, the panel inspects
//   · the same wire protocol as the big graph (graphInit/graphAppend/
//     commitMenu/revealCommit), so the host is shared
//
// Rows are virtualized with @tanstack/virtual-core and painted imperatively
// (innerHTML window) exactly like <gitstudio-graph> — only the visible window
// exists in the DOM.

import { LitElement, html, css, nothing } from "lit";
import { codiconStyles } from "../styles/codicons";
import { hostTokens } from "../styles/hostTokens";
import {
  Virtualizer,
  observeElementRect,
  observeElementOffset,
  elementScroll,
  type VirtualItem,
} from "@tanstack/virtual-core";
import type { WireRow, WireRef } from "@gitstudio/host-bridge/graphProtocol";
import { renderRowGutterSVG } from "./gutter";
import { paletteForTheme, observeGraphTheme } from "./lanePalette";
import { gravatarUrl, avatarHue, authorInitials } from "./avatar";

// ── Layout constants (the sidebar's visual contract) ────────────────────────
const ROW_HEIGHT = 40;
/** Horizontal pitch between rail lanes — sparse enough that a 14px avatar
 * reads unambiguously on ITS lane (adjacent lines stay 16px away). */
const PITCH = 16;
/** Mini author avatar diameter, px — sits ON the commit node. */
const AVATAR_SIZE = 14;
/** The rendered strip covers this many lanes at most; deeper lanes clip at
 * its edge (real geometry, honestly cut — never remapped). */
const MAX_RAIL_LANES = 12;
const NODE_RADIUS = 3;
/** Left inset so a lane-0 avatar isn't clipped (avatar half + 1). */
const RAIL_INSET = 8;
/** Right breathing room between a row's last active lane and its text. */
const RAIL_GAP = 7;
const OVERSCAN = 14;
/** Trigger a loadMore when within this many rows of the bottom. */
const LOAD_MORE_THRESHOLD = 60;
/** Ref chips shown on the meta line before collapsing into "+N". */
const MAX_CHIPS = 2;
/** The all-zeros sha marks the synthetic "uncommitted changes" (WIP) row. */
const ZERO_SHA_RE = /^0{40}$/;
/** Shared with the editor-area graph so the preference follows the user. */
const LS_SEARCH_SCOPE = "gitstudio.graph.search.scope";

/** What the search query matches against (mirrors the graph's scopes). */
export type RailSearchScope = "all" | "message" | "author" | "sha" | "refs";
const SEARCH_SCOPES: ReadonlyArray<{ id: RailSearchScope; label: string }> = [
  { id: "all", label: "All" },
  { id: "message", label: "Message" },
  { id: "author", label: "Author" },
  { id: "sha", label: "SHA" },
  { id: "refs", label: "Branch+Tag" },
];

export type RailAction =
  /** Promote to the editor-area Commit Graph, revealed at this commit. */
  | { type: "open"; sha: string }
  | { type: "context"; sha: string; x: number; y: number }
  | { type: "menuAction"; sha: string; id: string }
  | { type: "copy"; text: string }
  | { type: "loadMore" }
  | { type: "refresh" };

/** One item in the commit actions popover (host-built, same as the graph's). */
export interface RailMenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  sep?: boolean;
}

interface RailMenu {
  sha: string;
  x: number;
  y: number;
  title: string;
  items: RailMenuItem[];
}

/** A folded, render-ready ref chip (remote twins folded into their local). */
interface ChipView {
  kind: WireRef["kind"];
  label: string;
  /** The folded remote names ("origin", …) — shown as a cloud tail. */
  remotes: string[];
  title: string;
}

export class CommitRail extends LitElement {
  static properties = {
    rows: { attribute: false },
    head: { attribute: false },
    totalColumns: { attribute: false },
    hasMore: { attribute: false },
    status: { attribute: false },
    errorMessage: { attribute: false },
    searchQuery: { state: true },
    searchScope: { state: true },
    scopeOpen: { state: true },
    commitMenu: { state: true },
    selectedSha: { state: true },
  };

  static styles = [
    hostTokens,
    codiconStyles,
    css`
      :host {
        display: flex;
        flex-direction: column;
        height: 100%;
        min-height: 0;
        font-family: var(--gs-font-ui);
        font-size: var(--vscode-font-size, 13px);
        color: var(--gs-fg);
        background: var(--gs-bg);
        /* The halo color that keeps crossing lanes from fusing into nodes —
           follows each row's actual background via a per-row override. */
        --gs-graph-node-hole: var(--gs-bg);
      }

      /* ── Header: one slim bar — search owns it ─────────────────────────── */
      .bar {
        display: flex;
        align-items: center;
        gap: 4px;
        padding: 4px 6px 4px 8px;
        flex: 0 0 auto;
      }
      .search {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 4px;
        height: 24px;
        padding: 0 4px 0 6px;
        border-radius: var(--gs-radius-sm);
        border: 1px solid var(--gs-border-soft);
        background: var(--gs-surface);
        transition: border-color var(--gs-motion-fast) var(--gs-ease);
      }
      .search:focus-within {
        border-color: var(--gs-accent);
      }
      .search > .codicon-search {
        font-size: 12px;
        color: var(--gs-fg-muted);
        flex: 0 0 auto;
      }
      .search input {
        flex: 1 1 auto;
        min-width: 32px;
        border: 0;
        outline: 0;
        background: transparent;
        color: var(--gs-fg);
        font-family: inherit;
        font-size: 12px;
        padding: 0;
      }
      .search input::placeholder {
        color: var(--gs-fg-subtle);
      }
      .count {
        flex: 0 0 auto;
        font-size: 10px;
        font-variant-numeric: tabular-nums;
        color: var(--gs-fg-muted);
        white-space: nowrap;
      }
      .count.none { color: var(--gs-status-deleted); }

      .ibtn {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 20px;
        height: 20px;
        padding: 0;
        border: 0;
        border-radius: var(--gs-radius-sm);
        background: transparent;
        color: var(--gs-fg-muted);
        cursor: pointer;
      }
      .ibtn:hover { background: var(--gs-hover); color: var(--gs-fg); }
      .ibtn:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
      .ibtn .codicon { font-size: 13px; }
      .search .ibtn { width: 18px; height: 18px; }
      .search .ibtn .codicon { font-size: 11px; }
      /* A dot on the filter icon when the scope is narrowed from "All". */
      .ibtn.scoped::after {
        content: "";
        position: absolute;
        width: 4px;
        height: 4px;
        border-radius: 50%;
        background: var(--gs-accent-text);
        transform: translate(5px, -5px);
      }
      .ibtn.scoped { position: relative; }
      /* The narrowest sidebars keep search usable: match nav hides, Enter /
         Shift+Enter still steps through matches. */
      @media (max-width: 235px) {
        .search .nav { display: none; }
      }

      /* ── Scroller + virtualized rows ───────────────────────────────────── */
      .scroller {
        flex: 1 1 auto;
        min-height: 0;
        overflow-y: auto;
        overflow-x: hidden;
        outline: none;
        scrollbar-width: thin;
      }
      .scroller::-webkit-scrollbar { width: 8px; }
      .scroller::-webkit-scrollbar-thumb {
        background: var(--vscode-scrollbarSlider-background);
        border-radius: 4px;
      }
      .scroller::-webkit-scrollbar-thumb:hover {
        background: var(--vscode-scrollbarSlider-hoverBackground);
      }
      .sizer { position: relative; width: 100%; }

      .row {
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        height: ${ROW_HEIGHT}px;
        display: flex;
        align-items: stretch;
        cursor: pointer;
        user-select: none;
        -webkit-user-select: none;
        --gs-graph-node-hole: var(--gs-bg);
        content-visibility: auto;
      }
      .row:hover {
        background: var(--gs-hover);
        --gs-graph-node-hole: var(--vscode-list-hoverBackground, var(--gs-bg));
      }
      .row.selected {
        background: var(--vscode-list-activeSelectionBackground);
        --gs-graph-node-hole: var(--vscode-list-activeSelectionBackground, var(--gs-bg));
      }
      .row.selected .subject,
      .row.selected .who,
      .row.selected .age {
        color: var(--vscode-list-activeSelectionForeground, var(--gs-fg));
      }
      /* Selection reads as a left accent bar, VS Code list-style. */
      .row.selected::before {
        content: "";
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 2px;
        background: var(--gs-accent);
      }
      .rail {
        flex: 0 0 auto;
        pointer-events: none;
      }
      .rail svg { display: block; }

      /* ── Mini author avatar — sits ON the commit node (GitKraken-style).
         Positioned off the row (its transform makes it the containing block),
         at the node's lane x. Same load discipline as the editor graph: the
         initials disc is the always-visible base; the photo starts hidden and
         is revealed only once it truly loads, so a 404/offline fetch can never
         leave a blank circle. ─────────────────────────────────────────────── */
      .avatar {
        position: absolute;
        left: var(--gs-av-x, 14px);
        /* The gutter renderer half-pixel-aligns the node center (cy = 20.5);
           anchor the avatar on the same point so it sits ON the line. */
        top: calc(50% + 0.5px);
        width: ${AVATAR_SIZE}px;
        height: ${AVATAR_SIZE}px;
        transform: translate(-50%, -50%);
        border-radius: 50%;
        overflow: hidden;
        /* A lane-colored ring, then a hole-colored ring so crossing lanes
           never visually fuse into the avatar. */
        box-shadow:
          0 0 0 1.5px var(--gs-av-ring, var(--vscode-focusBorder)),
          0 0 0 3px var(--gs-graph-node-hole);
        pointer-events: none;
        z-index: 1;
      }
      .avatar img {
        /* position:relative so it paints ABOVE the absolutely-positioned
           fallback (positioned siblings beat static ones). Hidden until a
           confirmed load — see onImgLoad. */
        position: relative;
        width: 100%;
        height: 100%;
        display: block;
        object-fit: cover;
        background: transparent;
        opacity: 0;
      }
      .avatar img.is-loaded { opacity: 1; }
      .avatar .fallback {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 6.5px;
        font-weight: 600;
        letter-spacing: 0.02em;
        color: var(--vscode-foreground);
        font-family: var(--vscode-font-family);
        /* A whisper of the author's hue mixed into the surface — identity
           without a rainbow. */
        background: color-mix(in srgb, hsl(var(--gs-av-hue, 210) 45% 50%) 30%, var(--gs-bg));
      }
      /* WIP node: a pencil glyph in an amber-ringed disc. */
      .avatar.wip-node {
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--gs-graph-node-hole);
        color: var(--gs-amber);
        --gs-av-ring: var(--gs-amber);
      }
      .avatar.wip-node .codicon { font-size: 8px; }
      .row.selected .avatar {
        box-shadow:
          0 0 0 1.5px var(--gs-av-ring, var(--vscode-focusBorder)),
          0 0 0 3px var(--vscode-list-activeSelectionBackground, var(--gs-graph-node-hole));
      }

      .body {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        flex-direction: column;
        justify-content: center;
        gap: 1px;
        padding-right: 8px;
      }
      .l1 {
        display: flex;
        align-items: center;
        min-width: 0;
        line-height: 17px;
      }
      .subject {
        flex: 1 1 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        font-size: var(--vscode-font-size, 13px);
      }
      .row.is-merge .subject { color: var(--gs-fg-muted); }
      .row.is-wip .subject {
        font-style: italic;
        color: var(--gs-fg-muted);
      }
      .l2 {
        display: flex;
        align-items: center;
        gap: 5px;
        min-width: 0;
        line-height: 14px;
        font-size: 11px;
        color: var(--gs-fg-muted);
      }
      .who {
        /* Shrinks 4× faster than the chips: the author name is the first
           thing to give way in a narrow sidebar, the age never moves. */
        flex: 0 4 auto;
        min-width: 0;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .age {
        flex: 0 0 auto;
        margin-left: auto;
        color: var(--gs-fg-subtle);
        font-variant-numeric: tabular-nums;
      }

      /* ── Ref micro-chips on the meta line ──────────────────────────────── */
      .chips {
        flex: 0 1 auto;
        display: flex;
        align-items: center;
        gap: 3px;
        min-width: 0;
        overflow: hidden; /* a squeezed chip clips — it never paints over the author */
      }
      .chip {
        flex: 0 1 auto;
        min-width: 30px;
        display: inline-flex;
        align-items: center;
        gap: 3px;
        height: 15px;
        padding: 0 5px;
        border-radius: 8px;
        font-size: 10px;
        line-height: 1;
        max-width: 104px;
        border: 1px solid var(--gs-border);
        background: var(--gs-surface);
        color: var(--gs-fg-muted);
        white-space: nowrap;
      }
      .chip > .name {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .chip .codicon { font-size: 9px; flex: 0 0 auto; }
      .chip.current {
        background: var(--gs-brand);
        border-color: var(--gs-brand);
        color: var(--gs-brand-fg);
      }
      .chip.tag { color: var(--gs-amber); }
      .chip.more {
        flex: 0 0 auto;
        min-width: 0;
        padding: 0 4px;
        color: var(--gs-fg-subtle);
      }
      .chip .cloud { font-size: 9px; opacity: 0.85; }

      /* ── Hover actions (VS Code tree idiom): fade in over a scrim ──────── */
      .acts {
        position: absolute;
        right: 2px;
        top: 2px;
        display: none;
        align-items: center;
        gap: 1px;
        padding: 1px 2px 1px 14px;
        background: linear-gradient(
          to right,
          transparent,
          var(--gs-graph-node-hole) 12px
        );
      }
      .row:hover .acts,
      .row:focus-within .acts { display: inline-flex; }
      .acts .ibtn { width: 19px; height: 19px; color: var(--gs-fg-muted); }
      .acts .ibtn .codicon { font-size: 12px; }

      /* ── Search: matches pop, the rest recede ──────────────────────────── */
      .row.is-nomatch { opacity: 0.35; }
      .row.is-match::after {
        content: "";
        position: absolute;
        left: 0;
        top: 0;
        bottom: 0;
        width: 2px;
        background: color-mix(in srgb, var(--gs-accent-text) 55%, transparent);
      }
      .row.is-cursor {
        background: color-mix(in srgb, var(--gs-accent-text) 12%, transparent);
        --gs-graph-node-hole: var(--gs-bg);
      }

      /* Reveal flash — a wash that decays after the scroll lands. */
      .row.flash { animation: gs-flash 1.2s var(--gs-ease); }
      @keyframes gs-flash {
        0% { background: color-mix(in srgb, var(--gs-accent-text) 22%, transparent); }
        100% { background: transparent; }
      }
      @media (prefers-reduced-motion: reduce) {
        .row.flash { animation: none; }
      }

      /* ── Tail marker under the last row ────────────────────────────────── */
      .tail {
        padding: 10px 8px 14px;
        text-align: center;
        font-size: 10px;
        letter-spacing: 0.4px;
        color: var(--gs-fg-subtle);
        user-select: none;
      }

      /* ── Placeholder states ────────────────────────────────────────────── */
      .state {
        flex: 1 1 auto;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 20px 16px;
        text-align: center;
      }
      .state .codicon { font-size: 22px; color: var(--gs-fg-subtle); }
      .state .t { font-size: 12px; color: var(--gs-fg-muted); }
      .state .s { font-size: 11px; color: var(--gs-fg-subtle); max-width: 220px; }
      .state button {
        margin-top: 6px;
        padding: 3px 12px;
        font-family: inherit;
        font-size: 11px;
        color: var(--gs-fg);
        background: var(--gs-surface);
        border: 1px solid var(--gs-border);
        border-radius: var(--gs-radius-sm);
        cursor: pointer;
      }
      .state button:hover { background: var(--gs-hover); }

      /* Skeleton shimmer while the first page loads. */
      .skel { flex: 1 1 auto; overflow: hidden; padding-top: 2px; }
      .skel .srow {
        display: flex;
        align-items: center;
        height: ${ROW_HEIGHT}px;
        padding: 0 10px 0 0;
      }
      .skel .srail {
        flex: 0 0 18px;
        display: flex;
        align-items: center;
        justify-content: center;
        align-self: stretch;
        position: relative;
      }
      .skel .srail::before {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        width: 1.75px;
        background: var(--gs-border-soft);
      }
      .skel .srail::after {
        content: "";
        width: 7px;
        height: 7px;
        border-radius: 50%;
        background: var(--gs-border);
        position: relative;
      }
      .skel .stext { flex: 1 1 auto; min-width: 0; }
      .skel .b {
        height: 8px;
        border-radius: 4px;
        background: linear-gradient(
          100deg,
          var(--gs-border-soft) 40%,
          var(--gs-border) 50%,
          var(--gs-border-soft) 60%
        );
        background-size: 200% 100%;
        animation: gs-shimmer 1.6s linear infinite;
      }
      .skel .b + .b { margin-top: 7px; }
      .skel .b.w2 { width: 45%; height: 6px; }
      .skel .srow:nth-child(2n) .b.w1 { width: 72%; }
      .skel .srow:nth-child(2n + 1) .b.w1 { width: 88%; }
      .skel .srow:nth-child(3n) .b.w1 { width: 60%; }
      @keyframes gs-shimmer {
        from { background-position: 200% 0; }
        to { background-position: -200% 0; }
      }
      @media (prefers-reduced-motion: reduce) {
        .skel .b { animation: none; }
      }

      /* ── Popovers: search scope + commit actions share the shell ───────── */
      .pop {
        position: fixed;
        z-index: 40;
        min-width: 150px;
        max-width: 240px;
        max-height: calc(100vh - 16px);
        overflow-y: auto;
        padding: 4px;
        border-radius: var(--gs-radius);
        border: 1px solid var(--gs-border);
        background: var(--vscode-menu-background, var(--gs-bg));
        color: var(--vscode-menu-foreground, var(--gs-fg));
        box-shadow: var(--gs-shadow-2);
      }
      .pop .hd {
        padding: 3px 8px 5px;
        font-size: 10px;
        letter-spacing: 0.4px;
        text-transform: uppercase;
        color: var(--gs-fg-subtle);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .pop .mi {
        display: flex;
        align-items: center;
        gap: 7px;
        width: 100%;
        padding: 4px 8px;
        border: 0;
        border-radius: var(--gs-radius-sm);
        background: transparent;
        color: inherit;
        font-family: inherit;
        font-size: 12px;
        text-align: left;
        cursor: pointer;
        white-space: nowrap;
      }
      .pop .mi:hover,
      .pop .mi:focus-visible {
        background: var(--vscode-menu-selectionBackground, var(--gs-hover));
        color: var(--vscode-menu-selectionForeground, var(--gs-fg));
        outline: none;
      }
      .pop .mi .codicon { font-size: 13px; width: 15px; }
      .pop .mi.danger { color: var(--vscode-errorForeground, #f66); }
      .pop .mi .check { margin-left: auto; font-size: 12px; }
      .pop .sep {
        height: 1px;
        margin: 4px 6px;
        background: var(--gs-border-soft);
      }
    `,
  ];

  declare rows: WireRow[];
  declare head: string;
  declare totalColumns: number;
  declare hasMore: boolean;
  declare status: "loading" | "ready" | "empty" | "error";
  declare errorMessage: string;
  private declare searchQuery: string;
  private declare searchScope: RailSearchScope;
  private declare scopeOpen: boolean;
  private declare commitMenu: RailMenu | null;
  private declare selectedSha: string;

  /** Row intents, forwarded to the host by the entry point. */
  onAction: (action: RailAction) => void = () => {};

  /** URLs that have completed a load once — rendered visible immediately on
   * recycled rows so scrolling never flickers the initials disc. */
  private loadedAvatars = new Set<string>();
  private _authorAvatars: Record<string, string> = {};
  /** Host-resolved author photos (lowercased email → URL); repaints in place. */
  set authorAvatars(map: Record<string, string> | undefined) {
    this._authorAvatars = map ?? {};
    this.renderRows();
  }
  get authorAvatars(): Record<string, string> {
    return this._authorAvatars;
  }
  private avatarFor(email: string): string | undefined {
    return email ? this._authorAvatars[email.toLowerCase()] : undefined;
  }

  // Avatar <img> load/error don't bubble — delegated capture-phase handlers on
  // the scroller. Load reveals the photo over the initials base and remembers
  // the URL; error keeps it hidden so the disc stays.
  private onImgLoad = (e: Event): void => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.classList.contains("av-img")) {
      t.classList.add("is-loaded");
      const src = t.getAttribute("src");
      if (src) this.loadedAvatars.add(src);
    }
  };
  private onImgLoadOptions = {
    handleEvent: (e: Event) => this.onImgLoad(e),
    capture: true,
  };
  private onImgError = (e: Event): void => {
    const t = e.target;
    if (t instanceof HTMLImageElement && t.classList.contains("av-img")) {
      t.classList.remove("is-loaded");
    }
  };
  private onImgErrorOptions = {
    handleEvent: (e: Event) => this.onImgError(e),
    capture: true,
  };

  private virtualizer: Virtualizer<HTMLDivElement, HTMLDivElement> | undefined;
  private cleanupVirtualizer: (() => void) | undefined;
  private boundScroller: HTMLDivElement | undefined;
  private palette: readonly string[] = paletteForTheme();
  private disposeTheme: (() => void) | undefined;
  private shaToIndex = new Map<string, number>();
  private loadMoreArmed = true;
  /** Sha to reveal once the virtualizer is live (host reveal can beat it). */
  private pendingReveal: string | undefined;
  /** Sha currently playing the reveal flash. */
  private flashSha = "";
  private flashTimer: ReturnType<typeof setTimeout> | undefined;
  private searchMatches: number[] = [];
  private matchSet = new Set<number>();
  private matchIdx = 0;

  constructor() {
    super();
    this.rows = [];
    this.head = "";
    this.totalColumns = 1;
    this.hasMore = false;
    this.status = "loading";
    this.errorMessage = "";
    this.searchQuery = "";
    this.searchScope = "all";
    this.scopeOpen = false;
    this.commitMenu = null;
    this.selectedSha = "";
    try {
      const s = localStorage.getItem(LS_SEARCH_SCOPE);
      if (s && SEARCH_SCOPES.some((x) => x.id === s)) {
        this.searchScope = s as RailSearchScope;
      }
    } catch {
      /* non-fatal */
    }
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
    this.disposeTheme?.();
    this.disposeTheme = undefined;
    this.teardownVirtualizer();
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    document.removeEventListener("keydown", this.onDocKeyDown, true);
    if (this.flashTimer) clearTimeout(this.flashTimer);
  }

  updated(changed: Map<PropertyKey, unknown>): void {
    if (changed.has("rows")) {
      this.rebuildIndex();
      this.loadMoreArmed = true;
      if (this.searchQuery.trim()) this.computeMatches(false);
    }
    this.syncPopoverListener();

    const scroller = this.renderRoot.querySelector<HTMLDivElement>(".scroller");
    if (scroller) {
      if (!this.virtualizer || this.boundScroller !== scroller) {
        this.setupVirtualizer(scroller);
      } else {
        this.virtualizer.setOptions(this.virtualizerOptions());
      }
      if (this.pendingReveal) {
        const sha = this.pendingReveal;
        this.pendingReveal = undefined;
        this.reveal(sha);
      } else {
        this.renderRows();
      }
    } else {
      this.teardownVirtualizer();
    }
  }

  // ── Virtualizer ─────────────────────────────────────────────────────────

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

  /** PER-ROW rail width: exactly the lanes THIS row uses (its node + every
   * segment crossing it), capped at the strip max. The text hugs the graph
   * like `git log --graph` — a linear stretch pays ~31px even when history
   * fans out elsewhere, instead of reserving a worst-case block of space. */
  private rowRailWidth(row: WireRow): number {
    let maxCol = row.column;
    for (const seg of row.segments) {
      if (seg.fromColumn > maxCol) maxCol = seg.fromColumn;
      if (seg.toColumn > maxCol) maxCol = seg.toColumn;
    }
    const lanes = Math.min(maxCol, MAX_RAIL_LANES - 1) + 1;
    return lanes * PITCH + RAIL_INSET + RAIL_GAP;
  }

  private renderRows(): void {
    const v = this.virtualizer;
    const sizer = this.renderRoot.querySelector<HTMLElement>(".sizer");
    if (!v || !sizer) return;
    v._willUpdate();
    const items = v.getVirtualItems();
    sizer.style.height = `${v.getTotalSize()}px`;

    let lastIndex = -1;
    let out = "";
    for (const item of items) {
      lastIndex = Math.max(lastIndex, item.index);
      out += this.rowHtml(item);
    }
    sizer.innerHTML = out;

    if (
      this.hasMore &&
      this.loadMoreArmed &&
      lastIndex >= this.rows.length - LOAD_MORE_THRESHOLD
    ) {
      this.loadMoreArmed = false;
      this.onAction({ type: "loadMore" });
      // Not reactive on its own — nudge Lit so the tail shows the loading hint.
      this.requestUpdate();
    }
  }

  // ── Row markup ──────────────────────────────────────────────────────────

  private rowHtml(item: VirtualItem): string {
    const row = this.rows[item.index];
    if (!row) return "";
    const railW = this.rowRailWidth(row);
    const isWip = ZERO_SHA_RE.test(row.sha);
    const selected = row.sha === this.selectedSha;
    const searching = this.searchQuery.trim().length > 0;
    const isMatch = searching && this.matchSet.has(item.index);
    const isCursor =
      searching &&
      this.searchMatches.length > 0 &&
      this.searchMatches[this.matchIdx] === item.index;
    const cls =
      "row" +
      (selected ? " selected" : "") +
      (isWip ? " is-wip" : "") +
      (row.isMerge ? " is-merge" : "") +
      (searching ? (isMatch ? " is-match" : " is-nomatch") : "") +
      (isCursor ? " is-cursor" : "") +
      (row.sha === this.flashSha ? " flash" : "");

    // The REAL geometry from the shared gutter renderer — lanes beyond the
    // strip width clip at its edge instead of being remapped. curveSpan keeps
    // the bends taut inside the tall two-line rows (a full-height S at 40px
    // reads as a droopy wobble); the heavier stroke carries at 16px pitch.
    const rail = renderRowGutterSVG(
      row,
      {
        colWidth: PITCH,
        rowHeight: ROW_HEIGHT,
        nodeRadius: NODE_RADIUS,
        nodeInset: RAIL_INSET,
        palette: this.palette,
        curveSpan: 26,
        strokeWidth: 2,
      },
      railW,
    );
    // The mini avatar rides the node — anchored on the EXACT lane-line center
    // (gutter.ts half-pixel-aligns lane x; match it or the icon sits off the
    // line). Skipped only when the node is beyond the strip cap.
    const cx =
      Math.round(row.column * PITCH + PITCH / 2 + RAIL_INSET) + 0.5;
    const ring = this.palette[row.color % this.palette.length] ?? "#888";
    let avatar = "";
    if (cx + AVATAR_SIZE / 2 <= railW) {
      if (isWip) {
        avatar =
          `<span class="avatar wip-node" style="--gs-av-x:${cx}px" aria-hidden="true">` +
          `<span class="codicon codicon-edit"></span></span>`;
      } else {
        const url = this.avatarFor(row.authorEmail) || gravatarUrl(row.authorEmail, 28);
        avatar = avatarHtml(
          row.author,
          row.authorEmail,
          cx,
          ring,
          url,
          this.loadedAvatars.has(url),
        );
      }
    }
    const subject = esc(isWip ? row.subject || "Uncommitted changes" : row.subject);
    const chips = row.refs.length ? this.chipsHtml(row.refs) : "";
    const who = isWip ? "" : esc(shortAuthor(row.author));
    const age = isWip ? "now" : esc(relTime(row.authorDate));

    const tipRefs = row.refs.length
      ? `\n${row.refs.map((r) => r.name).join(", ")}`
      : "";
    const tip = isWip
      ? "Uncommitted changes — open in the Commit Graph for details"
      : `${row.shortSha} · ${row.subject}\n${row.author} · ${absTime(row.authorDate)}${tipRefs}`;

    const acts = isWip
      ? `<span class="acts">` +
        `<button class="ibtn" data-act="open" tabindex="-1" title="Open in Commit Graph"><span class="codicon codicon-link-external"></span></button>` +
        `</span>`
      : `<span class="acts">` +
        `<button class="ibtn" data-act="copy" tabindex="-1" title="Copy SHA ${esc(row.shortSha)}"><span class="codicon codicon-copy"></span></button>` +
        `<button class="ibtn" data-act="open" tabindex="-1" title="Open in Commit Graph"><span class="codicon codicon-link-external"></span></button>` +
        `</span>`;

    return (
      `<div class="${cls}" role="option" data-sha="${row.sha}" data-idx="${item.index}" ` +
      `aria-selected="${selected ? "true" : "false"}" title="${esc(tip)}" ` +
      `style="transform:translateY(${item.start}px)">` +
      `<div class="rail" style="width:${railW}px">${rail}${avatar}</div>` +
      `<div class="body">` +
      `<div class="l1"><span class="subject">${subject}</span></div>` +
      `<div class="l2">${chips}<span class="who">${who}</span><span class="age">${age}</span></div>` +
      `</div>` +
      acts +
      `</div>`
    );
  }

  /** Meta-line ref chips: remote twins fold into locals, capped at 2 + "+N". */
  private chipsHtml(refs: WireRef[]): string {
    const locals = new Map<string, ChipView>();
    const chips: ChipView[] = [];
    for (const ref of refs) {
      if (ref.kind === "head" || ref.kind === "currentHead") {
        const chip: ChipView = {
          kind: ref.kind,
          label: ref.name,
          remotes: [],
          title: ref.name,
        };
        locals.set(ref.name, chip);
        chips.push(chip);
      }
    }
    for (const ref of refs) {
      if (ref.kind === "remoteHead") {
        const slash = ref.name.indexOf("/");
        const local = slash > 0 ? locals.get(ref.name.slice(slash + 1)) : undefined;
        if (local) {
          local.remotes.push(ref.name.slice(0, slash));
          local.title += `, ${ref.name}`;
          continue;
        }
        chips.push({ kind: ref.kind, label: ref.name, remotes: [], title: ref.name });
      } else if (ref.kind === "tag") {
        chips.push({ kind: ref.kind, label: ref.name, remotes: [], title: `tag: ${ref.name}` });
      }
    }

    const visible = chips.slice(0, MAX_CHIPS);
    const rest = chips.slice(MAX_CHIPS);
    let out = `<span class="chips">`;
    for (const chip of visible) {
      const cls =
        "chip" +
        (chip.kind === "currentHead" ? " current" : "") +
        (chip.kind === "tag" ? " tag" : "");
      const icon =
        chip.kind === "tag"
          ? "tag"
          : chip.kind === "remoteHead"
            ? "cloud"
            : "git-branch";
      const cloud =
        chip.remotes.length > 0
          ? `<span class="codicon codicon-cloud cloud" aria-hidden="true"></span>`
          : "";
      out +=
        `<span class="${cls}" title="${esc(chip.title)}">` +
        `<span class="codicon codicon-${icon}" aria-hidden="true"></span>` +
        `<span class="name">${esc(chip.label)}</span>${cloud}</span>`;
    }
    if (rest.length) {
      out += `<span class="chip more" title="${esc(rest.map((c) => c.title).join("\n"))}">+${rest.length}</span>`;
    }
    return out + `</span>`;
  }

  // ── Pointer interaction (delegated on the scroller) ─────────────────────

  private rowFromEvent(e: Event): { sha: string; idx: number } | null {
    const el = (e.composedPath()[0] as HTMLElement | null)?.closest?.(
      ".row",
    ) as HTMLElement | null;
    if (!el?.dataset.sha) return null;
    return { sha: el.dataset.sha, idx: Number(el.dataset.idx ?? -1) };
  }

  private onScrollerClick = (e: MouseEvent): void => {
    const act = (e.composedPath()[0] as HTMLElement | null)?.closest?.(
      "[data-act]",
    ) as HTMLElement | null;
    const hit = this.rowFromEvent(e);
    if (!hit) return;
    if (act) {
      e.preventDefault();
      e.stopPropagation();
      if (act.dataset.act === "open") {
        this.onAction({ type: "open", sha: hit.sha });
      } else if (act.dataset.act === "copy") {
        this.onAction({ type: "copy", text: hit.sha });
      }
      return;
    }
    this.select(hit.sha);
    this.boundScroller?.focus({ preventScroll: true });
  };

  private onScrollerDblClick = (e: MouseEvent): void => {
    const hit = this.rowFromEvent(e);
    if (hit) this.onAction({ type: "open", sha: hit.sha });
  };

  private onScrollerContextMenu = (e: MouseEvent): void => {
    const hit = this.rowFromEvent(e);
    if (!hit) return;
    e.preventDefault();
    this.select(hit.sha);
    this.onAction({ type: "context", sha: hit.sha, x: e.clientX, y: e.clientY });
  };

  private select(sha: string): void {
    if (this.selectedSha === sha) return;
    this.selectedSha = sha;
    this.renderRows();
  }

  // ── Keyboard ────────────────────────────────────────────────────────────

  private onScrollerKeyDown = (e: KeyboardEvent): void => {
    if (!this.rows.length) return;
    const idx = this.shaToIndex.get(this.selectedSha) ?? -1;
    const move = (to: number): void => {
      const i = Math.max(0, Math.min(this.rows.length - 1, to));
      this.selectedSha = this.rows[i].sha;
      this.virtualizer?.scrollToIndex(i, { align: "auto" });
      this.renderRows();
    };
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(idx + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(idx < 0 ? 0 : idx - 1);
        break;
      case "PageDown":
        e.preventDefault();
        move(idx + this.visibleCount());
        break;
      case "PageUp":
        e.preventDefault();
        move(idx - this.visibleCount());
        break;
      case "Home":
        e.preventDefault();
        move(0);
        break;
      case "End":
        e.preventDefault();
        move(this.rows.length - 1);
        break;
      case "Enter":
        if (this.selectedSha) {
          e.preventDefault();
          this.onAction({ type: "open", sha: this.selectedSha });
        }
        break;
      case "ContextMenu":
      case "F10":
        if ((e.key === "F10" && !e.shiftKey) || !this.selectedSha) break;
        e.preventDefault();
        this.onAction({ type: "context", sha: this.selectedSha, x: -1, y: -1 });
        break;
      case "/":
        e.preventDefault();
        this.focusSearch();
        break;
      case "Escape":
        if (this.searchQuery) {
          this.clearSearch();
        } else if (this.selectedSha) {
          this.selectedSha = "";
          this.renderRows();
        }
        break;
    }
  };

  private visibleCount(): number {
    const h = this.boundScroller?.clientHeight ?? 400;
    return Math.max(1, Math.floor(h / ROW_HEIGHT) - 1);
  }

  // ── Public host entry points ────────────────────────────────────────────

  /** Select + center a commit (host `revealCommit`), with a landing flash. */
  reveal(sha: string): void {
    const idx = this.shaToIndex.get(sha);
    if (idx === undefined || !this.virtualizer) {
      this.pendingReveal = sha;
      return;
    }
    this.selectedSha = sha;
    this.flashSha = sha;
    if (this.flashTimer) clearTimeout(this.flashTimer);
    this.flashTimer = setTimeout(() => {
      this.flashSha = "";
      this.renderRows();
    }, 1300);
    this.virtualizer.scrollToIndex(idx, { align: "center" });
    this.renderRows();
  }

  /** Open the host-built commit actions menu as a popover at (x, y). */
  showCommitMenu(
    sha: string,
    x: number,
    y: number,
    title: string,
    items: RailMenuItem[],
  ): void {
    this.scopeOpen = false;
    let px = x;
    let py = y;
    if (x < 0 || y < 0) {
      const row = this.renderRoot.querySelector<HTMLElement>(".row.selected");
      const r = row?.getBoundingClientRect();
      px = r ? r.left + 40 : window.innerWidth / 2;
      py = r ? r.bottom - 4 : window.innerHeight / 2;
    }
    // Clamp so the menu never clips the (narrow) sidebar viewport.
    const estW = 200;
    const estH =
      items.reduce((n, i) => n + (i.sep ? 9 : 26), 0) + 30;
    px = Math.max(4, Math.min(px, window.innerWidth - estW - 4));
    py = Math.max(4, Math.min(py, window.innerHeight - Math.min(estH, 320) - 4));
    this.commitMenu = { sha, x: px, y: py, title, items };
  }

  // ── Popover dismissal ───────────────────────────────────────────────────

  private syncPopoverListener(): void {
    const open = this.scopeOpen || this.commitMenu !== null;
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    document.removeEventListener("keydown", this.onDocKeyDown, true);
    if (open) {
      document.addEventListener("pointerdown", this.onDocPointerDown, true);
      // Escape must dismiss from ANYWHERE — focus often sits on the trigger
      // (the filter button / the clicked row), not inside the popover.
      document.addEventListener("keydown", this.onDocKeyDown, true);
    }
  }

  private onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.scopeOpen = false;
    this.commitMenu = null;
  };

  private onDocPointerDown = (e: Event): void => {
    const inside = e
      .composedPath()
      .some(
        (n) =>
          n instanceof HTMLElement &&
          (n.classList.contains("pop") || n.classList.contains("anchor")),
      );
    if (!inside) {
      this.scopeOpen = false;
      this.commitMenu = null;
    }
  };

  private onPopKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.scopeOpen = false;
      this.commitMenu = null;
      this.boundScroller?.focus({ preventScroll: true });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(
        this.renderRoot.querySelectorAll<HTMLElement>(".pop .mi"),
      );
      if (!items.length) return;
      const active = (this.renderRoot as ShadowRoot).activeElement as HTMLElement | null;
      let i = items.findIndex((x) => x === active);
      i =
        e.key === "ArrowDown"
          ? (i + 1) % items.length
          : (i - 1 + items.length) % items.length;
      items[i]?.focus();
    }
  };

  // ── Search ──────────────────────────────────────────────────────────────

  private focusSearch(): void {
    this.renderRoot.querySelector<HTMLInputElement>(".search input")?.focus();
  }

  private onSearchInput = (e: Event): void => {
    this.searchQuery = (e.target as HTMLInputElement).value;
    this.computeMatches();
    this.renderRows();
  };

  private onSearchKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      this.stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.clearSearch();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      this.boundScroller?.focus({ preventScroll: true });
    }
  };

  private clearSearch(): void {
    this.searchQuery = "";
    this.searchMatches = [];
    this.matchSet.clear();
    this.matchIdx = 0;
    this.renderRows();
  }

  private computeMatches(jump = true): void {
    const q = this.searchQuery.trim().toLowerCase();
    this.searchMatches = [];
    this.matchSet.clear();
    this.matchIdx = 0;
    if (!q) return;
    const scope = this.searchScope;
    for (let i = 0; i < this.rows.length; i++) {
      if (rowMatches(this.rows[i], q, scope)) {
        this.searchMatches.push(i);
        this.matchSet.add(i);
      }
    }
    if (jump && this.searchMatches.length) {
      this.virtualizer?.scrollToIndex(this.searchMatches[0], { align: "auto" });
    }
  }

  private stepMatch(delta: number): void {
    if (!this.searchMatches.length) return;
    this.matchIdx =
      (this.matchIdx + delta + this.searchMatches.length) %
      this.searchMatches.length;
    this.virtualizer?.scrollToIndex(this.searchMatches[this.matchIdx], {
      align: "center",
    });
    this.requestUpdate();
    this.renderRows();
  }

  private setScope(scope: RailSearchScope): void {
    this.searchScope = scope;
    this.scopeOpen = false;
    try {
      localStorage.setItem(LS_SEARCH_SCOPE, scope);
    } catch {
      /* non-fatal */
    }
    this.computeMatches();
    this.renderRows();
    this.focusSearch();
  }

  // ── Template ────────────────────────────────────────────────────────────

  render() {
    return html`
      ${this.headerTpl()}
      ${this.status === "loading"
        ? this.skeletonTpl()
        : this.status === "empty"
          ? this.emptyTpl()
          : this.status === "error"
            ? this.errorTpl()
            : this.listTpl()}
      ${this.scopeOpen ? this.scopePopTpl() : nothing}
      ${this.commitMenu ? this.menuPopTpl(this.commitMenu) : nothing}
    `;
  }

  private headerTpl() {
    const q = this.searchQuery.trim();
    const count = q
      ? this.searchMatches.length
        ? `${this.matchIdx + 1}/${this.searchMatches.length}`
        : "0"
      : "";
    return html`
      <div class="bar">
        <span class="search">
          <span class="codicon codicon-search" aria-hidden="true"></span>
          <input
            type="text"
            placeholder="Search commits"
            aria-label="Search commits (${this.scopeLabel()})"
            .value=${this.searchQuery}
            @input=${this.onSearchInput}
            @keydown=${this.onSearchKeyDown}
          />
          ${q
            ? html`
                <span class="count ${this.searchMatches.length ? "" : "none"}"
                  >${count}</span
                >
                <button
                  class="ibtn nav"
                  title="Previous match (Shift+Enter)"
                  @click=${() => this.stepMatch(-1)}
                >
                  <span class="codicon codicon-chevron-up"></span>
                </button>
                <button
                  class="ibtn nav"
                  title="Next match (Enter)"
                  @click=${() => this.stepMatch(1)}
                >
                  <span class="codicon codicon-chevron-down"></span>
                </button>
                <button
                  class="ibtn"
                  title="Clear (Esc)"
                  @click=${() => {
                    this.clearSearch();
                    this.focusSearch();
                  }}
                >
                  <span class="codicon codicon-close"></span>
                </button>
              `
            : html`
                <button
                  class="ibtn anchor ${this.searchScope !== "all" ? "scoped" : ""}"
                  title="Search in: ${this.scopeLabel()}"
                  aria-haspopup="menu"
                  aria-expanded=${this.scopeOpen ? "true" : "false"}
                  @click=${(e: MouseEvent) => {
                    e.stopPropagation();
                    this.scopeOpen = !this.scopeOpen;
                  }}
                >
                  <span class="codicon codicon-filter"></span>
                </button>
              `}
        </span>
        ${this.head
          ? html`<button
              class="ibtn"
              title="Jump to HEAD"
              @click=${() => this.reveal(this.head)}
            >
              <span class="codicon codicon-target"></span>
            </button>`
          : nothing}
        <button
          class="ibtn"
          title="Refresh"
          @click=${() => this.onAction({ type: "refresh" })}
        >
          <span class="codicon codicon-refresh"></span>
        </button>
      </div>
    `;
  }

  private scopeLabel(): string {
    return SEARCH_SCOPES.find((s) => s.id === this.searchScope)?.label ?? "All";
  }

  private scopePopTpl() {
    const anchor = this.renderRoot
      .querySelector(".anchor")
      ?.getBoundingClientRect();
    const x = Math.max(4, Math.min((anchor?.left ?? 40) - 90, window.innerWidth - 160));
    const y = (anchor?.bottom ?? 28) + 4;
    return html`
      <div
        class="pop"
        role="menu"
        aria-label="Search scope"
        style="left:${x}px;top:${y}px"
        @keydown=${this.onPopKeyDown}
      >
        <div class="hd">Search in</div>
        ${SEARCH_SCOPES.map(
          (s) => html`
            <button
              class="mi"
              role="menuitemradio"
              aria-checked=${this.searchScope === s.id ? "true" : "false"}
              @click=${() => this.setScope(s.id)}
            >
              ${s.label}
              ${this.searchScope === s.id
                ? html`<span class="codicon codicon-check check"></span>`
                : nothing}
            </button>
          `,
        )}
      </div>
    `;
  }

  private menuPopTpl(menu: RailMenu) {
    return html`
      <div
        class="pop"
        role="menu"
        aria-label="Commit actions"
        style="left:${menu.x}px;top:${menu.y}px"
        @keydown=${this.onPopKeyDown}
      >
        <div class="hd">${menu.title}</div>
        ${menu.items.map((item) =>
          item.sep
            ? html`<div class="sep" role="separator"></div>`
            : html`
                <button
                  class="mi ${item.danger ? "danger" : ""}"
                  role="menuitem"
                  @click=${() => {
                    this.commitMenu = null;
                    this.onAction({
                      type: "menuAction",
                      sha: menu.sha,
                      id: item.id,
                    });
                  }}
                >
                  ${item.icon
                    ? html`<span class="codicon codicon-${item.icon}"></span>`
                    : html`<span class="codicon"></span>`}
                  ${item.label}
                </button>
              `,
        )}
      </div>
    `;
  }

  private listTpl() {
    return html`
      <div
        class="scroller"
        role="listbox"
        aria-label="Commits"
        tabindex="0"
        @click=${this.onScrollerClick}
        @dblclick=${this.onScrollerDblClick}
        @contextmenu=${this.onScrollerContextMenu}
        @keydown=${this.onScrollerKeyDown}
        @load=${this.onImgLoadOptions}
        @error=${this.onImgErrorOptions}
      >
        <div class="sizer"></div>
        <div class="tail">
          ${this.hasMore
            ? this.loadMoreArmed
              ? nothing
              : "loading older commits…"
            : "· start of history ·"}
        </div>
      </div>
    `;
  }

  private skeletonTpl() {
    return html`
      <div class="skel" aria-label="Loading history…">
        ${Array.from({ length: 10 }, () => html`
          <div class="srow">
            <span class="srail"></span>
            <span class="stext">
              <div class="b w1"></div>
              <div class="b w2"></div>
            </span>
          </div>
        `)}
      </div>
    `;
  }

  private emptyTpl() {
    return html`
      <div class="state">
        <span class="codicon codicon-git-commit"></span>
        <span class="t">No commits yet</span>
        <span class="s">Your history will appear here after the first commit.</span>
      </div>
    `;
  }

  private errorTpl() {
    return html`
      <div class="state">
        <span class="codicon codicon-warning"></span>
        <span class="t">Couldn't load history</span>
        ${this.errorMessage
          ? html`<span class="s">${this.errorMessage}</span>`
          : nothing}
        <button @click=${() => this.onAction({ type: "refresh" })}>Retry</button>
      </div>
    `;
  }
}

// ── Pure helpers ─────────────────────────────────────────────────────────────

function rowMatches(row: WireRow, q: string, scope: RailSearchScope): boolean {
  switch (scope) {
    case "message":
      return row.subject.toLowerCase().includes(q);
    case "author":
      return (
        row.author.toLowerCase().includes(q) ||
        row.authorEmail.toLowerCase().includes(q)
      );
    case "sha":
      return row.sha.startsWith(q) || row.shortSha.startsWith(q);
    case "refs":
      return row.refs.some((r) => r.name.toLowerCase().includes(q));
    case "all":
      return (
        row.subject.toLowerCase().includes(q) ||
        row.author.toLowerCase().includes(q) ||
        row.sha.startsWith(q) ||
        row.refs.some((r) => r.name.toLowerCase().includes(q))
      );
  }
}

/** "Anton Arnaudov" → "Anton A." — the meta line is 11px; keep it short. */
function shortAuthor(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length < 2) return name;
  const last = parts[parts.length - 1];
  return `${parts[0]} ${last.charAt(0).toUpperCase()}.`;
}

/**
 * Mini node avatar markup — the initials disc is the always-visible base, the
 * photo an enhancement revealed on confirmed load (see onImgLoad). `preloaded`
 * = this URL already loaded once, so a recycled row paints it instantly
 * instead of flashing the disc while the cached image re-fires load.
 */
function avatarHtml(
  author: string,
  email: string,
  cx: number,
  ring: string,
  resolvedUrl: string,
  preloaded: boolean,
): string {
  const hue = avatarHue(email);
  const initials = esc(authorInitials(author, email));
  const cls = preloaded ? "av-img is-loaded" : "av-img";
  return (
    `<span class="avatar" style="--gs-av-hue:${hue};--gs-av-x:${cx}px;` +
    `--gs-av-ring:${esc(ring)}" aria-hidden="true">` +
    `<span class="fallback">${initials}</span>` +
    `<img class="${cls}" src="${esc(resolvedUrl)}" alt="" loading="lazy" decoding="async" />` +
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

/** Compact relative age ("now", "5m", "3h", "2d", "4mo", "1y"). */
function relTime(epochSeconds: number, now = Date.now() / 1000): string {
  const delta = Math.floor(now - epochSeconds);
  if (delta < MINUTE) return "now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h`;
  if (delta < MONTH) return `${Math.floor(delta / DAY)}d`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo`;
  return `${Math.floor(delta / YEAR)}y`;
}

/** Full local timestamp for the row tooltip. */
function absTime(epochSeconds: number): string {
  try {
    return new Date(epochSeconds * 1000).toLocaleString();
  } catch {
    return "";
  }
}

if (!customElements.get("gitstudio-commit-rail")) {
  customElements.define("gitstudio-commit-rail", CommitRail);
}

declare global {
  interface HTMLElementTagNameMap {
    "gitstudio-commit-rail": CommitRail;
  }
}
