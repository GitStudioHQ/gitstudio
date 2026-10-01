import * as vscode from "vscode";
import { failed, notice } from "../ui/notify";
import { promptPick } from "../ui/dialogs";
import type { FileHistoryEntry } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";
import {
  openRevisionDiff,
  openSidesDiff,
  historyChangeSides,
  fromRevisionUri,
  REVISION_SCHEME,
} from "./revisionContentProvider";
import { resolveActiveFile } from "./historyContext";
import * as l10n from "@vscode/l10n";

/** A resolved working-tree file, plus the rev when invoked from a diff editor. */
interface ResolvedFile {
  entry: RepoEntry;
  root: string;
  rel: string;
  currentRev?: string;
}

/**
 * Revision navigation for a file: Open Changes (vs HEAD), Open File at
 * Revision (pick from history), and step back/forward through a file's history
 * re-opening the diff each time. A tiny in-memory cursor remembers where each
 * file is in its walk so Back/Forward feel continuous.
 */
export class RevisionNavigator implements vscode.Disposable {
  // Per repo-relative-key cursor: index into the file's newest-first history.
  private readonly cursors = new Map<string, number>();

  constructor(private readonly repos: RepoManager) {}

  /** Diff the active file's working tree against HEAD (working on the right). */
  async openChanges(resource?: vscode.Uri): Promise<void> {
    const resolved = this.resolveFrom(resource);
    if (!resolved) {
      return;
    }
    const { root, rel } = resolved;
    await openRevisionDiff(
      root,
      rel,
      "HEAD",
      undefined,
      l10n.t("{0} (HEAD ↔ Working Tree)", baseName(rel)),
    );
  }

  /** Pick a revision from the file's history and open it (diff vs working). */
  async openFileAtRevision(resource?: vscode.Uri): Promise<void> {
    const resolved = this.resolveFrom(resource);
    if (!resolved) {
      return;
    }
    const { entry, root, rel } = resolved;

    let history: FileHistoryEntry[];
    try {
      history = await entry.ctx.history.fileHistory(rel, {
        maxCount: 200,
        follow: true,
      });
    } catch (err) {
      void vscode.window.showErrorMessage(failed(l10n.t("File history"), err instanceof Error ? err.message : String(err)));
      return;
    }
    if (history.length === 0) {
      void vscode.window.showInformationMessage(notice(l10n.t("No history for {0}.", baseName(rel))));
      return;
    }

    const picked = await pickRevision(history, baseName(rel));
    if (!picked) {
      return;
    }
    this.cursors.set(this.key(root, rel), picked.index);
    await openSidesDiff(
      root,
      rel,
      historyChangeSides(picked.entry),
      `${baseName(rel)} (${picked.entry.shortSha})`,
    );
  }

  /** Step to the previous (older) revision in this file's history. */
  navigateBack(resource?: vscode.Uri): Promise<void> {
    return this.step(resource, +1);
  }

  /** Step to the next (newer) revision in this file's history. */
  navigateForward(resource?: vscode.Uri): Promise<void> {
    return this.step(resource, -1);
  }

  private async step(
    resource: vscode.Uri | undefined,
    delta: number,
  ): Promise<void> {
    const resolved = this.resolveFrom(resource);
    if (!resolved) {
      return;
    }
    const { entry, root, rel } = resolved;
    const key = this.key(root, rel);

    let history: FileHistoryEntry[];
    try {
      history = await entry.ctx.history.fileHistory(rel, {
        maxCount: 500,
        follow: true,
      });
    } catch {
      return;
    }
    if (history.length === 0) {
      return;
    }

    // Where are we? If the active editor is already a revision diff, anchor on
    // that sha; otherwise resume from the remembered cursor (default: newest).
    const anchored = resolved.currentRev
      ? history.findIndex((h) => h.sha.startsWith(resolved.currentRev!))
      : (this.cursors.get(key) ?? -1);
    const base = anchored >= 0 ? anchored : -1;

    const next = base + delta;
    if (next < 0) {
      void vscode.window.showInformationMessage(notice(l10n.t("Already at the newest revision")));
      return;
    }
    if (next >= history.length) {
      void vscode.window.showInformationMessage(notice(l10n.t("Already at the oldest revision")));
      return;
    }

    this.cursors.set(key, next);
    const target = history[next];
    await openSidesDiff(
      root,
      rel,
      historyChangeSides(target),
      `${baseName(rel)} (${target.shortSha})`,
    );
  }

  /**
   * Resolves a working-tree file from either an explicit resource, a
   * `gitstudio-rev` diff editor (carries root/path/rev), or the active editor.
   */
  private resolveFrom(resource?: vscode.Uri): ResolvedFile | undefined {
    const active = vscode.window.activeTextEditor?.document.uri;
    const uri = resource ?? active;

    // A historical-revision editor: decode its root/path/rev directly.
    if (uri && uri.scheme === REVISION_SCHEME) {
      const { root, rev, relPath } = fromRevisionUri(uri);
      const entry = this.repos.getAll().find((e) => e.root === root);
      if (entry) {
        return { entry, root, rel: relPath, currentRev: rev };
      }
    }

    const file = resolveActiveFile(this.repos);
    if (!file) {
      return undefined;
    }
    return { entry: file.entry, root: file.entry.root, rel: file.rel };
  }

  private key(root: string, rel: string): string {
    return `${root}\u0000${rel}`;
  }

  dispose(): void {
    this.cursors.clear();
  }
}

async function pickRevision(
  history: FileHistoryEntry[],
  fileName: string,
): Promise<{ entry: FileHistoryEntry; index: number } | undefined> {
  const picked = await promptPick({
    title: l10n.t("Open {0} at Revision", fileName),
    hint: l10n.t("Pick a revision to diff against your working tree."),
    choices: history.map((e, index) => ({
      id: String(index),
      label: e.subject,
      icon: "git-commit",
      detail: e.shortSha,
      description: `${e.author} · ${relativeTime(e.authorDate)}`,
    })),
  });
  if (picked === undefined) {
    return undefined;
  }
  const index = Number(picked);
  const entry = history[index];
  return entry ? { entry, index } : undefined;
}

function baseName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || rel;
}
