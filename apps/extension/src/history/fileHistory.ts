import * as vscode from "vscode";
import type { FileHistoryEntry } from "@gitstudio/git-service/index";
import type { RepoManager } from "../git/repoManager";
import { resolveActiveFile } from "./historyContext";
import { openRevisionDiff } from "./revisionContentProvider";

/**
 * "Show File History" — the browsable per-file history the product has always
 * advertised but never actually had a surface for.
 *
 * It used to be routed exclusively through VS Code's Timeline view, but
 * `workspace.registerTimelineProvider` is a PROPOSED API: it isn't in the
 * stable typings, the call threw at activation, and the throw was swallowed by
 * a `catch {}` — so the provider was dead code and per-file history simply did
 * not exist for anyone. A plain QuickPick needs no proposed API and works in
 * VS Code, Cursor, and VSCodium alike.
 *
 * Picking a commit opens that revision's diff for the file.
 */
export async function showFileHistory(repos: RepoManager): Promise<void> {
  const active = resolveActiveFile(repos);
  if (!active) {
    return;
  }
  const fileName = baseName(active.rel);

  let entries: FileHistoryEntry[];
  try {
    entries = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Window,
        title: `Loading history for ${fileName}…`,
      },
      () => active.entry.ctx.history.fileHistory(active.rel, { maxCount: 200 }),
    );
  } catch (err) {
    void vscode.window.showErrorMessage(
      `File history failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (entries.length === 0) {
    void vscode.window.showInformationMessage(`No history for ${fileName}.`);
    return;
  }

  const picked = await pickCommit(entries, fileName);
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
}

interface CommitItem extends vscode.QuickPickItem {
  entry: FileHistoryEntry;
}

async function pickCommit(
  entries: FileHistoryEntry[],
  fileName: string,
): Promise<FileHistoryEntry | undefined> {
  const items: CommitItem[] = entries.map((entry) => ({
    label: entry.subject,
    description: entry.shortSha,
    detail: `${entry.author} · ${relTime(entry.authorDate)}`,
    entry,
  }));
  const choice = await vscode.window.showQuickPick(items, {
    title: `History — ${fileName}`,
    placeHolder: "Pick a commit to see what it changed in this file",
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return choice?.entry;
}

function baseName(rel: string): string {
  const i = rel.lastIndexOf("/");
  return i >= 0 ? rel.slice(i + 1) : rel;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function relTime(epochSeconds: number): string {
  const delta = Math.floor(Date.now() / 1000 - epochSeconds);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < MONTH) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < YEAR) return `${Math.floor(delta / MONTH)}mo ago`;
  return `${Math.floor(delta / YEAR)}y ago`;
}
