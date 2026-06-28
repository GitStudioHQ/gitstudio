// Owns the open repository (a cached GitContext) plus the recent-repos list.
// Repo discovery goes through NodeGitAdapter — the portable HostGitAdapter the
// git-service ships — exactly as the brief specifies. Nothing here is
// Electron-specific beyond the persistence path, so the data layer stays the
// same one the extension uses.

import { basename } from "node:path";
import { GitContext, NodeGitAdapter } from "@gitstudio/git-service/index";
import type { GitRunHook } from "@gitstudio/git-service/index";
import type { RepoInfo } from "../shared/ipc";

const MAX_RECENT = 12;

export class RepoStore {
  private readonly adapter = new NodeGitAdapter();
  private context: GitContext | undefined;
  private currentRoot: string | undefined;
  private recent: string[] = [];
  /** Observer wired by main.ts: fires for every git command the open repo runs,
   *  so the renderer's Output tab can show a live git-command log. */
  onGitRun?: GitRunHook;

  /** Listeners fired when the active repo changes (the main process re-emits). */
  private readonly listeners = new Set<(info: RepoInfo | undefined) => void>();

  constructor(recent: string[] = []) {
    this.recent = recent.slice(0, MAX_RECENT);
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
    const root = await this.adapter.discoverRepoRoot(cwd);
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

  private promoteRecent(root: string): void {
    this.recent = [root, ...this.recent.filter((r) => r !== root)].slice(
      0,
      MAX_RECENT,
    );
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
