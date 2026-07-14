import * as vscode from "vscode";
import type { Change } from "../git/git";
import { toRevisionUri } from "../history/revisionContentProvider";

// Change-row helpers shared by the unified Commit webview (commitView.ts) and
// the line/hunk-staging commands. The standalone "Changes" tree view was folded
// into the Commit webview (which now renders the working-tree changes inline,
// SCM-style), so the TreeDataProvider no longer lives here — only the diff
// opener, the vscode.git Status → icon/letter mapping, and the relative-path
// helper remain, reused verbatim by the webview's host side.

// vscode.git's `Status` is an ambient enum in git.d.ts (types only — no runtime
// value), so we mirror its numeric values here for the runtime switch. The order
// matches microsoft/vscode's extensions/git/src/api/git.d.ts (API v1).
const enum St {
  INDEX_MODIFIED = 0,
  INDEX_ADDED = 1,
  INDEX_DELETED = 2,
  INDEX_RENAMED = 3,
  INDEX_COPIED = 4,
  MODIFIED = 5,
  DELETED = 6,
  UNTRACKED = 7,
  IGNORED = 8,
  INTENT_TO_ADD = 9,
  INTENT_TO_RENAME = 10,
  TYPE_CHANGED = 11,
  ADDED_BY_US = 12,
  ADDED_BY_THEM = 13,
  DELETED_BY_US = 14,
  DELETED_BY_THEM = 15,
  BOTH_ADDED = 16,
  BOTH_DELETED = 17,
  BOTH_MODIFIED = 18,
}

/** Which group a change belongs to (used by the diff opener + the webview). */
export type GroupKind = "merge" | "staged" | "unstaged";

const FILE_CONTEXT: Record<GroupKind, string> = {
  merge: "gitstudio.change.merge",
  staged: "gitstudio.change.staged",
  unstaged: "gitstudio.change.unstaged",
};

/**
 * A lightweight changed-file descriptor. Retained (instead of a TreeItem) so the
 * Commit webview's host side can reuse `openChangeDiff` to open the same diffs
 * without standing up a tree. Mirrors the fields the diff opener needs.
 */
export class ChangeFileNode {
  readonly resourceUri: vscode.Uri;
  readonly contextValue: string;

  constructor(
    readonly kind: GroupKind,
    readonly root: string,
    readonly change: Change,
  ) {
    this.resourceUri = change.uri;
    this.contextValue = FILE_CONTEXT[kind];
  }
}

/**
 * Opens the appropriate diff for a change row: working-tree vs index for
 * unstaged edits, index vs HEAD for staged edits, and working vs HEAD for merge
 * entries. Reuses the `gitstudio-rev` content provider (rev "" = index,
 * "HEAD" = committed) so no extra scheme is needed.
 */
export async function openChangeDiff(node: ChangeFileNode): Promise<void> {
  const { root, change } = node;
  const rel = relativePath(root, change.uri.fsPath);
  const fileName = baseName(rel);

  if (node.kind === "staged") {
    const left = toRevisionUri(root, "HEAD", rel);
    const right = toRevisionUri(root, "", rel); // index
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${fileName} (Staged)`,
      { preview: true },
    );
    return;
  }

  // unstaged / merge: working tree (right) vs index or HEAD (left).
  const baseRev = node.kind === "merge" ? "HEAD" : "";
  const left = toRevisionUri(root, baseRev, rel);
  const right = change.uri; // live working-tree file
  const label = node.kind === "merge" ? "Working Tree vs HEAD" : "Working Tree";
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${fileName} (${label})`,
    { preview: true },
  );
}

/** The single-letter status code (M/A/D/U/R/!/I/T) for a vscode.git Status. */
export function statusLetter(status: number): string {
  switch (status) {
    case St.INDEX_ADDED:
    case St.INTENT_TO_ADD:
      return "A";
    case St.UNTRACKED:
      return "U";
    case St.INDEX_DELETED:
    case St.DELETED:
      return "D";
    case St.INDEX_RENAMED:
    case St.INDEX_COPIED:
      return "R";
    case St.BOTH_MODIFIED:
    case St.BOTH_ADDED:
    case St.ADDED_BY_US:
    case St.ADDED_BY_THEM:
    case St.DELETED_BY_US:
    case St.DELETED_BY_THEM:
    case St.BOTH_DELETED:
      return "!";
    case St.IGNORED:
      return "I";
    case St.TYPE_CHANGED:
      return "T";
    case St.INDEX_MODIFIED:
    case St.MODIFIED:
    default:
      return "M";
  }
}

/** Repo-root-relative, forward-slashed path. */
export function relativePath(root: string, fsPath: string): string {
  const normRoot = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const normPath = fsPath.replace(/\\/g, "/");
  if (normPath === normRoot) {
    return "";
  }
  if (normPath.startsWith(normRoot + "/")) {
    return normPath.slice(normRoot.length + 1);
  }
  return normPath;
}

function baseName(rel: string): string {
  const parts = rel.split("/");
  return parts[parts.length - 1] || rel;
}
