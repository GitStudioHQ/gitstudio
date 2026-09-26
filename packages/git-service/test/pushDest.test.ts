// A push to a destination the CALLER named (`PushOptions.dest`).
//
// Create Pull Request pushed the PR's branch through the named-branch path,
// which takes the remote AND the destination from the upstream. A branch made
// with `git checkout -b feature origin/main` tracks main — so its commits went
// into origin's main, and in a triangular setup (pull from origin, push to a
// fork) to origin's main instead of the fork. `dest` pushes exactly
// refs/heads/<branch>:refs/heads/<dest> to the remote given.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";

const trash: string[] = [];
const contexts: GitContext[] = [];
afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  for (const d of trash.splice(0)) removeTempRepo(d);
});

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function tipOf(bare: string, branch: string): string | undefined {
  try {
    return git(bare, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`);
  } catch {
    return undefined;
  }
}

/** origin and fork (bare), a clone whose `feature` tracks origin/main with one commit. */
function world() {
  const base = mkdtempSync(join(tmpdir(), "gitstudio-pushdest-"));
  trash.push(base);
  const origin = join(base, "origin.git");
  const fork = join(base, "fork.git");
  const work = join(base, "work");
  for (const bare of [origin, fork]) execFileSync("git", ["init", "-q", "--bare", "-b", "main", bare]);
  execFileSync("git", ["init", "-q", "-b", "main", work]);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "t"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git(work, "config", k, v);
  }
  writeFileSync(join(work, "a.txt"), "a\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "base");
  git(work, "remote", "add", "origin", origin);
  git(work, "remote", "add", "fork", fork);
  git(work, "push", "-q", "origin", "main");
  git(work, "fetch", "-q", "origin");
  git(work, "checkout", "-q", "-b", "feature", "--track", "origin/main");
  writeFileSync(join(work, "b.txt"), "b\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "b");
  const ctx = new GitContext({ root: work });
  contexts.push(ctx);
  return { origin, fork, work, ctx, main: tipOf(origin, "main"), mine: git(work, "rev-parse", "HEAD") };
}

test("dest: the branch lands under the name given, on the remote given — not on what it tracks", async () => {
  const w = world();
  const r = await w.ctx.sync.push({ remote: "fork", branch: "feature", dest: "feature" });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(tipOf(w.fork, "feature"), w.mine);
  assert.equal(tipOf(w.origin, "main"), w.main, "origin's main, the branch it tracks, is untouched");
  assert.equal(tipOf(w.origin, "feature"), undefined);
  assert.equal(git(w.work, "config", "--get", "branch.feature.merge"), "refs/heads/main", "its tracking is left alone");
});

test("dest: to the tracked remote, still under the name given", async () => {
  const w = world();
  const r = await w.ctx.sync.push({ remote: "origin", branch: "feature", dest: "feature" });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(tipOf(w.origin, "feature"), w.mine);
  assert.equal(tipOf(w.origin, "main"), w.main);
});

test("dest: is never combined with a force, nor used without its remote and branch", async () => {
  const w = world();
  assert.equal((await w.ctx.sync.push({ remote: "origin", branch: "feature", dest: "main", force: true })).ok, false);
  assert.equal((await w.ctx.sync.push({ branch: "feature", dest: "feature" })).ok, false);
  assert.equal(tipOf(w.origin, "main"), w.main);
  assert.equal(tipOf(w.origin, "feature"), undefined);
});
