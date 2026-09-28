// Messaging contract for the virtualized commit-graph webview, shared between
// the extension host and the graph webview front-end.
//
// IMPORTANT: this module is TYPE-ONLY and must stay free of any runtime code and
// of any `vscode`/`node`/`monaco` import — the webview (browser context) imports
// it too, and the engine/host-bridge purity guard depends on it staying pure.

import type { CommitDetailsPayload } from "./commitDetailsProtocol";

/** A ref decoration attached to a commit (a branch tip, remote, or tag). */
export interface WireRef {
  /**
   * git's `%(refname:short)`: "main", "origin/main", "v1.2.0" — but only
   * SHORTEST UNAMBIGUOUS, so beside a tag "release" the branch is
   * "heads/release" and the tag "tags/release". Kept for the hosts that look a
   * ref up by the name git lists it under (the desktop's Branches view). Never
   * the chip's label, and never a key: see `fullName`.
   */
  name: string;
  /**
   * The full name, "refs/heads/release" (issue #30's follow-up). What a chip is
   * LABELLED by (shorn of its namespace: "release"), what twins fold by
   * (refs/remotes/<remote>/<branch> onto refs/heads/<branch>), and what a chip
   * resolves to in the picker's list.
   */
  fullName: string;
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

/**
 * One entry in the graph's Branches picker (issue #30): EVERY branch and tag
 * the repository has, whether or not the current filter shows it — a ref that
 * is filtered out still has to be listed, or it could never be ticked back in.
 */
export interface GraphRefEntry {
  /** Fully-qualified name — what the filter stores and `git log` is handed. */
  fullName: string;
  /** Short display name: "main", "origin/main", "v1.2.0". */
  name: string;
  kind: "head" | "remoteHead" | "tag";
  /** The local branch HEAD is on. */
  isCurrent?: boolean;
  /** The fully-qualified upstream of a local branch, when it tracks one that
   *  exists — what the "Current + upstream" preset ticks. */
  upstream?: string;
}

/**
 * The branch filter: the fully-qualified refs the graph is built around, or
 * null for every branch, tag and remote. A selection is never an empty list —
 * deselecting the last ref falls back to null, because a graph of nothing is
 * not a graph.
 *
 * What is STORED and SENT (setRefFilter) may also hold the presets' symbolic
 * entries (CURRENT_BRANCH and friends, graphRefFilter.ts), which follow HEAD
 * rather than name a branch. What a graphInit carries is always resolved: full
 * names only, the preset beside it in `refPreset`. That one may be EMPTY —
 * "Current branch" on a detached HEAD walks HEAD alone.
 */
export type GraphRefFilter = string[] | null;

/** The Branches picker's presets (issue #30). */
export type RefPreset = "current" | "currentUpstream" | "local" | "all";

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
  /**
   * No repository is open: the rows are empty because there is nothing to
   * read, not because the history is. The graph says so, instead of "No
   * commits yet".
   */
  noRepo?: boolean;
  /**
   * No repository YET: none is active, but the first discovery has not
   * settled (vscode.git's scan can still find one below the opened folder).
   * The graph says it is looking, as the Changes view above the rail does;
   * the host sends `noRepo` instead once discovery settles with nothing.
   */
  discovering?: boolean;
  /** The filter these rows were built under, RESOLVED to full names (see
   *  GraphRefFilter) — what the picker ticks. */
  refFilter: GraphRefFilter;
  /**
   * The preset the stored filter is, when it is one ("current", …) — so the
   * picker highlights it and the trigger says "Current branch (main)" after a
   * branch switch as before it. Absent for a hand-picked selection and for
   * every branch.
   */
  refPreset?: RefPreset;
  /**
   * Every ref the picker can offer — the filtered-out ones included — sent
   * only when it CHANGED since this host last sent one to this webview.
   *
   * Absent means "unchanged": the webview keeps the list it has. It is every
   * branch and tag in the repository (about 1 MB with ten thousand tags), and
   * a refresh or a filter change almost never alters it. A host tracks what it
   * sent with RefListCourier (graphRefFilter.ts) and starts over when the
   * webview reloads, so a fresh page always gets one with its first graphInit.
   */
  refList?: GraphRefEntry[];
}

