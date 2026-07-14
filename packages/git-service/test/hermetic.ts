// Hermetic git environment for the test suite.
//
// These tests spin up throwaway repos in the OS tmpdir and tear them down with
// rmSync. If git runs against the developer's *global*/system config it inherits
// whatever tooling they have wired in — LFS filters, commit hooks, and (the
// culprit behind a real intermittent ENOTEMPTY teardown flake) a `trace2`
// listener daemon that asynchronously writes notes/repacks the repo *after* the
// foreground git command exits. That out-of-band writer races rmSync and the
// directory is "not empty" when we try to remove it.
//
// Pin every git invocation in this process to an empty, isolated config so the
// suite behaves identically on every machine and in CI. Loaded via
// `node --import` (see package.json `test` script) so it runs before any test
// file imports GitContext or shells out to git.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = join(mkdtempSync(join(tmpdir(), "gitstudio-test-cfg-")), "config");
writeFileSync(cfg, "");

process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
// Belt-and-suspenders: drop any inherited trace2 wiring directly from the env.
delete process.env.GIT_TRACE2;
delete process.env.GIT_TRACE2_EVENT;
delete process.env.GIT_TRACE2_PERF;
