import * as vscode from "vscode";
import { relative } from "node:path";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { MergeEditorProvider } from "./mergeEditorProvider";
import { isSamePathOrInside } from "../git/repoManager";

/**
 * Watches every open repository for newly-conflicted files and, when
 * `gitstudio.merge.autoOpen` is enabled, opens them in the 3-pane merge editor.
 *
 * It rides RepoManager's debounced `onDidChange` (which already fans in
 * vscode.git state + direct `.git` op-state / ref watchers) and only opens
 * files it hasn't auto-opened before this conflict episode — so it never fights
 * the user by re-opening a file they deliberately closed. Files that leave the
 * conflict set are forgotten, so the next genuine conflict re-triggers.
 */
export class AutoOpenConflicts implements vscode.Disposable {
  /** repo-root | rel paths we've already auto-opened this episode. */
  private readonly opened = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private running = false;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
  ) {
    this.disposables.push(repos.onDidChange(() => void this.scan()));
    // Initial pass for a window opened mid-conflict.
    void this.scan();
  }

  private autoOpenEnabled(): boolean {
    return vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("merge.autoOpen", true);
  }

  private async scan(): Promise<void> {
    if (!this.autoOpenEnabled() || this.running) {
      return;
    }
    this.running = true;
    try {
      const live = new Set<string>();
      for (const entry of this.repos.getAll()) {
        let conflicts: string[];
        try {
          conflicts = await entry.ctx.conflict.listConflicts();
        } catch {
          continue; // a transient git error — try again on the next change
        }
        for (const rel of conflicts) {
          const key = `${entry.root}\u0000${rel}`;
          live.add(key);
          if (!this.opened.has(key)) {
            this.opened.add(key);
            await this.openInMergeEditor(entry, rel);
          }
        }
      }
      // Forget files that are no longer conflicted, so a fresh conflict on the
      // same path re-triggers an auto-open later.
      for (const key of [...this.opened]) {
        if (!live.has(key)) {
          this.opened.delete(key);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async openInMergeEditor(
    entry: RepoEntry,
    rel: string,
  ): Promise<void> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(entry.root), rel);
    try {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        uri,
        MergeEditorProvider.viewType,
      );
    } catch (err) {
      // A vanished file / already-resolved conflict is fine to ignore, but we
      // used to swallow EVERY error — so a merge editor that failed to open
      // did so completely silently, which is indistinguishable from "the
      // feature doesn't work". Say something, and offer the plain diff.
      const exists = await fileExists(uri);
      if (!exists) {
        return; // resolved/deleted between the scan and the open — genuinely fine
      }
      const OPEN_DIFF = "Open as Diff";
      const choice = await vscode.window.showErrorMessage(
        `GitStudio couldn't open the merge editor for ${rel}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
        OPEN_DIFF,
      );
      if (choice === OPEN_DIFF) {
        await vscode.commands.executeCommand("vscode.open", uri);
      }
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.opened.clear();
  }
}

/**
 * `gitstudio.resolveInMergeEditor`: open the given (or active) conflicted file
 * in the 3-pane merge editor manually. Tolerant of being invoked from the SCM
 * resource state (a `vscode.Uri`-like arg), an editor title, or the palette.
 */
export async function resolveInMergeEditor(
  repos: RepoManager,
  arg?: vscode.Uri | { resourceUri?: vscode.Uri },
): Promise<void> {
  const uri = pickUri(arg) ?? vscode.window.activeTextEditor?.document.uri;
  if (!uri || uri.scheme !== "file") {
    void vscode.window.showInformationMessage(
      "GitStudio: open or select a conflicted file first.",
    );
    return;
  }

  const target = resolveTarget(repos, uri);
  if (!target) {
    void vscode.window.showInformationMessage(
      "GitStudio: this file isn't inside an open Git repository.",
    );
    return;
  }

  await vscode.commands.executeCommand(
    "vscode.openWith",
    uri,
    MergeEditorProvider.viewType,
  );
}

function pickUri(
  arg?: vscode.Uri | { resourceUri?: vscode.Uri },
): vscode.Uri | undefined {
  if (!arg) {
    return undefined;
  }
  if (arg instanceof vscode.Uri) {
    return arg;
  }
  return arg.resourceUri;
}

function resolveTarget(
  repos: RepoManager,
  uri: vscode.Uri,
): { entry: RepoEntry; rel: string } | undefined {
  let best: RepoEntry | undefined;
  for (const entry of repos.getAll()) {
    if (isInside(uri.fsPath, entry.root)) {
      if (best === undefined || entry.root.length > best.root.length) {
        best = entry;
      }
    }
  }
  if (!best) {
    return undefined;
  }
  return {
    entry: best,
    rel: relative(best.root, uri.fsPath).replace(/\\/g, "/"),
  };
}

function isInside(filePath: string, dir: string): boolean {
  // Delegates to the ONE separator- and case-tolerant implementation. The old
  // local copy only matched a "/" boundary, so on Windows (fsPaths use "\\")
  // it always returned false and this feature silently did nothing.
  return isSamePathOrInside(filePath, dir);
}

/** Does the file still exist on disk? (A conflict resolved between the scan and
 *  the open is expected; a missing merge editor for a file that IS there isn't.) */
async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
