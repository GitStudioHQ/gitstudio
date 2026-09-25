// Index writes to one repository run one at a time.
//
// The Changes view stages a multi-selection, the selection bar's Stage, and a
// few quick "+" clicks as SEPARATE calls, and they arrive together. Each is a
// `git add` (or reset, checkout, update-index) that takes .git/index.lock, and
// the second of two concurrent ones is refused with "Unable to create
// '.git/index.lock': File exists". Measured before this queue existed: 42 of 60
// such calls failed on a 400-file repository, and often only one file of six
// ended up staged — with nothing said, because the view never read the result.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { removeTempRepo } from "./tmpRepo";

const dirs: string[] = [];
after(() => dirs.forEach(removeTempRepo));

/** A repository with a realistically sized index, so each write holds the lock for a moment. */
function repoWith(files: number): { dir: string; git: (...a: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "gs-index-queue-"));
  dirs.push(dir);
  const git = (...a: string[]): string => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "a@example.com");
  git("config", "user.name", "A");
  git("config", "commit.gpgsign", "false");
  git("config", "gc.auto", "0");
  for (let i = 0; i < 400; i++) writeFileSync(join(dir, `seed${i}.txt`), `seed ${i}\n`.repeat(50));
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}.txt`), "a\n");
  git("add", ".");
  git("commit", "-qm", "init");
  for (let i = 0; i < files; i++) writeFileSync(join(dir, `f${i}.txt`), "b\n");
  return { dir, git };
}

const stagedNames = (git: (...a: string[]) => string): string[] =>
  git("diff", "--cached", "--name-only").split("\n").filter(Boolean).sort();

test("ten concurrent stageFile calls all succeed, and all ten files are staged", async () => {
  for (let trial = 0; trial < 3; trial++) {
    const { dir, git } = repoWith(10);
    const ctx = new GitContext({ root: dir });
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => ctx.staging.stageFile(`f${i}.txt`)),
    );
    ctx.dispose();
    assert.deepEqual(
      results.filter((r) => !r.ok).map((r) => r.stderr.trim()),
      [],
      `trial ${trial}: every git add succeeds`,
    );
    assert.equal(stagedNames(git).length, 10, `trial ${trial}: every file is staged`);
  }
});

test("two GitContexts over the same repository share the one queue", async () => {
  // The extension builds more than one context per root (RepoManager, the
  // merge experience's locator), so a per-instance queue would not be enough.
  const { dir, git } = repoWith(8);
  const a = new GitContext({ root: dir });
  const b = new GitContext({ root: dir });
  const results = await Promise.all(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).staging.stageFile(`f${i}.txt`)),
  );
  a.dispose();
  b.dispose();
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.stderr.trim()), []);
  assert.equal(stagedNames(git).length, 8);
});

test("stage, unstage and discard issued together each do their own work", async () => {
  const { dir, git } = repoWith(6);
  git("add", "f4.txt", "f5.txt");
  const ctx = new GitContext({ root: dir });
  const results = await Promise.all([
    ctx.staging.stageFile("f0.txt"),
    ctx.staging.stageFiles(["f1.txt", "f2.txt"]),
    ctx.staging.unstageFile("f4.txt"),
    ctx.staging.unstageFiles(["f5.txt"]),
    ctx.staging.discardChanges("f3.txt"),
  ]);
  ctx.dispose();
  assert.deepEqual(results.filter((r) => !r.ok).map((r) => r.stderr.trim()), []);
  assert.deepEqual(stagedNames(git), ["f0.txt", "f1.txt", "f2.txt"]);
  assert.equal(git("status", "--porcelain", "--", "f3.txt"), "", "f3 is back to its committed text");
});

test("a lock held for a moment by another git (vscode.git's own status) is waited out", async () => {
  const { dir, git } = repoWith(1);
  const lock = join(dir, ".git", "index.lock");
  writeFileSync(lock, "");
  setTimeout(() => unlinkSync(lock), 250);
  const ctx = new GitContext({ root: dir });
  const r = await ctx.staging.stageFile("f0.txt");
  ctx.dispose();
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(stagedNames(git), ["f0.txt"]);
});

test("a lock nobody releases still fails, with git's own words", async () => {
  const { dir } = repoWith(1);
  const lock = join(dir, ".git", "index.lock");
  writeFileSync(lock, "");
  const ctx = new GitContext({ root: dir });
  const r = await ctx.staging.stageFile("f0.txt");
  ctx.dispose();
  if (existsSync(lock)) unlinkSync(lock);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /index\.lock/);
});
