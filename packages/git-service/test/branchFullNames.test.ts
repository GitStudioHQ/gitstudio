import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { branchNameOf, remoteBranchOf } from "../src/BranchOps";
import { removeTempRepo } from "./tmpRepo";

// The branch actions (#30's follow-up) take FULL names — never
// %(refname:short), which beside a tag of the same name is "heads/release".
// Handed to git that either names nothing (`git branch -m heads/release`:
// "no branch named 'heads/release'"), or the right ref under the wrong words
// (`git merge heads/release` records "Merge branch 'heads/release'"), while
// the bare "release" is the TAG. Every case here runs real git on a repository
// where a branch and a tag share a name and point at different commits, so
// which commit moved says which ref git resolved.

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function commit(dir: string, file: string, text: string, msg: string): string {
  writeFileSync(join(dir, file), text);
  git(dir, "add", file);
  git(dir, "commit", "-qm", msg);
  return git(dir, "rev-parse", "HEAD").trim();
}

/**
 * main ── base ── m1                 (main, checked out)
 *            └── r1                   (branch "release", and origin/release)
 * tag "release" on base — the bare name "release" is the TAG, which main
 * already contains, so merging it is "Already up to date".
 */
function collidingRepo(): { dir: string; upstream: string; base: string; releaseTip: string } {
  const upstream = mkdtempSync(join(tmpdir(), "gs-bfn-up-"));
  git(upstream, "init", "-q", "--bare", "-b", "main");
  const dir = mkdtempSync(join(tmpdir(), "gs-bfn-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t.t");
  git(dir, "config", "user.name", "T");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "remote", "add", "origin", upstream);
  const base = commit(dir, "base.txt", "base\n", "base");
  git(dir, "tag", "release");
  git(dir, "checkout", "-q", "-b", "release");
  const releaseTip = commit(dir, "r.txt", "release work\n", "release work");
  git(dir, "push", "-q", "origin", "refs/heads/release:refs/heads/release");
  git(dir, "fetch", "-q", "origin");
  git(dir, "checkout", "-q", "main");
  commit(dir, "m.txt", "main work\n", "main work");
  return { dir, upstream, base, releaseTip };
}

const subject = (dir: string): string => git(dir, "log", "-1", "--format=%s").trim();
const parents = (dir: string): string[] => git(dir, "log", "-1", "--format=%P").trim().split(" ");
const exists = (dir: string, ref: string): boolean => {
  try {
    git(dir, "rev-parse", "--verify", "--quiet", ref);
    return true;
  } catch {
    return false;
  }
};

