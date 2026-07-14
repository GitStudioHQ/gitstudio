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
import { hostTokens } from "../styles/hostTokens";
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
const ROW_HEIGHT = 30;
const COL_WIDTH = 20;
const NODE_RADIUS = 3.5;
const OVERSCAN = 12;
/** Author avatar diameter, px — sits ON the commit node, GitKraken-style. */
const AVATAR_SIZE = 18;
/** Left inset added to every lane so a node avatar at lane 0 isn't clipped. */
const NODE_INSET = 13;
/** Min gutter width so even a linear history reserves room for the avatar. */
const MIN_GUTTER_WIDTH = 44;
/** Cap the *rendered* gutter width so a pathological fan-out can't eat the row. */
const MAX_GUTTER_COLUMNS = 16;
/** Trigger a loadMore when within this many rows of the bottom. */
const LOAD_MORE_THRESHOLD = 60;
/** Cap ref chips shown inline before collapsing into a "+N" overflow pill. */
const MAX_VISIBLE_REFS = 4;
/** The all-zeros sha marks the synthetic "uncommitted changes" (WIP) node. */
const ZERO_SHA_RE = /^0{40}$/;

// ── Resizable / toggleable columns ───────────────────────────────────────────
// The row + colhead grids share a set of CSS custom properties on :host, so a
// drag on a header reflows both. Each toggleable column has: a CSS var carrying
// its track width, a default width, a min/max clamp for dragging, an id used in
// the hidden-set + localStorage, and a `:host(.hide-<id>)` class that collapses
// the track to 0 and hides the cells. Gutter + subject stay the flexible tracks.
interface ColumnSpec {
  /** Stable id: localStorage key suffix + hide-class + popover row. */
  id: "graph" | "refs" | "changes" | "author" | "date" | "sha";
  /** Human label for the Columns popover. */
  label: string;
  /** CSS custom property carrying this column's grid track width. */
  cssVar: string;
  /** Default track width in px. */
  def: number;
  /** Drag clamp, px. */
  min: number;
  max: number;
  /** False = always shown (excluded from the Columns popover / hide set). */
  hideable?: boolean;
}

const COLUMN_SPECS: readonly ColumnSpec[] = [
  // The graph gutter auto-sizes to the lane count; a manual resize overrides
  // that (dbl-click / Home on the grip restores auto). Never hideable.
  { id: "graph", label: "Graph", cssVar: "--gs-gutter-w", def: MIN_GUTTER_WIDTH, min: MIN_GUTTER_WIDTH, max: 480, hideable: false },
  // Branch/Tag is a fixed, resizable track (not auto-fit) so subjects start at
  // the same x on every row — a real scanability win, GitLens-style. Default is
  // lean so empty-ref rows don't waste width; drag wider for busy ref sets.
  { id: "refs", label: "Branch / Tag", cssVar: "--col-refs-w", def: 200, min: 60, max: 360 },
  { id: "changes", label: "Changes", cssVar: "--col-changes-w", def: 108, min: 72, max: 220 },
  { id: "author", label: "Author", cssVar: "--col-author-w", def: 132, min: 72, max: 240 },
  { id: "date", label: "Date", cssVar: "--col-date-w", def: 88, min: 44, max: 170 },
  { id: "sha", label: "SHA", cssVar: "--col-sha-w", def: 62, min: 48, max: 140 },
];
const COLUMN_BY_ID = new Map<string, ColumnSpec>(
  COLUMN_SPECS.map((c) => [c.id, c]),
);
/** Default width (px) for a column id — used to seed the grid template. */
function col(id: ColumnSpec["id"]): number {
  return COLUMN_BY_ID.get(id)!.def;
}

/** localStorage keys (work in both the Electron renderer and VS Code webviews). */
const LS_COL_WIDTHS = "gitstudio.graph.cols.widths";
const LS_COL_HIDDEN = "gitstudio.graph.cols.hidden";
const LS_SEARCH_SCOPE = "gitstudio.graph.search.scope";

/** What the search query matches against. */
export type SearchScope = "all" | "message" | "author" | "sha" | "refs";
const SEARCH_SCOPES: ReadonlyArray<{ id: SearchScope; label: string }> = [
  { id: "all", label: "All" },
  { id: "message", label: "Message" },
  { id: "author", label: "Author" },
  { id: "sha", label: "SHA" },
  { id: "refs", label: "Branch+Tag" },
];

export type GraphAction =
  | { type: "select"; sha: string }
  | { type: "open"; sha: string }
  | { type: "context"; sha: string; x: number; y: number }
  | { type: "menuAction"; sha: string; id: string }
  | { type: "loadMore" }
  | { type: "refresh" }
  | { type: "requestStats"; shas: string[] };

/** One item in the in-graph commit actions popover (from the host). */
export interface CommitMenuItem {
  id: string;
  label: string;
  icon?: string;
  danger?: boolean;
  sep?: boolean;
}

export class CommitGraph extends LitElement {
  // Declared imperatively (no decorators) so the build is independent of the
  // experimental-vs-standard decorator tsconfig toggle. `attribute: false`
  // keeps these as DOM properties, set by the webview entry, never reflected.
  static properties = {
    rows: { attribute: false },
    totalColumns: { attribute: false },
    hasMore: { attribute: false },
    status: { attribute: false },
    errorMessage: { attribute: false },
    head: { attribute: false },
    palette: { state: true },
    selectedSha: { state: true },
    searchQuery: { state: true },
    searchScope: { state: true },
    columnsOpen: { state: true },
    scopeOpen: { state: true },
    commitMenu: { state: true },
  };

