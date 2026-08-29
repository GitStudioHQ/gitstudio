// Owns the open repository (a cached GitContext) plus the recent-repos list.
// Repo discovery goes through NodeGitAdapter — the portable HostGitAdapter the
// git-service ships — exactly as the brief specifies. Nothing here is
// Electron-specific beyond the persistence path, so the data layer stays the
// same one the extension uses.

import { basename, resolve } from "node:path";
import { GitContext, NodeGitAdapter } from "@gitstudio/git-service/index";
import type { GitRunHook } from "@gitstudio/git-service/index";
import type { RepoInfo } from "../shared/ipc";

const MAX_RECENT = 12;

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

export class RepoStore {
  private readonly adapter = new NodeGitAdapter();
  private context: GitContext | undefined;
  private currentRoot: string | undefined;
  /** Monotonic token so an out-of-order `open()` can't clobber a newer one. */
  private openSeq = 0;
  private recent: string[] = [];
  /** Observer wired by main.ts: fires for every git command the open repo runs,
   *  so the renderer's Output tab can show a live git-command log. */
  onGitRun?: GitRunHook;

  /**
   * The options a shared runner needs to look like any other git command here:
   * the same executable, and the same observer feeding the Output tab.
   *
   * `RebaseRunner` spawns git directly rather than through `GitContext`, so
   * without this its invocations were invisible — a `rebase --continue` that
   * failed left no row anywhere in the app.
   */
  runnerOptions(): { gitPath: string; onRun: GitRunHook } {
    return { gitPath: this.adapter.gitPath(), onRun: (e) => this.onGitRun?.(e) };
  }

  /** Listeners fired when the active repo changes (the main process re-emits). */
  private readonly listeners = new Set<(info: RepoInfo | undefined) => void>();

  constructor(recent: string[] = []) {
    // The persisted list is plain JSON that outlives upgrades, so de-duplicate
    // on the way in rather than trusting it. Order is preserved; the first
    // spelling of each root wins.
    const seen: string[] = [];
    for (const r of recent) {
      if (r && !seen.some((k) => sameRoot(k, r))) seen.push(r);
    }
    this.recent = seen.slice(0, MAX_RECENT);
  }

  onChange(fn: (info: RepoInfo | undefined) => void): void {
    this.listeners.add(fn);
  }

  /** The cached GitContext for the open repo, or undefined when none is open. */
  getContext(): GitContext | undefined {
    return this.context;
  }

  current(): RepoInfo | undefined {
    return this.currentRoot ? toInfo(this.currentRoot) : undefined;
  }

  recentRepos(): RepoInfo[] {
    return this.recent.map(toInfo);
  }

  /** Serializable state to persist between sessions. */
  serialize(): { recent: string[]; current?: string } {
    return { recent: this.recent, current: this.currentRoot };
  }

  /**
   * Discover the repo root for `cwd` (a folder the user picked or a recent
   * entry), create + cache its GitContext, and make it the active repo. Returns
   * the opened RepoInfo, or undefined when `cwd` is not inside a git repo.
   */
  async open(cwd: string): Promise<RepoInfo | undefined> {
    const seq = ++this.openSeq;
    const root = await this.adapter.discoverRepoRoot(cwd);
    // A newer open() began while we were discovering the root — let it win, and
    // touch no shared state here (otherwise we'd leave the UI on one repo and the
    // active context on another).
    //
    // What we RETURN matters too. Handing back the root we discovered would tell
    // our caller "you opened A" while the active context is B, so the window
    // would render A's branches against B's repo. Report whatever is actually
    // open instead; if nothing is yet (the winner is still discovering), fall
    // back to our root so the caller doesn't raise a false "not a Git
    // repository" — the winner's change event corrects the view a moment later.
    if (seq !== this.openSeq) {
      if (!root) return undefined;
      return this.current() ?? toInfo(root);
    }
    if (!root) {
      return undefined;
    }
    if (root === this.currentRoot && this.context) {
      this.promoteRecent(root);
      return toInfo(root);
    }
    this.context?.dispose();
    this.context = new GitContext({
      root,
      gitPath: this.adapter.gitPath(),
      onRun: (e) => this.onGitRun?.(e),
    });
    this.currentRoot = root;
    this.promoteRecent(root);
    const info = toInfo(root);
    this.emit(info);
    return info;
  }

  close(): void {
    this.openSeq++; // supersede any in-flight open() so it can't re-open after close
    if (!this.context && !this.currentRoot) {
      return;
    }
    this.context?.dispose();
    this.context = undefined;
    this.currentRoot = undefined;
    this.emit(undefined);
  }

  dispose(): void {
    this.context?.dispose();
    this.context = undefined;
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

  private promoteRecent(root: string): void {
    this.recent = promoteRecentList(this.recent, root);
  }

  private emit(info: RepoInfo | undefined): void {
    for (const fn of this.listeners) {
      fn(info);
    }
  }
}

function toInfo(root: string): RepoInfo {
  return { root, name: basename(root) || root };
}
