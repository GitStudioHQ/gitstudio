import * as vscode from "vscode";
import { homedir } from "node:os";
import type { WorktreeEntry, GitRef } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";

// The Worktrees pillar — also absent from free VS Code. Each row is a linked (or
// the main) worktree; actions cover open / add / remove / lock / unlock / prune.

/** One worktree row. */
export class WorktreeNode extends vscode.TreeItem {
  readonly kind = "worktree" as const;
  constructor(
    readonly entry: WorktreeEntry,
    isCurrent: boolean,
  ) {
    const label = entry.bare
      ? "(bare)"
      : entry.branch ?? `${entry.head.slice(0, 7)} (detached)`;
    super(label, vscode.TreeItemCollapsibleState.None);

    this.description = tildify(entry.path) + (isCurrent ? " · current" : "");
    this.iconPath = new vscode.ThemeIcon(
      isCurrent ? "target" : entry.branch ? "git-branch" : "folder",
    );
    this.resourceUri = vscode.Uri.file(entry.path);
    this.contextValue = entry.locked
      ? "gitstudio.worktree.locked"
      : "gitstudio.worktree";
    this.tooltip = buildTooltip(entry, isCurrent);
    this.command = {
      command: "gitstudio.worktree.open",
      title: "Open Worktree",
      arguments: [this],
    };
  }
}

function buildTooltip(
  entry: WorktreeEntry,
  isCurrent: boolean,
): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  const head = entry.branch ?? `${entry.head.slice(0, 7)} (detached)`;
  md.appendMarkdown(`**${escapeMarkdown(head)}**\n\n`);
  md.appendMarkdown(`$(folder) \`${escapeMarkdown(entry.path)}\``);
  if (entry.head) {
    md.appendMarkdown(`\n\n$(git-commit) \`${entry.head.slice(0, 7)}\``);
  }
  const flags: string[] = [];
  if (isCurrent) flags.push("current");
  if (entry.locked) flags.push("locked");
  if (entry.bare) flags.push("bare");
  if (entry.prunable) flags.push("prunable");
  if (flags.length > 0) {
    md.appendMarkdown(`\n\n${flags.join(" · ")}`);
  }
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

/** Replace a leading home dir with "~" for compact display. */
function tildify(p: string): string {
  const home = homedir();
  if (p === home) {
    return "~";
  }
  if (p.startsWith(home + "/")) {
    return "~" + p.slice(home.length);
  }
  return p;
}

/**
 * Feeds the Worktrees tree. The active repo's own root is flagged as current.
 * Refreshes on RepoManager.onDidChange.
 */
export class WorktreesTreeProvider
  implements vscode.TreeDataProvider<WorktreeNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<WorktreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.disposables.push(this.repos.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: WorktreeNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: WorktreeNode): Promise<WorktreeNode[]> {
    if (element) {
      return [];
    }
    const a = this.repos.getActive();
    if (!a) {
      return [];
    }
    try {
      const list = await a.ctx.worktrees.list();
      return list.map(
        (e) => new WorktreeNode(e, samePath(e.path, a.root)),
      );
    } catch {
      return [];
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.emitter.dispose();
  }
}

/** Loose path equality (handles trailing slashes). */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\/+$/, "");
  return norm(a) === norm(b);
}

// ── Commands ─────────────────────────────────────────────────────────────────

function active(repos: RepoManager): RepoEntry | undefined {
  const a = repos.getActive();
  if (!a) {
    void vscode.window.showInformationMessage("GitStudio: no active repository.");
  }
  return a;
}

/** `gitstudio.worktree.open` — open the worktree folder. */
export async function openWorktree(node: WorktreeNode): Promise<void> {
  if (!node) {
    return;
  }
  const uri = vscode.Uri.file(node.entry.path);
  const choice = await vscode.window.showQuickPick(
    [
      { label: "$(window) Open in New Window", value: true },
      { label: "$(arrow-right) Open in This Window", value: false },
    ],
    { title: `Open worktree ${node.label}`, placeHolder: "Where to open" },
  );
  if (choice === undefined) {
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceNewWindow: choice.value,
  });
}

