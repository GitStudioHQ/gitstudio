import * as vscode from "vscode";
import * as path from "node:path";
import { GitContext, GitProcess } from "@gitstudio/git-service/index";
import type { API, Repository } from "./git";
import { getBuiltInGitApi } from "./builtInGit";

// Coalesce bursts of git activity (a rebase touches many ref files in quick
// succession) into a single refresh, while still feeling instant on a branch
// switch or commit.
const REFRESH_DEBOUNCE_MS = 400;

/**
 * The minimal Undo surface the RepoManager exposes to destructive-op sites,
 * kept structural so RepoManager never imports the concrete UndoLedger (which
 * imports RepoManager).
 */
export interface UndoLedgerLike {
  runWithUndo<T>(
    repo: RepoEntry,
    label: string,
    fn: () => Promise<T>,
  ): Promise<T>;
}

/** A live repository: its root, our data context, and (once vscode.git has
 * activated) its vscode.git handle. `repo` is UNDEFINED for eagerly-discovered
 * repos — we find the root + spin up our own git-service `ctx` immediately from
 * the workspace folders, so the ctx-driven views (worktrees, stashes, graph)
 * render without waiting for vscode.git; `repo` (used for live working-tree
 * state) attaches when vscode.git finishes activating. */
export interface RepoEntry {
  /** Absolute repo root (fsPath of `repo.rootUri`). */
  readonly root: string;
  /** vscode.git's Repository — undefined until vscode.git activation reconciles. */
  readonly repo?: Repository;
  readonly ctx: GitContext;
}

/** Per-repo disposables we own (state listener + .git watchers). */
interface RepoBinding {
  readonly entry: RepoEntry;
  readonly disposables: vscode.Disposable[];
}

/**
 * Owns the set of open repositories and the notion of the "active" one (the
 * repo containing the active editor's file, else the first). Surfaces a single
 * debounced `onDidChange` that the tree views subscribe to, firing on repo
 * open/close, active-editor moves across repos, vscode.git state changes, and
 * direct `.git` ref/op-state mutations (for instant refresh).
 */
export class RepoManager implements vscode.Disposable {
  private api: API | undefined;
  private readonly bindings = new Map<string, RepoBinding>();
  private activeRoot: string | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires (debounced) whenever the active repo's data may have changed. */
  readonly onDidChange = this.changeEmitter.event;

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor() {}

  /**
   * Constructs a RepoManager and kicks git-API activation in the BACKGROUND —
   * it does NOT await it. The caller can register every view/provider
   * immediately (they all tolerate "no repo yet"); init() fires onDidChange once
   * repos are discovered so the views fill in. Awaiting git activation here
   * gated every GitStudio view behind vscode.git (0.5–2s on a cold start) — the
   * #1 cause of "the view takes seconds to appear on first open".
   */
  static async create(): Promise<RepoManager> {
    const manager = new RepoManager();
    // Discover repos from the workspace folders via OUR OWN git (one fast
    // `git rev-parse` each) so views get a root + git-service ctx INSTANTLY,
    // without waiting for vscode.git to activate + scan (the gate that made
    // every view take ~a second on first open).
    void manager.eagerDiscover();
    void manager.init().catch(() => {
      // git unavailable — the views simply stay in their no-repo state.
    });
    return manager;
  }

  /** Fast, vscode.git-independent repo discovery from the open workspace
   * folders. Each folder's git toplevel is resolved with a single spawn; a
   * git-service-only (eager) binding is created so ctx-driven views render at
   * once. vscode.git reconciles + attaches `repo` later (see addRepo). */
  private async eagerDiscover(): Promise<void> {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const roots = await Promise.all(
      folders.map((f) => this.gitToplevel(f.uri.fsPath)),
    );
    let added = false;
    for (const root of roots) {
      if (root && !this.bindings.has(root)) {
        this.addEagerRepo(root);
        added = true;
      }
    }
    if (added) {
      this.recomputeActive();
      this.updateHasRepoContext();
      this.changeEmitter.fire();
    }
  }

