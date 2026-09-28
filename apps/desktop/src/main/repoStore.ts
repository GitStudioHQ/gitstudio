// Owns the open repositories — one tab each, every one with its own cached
// GitContext — plus the recent-repos list (issue #32: repositories as tabs; the
// design is docs/desktop-repo-tabs.md).
//
// Repo discovery goes through NodeGitAdapter — the portable HostGitAdapter the
// git-service ships — exactly as the brief specifies. Nothing here is
// Electron-specific beyond the persistence path, so the data layer stays the
// same one the extension uses.

import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
import { GitContext, NodeGitAdapter } from "@gitstudio/git-service/index";
import type { GitRunEvent, GitRunHook } from "@gitstudio/git-service/index";
import type { RepoInfo, RepoTabsState } from "../shared/ipc";
import { gitAvailability } from "./gitCheck";

const MAX_RECENT = 12;

/**
 * How many repositories may be open as tabs at once.
 *
 * Every open tab is fully live — its GitContext here, its screen, its terminals
 * and its kept-alive views in the renderer — because a tab that quietly drops
 * its state while you are not looking is worse than a limit you can see. A
 * GitContext costs nothing while idle (GitProcess only tracks in-flight
 * children); the renderer's DOM is what the bound is for. An eleventh open is
 * refused with a notice rather than evicting a tab behind the user's back.
 */
export const MAX_TABS = 10;

/**
 * Which repository the IPC call being handled right now is FOR.
 *
 * The renderer stamps every invoke with the tab that made it, and main's
 * `handle` wrapper runs the handler inside this scope, so `getContext()` and
 * `current()` answer for the tab that asked — through every await in the
 * handler, and for work that outlives it (an agent run, a rebase runner).
 * Outside any scope (boot, the menu, a watcher) they answer for the active tab.
 *
 * `{ root: undefined }` is a real answer — "a window with no repository open
 * asked" — and is NOT the same as no scope at all.
 */
export const repoScope = new AsyncLocalStorage<{ root: string | undefined }>();

/** What an open asked for turned into. */
export type OpenOutcome =
  /** A new tab, now the active one. */
  | { kind: "opened"; info: RepoInfo }
  /** The repository already had a tab (any spelling of its path); now active. */
  | { kind: "switched"; info: RepoInfo }
  /** `cwd` is not inside a git repository. */
  | { kind: "notRepo" }
  /** Every tab is taken. */
  | { kind: "full"; max: number }
  /** A newer open() began first and won; nothing here changed. */
  | { kind: "superseded"; info?: RepoInfo };

/** Test seams — the real adapter, realpath and GitContext by default. */
export interface RepoStoreDeps {
  discover?: (cwd: string) => Promise<string | undefined>;
  realpath?: (path: string) => string;
  createContext?: (root: string, onRun: GitRunHook) => GitContext;
  /** Does git itself run? (main/gitCheck.ts by default.) */
  gitReady?: () => Promise<boolean>;
}

