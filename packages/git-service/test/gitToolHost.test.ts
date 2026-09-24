import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
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
  removeTempRepo(repo);
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

  // With nothing stopped, git_reset still resets (its guard is for a stop only).
  const soft = await host.reset("soft", "HEAD~1");
  assert.equal(soft.ok, true, soft.message);
  assert.equal((await host.log({ limit: 10 }))[0].subject, "feat: initial commit");
  assert.equal((await host.commit("feat: add b and extend a")).ok, true, "the soft reset kept everything staged");
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

test("checking out a branch git_branches reported as heads/<name> lands ON it, not detached", async () => {
  // A branch and a tag both called "release", the tag one commit ahead. The
  // agent reads the branch's name from git_branches — `%(refname:short)`,
  // which is "heads/release" here — and hands it straight back. As a bare
  // `git checkout heads/release` that DETACHED at the branch tip, reported ok.
  const sh = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  sh(["stash", "-u", "-q"]);
  sh(["checkout", "-q", "main"]);
  sh(["branch", "release"]);
  const branchTip = sh(["rev-parse", "refs/heads/release"]);
  sh(["commit", "-q", "--allow-empty", "-m", "ahead of the branch"]);
  sh(["tag", "release"]);
  const listed = (await host.branches()).find((b) => b.name === "heads/release");
  assert.ok(listed, "git_branches reports the branch by git's short form");
  const r = await host.checkout(listed.name);
  assert.equal(r.ok, true, r.message);
  assert.equal(sh(["symbolic-ref", "-q", "HEAD"]), "refs/heads/release", "attached to the branch");
  assert.equal(sh(["rev-parse", "HEAD"]), branchTip, "at the BRANCH's tip, not the tag's");
  // A full name works too, and anything that is not a local branch is still
  // git's to resolve: a tag's short name detaches at the tag, as before.
  sh(["checkout", "-q", "main"]);
  assert.equal((await host.checkout("refs/heads/release")).ok, true);
  assert.equal(sh(["symbolic-ref", "-q", "HEAD"]), "refs/heads/release");
  assert.equal((await host.checkout("tags/release")).ok, true);
  assert.equal(sh(["rev-parse", "HEAD"]), sh(["rev-parse", "refs/tags/release^{commit}"]), "a tag still checks out as the tag");
  sh(["checkout", "-q", "main"]);
});

test("deleting a branch git_branches reported as heads/<name> deletes THAT branch, and never the tag", async () => {
  // Runs after the test above, which left a branch and a tag both named
  // "release". `git branch -d heads/release` finds no branch of that name.
  const sh = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  sh(["checkout", "-q", "main"]);
  const tag = sh(["rev-parse", "refs/tags/release"]);
  const listed = (await host.branches()).find((b) => b.name === "heads/release");
  assert.ok(listed, "the agent is told heads/release");
  const r = await host.deleteBranch(listed.name, true);
  assert.equal(r.ok, true, r.message);
  assert.equal(sh(["for-each-ref", "refs/heads/release"]), "", "the branch is gone");
  assert.equal(sh(["rev-parse", "refs/tags/release"]), tag, "the tag is untouched");
});

test("a branch named like an option is refused by its full name with the reason, not detached onto", async () => {
  // "refs/heads/-f" clears the argv guard (it starts with "refs/"), and the
  // planner refuses it — after which the fall-through handed git the full
  // name as a REVISION and detached HEAD at the branch tip, reported ok.
  const sh = (args: string[]): string =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
  sh(["checkout", "-q", "main"]);
  sh(["update-ref", "refs/heads/-f", "HEAD~1"]);
  const r = await host.checkout("refs/heads/-f");
  assert.equal(r.ok, false);
  assert.match(r.message ?? "", /can't safely check out a branch whose name starts with "-"/);
  assert.equal(sh(["symbolic-ref", "-q", "HEAD"]), "refs/heads/main", "HEAD did not move");
  sh(["update-ref", "-d", "refs/heads/-f"]);
});