test("the repository really is ambiguous: git's short name for the branch is heads/release", () => {
  const { dir, upstream } = collidingRepo();
  try {
    assert.equal(git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads/release").trim(), "heads/release");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("merging a branch by its full name merges the BRANCH and records \"Merge branch 'release'\"", async () => {
  const { dir, upstream, releaseTip } = collidingRepo();
  try {
    const ctx = new GitContext({ root: dir });
    const r = await ctx.branches.merge("refs/heads/release");
    assert.equal(r.ok, true, r.stderr);
    assert.ok(parents(dir).includes(releaseTip), "the branch tip is a parent — the tag would have been up to date");
    assert.equal(subject(dir), "Merge branch 'release'");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("off the default branch the message says where it went, as git's own does", async () => {
  const { dir, upstream } = collidingRepo();
  try {
    git(dir, "checkout", "-q", "-b", "feature");
    const ctx = new GitContext({ root: dir });
    const r = await ctx.branches.merge("refs/heads/release");
    assert.equal(r.ok, true, r.stderr);
    assert.equal(subject(dir), "Merge branch 'release' into feature");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("merge.log writes its shortlog once, under the branch's own name", async () => {
  const { dir, upstream } = collidingRepo();
  try {
    git(dir, "config", "merge.log", "true");
    const ctx = new GitContext({ root: dir });
    const r = await ctx.branches.merge("refs/heads/release");
    assert.equal(r.ok, true, r.stderr);
    const body = git(dir, "log", "-1", "--format=%B");
    assert.match(body, /^Merge branch 'release'\n\n\* release:\n {2}release work\n/);
    assert.equal(body.match(/release work/g)?.length, 1, "one shortlog, not fmt-merge-msg's plus git merge's");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("a remote-tracking branch merges as one, by its full name", async () => {
  const { dir, upstream, releaseTip } = collidingRepo();
  try {
    const ctx = new GitContext({ root: dir });
    const r = await ctx.branches.merge("refs/remotes/origin/release", { noFf: true });
    assert.equal(r.ok, true, r.stderr);
    assert.ok(parents(dir).includes(releaseTip));
    assert.equal(subject(dir), "Merge remote-tracking branch 'origin/release'");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("a conflicted merge leaves the right message waiting in MERGE_MSG", async () => {
  const { dir, upstream } = collidingRepo();
  try {
    // Both sides edit r.txt so the merge stops.
    commit(dir, "r.txt", "main's version\n", "main edits r");
    const ctx = new GitContext({ root: dir });
    const r = await ctx.branches.merge("refs/heads/release");
    assert.equal(r.ok, false, "it stops on the conflict");
    const msg = git(dir, "rev-parse", "--git-path", "MERGE_MSG").trim();
    const text = execFileSync("cat", [join(dir, msg)], { encoding: "utf8" });
    assert.match(text, /^Merge branch 'release'\n/);
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("rebasing onto a branch by its full name rebases onto the BRANCH, not the tag", async () => {
  const { dir, upstream, releaseTip } = collidingRepo();
  try {
    const ctx = new GitContext({ root: dir });
    const r = await ctx.branches.rebaseOnto("refs/heads/release");
    assert.equal(r.ok, true, r.stderr);
    assert.equal(git(dir, "rev-parse", "HEAD~1").trim(), releaseTip, "main now sits on release's tip");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("rename, delete and set-upstream take the name under refs/heads/ — the tag is never touched", async () => {
  const { dir, upstream, base } = collidingRepo();
  try {
    const ctx = new GitContext({ root: dir });
    const name = branchNameOf("refs/heads/release");
    assert.equal(name, "release");
    const up = await ctx.branches.setUpstream(name!, "refs/remotes/origin/release");
    assert.equal(up.ok, true, up.stderr);
    assert.deepEqual(await ctx.branches.upstreamOf("release"), { remote: "origin", branch: "release" });
    const mv = await ctx.branches.rename(name!, "release-2");
    assert.equal(mv.ok, true, mv.stderr);
    assert.equal(exists(dir, "refs/heads/release-2"), true);
    assert.equal(exists(dir, "refs/heads/release"), false);
    const del = await ctx.branches.delete("release-2", { force: true });
    assert.equal(del.ok, true, del.stderr);
    assert.equal(exists(dir, "refs/heads/release-2"), false);
    assert.equal(git(dir, "rev-parse", "refs/tags/release").trim(), base, "the tag of the same name is where it was");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("git's short name is what broke them: heads/release names no branch to rename or delete", async () => {
  // Pinned as git's behaviour, so the doors cannot drift back to the short name.
  const { dir, upstream } = collidingRepo();
  try {
    const ctx = new GitContext({ root: dir });
    assert.equal((await ctx.branches.rename("heads/release", "x")).ok, false);
    assert.equal((await ctx.branches.delete("heads/release", { force: true })).ok, false);
    assert.equal(exists(dir, "refs/heads/release"), true);
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("a branch named like an option is renamed and deleted as a NAME, after --", async () => {
  const { dir, upstream } = collidingRepo();
  try {
    git(dir, "update-ref", "refs/heads/-f", "HEAD");
    git(dir, "update-ref", "refs/heads/-x", "HEAD");
    writeFileSync(join(dir, "m.txt"), "uncommitted\n");
    const ctx = new GitContext({ root: dir });
    const up = await ctx.branches.setUpstream("-f", "refs/remotes/origin/release");
    assert.equal(up.ok, true, up.stderr);
    assert.deepEqual(await ctx.branches.upstreamOf("-f"), { remote: "origin", branch: "release" });
    const mv = await ctx.branches.rename("-f", "fixed-f");
    assert.equal(mv.ok, true, mv.stderr);
    assert.equal(exists(dir, "refs/heads/fixed-f"), true);
    assert.equal(exists(dir, "refs/heads/-f"), false);
    const del = await ctx.branches.delete("-x", { force: true });
    assert.equal(del.ok, true, del.stderr);
    assert.equal(exists(dir, "refs/heads/-x"), false);
    assert.equal(execFileSync("cat", [join(dir, "m.txt")], { encoding: "utf8" }), "uncommitted\n", "nothing was read as a flag");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("deleting a remote branch deletes the BRANCH on the remote, beside a tag of the same name there", async () => {
  const { dir, upstream } = collidingRepo();
  try {
    git(dir, "push", "-q", "origin", "refs/tags/release:refs/tags/release");
    const ctx = new GitContext({ root: dir });
    const pair = remoteBranchOf("refs/remotes/origin/release");
    assert.deepEqual(pair, { remote: "origin", branch: "release" });
    const r = await ctx.branches.deleteRemoteBranch(pair!.remote, pair!.branch);
    assert.equal(r.ok, true, r.stderr);
    assert.equal(exists(upstream, "refs/heads/release"), false, "the branch is gone on the remote");
    assert.equal(exists(upstream, "refs/tags/release"), true, "and its tag is not");
  } finally {
    removeTempRepo(dir);
    removeTempRepo(upstream);
  }
});

test("branchNameOf and remoteBranchOf read only their own namespace", () => {
  assert.equal(branchNameOf("refs/heads/heads/x"), "heads/x", "a branch really called heads/x keeps it");
  assert.equal(branchNameOf("refs/remotes/origin/x"), undefined);
  assert.equal(branchNameOf("heads/x"), undefined);
  assert.equal(branchNameOf("refs/heads/"), undefined);
  assert.deepEqual(remoteBranchOf("refs/remotes/origin/feature/x"), { remote: "origin", branch: "feature/x" });
  assert.equal(remoteBranchOf("refs/remotes/origin"), undefined);
  assert.equal(remoteBranchOf("refs/heads/x"), undefined);
});
