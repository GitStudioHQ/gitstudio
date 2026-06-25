import * as vscode from "vscode";
import { relative } from "node:path";
import type { RepoManager, RepoEntry } from "../git/repoManager";

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
  const editor = vscode.window.activeTextEditor;
  const uri = editor?.document.uri;
  if (!uri || uri.scheme !== "file") {
    void vscode.window.showInformationMessage(
      "Open a file in a Git repository first.",
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

function isInside(filePath: string, dir: string): boolean {
  if (filePath === dir) {
    return true;
  }
  const withSep = dir.endsWith("/") ? dir : `${dir}/`;
  return filePath.startsWith(withSep);
}
