// Shared payload for the commit-details panel (the GitLens/GitKraken "inspect a
// commit" surface), used by the VS Code extension and the desktop app and
// rendered by the shared <gitstudio-commit-details> Lit element.
//
// TYPE-ONLY — no runtime, no vscode/node imports — so it stays importable from
// the webview, the extension host, and the desktop main process alike.

import type { CommitFileChange } from "./git";
import type { WireRef } from "./graphProtocol";

export type { CommitFileChange, WireRef };

/** Action ids the details panel can emit; the host maps them to git ops. */
export type CommitDetailsActionId =
  | "checkout"
  | "branch"
  | "tag"
  | "cherry-pick"
  | "revert"
  | "interactive-rebase"
  | "reset"
  | "copy-sha"
  | "open-remote"
  // WIP-only
  | "stage-all"
  | "unstage-all"
  | "commit"
  | "stash"
  | "discard-all";

/**
 * Everything the panel needs to render a commit (or the working tree, when
 * `kind === "wip"`). For WIP, sha is the all-zeros UNCOMMITTED_SHA, the date
 * fields are "now", and `files` carries the working-tree changes (each marked
 * `staged` where relevant on the CommitFileChange... see stagedCount).
 */
export interface CommitDetailsPayload {
  kind: "commit" | "wip";
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  authorEmail: string;
  /** Authored timestamp, epoch seconds. */
  authorDate: number;
  committer: string;
  committerEmail: string;
  /** Committed timestamp, epoch seconds. */
  committerDate: number;
  subject: string;
  body: string;
  /** Ref chips on this commit (branch tips, remotes, tags). */
  refs: WireRef[];
  /** Files changed by the commit (vs first parent), or the WIP change set. */
  files: CommitFileChange[];
  /** For WIP: how many of `files` are staged (the leading N entries). */
  stagedCount?: number;
  /** True when an upstream/remote exists so "Open on remote" is offered. */
  hasRemote?: boolean;
}
