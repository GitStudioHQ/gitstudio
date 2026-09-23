// "Ahead AND behind" has two causes, and they need opposite answers.
//
//   · WE rewrote the tip the remote still has — amended a pushed commit, or
//     reworded it in an interactive rebase. Pulling brings the old version
//     back; the answer is a force push.
//   · THEY moved on — somebody else pushed. The answer is merge or rebase, and
//     a force push deletes their work.
//
// The extension's status-bar Sync treated every divergence as the first. It
// fetched, saw ahead AND behind, said "This branch was rewritten — amending a
// pushed commit does this", and offered "Force push — uses --force-with-lease,
// which still refuses if someone else pushed". It does not refuse: Sync had
// JUST fetched, so the lease (the remote-tracking ref) matched the remote
// exactly. Replayed against a real repository where a colleague had pushed two
// commits: accepting the offer removed both from the remote.
//
// `rewroteUpstream` tells the two apart by what an amend and a rebase keep and
// a colleague's commit does not: the AUTHOR and the AUTHOR DATE. Every commit
// only the upstream has must reappear, by that identity, among the commits
// only we have. One the remote has that we did not rewrite — somebody else's —
// and it is a divergence.

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

function git(cwd: string, args: string[], env: Record<string, string> = {}): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", ...env },
  });
}

function identify(dir: string, name: string, email: string): void {
  git(dir, ["config", "user.name", name]);
  git(dir, ["config", "user.email", email]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "gc.auto", "0"]);
}

/** A commit with a fixed author date, so "same author date" is a fact the test
 *  controls rather than a race against the clock. */
function commitAt(cwd: string, file: string, content: string, msg: string, when: string): void {
  writeFileSync(join(cwd, file), content);
  git(cwd, ["add", file]);
  git(cwd, ["commit", "-q", "-m", msg], { GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when });
}

/** Me with a clone and two pushed commits; a colleague with a clone of their own. */
function pushedWork(): { mine: string; theirs: string; ctx: GitContext } {
  const bare = mkdtempSync(join(tmpdir(), "gitstudio-rewrite-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const mine = mkdtempSync(join(tmpdir(), "gitstudio-rewrite-mine-"));
  execFileSync("git", ["clone", "-q", bare, mine]);
  identify(mine, "Me", "me@example.com");
  commitAt(mine, "base.txt", "base\n", "base", "1700000000 +0000");
  commitAt(mine, "a.txt", "a\n", "first of mine", "1700000100 +0000");
  commitAt(mine, "b.txt", "b\n", "second of mine", "1700000200 +0000");
  git(mine, ["push", "-q", "-u", "origin", "main"]);
  const theirs = mkdtempSync(join(tmpdir(), "gitstudio-rewrite-theirs-"));
  execFileSync("git", ["clone", "-q", bare, theirs]);
  identify(theirs, "Colleague", "colleague@example.com");
  trash.push(bare, mine, theirs);
  const ctx = new GitContext({ root: mine });
  contexts.push(ctx);
  return { mine, theirs, ctx };
}

test("amending a pushed commit is a rewrite", async () => {
  const { mine, ctx } = pushedWork();
  git(mine, ["commit", "-q", "--amend", "-m", "second of mine, reworded"]);
  const ab = await ctx.sync.aheadBehind();
  assert.deepEqual([ab.ahead, ab.behind], [1, 1], "precondition: ahead AND behind");
  assert.equal(await ctx.sync.rewroteUpstream(), true);
});

test("rewording two pushed commits in a rebase is a rewrite", async () => {
  const { mine, ctx } = pushedWork();
  // An interactive reword, done non-interactively: reset and re-commit both
  // with their original author dates, as `rebase -i` keeps them.
  git(mine, ["reset", "-q", "--hard", "HEAD~2"]);
  commitAt(mine, "a.txt", "a\n", "first, reworded", "1700000100 +0000");
  commitAt(mine, "b.txt", "b\n", "second, reworded", "1700000200 +0000");
  const ab = await ctx.sync.aheadBehind();
  assert.deepEqual([ab.ahead, ab.behind], [2, 2], "precondition: ahead AND behind");
  assert.equal(await ctx.sync.rewroteUpstream(), true);
});

test("somebody else pushing is NOT a rewrite, however it looks from here", async () => {
  const { mine, theirs, ctx } = pushedWork();
  commitAt(theirs, "c.txt", "c\n", "theirs", "1700000300 +0000");
  git(theirs, ["push", "-q", "origin", "main"]);
  commitAt(mine, "d.txt", "d\n", "mine, new", "1700000400 +0000");
  git(mine, ["fetch", "-q"]);
  const ab = await ctx.sync.aheadBehind();
  assert.deepEqual([ab.ahead, ab.behind], [1, 1], "precondition: ahead AND behind");
  assert.equal(await ctx.sync.rewroteUpstream(), false);
});

test("an amend AND a colleague's push on top of the old commit is not a rewrite", async () => {
  // The force push would delete the colleague's commit along with the old one.
  const { mine, theirs, ctx } = pushedWork();
  commitAt(theirs, "c.txt", "c\n", "theirs, on top", "1700000300 +0000");
  git(theirs, ["push", "-q", "origin", "main"]);
  git(mine, ["commit", "-q", "--amend", "-m", "second of mine, reworded"]);
  git(mine, ["fetch", "-q"]);
  const ab = await ctx.sync.aheadBehind();
  assert.deepEqual([ab.ahead, ab.behind], [1, 2], "precondition: ahead AND behind");
  assert.equal(await ctx.sync.rewroteUpstream(), false);
});

test("nothing to compare is not a rewrite", async () => {
  const { ctx } = pushedWork();
  assert.equal(await ctx.sync.rewroteUpstream(), false, "in sync");
});
