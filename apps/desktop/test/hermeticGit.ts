// Pin every git this test process runs — the fixtures' own execFileSync calls
// AND the GitBridge's GitProcess, which inherits this environment — to an
// empty, isolated config.
//
// The same discipline as packages/git-service/test/hermetic.ts, which the
// engine suite loads with `--import`. The desktop suite has no such preload,
// so a test that shells out to real git and whose outcome depends on config
// imports this FIRST:
//
//     import "./hermeticGit";
//
// Why it matters here: `SyncOps.pull` deliberately honours the user's own
// `pull.rebase` / `pull.ff` — if they have answered git's question, we do not
// ask it again. That is right for users and wrong for a test: on a machine
// with `pull.rebase=true` in ~/.gitconfig, a diverged pull rebased instead of
// asking, and three of pullDiverged.test.ts's eight cases failed for a reason
// that had nothing to do with the code under test.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cfg = join(mkdtempSync(join(tmpdir(), "gitstudio-desktop-test-cfg-")), "config");
writeFileSync(cfg, "");

process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_OPTIONAL_LOCKS = "0";
delete process.env.GIT_TRACE2;
delete process.env.GIT_TRACE2_EVENT;
delete process.env.GIT_TRACE2_PERF;

/** The pinned (empty) global config file, for a test that wants to prove it. */
export const HERMETIC_GIT_CONFIG = cfg;