  /** One `git rev-parse …` with a hard timeout (a hung git must never block
   * eager discovery or leak the child). */
  private async revParse(
    cwd: string,
    args: string[],
  ): Promise<string | undefined> {
    const proc = new GitProcess({ cwd, gitPath: this.gitPath() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const r = await proc.run(args, { signal: controller.signal });
      return r.code === 0 ? r.stdout.trim() || undefined : undefined;
    } catch {
      return undefined;
    } finally {
      clearTimeout(timer);
      proc.dispose();
    }
  }

  /** The repo root for a folder, resolved to BYTE-MATCH vscode.git's
   * `repo.rootUri.fsPath`, so addRepo's reconcile finds the eager binding
   * instead of creating a duplicate. Replicates vscode.git's getRepositoryRoot:
   * `git rev-parse --show-toplevel` resolves symlinks, but vscode preserves the
   * OPENED path — so when a symlink diverges them (cwd is neither the resolved
   * root nor an ancestor/descendant of it) we un-resolve back to the opened path
   * via the relative form (git >= 2.31). */
  private async gitToplevel(cwd: string): Promise<string | undefined> {
    const plain = await this.revParse(cwd, ["rev-parse", "--show-toplevel"]);
    if (!plain) {
      return undefined;
    }
    const physical = vscode.Uri.file(plain).fsPath;
    if (isSamePathOrInside(cwd, physical) || isSamePathOrInside(physical, cwd)) {
      return physical;
    }
    const rel = await this.revParse(cwd, [
      "rev-parse",
      "--path-format=relative",
      "--show-toplevel",
    ]);
    if (rel === undefined) {
      return physical; // older git without --path-format — best effort
    }
    return vscode.Uri.file(path.resolve(cwd, rel)).fsPath;
  }

  private async init(): Promise<void> {
    this.api = await getBuiltInGitApi();

    // Track the active editor moving between repositories.
    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.recomputeActive();
      }),
    );

    if (this.api) {
      for (const repo of this.api.repositories) {
        this.addRepo(repo);
      }
      this.disposables.push(
        this.api.onDidOpenRepository((repo) => this.addRepo(repo)),
        this.api.onDidCloseRepository((repo) => this.removeRepo(repo)),
      );
    }

    this.recomputeActive();
    this.updateHasRepoContext();
    // Repos are now discovered (or confirmed absent) — refresh every subscriber
    // IMMEDIATELY (not via the 400ms debounce) so the views fill the instant git
    // is ready, since registration no longer waits for this.
    this.changeEmitter.fire();
  }

  /** The git binary path. Prefers vscode.git's discovered path; before it has
   * activated we read the same `git.path` setting vscode.git uses, so eager
   * bindings run the user's configured git — not just PATH `git`. */
  private gitPath(): string {
    if (this.api?.git.path) {
      return this.api.git.path;
    }
    const cfg = vscode.workspace
      .getConfiguration("git")
      .get<string | string[] | null>("path");
    if (typeof cfg === "string" && cfg) {
      return cfg;
    }
    if (Array.isArray(cfg) && cfg.length > 0 && cfg[0]) {
      return cfg[0];
    }
    return "git";
  }

  /** Instant-refresh watchers on `.git` op-state + ref files (vscode.git's
   * status scan can lag a branch switch/merge). Works without vscode.git, so
   * eager bindings get them too. (Mirrors merge-studio's op-state-watcher.) */
  private makeGitWatchers(rootUri: vscode.Uri): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    const gitDir = vscode.Uri.joinPath(rootUri, ".git");
    const opStateWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        gitDir,
        "{HEAD,MERGE_HEAD,CHERRY_PICK_HEAD,REVERT_HEAD,rebase-merge,rebase-apply}",
      ),
    );
    const refsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitDir, "refs/**"),
    );
    const poke = () => this.scheduleRefresh();
    for (const watcher of [opStateWatcher, refsWatcher]) {
      watcher.onDidCreate(poke);
      watcher.onDidChange(poke);
      watcher.onDidDelete(poke);
      disposables.push(watcher);
    }
    return disposables;
  }

  /** A git-service-only binding (no vscode.git Repository yet). */
  private addEagerRepo(root: string): void {
    if (this.bindings.has(root)) {
      return;
    }
    const ctx = new GitContext({ root, gitPath: this.gitPath() });
    const entry: RepoEntry = { root, ctx };
    const disposables = this.makeGitWatchers(vscode.Uri.file(root));
    this.bindings.set(root, { entry, disposables });
  }

  private addRepo(repo: Repository): void {
    const root = repo.rootUri.fsPath;
    const existing = this.bindings.get(root);
    if (existing) {
      if (existing.entry.repo) {
        return; // already a full binding
      }
      // Upgrade an eager (git-service-only) binding with vscode.git's Repository
      // for live working-tree state, reusing its ctx + watchers.
      existing.disposables.push(
        repo.state.onDidChange(() => this.scheduleRefresh()),
      );
      this.bindings.set(root, {
        entry: { root, repo, ctx: existing.entry.ctx },
        disposables: existing.disposables,
      });
      this.recomputeActive();
      this.updateHasRepoContext();
      this.scheduleRefresh();
      return;
    }

    // Fresh binding for a repo vscode.git found that we didn't eagerly discover.
    const ctx = new GitContext({ root, gitPath: this.gitPath() });
    const entry: RepoEntry = { root, repo, ctx };
    const disposables = this.makeGitWatchers(repo.rootUri);
    disposables.push(repo.state.onDidChange(() => this.scheduleRefresh()));
    this.bindings.set(root, { entry, disposables });

    this.recomputeActive();
    this.updateHasRepoContext();
    this.scheduleRefresh();
  }

  private removeRepo(repo: Repository): void {
    const root = repo.rootUri.fsPath;
    const binding = this.bindings.get(root);
    if (!binding) {
      return;
    }
    this.bindings.delete(root);
    for (const d of binding.disposables) {
      d.dispose();
    }
    binding.entry.ctx.dispose();

    this.recomputeActive();
    this.updateHasRepoContext();
    this.scheduleRefresh();
  }

  /**
   * Recomputes the active repo from the active editor (the repo whose root is a
   * prefix of the file's path, longest match wins), falling back to the first
   * open repo. Fires a refresh only when the active repo actually changed.
   */
  private recomputeActive(): void {
    const previous = this.activeRoot;
    const next = this.computeActiveRoot();
    this.activeRoot = next;
    if (next !== previous) {
      this.scheduleRefresh();
    }
  }

  private computeActiveRoot(): string | undefined {
    const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (editorPath) {
      let best: string | undefined;
      for (const root of this.bindings.keys()) {
        if (isPathInside(editorPath, root)) {
          if (best === undefined || root.length > best.length) {
            best = root;
          }
        }
      }
      if (best !== undefined) {
        return best;
      }
    }
    // Fall back to the first open repo (insertion order).
    const first = this.bindings.keys().next();
    return first.done ? undefined : first.value;
  }

  /** The active repository, or undefined when no repo is open. */
  getActive(): RepoEntry | undefined {
    if (this.activeRoot === undefined) {
      return undefined;
    }
    return this.bindings.get(this.activeRoot)?.entry;
  }

  /** All open repositories, in insertion order. */
  getAll(): RepoEntry[] {
    return Array.from(this.bindings.values(), (b) => b.entry);
  }

  /**
   * The universal Undo envelope, wired in at activation (M8). Surfaced here so
   * any destructive-op site (the graph context menu, the merge editor) can route
   * through `runWithUndo` without threading the ledger through every call site.
   */
  private undoLedger: UndoLedgerLike | undefined;

  setUndoLedger(ledger: UndoLedgerLike): void {
    this.undoLedger = ledger;
  }

  getUndoLedger(): UndoLedgerLike | undefined {
    return this.undoLedger;
  }

  private updateHasRepoContext(): void {
    void vscode.commands.executeCommand(
      "setContext",
      "gitstudio.hasRepo",
      this.bindings.size > 0,
    );
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.changeEmitter.fire();
    }, REFRESH_DEBOUNCE_MS);
  }

  dispose(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const binding of this.bindings.values()) {
      for (const d of binding.disposables) {
        d.dispose();
      }
      binding.entry.ctx.dispose();
    }
    this.bindings.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.changeEmitter.dispose();
  }
}

/** True when `filePath` sits at or below `dir` (path-boundary aware). Delegates
 * to isSamePathOrInside so it is separator- and case-tolerant: on Windows both
 * arguments are vscode fsPaths using "\", which the old forward-slash-only
 * boundary never matched — so the active repo fell back to the wrong root. */
function isPathInside(filePath: string, dir: string): boolean {
  return isSamePathOrInside(filePath, dir);
}

/** Case-insensitive on macOS/Windows: is `child` the same path as, or inside,
 * `parent`? Used to detect whether git's symlink-resolved root already matches
 * the opened folder (vscode.git-compatible root resolution). */
function isSamePathOrInside(child: string, parent: string): boolean {
  const norm = (p: string): string => {
    const noTrail = p.replace(/[\\/]+$/, "");
    return process.platform === "linux" ? noTrail : noTrail.toLowerCase();
  };
  const c = norm(child);
  const p = norm(parent);
  return c === p || c.startsWith(p + "/") || c.startsWith(p + "\\");
}
