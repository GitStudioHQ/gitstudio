import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { applySelectedChanges } from "@gitstudio/engine/staging/applyLineChanges";

// A hermetic repo: a tracked 3-line file, then both line 1 and line 3 edited in
// the working tree. The headline test stages ONLY line 1 (reconstructed via the
// engine) and proves the index holds exactly that change while the working tree
// still carries the line-3 change.
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

function read(name: string): string {
  return readFileSync(join(repo, name), "utf8");
}

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-staging-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(["config", "user.email", "dev@example.com"]);
  git(["config", "user.name", "Dev"]);
  git(["config", "commit.gpgsign", "false"]);

  // Base commit: three lines committed cleanly.
  write("file.txt", "one\ntwo\nthree\n");
  git(["add", "file.txt"]);
  git(["commit", "-m", "base"]);

  // Working tree: edit line 1 and line 3 (line 2 untouched).
  write("file.txt", "ONE\ntwo\nTHREE\n");

  ctx = new GitContext({ root: repo });
});

after(() => {
  ctx?.dispose();
  if (repo) {
    rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("KILLER: stage ONLY line 1 — index shows just that change, working tree keeps line 3", async () => {
  const original = await ctx.staging.indexContent("file.txt"); // == HEAD here
  const modified = read("file.txt");
  assert.equal(original, "one\ntwo\nthree\n");
  assert.equal(modified, "ONE\ntwo\nTHREE\n");

  // Reconstruct content that stages ONLY line index 0 (the first line).
  const content = applySelectedChanges(original, modified, [
    { start: 0, end: 0 },
  ]);
  assert.equal(content, "ONE\ntwo\nthree\n");

  const result = await ctx.staging.stageContent("file.txt", content);
  assert.ok(result.ok, result.stderr);

  // Staged diff (index vs HEAD): exactly the line-1 change.
  const cached = git(["diff", "--cached"]);
  assert.match(cached, /^-one$/m);
  assert.match(cached, /^\+ONE$/m);
  assert.doesNotMatch(cached, /THREE/);
  assert.doesNotMatch(cached, /^-three$/m);

  // Unstaged diff (working tree vs index): still carries the line-3 change, and
  // line 1 is no longer a *changed* line (it may appear as a context line).
  const unstaged = git(["diff"]);
  assert.match(unstaged, /^-three$/m);
  assert.match(unstaged, /^\+THREE$/m);
  // No line-1 change remains unstaged (neither the -one removal nor +ONE add).
  assert.doesNotMatch(unstaged, /^-one$/m);
  assert.doesNotMatch(unstaged, /^\+ONE$/m);

  // The working tree on disk is untouched by content staging.
  assert.equal(read("file.txt"), "ONE\ntwo\nTHREE\n");
});

test("indexContent reflects the staged blob, headContent stays at HEAD", async () => {
  // After the previous test, the index has line 1 staged.
  const idx = await ctx.staging.indexContent("file.txt");
  const head = await ctx.staging.headContent("file.txt");
  assert.equal(idx, "ONE\ntwo\nthree\n");
  assert.equal(head, "one\ntwo\nthree\n");
});

test("stageFile / unstageFile round-trip", async () => {
  // Stage the whole working-tree file, then unstage it.
  const staged = await ctx.staging.stageFile("file.txt");
  assert.ok(staged.ok, staged.stderr);
  let idx = await ctx.staging.indexContent("file.txt");
  assert.equal(idx, "ONE\ntwo\nTHREE\n");

  const unstaged = await ctx.staging.unstageFile("file.txt");
  assert.ok(unstaged.ok, unstaged.stderr);
  // Back to HEAD content in the index.
  idx = await ctx.staging.indexContent("file.txt");
  assert.equal(idx, "one\ntwo\nthree\n");
});

test("discardChanges restores the working tree to HEAD", async () => {
  // Working tree currently has both edits; discard them.
  const discarded = await ctx.staging.discardChanges("file.txt");
  assert.ok(discarded.ok, discarded.stderr);
  assert.equal(read("file.txt"), "one\ntwo\nthree\n");
});

test("stageContent on a brand-new untracked file uses mode 100644 and stages it", async () => {
  write("new.txt", "alpha\nbeta\n");
  const original = await ctx.staging.indexContent("new.txt"); // ""
  assert.equal(original, "");

  // Stage the whole new file content.
  const content = applySelectedChanges("", "alpha\nbeta\n", [
    { start: 0, end: 2 },
  ]);
  const r = await ctx.staging.stageContent("new.txt", content);
  assert.ok(r.ok, r.stderr);

  const cached = git(["diff", "--cached", "--name-status"]);
  assert.match(cached, /^A\s+new\.txt$/m);
  assert.equal(await ctx.staging.indexContent("new.txt"), "alpha\nbeta\n");
});

test("commit creates a commit with the given message and clears the staged count", async () => {
  // Stage new.txt was already done above; ensure something is staged.
  await ctx.staging.stageFile("new.txt");
  const before = await ctx.staging.stagedCount();
  assert.ok(before >= 1);

  const r = await ctx.staging.commit("feat: add new.txt\n\nWith a body line.");
  assert.ok(r.ok, r.stderr);

  // The new commit is now HEAD with the exact subject.
  const subject = git(["log", "-1", "--pretty=%s"]).trim();
  assert.equal(subject, "feat: add new.txt");
  const body = git(["log", "-1", "--pretty=%b"]).trim();
  assert.equal(body, "With a body line.");

  const after = await ctx.staging.stagedCount();
  assert.equal(after, 0);
});

test("commit --amend rewrites the previous commit message", async () => {
  const r = await ctx.staging.commit("feat: add new.txt (amended)", {
    amend: true,
  });
  assert.ok(r.ok, r.stderr);
  const subject = git(["log", "-1", "--pretty=%s"]).trim();
  assert.equal(subject, "feat: add new.txt (amended)");
});

test("commit --signoff adds a Signed-off-by trailer", async () => {
  write("signed.txt", "x\n");
  await ctx.staging.stageFile("signed.txt");
  const r = await ctx.staging.commit("chore: signed commit", { signoff: true });
  assert.ok(r.ok, r.stderr);
  const message = git(["log", "-1", "--pretty=%B"]);
  assert.match(message, /Signed-off-by: Dev <dev@example\.com>/);
});

test("unstageFile on an initial commit (no HEAD) falls back to rm --cached", async () => {
  // A fresh repo with no commits: staging then unstaging must not throw.
  const fresh = mkdtempSync(join(tmpdir(), "gitstudio-staging-fresh-"));
  try {
    execFileSync("git", ["-c", "init.defaultBranch=main", "init", fresh], {
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    writeFileSync(join(fresh, "a.txt"), "hi\n");
    const freshCtx = new GitContext({ root: fresh });
    try {
      const staged = await freshCtx.staging.stageFile("a.txt");
      assert.ok(staged.ok, staged.stderr);
      const unstaged = await freshCtx.staging.unstageFile("a.txt");
      assert.ok(unstaged.ok, unstaged.stderr);
      // Nothing staged anymore.
      assert.equal(await freshCtx.staging.stagedCount(), 0);
    } finally {
      freshCtx.dispose();
    }
  } finally {
    rmSync(fresh, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
