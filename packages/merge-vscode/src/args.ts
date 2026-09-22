// Command-argument normalisation shared by every merge command. Menus hand
// commands different shapes: a Uri (explorer, editor title), an SCM resource
// state ({ resourceUri }), an Explorer multi-selection (the second argument, a
// Uri[]), or nothing at all (the palette).

import * as vscode from "vscode";
import { relative } from "node:path";
import type { MergeRepo, RepoLocator } from "./product";

export function resolveUriArg(arg: unknown): vscode.Uri | undefined {
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  if (arg && typeof arg === "object") {
    const candidate = (arg as { resourceUri?: unknown }).resourceUri;
    if (candidate instanceof vscode.Uri) {
      return candidate;
    }
  }
  return undefined;
}

/** An Explorer multi-selection as file Uris (anything else is ignored). */
export function collectUris(arg: unknown): vscode.Uri[] {
  if (!Array.isArray(arg)) {
    return [];
  }
  const uris: vscode.Uri[] = [];
  for (const item of arg) {
    const uri = resolveUriArg(item);
    if (uri) {
      uris.push(uri);
    }
  }
  return uris;
}

/** The clicked resource, else the active text editor's document. */
export function targetUri(arg: unknown): vscode.Uri | undefined {
  return resolveUriArg(arg) ?? vscode.window.activeTextEditor?.document.uri;
}

/** The repository holding `uri` and the file's repo-relative, forward-slashed path. */
export function locate(
  locator: RepoLocator,
  uri: vscode.Uri,
): { repo: MergeRepo; rel: string } | undefined {
  if (uri.scheme !== "file") {
    return undefined;
  }
  const repo = locator.forPath(uri.fsPath);
  if (!repo) {
    return undefined;
  }
  return { repo, rel: relative(repo.root, uri.fsPath).split("\\").join("/") };
}

/** The file's name for sentences ("app.ts"). */
export function baseName(uri: vscode.Uri): string {
  return uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
}