/** `gitstudio.worktree.add` — QuickPick branch/new-branch + a folder. */
export async function addWorktree(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }

  let refs: GitRef[] = [];
  try {
    refs = await a.ctx.refs.listRefs();
  } catch {
    // proceed with new-branch only
  }
  const localBranches = refs.filter((r) => r.type === "head");

  const NEW = "$(add) New branch…";
  const items: vscode.QuickPickItem[] = [
    { label: NEW, description: "create a new branch in the worktree" },
    {
      label: "",
      kind: vscode.QuickPickItemKind.Separator,
    },
    ...localBranches.map((r) => ({
      label: `$(git-branch) ${r.name}`,
      description: r.sha.slice(0, 7),
    })),
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: "New worktree — pick a branch",
    placeHolder: "Check out which branch in the new worktree?",
  });
  if (!picked) {
    return;
  }

  let ref: string;
  let newBranch = false;
  if (picked.label === NEW) {
    const name = await vscode.window.showInputBox({
      title: "New worktree branch",
      prompt: "New branch name",
      placeHolder: "feature/worktree",
      validateInput: validateRefName,
    });
    if (!name) {
      return;
    }
    ref = name;
    newBranch = true;
  } else {
    ref = picked.label.replace(/^\$\(git-branch\)\s*/, "");
  }

  const folders = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    canSelectMany: false,
    openLabel: "Create Worktree Here",
    title: "Pick a parent folder for the new worktree",
  });
  const parent = folders?.[0];
  if (!parent) {
    return;
  }
  // Place the worktree in a subfolder named after the ref's last segment.
  const leaf = ref.split("/").pop() ?? ref;
  const target = vscode.Uri.joinPath(parent, leaf);

  const result = await a.ctx.worktrees.add(target.fsPath, ref, { newBranch });
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: worktree add failed.",
    );
    return;
  }
  refresh();
  const open = await vscode.window.showInformationMessage(
    `Created worktree at ${target.fsPath}`,
    "Open in New Window",
  );
  if (open === "Open in New Window") {
    await vscode.commands.executeCommand("vscode.openFolder", target, {
      forceNewWindow: true,
    });
  }
}

/** `gitstudio.worktree.remove` — confirm + remove. */
export async function removeWorktree(
  repos: RepoManager,
  node: WorktreeNode,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  const ok = await confirm(
    `Remove worktree at ${node.entry.path}? This deletes the worktree's files.`,
    "Remove",
  );
  if (!ok) {
    return;
  }
  let result = await a.ctx.worktrees.remove(node.entry.path);
  if (!result.ok && /dirty|locked|use --force/i.test(result.stderr)) {
    const force = await confirm(
      `The worktree is dirty or locked. Force removal (discarding changes)?`,
      "Force Remove",
    );
    if (!force) {
      return;
    }
    result = await a.ctx.worktrees.remove(node.entry.path, { force: true });
  }
  report(result, "Removed worktree", refresh);
}

/** `gitstudio.worktree.lock` / `.unlock`. */
export async function lockWorktree(
  repos: RepoManager,
  node: WorktreeNode,
  lock: boolean,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  const result = lock
    ? await a.ctx.worktrees.lock(node.entry.path)
    : await a.ctx.worktrees.unlock(node.entry.path);
  report(result, lock ? "Locked worktree" : "Unlocked worktree", refresh);
}

/** `gitstudio.worktree.prune`. */
export async function pruneWorktrees(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const result = await a.ctx.worktrees.prune();
  report(result, "Pruned worktrees", refresh);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function report(
  result: { ok: boolean; stderr: string },
  success: string,
  refresh: () => void,
): void {
  if (result.ok) {
    flash(success);
    refresh();
  } else {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: worktree operation failed.",
    );
  }
}

async function confirm(message: string, action: string): Promise<boolean> {
  const choice = await vscode.window.showWarningMessage(
    message,
    { modal: true },
    action,
  );
  return choice === action;
}

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}

function validateRefName(value: string): string | undefined {
  const name = value.trim();
  if (!name) {
    return "Name cannot be empty";
  }
  if (
    /[ ~^:?*\[\\]/.test(name) ||
    name.includes("..") ||
    name.startsWith("/") ||
    name.endsWith("/") ||
    name.endsWith(".") ||
    name.endsWith(".lock")
  ) {
    return "Invalid character in ref name";
  }
  return undefined;
}
