import * as vscode from "vscode";
import type { GitRef } from "@gitstudio/host-bridge/git";
import type { RepoManager } from "../git/repoManager";

// The tree has two levels: fixed category roots (Local / Remotes / Tags) and
// the refs grouped under them. Stashes are deferred to M9, so there's no
// Stashes category here.
type RefCategory = "local" | "remotes" | "tags";

const CATEGORY_LABELS: Record<RefCategory, string> = {
  local: "Local",
  remotes: "Remotes",
  tags: "Tags",
};

/** Union of the rows the Branches tree renders. */
type BranchTreeNode = CategoryNode | RefNode;

/** A collapsible category header (Local / Remotes / Tags). */
class CategoryNode extends vscode.TreeItem {
  readonly kind = "category" as const;
  constructor(
    readonly category: RefCategory,
    count: number,
  ) {
    super(
      CATEGORY_LABELS[category],
      vscode.TreeItemCollapsibleState.Expanded,
    );
    this.description = String(count);
    this.contextValue = `gitstudio.category.${category}`;
    this.iconPath = new vscode.ThemeIcon(
      category === "remotes" ? "cloud" : category === "tags" ? "tag" : "git-branch",
    );
  }
}

/** A single ref (branch / remote branch / tag). */
class RefNode extends vscode.TreeItem {
  readonly kind = "ref" as const;
  constructor(readonly ref: GitRef) {
    super(ref.name, vscode.TreeItemCollapsibleState.None);

    if (ref.type === "head") {
      this.iconPath = ref.isCurrent
        ? new vscode.ThemeIcon("target")
        : new vscode.ThemeIcon("git-branch");
      if (ref.isCurrent) {
        this.description = "current";
      }
      this.contextValue = "gitstudio.branch";
    } else if (ref.type === "remote") {
      this.iconPath = new vscode.ThemeIcon("cloud");
      this.contextValue = "gitstudio.remoteBranch";
    } else {
      this.iconPath = new vscode.ThemeIcon("tag");
      this.contextValue = "gitstudio.tag";
    }

    this.tooltip = buildRefTooltip(ref);
  }
}

function buildRefTooltip(ref: GitRef): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMarkdown(ref.name)}**\n\n`);
  md.appendMarkdown(`$(git-commit) \`${ref.sha.slice(0, 7)}\``);
  if (ref.upstream) {
    md.appendMarkdown(`\n\n$(cloud) ${escapeMarkdown(ref.upstream)}`);
  }
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

const CATEGORY_OF_TYPE: Record<GitRef["type"], RefCategory | undefined> = {
  head: "local",
  remote: "remotes",
  tag: "tags",
  stash: undefined,
};

/**
 * Feeds the Branches tree. Roots are the three category headers; their children
 * are the active repo's refs grouped by type. Refreshes on RepoManager change.
 */
export class RefsTreeProvider
  implements vscode.TreeDataProvider<BranchTreeNode>, vscode.Disposable
{
  private readonly emitter =
    new vscode.EventEmitter<BranchTreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  private readonly disposables: vscode.Disposable[] = [];
  /** Cached refs grouped by category, populated on the root load. */
  private grouped: Record<RefCategory, GitRef[]> = {
    local: [],
    remotes: [],
    tags: [],
  };

  constructor(private readonly repos: RepoManager) {
    this.disposables.push(this.repos.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: BranchTreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: BranchTreeNode): Promise<BranchTreeNode[]> {
    if (element) {
      if (element.kind === "category") {
        return this.grouped[element.category].map((ref) => new RefNode(ref));
      }
      return [];
    }

    const active = this.repos.getActive();
    if (!active) {
      this.grouped = { local: [], remotes: [], tags: [] };
      return [];
    }

    const next: Record<RefCategory, GitRef[]> = {
      local: [],
      remotes: [],
      tags: [],
    };
    try {
      const refs = await active.ctx.refs.listRefs();
      for (const ref of refs) {
        const category = CATEGORY_OF_TYPE[ref.type];
        if (category) {
          next[category].push(ref);
        }
      }
    } catch {
      // Transient git error — show empty categories rather than throwing.
    }
    this.grouped = next;

    return (Object.keys(CATEGORY_LABELS) as RefCategory[]).map(
      (category) => new CategoryNode(category, next[category].length),
    );
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}
