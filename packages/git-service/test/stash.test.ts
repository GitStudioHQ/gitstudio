import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";

// A hermetic repo with a tracked file. We dirty it, stash, and exercise the
// list/apply/pop/drop/show/branch round-trip.
let repo: string;
let ctx: GitContext;

function git(args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
}

function read(name: string): string {
  return readFileSync(join(repo, name), "utf8");
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-stash-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  git(["config", "commit.gpgsign", "false"]);

  write("file.txt", "one\ntwo\nthree\n");
  git(["add", "file.txt"]);
  git(["commit", "-m", "base"]);

  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("save then list returns one stash with the given message", async () => {
  write("file.txt", "ONE\ntwo\nthree\n");
  const saved = await ctx.stashes.save({ message: "wip: edit line 1" });
  assert.ok(saved.ok, saved.stderr);

  // Working tree is back to HEAD after stashing.
  assert.equal(read("file.txt"), "one\ntwo\nthree\n");

  const list = await ctx.stashes.list();
  assert.equal(list.length, 1);
  assert.match(list[0].ref, /^stash@\{0\}$/);
  assert.match(list[0].message, /wip: edit line 1/);
  assert.ok(list[0].sha.length >= 7);
  assert.ok(list[0].time > 0);
});

test("show returns the stash diff text", async () => {
  const list = await ctx.stashes.list();
  const diff = await ctx.stashes.show(list[0].ref);
  assert.match(diff, /^-one$/m);
  assert.match(diff, /^\+ONE$/m);
});

test("apply restores changes but keeps the stash", async () => {
  const before = await ctx.stashes.list();
  const applied = await ctx.stashes.apply(before[0].ref);
  assert.ok(applied.ok, applied.stderr);
  assert.equal(read("file.txt"), "ONE\ntwo\nthree\n");
  // Stash still present after apply.
  const after = await ctx.stashes.list();
  assert.equal(after.length, before.length);

  // Reset working tree for the next test.
  git(["checkout", "--", "file.txt"]);
});

test("pop applies then drops the stash", async () => {
  const popped = await ctx.stashes.pop("stash@{0}");
  assert.ok(popped.ok, popped.stderr);
  assert.equal(read("file.txt"), "ONE\ntwo\nthree\n");
  const list = await ctx.stashes.list();
  assert.equal(list.length, 0);

  git(["checkout", "--", "file.txt"]);
});

test("drop removes a stash without applying it", async () => {
  write("file.txt", "x\ntwo\nthree\n");
  await ctx.stashes.save({ message: "to-drop" });
  assert.equal(read("file.txt"), "one\ntwo\nthree\n");
  let list = await ctx.stashes.list();
  assert.equal(list.length, 1);

  const dropped = await ctx.stashes.drop(list[0].ref);
  assert.ok(dropped.ok, dropped.stderr);
  list = await ctx.stashes.list();
  assert.equal(list.length, 0);
  // Working tree untouched by drop.
  assert.equal(read("file.txt"), "one\ntwo\nthree\n");
});

test("includeUntracked stashes new files", async () => {
  write("untracked.txt", "fresh\n");
  const saved = await ctx.stashes.save({
    message: "with untracked",
    includeUntracked: true,
  });
  assert.ok(saved.ok, saved.stderr);
  // The untracked file was stashed away.
  assert.throws(() => read("untracked.txt"));

  const list = await ctx.stashes.list();
  assert.equal(list.length, 1);
  await ctx.stashes.drop(list[0].ref);
});

test("branch creates a new branch from a stash and applies it", async () => {
  write("file.txt", "BRANCHED\ntwo\nthree\n");
  await ctx.stashes.save({ message: "for branch" });
  const list = await ctx.stashes.list();
  assert.equal(list.length, 1);

  const result = await ctx.stashes.branch(list[0].ref, "from-stash");
  assert.ok(result.ok, result.stderr);

  // We're now on the new branch with the stashed change applied.
  const head = await ctx.refs.getHead();
  assert.equal(head.detached, false);
  if (!head.detached) {
    assert.equal(head.branch, "from-stash");
  }
  assert.equal(read("file.txt"), "BRANCHED\ntwo\nthree\n");

  // stash branch drops the stash on success.
  const after = await ctx.stashes.list();
  assert.equal(after.length, 0);

  // Return to main and clean up.
  git(["checkout", "--", "file.txt"]);
  git(["checkout", "main"]);
});
