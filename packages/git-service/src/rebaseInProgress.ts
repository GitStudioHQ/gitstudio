import { existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/** All this needs: run git in a repository, and know which directory that is. */
export interface RebaseStateRunner {
  readonly cwd: string;
  run(args: string[], opts?: { signal?: AbortSignal }): Promise<{ code: number; stdout: string }>;
}

/**
 * Is a rebase in progress — paused on a conflict, an `edit`, or a `break`?
 *
 * Answered by git's state directory (`rebase-merge`, or `rebase-apply` without
 * the `applying` marker that makes it a `git am`), which git creates when a
 * rebase starts and deletes when it ends, however it ends. The same rule
 * RebaseRunner's `rebaseStateDir` uses.
 *
 * NOT by REBASE_HEAD. git leaves that ref behind when a stopped rebase
 * FINISHES — after `--continue`, `--skip` to the end, and `--quit` (checked
 * against git 2.49) — so every repository that has ever finished a stopped
 * rebase carries one. Read as "in progress", it announced a merge that stopped
 * as "continue the rebase", blamed later failures on a rebase long over, and
 * read "cannot rebase: You have unstaged changes" (exit 1, nothing paused) as
 * the rebase stopping for the user.
 */
export async function rebaseInProgress(proc: RebaseStateRunner, signal?: AbortSignal): Promise<boolean> {
  for (const dir of ["rebase-merge", "rebase-apply"]) {
    const r = await proc.run(["rev-parse", "--git-path", dir], { signal });
    if (r.code !== 0) {
      continue;
    }
    // resolve(), not join(): inside a linked worktree git answers with an
    // ABSOLUTE path, and a relative one is relative to the repository root.
    const at = resolve(proc.cwd, r.stdout.trim());
    try {
      if (!statSync(at).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    if (dir === "rebase-apply" && existsSync(join(at, "applying"))) {
      continue; // a `git am`, not a rebase
    }
    return true;
  }
  return false;
}
