// Pin every git this test process runs — the fixtures' own execFileSync calls
// AND the GitBridge's GitProcess, which inherits this environment — to an
// empty, isolated config, with no network and no credential helper.
//
// The desktop suite's `test` script loads scripts/test/hermetic-git.mjs before
// every file, as every workspace's does. A test whose outcome depends on git's
// config still imports this FIRST, so it is hermetic however it is run:
//
//     import "./hermeticGit";
//
// Why it matters here: `SyncOps.pull` deliberately honours the user's own
// `pull.rebase` / `pull.ff` — if they have answered git's question, we do not
// ask it again. That is right for users and wrong for a test: on a machine
// with `pull.rebase=true` in ~/.gitconfig, a diverged pull rebased instead of
// asking, and three of pullDiverged.test.ts's eight cases failed for a reason
// that had nothing to do with the code under test.
import { HERMETIC_GIT_CONFIG as CONFIG } from "../../../scripts/test/hermetic-git.mjs";

/** The pinned (empty) global config file, for a test that wants to prove it. */
export const HERMETIC_GIT_CONFIG: string = CONFIG;
