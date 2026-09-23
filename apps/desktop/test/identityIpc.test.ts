import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// git:setIdentity / git:identity — the Settings "Git Identity" card's backend.
// `git config` exits NON-ZERO without throwing, so the write path must check
// the exit code: it used to report "updated ✓" while writing nothing (e.g. a
// read-only ~/.gitconfig), which reads as "updating my identity is broken".

let repo: string;
let cfgDir: string;
let cfg: string;
let ctx: GitContext;
let bridge: GitBridge;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-ident-"));
  cfgDir = mkdtempSync(join(tmpdir(), "gitstudio-identcfg-"));
  cfg = join(cfgDir, "gitconfig");
  writeFileSync(cfg, "");
  // Point git's --global scope at our scratch file (GitProcess inherits env).
  savedEnv.GIT_CONFIG_GLOBAL = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = cfg;
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  if (savedEnv.GIT_CONFIG_GLOBAL === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = savedEnv.GIT_CONFIG_GLOBAL;
  ctx?.dispose?.();
  removeTempRepo(repo);
  removeTempRepo(cfgDir);
});

test("setGitIdentity writes both values and gitIdentity reads them back", async () => {
  const r = await bridge.setGitIdentity({ name: "Test User", email: "t@example.com" });
  assert.equal(r.ok, true);
  const written = readFileSync(cfg, "utf8");
  assert.match(written, /name = Test User/);
  assert.match(written, /email = t@example\.com/);
  assert.deepEqual(await bridge.gitIdentity(), { name: "Test User", email: "t@example.com" });
});

test("a failing git config write reports the failure instead of success", async () => {
  // git config rewrites via a lock file + rename, so the file itself being
  // read-only does not stop it — and a read-only DIRECTORY does not stop it on
  // Windows, where CI runs this too. A config path whose parent is a FILE
  // fails the lock on every platform.
  const notADir = join(cfgDir, "not-a-dir");
  writeFileSync(notADir, "");
  process.env.GIT_CONFIG_GLOBAL = join(notADir, "gitconfig");
  // BOTH fields: with one empty, the pair check refuses before git runs, and
  // this passed without ever reaching the write it is named for.
  const r = await bridge.setGitIdentity({ name: "Someone Else", email: "someone@example.com" });
  assert.equal(r.ok, false, "a non-zero git exit must not report ok");
  assert.ok(r.message && r.message.length > 0, "the git stderr should be surfaced");
  assert.doesNotMatch(r.message ?? "", /needs both/, "…from git config, not from the field check");
  assert.notEqual(r.expected, true, "a write that failed is news, so it is crash-reported");
});

test("with no repository open, the card still reads and writes the global identity", async () => {
  // The identity is the user's, not the repository's (report #15 was Save
  // refused with "No repository open." on a machine with none open yet).
  const none = new GitBridge({ getContext: () => undefined } as unknown as RepoStore);
  const r = await none.setGitIdentity({ name: "Pat Example", email: "pat@example.com" });
  assert.equal(r.ok, true, r.message);
  assert.match(readFileSync(cfg, "utf8"), /name = Pat Example/);
  assert.deepEqual(await none.gitIdentity(), { name: "Pat Example", email: "pat@example.com" });
});

test("saving with both fields empty is rejected, not silently 'updated'", async () => {
  const r = await bridge.setGitIdentity({ name: "", email: "  " });
  assert.equal(r.ok, false);
});

/**
 * The card is a pair of fields over a pair of git settings, and git will not
 * record a commit without both. Clearing one and pressing Save used to write
 * only the other, leave the cleared setting exactly as it was, and report
 * "Identity updated" — so the value on screen and the value in ~/.gitconfig
 * disagreed, with the app insisting it had done what was asked.
 */
test("clearing one field is refused, and leaves the stored identity alone", async () => {
  await bridge.setGitIdentity({ name: "Test User", email: "t@example.com" });

  const cleared = await bridge.setGitIdentity({ name: "", email: "t@example.com" });
  assert.equal(cleared.ok, false, "a half-filled identity is not saved");
  assert.equal(cleared.changed, false);
  assert.match(cleared.message ?? "", /both a name and an email/i, "and says why");
  assert.match(cleared.message ?? "", /nothing has been changed/i, "and what it did instead");

  assert.deepEqual(
    await bridge.gitIdentity(),
    { name: "Test User", email: "t@example.com" },
    "the stored identity is untouched — which is what the message promised",
  );

  const other = await bridge.setGitIdentity({ name: "Test User", email: "   " });
  assert.equal(other.ok, false, "whitespace is empty too");
  assert.match(other.message ?? "", /Add an email/i, "naming the field that is missing");
});
