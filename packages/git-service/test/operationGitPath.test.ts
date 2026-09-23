import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { GitContext } from "../src/GitContext";
import { removeTempRepo } from "./tmpRepo";

// `OperationProvider.gitPath` is the one worktree-safe way every consumer finds
// git's operation files (MERGE_HEAD, rebase-merge/, rebase-apply/applying, …).
// Inside a LINKED worktree `git rev-parse --git-path` answers with an ABSOLUTE
// path under the main repository's .git/worktrees/<name>/, and joining that
// onto the worktree root produced a path that cannot exist — which is how
// both extensions' operation watchers went blind in worktrees while the
// desktop (which resolves) did not.

let dir: string;
let repo: string;
let wt: string;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

before(() => {
  dir = mkdtempSync(join(tmpdir(), "gitstudio-gitpath-"));
  repo = join(dir, "main");
  wt = join(dir, "linked");
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git(repo, "config", "user.email", "dev@example.com");
  git(repo, "config", "user.name", "Dev");
  git(repo, "config", "core.autocrlf", "false");
  writeFileSync(join(repo, "f.txt"), "one\ntwo\nthree\n");
  git(repo, "add", "f.txt");
  git(repo, "commit", "-m", "base");
  git(repo, "branch", "other");
  git(repo, "worktree", "add", "-b", "feature", wt);
  // A real conflict in the LINKED worktree, so MERGE_HEAD exists only there.
  writeFileSync(join(wt, "f.txt"), "one\nTWO-feature\nthree\n");
  git(wt, "commit", "-am", "feature edit");
  git(repo, "checkout", "other");
  writeFileSync(join(repo, "f.txt"), "one\nTWO-other\nthree\n");
  git(repo, "commit", "-am", "other edit");
  git(repo, "checkout", "main");
  try {
    git(wt, "merge", "other");
  } catch {
    // Expected: the merge stops on the conflict.
  }
});

after(() => {
  removeTempRepo(dir);
});

test("gitPath finds a linked worktree's MERGE_HEAD (absolute git answer is resolved, not joined)", async () => {
  const ctx = new GitContext({ root: wt });
  try {
    const p = await ctx.operation.gitPath("MERGE_HEAD");
    assert.ok(isAbsolute(p), p);
    assert.match(p.replace(/\\/g, "/"), /\/\.git\/worktrees\/linked\/MERGE_HEAD$/);
    assert.ok(existsSync(p), `expected the in-progress merge's MERGE_HEAD at ${p}`);
  } finally {
    ctx.dispose();
  }
});

test("gitPath in the main worktree resolves git's relative answer against the root", async () => {
  const ctx = new GitContext({ root: repo });
  try {
    assert.equal(await ctx.operation.gitPath("index"), join(repo, ".git", "index"));
    // The main worktree has no merge in progress; its MERGE_HEAD path is still answered.
    assert.equal(existsSync(await ctx.operation.gitPath("MERGE_HEAD")), false);
  } finally {
    ctx.dispose();
  }
});

test("the linked worktree's merge is detected, named and listed there — and only there", async () => {
  // Detection goes through the same --git-path rule, so an operation inside a
  // linked worktree is visible from it (and the main worktree stays clean).
  const linked = new GitContext({ root: wt });
  const main = new GitContext({ root: repo });
  try {
    const d = await linked.operation.detect();
    assert.deepEqual(d, { kind: "merge", unmerged: 1 });
    const v = await linked.operation.view();
    assert.equal(v.kind, "merge");
    assert.equal(v.yours.name, "feature");
    assert.equal(v.theirs.name, "other");
    assert.equal(v.title, "Merging other into feature");
    const snap = await linked.conflictOps.snapshot({ op: v });
    assert.deepEqual(snap.files.map((f) => f.path), ["f.txt"]);
    assert.equal((await main.operation.view()).kind, "none");
    assert.equal((await main.operation.detect()).unmerged, 0);
  } finally {
    linked.dispose();
    main.dispose();
  }
});

test("gitPath rejects outside a repository instead of inventing a path", async () => {
  const ctx = new GitContext({ root: dir });
  try {
    await assert.rejects(ctx.operation.gitPath("MERGE_HEAD"));
  } finally {
    ctx.dispose();
  }
});
