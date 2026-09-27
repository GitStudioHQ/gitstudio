import { sameFolder } from "@gitstudio/git-service/WorktreeProvider";
import type { RepoEntry, RepoManager } from "./repoManager";

// A worktree of the active repository that this window may not have open —
// Pull in its own folder, the push review for it, a diff of its index —
// needs git run THERE: its HEAD, index and operation are its own. When the
// window has that folder open as a repository, that entry is it; otherwise a
// context is made for it, like the active one (same git, same run hook).

export interface WorktreeEntry {
  entry: RepoEntry;
  /** The window has this folder open as one of its repositories. */
  open: boolean;
  /** Dispose a context made for it (a no-op for an open one). */
  release(): void;
}

export function worktreeEntry(
  repos: Pick<RepoManager, "getActive"> & Partial<Pick<RepoManager, "getAll">>,
  path: string,
): WorktreeEntry | undefined {
  const all = repos.getAll?.() ?? [];
  const active = repos.getActive();
  const open = [...all, ...(active ? [active] : [])].find((e) => sameFolder(e.root, path));
  if (open) {
    return { entry: open, open: true, release: () => {} };
  }
  if (!active) {
    return undefined;
  }
  const ctx = active.ctx.at(path);
  return { entry: { root: path, ctx }, open: false, release: () => ctx.dispose() };
}
