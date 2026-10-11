// "Files changed" as a list or as a folder tree (#81) — the rows the commit
// details pane draws, in reading order, and the choice between the two.
//
// The tree is the shared builder (@gitstudio/engine/fileTree, the one a pull
// request's Files tab uses): folders first, then files, each by name, and a
// folder holding nothing but one folder compacted into one row. This module
// flattens it to rows the way VS Code's own trees are drawn — one flat run of
// treeitems, each saying its level, its position among its siblings and, for
// a folder, whether it is open — and gives each folder what everything under
// it adds up to.

import { fileTree, filesUnder, type FileTreeNode } from "@gitstudio/engine/fileTree";
import type { CommitFileChange } from "@gitstudio/host-bridge/commitDetailsProtocol";
import type { GraphFilesLayout } from "@gitstudio/host-bridge/graphProtocol";

/** "list": one row per file, its folder beside it. "tree": grouped by folder. */
export type FilesLayout = GraphFilesLayout;

/** What a folder's row says about everything under it, at any depth. */
export interface FolderTally {
  files: number;
  /** Lines added and removed. A binary file has no counts and adds nothing. */
  additions: number;
  deletions: number;
}

/** Where a row sits, as a screen reader is told (aria-level/-setsize/-posinset). */
interface RowPlace {
  /** Unique within one list: "d:<folder path>" or "f:<file path>". */
  key: string;
  /** 1 for the top. */
  level: number;
  setsize: number;
  posinset: number;
}

export type FolderRow = RowPlace & {
  kind: "dir";
  /** The folder's whole path — what it is collapsed by. */
  path: string;
  /** What its row shows: a compacted chain ("src/graph") or one name. */
  name: string;
  expanded: boolean;
  tally: FolderTally;
};

export type FileRow = RowPlace & {
  kind: "file";
  file: CommitFileChange;
};

export type FilesRow = FolderRow | FileRow;

/** The files of a node, summed. A binary file (-1 / -1) is counted, not added. */
export function folderTally(node: FileTreeNode<CommitFileChange>): FolderTally {
  const files = filesUnder(node);
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    if (f.additions > 0) additions += f.additions;
    if (f.deletions > 0) deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

/** The list: the files as the host sent them, one level. */
export function listRows(files: readonly CommitFileChange[]): FileRow[] {
  return files.map((file, i) => ({
    kind: "file",
    key: `f:${file.path}`,
    level: 1,
    setsize: files.length,
    posinset: i + 1,
    file,
  }));
}

/**
 * The tree, flattened to the rows on screen: a folder in `collapsed` (by its
 * whole path) shows its own row and hides everything under it. A renamed file
 * sits under its new path, as it does in the list.
 */
export function treeRows(files: readonly CommitFileChange[], collapsed: ReadonlySet<string> = new Set()): FilesRow[] {
  const out: FilesRow[] = [];
  const walk = (nodes: FileTreeNode<CommitFileChange>[], level: number): void => {
    nodes.forEach((n, i) => {
      const place = { level, setsize: nodes.length, posinset: i + 1 };
      if (n.kind === "file") {
        out.push({ kind: "file", key: `f:${n.file.path}`, file: n.file, ...place });
        return;
      }
      const expanded = !collapsed.has(n.path);
      out.push({ kind: "dir", key: `d:${n.path}`, path: n.path, name: n.name, expanded, tally: folderTally(n), ...place });
      if (expanded) walk(n.children, level + 1);
    });
  };
  walk(fileTree(files), 1);
  return out;
}

// ── The choice, remembered ───────────────────────────────────────────────────

/** Beside the pane's other remembered state (gitstudio.details.leftw). */
export const LS_FILES_LAYOUT = "gitstudio.details.files.layout";

const layoutListeners = new Set<(layout: FilesLayout) => void>();
let hearsOtherWindows = false;

/** The remembered choice; the list until one is made. */
export function readFilesLayout(): FilesLayout {
  try {
    return localStorage.getItem(LS_FILES_LAYOUT) === "tree" ? "tree" : "list";
  } catch {
    return "list"; // storage unavailable — today's list
  }
}

/** Remember a choice, and tell every pane showing files — a choice made here,
 *  or one a host relays from another graph (the extension's filesLayout). */
export function saveFilesLayout(layout: FilesLayout): void {
  try {
    localStorage.setItem(LS_FILES_LAYOUT, layout);
  } catch {
    /* storage unavailable — this session still follows it */
  }
  tell(layout);
}

function tell(layout: FilesLayout): void {
  for (const listener of [...layoutListeners]) {
    try {
      listener(layout);
    } catch {
      // One pane's repaint must not stop the next one's.
    }
  }
}

/**
 * Follow the choice wherever it is made: another pane in this page, or
 * another window of the same app (the desktop's), whose write arrives here as
 * a `storage` event.
 */
export function onFilesLayoutChange(listener: (layout: FilesLayout) => void): () => void {
  layoutListeners.add(listener);
  if (!hearsOtherWindows && typeof window !== "undefined") {
    hearsOtherWindows = true;
    window.addEventListener("storage", (e) => {
      if (e.key === LS_FILES_LAYOUT) tell(readFilesLayout());
    });
  }
  return () => {
    layoutListeners.delete(listener);
  };
}
