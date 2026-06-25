import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { Change } from "../git/git";
import { toRevisionUri } from "../history/revisionContentProvider";

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

// The Changes view: the daily-driver surface. Three collapsible groups —
// Merge Changes (only when present), Staged Changes, and Changes (unstaged) —
// populated from the active repo's vscode.git state. File status is encoded as a
// colored ThemeIcon + a relative-dir description on each tree row (rather than a
// FileDecorationProvider, which would visually fight the built-in git explorer
// decorations). Stage / Unstage / Discard live as inline + group-title actions
// wired to git-service's StagingProvider; the view refreshes on
// RepoManager.onDidChange.

type GroupKind = "merge" | "staged" | "unstaged";

const GROUP_LABEL: Record<GroupKind, string> = {
  merge: "Merge Changes",
  staged: "Staged Changes",
  unstaged: "Changes",
};

const GROUP_CONTEXT: Record<GroupKind, string> = {
  merge: "gitstudio.changeGroup.merge",
  staged: "gitstudio.changeGroup.staged",
  unstaged: "gitstudio.changeGroup.unstaged",
};

const FILE_CONTEXT: Record<GroupKind, string> = {
  merge: "gitstudio.change.merge",
  staged: "gitstudio.change.staged",
  unstaged: "gitstudio.change.unstaged",
};

/** A status group header (Merge / Staged / Changes). */
export class ChangeGroupNode extends vscode.TreeItem {
  constructor(
    readonly kind: GroupKind,
    readonly root: string,
    readonly changes: Change[],
  ) {
    super(GROUP_LABEL[kind], vscode.TreeItemCollapsibleState.Expanded);
    this.contextValue = GROUP_CONTEXT[kind];
    this.description = String(changes.length);
    this.id = `group:${kind}:${root}`;
  }
}

/** A single changed file row. */
export class ChangeFileNode extends vscode.TreeItem {
  constructor(
    readonly kind: GroupKind,
    readonly root: string,
    readonly change: Change,
  ) {
    const uri = change.uri;
    super(uri, vscode.TreeItemCollapsibleState.None);

    const rel = relativePath(root, uri.fsPath);
    const dir = parentDir(rel);
    this.label = baseName(rel);
    this.description = dir || undefined;
    this.resourceUri = uri;
    this.contextValue = FILE_CONTEXT[kind];

    const { icon, color, letter, word } = decorate(change.status);
    this.iconPath = new vscode.ThemeIcon(
      icon,
      color ? new vscode.ThemeColor(color) : undefined,
    );
    this.tooltip = `${rel} · ${word} (${letter})`;

    // Click to open the diff (working-vs-index for unstaged, index-vs-HEAD for
    // staged). Merge entries open against HEAD for context.
    this.command = {
      command: "gitstudio.changes.openDiff",
      title: "Open Changes",
      arguments: [this],
    };
  }
}

export type ChangeNode = ChangeGroupNode | ChangeFileNode;

/** Feeds the Changes tree from the active repo's vscode.git state. */
export class ChangesTreeProvider
  implements vscode.TreeDataProvider<ChangeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<ChangeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.disposables.push(this.repos.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: ChangeNode): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ChangeNode): ChangeNode[] {
    const active = this.repos.getActive();
    if (!active) {
      return [];
    }

    if (!element) {
      return this.groups(active);
    }
    if (element instanceof ChangeGroupNode) {
      return element.changes.map(
        (c) => new ChangeFileNode(element.kind, element.root, c),
      );
    }
    return [];
  }

  private groups(active: RepoEntry): ChangeGroupNode[] {
    const state = active.repo.state;
    const out: ChangeGroupNode[] = [];
    if (state.mergeChanges.length > 0) {
      out.push(new ChangeGroupNode("merge", active.root, state.mergeChanges));
    }
    out.push(new ChangeGroupNode("staged", active.root, state.indexChanges));
    out.push(
      new ChangeGroupNode("unstaged", active.root, state.workingTreeChanges),
    );
    return out;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
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
  const label = node.kind === "merge" ? "Working Tree ↔ HEAD" : "Working Tree";
  await vscode.commands.executeCommand(
    "vscode.diff",
    left,
    right,
    `${fileName} (${label})`,
    { preview: true },
  );
}

interface Decoration {
  icon: string;
  color: string | undefined;
  letter: string;
  word: string;
}

/** Maps a vscode.git Status (numeric) to a themed icon + a status letter/word. */
function decorate(status: number): Decoration {
  switch (status) {
    case St.INDEX_ADDED:
    case St.INTENT_TO_ADD:
      return iconFor("diff-added", "gitDecoration.addedResourceForeground", "A", "Added");
    case St.UNTRACKED:
      return iconFor("diff-added", "gitDecoration.untrackedResourceForeground", "U", "Untracked");
    case St.INDEX_DELETED:
    case St.DELETED:
      return iconFor("diff-removed", "gitDecoration.deletedResourceForeground", "D", "Deleted");
    case St.INDEX_RENAMED:
    case St.INDEX_COPIED:
      return iconFor("diff-renamed", "gitDecoration.renamedResourceForeground", "R", "Renamed");
    case St.BOTH_MODIFIED:
    case St.BOTH_ADDED:
    case St.ADDED_BY_US:
    case St.ADDED_BY_THEM:
    case St.DELETED_BY_US:
    case St.DELETED_BY_THEM:
    case St.BOTH_DELETED:
      return iconFor("git-merge", "gitDecoration.conflictingResourceForeground", "!", "Conflict");
    case St.IGNORED:
      return iconFor("diff-ignored", "gitDecoration.ignoredResourceForeground", "I", "Ignored");
    case St.TYPE_CHANGED:
      return iconFor("diff-modified", "gitDecoration.modifiedResourceForeground", "T", "Type changed");
    case St.INDEX_MODIFIED:
    case St.MODIFIED:
    default:
      return iconFor("diff-modified", "gitDecoration.modifiedResourceForeground", "M", "Modified");
  }
}

function iconFor(
  icon: string,
  color: string,
  letter: string,
  word: string,
): Decoration {
  return { icon, color, letter, word };
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

function parentDir(rel: string): string {
  const idx = rel.lastIndexOf("/");
  return idx === -1 ? "" : rel.slice(0, idx);
}
