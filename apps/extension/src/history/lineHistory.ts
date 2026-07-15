import * as vscode from "vscode";
import type { LineHistoryEntry } from "@gitstudio/git-service/index";
import type { RepoManager } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";
import { openRevisionDiff } from "./revisionContentProvider";
import { resolveActiveFile } from "./historyContext";

interface LineHistoryItem extends vscode.QuickPickItem {
  entry: LineHistoryEntry;
}

/**
 * `gitstudio.showLineHistory`: walks the evolution of the active selection's
 * line range. Presents the commits that touched those lines in a QuickPick; the
 * pick opens that commit's diff for the file. The QuickPick re-opens after each
 * diff so you can step through the range's history without re-invoking.
 */
export async function showLineHistory(repos: RepoManager): Promise<void> {
  const active = resolveActiveFile(repos);
  if (!active) {
    return;
  }
  // 1-based inclusive line range from the selection (a caret = a single line).
  // The editor may not be the *active* tab (the command can be run from the
  // walkthrough or a diff), so find the one showing this file; with no editor
  // at all, fall back to the first line rather than silently doing nothing.
  const editor = vscode.window.visibleTextEditors.find(
    (e) => e.document.uri.fsPath === active.uri.fsPath,
  );
  const sel = editor?.selection;
  const startLine = sel ? sel.start.line + 1 : 1;
  const endLine = sel ? sel.end.line + 1 : 1;

  let entries: LineHistoryEntry[];
  try {
    entries = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Loading line history (${startLine}–${endLine})…`,
      },
      () =>
        active.entry.ctx.history.lineHistory(active.rel, startLine, endLine, {
          maxCount: 200,
        }),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `Line history failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (entries.length === 0) {
    void vscode.window.showInformationMessage(
      `No history for lines ${startLine}–${endLine} of ${baseName(active.rel)}.`,
    );
    return;
  }

  const range =
    startLine === endLine ? `line ${startLine}` : `lines ${startLine}–${endLine}`;
  const fileName = baseName(active.rel);

  // Pick a commit → open its diff. It used to loop and re-open the QuickPick
  // immediately ON TOP of the diff it had just opened, so the diff was hidden
  // behind the picker and the whole thing read as "nothing happened".
  const picked = await pickCommit(entries, `${fileName} · ${range}`);
  if (!picked) {
    return;
  }
  await openRevisionDiff(
    active.entry.root,
    active.rel,
    `${picked.sha}~1`,
    picked.sha,
    `${fileName} (${picked.shortSha})`,
  );
  revealRange(startLine, endLine);
}

function pickCommit(
  entries: LineHistoryEntry[],
  title: string,
): Promise<LineHistoryEntry | undefined> {
  const items: LineHistoryItem[] = entries.map((e) => ({
    label: e.subject,
    description: `${e.author} · ${relativeTime(e.authorDate)} · ${e.shortSha}`,
    entry: e,
  }));

  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick<LineHistoryItem>();
    qp.title = `Line History — ${title}`;
    qp.placeholder = "Pick a commit to diff it against its parent (Esc to close)";
    qp.matchOnDescription = true;
    qp.items = items;
    let accepted = false;
    qp.onDidAccept(() => {
      accepted = true;
      const sel = qp.selectedItems[0];
      qp.hide();
      resolve(sel?.entry);
    });
    qp.onDidHide(() => {
      qp.dispose();
      if (!accepted) {
        resolve(undefined);
      }
    });
    qp.show();
  });
}

/** Best-effort scroll of the freshly-opened diff to the range of interest. */
function revealRange(startLine: number, endLine: number): void {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    return;
  }
  const max = editor.document.lineCount;
  const from = Math.min(Math.max(startLine - 1, 0), Math.max(max - 1, 0));
  const to = Math.min(Math.max(endLine - 1, 0), Math.max(max - 1, 0));
  const range = new vscode.Range(from, 0, to, 0);
  editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
}

function baseName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || rel;
}
