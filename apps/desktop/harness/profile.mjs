// A throwaway Chrome profile for one headless launch.
//
// Without --user-data-dir, headless Chrome makes its own `.com.google.Chrome.*`
// profile in the temp directory and does not always remove it — never when the
// launch is killed on a timeout. One full check.mjs run is ~1,000 launches, so
// a night of harness runs left 40,000 of them behind (7.7 GB) and filled the
// disk. Every launcher here names its own profile and removes it when Chrome
// has answered.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** `flag` goes on Chrome's argv; call `cleanup()` once Chrome has exited. */
export function chromeProfile(prefix = "gs-chrome-") {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    flag: `--user-data-dir=${dir}`,
    cleanup: () => rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }),
  };
}
