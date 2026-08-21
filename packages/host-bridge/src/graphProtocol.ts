// Messaging contract for the virtualized commit-graph webview, shared between
// the extension host and the graph webview front-end.
//
// IMPORTANT: this module is TYPE-ONLY and must stay free of any runtime code and
// of any `vscode`/`node`/`monaco` import — the webview (browser context) imports
// it too, and the engine/host-bridge purity guard depends on it staying pure.

import type { CommitDetailsPayload } from "./commitDetailsProtocol";

/** A ref decoration attached to a commit (a branch tip, remote, or tag). */
export interface WireRef {
  /** Display name, e.g. "main", "origin/main", "v1.2.0". */
  name: string;
  /**
   * - `currentHead`: the local branch HEAD currently points at (filled accent).
   * - `head`: another local branch.
   * - `remoteHead`: a remote-tracking branch (origin/…).
   * - `tag`: an annotated/lightweight tag.
   */
  kind: "head" | "remoteHead" | "tag" | "currentHead";
}

/**
 * One row of the rendered graph, flattened for the wire. The lane geometry
 * (`column`, `color`, `segments`) comes straight from the engine's
 * `computeGraphLayout`; the commit metadata is denormalized so the webview can
 * render a row entirely from this object with no extra round-trips.
 */
export interface WireRow {
  sha: string;
  /** Abbreviated sha for the trailing column (typically 7 chars). */
  shortSha: string;
  /** The lane this commit's node sits in. */
  column: number;
  /** Lane-color index 0..palette.length-1 for the node. */
  color: number;
  /** parents.length > 1 — drawn as a hollow/ringed node. */
  isMerge: boolean;
  /**
   * Every lane segment crossing this row, top→bottom. A segment is vertical
   * when `fromColumn === toColumn`, diagonal otherwise; `color` indexes the
   * lane palette.
   */
  segments: WireSegment[];
  subject: string;
  author: string;
  authorEmail: string;
  /** Authored timestamp, epoch seconds. */
  authorDate: number;
  /** Ref chips to render before the subject (current head first). */
  refs: WireRef[];
}

/** A single lane segment spanning one row vertically. Mirrors GraphSegment. */
export interface WireSegment {
  fromColumn: number;
  toColumn: number;
  color: number;
}

// ── Host → webview ──────────────────────────────────────────────────────────

/** Full (re)initialization: replaces the graph with a fresh first page. */
export interface GraphInitMessage {
  type: "graphInit";
  rows: WireRow[];
  /** Sha of the current HEAD commit, for the "you are here" affordance. */
  head: string;
  /** Total columns across the loaded rows, for gutter sizing. */
  totalColumns: number;
  /** True while more pages remain to be loaded on demand. */
  hasMore: boolean;
}

/** A later page appended to the existing graph (infinite scroll). */
export interface GraphAppendMessage {
  type: "graphAppend";
  rows: WireRow[];
  totalColumns: number;
  hasMore: boolean;
}

/** Optional palette override pushed by the host (rarely needed). */
export interface GraphConfigMessage {
  type: "graphConfig";
  lanePalette: string[];
}

/** The selected commit's full details for the docked inspect panel. */
export interface GraphCommitDetailsMessage {
  type: "commitDetails";
  details: CommitDetailsPayload | null;
}

/** Per-row change stats for the CHANGES column (lazy, for visible rows). */
export interface GraphRowStatsMessage {
  type: "rowStats";
  stats: RowStat[];
}

export interface RowStat {
  sha: string;
  files: number;
  additions: number;
  deletions: number;
}

/** Host asks the webview to select + scroll a commit into view. */
export interface GraphRevealMessage {
  type: "revealCommit";
  sha: string;
}

/** Host-resolved author profile photos: lowercased commit-author email → avatar
 * URL (e.g. a GitHub avatar). Best-effort + late-arriving; the webview repaints
 * avatars in place, falling back to Gravatar/initials for unmapped emails. */
export interface GraphAuthorAvatarsMessage {
  type: "authorAvatars";
  avatars: Record<string, string>;
}

/** One item in the in-graph commit actions popover (host builds the list). */
export interface GraphMenuItem {
  /** Action id posted back as `commitMenuAction` (empty for a separator). */
  id: string;
  /** Display label (no codicon markup). */
  label: string;
  /** Optional codicon name shown before the label. */
  icon?: string;
  danger?: boolean;
  sep?: boolean;
}

/** Host asks the webview to open the commit actions menu as an in-graph popover
 * at (x, y) — replaces the native quick-pick so it reads as part of the graph. */
