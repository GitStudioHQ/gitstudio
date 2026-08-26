import * as vscode from "vscode";

/**
 * Whether fetch operations pass `--prune`, dropping remote-tracking branches
 * that no longer exist on the remote (issue #23). One setting governs every
 * fetch surface — status bar, branch menu, remotes menu — so the remote branch
 * list can never go stale on one path and fresh on another.
 */
export function pruneOnFetch(): boolean {
  return vscode.workspace
    .getConfiguration("gitstudio.fetch")
    .get<boolean>("prune", true);
}
