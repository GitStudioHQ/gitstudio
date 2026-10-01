import * as vscode from "vscode";
import type { FileHistoryEntry } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { touches } from "../git/repoChange";
import { relativeTime } from "../util/relativeTime";
import { isSamePathOrInside, relativeInside } from "../util/repoScope";
import { historyChangeSides, revisionSideUri } from "./revisionContentProvider";
import {
  createTimelineItem,
  type Timeline,
  type TimelineChangeEvent,
  type TimelineItem,
  type TimelineOptions,
  type TimelineProvider,
} from "./timelineApi";
import * as l10n from "@vscode/l10n";

/** The source id this provider registers under (also its TimelineItem.source). */
export const FILE_HISTORY_SOURCE = "gitstudio-file-history";

/** Context value so the Timeline view can attach our menu actions. */
export const FILE_HISTORY_ITEM_CONTEXT = "gitstudio.fileHistoryItem";

const DEFAULT_LIMIT = 50;

/**
 * Surfaces a file's commit history in VS Code's built-in Timeline view. Each
 * entry opens a diff of that commit vs its parent FOR THAT FILE. Paging is
 * cursor-based (the cursor is the number of entries already shown).
 */
export class FileTimelineProvider implements TimelineProvider {
  readonly id = FILE_HISTORY_SOURCE;
  readonly label = l10n.t("GitStudio File History");

  private readonly changeEmitter =
    new vscode.EventEmitter<TimelineChangeEvent | undefined>();
  readonly onDidChange = this.changeEmitter.event;

  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    // Repo activity (commit, checkout, rebase) may add/remove history entries.
    // A file's history is commits: a save or a window focus (vscode.git's
    // status runs) changes none, and emptied the Timeline each time.
    this.disposables.push(
      this.repos.onDidChange((e) => {
        if (touches(e, "refs", "operation", "repos")) {
          this.changeEmitter.fire({ uri: undefined, reset: true });
        }
      }),
    );
  }

  async provideTimeline(
    uri: vscode.Uri,
    options: TimelineOptions,
    token: vscode.CancellationToken,
  ): Promise<Timeline> {
    const entry = this.resolveRepo(uri);
    if (!entry) {
      return { items: [] };
    }

    const rel = relativeInside(uri.fsPath, entry.root);
    if (!rel) {
      return { items: [] };
    }

    // The cursor encodes how many entries we've already returned; fetch that
    // many more plus the page so paging walks deterministically backwards.
    const already = parseCursor(options.cursor);
    const pageSize =
      typeof options.limit === "number" ? options.limit : DEFAULT_LIMIT;
    const maxCount = already + pageSize + 1; // +1 to detect "more".

    const ac = new AbortController();
    token.onCancellationRequested(() => ac.abort());

    let history: FileHistoryEntry[];
    try {
      history = await entry.ctx.history.fileHistory(rel, {
        maxCount,
        follow: true,
        signal: ac.signal,
      });
    } catch {
      return { items: [] };
    }

    const slice = history.slice(already, already + pageSize);
    const hasMore = history.length > already + pageSize;

    const items = slice.map((e) => this.toTimelineItem(entry.root, rel, e));

    return {
      items,
      paging: hasMore
        ? { cursor: String(already + pageSize) }
        : undefined,
    };
  }

  private toTimelineItem(
    root: string,
    rel: string,
    e: FileHistoryEntry,
  ): TimelineItem {
    const item = createTimelineItem(e.subject, e.authorDate * 1000);
    item.id = e.sha;
    item.description = `${e.author} · ${e.shortSha}`;
    item.iconPath = new vscode.ThemeIcon("git-commit");
    item.contextValue = FILE_HISTORY_ITEM_CONTEXT;

    const when = new Date(e.authorDate * 1000).toLocaleString();
    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${escapeMd(e.subject)}**\n\n`);
    tooltip.appendMarkdown(
      `${escapeMd(e.author)} <${escapeMd(e.authorEmail)}>\n\n`,
    );
    tooltip.appendMarkdown(
      `${escapeMd(when)} (${relativeTime(e.authorDate)})\n\n`,
    );
    tooltip.appendMarkdown(`\`${e.sha}\``);
    if (e.body && e.body.trim().length > 0) {
      tooltip.appendMarkdown(`\n\n${escapeMd(e.body.trim())}`);
    }
    item.detail = tooltip;

    const fileName = baseName(rel);
    // Diff this commit vs its parent for THIS file, under the names it had
    // there (a commit older than a rename knows it by its old name). `<sha>~1`
    // is the parent; RevisionContentProvider yields "" when the parent lacks
    // the file (the commit that introduced it), so the left side is empty.
    const sides = historyChangeSides(e);
    item.command = {
      title: l10n.t("Open Changes"),
      command: "vscode.diff",
      arguments: [
        revisionSideUri(root, rel, sides.left),
        revisionSideUri(root, rel, sides.right),
        `${fileName} (${e.shortSha})`,
        { preview: true } satisfies vscode.TextDocumentShowOptions,
      ],
    };

    return item;
  }

  private resolveRepo(uri: vscode.Uri): RepoEntry | undefined {
    if (uri.scheme !== "file") {
      return undefined;
    }
    const path = uri.fsPath;
    let best: RepoEntry | undefined;
    for (const entry of this.repos.getAll()) {
      // Separator- and case-tolerant (see historyContext): a "/"-only
      // boundary gave every Windows file an empty Timeline.
      if (isSamePathOrInside(path, entry.root)) {
        if (best === undefined || entry.root.length > best.root.length) {
          best = entry;
        }
      }
    }
    return best;
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.changeEmitter.dispose();
  }
}

function parseCursor(cursor: string | undefined): number {
  const n = cursor ? Number(cursor) : 0;
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function baseName(rel: string): string {
  const parts = rel.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || rel;
}

function escapeMd(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|<>]/g, (c) => `\\${c}`);
}