export interface GraphCommitMenuMessage {
  type: "commitMenu";
  sha: string;
  x: number;
  y: number;
  title: string;
  items: GraphMenuItem[];
}

export type GraphHostMessage =
  | GraphInitMessage
  | GraphAppendMessage
  | GraphConfigMessage
  | GraphCommitDetailsMessage
  | GraphRowStatsMessage
  | GraphRevealMessage
  | GraphAuthorAvatarsMessage
  | GraphCommitMenuMessage
  | GraphCommitContainsMessage
  | GraphRebaseChainMessage
  | GraphErrorMessage;

/**
 * Which commits the Commits list may reorder (issue #18).
 *
 * The webview cannot work this out: its rows carry `isMerge` but no parents,
 * and no notion of what is published. So the host answers once per load and
 * sends it down. An empty `shas` means nothing is draggable, which is also what
 * a host that never sends this message produces — so the feature is simply
 * absent rather than broken on a surface that has not opted in.
 */
export interface GraphRebaseChainMessage {
  type: "rebaseChain";
  /** Rewritable commits, NEWEST FIRST, matching the list's own order. */
  shas: string[];
  /** Why the chain ends where it does — shown on the first inert row. */
  stop: "merge" | "published" | "root";
  /** The commit a rebase would run onto. Absent means `--root`. */
  base?: string;
  /**
   * Local branches whose tip is each sha. Drives the opt-in that carries them
   * along with the rewrite; absent means no branch sits on that commit.
   */
  branches?: Record<string, string[]>;
}

/** The graph failed to load — a real git error, distinct from an empty repo
 * (which stays a "graphInit" with no rows). Drives the error placeholder. */
export interface GraphErrorMessage {
  type: "graphError";
  message?: string;
}

/** Lazily-computed answer to "which branches contain this commit?". `sha` is
 * echoed back so a slow reply for a previously-selected commit can be ignored
 * rather than painted onto the wrong one. */
export interface GraphCommitContainsMessage {
  type: "commitContains";
  sha: string;
  /** Local branches first, then remote-tracking, each sorted. */
  branches: string[];
  /** True when the list was capped — render "N+" rather than an exact count. */
  truncated: boolean;
}

// ── Webview → host ──────────────────────────────────────────────────────────

export type GraphWebviewMessage =
  | { type: "ready" }
  /** Primary activation (double-click / Enter): open the commit's details. */
  | { type: "openCommit"; sha: string }
  /** Single-click selection moved to this commit. */
  | { type: "selectCommit"; sha: string }
  /** Right-click on a row: the host shows a context menu at (x, y). */
  | { type: "contextMenu"; sha: string; x: number; y: number }
  /** A direct action request (used by keyboard menu / fallbacks). */
  | { type: "action"; action: string; sha: string }
  /** Near the bottom of the loaded rows: please page in more. */
  | { type: "loadMore" }
  /** Toolbar refresh — reload the graph from the first page. */
  | { type: "refresh" }
  /** Open a changed file from the details panel as a diff. */
  | { type: "openFile"; sha: string; path: string; wip?: boolean }
  /** A commit action from the details panel's toolbar. */
  | { type: "commitAction"; action: string; sha: string }
  /**
   * A drag in the Commits list reordered the rewritable chain (issue #18).
   * `order` is the WHOLE chain in its new display order, newest first — not a
   * delta — so the host never has to replay the drag to know what was meant.
   */
  | {
      type: "reorderCommits";
      order: string[];
      /** Carry local branches pointing into the range along with the rewrite. */
      updateRefs: boolean;
    }
  /** The user picked an item from the in-graph commit actions popover. */
  | { type: "commitMenuAction"; sha: string; id: string }
  /** Copy text to the clipboard (host-side, CSP-safe). */
  | { type: "copyText"; text: string }
  /** Request CHANGES-column stats for these (visible) shas. */
  | { type: "requestStats"; shas: string[] }
  /** Sidebar rail: promote this commit to the full graph panel (open the
   * editor-area Commit Graph revealed + selected at `sha`). */
  | { type: "openInGraph"; sha: string }
  /** The details dock was opened/dismissed in the webview. The host mirrors
   * this so it can tell "already showing that commit" from "showing it, but the
   * user closed the details" — only a fresh reveal re-opens a dismissed dock. */
  | { type: "detailsVisibility"; open: boolean }
  /** The details pane's "in N branches" row was expanded. Containment is a
   * history walk (`git branch --all --contains`) that can be slow on large
   * repos, so it is never computed up front — only when the user asks. */
  | { type: "requestContains"; sha: string };
