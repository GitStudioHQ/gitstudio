import * as vscode from "vscode";
import type { StashEntry } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";

// The Stashes pillar — genuinely absent from free VS Code, so GitStudio makes it
// first-class. Each row is one `git stash` entry; clicking opens its diff, and
// inline/context actions cover apply / pop / drop (with Undo) / create-branch.

const STASH_DIFF_SCHEME = "gitstudio-stash";

/** One stash row, carrying the entry for the action commands. */
export class StashNode extends vscode.TreeItem {
  readonly kind = "stash" as const;
  constructor(readonly entry: StashEntry) {
    super(
      entry.message || entry.ref,
      vscode.TreeItemCollapsibleState.None,
    );
    this.description = `${entry.ref} · ${relativeTime(entry.time)}`;
    this.iconPath = new vscode.ThemeIcon("git-stash");
    this.contextValue = "gitstudio.stash";
    this.tooltip = buildTooltip(entry);
    this.command = {
      command: "gitstudio.stash.show",
      title: "Show Stash Diff",
      arguments: [this],
    };
  }
}

function buildTooltip(entry: StashEntry): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.supportThemeIcons = true;
  md.appendMarkdown(`**${escapeMarkdown(entry.message || entry.ref)}**\n\n`);
  md.appendMarkdown(`$(git-stash) \`${entry.ref}\`\n\n`);
  md.appendMarkdown(`$(git-commit) \`${entry.sha.slice(0, 7)}\``);
  return md;
}

function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

/**
 * Feeds the Stashes tree (a flat list, newest first). Refreshes on
 * RepoManager.onDidChange.
 */
export class StashesTreeProvider
  implements vscode.TreeDataProvider<StashNode>, vscode.Disposable
{
  private readonly emitter = new vscode.EventEmitter<StashNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly repos: RepoManager) {
    this.disposables.push(this.repos.onDidChange(() => this.refresh()));
  }

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(element: StashNode): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: StashNode): Promise<StashNode[]> {
    if (element) {
      return [];
    }
    const active = this.repos.getActive();
    if (!active) {
      return [];
    }
    try {
      const entries = await active.ctx.stashes.list();
      return entries.map((e) => new StashNode(e));
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

/**
 * Read-only content provider for stash diffs, so `gitstudio.stash.show` opens
 * the patch in a regular (diff-highlighted) read-only editor. The uri encodes
 * the repo root + stash ref; content is resolved lazily via the StashProvider.
 */
export class StashDiffContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  static readonly scheme = STASH_DIFF_SCHEME;

  constructor(private readonly repos: RepoManager) {}

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // uri.path is "/<encoded ref>.diff"; the repo root rides in the query.
    const ref = decodeURIComponent(
      uri.path.replace(/^\//, "").replace(/\.diff$/, ""),
    );
    const root = uri.query;
    const entry = this.repos.getAll().find((e) => e.root === root);
    if (!entry) {
      return "";
    }
    return entry.ctx.stashes.show(ref);
  }

  dispose(): void {
    // no-op
  }
}

/** Build the read-only uri a stash diff renders from. */
export function stashDiffUri(root: string, ref: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: STASH_DIFF_SCHEME,
    path: `/${encodeURIComponent(ref)}.diff`,
    query: root,
  });
}

// ── Commands ─────────────────────────────────────────────────────────────────

/** Resolve the active repo, or surface a hint. */
function active(repos: RepoManager): RepoEntry | undefined {
  const a = repos.getActive();
  if (!a) {
    void vscode.window.showInformationMessage("GitStudio: no active repository.");
  }
  return a;
}

/** `gitstudio.stash.show` — open the stash's diff in a read-only editor. */
export async function showStash(
  repos: RepoManager,
  node: StashNode,
): Promise<void> {
  const a = repos.getActive();
  if (!a || !node) {
    return;
  }
  const uri = stashDiffUri(a.root, node.entry.ref);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.languages.setTextDocumentLanguage(doc, "diff");
  await vscode.window.showTextDocument(doc, { preview: true });
}

/** `gitstudio.stash.save` — QuickPick a message + options, then stash. */
export async function saveStash(
  repos: RepoManager,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }
  const message = await vscode.window.showInputBox({
    title: "Stash changes",
    prompt: "Optional stash message",
    placeHolder: "WIP: …",
  });
  if (message === undefined) {
    return; // cancelled
  }

  const options = await vscode.window.showQuickPick(
    [
      {
        label: "$(file) Include untracked files",
        description: "--include-untracked",
        picked: false,
        id: "untracked",
      },
      {
        label: "$(check) Keep staged changes staged",
        description: "--keep-index",
        picked: false,
        id: "keep",
      },
    ],
    {
      title: "Stash options",
      placeHolder: "Toggle options (Enter to stash)",
      canPickMany: true,
    },
  );
  if (options === undefined) {
    return; // cancelled
  }

  const result = await a.ctx.stashes.save({
    message: message || undefined,
    includeUntracked: options.some((o) => o.id === "untracked"),
    keepIndex: options.some((o) => o.id === "keep"),
  });
  if (!result.ok) {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: stash failed.",
    );
    return;
  }
  flash("Stashed changes");
  refresh();
}

/** `gitstudio.stash.apply` — apply without dropping. */
export async function applyStash(
  repos: RepoManager,
  node: StashNode,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  const result = await a.ctx.stashes.apply(node.entry.ref);
  reportStashOp(result, "Applied stash", refresh);
}

/** `gitstudio.stash.pop` — apply then drop (routed through Undo). */
export async function popStash(
  repos: RepoManager,
  node: StashNode,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  const ledger = repos.getUndoLedger();
  const run = () => a.ctx.stashes.pop(node.entry.ref);
  const result = ledger
    ? await ledger.runWithUndo(a, `Pop ${node.entry.ref}`, run)
    : await run();
  reportStashOp(result, "Popped stash", refresh);
}

/** `gitstudio.stash.drop` — confirm + drop (routed through Undo). */
export async function dropStash(
  repos: RepoManager,
  node: StashNode,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  const ok = await confirm(
    `Drop ${node.entry.ref}? This discards the stashed changes.`,
    "Drop",
  );
  if (!ok) {
    return;
  }
  const ledger = repos.getUndoLedger();
  const run = () => a.ctx.stashes.drop(node.entry.ref);
  const result = ledger
    ? await ledger.runWithUndo(a, `Drop ${node.entry.ref}`, run)
    : await run();
  reportStashOp(result, "Dropped stash", refresh);
}

/** `gitstudio.stash.branch` — create a branch from the stash. */
export async function branchFromStash(
  repos: RepoManager,
  node: StashNode,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a || !node) {
    return;
  }
  const name = await vscode.window.showInputBox({
    title: `Create branch from ${node.entry.ref}`,
    prompt: "New branch name",
    placeHolder: "feature/from-stash",
    validateInput: validateRefName,
  });
  if (!name) {
    return;
  }
  const result = await a.ctx.stashes.branch(node.entry.ref, name);
  reportStashOp(result, `Created branch ${name}`, refresh);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function reportStashOp(
  result: { ok: boolean; stderr: string },
  success: string,
  refresh: () => void,
): void {
  if (result.ok) {
    flash(success);
    refresh();
  } else {
    void vscode.window.showErrorMessage(
      result.stderr.trim() || "GitStudio: stash operation failed.",
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