/** A later page appended to the existing graph (infinite scroll). */
export interface GraphAppendMessage {
  type: "graphAppend";
  rows: WireRow[];
  totalColumns: number;
  hasMore: boolean;
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
  /**
   * Shas the host could not answer THIS time — the whole `git log --numstat`
   * batch failed — as opposed to a sha git skipped, which is answered with
   * zeros in `stats` and never asked about again. The webview releases these
   * without recording them, so the next repaint asks again (see
   * CommitGraph.failRowStats). Absent when every sha got its answer.
   */
  unanswered?: string[];
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

/**
 * Whether the page may look commit authors' pictures up on the internet: the
 * extension's `gitstudio.avatars.gravatar` setting. The host posts it before
 * its first graphInit and again whenever the setting changes (the desktop,
 * which has no webview between it and the graph, sets it directly — see
 * webview-ui's setGravatarEnabled).
 *
 * Off, the page produces no Gravatar URL, so nothing is requested from
 * www.gravatar.com — nor, for a GitHub noreply address, from
 * avatars.githubusercontent.com — and every author is drawn as initials.
 * Photos the HOST resolved (`authorAvatars`, from a signed-in GitHub
 * account's data) are separate, and still shown.
 */
export interface GraphAvatarPrefsMessage {
  type: "avatarPrefs";
  gravatar: boolean;
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
  /**
   * The menu is for SEVERAL commits (issue #32): the selection it was asked
   * for, newest first. The webview hands them back with the item picked
   * (`commitMenuAction.shas`). Absent for one commit's menu.
   */
  shas?: string[];
  x: number;
  y: number;
  title: string;
  items: GraphMenuItem[];
}

/**
 * The details pane's answer to a multi-selection (issue #32): what the host
 * offers for these commits — the same items as their right-click menu — for
 * the "N commits selected" summary. `shas` is echoed so a late answer for a
 * selection that has since changed is dropped rather than shown.
 */
export interface GraphCommitsSummaryMessage {
  type: "commitsSummary";
  shas: string[];
  items: GraphMenuItem[];
}

export type GraphHostMessage =
  | GraphInitMessage
  | GraphAppendMessage
  | GraphCommitDetailsMessage
  | GraphRowStatsMessage
  | GraphRevealMessage
  | GraphAuthorAvatarsMessage
  | GraphAvatarPrefsMessage
  | GraphCommitMenuMessage
  | GraphCommitsSummaryMessage
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
  /**
   * The selection is now SEVERAL commits — or none (issue #32): Cmd/Ctrl-click
   * and Shift-click in the graph. Newest first, as the list shows them. The
   * host answers `commitsSummary` for the details pane. One selected commit is
   * still `selectCommit`.
   */
  | { type: "selectCommits"; shas: string[] }
  /**
   * Right-click on a row: the host shows a context menu at (x, y). `shas` is
   * set when the row is part of a selection of two or more (issue #32) — the
   * menu is then for all of them, newest first; `sha` is the row clicked.
   */
  | { type: "contextMenu"; sha: string; shas?: string[]; x: number; y: number }
  /** A direct action request (used by keyboard menu / fallbacks). */
  | { type: "action"; action: string; sha: string }
  /** Near the bottom of the loaded rows: please page in more. */
  | { type: "loadMore" }
  /** Toolbar refresh — reload the graph from the first page. */
  | { type: "refresh" }
  /**
   * Open a changed file from the details panel as a diff. `oldPath` is the
   * file's name in the parent when the commit renamed it (the parent side is
   * read under that name); `status` is git's letter (A has no parent side, D
   * no commit side).
   */
  | { type: "openFile"; sha: string; path: string; oldPath?: string; status?: string; wip?: boolean }
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
  /** The user picked an item from the in-graph commit actions popover — or
   *  from the "N commits selected" summary. `shas` carries the commits of a
   *  several-commit menu (issue #32), newest first; absent for one commit. */
  | { type: "commitMenuAction"; sha: string; shas?: string[]; id: string }
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
  | { type: "requestContains"; sha: string }
  /**
   * The Branches picker changed the filter (issue #30). The host remembers it
   * for this repository, rebuilds the graph from the first page around exactly
   * these refs, and answers with a fresh `graphInit` carrying the filter it
   * actually applied (refs that no longer exist are dropped on the way).
   */
  | { type: "setRefFilter"; refs: GraphRefFilter }
  /**
   * "Checkout <ref>" from a chip's own menu (issue #30). Right-clicking a chip
   * used to open the row's commit menu, whose first items check out the refs
   * on that row; the chip's filter menu took that click, so it offers the
   * checkout too. The host runs it exactly as it runs the commit menu's item.
   *
   * `fullName` is what the host checks out; `name` and `kind` are the chip's
   * words for its messages. A chip's name is `%(refname:short)`, and with a
   * tag and a branch both called "release" the branch chip reads
   * "heads/release" — which `git checkout` resolves as a REVISION and detaches
   * at. The webview resolves the chip through the ref list (chipRefs), where
   * the full name git gave it lives.
   */
  | { type: "checkoutRef"; sha: string; name: string; kind: WireRef["kind"]; fullName: string };
