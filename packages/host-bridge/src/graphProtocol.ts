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

export type GraphHostMessage =
  | GraphInitMessage
  | GraphAppendMessage
  | GraphConfigMessage
  | GraphCommitDetailsMessage
  | GraphRowStatsMessage
  | GraphRevealMessage;

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
  /** Open a changed file from the details panel as a diff. */
  | { type: "openFile"; sha: string; path: string; wip?: boolean }
  /** A commit action from the details panel's toolbar. */
  | { type: "commitAction"; action: string; sha: string }
  /** Copy text to the clipboard (host-side, CSP-safe). */
  | { type: "copyText"; text: string }
  /** Request CHANGES-column stats for these (visible) shas. */
  | { type: "requestStats"; shas: string[] };
