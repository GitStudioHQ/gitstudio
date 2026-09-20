import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { removeTempRepo } from "./tmpRepo";
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
  removeTempRepo(seed);

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
      removeTempRepo(dir);
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
  removeTempRepo(other);

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

// Publishing an unpublished branch that has NO commits of its own.
// A bare `git push` REFUSES this ("the current branch has no upstream branch"),
// so SyncOps.push() must resolve the target itself and --set-upstream. The
// zero-commits case is the one that regressed: the branch exists only locally
// and pushing appeared to do nothing at all.
test("push() publishes an unpublished branch with no new commits", async () => {
  await ctx.branches.checkout("main");
  const r0 = await ctx.branches.checkoutNew("publish-me", "main");
  assert.ok(r0.ok, r0.stderr);

  // Precondition: no upstream, and nothing ahead.
  assert.equal(await ctx.sync.currentUpstream(), null);
  assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 0, behind: 0 });

  // The bare call the UI makes — no remote, no branch, no setUpstream.
  const pushed = await ctx.sync.push();
  assert.ok(pushed.ok, `push failed: ${pushed.stderr}`);

  // It really landed on the remote, and tracking is configured.
  assert.equal(await ctx.sync.currentUpstream(), "origin/publish-me");
  const remoteHeads = gitIn(clone, ["ls-remote", "--heads", "origin"]);
  assert.match(remoteHeads, /refs\/heads\/publish-me/);

  // A second push is a normal no-op push, not another publish.
  const again = await ctx.sync.push();
  assert.ok(again.ok, `second push failed: ${again.stderr}`);

  await ctx.branches.checkout("main");
});

// An already-tracking branch must NOT be re-published or have its upstream
// rewritten by the auto-publish path.
test("push() leaves an existing upstream alone", async () => {
  await ctx.branches.checkout("main");
  const before = await ctx.sync.currentUpstream();
  assert.equal(before, "origin/main");
  const r = await ctx.sync.push();
  assert.ok(r.ok, r.stderr);
  assert.equal(await ctx.sync.currentUpstream(), "origin/main");
});

// A branch that shares its name with a tag must still publish. An unqualified
// refspec resolves against refs/heads AND refs/tags, so `git push origin X`
// fails with "src refspec X matches more than one"; the auto-publish path
// therefore pushes refs/heads/X:refs/heads/X.
test("push() publishes a branch whose name collides with a tag", async () => {
  await ctx.branches.checkout("main");
  const c = await ctx.branches.checkoutNew("collide", "main");
  assert.ok(c.ok, c.stderr);
  const t = await ctx.tags.create("collide");
  assert.ok(t.ok, t.stderr);

  assert.equal(await ctx.sync.currentUpstream(), null);
  const pushed = await ctx.sync.push();
  assert.ok(pushed.ok, `push failed: ${pushed.stderr}`);
  assert.equal(await ctx.sync.currentUpstream(), "origin/collide");

  await ctx.tags.delete("collide");
  await ctx.branches.checkout("main");
});

// Issue #23: fetch({prune}) must drop remote-tracking refs whose branch was
// deleted on the remote — and a plain fetch must leave them alone, so the
// prune setting is a real choice rather than a no-op.
test("fetch({prune}) removes a remote-tracking ref deleted on the remote", async () => {
  await ctx.branches.checkout("main");
  clik(["push", "origin", "main:doomed"]);
  const fetched = await ctx.sync.fetch({});
  assert.ok(fetched.ok, fetched.stderr);
  assert.match(clik(["branch", "-r"]), /origin\/doomed/);

  // Delete on the remote; a non-pruning fetch keeps the stale ref.
  clik(["push", "origin", "--delete", "doomed"]);
  clik(["update-ref", "refs/remotes/origin/doomed", clik(["rev-parse", "main"]).trim()]);
  const plain = await ctx.sync.fetch({});
  assert.ok(plain.ok, plain.stderr);
  assert.match(clik(["branch", "-r"]), /origin\/doomed/);

  const pruned = await ctx.sync.fetch({ prune: true });
  assert.ok(pruned.ok, pruned.stderr);
  assert.doesNotMatch(clik(["branch", "-r"]), /origin\/doomed/);
});

