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

// Dropping a stash looks like deleting work and is not: it removes a ref, and
// the commit stays in the object database. `git stash store` puts the ref back.
// That is what makes "Put the stash back" an honest offer rather than a button
// that reports success and restores nothing.

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;

const git = (...a: string[]): string =>
  execFileSync("git", a, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-stashrestore-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  writeFileSync(join(repo, "a.txt"), "committed\n");
  git("add", ".");
  git("commit", "-m", "first");
  ctx = new GitContext({ root: repo });
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore);
});

afterEach(() => removeTempRepo(repo));

test("a dropped stash can be put back, with its contents intact", async () => {
  writeFileSync(join(repo, "a.txt"), "work in progress\n");
  git("stash", "push", "-m", "my work");
  const before = await ctx.stashes.list();
  assert.equal(before.length, 1);
  const sha = before[0].sha!;

  const dropped = await bridge.stashDrop(before[0].ref);
  assert.equal(dropped.ok, true);
  assert.equal((await ctx.stashes.list()).length, 0, "the stash is gone");

  const back = await bridge.stashRestore({ sha, message: "my work" });
  assert.equal(back.ok, true, back.message);
  const after = await ctx.stashes.list();
  assert.equal(after.length, 1, "the stash is back");
  assert.equal(after[0].sha, sha, "and it is the same commit");

  // And it still holds the work: applying it brings the content back.
  await ctx.stashes.pop(after[0].ref);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "work in progress\n");
});

test("restoring refuses a sha that is not a commit in this repository", async () => {
  const notHere = await bridge.stashRestore({ sha: "0".repeat(40) });
  assert.equal(notHere.ok, false);
  assert.match(notHere.message ?? "", /no longer in the repository/i);

  // A tree is an object but not a stash; storing it would leave a stash ref
  // that every later read chokes on.
  const tree = git("rev-parse", "HEAD^{tree}").trim();
  const wrongKind = await bridge.stashRestore({ sha: tree });
  assert.equal(wrongKind.ok, false);
});

test("restoring refuses a flag-shaped argument", async () => {
  const r = await bridge.stashRestore({ sha: "--all" });
  assert.equal(r.ok, false);
});
