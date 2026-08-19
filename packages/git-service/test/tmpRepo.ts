import { rmSync } from "node:fs";

/**
 * Remove a throwaway test repository, tolerating the one failure that is never
 * the test's fault.
 *
 * git children can hold descriptors inside `.git` for a moment after the call
 * that spawned them resolved, and rmSync then throws ENOTEMPTY — failing
 * whichever test happened to run last, with a cleanup error rather than an
 * assertion. A scratch directory that survives a few seconds longer costs
 * nothing; the OS reclaims it.
 */
export function removeTempRepo(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Deliberately swallowed: failing to delete scratch space is not a result.
  }
}
