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
//     and git names it in its error ("…/no-network-in-tests-…/ssh").
//
// Each by the setting nothing outranks — the runs that load this file alone
// (below) keep the developer's own global and system config:
//
//   · ssh: GIT_SSH_COMMAND, above every core.sshCommand — a repository's, and
//     a machine's that would otherwise send the suite's ssh through its own;
//   · git://: GIT_PROXY_COMMAND, above core.gitProxy;
//   · https: http.proxy at the command scope is above the same key in every
//     file, but NOT above a URL-scoped http.<url>.proxy: git ranks those by
//     how much of the URL they name before it looks at scope, so a global
//     `http.https://github.com.proxy` (or an empty one: straight out) won.
//     Every http.<url>.proxy and remote.<name>.proxy a config file has when
//     this loads is named again at the command scope, where the same key is
//     read last and wins; and the wildcards (https://*, https://*.*, …) name
//     the rest, for a file that only applies inside some repository.
//
// A test that serves a remote itself opts in, in so many words: serveOwnSsh()
// below (prCheckoutUpdate.test.ts serves its fake github.com that way). A
// repository's core.sshCommand alone is not enough — which is the point.
//
// And the test process itself: no-network-node.mjs refuses fetch, http(s),
// net and tls to any host but this machine's.
//
// Loaded by hermetic-git.mjs, which every workspace's `test` script preloads;
// and on its own before the tests that must read THIS checkout with its own
// config (scripts/merge-studio/test: a Windows checkout's core.autocrlf is
// system config). packages/git-service/test/noNetworkGit.test.ts is the census
// that keeps every test file under it.

import "./no-network-node.mjs";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Set in every process this module has guarded. */
export const NO_NETWORK_MARK = "GS_TEST_GIT_NO_NETWORK";
/** An address nothing listens on: git's http(s) connects here, and is refused. */
export const NO_NETWORK_PROXY = "http://127.0.0.1:1";
/** How many labels the wildcard proxies cover: https://* … https://*.*.*.*.*.* */
const WILDCARD_LABELS = 6;

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

/** The ssh the guard puts in every git's way: a program that is never there.
 *  Quoted, with forward slashes: git runs it through `sh -c`, which eats a
 *  Windows path's backslashes. */
export const NO_NETWORK_SSH = `"${join(nowhere, "ssh").split("\\").join("/")}"`;

/**
 * The one way a test serves its own ssh: GIT_SSH_COMMAND is the guard's, and
 * it outranks every core.sshCommand — a repository's included. Returns the
 * undo; call it in a `finally`. Forward slashes in `command`, for `sh -c`.
 */
export function serveOwnSsh(command) {
  process.env.GIT_SSH_COMMAND = command;
  return () => {
    process.env.GIT_SSH_COMMAND = NO_NETWORK_SSH;
  };
}

/**
 * Every URL-scoped proxy a config file names as this loads — http.<url>.proxy
 * and remote.<name>.proxy, in the system, global, repository and worktree
 * files, includes followed — so each can be named again above them all.
 */
function scopedProxyKeys() {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)$/.test(k)) delete env[k];
  }
  let r;
  try {
    r = spawnSync("git", ["config", "--show-scope", "-z", "--get-regexp", "^(http\\..+|remote\\..+)\\.proxy$"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
      windowsHide: true,
    });
  } catch {
    return [];
  }
  // 1 is "there are none"; anything else, no git at all: nothing to outrank.
  if (r.status !== 0 || typeof r.stdout !== "string") return [];
  // scope NUL key LF value NUL — or key NUL alone, for a key with no value.
  const parts = r.stdout.split("\0");
  const keys = [];
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (parts[i] !== "command") keys.push(parts[i + 1].split("\n")[0]);
  }
  return keys;
}

/** Config at git's command scope — see above. */
const COMMAND_CONFIG = [
  // An empty value empties the helper list: osxkeychain, manager, store — none runs.
  ["credential.helper", ""],
  // http.proxy outranks the http(s)_proxy variables; NO_PROXY is removed below.
  ["http.proxy", NO_NETWORK_PROXY],
];
{
  const named = new Set(COMMAND_CONFIG.map(([k]) => k));
  const proxy = (key) => {
    if (named.has(key)) return;
    named.add(key);
    COMMAND_CONFIG.push([key, NO_NETWORK_PROXY]);
  };
  // `*` is ONE label of a host: https://* is "localhost" and nothing else.
  for (const scheme of ["https", "http"]) {
    for (let n = 1; n <= WILDCARD_LABELS; n++) proxy(`http.${scheme}://${Array(n).fill("*").join(".")}.proxy`);
  }
  for (const key of scopedProxyKeys()) proxy(key);
}

Object.assign(process.env, {
  [NO_NETWORK_MARK]: "1",
  GIT_TERMINAL_PROMPT: "0",
  GIT_ASKPASS: join(nowhere, "askpass"),
  SSH_ASKPASS: join(nowhere, "askpass"),
  // Above core.sshCommand in every file; a test serving its own: serveOwnSsh.
  GIT_SSH_COMMAND: NO_NETWORK_SSH,
  // …and for anything that reads GIT_SSH alone.
  GIT_SSH: join(nowhere, "ssh"),
  GIT_PROXY_COMMAND: join(nowhere, "git-proxy"),
  GIT_CONFIG_COUNT: String(COMMAND_CONFIG.length),
});
// A parent's longer list must not leave keys past this one's count behind.
for (const k of Object.keys(process.env)) {
  if (/^GIT_CONFIG_(?:KEY|VALUE)_\d+$/.test(k)) delete process.env[k];
}
COMMAND_CONFIG.forEach(([key, value], i) => {
  process.env[`GIT_CONFIG_KEY_${i}`] = key;
  process.env[`GIT_CONFIG_VALUE_${i}`] = value;
});
for (const key of [
  // curl skips the proxy for any host listed here ("*" is every host).
  "NO_PROXY",
  "no_proxy",
  // `git -c` handed down from a parent git (a hook running the suite).
  "GIT_CONFIG_PARAMETERS",
]) {
  delete process.env[key];
}
