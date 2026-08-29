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
 *
 * git is not the only writer. On this machine something outside this repo drops
 * `.git/ai/working_logs/` into every repository shortly after it is created, so
 * a `.git` that was empty when the test finished is not empty a beat later.
 * That is why the tests also set `gc.auto 0` and why this swallows rather than
 * merely retries: any test creating a repo must reach for THIS, not its own
 * `rmSync`, or the suite goes red about one run in three in a different test
 * each time — which teaches you to ignore it.
 */
export function removeTempRepo(dir: string | undefined): void {
  if (!dir) return;
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    // Deliberately swallowed: failing to delete scratch space is not a result.
  }
}
