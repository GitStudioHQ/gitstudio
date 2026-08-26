import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge } from "../src/main/gitBridge";
import type { RepoStore } from "../src/main/repoStore";
import { removeTempRepo } from "./tmpRepo";

// ref:log — the per-ref history behind the peek cards (branch / remote / tag
// popups). Driven through the same bridge method the IPC channel calls.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-reflog-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  writeFileSync(join(repo, "f.txt"), "one\n");
  git("add", ".");
  git("commit", "-m", "first");
  writeFileSync(join(repo, "f.txt"), "two\n");
  git("commit", "-am", "second");
  git("branch", "side");
  writeFileSync(join(repo, "f.txt"), "three\n");
  git("commit", "-am", "third (main only)");
  git("tag", "v1");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

test("ref:log lists a branch's commits newest-first with the peek's row shape", async () => {
  const log = await bridge.refLog({ ref: "main" });
  assert.equal(log.length, 3);
  assert.equal(log[0].subject, "third (main only)");
  assert.equal(log[2].subject, "first");
  assert.equal(log[0].shortSha, log[0].sha.slice(0, 7));
  assert.equal(log[0].author, "Dev");
  assert.ok(log[0].date > 0);
});

test("ref:log scopes to the named ref, not HEAD", async () => {
  const log = await bridge.refLog({ ref: "side" });
  assert.deepEqual(
    log.map((c) => c.subject),
    ["second", "first"],
  );
});

test("ref:log resolves tags and honors maxCount", async () => {
  const log = await bridge.refLog({ ref: "v1", maxCount: 1 });
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, "third (main only)");
});

test("ref:log returns empty for an unknown ref and refuses a flag-shaped one", async () => {
  assert.deepEqual(await bridge.refLog({ ref: "does-not-exist" }), []);
  assert.deepEqual(await bridge.refLog({ ref: "--all" }), []);
});