// The branch menu's "Pull N into 'feature'" for a branch that is NOT checked
// out: a fetch straight into the local ref, never a checkout. The same op was
// spelled out by hand in both the extension and the desktop bridge; this is
// its one home.
test("pullFastForward moves a non-checked-out branch to its upstream, HEAD untouched", async () => {
  await ctx.branches.checkout("main");
  // `behind` tracks origin/main from where main is now; then main moves on
  // and publishes, so origin/main is ahead of `behind` by one.
  clik(["branch", "--track", "behind", "origin/main"]);
  const parked = clik(["rev-parse", "behind"]).trim();
  commitIn(clone, "ff.txt", "advance\n", "advance main");
  const pushed = await ctx.sync.push();
  assert.ok(pushed.ok, pushed.stderr);
  const tip = clik(["rev-parse", "origin/main"]).trim();
  assert.notEqual(parked, tip);

  const r = await ctx.sync.pullFastForward("behind");
  assert.ok(r.ok, r.stderr);
  assert.equal(clik(["rev-parse", "behind"]).trim(), tip);
  // The worktree never moved: still on main, at main.
  assert.equal(clik(["rev-parse", "--abbrev-ref", "HEAD"]).trim(), "main");
  assert.equal(clik(["rev-parse", "HEAD"]).trim(), tip);
});

test("pullFastForward refuses a diverged branch and the checked-out one", async () => {
  await ctx.branches.checkout("main");
  // Diverge `behind` from its upstream with a commit of its own.
  await ctx.branches.checkout("behind");
  commitIn(clone, "mine.txt", "local only\n", "diverge");
  await ctx.branches.checkout("main");
  commitIn(clone, "ff.txt", "advance again\n", "advance main again");
  const pushed = await ctx.sync.push();
  assert.ok(pushed.ok, pushed.stderr);
  const before = clik(["rev-parse", "behind"]).trim();

  const nonFf = await ctx.sync.pullFastForward("behind");
  assert.equal(nonFf.ok, false);
  assert.match(nonFf.stderr, /non-fast-forward|rejected/);
  assert.equal(clik(["rev-parse", "behind"]).trim(), before, "a refused pull moves nothing");

  // git will not fetch into the branch that is checked out.
  const current = await ctx.sync.pullFastForward("main");
  assert.equal(current.ok, false);
  assert.match(current.stderr, /checked out/);
});

test("pullFastForward on a branch with no upstream says so", async () => {
  await ctx.branches.checkout("main");
  clik(["branch", "lone"]);
  const r = await ctx.sync.pullFastForward("lone");
  assert.equal(r.ok, false);
  assert.match(r.stderr, /'lone' has no upstream/);
});

// A remote may be named with a slash. Both hand-rolled versions of this op
// split `%(upstream:short)` ("team/eu/main") on its FIRST slash and fetched
// from a remote called "team", which does not exist.
test("pullFastForward resolves a remote whose name contains a slash", async () => {
  await ctx.branches.checkout("main");
  clik(["remote", "add", "team/eu", bare]);
  clik(["fetch", "-q", "team/eu"]);
  clik(["branch", "--track", "slashed", "team/eu/main"]);
  clik(["update-ref", "refs/heads/slashed", clik(["rev-parse", "HEAD~1"]).trim()]);
  const tip = clik(["rev-parse", "team/eu/main"]).trim();
  assert.notEqual(clik(["rev-parse", "slashed"]).trim(), tip);

  const r = await ctx.sync.pullFastForward("slashed");
  assert.ok(r.ok, r.stderr);
  assert.equal(clik(["rev-parse", "slashed"]).trim(), tip);
  clik(["remote", "remove", "team/eu"]);
});