  static styles = [hostTokens, codiconStyles, css`
    :host {
      display: flex;
      flex-direction: column;
      height: 100%;
      width: 100%;
      overflow: hidden;
      /* Hole color punched through graph nodes = the surface behind the row.
         Falls through to the editor bg; hover/selected rows override it so the
         node hole tracks the row tint. (The --gs-* scale is inherited from the
         document via graph.css @import "./tokens.css" — only this graph-specific
         var is declared locally.) */
      --gs-graph-node-hole: var(--vscode-editor-background, #1e1e1e);
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

    /* ── Search box + match nav ──────────────────────────────────────────── */
    .gh-search {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      min-width: 200px;
      max-width: 460px;
      flex: 0 1 360px;
      padding: 0 4px 0 9px;
      border-radius: 6px;
      border: 1px solid color-mix(in srgb, var(--vscode-foreground) 14%, transparent);
      background: color-mix(in srgb, var(--vscode-foreground) 5%, var(--vscode-editor-background));
      transition: border-color 140ms ease;
    }
    .gh-search:focus-within {
      border-color: var(--vscode-focusBorder);
    }
    .gh-search > .codicon-search {
      font-size: 13px;
      color: var(--gs-fg-muted);
      flex: 0 0 auto;
    }
    .gh-input {
      flex: 1 1 auto;
      min-width: 0;
      height: 100%;
      border: none;
      outline: none;
      background: transparent;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      font-size: 12px;
    }
    .gh-input::placeholder { color: color-mix(in srgb, var(--vscode-foreground) 42%, transparent); }
    .gh-results {
      flex: 0 0 auto;
      font-size: 11px;
      font-variant-numeric: tabular-nums;
      color: var(--gs-fg-muted);
      padding: 0 2px;
      white-space: nowrap;
    }
    .gh-results.none { color: var(--vscode-charts-red, #f14c4c); }
    .gh-iconbtn {
      flex: 0 0 auto;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: var(--gs-radius-sm);
      background: transparent;
      color: var(--gs-fg-muted);
      cursor: pointer;
      transition: background var(--gs-motion-fast) var(--gs-ease), color var(--gs-motion-fast) var(--gs-ease);
    }
    .gh-iconbtn:hover { background: var(--gs-hover); color: var(--gs-fg); }
    .gh-iconbtn:active { background: color-mix(in srgb, var(--gs-fg) 12%, transparent); }
    .gh-iconbtn:focus-visible {
      outline: 1px solid var(--gs-accent);
      outline-offset: -1px;
      background: var(--gs-hover);
      color: var(--gs-fg);
    }
    .gh-iconbtn .codicon { font-size: 14px; }
    .gh-iconbtn[aria-expanded="true"] {
      background: var(--vscode-list-hoverBackground);
      color: var(--vscode-foreground);
    }
    .gh-refresh { margin-left: 2px; }

    /* ── Anchored popover/menu shell (Columns + search scope share it) ────── */
    .gh-anchor { position: relative; flex: 0 0 auto; display: inline-flex; }
    .gh-pop {
      position: absolute;
      top: calc(100% + 6px);
      right: 0;
      z-index: 20;
      min-width: 176px;
      padding: 5px;
      border-radius: 8px;
      background: var(--vscode-menu-background,
        color-mix(in srgb, var(--vscode-foreground) 6%, var(--vscode-editor-background)));
      border: 1px solid var(--vscode-menu-border,
        color-mix(in srgb, var(--vscode-foreground) 18%, transparent));
      box-shadow: 0 6px 22px color-mix(in srgb, #000 38%, transparent);
      color: var(--vscode-menu-foreground, var(--vscode-foreground));
      animation: gh-pop-in 120ms ease;
    }
    @keyframes gh-pop-in {
      from { opacity: 0; transform: translateY(-3px); }
      to { opacity: 1; transform: translateY(0); }
    }
    @media (prefers-reduced-motion: reduce) {
      .gh-pop { animation: none; }
    }
    /* The commit context popover is positioned at the cursor (fixed), not
       anchored to a header control. */
    .gh-pop.gh-ctx { position: fixed; top: auto; right: auto; min-width: 214px; }
    .gh-menuitem.danger { color: var(--vscode-errorForeground, #e15a5a); }
    .gh-menuitem.danger:hover {
      background: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 16%, transparent);
      color: var(--vscode-errorForeground, #e15a5a);
    }
    .gh-pop-title {
      padding: 4px 8px 5px;
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--vscode-foreground) 50%, transparent);
      user-select: none;
    }
    .gh-menuitem {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      height: 28px;
      padding: 0 8px;
      border: none;
      border-radius: 5px;
      background: transparent;
      color: inherit;
      font-family: var(--vscode-font-family);
      font-size: 12px;
      text-align: left;
      cursor: pointer;
    }
    .gh-menuitem:hover,
    .gh-menuitem:focus-visible {
      background: var(--vscode-menu-selectionBackground, var(--vscode-list-hoverBackground));
      color: var(--vscode-menu-selectionForeground, var(--vscode-foreground));
      outline: none;
    }
    .gh-menuitem .codicon-check {
      flex: 0 0 auto;
      font-size: 13px;
      opacity: 0;
    }
    .gh-menuitem[aria-checked="true"] .codicon-check { opacity: 1; }
    .gh-menuitem .lbl { flex: 1 1 auto; }
    .gh-menuitem[disabled] {
      opacity: 0.5;
      cursor: default;
    }
    .gh-menuitem[disabled]:hover { background: transparent; }
    .gh-pop-sep {
      height: 1px;
      margin: 4px 4px;
      background: color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
    }
    .gh-pop-hint {
      padding: 3px 8px 4px;
      font-size: 10.5px;
      color: color-mix(in srgb, var(--vscode-foreground) 45%, transparent);
    }

    /* ── Search scope trigger (segmented-style button inside the search box) ── */
    .gh-scope {
      display: inline-flex;
      align-items: center;
      gap: 3px;
      height: 20px;
      padding: 0 5px 0 6px;
      margin-right: 1px;
      border: none;
      border-radius: var(--gs-radius-sm);
      background: color-mix(in srgb, var(--gs-fg) 8%, transparent);
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: 11px;
      white-space: nowrap;
      cursor: pointer;
      flex: 0 0 auto;
      transition: background var(--gs-motion-fast) var(--gs-ease);
    }
    .gh-scope:hover { background: color-mix(in srgb, var(--gs-fg) 14%, transparent); }
    .gh-scope:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .gh-scope .codicon-filter { font-size: 11px; opacity: 0.8; }
    .gh-scope .codicon-chevron-down { font-size: 11px; opacity: 0.7; margin-left: -1px; }
    .gh-scope.scoped {
      background: color-mix(in srgb, var(--gs-accent) 22%, transparent);
      color: var(--gs-accent-text);
    }
    .gh-scope-pop { min-width: 150px; }
    /* The scope popover anchors to the search box's scope button (left-ish). */
    .gh-scope-pop { right: auto; left: 0; }

    /* Search highlight: matches glow, the rest recede. */
    .row.is-match {
      background: color-mix(in srgb, var(--vscode-charts-yellow, #e2c08d) 12%, transparent);
      box-shadow: inset 2px 0 0 var(--vscode-charts-yellow, #e2c08d);
    }
    .row.is-nomatch .subject,
    .row.is-nomatch .refs,
    .row.is-nomatch .changes,
    .row.is-nomatch .meta { opacity: 0.4; }
    .row.is-nomatch .avatar { opacity: 0.45; }

    @media (max-width: 560px) {
      .gh-search { min-width: 130px; flex-basis: 200px; }
      /* keep the scope trigger icon-only when space is tight */
      .gh-scope > span:not(.codicon) { display: none; }
    }
    @media (max-width: 420px) { .gh-count { display: none; } }

    /* ── The shared 7-track grid (colhead + every row reference it) ──────
       Gutter + subject are the flexible tracks; the rest are CSS vars so a
       header drag reflows the whole list, and a hidden column collapses to 0.
       Defaults live in the :host var declarations below. */
    :host {
      --gs-grid:
        var(--gs-gutter-w, ${MIN_GUTTER_WIDTH}px)
        clamp(0px, var(--col-refs-w, ${col("refs")}px), 360px)
        minmax(0, 1fr)
        var(--col-changes-w, ${col("changes")}px)
        var(--col-author-w, ${col("author")}px)
        var(--col-date-w, ${col("date")}px)
        var(--col-sha-w, ${col("sha")}px);
    }
    /* refs + subject share a wrapper. In column mode it is display:contents so
       they behave as their own grid tracks; in the sidebar (inline) mode it
       becomes a flex box so the chips flow INLINE before the message. */
    .content { display: contents; min-width: 0; }

    /* ── Responsive: in a narrow host (the Commits SIDEBAR view) drop trailing
       columns from the right so the commit SUBJECT always has room. You must be
       able to READ commit messages even in a slim sidebar — the graph, refs and
       subject stay; date → sha → author → changes fall away as it narrows. The
       hidden data is still on the row's hover tooltip and in the details dock. */
    @media (max-width: 760px) {
      :host {
        --gs-grid:
          var(--gs-gutter-w, ${MIN_GUTTER_WIDTH}px)
          clamp(0px, var(--col-refs-w, ${col("refs")}px), 300px)
          minmax(0, 1fr)
          var(--col-changes-w, ${col("changes")}px)
          var(--col-author-w, ${col("author")}px);
      }
      .colhead .ch-date, .colhead .ch-sha,
      .row .date, .row .sha { display: none; }
    }
    /* ── Sidebar (inline) mode ──────────────────────────────────────────────
       Below ~620px (every practical sidebar width) the refs stop being a fixed
       column — they flow INLINE right before the message, so a commit with no
       refs uses the FULL width instead of starting behind a ~120px empty gap.
       The column header, resize handles and all trailing columns fall away; it
       reads as a clean commit list, not a cramped spreadsheet. */
    @media (max-width: 620px) {
      :host {
        --gs-grid:
          var(--gs-gutter-w, ${MIN_GUTTER_WIDTH}px)
          minmax(0, 1fr);
      }
      /* :host-qualified so these beat the later base .colhead/.col-resize
         rules on specificity, not just source order. */
      :host .colhead { display: none; }
      :host .col-resize { display: none; }
      .row .changes, .row .author, .row .date, .row .sha { display: none; }
      .content { display: flex; align-items: center; gap: 7px; }
      .content .refs {
        display: inline-flex; flex: 0 1 auto; min-width: 0;
        max-width: 58%; margin: 0; padding: 0;
      }
      /* No refs → no chip box → no leading gap: the message starts at the edge. */
      .content .refs:empty { display: none; }
      .content .subject { flex: 1 1 auto; min-width: 0; }
    }

    /* ── Column header row (aligned to the row grid) ──────────────────── */
    .colhead {
      position: relative;
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: var(--gs-grid);
      align-items: center;
      height: 24px;
      padding-right: 12px;
      /* Mirror the rows' selection border so header cells sit exactly over
         their column content. */
      border-left: 2px solid transparent;
      border-bottom: 1px solid color-mix(in srgb, var(--vscode-foreground) 12%, transparent);
      background: color-mix(in srgb, var(--vscode-foreground) 2%, var(--vscode-editor-background));
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.05em;
      text-transform: uppercase;
      color: color-mix(in srgb, var(--vscode-foreground) 50%, transparent);
      user-select: none;
    }
    /* Header cells let the right-edge grip escape (overflow:visible); the label
       text is clipped by its own .ch-label child so it still ellipsizes. */
    .colhead > span {
      position: relative;
      overflow: visible;
      white-space: nowrap;
      padding-left: 2px;
    }
    .colhead .ch-label {
      display: block;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .colhead .ch-graph { padding-left: 4px; }
    /* Chips start 6px into the refs cell — start the header label with them. */
    .colhead .ch-refs { padding-left: 6px; }

    /* ── Column resize handles (grab strips on the right edge of headers) ──
       Pinned flush to the column's right edge, fully inside the track so the
       parent span's box never clips them. A hairline brightens on hover/drag. */
    .col-resize {
      position: absolute;
      top: 0;
      right: 0;
      width: 9px;
      height: 100%;
      cursor: col-resize;
      z-index: 4;
      background:
        linear-gradient(to right, transparent 4px,
          color-mix(in srgb, var(--vscode-foreground) 16%, transparent) 4px,
          color-mix(in srgb, var(--vscode-foreground) 16%, transparent) 5px,
          transparent 5px);
      transition: background 120ms ease;
      touch-action: none;
    }
    .col-resize:hover,
    .col-resize.dragging {
      background:
        linear-gradient(to right, transparent 4px,
          var(--vscode-focusBorder) 4px,
          var(--vscode-focusBorder) 5px,
          transparent 5px);
    }
    .col-resize:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
      border-radius: 2px;
    }
    /* While dragging, lock the cursor + kill text selection document-wide. */
    :host(.col-dragging) { cursor: col-resize; }
    :host(.col-dragging) .scroller,
    :host(.col-dragging) .row,
    :host(.col-dragging) .colhead { user-select: none; }

    /* ── Hidden columns: hide the cells/header (the track is collapsed to 0 on
       the inline :host style by applyColumnStyles, which outranks any saved
       width). These rules only remove the now-empty cells + their grip. */
    :host(.hide-refs) .refs, :host(.hide-refs) .ch-refs,
    :host(.hide-refs) .col-resize[data-col="refs"] { display: none; }
    :host(.hide-changes) .changes, :host(.hide-changes) .ch-changes,
    :host(.hide-changes) .col-resize[data-col="changes"] { display: none; }
    :host(.hide-author) .author, :host(.hide-author) .ch-author,
    :host(.hide-author) .col-resize[data-col="author"] { display: none; }
    :host(.hide-date) .date, :host(.hide-date) .ch-date,
    :host(.hide-date) .col-resize[data-col="date"] { display: none; }
    /* SHA is the last column: no trailing grip (dividers only sit BETWEEN
       columns, Git Graph-style) — the date|sha boundary resizes it. */
    :host(.hide-sha) .sha, :host(.hide-sha) .ch-sha { display: none; }

    /* Whichever column becomes last when trailing columns are hidden must not
       keep a dangling right-edge grip either. */
    :host(.hide-sha) .col-resize[data-col="date"] { display: none; }
    :host(.hide-sha.hide-date) .col-resize[data-col="author"] { display: none; }
    :host(.hide-sha.hide-date.hide-author)
      .col-resize[data-col="changes"][data-invert="0"] { display: none; }

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
      grid-template-columns: var(--gs-grid);
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
      /* Positioned so it paints ABOVE the absolutely-positioned initials
         fallback (positioned siblings always paint over static ones — a
         static img here is permanently covered even after it loads).
         Starts hidden and is revealed ONLY once it confirms a successful load
         (onImgLoad adds .is-loaded). A Gravatar 404 (d=404), a blocked host, or
         an offline fetch therefore never obscures the initials disc with an
         empty box — the disc is the always-visible base, the photo is a
         progressive enhancement painted on top only when it truly arrives. */
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
      font-size: 9px;
      font-weight: 600;
      letter-spacing: 0.02em;
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
      /* A soft, near-neutral disc — a whisper of the author's hue mixed into the
         surface, not a saturated color. Keeps per-author identity without turning
         the avatar column into a rainbow (the loudest "busy" signal in a graph). */
      background: color-mix(in srgb, hsl(var(--gs-av-hue, 210) 45% 50%) 30%, var(--gs-bg, var(--vscode-editor-background, #24262c)));
    }
    /* WIP node: a pencil glyph in a dashed lane-colored ring. */
    .avatar.wip-node {
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--vscode-editor-background);
      color: var(--gs-av-ring, var(--vscode-charts-yellow, #e2c08d));
      box-shadow:
        0 0 0 1.5px var(--gs-av-ring, var(--vscode-charts-yellow, #e2c08d)),
        0 0 0 3px var(--gs-graph-node-hole);
    }
    .avatar.wip-node .codicon { font-size: 11px; }
    .row.is-wip .subject { font-style: italic; color: var(--gs-fg-muted); }

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
      gap: 5px;
      padding: 0 8px 0 6px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
    }
    /* ── Ref chips — clearer, more prominent, AA-legible in both themes ──────
       Each kind is differentiated by hue + icon: local branch (accent), remote
       (cool/neutral + cloud), tag (amber + tag), current HEAD (filled accent +
       "you are here" dot). Every chip composites its tint over the OPAQUE editor
       background (not transparent) so the label contrast can't collapse on a
       selected (accent-filled) row. */
    .chip {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 18px;
      padding: 0 7px;
      border-radius: 5px;
      font-size: 11px;
      font-weight: 550;
      line-height: 18px;
      /* Cap a single long ref so it can't hog the whole column; no min-width, so
         short refs (a 3-char branch, a tag) pack tight instead of each reserving
         a wide slot and pushing the rest into a "+N". */
      max-width: 150px;
      overflow: hidden;
      white-space: nowrap;
      border: 1px solid transparent;
      flex: 0 1 auto;
    }
    /* The text label inside a chip truncates; the icon never shrinks. */
    .chip .nm {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    /* Remote prefix ("origin/") recedes so the branch name carries the chip. */
    .chip .rp { opacity: 0.58; }
    /* Cloud tail on a local chip whose remote twin was folded into it. */
    .chip .tail {
      font-size: 10px;
      flex: 0 0 auto;
      opacity: 0.7;
      margin-left: 1px;
    }
    .chip .ico {
      font-size: 11px;
      flex: 0 0 auto;
      opacity: 0.95;
    }
    /* current HEAD = filled GitStudio violet with a leading "you are here" dot. */
    .chip-current {
      color: var(--gs-brand-fg, #fff);
      background: var(--gs-brand);
      border-color: var(--gs-brand);
      font-weight: 650;
      box-shadow: 0 1px 2px color-mix(in srgb, var(--gs-brand) 40%, transparent);
    }
    .chip-current .dot {
      width: 5px;
      height: 5px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: currentColor;
      box-shadow: 0 0 0 2px color-mix(in srgb, currentColor 35%, transparent);
    }
    /* local branch = accent-tinted, accent text + icon. */
    .chip-head {
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      border-color: color-mix(in srgb,
        var(--vscode-focusBorder) 45%, transparent);
      background: color-mix(in srgb,
        var(--vscode-focusBorder) 16%, var(--vscode-editor-background));
    }
    .chip-head .ico { color: var(--vscode-textLink-foreground, var(--vscode-focusBorder)); }
    /* remote = a distinct cool tint + a muted cloud glyph. */
    .chip-remote {
      color: color-mix(in srgb, var(--vscode-foreground) 88%, var(--vscode-charts-blue, #4aa5ff));
      border-color: color-mix(in srgb, var(--vscode-charts-blue, #6c93c0) 34%, transparent);
      background: color-mix(in srgb, var(--vscode-charts-blue, #6c93c0) 13%, var(--vscode-editor-background));
    }
    .chip-remote .ico { color: color-mix(in srgb, var(--vscode-charts-blue, #6c93c0) 90%, var(--vscode-foreground)); }
    /* tag = amber tinted with a tag glyph. Uses --gs-amber (the legibility-tuned
       gitDecoration "modified" foreground), NOT raw charts-yellow, which fails
       AA as small text on light themes. */
    .chip-tag {
      color: var(--gs-amber);
      border-color: color-mix(in srgb, var(--gs-amber) 40%, transparent);
      background: color-mix(in srgb, var(--gs-amber) 16%, var(--vscode-editor-background));
    }
    .chip-tag .ico { color: var(--gs-amber); }
    /* The "+N" overflow pill must never shrink or ellipsize — it's the count. */
    .chip-overflow {
      color: var(--vscode-foreground);
      background: color-mix(in srgb, var(--vscode-descriptionForeground) 12%, var(--vscode-editor-background));
      border-color: color-mix(in srgb, var(--vscode-descriptionForeground) 24%, transparent);
      padding: 0 6px;
      min-width: 0;
      flex: 0 0 auto;
      overflow: visible;
      cursor: default;
      font-variant-numeric: tabular-nums;
    }
    /* On a selected (accent-filled) row, lift chip contrast a touch so the
       tinted fills don't muddy against the active-selection background. */
    .row.selected .chip-head,
    .row.selected .chip-remote,
    .row.selected .chip-tag,
    .row.selected .chip-overflow {
      background: color-mix(in srgb,
        var(--vscode-editor-background) 78%, transparent);
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
    /* A slim proportional meter: length ~ size of the change (log scale),
       green/red split = add/delete mix. Reads like the commit-details stat
       bars, so the two surfaces speak the same language. */
    .changes .ch-bar {
      display: inline-flex;
      height: 4px;
      border-radius: 2px;
      overflow: hidden;
      flex: 0 0 auto;
      background: color-mix(in srgb, currentColor 16%, transparent);
    }
    .changes .ch-bar i {
      height: 100%;
    }
    .changes .ch-bar i.a {
      background: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #89d185));
    }
    .changes .ch-bar i.d {
      background: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red, #f14c4c));
    }
    .author {
      padding-right: 12px;
    }
    /* Every column is left-aligned (Git Graph-style) — one reading axis. */
    .date {
      padding-right: 12px;
      font-variant-numeric: tabular-nums;
    }
    /* ── SHA cell — click to copy the FULL sha, with inline feedback ──────────
       Interactivity (cursor, hover, copy glyph) is scoped to [data-sha-cell] so
       the empty WIP-row sha cell stays inert. */
    .sha {
      display: inline-flex;
      align-items: center;
      justify-content: flex-start;
      gap: 4px;
      min-width: 0;
      overflow: hidden;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      opacity: 0.8;
      border-radius: 4px;
      transition: color 120ms ease, opacity 120ms ease, background 120ms ease;
    }
    .sha[data-sha-cell] { cursor: pointer; }
    .sha .codicon {
      font-size: 11px;
      opacity: 0;
      transition: opacity 120ms ease;
    }
    .row:hover .sha { opacity: 1; }
    .row:hover .sha[data-sha-cell]:hover {
      color: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      text-decoration: underline;
      text-underline-offset: 2px;
    }
    /* A faint copy glyph fades in on row hover as the affordance cue. */
    .row:hover .sha[data-sha-cell] .codicon-copy { opacity: 0.6; }
    .row:hover .sha[data-sha-cell]:hover .codicon-copy { opacity: 1; }
    /* "Copied" confirmation state (set for ~1s after a successful copy). */
    .sha.copied {
      color: var(--vscode-charts-green, var(--vscode-gitDecoration-addedResourceForeground, #89d185));
      opacity: 1;
      text-decoration: none;
    }
    .sha.copied .codicon-check { opacity: 1; }
    .row.selected .meta {
      color: inherit;
      opacity: 0.85;
    }
    .row.selected .sha { opacity: 1; }

    /* Lane focus (engaged only while hovering the gutter — see onPointerMove):
       unrelated branches recede so the hovered branch stands out. The gutter and
       row chrome dim firmly; the subject stays legible so the list is still
       readable, not blanked out. */
    .scroller.focusing .row:not(.focus-on) .gutter,
    .scroller.focusing .row:not(.focus-on) .refs,
    .scroller.focusing .row:not(.focus-on) .avatar,
    .scroller.focusing .row:not(.focus-on) .changes,
    .scroller.focusing .row:not(.focus-on) .meta {
      opacity: 0.42;
    }
    .scroller.focusing .row:not(.focus-on) .subject { opacity: 0.62; }

    .placeholder {
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 24px;
      color: var(--vscode-descriptionForeground, #9aa0a6);
      font-size: 13px;
      text-align: center;
    }
    .placeholder .ph-icon { font-size: 30px; opacity: 0.45; }
    .placeholder .ph-title {
      font-size: 13px; font-weight: 600; color: var(--vscode-foreground);
    }
    .placeholder .ph-detail {
      font-size: 12px; line-height: 1.5; max-width: 300px; color: var(--gs-fg-muted);
    }
    .placeholder .ph-retry {
      display: inline-flex; align-items: center; gap: 6px;
      margin-top: 4px; height: 26px; padding: 0 12px;
      border-radius: var(--gs-radius-sm); border: 1px solid var(--gs-border);
      background: var(--gs-surface); color: var(--gs-fg);
      cursor: pointer; font-size: 12px; font-family: inherit;
      transition: background var(--gs-motion) var(--gs-ease),
                  border-color var(--gs-motion) var(--gs-ease);
    }
    .placeholder .ph-retry:hover {
      background: var(--gs-hover); border-color: var(--gs-fg-subtle);
    }
    .placeholder .ph-retry:focus-visible {
      outline: 1px solid var(--gs-accent); outline-offset: 1px;
    }
    .placeholder .ph-retry .codicon { font-size: 13px; }
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
  declare status: "loading" | "ready" | "empty" | "error";
  /** Message for the error placeholder — a git failure, NOT an empty repo
      (an empty/fresh repo stays in the "empty" state with its own guidance). */
  declare errorMessage: string;
  /** Sha of the current HEAD commit. */
  declare head: string;

  private declare palette: readonly string[];
  private declare selectedSha: string | undefined;
  private declare searchQuery: string;
  /** What the search query is scoped to match against. */
  private declare searchScope: SearchScope;
  /** Whether the Columns popover / search-scope popover are open. */
  private declare columnsOpen: boolean;
  private declare scopeOpen: boolean;
  /** The open in-graph commit actions popover, or null. Positioned at (x,y). */
  private declare commitMenu: {
    sha: string;
    x: number;
    y: number;
    title: string;
    items: CommitMenuItem[];
  } | null;
  /** Row indices matching the current search, and the cursor into them. */
  private searchMatches: number[] = [];
  private matchSet = new Set<number>();
  private matchIdx = -1;

  /** Host-resolved author photos: lowercased email → avatar URL (e.g. GitHub).
   *  Empty until the host pushes them; a plain DOM property (not a Lit reactive
   *  prop) whose setter repaints the virtualized rows in place. */
  /** URLs whose avatar image has loaded successfully at least once, so recycled
   *  rows can render them visible immediately (no scroll flicker). */
  private loadedAvatars = new Set<string>();
  private _authorAvatars: Record<string, string> = {};
  set authorAvatars(map: Record<string, string> | undefined) {
    this._authorAvatars = map ?? {};
    // Rows are virtualized (raw innerHTML), so a reactive re-render wouldn't
    // touch them — repaint explicitly once the map lands.
    if (this.rows.length > 0) {
      this.renderRows();
    }
  }
  get authorAvatars(): Record<string, string> {
    return this._authorAvatars;
  }
  /** The resolved photo URL for an author email, or undefined to fall back. */
  private avatarFor(email: string): string | undefined {
    return email ? this._authorAvatars[email.toLowerCase()] : undefined;
  }

  /** Per-column widths (px), keyed by column id; persisted to localStorage. */
  private colWidths: Partial<Record<ColumnSpec["id"], number>> = {};
  /** Hidden column ids; persisted to localStorage. */
  private hiddenCols = new Set<ColumnSpec["id"]>();
  /** Live column-drag bookkeeping (null when not dragging). */
  private drag: {
    id: ColumnSpec["id"];
    startX: number;
    startW: number;
    handle: HTMLElement;
    /** True for a divider on the LEFT of its column (drag right = shrink). */
    invert: boolean;
  } | null = null;
  /** Timer that clears the "Copied" sha feedback. */
  private copiedTimer: number | undefined;

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
    this.errorMessage = "";
    this.head = "";
    this.palette = paletteForTheme();
    this.selectedSha = undefined;
    this.searchQuery = "";
    this.searchScope = "all";
    this.columnsOpen = false;
    this.scopeOpen = false;
    this.commitMenu = null;
  }

  connectedCallback(): void {
    super.connectedCallback();
    this.loadColumnPrefs();
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
    this.endColumnDrag();
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = undefined;
    }
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    document.removeEventListener("keydown", this.onDocKeyDown, true);
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
    // Column track widths + hide-classes live on :host and drive both the
    // header and every row; (re)apply them on every update so a Lit re-render
    // (selection, search, popover toggle) never drops them.
    this.applyColumnStyles();
    // A popover being open needs a document-level click-outside/Escape listener.
    this.syncPopoverListener();

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
    // A user-dragged width wins over the lane-count auto-size (reset restores).
    const w = this.colWidths.graph ?? this.gutterWidth();
    this.style.setProperty("--gs-gutter-w", `${w}px`);
  }

  // ── Column preferences: resize, show/hide, persistence ─────────────────────

  /** Load persisted widths + hidden set + search scope from localStorage. */
  private loadColumnPrefs(): void {
    try {
      const raw = localStorage.getItem(LS_COL_WIDTHS);
      if (raw) {
        const obj = JSON.parse(raw) as Record<string, unknown>;
        for (const spec of COLUMN_SPECS) {
          const v = obj[spec.id];
          if (typeof v === "number" && Number.isFinite(v)) {
            this.colWidths[spec.id] = this.clampCol(spec, v);
          }
        }
      }
    } catch {
      /* corrupt/unavailable storage → fall back to defaults */
    }
    try {
      const raw = localStorage.getItem(LS_COL_HIDDEN);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          for (const id of arr) {
            const spec = COLUMN_BY_ID.get(id);
            if (spec && spec.hideable !== false) {
              this.hiddenCols.add(id as ColumnSpec["id"]);
            }
          }
        }
      }
    } catch {
      /* ignore */
    }
    try {
      const s = localStorage.getItem(LS_SEARCH_SCOPE);
      if (s && SEARCH_SCOPES.some((x) => x.id === s)) {
        this.searchScope = s as SearchScope;
      }
    } catch {
      /* ignore */
    }
  }

  private clampCol(spec: ColumnSpec, w: number): number {
    return Math.round(Math.max(spec.min, Math.min(spec.max, w)));
  }

  /** Reflect column widths (as :host CSS vars) + hidden set (as :host classes).
   *  A hidden column's track is forced to 0 on the INLINE style — the saved
   *  width stays in `colWidths` so re-showing restores it, but inline style
   *  outranks the `:host(.hide-*)` stylesheet rule, so we must zero it here or a
   *  previously-resized-then-hidden column would leave a ghost gap. */
  private applyColumnStyles(): void {
    for (const spec of COLUMN_SPECS) {
      // The graph track is owned by applyGutterWidth (auto-size + override).
      if (spec.id === "graph") continue;
      const hidden = this.hiddenCols.has(spec.id);
      const w = this.colWidths[spec.id];
      if (hidden) {
        this.style.setProperty(spec.cssVar, "0px");
      } else if (w !== undefined) {
        this.style.setProperty(spec.cssVar, `${w}px`);
      } else {
        this.style.removeProperty(spec.cssVar);
      }
      this.classList.toggle(`hide-${spec.id}`, hidden);
    }
  }

  private persistWidths(): void {
    try {
      localStorage.setItem(LS_COL_WIDTHS, JSON.stringify(this.colWidths));
    } catch {
      /* storage may be unavailable; non-fatal */
    }
  }

  private persistHidden(): void {
    try {
      localStorage.setItem(LS_COL_HIDDEN, JSON.stringify([...this.hiddenCols]));
    } catch {
      /* non-fatal */
    }
  }

  // ── Column resize (pointer drag on a header handle) ────────────────────────

  private onResizeHandlePointerDown = (e: PointerEvent): void => {
    if (e.button !== 0) return;
    const handle = e.currentTarget as HTMLElement;
    const id = handle.dataset.col as ColumnSpec["id"] | undefined;
    const spec = id ? COLUMN_BY_ID.get(id) : undefined;
    if (!spec) return;
    e.preventDefault();
    e.stopPropagation();
    const startW = this.colWidths[spec.id] ?? this.defaultColWidth(spec);
    const invert = handle.dataset.invert === "1";
    this.drag = { id: spec.id, startX: e.clientX, startW, handle, invert };
    handle.classList.add("dragging");
    this.classList.add("col-dragging");
    try {
      handle.setPointerCapture(e.pointerId);
    } catch {
      /* setPointerCapture can throw if the pointer is already released */
    }
    handle.addEventListener("pointermove", this.onResizePointerMove);
    handle.addEventListener("pointerup", this.onResizePointerUp);
    handle.addEventListener("pointercancel", this.onResizePointerUp);
  };

  private onResizePointerMove = (e: PointerEvent): void => {
    const d = this.drag;
    if (!d) return;
    const spec = COLUMN_BY_ID.get(d.id)!;
    const dx = e.clientX - d.startX;
    const next = this.clampCol(spec, d.startW + (d.invert ? -dx : dx));
    this.colWidths[d.id] = next;
    this.style.setProperty(spec.cssVar, `${next}px`);
  };

  private onResizePointerUp = (): void => {
    if (this.drag) this.persistWidths();
    this.endColumnDrag();
    // Chip fitting is width-aware — recompute the visible window at the new
    // width (during the live drag CSS clipping covers gracefully).
    this.renderRows();
  };

  private endColumnDrag(): void {
    const d = this.drag;
    if (d) {
      d.handle.classList.remove("dragging");
      d.handle.removeEventListener("pointermove", this.onResizePointerMove);
      d.handle.removeEventListener("pointerup", this.onResizePointerUp);
      d.handle.removeEventListener("pointercancel", this.onResizePointerUp);
    }
    this.drag = null;
    this.classList.remove("col-dragging");
  }

  /** Double-click a handle → reset that column to its default width. */
  private onResizeHandleDblClick = (e: MouseEvent): void => {
    const id = (e.currentTarget as HTMLElement).dataset.col as
      | ColumnSpec["id"]
      | undefined;
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    this.resetColumnWidth(id);
  };

  /** Keyboard resize: Left/Right nudge, Home reset (handles are focusable). */
  private onResizeHandleKey = (e: KeyboardEvent): void => {
    const id = (e.currentTarget as HTMLElement).dataset.col as
      | ColumnSpec["id"]
      | undefined;
    const spec = id ? COLUMN_BY_ID.get(id) : undefined;
    if (!spec) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const invert = (e.currentTarget as HTMLElement).dataset.invert === "1";
      const step = (e.shiftKey ? 16 : 6) * (invert ? -1 : 1);
      const cur = this.colWidths[spec.id] ?? this.defaultColWidth(spec);
      const next = this.clampCol(spec, cur + (e.key === "ArrowRight" ? step : -step));
      this.colWidths[spec.id] = next;
      this.style.setProperty(spec.cssVar, `${next}px`);
      this.persistWidths();
      this.renderRows();
    } else if (e.key === "Home") {
      e.preventDefault();
      this.resetColumnWidth(spec.id);
    }
  };

  private resetColumnWidth(id: ColumnSpec["id"]): void {
    const spec = COLUMN_BY_ID.get(id)!;
    delete this.colWidths[id];
    this.style.removeProperty(spec.cssVar);
    if (id === "graph") this.applyGutterWidth(); // back to lane-count auto-size
    this.persistWidths();
    this.renderRows();
  }

  /** Effective default width — the graph column's default is its auto-size. */
  private defaultColWidth(spec: ColumnSpec): number {
    return spec.id === "graph" ? this.gutterWidth() : spec.def;
  }

  // ── Show / hide columns ────────────────────────────────────────────────────

  private toggleColumn(id: ColumnSpec["id"]): void {
    if (COLUMN_BY_ID.get(id)?.hideable === false) return;
    if (this.hiddenCols.has(id)) this.hiddenCols.delete(id);
    else this.hiddenCols.add(id);
    this.persistHidden();
    this.applyColumnStyles();
    this.requestUpdate(); // refresh the popover's checkmarks
  }

  // ── Popovers (Columns + search scope): open/close + dismissal ──────────────

  private toggleColumnsPopover = (e?: Event): void => {
    e?.stopPropagation();
    this.scopeOpen = false;
    this.columnsOpen = !this.columnsOpen;
  };

  private toggleScopePopover = (e?: Event): void => {
    e?.stopPropagation();
    this.columnsOpen = false;
    this.scopeOpen = !this.scopeOpen;
  };

  private closePopovers(): void {
    if (this.columnsOpen || this.scopeOpen) {
      this.columnsOpen = false;
      this.scopeOpen = false;
    }
    if (this.commitMenu) {
      this.commitMenu = null;
    }
  }

  /** Open the in-graph commit actions popover at (x, y). x < 0 → near the
   *  selected row (keyboard menu). Host-driven; replaces the native quick-pick. */
  showCommitMenu(
    sha: string,
    x: number,
    y: number,
    title: string,
    items: CommitMenuItem[],
  ): void {
    this.columnsOpen = false;
    this.scopeOpen = false;
    let px = x;
    let py = y;
    if (x < 0 || y < 0) {
      const row = this.renderRoot.querySelector<HTMLElement>(".row.selected");
      const r = row?.getBoundingClientRect();
      px = r ? r.left + 24 : window.innerWidth / 2;
      py = r ? r.bottom : window.innerHeight / 2;
    }
    this.commitMenu = { sha, x: px, y: py, title, items };
  }

  /** Attach/detach the document click-outside/Escape listeners as popovers
   *  open/close. Escape must dismiss from ANYWHERE — focus often sits on the
   *  trigger (the filter button / the clicked row), not inside the popover, so
   *  the popover's own keydown handler never sees it (same fix as the rail). */
  private syncPopoverListener(): void {
    const open = this.columnsOpen || this.scopeOpen || this.commitMenu !== null;
    document.removeEventListener("pointerdown", this.onDocPointerDown, true);
    document.removeEventListener("keydown", this.onDocKeyDown, true);
    if (open) {
      document.addEventListener("pointerdown", this.onDocPointerDown, true);
      document.addEventListener("keydown", this.onDocKeyDown, true);
    }
  }

  private onDocKeyDown = (e: KeyboardEvent): void => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    this.closePopovers();
  };

  // A pointerdown anywhere outside an open popover (the event re-targets to the
  // host from outside the shadow root) dismisses it. Clicks inside the shadow
  // popover keep `composedPath()` containing a `.gh-pop`, so we leave it open.
  private onDocPointerDown = (e: Event): void => {
    const path = e.composedPath();
    const insidePop = path.some(
      (n) =>
        n instanceof HTMLElement &&
        (n.classList.contains("gh-pop") || n.classList.contains("gh-anchor")),
    );
    if (!insidePop) this.closePopovers();
  };

  private onPopoverKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const wasColumns = this.columnsOpen;
      this.closePopovers();
      // Return focus to the trigger so keyboard users aren't stranded.
      requestAnimationFrame(() => {
        const sel = wasColumns ? ".gh-columns-btn" : ".gh-scope";
        (this.renderRoot.querySelector(sel) as HTMLElement | null)?.focus();
      });
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const items = Array.from(
        this.renderRoot.querySelectorAll<HTMLElement>(".gh-pop .gh-menuitem:not([disabled])"),
      );
      if (!items.length) return;
      const root = this.renderRoot as ShadowRoot;
      const active = (root.activeElement ?? null) as HTMLElement | null;
      let i = items.findIndex((x) => x === active);
      i = e.key === "ArrowDown" ? (i + 1) % items.length : (i - 1 + items.length) % items.length;
      items[i]?.focus();
    }
  };

  // ── Search scope ───────────────────────────────────────────────────────────

  private setSearchScope(scope: SearchScope): void {
    this.searchScope = scope;
    this.scopeOpen = false;
    try {
      localStorage.setItem(LS_SEARCH_SCOPE, scope);
    } catch {
      /* non-fatal */
    }
    this.computeMatches();
    this.renderRows();
    // Refocus the input so the user can keep typing/jumping.
    requestAnimationFrame(() => {
      (this.renderRoot.querySelector(".gh-input") as HTMLInputElement | null)?.focus();
    });
  }

  // ── Click-to-copy the full sha ─────────────────────────────────────────────

  /** Copy a row's FULL sha; flash an inline "Copied" confirmation for ~1s. */
  private copySha(sha: string, cell: HTMLElement): void {
    // Restore any cell still showing a prior "Copied" flash before re-arming, so
    // overlapping copies don't strand a cell in the confirmation state. (The
    // virtualizer may also recycle the node out from under the timer; reading
    // the label off the *current* target keeps the restore correct.)
    if (this.copiedTimer !== undefined) {
      clearTimeout(this.copiedTimer);
      this.copiedTimer = undefined;
    }
    const label = cell.getAttribute("data-label") ?? esc(sha.slice(0, 7));
    const done = () => {
      cell.classList.add("copied");
      cell.innerHTML =
        `<span class="codicon codicon-check" aria-hidden="true"></span>Copied`;
      this.copiedTimer = window.setTimeout(() => {
        cell.classList.remove("copied");
        cell.innerHTML =
          `${label}<span class="codicon codicon-copy" aria-hidden="true"></span>`;
        this.copiedTimer = undefined;
      }, 1000);
    };
    try {
      const p = navigator.clipboard?.writeText(sha);
      if (p && typeof p.then === "function") p.then(done).catch(() => done());
      else done();
    } catch {
      // Even if the clipboard API is unavailable, show feedback so the control
      // never feels dead.
      done();
    }
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
    const adds = Math.max(0, s.additions);
    const dels = Math.max(0, s.deletions);
    const total = adds + dels;
    // Bar length grows with the size of the change (log scale) so big commits
    // read at a glance; the green/red split is the true add/delete proportion,
    // with a floor so a tiny-but-present side never vanishes.
    let bar = "";
    if (total > 0) {
      const barW = Math.round(Math.min(46, 16 + 10 * Math.log10(1 + total)));
      let a = Math.round((adds / total) * 100);
      if (adds > 0 && dels > 0) a = Math.min(90, Math.max(10, a));
      bar =
        `<span class="ch-bar" style="width:${barW}px" title="+${adds} −${dels}">` +
        (adds > 0 ? `<i class="a" style="width:${a}%"></i>` : "") +
        (dels > 0 ? `<i class="d" style="width:${100 - a}%"></i>` : "") +
        `</span>`;
    }
    return (
      `<span class="ch-count" title="${s.files} file${s.files === 1 ? "" : "s"} changed · +${adds} −${dels}">` +
      `<span class="codicon codicon-file"></span>${s.files}</span>` +
      bar
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
    const searching = this.searchQuery.trim().length > 0;
    const isMatch = searching && this.matchSet.has(item.index);
    const isWip = ZERO_SHA_RE.test(row.sha);
    const cls =
      "row" +
      (selected ? " selected" : "") +
      (focusOn ? " focus-on" : "") +
      (isWip ? " is-wip" : "") +
      (searching ? (isMatch ? " is-match" : " is-nomatch") : "");
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
    // node's lane x and ringed in the lane color. The WIP node gets a distinct
    // pencil glyph instead of an author avatar.
    const cx = Math.round(row.column * COL_WIDTH + COL_WIDTH / 2 + NODE_INSET);
    const ring = this.palette[row.color % this.palette.length] ?? "#888";
    const avatarUrl =
      this.avatarFor(row.authorEmail) || gravatarUrl(row.authorEmail, 40);
    const avatar = isWip
      ? `<span class="avatar wip-node" style="--gs-av-x:${cx}px;--gs-av-ring:${esc(ring)}" aria-hidden="true"><span class="codicon codicon-edit"></span></span>`
      : avatarHtml(
          row.author,
          row.authorEmail,
          cx,
          ring,
          avatarUrl,
          this.loadedAvatars.has(avatarUrl),
        );
    const label = esc(
      isWip
        ? "Uncommitted changes"
        : `${row.shortSha}: ${row.subject} — ${row.author}, ${relTime(row.authorDate)}`,
    );
    return (
      `<div class="${cls}" role="row" data-sha="${row.sha}" ` +
      `aria-selected="${selected ? "true" : "false"}" aria-label="${label}" ` +
      `style="transform:translateY(${item.start}px)">` +
      `<div class="gutter">${gutter}${avatar}</div>` +
      `<div class="content">` +
        `<div class="refs">${refs}</div>` +
        `<div class="subject" title="${esc(row.subject)}">${esc(row.subject)}</div>` +
      `</div>` +
      `<div class="changes">${isWip ? "" : this.changesHtml(row.sha)}</div>` +
      `<div class="meta author" title="${esc(row.author)} <${esc(row.authorEmail)}>">${isWip ? "" : esc(row.author)}</div>` +
      `<div class="meta date" title="${esc(absTime(row.authorDate))}">${isWip ? "now" : esc(dateLabel(row.authorDate))}</div>` +
      shaCellHtml(row.sha, row.shortSha, isWip) +
      `</div>`
    );
  }

  private refsHtml(refs: WireRef[]): string {
    // Fold each remote-tracking twin ("origin/foo") into its same-named local
    // branch chip ("foo" gains a cloud tail) — GitKraken-style. This halves the
    // chip clutter on the common local+remote row without losing information
    // (the tooltip names the remotes).
    const locals = new Map<string, ChipEntry>();
    for (const ref of refs) {
      if (ref.kind === "head" || ref.kind === "currentHead") {
        locals.set(ref.name, { ref, remotes: [] });
      }
    }
    const entries: ChipEntry[] = [];
    for (const ref of refs) {
      if (ref.kind === "remoteHead") {
        const slash = ref.name.indexOf("/");
        const local = slash > 0 ? locals.get(ref.name.slice(slash + 1)) : undefined;
        if (local) {
          local.remotes.push(ref.name.slice(0, slash));
          continue;
        }
        entries.push({ ref, remotes: [] });
      } else if (ref.kind === "head" || ref.kind === "currentHead") {
        entries.push(locals.get(ref.name)!);
      } else {
        entries.push({ ref, remotes: [] });
      }
    }

    // Width-aware fit: estimate each chip's rendered width and stop BEFORE the
    // column edge would clip one mid-word; the rest collapse into a "+N" pill
    // whose tooltip lists them. The first chip always renders (CSS min-width +
    // ellipsis keep it legible even in a very narrow column).
    const colW = this.hiddenCols.has("refs")
      ? 0
      : (this.colWidths.refs ?? col("refs"));
    const budget = colW - 14; // .refs horizontal padding
    let used = 0;
    let shown = 0;
    let out = "";
    for (const entry of entries) {
      if (shown >= MAX_VISIBLE_REFS) break;
      const w = estimateChipWidth(entry);
      const reserve = entries.length - shown - 1 > 0 ? 40 : 0; // room for "+N"
      if (shown > 0 && used + w + reserve > budget) break;
      out += chipHtml(entry.ref, entry.remotes);
      used += w + 5; // + .refs flex gap
      shown++;
    }
    const rest = entries.slice(shown);
    // The "+N" pill renders only when it genuinely fits — a clipped pill looks
    // worse than none. In an ultra-narrow column the first chip (which can
    // shrink to its CSS min-width) wins the space.
    if (rest.length > 0 && used + 30 <= budget) {
      const names = rest.map((e) => e.ref.name).join(", ");
      out += `<span class="chip chip-overflow" title="${esc(names)}">+${rest.length}</span>`;
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
    const target = e.target as HTMLElement | null;
    // A click on a copyable SHA cell copies the FULL sha and must NOT select or
    // open the row. Only real sha cells carry [data-sha-cell] (the WIP row's sha
    // cell is empty + non-interactive, so it falls through to normal selection).
    const shaCell = target?.closest(".sha[data-sha-cell]") as HTMLElement | null;
    if (shaCell) {
      const full = (shaCell.closest(".row") as HTMLElement | null)?.dataset.sha;
      if (full) {
        e.preventDefault();
        this.copySha(full, shaCell);
      }
      return;
    }
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
    // Double-click opens the in-graph actions popover (same as right-click), so
    // every sidebar tab behaves the same — no native quick-pick.
    e.preventDefault();
    this.select(sha, false);
    this.onAction({ type: "context", sha, x: e.clientX, y: e.clientY });
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
    // Lane focus is a deliberate affordance: only engage while the pointer is
    // over the graph gutter (the rails). Casually moving across subjects/refs
    // while reading no longer dims the list — that restlessness was the graph's
    // biggest "busy" tell. Off the gutter → focus clears.
    const inGutter = (e.target as HTMLElement | null)?.closest(".gutter");
    const el = inGutter?.closest(".row") as HTMLElement | null;
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

  // Companion to onImgError: a delegated, capture-phase `load` handler (load,
  // like error, does not bubble). The avatar <img> starts hidden (opacity:0);
  // it is revealed ONLY here, once it has genuinely loaded. This makes the
  // initials disc the always-visible base and the photo a pure enhancement —
  // so a 404 / blocked host / offline fetch can never leave a blank avatar, and
  // every recycled virtual row gets a fresh <img> that re-fires load from cache.
  private onImgLoad = (e: Event): void => {
    const t = e.target as HTMLElement | null;
    if (t && t instanceof HTMLImageElement && t.classList.contains("av-img")) {
      t.classList.add("is-loaded");
      // Remember this URL succeeded so future recycled rows render it visible
      // up front (see avatarHtml `preloaded`) — kills the scroll flicker.
      const src = t.getAttribute("src");
      if (src) {
        this.loadedAvatars.add(src);
      }
    }
  };
  private onImgLoadOptions = {
    handleEvent: (e: Event) => this.onImgLoad(e),
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

  // ── Search (highlight + navigate matches across loaded rows) ───────────────

  private onSearchInput = (e: Event): void => {
    this.searchQuery = (e.target as HTMLInputElement).value;
    this.computeMatches();
    this.renderRows();
  };

  private onSearchKey = (e: KeyboardEvent): void => {
    if (e.key === "Enter") {
      e.preventDefault();
      this.gotoMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // Keep this Escape inside the search box: without stopPropagation the
      // composed event also reaches the host's document-level Escape handler,
      // which would collapse the commit-details dock at the same time.
      e.stopPropagation();
      this.clearSearch();
    }
  };

  private clearSearch(): void {
    this.searchQuery = "";
    this.computeMatches();
    this.renderRows();
  }

  private computeMatches(): void {
    const q = this.searchQuery.trim().toLowerCase();
    this.searchMatches = [];
    this.matchSet.clear();
    this.matchIdx = -1;
    if (!q) {
      return;
    }
    const scope = this.searchScope;
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rowMatches(this.rows[i], q, scope)) {
        this.searchMatches.push(i);
        this.matchSet.add(i);
      }
    }
    if (this.searchMatches.length) {
      this.matchIdx = 0;
      this.scrollToMatch();
    }
  }

  /** Whether a row matches the lowercased query under the chosen scope. */
  private rowMatches(r: WireRow, q: string, scope: SearchScope): boolean {
    switch (scope) {
      case "message":
        return r.subject.toLowerCase().includes(q);
      case "author":
        return (
          r.author.toLowerCase().includes(q) ||
          r.authorEmail.toLowerCase().includes(q)
        );
      case "sha":
        // SHA is prefix-matched against the full sha (so a long paste still hits).
        return r.sha.toLowerCase().startsWith(q) || r.shortSha.toLowerCase().startsWith(q);
      case "refs":
        return r.refs.some((ref) => ref.name.toLowerCase().includes(q));
      case "all":
      default:
        return (
          r.subject.toLowerCase().includes(q) ||
          r.author.toLowerCase().includes(q) ||
          r.authorEmail.toLowerCase().includes(q) ||
          r.sha.toLowerCase().startsWith(q) ||
          r.refs.some((ref) => ref.name.toLowerCase().includes(q))
        );
    }
  }

  private gotoMatch(delta: number): void {
    if (!this.searchMatches.length) {
      return;
    }
    this.matchIdx =
      (this.matchIdx + delta + this.searchMatches.length) % this.searchMatches.length;
    this.scrollToMatch();
  }

  private scrollToMatch(): void {
    const idx = this.searchMatches[this.matchIdx];
    const row = this.rows[idx];
    if (row) {
      this.select(row.sha, true);
    }
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
    const q = this.searchQuery.trim();
    const results = q
      ? this.searchMatches.length
        ? `${this.matchIdx + 1}/${this.searchMatches.length}`
        : "No results"
      : "";
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
      <span class="gh-search ${q ? "active" : ""}">
        <span class="codicon codicon-search" aria-hidden="true"></span>
        ${this.scopeControlHtml()}
        <input
          class="gh-input"
          type="text"
          placeholder=${this.searchPlaceholder()}
          aria-label="Search commits"
          .value=${this.searchQuery}
          @input=${this.onSearchInput}
          @keydown=${this.onSearchKey}
        />
        ${q
          ? html`<span class="gh-results ${this.searchMatches.length ? "" : "none"}"
                >${results}</span
              >
              <button
                class="gh-iconbtn"
                title="Previous match (Shift+Enter)"
                @click=${() => this.gotoMatch(-1)}
              >
                <span class="codicon codicon-chevron-up"></span></button
              ><button
                class="gh-iconbtn"
                title="Next match (Enter)"
                @click=${() => this.gotoMatch(1)}
              >
                <span class="codicon codicon-chevron-down"></span></button
              ><button
                class="gh-iconbtn"
                title="Clear search (Esc)"
                @click=${() => this.clearSearch()}
              >
                <span class="codicon codicon-close"></span>
              </button>`
          : nothing}
      </span>
      ${this.columnsControlHtml()}
      <button
        class="gh-iconbtn gh-refresh"
        title="Refresh"
        @click=${() => this.onAction({ type: "refresh" })}
      >
        <span class="codicon codicon-refresh"></span>
      </button>
    </div>`;
  }

