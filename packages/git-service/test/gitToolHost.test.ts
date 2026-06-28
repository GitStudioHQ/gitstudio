import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { createGitToolHost } from "../src/GitToolHost";
import type { GitToolHost } from "@gitstudio/ai/gitTools";

// Exercise the shared git-tool host against a real throwaway repo: the exact
// adapter the MCP server and the desktop agent both run on. Proves the read
// tools report true state and the write tools actually mutate the repo.

let repo: string;
let ctx: GitContext;
let host: GitToolHost;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repo, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-toolhost-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  git(["config", "commit.gpgsign", "false"]);
  writeFileSync(join(repo, "a.txt"), "one\n");
  git(["add", "a.txt"]);
  git(["commit", "-m", "feat: initial commit"]);
  ctx = new GitContext({ root: repo });
  host = createGitToolHost(ctx);
});

after(() => {
  ctx.dispose();
  rmSync(repo, { recursive: true, force: true });
});

test("read tools report repo state", async () => {
  assert.equal(host.repoRoot(), repo);
  const log = await host.log({ limit: 10 });
  assert.equal(log.length, 1);
  assert.equal(log[0].subject, "feat: initial commit");

  const head = await host.head();
  assert.equal(head.detached, false);
  assert.equal(head.branch, "main");

  const branches = await host.branches();
  assert.ok(branches.some((b) => b.name === "main" && b.current));

  const file = await host.readFile("a.txt");
  assert.equal(file?.text, "one\n");
  assert.equal(file?.binary, false);

  const missing = await host.readFile("nope.txt");
  assert.equal(missing, undefined);
});

test("status reflects staged + unstaged changes", async () => {
  writeFileSync(join(repo, "a.txt"), "one\ntwo\n"); // modify (unstaged)
  writeFileSync(join(repo, "b.txt"), "new\n"); // untracked
  const status = await host.status();
  const a = status.find((f) => f.path === "a.txt" && !f.staged);
  const b = status.find((f) => f.path === "b.txt");
  assert.equal(a?.status, "M");
  assert.equal(b?.status, "?");
});

test("write tools stage and commit", async () => {
  const stage = await host.stage(["a.txt", "b.txt"]);
  assert.equal(stage.ok, true);
  const staged = (await host.status()).filter((f) => f.staged);
  assert.ok(staged.length >= 2, "both files staged");

  const commit = await host.commit("feat: add b and extend a");
  assert.equal(commit.ok, true);
  const log = await host.log({ limit: 10 });
  assert.equal(log[0].subject, "feat: add b and extend a");
});

test("branch tools create and switch", async () => {
  const made = await host.createBranch("feature/x", true);
  assert.equal(made.ok, true);
  assert.equal((await host.head()).branch, "feature/x");
  // Safety guard: an option-looking ref is rejected, not executed.
  const bad = await host.checkout("--evil");
  assert.equal(bad.ok, false);
});

test("diff returns a unified patch for the staged index", async () => {
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await host.stage(["a.txt"]);
  const diff = await host.diff({ staged: true });
  assert.match(diff, /\+three/);
});
