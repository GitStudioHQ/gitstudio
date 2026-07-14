import * as vscode from "vscode";
import { join, relative } from "node:path";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { isSamePathOrInside } from "../git/repoManager";
import { REVISION_SCHEME, fromRevisionUri } from "./revisionContentProvider";

/** A resolved (repo, file-relative-path) for the active editor's document. */
export interface ActiveFile {
  entry: RepoEntry;
  /** Repo-relative path, forward-slashed. */
  rel: string;
  uri: vscode.Uri;
}

/**
 * Resolves the active editor's file to the repo that contains it and the path
 * relative to that repo's root. Returns undefined (with a gentle toast) when
 * there is no file-scheme editor inside a known repo.
 */
export function resolveActiveFile(repos: RepoManager): ActiveFile | undefined {
  const uri = activeFileUri();
  if (!uri) {
    void vscode.window.showInformationMessage(
      "Open a file in a Git repository first, then run this command.",
    );
    return undefined;
  }

  let best: RepoEntry | undefined;
  for (const entry of repos.getAll()) {
    if (isInside(uri.fsPath, entry.root)) {
      if (best === undefined || entry.root.length > best.root.length) {
        best = entry;
      }
    }
  }
  if (!best) {
    void vscode.window.showInformationMessage(
      "This file is not inside an open Git repository.",
    );
    return undefined;
  }

  const rel = relative(best.root, uri.fsPath).replace(/\\/g, "/");
  return { entry: best, rel, uri };
}

/**
 * The file this command should act on.
 *
 * The active editor is the obvious answer, but it's often NOT a text editor:
 * run this from the Walkthrough (a webview) or a diff and `activeTextEditor`
 * is undefined, which used to make every history command a silent no-op. So we
 * fall back to the most recently visible file editor.
 *
 * A `gitstudio-rev:` revision document maps back to the working-tree file it
 * came from, so Line History keeps working *inside* a revision diff — exactly
 * where you want to ask "what happened to this line?".
 */
function activeFileUri(): vscode.Uri | undefined {
  const candidates = [
    vscode.window.activeTextEditor,
    ...vscode.window.visibleTextEditors,
  ];
  for (const editor of candidates) {
    const uri = editor?.document.uri;
    if (!uri) {
      continue;
    }
    if (uri.scheme === "file") {
      return uri;
    }
    const source = revisionSourceUri(uri);
    if (source) {
      return source;
    }
  }
  return undefined;
}

/** A `gitstudio-rev:` URI encodes (root, rev, relPath) — map it back to the
 *  working-tree file so history commands work from inside a revision diff. */
function revisionSourceUri(uri: vscode.Uri): vscode.Uri | undefined {
  if (uri.scheme !== REVISION_SCHEME) {
    return undefined;
  }
  try {
    const { root, relPath } = fromRevisionUri(uri);
    return root && relPath ? vscode.Uri.file(join(root, relPath)) : undefined;
  } catch {
    return undefined;
  }
}

function isInside(filePath: string, dir: string): boolean {
  // Delegates to the ONE separator- and case-tolerant implementation. The old
  // local copy only matched a "/" boundary, so on Windows (fsPaths use "\\")
  // it always returned false and this feature silently did nothing.
  return isSamePathOrInside(filePath, dir);
}