  private searchPlaceholder(): string {
    switch (this.searchScope) {
      case "message": return "Search messages…";
      case "author": return "Search authors…";
      case "sha": return "Search SHA…";
      case "refs": return "Search branches & tags…";
      default: return "Search commits, authors, refs…";
    }
  }

  /** The scope segmented-button + its dropdown, sitting inside the search box.
      Compact by default (just a filter glyph); when a non-"All" scope is active
      it shows the scope label so the constraint is always visible. */
  private scopeControlHtml() {
    const cur = SEARCH_SCOPES.find((s) => s.id === this.searchScope) ?? SEARCH_SCOPES[0];
    const scoped = this.searchScope !== "all";
    return html`<span class="gh-anchor">
      <button
        class="gh-scope ${scoped ? "scoped" : ""}"
        type="button"
        title=${`Search scope: ${cur.label}`}
        aria-label=${`Search scope: ${cur.label}`}
        aria-haspopup="menu"
        aria-expanded=${this.scopeOpen ? "true" : "false"}
        @click=${this.toggleScopePopover}
        @keydown=${this.onPopoverKeyDown}
      >
        <span class="codicon codicon-filter" aria-hidden="true"></span>
        ${scoped ? html`<span>${cur.label}</span>` : nothing}
        <span class="codicon codicon-chevron-down" aria-hidden="true"></span>
      </button>
      ${this.scopeOpen
        ? html`<div
            class="gh-pop gh-scope-pop"
            role="menu"
            aria-label="Search scope"
            @keydown=${this.onPopoverKeyDown}
          >
            <div class="gh-pop-title">Search in</div>
            ${SEARCH_SCOPES.map(
              (s) => html`<button
                class="gh-menuitem"
                role="menuitemradio"
                aria-checked=${this.searchScope === s.id ? "true" : "false"}
                @click=${() => this.setSearchScope(s.id)}
              >
                <span class="codicon codicon-check" aria-hidden="true"></span>
                <span class="lbl">${s.label}</span>
              </button>`,
            )}
          </div>`
        : nothing}
    </span>`;
  }

