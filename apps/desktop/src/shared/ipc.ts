// The desktop IPC contract: the typed request/response shapes that flow over
// Electron's `ipcMain.handle` / `ipcRenderer.invoke` bridge. This module is
// shared by the main process (which implements the handlers), the preload
// (which forwards them across the contextBridge), and the renderer (which calls
// them through `window.gitstudio`). It is TYPE-ONLY and imports nothing
// host-specific, so the renderer (browser) and main (Node) bundles both carry it.

import type { WireRow } from "@gitstudio/host-bridge/graphProtocol";

/** A repo the user has opened, surfaced in the "recent" list + sidebar header. */
export interface RepoInfo {
  /** Absolute repo root (the `rev-parse --show-toplevel`). */
  root: string;
  /** Last path segment of the root — the display name. */
  name: string;
}

/** A ref decoration listed in the sidebar (branch / remote / tag). */
export interface RefInfo {
  type: "head" | "remote" | "tag" | "stash";
  name: string;
  fullName: string;
  sha: string;
  isCurrent: boolean;
  upstream?: string;
}

/** The current HEAD, for the sidebar's "on branch …" affordance. */
export interface HeadInfo {
  detached: boolean;
  branch?: string;
  sha: string;
}

/** A page of graph rows plus the paging cursor the renderer feeds back. */
export interface GraphPage {
  rows: WireRow[];
  head: string;
  totalColumns: number;
  hasMore: boolean;
  /** Skip cursor for the next page request. */
  nextSkip: number;
}

/** One changed file in a commit or in the working tree. */
export interface ChangedFile {
  path: string;
  /** Single-letter git status: A(dded) M(odified) D(eleted) R(enamed) … */
  status: string;
  /** Present for working-tree changes: is the change staged (in the index)? */
  staged?: boolean;
}

/** A commit's full details for the right-hand details panel. */
export interface CommitDetails {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  authorDate: number;
  committer: string;
  committerEmail: string;
  committerDate: number;
  subject: string;
  body: string;
  files: ChangedFile[];
}

/** The two sides of a file diff, ready to drop into the shared DiffView. */
export interface FileDiff {
  path: string;
  leftLabel: string;
  rightLabel: string;
  leftText: string;
  rightText: string;
  /** True when the file is conflicted — the renderer opens the 3-pane merge. */
  conflicted: boolean;
}

/** The three sides of a conflicted file, for the shared MergeView. */
export interface ConflictModel {
  path: string;
  hasBase: boolean;
  base: string;
  ours: string;
  theirs: string;
  result: string;
  oursLabel: string;
  theirsLabel: string;
}

/** A git action requested from the graph context menu. */
export interface CommitActionRequest {
  action:
    | "checkout"
    | "branch"
    | "tag"
    | "cherry-pick"
    | "revert"
    | "reset-soft"
    | "reset-mixed"
    | "reset-hard"
    | "copy-sha";
  sha: string;
  /** Free-text argument (a new branch/tag name) where the action needs one. */
  name?: string;
}

export interface CommitActionResult {
  ok: boolean;
  /** True when the repo state changed and the graph should refresh. */
  changed: boolean;
  message?: string;
}

/**
 * The full channel map: channel name -> [request, response]. Used to make the
 * preload's `invoke` and the main handlers strongly typed end to end.
 */
export interface IpcChannels {
  "repo:open": [void, RepoInfo | undefined];
  "repo:openPath": [string, RepoInfo | undefined];
  "repo:recent": [void, RepoInfo[]];
  "repo:current": [void, RepoInfo | undefined];
  "repo:close": [void, void];
  "graph:load": [{ skip?: number; maxCount?: number }, GraphPage];
  "refs:list": [void, RefInfo[]];
  "head:get": [void, HeadInfo | undefined];
  "status": [void, ChangedFile[]];
  "commit:details": [string, CommitDetails | undefined];
  "diff:files": [void, ChangedFile[]];
  "file:diff": [{ path: string; sha?: string }, FileDiff | undefined];
  "conflict:model": [string, ConflictModel | undefined];
  "blame:file": [string, unknown];
  "commit:action": [CommitActionRequest, CommitActionResult];
}

export type IpcChannel = keyof IpcChannels;
export type IpcRequest<C extends IpcChannel> = IpcChannels[C][0];
export type IpcResponse<C extends IpcChannel> = IpcChannels[C][1];

/** Push events the main process emits to the renderer (host → renderer). */
export interface IpcEvents {
  /** The active repo changed (opened/closed) — the renderer reloads. */
  "repo:changed": RepoInfo | undefined;
  /** A menu item asks the renderer to do something it owns. */
  "menu:command": { command: "openRepo" | "refresh" | "closeRepo" };
}

export type IpcEvent = keyof IpcEvents;

/** The shape exposed on `window.gitstudio` by the preload contextBridge. */
export interface GitStudioBridge {
  invoke<C extends IpcChannel>(
    channel: C,
    payload: IpcRequest<C>,
  ): Promise<IpcResponse<C>>;
  on<E extends IpcEvent>(event: E, listener: (data: IpcEvents[E]) => void): () => void;
}