/** Resolve symlinks, falling back to a lexical resolve for a path that is gone. */
function realOrResolved(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/**
 * How two repo roots are compared, everywhere.
 *
 * `removeRecent` already established that raw string equality is the wrong
 * rule — the repo manager hands back realpath'd roots, so a recent stored
 * through a symlink would never match and "Forget" would silently do nothing.
 * The same argument applies to ADDING: the recents file is plain JSON that
 * survives upgrades and can be hand-edited, so a stored "/x/repo/" and a
 * freshly discovered "/x/repo" are the same repo listed twice.
 */
export function sameRoot(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

/**
 * The recents list after opening `root`: most recent first, no duplicates
 * (compared by {@link sameRoot}), capped. Pure, so the ordering rules are
 * testable without a git repo on disk.
 *
 * The freshly opened spelling of the path wins, so a list that accumulated an
 * odd variant heals the next time you open that repo.
 */
export function promoteRecentList(
  recent: readonly string[],
  root: string,
  max = MAX_RECENT,
): string[] {
  return [root, ...recent.filter((r) => !sameRoot(r, root))].slice(0, max);
}

interface Tab {
  root: string;
  context: GitContext;
}

export class RepoStore {
  private readonly adapter = new NodeGitAdapter();
  private readonly discover: (cwd: string) => Promise<string | undefined>;
  private readonly realpath: (path: string) => string;
  private readonly createContext: (root: string, onRun: GitRunHook) => GitContext;
  private readonly gitReady: () => Promise<boolean>;
  /** The open tabs, in the order the tab row shows them. */
  private tabs: Tab[] = [];
  private activeRoot: string | undefined;
  /** Monotonic token so an out-of-order `open()` can't clobber a newer one. */
  private openSeq = 0;
  /** The launch restore, while (and after) it runs — see settledState. */
  private restoring?: Promise<unknown>;
  /**
   * The tabs a launch could not restore because GIT would not run — not
   * because their folders are gone. Kept (and saved) as they were, and
   * restored by resumeDeferredRestore once git answers.
   */
  private deferred?: { open: string[]; current?: string };
  /**
   * The roots closed while each open in flight was still finding its
   * repository — one set per open (see openTab). A close is the later word
   * only about the repository it closed.
   */
  private readonly closedDuringOpen = new Set<Set<string>>();
  private recent: string[] = [];
  /** Observer wired by main.ts: fires for every git command any open repo runs,
   *  with the repository it ran in, so each tab's Output log shows its own. */
  onGitRun?: (e: GitRunEvent, root: string) => void;

  /**
   * The options a shared runner needs to look like any other git command here:
   * the same executable, and the same observer feeding the Output tab.
   *
   * `RebaseRunner` spawns git directly rather than through `GitContext`, so
   * without this its invocations were invisible — a `rebase --continue` that
   * failed left no row anywhere in the app.
   */
  runnerOptions(): { gitPath: string; onRun: GitRunHook } {
    const root = this.scopedRoot() ?? "";
    return { gitPath: this.adapter.gitPath(), onRun: (e) => this.onGitRun?.(e, root) };
  }

  /** Listeners fired when the tabs or the active tab change (main re-emits). */
  private readonly listeners = new Set<(state: RepoTabsState) => void>();

  constructor(recent: string[] = [], deps: RepoStoreDeps = {}) {
    this.discover = deps.discover ?? ((cwd) => this.adapter.discoverRepoRoot(cwd));
    this.realpath = deps.realpath ?? realOrResolved;
    this.createContext =
      deps.createContext ??
      ((root, onRun) => new GitContext({ root, gitPath: this.adapter.gitPath(), onRun }));
    this.gitReady = deps.gitReady ?? (async () => (await gitAvailability()).ok);
    // The persisted list is plain JSON that outlives upgrades, so de-duplicate
    // on the way in rather than trusting it. Order is preserved; the first
    // spelling of each root wins.
    const seen: string[] = [];
    for (const r of recent) {
      if (r && !seen.some((k) => sameRoot(k, r))) seen.push(r);
    }
    this.recent = seen.slice(0, MAX_RECENT);
  }

  onChange(fn: (state: RepoTabsState) => void): void {
    this.listeners.add(fn);
  }

  /**
   * The root this call is about: the IPC scope's when inside one (even when
   * that is "no repository"), otherwise the active tab's.
   */
  scopedRoot(): string | undefined {
    const scope = repoScope.getStore();
    return scope ? scope.root : this.activeRoot;
  }

  /**
   * The GitContext for the repository this call is about, or undefined when
   * that tab is not open — closed since the call was made, or none at all. A
   * call for a closed tab NEVER falls back to the active one: acting on
   * whichever repository happens to be in front is the one thing it must not do.
   */
  getContext(): GitContext | undefined {
    const root = this.scopedRoot();
    return root === undefined ? undefined : this.find(root)?.context;
  }

  /** The GitContext of one open tab, whoever is asking. For main's own
   *  bookkeeping (the watcher follows the ACTIVE tab, not the caller's). */
  contextFor(root: string): GitContext | undefined {
    return this.find(root)?.context;
  }

  /** The repository this call is about — see {@link scopedRoot}. */
  current(): RepoInfo | undefined {
    const root = this.scopedRoot();
    const tab = root === undefined ? undefined : this.find(root);
    return tab ? toInfo(tab.root) : undefined;
  }

  /** Is every tab taken? An open of a repository WITHOUT a tab is refused then. */
  isFull(): boolean {
    return this.tabs.length >= MAX_TABS;
  }

  /** The active tab, whoever is asking. */
  active(): RepoInfo | undefined {
    return this.activeRoot ? toInfo(this.activeRoot) : undefined;
  }

  /** Every open tab, in order, and which one is active. */
  state(): RepoTabsState {
    return { tabs: this.tabs.map((t) => toInfo(t.root)), active: this.activeRoot };
  }

  /**
   * {@link state}, once a launch restore under way has finished — what the
   * window's first read of the tabs (`repo:tabs`) answers. main starts the
   * restore and then loads the window, and the renderer asks while it loads:
   * answered before the restore, it heard "no tabs", built the no-repository
   * screen, and then took the restored tabs for new ones when they arrived.
   */
  async settledState(): Promise<RepoTabsState> {
    await this.restoring?.catch(() => undefined);
    return this.state();
  }

  recentRepos(): RepoInfo[] {
    return this.recent.map(toInfo);
  }

  /** Serializable state to persist between sessions. `current` is the active
   *  tab; `open` is every tab, in order. */
  serialize(): { recent: string[]; current?: string; open: string[] } {
    // Tabs held back for want of git are still the session: saved as they
    // were, so a relaunch after installing Git brings them back.
    if (this.deferred && this.tabs.length === 0) {
      return { recent: this.recent, current: this.deferred.current, open: [...this.deferred.open] };
    }
    return { recent: this.recent, current: this.activeRoot, open: this.tabs.map((t) => t.root) };
  }

  /**
   * The tab for `root`, compared by REAL path: a symlinked or oddly spelled
   * path to a repository that already has a tab IS that tab. git's
   * `--show-toplevel` answers with the physical path, but a root can also
   * arrive from the renderer or a persisted file, spelled however it was then.
   */
  private find(root: string): Tab | undefined {
    const exact = this.tabs.find((t) => t.root === root);
    if (exact) return exact;
    const real = this.realpath(root);
    return this.tabs.find((t) => sameRoot(t.root, root) || this.realpath(t.root) === real);
  }

  private addTab(root: string): void {
    this.tabs.push({ root, context: this.createContext(root, (e) => this.onGitRun?.(e, root)) });
  }

  /**
   * Discover the repo root for `cwd` (a folder the user picked or a recent
   * entry) and make it the active tab — a new one, or the one it already has.
   * Returns the RepoInfo, or undefined when it could not be opened.
   */
  async open(cwd: string): Promise<RepoInfo | undefined> {
    const out = await this.openTab(cwd);
    return "info" in out ? out.info : undefined;
  }

  /**
   * Open `cwd` in a tab — or switch to the tab it already has — and make it the
   * active one. See {@link OpenOutcome} for everything it can turn into.
   */
  async openTab(cwd: string): Promise<OpenOutcome> {
    const seq = ++this.openSeq;
    const closed = new Set<string>();
    this.closedDuringOpen.add(closed);
    let root: string | undefined;
    try {
      root = await this.discover(cwd);
    } finally {
      this.closedDuringOpen.delete(closed);
    }
    // A newer open() began while we were discovering the root — let it win, and
    // touch no shared state here (otherwise we'd leave the UI on one repo and the
    // active context on another).
    //
    // What we RETURN matters too. Handing back the root we discovered would tell
    // our caller "you opened A" while the active tab is B, so the window would
    // render A's branches against B's repo. Report whatever is actually active
    // instead; if nothing is yet (the winner is still discovering), fall back to
    // our root so the caller doesn't raise a false "not a Git repository" — the
    // winner's change event corrects the view a moment later.
    if (seq !== this.openSeq) {
      if (!root) return { kind: "notRepo" };
      return { kind: "superseded", info: this.active() ?? toInfo(root) };
    }
    if (!root) return { kind: "notRepo" };
    // Its own tab was closed while it was being found: the close came later,
    // and wins. It opens nothing, and does not claim the tab in front either —
    // no caller may report it as opened.
    if (closed.size) {
      const real = this.realpath(root);
      if ([...closed].some((r) => sameRoot(r, root) || this.realpath(r) === real)) return { kind: "superseded" };
    }
    const existing = this.find(root);
    if (existing) {
      this.promoteRecent(existing.root);
      if (this.activeRoot !== existing.root) {
        this.activeRoot = existing.root;
        this.emit();
      }
      return { kind: "switched", info: toInfo(existing.root) };
    }
    if (this.tabs.length >= MAX_TABS) return { kind: "full", max: MAX_TABS };
    this.addTab(root);
    this.activeRoot = root;
    this.promoteRecent(root);
    this.emit();
    return { kind: "opened", info: toInfo(root) };
  }

  /**
   * Bring back the tabs a previous session had open, in order, with the one
   * that was active. A folder that is gone or no longer a repository is left
   * out and reported, so the caller can say so once rather than per tab.
   * Emits once, at the end.
   */
  restore(open: readonly string[], current?: string): Promise<{ dropped: string[] }> {
    const run = this.restoreTabs(open, current);
    // Held from the moment it starts, so a read that arrives before the first
    // repository is found still waits for all of them (settledState).
    this.restoring = run;
    return run;
  }

  /**
   * Git works now (the window's "Check again"): restore the tabs a launch
   * without it held back. Nothing to do — undefined — when there were none;
   * otherwise the tabs whose folders really are gone, to be said once.
   */
  async resumeDeferredRestore(): Promise<string[] | undefined> {
    const held = this.deferred;
    if (!held) return undefined;
    this.deferred = undefined;
    const { dropped } = await this.restore(held.open, held.current);
    return dropped;
  }

  private async restoreTabs(open: readonly string[], current?: string): Promise<{ dropped: string[] }> {
    const dropped: string[] = [];
    for (const want of open) {
      if (this.tabs.length >= MAX_TABS) break;
      const root = await this.discover(want).catch(() => undefined);
      if (!root) {
        dropped.push(want);
        continue;
      }
      if (this.find(root)) continue;
      this.addTab(root);
    }
    // A folder that would not open because GIT would not run is not gone.
    // Without git every discovery fails, and dropping those tabs threw away —
    // and then saved away — the session the user wants back the moment Git is
    // installed. Asked only when something failed, so a normal launch never
    // waits on it.
    if (dropped.length > 0 && this.tabs.length === 0 && !(await this.gitReady().catch(() => false))) {
      this.deferred = { open: [...open], current };
      this.activeRoot = undefined;
      this.emit();
      return { dropped: [] };
    }
    // The active tab is found by the same rule as any other (real path), so a
    // `current` persisted under another spelling still wins its seat.
    let wanted: Tab | undefined;
    if (current) {
      const real = this.realpath(current);
      wanted = this.tabs.find((t) => sameRoot(t.root, current) || this.realpath(t.root) === real);
    }
    this.activeRoot = wanted?.root ?? this.tabs[0]?.root;
    this.emit();
    return { dropped };
  }

  /** Make an open tab the active one. False when `root` has no tab. */
  activate(root: string): boolean {
    const tab = this.find(root);
    if (!tab) return false;
    if (this.activeRoot !== tab.root) {
      this.activeRoot = tab.root;
      this.emit();
    }
    return true;
  }

  /**
   * Close a tab. When it was the active one, the tab to its right takes over,
   * else the one to its left — a browser's rule, and VS Code's.
   *
   * Its GitContext is DROPPED, not disposed: `dispose()` SIGTERMs every git
   * child still running, and a push or a `rebase --continue` killed halfway is
   * a far worse outcome than one that finishes with nobody watching.
   */
  closeTab(root: string): boolean {
    const tab = this.find(root);
    if (!tab) return false;
    // An open still finding its repository is superseded only if it turns out
    // to be for THIS one (openTab checks). Closing any tab used to supersede
    // every open in flight — a leftover of "closing means the one repository
    // goes away" — so closing an unrelated background tab silently cancelled
    // an open, and its caller then reported the tab in front as opened.
    for (const closed of this.closedDuringOpen) closed.add(tab.root);
    const i = this.tabs.indexOf(tab);
    this.tabs.splice(i, 1);
    if (this.activeRoot === tab.root) {
      this.activeRoot = (this.tabs[i] ?? this.tabs[i - 1])?.root;
    }
    this.emit();
    return true;
  }

  /** Move a tab to `index` in the row (clamped). False when nothing moved. */
  moveTab(root: string, index: number): boolean {
    const tab = this.find(root);
    if (!tab) return false;
    const from = this.tabs.indexOf(tab);
    const to = Math.max(0, Math.min(this.tabs.length - 1, Math.floor(index)));
    if (from === to) return false;
    this.tabs.splice(from, 1);
    this.tabs.splice(to, 0, tab);
    this.emit();
    return true;
  }

  /** Close the tab this call is about (the active one outside an IPC scope). */
  close(): void {
    const root = this.scopedRoot();
    if (root === undefined) {
      this.openSeq++; // still supersede an open in flight, as before
      return;
    }
    this.closeTab(root);
  }

  dispose(): void {
    for (const t of this.tabs) t.context.dispose();
    this.tabs = [];
    this.activeRoot = undefined;
    this.listeners.clear();
  }

  /** Forget a root (Settings → Repositories). Returns true when it was there —
   *  main.ts persists only on a real change. Never touches disk or the open
   *  repo: forgetting a repo you're standing in is a list edit, nothing more. */
  removeRecent(root: string): boolean {
    const before = this.recent.length;
    // Compare RESOLVED paths: the manager hands back realpath'd roots, and a
    // recent stored through a symlink would otherwise never match — the click
    // would report success and change nothing.
    this.recent = this.recent.filter((r) => !sameRoot(r, root));
    return this.recent.length !== before;
  }

  /**
   * Put a root back in the recent list — the undo of `removeRecent`.
   *
   * It goes to the FRONT rather than to wherever it was: a list that reorders
   * itself constantly has no position to restore, and the thing you just
   * un-forgot is the thing you are most likely to want. Returns false when it
   * is already there, so the caller can skip persisting.
   */
  restoreRecent(root: string): boolean {
    if (this.recent.some((r) => sameRoot(r, root))) return false;
    this.promoteRecent(root);
    return true;
  }

  private promoteRecent(root: string): void {
    this.recent = promoteRecentList(this.recent, root);
  }

  private emit(): void {
    const state = this.state();
    for (const fn of this.listeners) {
      fn(state);
    }
  }
}

function toInfo(root: string): RepoInfo {
  return { root, name: basename(root) || root };
}
