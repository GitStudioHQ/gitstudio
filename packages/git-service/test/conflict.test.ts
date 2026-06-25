import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";

// A hermetic repo with a real merge conflict: two branches edit the same line
// of the same file, then `git merge` fails, leaving file.txt unmerged with
// stages :1: (base), :2: (ours), :3: (theirs) populated.
let repo: string;
let ctx: GitContext;

function git(args: string[], allowFail = false): string {
  try {
    return execFileSync("git", args, {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
  } catch (err) {
    if (allowFail) {
      return "";
    }
    throw err;
  }
}

function write(name: string, content: string): void {
  writeFileSync(join(repo, name), content);
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-conflict-"));

  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  // Ensure stage reads behave predictably regardless of the host's merge config.
  git(["config", "merge.conflictStyle", "merge"]);

  // Base commit: file.txt with a shared middle line.
  write("file.txt", "line one\nshared base\nline three\n");
  git(["add", "file.txt"]);
  git(["commit", "-m", "base"]);

  // ours: edit the middle line on main.
  write("file.txt", "line one\nOURS change\nline three\n");
  git(["add", "file.txt"]);
  git(["commit", "-m", "ours edit"]);

  // theirs: branch off the base and edit the same line differently.
  const baseSha = git(["rev-parse", "HEAD~1"]).trim();
  git(["checkout", "-b", "theirs", baseSha]);
  write("file.txt", "line one\nTHEIRS change\nline three\n");
  git(["add", "file.txt"]);
  git(["commit", "-m", "theirs edit"]);

  // Back to main and merge theirs -> conflict on file.txt.
  git(["checkout", "main"]);
  git(["merge", "theirs"], /* allowFail */ true);

  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("listConflicts finds the unmerged file", async () => {
  const conflicts = await ctx.conflict.listConflicts();
  assert.deepEqual(conflicts, ["file.txt"]);
});

test("isConflicted is true for the unmerged file and false otherwise", async () => {
  assert.equal(await ctx.conflict.isConflicted("file.txt"), true);
  assert.equal(await ctx.conflict.isConflicted("nope.txt"), false);
});

test("getConflictVersions reads ours/base/theirs from git stages", async () => {
  const versions = await ctx.conflict.getConflictVersions("file.txt");

  assert.equal(versions.source, "git-stages");
  assert.equal(versions.hasBase, true);
  assert.equal(versions.base, "line one\nshared base\nline three\n");
  assert.equal(versions.ours, "line one\nOURS change\nline three\n");
  assert.equal(versions.theirs, "line one\nTHEIRS change\nline three\n");
});

test("getHeadVersion returns the file's HEAD content, and '' when absent", async () => {
  const head = await ctx.conflict.getHeadVersion("file.txt");
  assert.equal(head, "line one\nOURS change\nline three\n");

  const missing = await ctx.conflict.getHeadVersion("does-not-exist.txt");
  assert.equal(missing, "");
});

test("getConflictVersions falls back to markers when stages are unavailable", async () => {
  // A path with no index stages forces the marker fallback via workingText.
  const workingText =
    "head\n" +
    "<<<<<<< HEAD\n" +
    "our line\n" +
    "||||||| base\n" +
    "base line\n" +
    "=======\n" +
    "their line\n" +
    ">>>>>>> theirs\n" +
    "tail\n";

  const versions = await ctx.conflict.getConflictVersions("unstaged.txt", {
    workingText,
  });

  assert.equal(versions.source, "markers");
  assert.equal(versions.hasBase, true);
  assert.equal(versions.ours, "head\nour line\ntail\n");
  assert.equal(versions.base, "head\nbase line\ntail\n");
  assert.equal(versions.theirs, "head\ntheir line\ntail\n");
});

test("getConflictVersions reports source 'none' when nothing is usable", async () => {
  const versions = await ctx.conflict.getConflictVersions("clean.txt", {
    workingText: "just\nnormal\ntext\n",
  });
  assert.equal(versions.source, "none");
  assert.equal(versions.hasBase, false);
  assert.equal(versions.ours, "");
  assert.equal(versions.theirs, "");
});
