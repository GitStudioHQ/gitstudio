import { rmSync } from "node:fs";

/**
 * Remove a throwaway test repository, tolerating the one failure that is never
 * the test's fault.
 *
 * git children can still hold descriptors inside `.git` for a moment after the
 * call that spawned them resolved, and rmSync then throws ENOTEMPTY. That
 * failed the test that happened to be last — "many concurrent loads leave the
 * accumulator self-consistent" — with a cleanup error rather than an assertion,
 * about once in ten runs. A temp directory under the OS temp dir that survives
 * a few seconds longer costs nothing; the OS reclaims it.
 */
export function removeTempRepo(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Deliberately swallowed: failing to delete scratch space is not a result.
  }
}
