import * as vscode from "vscode";
import type { CommitRecord } from "@gitstudio/host-bridge/git";
import type { RepoManager } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";

// How many commits we load for the active branch. M2 keeps this a flat,
// bounded list; the full paginated graph lands in a later milestone.
const COMMIT_PAGE_SIZE = 150;

/** A commit row in the Commits tree. Carries the full record for actions. */
export class CommitNode extends vscode.TreeItem {
  constructor(readonly commit: CommitRecord) {
    super(commit.subject || "(no commit message)", vscode.TreeItemCollapsibleState.None);

    const shortSha = commit.sha.slice(0, 7);
    this.description = `${shortSha} · ${relativeTime(commit.authorDate)}`;
    this.iconPath = new vscode.ThemeIcon("git-commit");
    this.contextValue = "gitstudio.commit";
    this.tooltip = buildCommitTooltip(commit);
  }
}

function buildCommitTooltip(commit: CommitRecord): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  const date = new Date(commit.authorDate * 1000);

  md.appendMarkdown(`**${escapeMarkdown(commit.subject)}**\n\n`);
  md.appendMarkdown(`$(git-commit) \`${commit.sha.slice(0, 12)}\`\n\n`);
  md.appendMarkdown(
    `$(account) ${escapeMarkdown(commit.author)} <${escapeMarkdown(commit.authorEmail)}>\n\n`,
  );
  md.appendMarkdown(`$(calendar) ${date.toLocaleString()}\n`);

  const body = commit.body.trim();
  if (body) {
    md.appendMarkdown(`\n---\n\n${escapeMarkdown(body)}`);
  }
  return md;
}

/** Escapes the markdown control characters that show up in commit text. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

/**
 * Feeds the Commits tree: the first ~150 commits of the active repo's current
 * branch, refreshed whenever the RepoManager signals a change. In-flight loads
 * are cancelled when a newer refresh arrives.
 */
export class CommitsTreeProvider
  implements vscode.TreeDataProvider<CommitNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<CommitNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private loadController: AbortController | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.disposables.push(this.repos.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    // Cancel any in-flight load; the next getChildren starts a fresh one.
    this.loadController?.abort();
    this.loadController = undefined;
    this.emitter.fire(undefined);
  }

  getTreeItem(element: CommitNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: CommitNode): Promise<CommitNode[]> {
    if (element) {
      return [];
    }
    const active = this.repos.getActive();
    if (!active) {
      return [];
    }

    // Each load owns a controller; abort supersedes a stale in-flight read.
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;

    const nodes: CommitNode[] = [];
    try {
      for await (const commit of active.ctx.log.streamCommits({
        revRange: "HEAD",
        maxCount: COMMIT_PAGE_SIZE,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) {
          return [];
        }
        nodes.push(new CommitNode(commit));
      }
    } catch (err) {
      if (controller.signal.aborted) {
        return [];
      }
      // No commits yet (fresh repo) or transient git error — show empty, the
      // viewsWelcome/empty state handles the no-repo case.
      return [];
    } finally {
      if (this.loadController === controller) {
        this.loadController = undefined;
      }
    }
    return nodes;
  }

  dispose(): void {
    this.loadController?.abort();
    this.loadController = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

/**
 * Copies a commit's full SHA to the clipboard. Accepts either a CommitNode
 * (tree item context-menu action) or a raw sha string (the blame hover's
 * command link).
 */
export async function copyCommitSha(
  arg?: CommitNode | string,
): Promise<void> {
  const sha = typeof arg === "string" ? arg : arg?.commit.sha;
  if (!sha) {
    return;
  }
  await vscode.env.clipboard.writeText(sha);
  void vscode.window.setStatusBarMessage(
    `$(check) Copied ${sha.slice(0, 7)}`,
    2000,
  );
}
