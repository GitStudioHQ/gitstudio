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

    // Description leads with status flags (current first), then the path.
    const flags: string[] = [];
    if (isCurrent) flags.push("current");
    if (entry.locked) flags.push("locked");
    if (entry.bare) flags.push("bare");
    if (entry.prunable) flags.push("prunable");
    const path = tildify(entry.path);
    this.description = flags.length > 0 ? `${flags.join(" · ")} · ${path}` : path;

    // Icon conveys status: current worktree gets an accent, prunable warns,
    // locked shows a lock, otherwise branch / detached folder.
    if (isCurrent) {
      this.iconPath = new vscode.ThemeIcon(
        "check",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      );
    } else if (entry.prunable) {
      this.iconPath = new vscode.ThemeIcon(
        "warning",
        new vscode.ThemeColor("charts.yellow"),
      );
    } else if (entry.locked) {
      this.iconPath = new vscode.ThemeIcon("lock");
    } else {
      this.iconPath = new vscode.ThemeIcon(entry.branch ? "git-branch" : "folder");
    }
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
  const headIcon = entry.bare
    ? "$(archive)"
    : entry.branch
      ? "$(git-branch)"
      : "$(git-commit)";
  md.appendMarkdown(`${headIcon} **${escapeMarkdown(head)}**\n\n`);
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

  /**
   * A short-TTL cache of the worktree list. RepoManager's change event is a
   * firehose — it fires on every ref write (commits, fetches, branch updates) —
   * but worktree membership changes rarely, so serving a cached list for a few
   * seconds avoids re-spawning `git worktree list` on every unrelated git poke.
   * An explicit refresh() (a worktree add/remove, or the refresh button) busts
   * it, so real changes still show immediately.
   */
  private cache: { root: string; at: number; nodes: WorktreeNode[] } | undefined;
  private static readonly TTL_MS = 4000;
  /**
   * Set by refresh() (a worktree add/remove/lock/prune, or the refresh button)
   * so the very next getChildren skips the persisted seed and awaits a fresh
   * `git worktree list` — after a mutation the persisted list is stale by one
   * entry, and we don't want it to flash before the fresh list lands.
   */
  private forceFresh = false;
  /** In-flight `git worktree list` for a root, so prewarm() and VS Code's own
   * first render (which fire getChildren twice in quick succession) share ONE
   * spawn instead of racing two concurrent ones. */
  private inflight: { root: string; p: Promise<WorktreeEntry[]> } | undefined;

  constructor(
    private readonly repos: RepoManager,
    /** workspaceState — persists the last worktree list across window reloads
     * so the FIRST paint of a session is instant instead of paying a cold
     * `git worktree list` spawn (the in-memory cache is empty on every reload). */
    private readonly store: vscode.Memento,
  ) {
    // Passive repo changes just re-emit; getChildren serves the cache (below).
    this.disposables.push(
      this.repos.onDidChange(() => this.emitter.fire(undefined)),
    );
  }

  refresh(): void {
    this.cache = undefined;
    this.forceFresh = true;
    this.emitter.fire(undefined);
  }

  /** Warm the in-memory cache off the reveal path (called right after the view
   * is created) so a cold spawn overlaps activation instead of blocking first
   * reveal. Fire-and-forget; errors are swallowed by getChildren. */
  prewarm(): void {
    void this.getChildren();
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
      this.cache = undefined;
      return [];
    }
    const now = Date.now();
    if (
      this.cache &&
      this.cache.root === a.root &&
      now - this.cache.at < WorktreesTreeProvider.TTL_MS
    ) {
      return this.cache.nodes;
    }
    // Cross-session cold start: seed from the persisted list for an instant
    // first paint, then revalidate in the background. Skipped right after an
    // explicit refresh (forceFresh) so mutations never flash a stale entry.
    if (!this.cache && !this.forceFresh) {
      const persisted = this.store.get<WorktreeEntry[]>(this.storeKey(a.root));
      if (persisted && persisted.length) {
        const nodes = this.buildNodes(persisted, a.root);
        // Seed as a normal fresh cache entry so VS Code's own first render
        // cache-HITS this instead of falling through to a second fetch; the
        // background revalidate below is the only thing that touches git.
        this.cache = { root: a.root, at: now, nodes };
        void this.revalidate(a);
        return nodes;
      }
    }
    this.forceFresh = false;
    return this.fetch(a, now);
  }

  private storeKey(root: string): string {
    return `gitstudio.worktrees:${root}`;
  }

  private buildNodes(list: WorktreeEntry[], root: string): WorktreeNode[] {
    return list.map((e) => new WorktreeNode(e, samePath(e.path, root)));
  }

  /** Dedup the git spawn: concurrent callers for the same root share one list. */
  private listOnce(a: RepoEntry): Promise<WorktreeEntry[]> {
    if (this.inflight && this.inflight.root === a.root) {
      return this.inflight.p;
    }
    const p = a.ctx.worktrees.list();
    this.inflight = { root: a.root, p };
    const clear = (): void => {
      if (this.inflight && this.inflight.p === p) {
        this.inflight = undefined;
      }
    };
    p.then(clear, clear);
    return p;
  }

  /** Stable signature of a worktree list, to skip needless repaints. */
  private signature(list: WorktreeEntry[]): string {
    return list
      .map(
        (e) =>
          `${e.path} ${e.head} ${e.branch ?? ""} ${e.bare ? 1 : 0}${e.locked ? 1 : 0}${e.prunable ? 1 : 0}`,
      )
      .join("");
  }

  /** Awaited fetch — used for the first-ever load of a repo and after refresh. */
  private async fetch(a: RepoEntry, at: number): Promise<WorktreeNode[]> {
    try {
      const list = await this.listOnce(a);
      // An empty result means a failed read: a valid repo always lists at least
      // its own main worktree. Keep the last good list rather than blanking it
      // (and don't clobber the persisted seed with []).
      if (list.length === 0) {
        return this.cache && this.cache.root === a.root ? this.cache.nodes : [];
      }
      const nodes = this.buildNodes(list, a.root);
      this.cache = { root: a.root, at, nodes };
      void this.store.update(this.storeKey(a.root), list);
      return nodes;
    } catch {
      // Keep showing the last good list for this repo if we have one.
      return this.cache && this.cache.root === a.root ? this.cache.nodes : [];
    }
  }

  /** Background refresh behind a seeded (persisted) paint — repaints only on
   * an actual change so an unchanged list doesn't flicker the whole tree. */
  private async revalidate(a: RepoEntry): Promise<void> {
    try {
      const prevSig = this.signature(
        this.store.get<WorktreeEntry[]>(this.storeKey(a.root)) ?? [],
      );
      const list = await this.listOnce(a);
      if (list.length === 0) {
        return; // failed read — keep the seeded/last-good list
      }
      const nodes = this.buildNodes(list, a.root);
      this.cache = { root: a.root, at: Date.now(), nodes };
      void this.store.update(this.storeKey(a.root), list);
      if (this.signature(list) !== prevSig) {
        this.emitter.fire(undefined);
      }
    } catch {
      // Keep the seeded view; a later change event will retry.
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

/** Loose path equality: tolerant of trailing slashes AND of git's forward-slash
 * worktree paths vs vscode fsPath backslashes on Windows (and of case on
 * macOS/Windows). Without the separator/case unification the current worktree
 * was never matched on Windows. */
function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    const unified = p.replace(/[\\/]+/g, "/").replace(/\/+$/, "");
    return process.platform === "linux" ? unified : unified.toLowerCase();
  };
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
