import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { removeTempRepo } from "./tmpRepo";

// Stashing a SELECTION rather than the whole tree. Two things make this worth
// real-git tests rather than argument-shape ones: git's emptiness reporting is
// scoped by the pathspec, and one option combination silently corrupts state.

let repo: string;
let ctx: GitContext;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

const write = (name: string, body: string): void => writeFileSync(join(repo, name), body);
const read = (name: string): string => readFileSync(join(repo, name), "utf8");
const stashCount = (): number =>
  git("stash", "list").split("\n").filter(Boolean).length;

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-stashpaths-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  write("one.txt", "a\n");
  write("two.txt", "b\n");
  write("three.txt", "c\n");
  git("add", ".");
  git("commit", "-m", "base");
  ctx = new GitContext({ root: repo });
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

test("stashing a selection takes those files and leaves the rest alone", async () => {
  write("one.txt", "a2\n");
  write("two.txt", "b2\n");
  write("three.txt", "c2\n");

  const r = await ctx.stashes.save({ paths: ["one.txt", "three.txt"], message: "sel" });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(r.created, true);

  assert.equal(read("one.txt"), "a\n", "selected file reverted");
  assert.equal(read("three.txt"), "c\n", "selected file reverted");
  assert.equal(read("two.txt"), "b2\n", "unselected file untouched");
  assert.equal(stashCount(), 1);
});

test("THE TRAP: a selection with no changes reports created:false, not success", async () => {
  // The whole tree is dirty, but the SELECTED file is not. Asking the unscoped
  // question would see the dirty tree, say "there is something to stash", and
  // report a stash that git declined to make — telling the user their work is
  // put away while it sits in the working tree.
  write("one.txt", "a2\n");

  const r = await ctx.stashes.save({ paths: ["two.txt"], message: "nothing here" });
  assert.equal(r.ok, true, "git exits 0 — that is the trap");
  assert.equal(r.created, false, "but nothing was stashed");
  assert.equal(r.blocker, "cleanTree");
  assert.equal(stashCount(), 0);
  assert.equal(read("one.txt"), "a2\n", "and the dirty file was not touched");
});

test("staged-only stashing takes the index and leaves unstaged work", async () => {
  write("one.txt", "a2\n");
  git("add", "one.txt");
  write("two.txt", "b2\n"); // unstaged

  const r = await ctx.stashes.save({ stagedOnly: true, message: "staged" });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(r.created, true);

  assert.equal(read("one.txt"), "a\n", "the staged change was taken");
  assert.equal(read("two.txt"), "b2\n", "unstaged work stays");
  assert.equal(git("diff", "--cached", "--name-only").trim(), "", "index is clean");
});

test("staged-only with nothing staged does not claim a stash", async () => {
  write("one.txt", "a2\n"); // unstaged only

  const r = await ctx.stashes.save({ stagedOnly: true });
  assert.equal(r.ok, true);
  assert.equal(r.created, false, "there was nothing IN THE INDEX to stash");
  assert.equal(r.blocker, "cleanTree");
  assert.equal(stashCount(), 0);
  assert.equal(read("one.txt"), "a2\n");
});

test("staged-only plus a selection is REFUSED, because git corrupts state", async () => {
  // `git stash push --staged -- <path>` ignores the pathspec: the stash gets
  // every staged change, and files outside the pathspec keep their index entry
  // while their working tree is reverted — MM in status, working copy of
  // unselected work thrown away, exit 0, no warning. Verified on git 2.49.
  write("one.txt", "a2\n");
  write("two.txt", "b2\n");
  git("add", ".");

  const r = await ctx.stashes.save({ stagedOnly: true, paths: ["one.txt"] });
  assert.equal(r.ok, false, "refused rather than passed through");
  assert.match(r.stderr, /not supported by git/i);

  // Nothing happened: no stash, and both files are exactly as they were.
  assert.equal(stashCount(), 0);
  assert.equal(read("one.txt"), "a2\n");
  assert.equal(read("two.txt"), "b2\n");
  assert.equal(git("diff", "--cached", "--name-only").split("\n").filter(Boolean).length, 2);
});

test("an untracked file in the selection needs includeUntracked, and says so", async () => {
  write("brand-new.txt", "fresh\n");

  const without = await ctx.stashes.save({ paths: ["brand-new.txt"] });
  assert.equal(without.created, false);
  assert.equal(without.blocker, "untrackedOnly", "scoped to the selection, not the tree");

  const with_ = await ctx.stashes.save({
    paths: ["brand-new.txt"],
    includeUntracked: true,
  });
  assert.equal(with_.created, true, with_.stderr);
  assert.equal(stashCount(), 1);
});

test("a path inside a directory selection is stashed", async () => {
  execFileSync("mkdir", ["-p", join(repo, "src")]);
  write("src/deep.txt", "d\n");
  git("add", "src/deep.txt");
  git("commit", "-m", "add src");
  write("src/deep.txt", "d2\n");
  write("one.txt", "a2\n");

  const r = await ctx.stashes.save({ paths: ["src"], message: "dir" });
  assert.equal(r.created, true, r.stderr);
  assert.equal(read("src/deep.txt"), "d\n");
  assert.equal(read("one.txt"), "a2\n", "outside the directory, untouched");
});

test("an empty paths array means the whole tree, not nothing", async () => {
  write("one.txt", "a2\n");
  write("two.txt", "b2\n");

  const r = await ctx.stashes.save({ paths: [], message: "all" });
  assert.equal(r.created, true, r.stderr);
  assert.equal(read("one.txt"), "a\n");
  assert.equal(read("two.txt"), "b\n");
});
