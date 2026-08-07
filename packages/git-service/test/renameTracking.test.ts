import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";

// Renaming a PUBLISHED branch, then pushing.
//
// The reported bug: push a commit, amend it, rename the branch, push again —
// and the push went to (or was refused for) the OLD branch name. The cause is
// that `git branch -m` deliberately keeps the tracking config: the branch on the
// server was not renamed, so `branch.<new>.merge` still says the old name.
// Everything downstream then silently refers to the old branch.
//
// These tests pin both halves: that we can SEE the stale tracking
// (BranchOps.upstreamOf), and that a bare push behaves identically regardless of
// the user's push.default instead of failing or landing on the wrong branch.

let bare: string;
let clone: string;
let ctx: GitContext;

const ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0" };

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: ENV });
}
const clik = (args: string[]) => gitIn(clone, args);

function commitIn(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  gitIn(cwd, ["add", name]);
  gitIn(cwd, ["commit", "-m", msg]);
}

/** Branches that exist on the bare "remote". */
function remoteBranches(): string[] {
  return gitIn(bare, ["for-each-ref", "--format=%(refname:short)", "refs/heads"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
    .sort();
}

before(() => {
  bare = mkdtempSync(join(tmpdir(), "gitstudio-rn-bare-"));
  execFileSync("git", ["init", "--bare", "-b", "main", bare], { env: ENV });

  const seed = mkdtempSync(join(tmpdir(), "gitstudio-rn-seed-"));
  execFileSync("git", ["clone", bare, seed], { env: ENV });
  gitIn(seed, ["config", "user.email", "dev@example.com"]);
  gitIn(seed, ["config", "user.name", "Dev"]);
  gitIn(seed, ["config", "commit.gpgsign", "false"]);
  commitIn(seed, "file.txt", "base\n", "base");
  gitIn(seed, ["push", "origin", "main"]);
  rmSync(seed, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

  clone = mkdtempSync(join(tmpdir(), "gitstudio-rn-clone-"));
  execFileSync("git", ["clone", bare, clone], { env: ENV });
  clik(["config", "user.email", "dev@example.com"]);
  clik(["config", "user.name", "Dev"]);
  clik(["config", "commit.gpgsign", "false"]);

  ctx = new GitContext({ root: clone });
});

after(() => {
  ctx?.dispose();
  for (const dir of [bare, clone]) {
    if (dir) {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    }
  }
});

/** Reset to a clean `feature/old`, published, amended, then renamed to new. */
function reproduce(pushDefault: string): void {
  clik(["checkout", "-q", "main"]);
  for (const b of ["feature/old", "feature/new"]) {
    try {
      clik(["branch", "-D", b]);
    } catch {
      /* not there */
    }
  }
  for (const b of remoteBranches().filter((n) => n !== "main")) {
    gitIn(bare, ["update-ref", "-d", `refs/heads/${b}`]);
  }
  clik(["config", "push.default", pushDefault]);
  clik(["checkout", "-qb", "feature/old"]);
  commitIn(clone, "work.txt", "one\n", "work");
  clik(["push", "-q", "-u", "origin", "feature/old"]);
  // Amend AFTER publishing — this is what makes the local and remote diverge.
  writeFileSync(join(clone, "work.txt"), "one\ntwo\n");
  clik(["add", "work.txt"]);
  clik(["commit", "-q", "--amend", "-m", "work (amended)"]);
  clik(["branch", "-m", "feature/old", "feature/new"]);
}

beforeEach(() => reproduce("simple"));

test("git keeps the OLD name in tracking config after a rename", async () => {
  // Not a bug in git — the server-side branch really is still called
  // feature/old. It IS the thing every downstream reader has to notice.
  const upstream = await ctx.branches.upstreamOf("feature/new");
  assert.deepEqual(upstream, { remote: "origin", branch: "feature/old" });

  // And the short-name view agrees, which is what the push modal used to show.
  assert.equal(await ctx.sync.currentUpstream(), "origin/feature/old");
});

test("upstreamOf returns null for a branch that was never published", async () => {
  clik(["checkout", "-qb", "local-only"]);
  assert.equal(await ctx.branches.upstreamOf("local-only"), null);
  clik(["checkout", "-q", "feature/new"]);
  clik(["branch", "-D", "local-only"]);
});

test("push after a rename fails on the DIVERGENCE, not on the name mismatch", async () => {
  // Bare `git push` under push.default=simple never even reaches the remote: it
  // refuses locally with "the upstream branch of your current branch does not
  // match the name of your current branch" plus a wall of advice about
  // push.default — which tells the user nothing about their actual situation.
  //
  // Resolving the refspec ourselves gets the real answer out of git: the amend
  // rewrote the commit, so this is a non-fast-forward and wants a force push.
  const r = await ctx.sync.push();
  assert.equal(r.ok, false);
  assert.match(r.stderr, /non-fast-forward|fetch first|behind its remote/i);
  assert.doesNotMatch(r.stderr, /does not match the name of your current branch/i);
});

test("every push.default produces the SAME outcome after a rename", async () => {
  // The bug's sharpest edge: one click, three different behaviours depending on
  // a config the user never set. `simple` refuses locally, `upstream` pushes to
  // the old name, `current` pushes to the NEW name while still tracking the old.
  // All three must now resolve to the same thing — the tracked branch.
  const results: Array<{ mode: string; ok: boolean; branches: string[] }> = [];
  for (const mode of ["simple", "upstream", "current"]) {
    reproduce(mode);
    const r = await ctx.sync.push({ force: true });
    results.push({ mode, ok: r.ok, branches: remoteBranches() });
  }
  for (const got of results) {
    assert.equal(got.ok, true, `${got.mode} failed`);
    assert.deepEqual(
      got.branches,
      ["feature/old", "main"],
      `${got.mode} pushed to the wrong branch`,
    );
  }
});

test("a forced push after a rename updates the tracked branch to the amended commit", async () => {
  const local = clik(["rev-parse", "HEAD"]).trim();
  const r = await ctx.sync.push({ force: true });
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(remoteBranches(), ["feature/old", "main"]);
  assert.equal(
    gitIn(bare, ["rev-parse", "refs/heads/feature/old"]).trim(),
    local,
    "the tracked branch should now hold the amended commit",
  );
});

test("publishing under the new name repoints tracking and clears the divergence", async () => {
  // What the rename dialog's "Rename on origin" does: push the new name with
  // --set-upstream, then drop the old remote branch.
  const pushed = await ctx.sync.push({
    remote: "origin",
    branch: "feature/new",
    setUpstream: true,
  });
  assert.equal(pushed.ok, true, pushed.stderr);

  assert.deepEqual(await ctx.branches.upstreamOf("feature/new"), {
    remote: "origin",
    branch: "feature/new",
  });
  // The whole point: no longer 1 ahead / 1 behind a stale remote branch.
  assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 0, behind: 0 });

  const removed = await ctx.branches.deleteRemoteBranch("origin", "feature/old");
  assert.equal(removed.ok, true, removed.stderr);
  assert.deepEqual(remoteBranches(), ["feature/new", "main"]);
});

test("a branch deliberately tracking a different name is left alone", async () => {
  // Legal and sometimes intentional: track origin/main from a local branch with
  // another name. upstreamOf must report it truthfully so callers can tell this
  // apart from rename fallout by comparing against the OLD name.
  clik(["checkout", "-qb", "my-main", "main"]);
  clik(["branch", "--set-upstream-to=origin/main", "my-main"]);
  assert.deepEqual(await ctx.branches.upstreamOf("my-main"), {
    remote: "origin",
    branch: "main",
  });
  clik(["checkout", "-q", "feature/new"]);
  clik(["branch", "-D", "my-main"]);
});
