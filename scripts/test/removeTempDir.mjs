// Remove a test's temporary directory without ever failing the test.
//
// On Windows a browser's helper processes keep files in its profile open for a
// moment after the browser itself has exited, so an immediate rmSync throws
// EBUSY — and thrown from a child-process callback it failed whichever test
// happened to be running (three "flaky" Windows failures in one release run).
// Cleanup is housekeeping, not a check: retry for a while, then try once more
// later in the background, and never throw.
import { rm, rmSync } from "node:fs";

export function removeTempDir(dir) {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch {
    const later = setTimeout(() => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }, () => {}), 2000);
    later.unref?.();
  }
}
