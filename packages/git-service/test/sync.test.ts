import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { parseRemoteVerbose } from "../src/RemoteOps";

// A clone tracking a local bare "remote". We diverge both sides and assert the
// ahead/behind counts, then push/pull/fetch round-trip.
let bare: string;
let clone: string;
let ctx: GitContext;

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function clik(args: string[]): string {
  return gitIn(clone, args);
}

function commitIn(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  gitIn(cwd, ["add", name]);
  gitIn(cwd, ["commit", "-m", msg]);
}

before(() => {
  bare = mkdtempSync(join(tmpdir(), "gitstudio-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });

  // Seed the bare via a throwaway working clone.
  const seed = mkdtempSync(join(tmpdir(), "gitstudio-seed-"));
  execFileSync("git", ["clone", bare, seed], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  gitIn(seed, ["config", "user.email", "dev@example.com"]);
  gitIn(seed, ["config", "user.name", "Dev"]);
  gitIn(seed, ["config", "commit.gpgsign", "false"]);
  commitIn(seed, "file.txt", "base\n", "base");
  gitIn(seed, ["push", "origin", "main"]);
  rmSync(seed, { recursive: true, force: true });

  // The clone under test.
  clone = mkdtempSync(join(tmpdir(), "gitstudio-clone-"));
  execFileSync("git", ["clone", bare, clone], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  clik(["config", "user.email", "dev@example.com"]);
  clik(["config", "user.name", "Dev"]);
  clik(["config", "commit.gpgsign", "false"]);

  ctx = new GitContext({ root: clone });
});

after(() => {
  ctx?.dispose();
  for (const dir of [bare, clone]) {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("currentUpstream is origin/main on a fresh clone", async () => {
  const upstream = await ctx.sync.currentUpstream();
  assert.equal(upstream, "origin/main");
});

test("aheadBehind is {0,0} right after clone", async () => {
  const counts = await ctx.sync.aheadBehind();
  assert.deepEqual(counts, { ahead: 0, behind: 0 });
});

test("aheadBehind reports ahead after a local commit", async () => {
  commitIn(clone, "local.txt", "a\n", "local 1");
  commitIn(clone, "local.txt", "ab\n", "local 2");
  const counts = await ctx.sync.aheadBehind();
  assert.deepEqual(counts, { ahead: 2, behind: 0 });
});

test("push publishes the local commits (ahead drops to 0)", async () => {
  const pushed = await ctx.sync.push();
  assert.ok(pushed.ok, pushed.stderr);
  const counts = await ctx.sync.aheadBehind();
  assert.deepEqual(counts, { ahead: 0, behind: 0 });
});

test("aheadBehind reports behind after the remote advances", async () => {
  // Advance the remote via another working clone.
  const other = mkdtempSync(join(tmpdir(), "gitstudio-other-"));
  execFileSync("git", ["clone", bare, other], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  gitIn(other, ["config", "user.email", "dev@example.com"]);
  gitIn(other, ["config", "user.name", "Dev"]);
  gitIn(other, ["config", "commit.gpgsign", "false"]);
  commitIn(other, "remote.txt", "r\n", "remote 1");
  gitIn(other, ["push", "origin", "main"]);
  rmSync(other, { recursive: true, force: true });

  // Fetch so our remote-tracking ref sees the new commit.
  const fetched = await ctx.sync.fetch({ prune: true });
  assert.ok(fetched.ok, fetched.stderr);

  const counts = await ctx.sync.aheadBehind();
  assert.deepEqual(counts, { ahead: 0, behind: 1 });
});

test("pull brings the branch up to date (behind drops to 0)", async () => {
  const pulled = await ctx.sync.pull();
  assert.ok(pulled.ok, pulled.stderr);
  const counts = await ctx.sync.aheadBehind();
  assert.deepEqual(counts, { ahead: 0, behind: 0 });
});

test("aheadBehind for a branch with no upstream is {0,0}", async () => {
  clik(["checkout", "-b", "no-upstream"]);
  const counts = await ctx.sync.aheadBehind("no-upstream");
  assert.deepEqual(counts, { ahead: 0, behind: 0 });
  clik(["checkout", "main"]);
});

test("remotes.list parses origin's fetch + push URLs", async () => {
  const remotes = await ctx.remotes.list();
  assert.equal(remotes.length, 1);
  assert.equal(remotes[0].name, "origin");
  assert.equal(remotes[0].fetchUrl, bare);
  assert.equal(remotes[0].pushUrl, bare);
});

test("parseRemoteVerbose merges fetch + push lines per remote", () => {
  const sample =
    "origin\tgit@example.com:me/repo.git (fetch)\n" +
    "origin\tgit@example.com:me/repo.git (push)\n" +
    "upstream\thttps://example.com/upstream.git (fetch)\n" +
    "upstream\thttps://example.com/upstream-push.git (push)\n";
  const parsed = parseRemoteVerbose(sample);
  assert.equal(parsed.length, 2);
  assert.deepEqual(parsed[0], {
    name: "origin",
    fetchUrl: "git@example.com:me/repo.git",
    pushUrl: "git@example.com:me/repo.git",
  });
  assert.equal(parsed[1].fetchUrl, "https://example.com/upstream.git");
  assert.equal(parsed[1].pushUrl, "https://example.com/upstream-push.git");
});

test("branches and tags ops round-trip on the clone", async () => {
  // Branch create + checkout + rename + delete.
  let r = await ctx.branches.create("topic", "main");
  assert.ok(r.ok, r.stderr);
  r = await ctx.branches.rename("topic", "topic2");
  assert.ok(r.ok, r.stderr);
  r = await ctx.branches.delete("topic2");
  assert.ok(r.ok, r.stderr);

  // checkoutNew then back.
  r = await ctx.branches.checkoutNew("feature-x", "main");
  assert.ok(r.ok, r.stderr);
  const head = await ctx.refs.getHead();
  assert.equal(head.detached, false);
  await ctx.branches.checkout("main");
  await ctx.branches.delete("feature-x", { force: true });

  // Tags: lightweight + annotated + delete.
  let t = await ctx.tags.create("v1");
  assert.ok(t.ok, t.stderr);
  t = await ctx.tags.create("v2", { message: "release two", ref: "main" });
  assert.ok(t.ok, t.stderr);
  const tagShow = gitIn(clone, ["cat-file", "-t", "v2"]).trim();
  assert.equal(tagShow, "tag"); // annotated
  t = await ctx.tags.delete("v1");
  assert.ok(t.ok, t.stderr);
  t = await ctx.tags.delete("v2");
  assert.ok(t.ok, t.stderr);
});
