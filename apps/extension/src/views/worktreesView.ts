import * as vscode from "vscode";
import {
  promptConfirm,
  promptInput,
  promptPick,
  type DialogChoice,
} from "../ui/dialogs";
import { homedir } from "node:os";
import * as path from "node:path";
import type { WorktreeEntry, GitRef } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { bareName, shortNameOf, startPointOf } from "./worktreeRefs";

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
          `${e.path}\u0000${e.head}\u0000${e.branch ?? ""}\u0000${e.bare ? 1 : 0}${e.locked ? 1 : 0}${e.prunable ? 1 : 0}`,
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
  const choice = await promptPick({
    title: `Open worktree ${node.label}`,
    hint: node.entry.path,
    choices: [
      { id: "new", label: "Open in New Window", icon: "window" },
      { id: "here", label: "Open in This Window", icon: "arrow-right", description: "Replaces what is currently open." },
    ],
  });
  if (choice === undefined) {
    return;
  }
  await vscode.commands.executeCommand("vscode.openFolder", uri, {
    forceNewWindow: choice === "new",
  });
}

/** `gitstudio.worktree.add` — pick a ref (branch/remote/tag, or a new one) + a folder. */
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

  // A sentinel id no ref can collide with: git forbids ":" in a ref name.
  const NEW = "gitstudio:new-branch";

  // Local branches, remote branches, and tags — so you can base a worktree on
  // origin/main without first checking it out anywhere. Keyed by the FULL ref:
  // a local branch and a tag can legally share a short name (git warns "refname
  // 'v1.2' is ambiguous"), and keying by the short name would silently resolve
  // the picked row to whichever ref git listed last. Labels stay short.
  const byId = new Map<string, GitRef>();
  const choices: DialogChoice[] = [
    {
      id: NEW,
      label: "New branch…",
      icon: "add",
      description: "Create a new branch from the current HEAD.",
    },
  ];
  for (const r of refs) {
    // stash is not a worktree ref; "/HEAD" (origin/HEAD) is a symbolic pointer
    // to the remote's default branch and checking it out detaches at whatever
    // it points to — never offer it.
    if (r.type === "stash" || r.name.endsWith("/HEAD")) {
      continue;
    }
    const key = r.fullName ?? r.name;
    byId.set(key, r);
    choices.push({
      id: key,
      label: r.name,
      icon: r.type === "head" ? "git-branch" : r.type === "remote" ? "cloud" : "tag",
      detail: r.sha.slice(0, 7),
    });
  }

  const picked = await promptPick({
    title: "New worktree — pick a ref",
    hint: "What should the new worktree be based on?",
    choices,
  });
  if (!picked) {
    return;
  }

  if (picked === NEW) {
    const name = await promptInput({
      title: "New worktree branch",
      hint: "The branch is created at the current HEAD and checked out in the new worktree.",
      placeholder: "feature/worktree",
      confirmLabel: "Continue",
      validate: "refName",
    });
    if (!name) {
      return;
    }
    await pickFolderAndCreate(
      a,
      { branchName: name, newBranch: true },
      refresh,
    );
    return;
  }

  const ref = byId.get(picked);
  if (!ref) {
    return;
  }
  await worktreeFromRef(repos, ref, refresh);
}

/**
 * Shared "create a worktree from an existing ref" flow — used by the Worktrees
 * view's "New Worktree" (after picking a ref) and by the branch menu's
 * "New Worktree from '…'". Works for local branches, remote branches, and tags,
 * and never requires switching off the current branch.
 */
