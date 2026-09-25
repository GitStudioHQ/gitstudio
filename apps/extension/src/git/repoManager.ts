import * as vscode from "vscode";
import * as path from "node:path";
import { GitContext, GitProcess } from "@gitstudio/git-service/index";
import { gitWatchTargets } from "@gitstudio/merge-vscode/gitWatch";
import type { API, Repository } from "./git";
import { getBuiltInGitApi } from "./builtInGit";
import { isSamePathOrInside } from "../util/repoScope";

// Coalesce bursts of git activity (a rebase touches many ref files in quick
// succession) into a single refresh, while still feeling instant on a branch
// switch or commit.
const REFRESH_DEBOUNCE_MS = 400;

/** workspaceState key for the repository the user picked (issue #32). */
export const PICKED_REPO_KEY = "gitstudio.pickedRepository";

/** The one workspaceState surface RepoManager needs (a vscode.Memento). */
export interface PickMemento {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

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
 * Owns the set of open repositories and the notion of the "active" one.
 * Surfaces a single debounced `onDidChange` that the tree views subscribe to,
 * firing on repo open/close, active-editor moves across repos, vscode.git state
 * changes, and direct `.git` ref/op-state mutations (for instant refresh).
 *
 * WHICH REPOSITORY IS ACTIVE (issue #32). Everything that shows "the" repo —
 * the Changes view, the commit graph, worktrees, the sync status — reads
 * getActive(), and the rule is:
 *
 *   · an explicit pick (setActive, from Switch Repository…) holds until you
 *     pick again, or until that repository closes. Opening a file that lives
 *     in another repository does NOT move it — the JetBrains / VS Code SCM
 *     behaviour: a choice you made is not undone by where you click next.
 *   · with no pick, the active repo follows the editor, as it always has: the
 *     repo containing the active editor's file (longest root wins, so a repo
 *     nested inside another's folder owns its own files), else the first.
 *
 * The pick is remembered per workspace (workspaceState), so a reload keeps it.
 * A remembered pick whose repository is not found once discovery settles —
 * deleted from disk, or removed from the workspace — is forgotten, and the
 * view follows the editor again.
 *
 * Per-FILE features (blame, the staging gutter, the timeline, line staging,
 * merge) resolve a file to the repository that OWNS it — the longest root, as
 * findByPath does — never to the active one, so a pick cannot point them at
 * the wrong repository.
 */
export class RepoManager implements vscode.Disposable {
  private api: API | undefined;
  private readonly bindings = new Map<string, RepoBinding>();
  private activeRoot: string | undefined;
  /**
   * The repository the user picked, if any. May name a root that is not (yet)
   * open: a pick restored from workspaceState waits for discovery to find its
   * repo, and until then the editor rule applies (see settlePick).
   */
  private pickedRoot: string | undefined;
  /** Where the pick is remembered across reloads (the workspace's Memento). */
  private readonly pickStore: PickMemento | undefined;
  /** Resolves when eager discovery has finished (one rev-parse per folder). */
  private eagerDone: Promise<void> = Promise.resolve();
  private disposed = false;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires (debounced) whenever the active repo's data may have changed. */
  readonly onDidChange = this.changeEmitter.event;

  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  private constructor(pickStore?: PickMemento) {
    this.pickStore = pickStore;
    const remembered = pickStore?.get<string>(PICKED_REPO_KEY);
    if (typeof remembered === "string" && remembered) {
      this.pickedRoot = remembered; // judged once discovery settles (settlePick)
    }
  }

  /**
   * Constructs a RepoManager and kicks git-API activation in the BACKGROUND —
   * it does NOT await it. The caller can register every view/provider
   * immediately (they all tolerate "no repo yet"); init() fires onDidChange once
   * repos are discovered so the views fill in. Awaiting git activation here
   * gated every GitStudio view behind vscode.git (0.5–2s on a cold start) — the
   * #1 cause of "the view takes seconds to appear on first open".
   *
   * `pickStore` is the workspace's Memento (context.workspaceState): where the
   * repository picked with Switch Repository… is remembered across reloads.
   */
  static async create(pickStore?: PickMemento): Promise<RepoManager> {
    const manager = new RepoManager(pickStore);
    // Discover repos from the workspace folders via OUR OWN git (one fast
    // `git rev-parse` each) so views get a root + git-service ctx INSTANTLY,
    // without waiting for vscode.git to activate + scan (the gate that made
    // every view take ~a second on first open).
    manager.eagerDone = manager.eagerDiscover().catch(() => undefined);
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

    const api = this.api;
    if (api) {
      for (const repo of api.repositories) {
        this.addRepo(repo);
      }
      this.disposables.push(
        api.onDidOpenRepository((repo) => this.addRepo(repo)),
        api.onDidCloseRepository((repo) => this.removeRepo(repo)),
      );
    }

    this.recomputeActive();
    this.updateHasRepoContext();
    // Repos are now discovered (or confirmed absent) — refresh every subscriber
    // IMMEDIATELY (not via the 400ms debounce) so the views fill the instant git
    // is ready, since registration no longer waits for this.
    this.changeEmitter.fire();

    // A remembered pick is judged once discovery has SETTLED: vscode.git scans
    // the workspace for repositories after its API is handed out, so a repo
    // missing from the first list may simply not be found yet.
    if (!api || api.state === "initialized") {
      await this.eagerDone;
      this.settlePick();
    } else {
      const settled = api.onDidChangeState((state) => {
        if (state === "initialized") {
          settled.dispose();
          void this.eagerDone.then(() => this.settlePick());
        }
      });
      this.disposables.push(settled);
    }
  }

  /**
   * Discovery has finished: a remembered pick whose repository was not found is
   * forgotten (the folder was removed from the workspace, or is no longer a
   * repository). The active repo already follows the editor while the pick
   * waits, so nothing on screen changes.
   */
  private settlePick(): void {
    // A window closing mid-discovery has no repositories left to judge by, and
    // must not wipe the pick the next window is about to restore.
    if (this.disposed) {
      return;
    }
    if (this.pickedRoot !== undefined && !this.bindings.has(this.pickedRoot)) {
      this.forgetPick();
    }
  }

  private forgetPick(): void {
    this.pickedRoot = undefined;
    void this.pickStore?.update(PICKED_REPO_KEY, undefined);
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

  /** Instant-refresh watchers on git's op-state + ref files (vscode.git's
   * status scan can lag a branch switch/merge). Works without vscode.git, so
   * eager bindings get them too.
   *
   * WHERE is asked of git (`rev-parse --git-path`, via gitWatchTargets), never
   * assumed to be `<root>/.git`: in a linked worktree that path is a FILE, so
   * the old watchers never fired there — a conflict in a worktree surfaced only
   * when vscode.git's own poll caught up. The watchers attach once git has
   * answered (the returned array is the binding's, filled in place). */
  private makeGitWatchers(ctx: GitContext): vscode.Disposable[] {
    const disposables: vscode.Disposable[] = [];
    void this.watchGitDirs(ctx, disposables);
    return disposables;
  }

  private async watchGitDirs(ctx: GitContext, into: vscode.Disposable[]): Promise<void> {
    let targets;
    try {
      targets = await gitWatchTargets(ctx.operation);
    } catch {
      return; // not a repository any more; vscode.git's events still arrive
    }
    // The repository may have closed while git answered.
    if (![...this.bindings.values()].some((b) => b.disposables === into)) {
      return;
    }
    const poke = () => this.scheduleRefresh();
    for (const [dir, glob] of [
      [targets.gitDir, targets.opStateGlob],
      [targets.commonDir, targets.refsGlob],
    ] as const) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), glob),
      );
      watcher.onDidCreate(poke);
      watcher.onDidChange(poke);
      watcher.onDidDelete(poke);
      into.push(watcher);
    }
  }

  /** A git-service-only binding (no vscode.git Repository yet). */
  private addEagerRepo(root: string): void {
    if (this.bindings.has(root)) {
      return;
    }
    const ctx = new GitContext({ root, gitPath: this.gitPath() });
    const entry: RepoEntry = { root, ctx };
    const disposables = this.makeGitWatchers(ctx);
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
    const disposables = this.makeGitWatchers(ctx);
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
    // The picked repository closed: the pick ends with it, and the active repo
    // follows the editor again. Kept, it would silently re-take the view if
    // the repository ever reopened — long after anyone remembers picking it.
    if (this.pickedRoot === root) {
      this.forgetPick();
    }

    this.recomputeActive();
    this.updateHasRepoContext();
    this.scheduleRefresh();
  }

  /**
   * Recomputes the active repo (see the class comment for the rule). Fires a
   * refresh only when the active repo actually changed.
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
    // An explicit pick wins while its repository is open.
    if (this.pickedRoot !== undefined && this.bindings.has(this.pickedRoot)) {
      return this.pickedRoot;
    }
    const editorPath = vscode.window.activeTextEditor?.document.uri.fsPath;
    if (editorPath) {
      const owner = this.findRootFor(editorPath);
      if (owner !== undefined) {
        return owner;
      }
    }
    // Fall back to the first open repo (insertion order).
    const first = this.bindings.keys().next();
    return first.done ? undefined : first.value;
  }

  /** The open repo root containing `fsPath` — the longest one, so a repo nested
   * inside another's folder owns its own files. */
  private findRootFor(fsPath: string): string | undefined {
    let best: string | undefined;
    for (const root of this.bindings.keys()) {
      if (isPathInside(fsPath, root)) {
        if (best === undefined || root.length > best.length) {
          best = root;
        }
      }
    }
    return best;
  }

  /**
   * The open repository a FILE belongs to (longest root wins), regardless of
   * which repository is active. Per-file features must use this, not
   * getActive(): with a picked repository the active one is not necessarily the
   * file's — and for a repo nested in the picked one's folder, the picked root
   * even CONTAINS the file while not owning it.
   */
  findByPath(fsPath: string): RepoEntry | undefined {
    const root = this.findRootFor(fsPath);
    return root === undefined ? undefined : this.bindings.get(root)?.entry;
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
   * Make `root` the active repository until the user picks again or it closes
   * (Switch Repository…). `undefined` drops the pick, so the active repo
   * follows the editor again. Returns false — and changes nothing — when
   * `root` is not an open repository (it closed while the picker was up).
   *
   * Refreshes every subscriber at once rather than after the 400ms debounce:
   * this is a click, and the views should answer it like one.
   */
  setActive(root: string | undefined): boolean {
    if (root !== undefined && !this.bindings.has(root)) {
      return false;
    }
    this.pickedRoot = root;
    void this.pickStore?.update(PICKED_REPO_KEY, root);
    const previous = this.activeRoot;
    this.activeRoot = this.computeActiveRoot();
    if (this.activeRoot !== previous) {
      if (this.refreshTimer !== undefined) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
      }
      this.changeEmitter.fire();
    }
    return true;
  }

  /** The root the user picked, while that repository is open; undefined when
   * the active repo is following the editor. */
  getPicked(): string | undefined {
    return this.pickedRoot !== undefined && this.bindings.has(this.pickedRoot)
      ? this.pickedRoot
      : undefined;
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
    // Gates Switch Repository… in the Command Palette: with one repository
    // there is nothing to switch to.
    void vscode.commands.executeCommand(
      "setContext",
      "gitstudio.multiRepo",
      this.bindings.size > 1,
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
    this.disposed = true;
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
 * boundary never matched — so the active repo fell back to the wrong root.
 *
 * The implementation lives in util/repoScope.ts, where it is unit-tested. It
 * used to be a private copy here; the Changes view then needed the same
 * comparison and grew a second one that was case-SENSITIVE — the very bug this
 * comment records, reintroduced a few files away. One copy now. */
function isPathInside(filePath: string, dir: string): boolean {
  return isSamePathOrInside(filePath, dir);
}