  /** The "Columns" button + show/hide popover. */
  private columnsControlHtml() {
    const hiddenCount = this.hiddenCols.size;
    return html`<span class="gh-anchor">
      <button
        class="gh-iconbtn gh-columns-btn"
        type="button"
        title="Columns"
        aria-label="Show or hide columns"
        aria-haspopup="menu"
        aria-expanded=${this.columnsOpen ? "true" : "false"}
        @click=${this.toggleColumnsPopover}
        @keydown=${this.onPopoverKeyDown}
      >
        <span class="codicon codicon-list-flat" aria-hidden="true"></span>
      </button>
      ${this.columnsOpen
        ? html`<div
            class="gh-pop"
            role="menu"
            aria-label="Toggle columns"
            @keydown=${this.onPopoverKeyDown}
          >
            <div class="gh-pop-title">Columns</div>
            ${COLUMN_SPECS.filter((s) => s.hideable !== false).map((spec) => {
              const visible = !this.hiddenCols.has(spec.id);
              return html`<button
                class="gh-menuitem"
                role="menuitemcheckbox"
                aria-checked=${visible ? "true" : "false"}
                @click=${() => this.toggleColumn(spec.id)}
              >
                <span class="codicon codicon-check" aria-hidden="true"></span>
                <span class="lbl">${spec.label}</span>
              </button>`;
            })}
            <div class="gh-pop-sep"></div>
            <div class="gh-pop-hint">
              ${hiddenCount === 0
                ? "Graph & message are always shown"
                : `${hiddenCount} hidden · drag header edges to resize`}
            </div>
          </div>`
        : nothing}
    </span>`;
  }

