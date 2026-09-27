// No test in this repository reaches the network or a credential helper.
//
// ghRepoOpen.test.ts once cloned https://github.com/acme/elsewhere for real,
// and git asked the macOS keychain's credential helper — which waits on a
// dialog on the screen of whoever runs the suite. So, for every git a test
// process runs (the fixtures' own, and GitContext / GitProcess / RebaseRunner /
// a clone under test, which inherit this environment):
//
//   · no credential helper runs: credential.helper is emptied at git's
//     COMMAND scope, read after the system, global, repository and worktree
//     files, so nothing a machine or a test sets brings one back;
//   · nothing prompts: no terminal prompt, and askpass is a program that is
//     never there;
//   · a remote that is not on this disk fails at once: https goes to a proxy
//     nothing listens on, ssh and git:// to a program that is never there,
//     and git names it in its error ("cannot exec …/no-network-in-tests/ssh").
//
// A test that serves a remote itself says so in the repository it made —
// core.sshCommand, as prCheckoutUpdate.test.ts does, still outranks GIT_SSH.
//
// Loaded by hermetic-git.mjs, which every workspace's `test` script preloads;
// and on its own before the tests that must read THIS checkout with its own
// config (scripts/merge-studio/test: a Windows checkout's core.autocrlf is
// system config). packages/git-service/test/noNetworkGit.test.ts is the census
// that keeps every test file under it.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set in every process this module has guarded. */
export const NO_NETWORK_MARK = "GS_TEST_GIT_NO_NETWORK";
/** An address nothing listens on: git's http(s) connects here, and is refused. */
export const NO_NETWORK_PROXY = "http://127.0.0.1:1";

// An empty folder of this process's own (never a fixed path another user could
// fill): a program named in it fails to start, on every system.
const nowhere = mkdtempSync(join(tmpdir(), "gitstudio-no-network-in-tests-"));
process.on("exit", () => {
  try {
    rmSync(nowhere, { recursive: true, force: true });
  } catch {
    /* a temp folder left behind is not a failure */
  }
});

/** Config at git's command scope — see above. */
const COMMAND_CONFIG = [
  // An empty value empties the helper list: osxkeychain, manager, store — none runs.
  ["credential.helper", ""],
  // http.proxy outranks the http(s)_proxy variables; NO_PROXY is removed below.
  ["http.proxy", NO_NETWORK_PROXY],
];

Object.assign(process.env, {
  [NO_NETWORK_MARK]: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: join(nowhere, "askpass"),
  SSH_ASKPASS: join(nowhere, "askpass"),
  // Below core.sshCommand, which a test that serves its own "ssh" sets in its
  // repository; above plain `ssh`.
  GIT_SSH: join(nowhere, "ssh"),
  GIT_PROXY_COMMAND: join(nowhere, "git-proxy"),
  GIT_CONFIG_COUNT: String(COMMAND_CONFIG.length),
});
COMMAND_CONFIG.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
});
for (const key of [
  // Would outrank core.sshCommand and GIT_SSH alike.
  "GIT_SSH_COMMAND",
  // curl skips the proxy for any host listed here ("*" is every host).
  "NO_PROXY",
  "no_proxy",
  // `git -c` handed down from a parent git (a hook running the suite).
  "GIT_CONFIG_PARAMETERS",
]) {
  delete process.env[key];
}
