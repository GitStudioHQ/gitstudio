import * as vscode from "vscode";
import { GitContext } from "@gitstudio/git-service/index";
import type { API, Repository } from "./git";
import { getBuiltInGitApi } from "./builtInGit";

// Coalesce bursts of git activity (a rebase touches many ref files in quick
// succession) into a single refresh, while still feeling instant on a branch
// switch or commit.
const REFRESH_DEBOUNCE_MS = 400;

/** A live repository: its root, the vscode.git handle, and our data context. */
export interface RepoEntry {
  /** Absolute repo root (fsPath of `repo.rootUri`). */
  readonly root: string;
  readonly repo: Repository;
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

  /** Constructs and wires a RepoManager. Async because git API activation is. */
  static async create(): Promise<RepoManager> {
    const manager = new RepoManager();
    await manager.init();
    return manager;
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
  }

  /** The git binary path discovered by vscode.git, or "git" as a fallback. */
  private gitPath(): string {
    return this.api?.git.path ?? "git";
  }

  private addRepo(repo: Repository): void {
    const root = repo.rootUri.fsPath;
    if (this.bindings.has(root)) {
      return;
    }

    const ctx = new GitContext({ root, gitPath: this.gitPath() });
    const entry: RepoEntry = { root, repo, ctx };
    const disposables: vscode.Disposable[] = [];

    // vscode.git's own state changes (commit, checkout, stage, ...).
    disposables.push(repo.state.onDidChange(() => this.scheduleRefresh()));

    // Instant refresh: watch the `.git` op-state + ref files directly, since
    // vscode.git's status scan can lag a branch switch or merge by a beat.
    // (Mirrors merge-studio's op-state-watcher trick.)
    const gitDir = vscode.Uri.joinPath(repo.rootUri, ".git");
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

/** True when `filePath` sits at or below `dir` (path-boundary aware). */
function isPathInside(filePath: string, dir: string): boolean {
  if (filePath === dir) {
    return true;
  }
  const withSep = dir.endsWith("/") ? dir : `${dir}/`;
  return filePath.startsWith(withSep);
}