  render() {
    const header = this.headerHtml();
    if (this.status === "error") {
      return html`${header}<div class="placeholder">
          <span class="ph-icon codicon codicon-warning"></span>
          <div class="ph-title">Couldn't load the history</div>
          ${this.errorMessage
            ? html`<div class="ph-detail">${this.errorMessage}</div>`
            : nothing}
          <button class="ph-retry" @click=${() => this.onAction({ type: "refresh" })}>
            <span class="codicon codicon-refresh"></span> Retry
          </button>
        </div>${nothing}`;
    }
    if (this.status === "empty") {
      return html`${header}<div class="placeholder">
          <span class="ph-icon codicon codicon-git-commit"></span>
          <div class="ph-title">No commits yet</div>
          <div class="ph-detail">Make your first commit and the history will appear here.</div>
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
        @load=${this.onImgLoadOptions}
      >
        <div class="sizer"></div>
      </div>${this.commitMenu ? this.renderCommitMenu() : nothing}`;
  }

  /** The in-graph commit actions popover (fixed at the cursor, clamped). */
  private renderCommitMenu() {
    const m = this.commitMenu;
    if (!m) {
      return nothing;
    }
    // Clamp to the viewport (approx sizes; refined once measured is fine).
    const W = 220;
    const H = 34 + m.items.length * 28;
    const left = Math.max(6, Math.min(m.x, window.innerWidth - W - 6));
    const top = Math.max(6, Math.min(m.y, window.innerHeight - H - 6));
    const pick = (id: string) => {
      const sha = m.sha;
      this.commitMenu = null;
      if (id) {
        this.onAction({ type: "menuAction", sha, id });
      }
    };
    return html`<div
      class="gh-pop gh-ctx"
      role="menu"
      style="left:${Math.round(left)}px;top:${Math.round(top)}px"
      @keydown=${(e: KeyboardEvent) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          this.commitMenu = null;
        }
      }}
    >
      <div class="gh-pop-title">${m.title}</div>
      ${m.items.map((it) =>
        it.sep
          ? html`<div class="gh-pop-sep"></div>`
          : html`<button
              class="gh-menuitem${it.danger ? " danger" : ""}"
              role="menuitem"
              @click=${() => pick(it.id)}
            >
              ${it.icon
                ? html`<span class="codicon codicon-${it.icon}"></span>`
                : nothing}
              <span class="lbl">${it.label}</span>
            </button>`,
      )}
    </div>`;
  }

  /** GitLens-style column headers, aligned to the row grid, with resize grips.
      Each resizable header carries a grip on its right edge; the flexible
      subject + gutter columns have none. The refs grip resizes the Branch/Tag
      track that sits to the LEFT of the subject. */
  private colHeadHtml() {
    return html`<div class="colhead">
      <span class="ch-graph"
        ><span class="ch-label">Graph</span>${this.resizeHandle("graph")}</span
      >
      <span class="ch-refs"
        ><span class="ch-label">Branch / Tag</span>${this.resizeHandle("refs")}</span
      >
      <span class="ch-subject"
        ><span class="ch-label">Commit message</span>${this.resizeHandle(
          "changes",
          true,
        )}</span
      >
      <span class="ch-changes"
        ><span class="ch-label">Changes</span>${this.resizeHandle("changes")}</span
      >
      <span class="ch-author"
        ><span class="ch-label">Author</span>${this.resizeHandle("author")}</span
      >
      <span class="ch-date"
        ><span class="ch-label">Date</span>${this.resizeHandle("date")}</span
      >
      <span class="ch-sha"><span class="ch-label">SHA</span></span>
    </div>`;
  }

  /** A drag handle pinned to the right edge of a resizable column header.
      `invert = true` places the SAME divider on the hosting header's right
      edge but resizes the NAMED column inversely — used for the Commit
      message / Changes boundary (dragging right widens the message). */
  private resizeHandle(id: ColumnSpec["id"], invert = false) {
    const spec = COLUMN_BY_ID.get(id)!;
    const w = this.colWidths[id] ?? this.defaultColWidth(spec);
    return html`<span
      class="col-resize"
      data-col=${id}
      data-invert=${invert ? "1" : "0"}
      role="separator"
      aria-orientation="vertical"
      aria-label=${invert
        ? "Resize Commit message / Changes divider"
        : `Resize ${spec.label} column`}
      aria-valuenow=${Math.round(w)}
      aria-valuemin=${spec.min}
      aria-valuemax=${spec.max}
      tabindex="0"
      @pointerdown=${this.onResizeHandlePointerDown}
      @dblclick=${this.onResizeHandleDblClick}
      @keydown=${this.onResizeHandleKey}
    ></span>`;
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

/** A ref chip to render: the ref plus any remotes folded into it. */
interface ChipEntry {
  ref: WireRef;
  /** Remote names ("origin") whose same-named branch was merged into this chip. */
  remotes: string[];
}

/** Cloud tail marking a local chip that also exists on the listed remotes. */
function tailHtml(remotes: string[]): string {
  return remotes.length
    ? '<span class="tail codicon codicon-cloud" aria-hidden="true"></span>'
    : "";
}

/** Chip label; a remote chip's "origin/" prefix is visually muted. */
function refNameHtml(ref: WireRef): string {
  if (ref.kind === "remoteHead") {
    const i = ref.name.indexOf("/");
    if (i > 0) {
      return (
        `<span class="nm"><span class="rp">${esc(ref.name.slice(0, i + 1))}</span>` +
        `${esc(ref.name.slice(i + 1))}</span>`
      );
    }
  }
  return `<span class="nm">${esc(ref.name)}</span>`;
}

/**
 * Estimated rendered chip width (px) for the width-aware fit: padding + border
 * + leading glyph + ~6px/char of 11px label text + optional cloud tail, clamped
 * to the chip CSS min/max. An estimate is fine — chips can still shrink a few
 * px via flex, and the fit only decides how many chips to attempt.
 */
function estimateChipWidth(entry: ChipEntry): number {
  const w = 16 + 15 + entry.ref.name.length * 6 + (entry.remotes.length ? 15 : 0);
  return Math.max(46, Math.min(150, w));
}

function chipHtml(ref: WireRef, remotes: string[] = []): string {
  const nm = refNameHtml(ref);
  const tail = tailHtml(remotes);
  const also = remotes.length ? ` · also on ${esc(remotes.join(", "))}` : "";
  switch (ref.kind) {
    case "currentHead":
      return `<span class="chip chip-current" title="${esc(ref.name)} (current HEAD${also})">${CURRENT_DOT}${nm}${tail}</span>`;
    case "head":
      return `<span class="chip chip-head" title="${esc(ref.name)} (local branch${also})">${BRANCH_ICON}${nm}${tail}</span>`;
    case "remoteHead":
      return `<span class="chip chip-remote" title="${esc(ref.name)} (remote branch)">${REMOTE_ICON}${nm}</span>`;
    case "tag":
      return `<span class="chip chip-tag" title="${esc(ref.name)} (tag)">${TAG_ICON}${nm}</span>`;
  }
}

/**
 * The trailing SHA cell — a click-to-copy affordance. Shows the short sha + a
 * faint copy glyph (revealed on row hover via CSS). `data-sha-cell` marks it for
 * the delegated copy handler; `data-label` lets the "Copied" flash restore the
 * original text exactly. The WIP row renders an empty, non-interactive cell.
 */
function shaCellHtml(fullSha: string, shortSha: string, isWip: boolean): string {
  if (isWip) {
    return `<div class="meta sha" data-wip="1"></div>`;
  }
  const short = esc(shortSha);
  return (
    `<div class="meta sha" data-sha-cell="1" data-label="${short}" ` +
    `title="Click to copy ${esc(fullSha)}">` +
    `${short}<span class="codicon codicon-copy" aria-hidden="true"></span>` +
    `</div>`
  );
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
  resolvedUrl: string,
  preloaded: boolean,
): string {
  const hue = avatarHue(email);
  const initials = esc(authorInitials(author, email));
  const url = esc(resolvedUrl);
  // `preloaded` = this exact URL already loaded once (tracked in loadedAvatars).
  // Render it visible IMMEDIATELY so a row recycled during scroll shows the
  // cached photo instantly instead of flashing the initials disc while it waits
  // for a fresh load event — the flicker. A first-ever load still starts hidden
  // and is revealed by onImgLoad, over the disc base (a 404 stays hidden).
  const cls = preloaded ? "av-img is-loaded" : "av-img";
  return (
    `<span class="avatar" style="--gs-av-hue:${hue};--gs-av-x:${cx}px;` +
    `--gs-av-ring:${esc(ring)}" aria-hidden="true">` +
    `<span class="fallback">${initials}</span>` +
    `<img class="${cls}" src="${url}" alt="" loading="lazy" decoding="async" />` +
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

/**
 * The DATE cell label: relative while it's still "today news" (now/5m/3h),
 * then a real calendar date — a column of "2y" rows carries no information,
 * while "Jun 12, 2024" places a commit instantly. Year is dropped for the
 * current year to keep the column lean.
 */
function dateLabel(epochSeconds: number, now = Date.now() / 1000): string {
  if (now - epochSeconds < DAY) {
    return relTime(epochSeconds, now);
  }
  try {
    const d = new Date(epochSeconds * 1000);
    const sameYear = d.getFullYear() === new Date(now * 1000).getFullYear();
    return d.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      ...(sameYear ? {} : { year: "numeric" }),
    });
  } catch {
    return relTime(epochSeconds, now);
  }
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
