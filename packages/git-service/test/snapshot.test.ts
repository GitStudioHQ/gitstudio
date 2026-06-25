import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";

let repo: string;
let ctx: GitContext;

function git(args: string[], input?: string): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    input,
    env: {
      ...process.env,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
      GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
    },
  });
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
}

function commit(name: string, content: string, message: string): void {
  write(name, content);
  git(["add", name]);
  git(["commit", "-F", "-"], message);
}

function head(): string {
  return git(["rev-parse", "HEAD"]).trim();
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-snap-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(["config", "user.email", "test@gitstudio.dev"]);
  git(["config", "user.name", "GitStudio Test"]);
  commit("a.txt", "1\n", "c1: root");
  commit("a.txt", "1\n2\n", "c2: second");
  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  rmSync(repo, { recursive: true, force: true });
});

test("capture records HEAD and the current branch on a clean tree", async () => {
  const snap = await ctx.snapshot.capture("test snapshot");
  assert.equal(snap.headSha, head());
  assert.equal(snap.ref, "main");
  assert.equal(snap.stashSha, null);
});

test("restore moves HEAD back after a new commit", async () => {
  const before = head();
  const snap = await ctx.snapshot.capture("before new commit");
  // Advance with a real commit.
  commit("a.txt", "1\n2\n3\n", "c3: extra");
  assert.notEqual(head(), before);
  await ctx.snapshot.restore(snap);
  assert.equal(head(), before);
});

test("restore moves HEAD back after a destructive reset --hard", async () => {
  const before = head();
  const snap = await ctx.snapshot.capture("before reset");
  // Nuke history back to the root commit.
  const root = git(["rev-list", "--max-parents=0", "HEAD"]).trim();
  git(["reset", "--hard", root]);
  assert.equal(head(), root);
  await ctx.snapshot.restore(snap);
  assert.equal(head(), before);
});

test("dirty capture + restore brings back uncommitted edits a reset nuked", async () => {
  // Make an uncommitted edit, then capture it.
  write("a.txt", "1\n2\nDIRTY\n");
  const snap = await ctx.snapshot.capture("dirty work");
  assert.ok(snap.stashSha, "expected a stash sha for dirty tree");

  // A hard reset to HEAD throws the dirty edits away.
  git(["checkout", "--", "a.txt"]);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "1\n2\n");

  // Restore should reset HEAD (no-op here) and re-apply the captured edits.
  await ctx.snapshot.restore(snap);
  assert.equal(readFileSync(join(repo, "a.txt"), "utf8"), "1\n2\nDIRTY\n");

  // Clean back up so other tests start from a clean tree.
  git(["checkout", "--", "a.txt"]);
});

test("isPushed is false for a local-only commit (no remotes)", async () => {
  const sha = head();
  assert.equal(await ctx.snapshot.isPushed(sha), false);
});

test("isPushed is true once a commit is on a remote-tracking branch", async () => {
  // Create a bare 'remote' and push main to it.
  const remote = mkdtempSync(join(tmpdir(), "gitstudio-snap-remote-"));
  execFileSync("git", ["init", "--bare", remote], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  try {
    git(["remote", "add", "origin", remote]);
    git(["push", "-u", "origin", "main"]);
    const sha = head();
    assert.equal(await ctx.snapshot.isPushed(sha), true);
  } finally {
    rmSync(remote, { recursive: true, force: true });
  }
});

test("capture on detached HEAD records a null ref", async () => {
  const sha = head();
  git(["checkout", "--detach", sha]);
  try {
    const snap = await ctx.snapshot.capture("detached");
    assert.equal(snap.ref, null);
    assert.equal(snap.headSha, sha);
  } finally {
    git(["checkout", "main"]);
  }
});
