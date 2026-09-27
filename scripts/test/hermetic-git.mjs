// Hermetic git for every test process in this repository.
//
// Every workspace's `test` script loads this before any test file:
//
//     tsx --import ../../scripts/test/hermetic-git.mjs --test "test/**/*.test.ts"
//
// and node's test runner hands the flag on to the process it starts for each
// file, so every git a test runs — the fixtures' own execFileSync calls, and
// the GitContext / GitProcess / RebaseRunner under test, which inherit this
// environment — sees what is set here:
//
//   · no network and no credential helper, ever (no-network-git.mjs) — for
//     the test process itself too: fetch, http(s), net and tls reach this
//     machine and nothing else (no-network-node.mjs);
//   · no config but the repository's own. Against the developer's global or
//     system config a test inherits hooks, LFS filters, an editor,
//     pull.rebase, autocrlf and trace2 listeners, and then describes the
//     machine instead of the code (a trace2 daemon still writing into .git
//     raced rmSync).
//
// packages/git-service/test/noNetworkGit.test.ts is the census that keeps
// every test file under it.

import "./no-network-git.mjs";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// One folder per PROCESS, never shared: node runs test files in parallel, and
// a test that writes the global config (reportingVerdicts.test.ts) must not
// change what the file running beside it reads.
const dir = mkdtempSync(join(tmpdir(), "gitstudio-test-git-"));
process.on("exit", () => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* a temp folder left behind is not a failure */
  }
});

/** The empty config file that stands in for the global and system ones. */
export const HERMETIC_GIT_CONFIG = join(dir, "config");
writeFileSync(HERMETIC_GIT_CONFIG, "");

Object.assign(process.env, {
  GIT_CONFIG_GLOBAL: HERMETIC_GIT_CONFIG,
  GIT_CONFIG_SYSTEM: HERMETIC_GIT_CONFIG,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_OPTIONAL_LOCKS: "0",
});
for (const key of [
  // A hook's repository: every fixture would act on it instead of its own.
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
  // trace2 listeners write into .git after the command exits.
  "GIT_TRACE2",
  "GIT_TRACE2_EVENT",
  "GIT_TRACE2_PERF",
]) {
  delete process.env[key];
}