export async function worktreeFromRef(
  repos: RepoManager,
  ref: GitRef,
  refresh: () => void,
): Promise<void> {
  const a = active(repos);
  if (!a) {
    return;
  }

  // The branch-menu webview sends name + type only (no fullName). Re-resolve the
  // authoritative fullName from listRefs() so the start point and the direct
  // checkout are exact even when git disambiguated the short name: a genuine
  // branch named "heads/x" and a collision-prefixed name are string-identical,
  // so name-based stripping alone would mis-strip one of them.
  let resolved = ref;
  if (!ref.fullName) {
    try {
      const refs = await a.ctx.refs.listRefs();
      resolved =
        refs.find((r) => r.type === ref.type && r.name === ref.name) ?? ref;
    } catch {
      // keep the webview ref
    }
  }

  const isLocal = resolved.type === "head";
  const mode = await promptPick({
    title: `Worktree from '${resolved.name}'`,
    hint: "Check it out directly, or as a new named branch?",
    choices: [
      {
        id: "direct",
        label: isLocal ? resolved.name : `${resolved.name} (detached)`,
        icon: isLocal ? "git-branch" : "git-commit",
        description: isLocal
          ? `Check out the existing local branch ${resolved.name}.`
          : `Check out ${resolved.name} as a detached HEAD.`,
      },
      {
        id: "new",
        label: "New branch…",
        icon: "add",
        description: `Create a new local branch starting from ${resolved.name}.`,
      },
    ],
  });
  if (!mode) {
    return;
  }

  if (mode === "direct") {
    // Local branches attach via their short name; a full refs/heads/… would
    // silently detach. Remote/tag refs must detach and need the full ref so a
    // tag sharing a branch's short name can't resolve ambiguously — startPointOf
    // also reconstructs the full ref for the branch-menu path, which only sends
    // name + type. bareName strips git's collision disambiguator ("heads/x").
    const directRef =
      resolved.type === "head"
        ? bareName(resolved)
        : (startPointOf(resolved) ?? bareName(resolved));
    await pickFolderAndCreate(
      a,
      { branchName: directRef, newBranch: false },
      refresh,
    );
    return;
  }

  const name = await promptInput({
    title: "New worktree branch",
    hint: `A new local branch is created from ${resolved.name} and checked out in the new worktree.`,
    placeholder: "feature/worktree",
    confirmLabel: "Continue",
    validate: "refName",
  });
  if (!name) {
    return;
  }

  const startPoint = startPointOf(resolved);
  // simple upstream semantics: track only when the new branch's name matches
  // the start point's short name. A differently-named branch would otherwise
  // auto-track the remote under git's default branch.autoSetupMerge, and
  // GitStudio's push then targets that remote branch.
  const short = startPoint ? shortNameOf(startPoint) : undefined;
  await pickFolderAndCreate(
    a,
    {
      branchName: name,
      newBranch: true,
      startPoint,
      noTrack: !!startPoint && short !== undefined && name !== short,
    },
    refresh,
  );
}

/**
 * Pick a parent folder, then add the worktree in a subfolder named after the
 * branch's last segment and report the outcome. Shared by every create route so
 * the folder/dir-naming logic stays in exactly one place.
 */
async function pickFolderAndCreate(
  a: RepoEntry,
  opts: {
    branchName: string;
    newBranch: boolean;
    startPoint?: string;
    noTrack?: boolean;
  },
  refresh: () => void,
): Promise<void> {
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
  // Place the worktree in a subfolder named after the ref's last segment. When
  // gitstudio.worktrees.prefixWithProjectName is on, prefix it with the MAIN
  // repository's folder name — resolved from `git worktree list` (whose first
  // entry is always the main checkout), so the prefix is stable no matter which
  // (possibly linked) worktree initiated the add.
  const leaf = opts.branchName.split("/").pop() ?? opts.branchName;
  let dirName = leaf;
  const prefixEnabled = vscode.workspace
    .getConfiguration("gitstudio")
    .get<boolean>("worktrees.prefixWithProjectName", false);
  if (prefixEnabled) {
    const mainRoot = await a.ctx.worktrees.mainRoot();
    if (mainRoot) {
      const project = path.basename(mainRoot);
      if (project) {
        dirName = `${project}-${leaf}`;
      }
    }
  }
  const target = vscode.Uri.joinPath(parent, dirName);

  const result = await a.ctx.worktrees.add(target.fsPath, opts.branchName, {
    newBranch: opts.newBranch,
    startPoint: opts.startPoint,
    noTrack: opts.noTrack,
  });
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
  const ok = await promptConfirm({
    title: `Remove worktree at ${node.entry.path}?`,
    message:
      "The worktree's directory and its files are deleted from disk. The branch it had checked out is left alone.",
    confirmLabel: "Remove",
    danger: true,
  });
  if (!ok) {
    return;
  }
  let result = await a.ctx.worktrees.remove(node.entry.path);
  if (!result.ok && /dirty|locked|use --force/i.test(result.stderr)) {
    const force = await promptConfirm({
      title: "The worktree is dirty or locked",
      message:
        "Forcing removal deletes it anyway, discarding any uncommitted changes inside it. Those edits were never committed, so nothing can bring them back.",
      confirmLabel: "Force Remove",
      danger: true,
    });
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

function flash(message: string): void {
  void vscode.window.setStatusBarMessage(`$(check) ${message}`, 2500);
}
