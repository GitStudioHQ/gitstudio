import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
  chmodSync(cfgDir, 0o755); // un-readonly so cleanup can delete it
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
  // git config rewrites via a lock file + rename, so the DIRECTORY must be
  // read-only to make the write fail (a read-only file alone doesn't).
  chmodSync(cfgDir, 0o555);
  const r = await bridge.setGitIdentity({ name: "Someone Else", email: "" });
  assert.equal(r.ok, false, "a non-zero git exit must not report ok");
  assert.ok(r.message && r.message.length > 0, "the git stderr should be surfaced");
});

test("saving with both fields empty is rejected, not silently 'updated'", async () => {
  const r = await bridge.setGitIdentity({ name: "", email: "  " });
  assert.equal(r.ok, false);
});
