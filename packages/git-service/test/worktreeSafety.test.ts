// The worktree plumbing both products remove, lock and add through — pinned
// against real git, cell by cell, for the cases the Worktrees audit found
// broken: a LOCKED worktree git refuses to remove with one --force, an add
// whose -b branch outlived the add that failed, and a remove whose question
// could not say what it would delete because nothing asked before git ran.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import { parseWorktreePorcelain } from "../src/WorktreeProvider";
import { removeTempRepo } from "./tmpRepo";

// os.tmpdir()'s own spelling (RUNNER~1 on a Windows runner, /var/… on macOS),
// never resolved: git names these folders by another, and removal() must
// find them by either.
const scratch = mkdtempSync(join(tmpdir(), "gitstudio-wt-safety-"));
const contexts: GitContext[] = [];
after(() => {
  for (const c of contexts) c.dispose();
  removeTempRepo(scratch);
});
let seq = 0;

function at(cwd: string) {
  return (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A main worktree on `main` with one commit, and a fresh GitContext on it. */
function repo(): { dir: string; git: (...a: string[]) => string; ctx: GitContext; base: string } {
  const base = join(scratch, `r${++seq}`);
  const dir = join(base, "app");
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", "-b", "main", dir]);
  const git = at(dir);
  for (const [k, v] of [["user.email", "t@example.com"], ["user.name", "T"], ["commit.gpgsign", "false"], ["gc.auto", "0"]]) {
    git("config", k, v);
  }
  writeFileSync(join(dir, "a.txt"), "a\n");
  git("add", ".");
  git("commit", "-qm", "base");
  const ctx = new GitContext({ root: dir });
  contexts.push(ctx);
  return { dir, git, ctx, base };
}

test("the porcelain's lock reason is kept, quoted or not; a bare `locked` has none", () => {
  const parsed = parseWorktreePorcelain(
    "worktree /r\nHEAD a\nbranch refs/heads/main\n\n" +
      "worktree /r/usb\nHEAD b\nbranch refs/heads/usb\nlocked on a USB drive\n\n" +
      "worktree /r/quoted\nHEAD c\nbranch refs/heads/q\nlocked \"agent \\\"7\\\"\\nline two \\303\\251\"\n\n" +
      "worktree /r/plain\nHEAD d\nbranch refs/heads/p\nlocked\n",
  );
  assert.equal(parsed[0].locked, undefined);
  assert.equal(parsed[1].locked, true);
  assert.equal(parsed[1].lockReason, "on a USB drive");
  assert.equal(parsed[2].lockReason, 'agent "7"\nline two é');
  assert.equal(parsed[3].locked, true);
  assert.equal(parsed[3].lockReason, undefined);
});

test("lock takes a reason, and list reads it back", async () => {
  const { base, git, ctx } = repo();
  const wt = join(base, "wt", "usb");
  git("worktree", "add", "-q", "-b", "usb", wt);
  const locked = await ctx.worktrees.lock(wt, { reason: "on a USB drive" });
  assert.ok(locked.ok, locked.stderr);
  const entry = (await ctx.worktrees.list()).find((e) => e.branch === "usb");
  assert.equal(entry?.locked, true);
  assert.equal(entry?.lockReason, "on a USB drive");
});

test("a locked worktree: one --force is refused, evenIfLocked removes it", async () => {
  const { base, git, ctx } = repo();
  const wt = join(base, "wt", "locked");
  git("worktree", "add", "-q", "-b", "locked", wt);
  git("worktree", "lock", "--reason", "on a USB drive", wt);

  const once = await ctx.worktrees.remove(wt, { force: true });
  assert.equal(once.ok, false, "git needs --force twice past a lock");
  assert.ok(existsSync(wt));

  const twice = await ctx.worktrees.remove(wt, { force: true, evenIfLocked: true });
  assert.ok(twice.ok, twice.stderr);
  assert.equal(existsSync(wt), false);
  assert.equal(git("rev-parse", "--verify", "refs/heads/locked").length, 40, "the branch stays");
});

test("removal() says what removing takes, before git runs", async () => {
  const { base, dir, git, ctx } = repo();
  const clean = join(base, "wt", "clean");
  const dirty = join(base, "wt", "dirty");
  const gone = join(base, "wt", "gone");
  const lockedGone = join(base, "wt", "locked-gone");
  git("worktree", "add", "-q", "-b", "clean", clean);
  git("worktree", "add", "-q", "-b", "dirty", dirty);
  git("worktree", "add", "-q", "-b", "gone", gone);
  git("worktree", "add", "-q", "-b", "locked-gone", lockedGone);
  git("worktree", "lock", "--reason", "agent 42", lockedGone);
  rmSync(gone, { recursive: true, force: true });
  rmSync(lockedGone, { recursive: true, force: true });
  // Staged, unstaged, untracked, renamed — and an ignored file, which git's
  // own check does not count.
  writeFileSync(join(dirty, "a.txt"), "changed\n");
  writeFileSync(join(dirty, "staged.txt"), "s\n");
  at(dirty)("add", "staged.txt");
  at(dirty)("mv", "a.txt", "moved.txt");
  writeFileSync(join(dirty, "new.txt"), "n\n");
  writeFileSync(join(dirty, ".gitignore"), "*.log\n");
  writeFileSync(join(dirty, "noise.log"), "x\n");

  const main = await ctx.worktrees.removal(dir);
  assert.equal(main.kind, "main");

  const c = await ctx.worktrees.removal(clean);
  assert.equal(c.kind, "present");
  assert.deepEqual(c.kind === "present" ? c.changes : undefined, []);

  const d = await ctx.worktrees.removal(dirty);
  assert.equal(d.kind, "present");
  assert.deepEqual(
    [...(d.kind === "present" ? (d.changes ?? []) : [])].sort(),
    [".gitignore", "moved.txt", "new.txt", "staged.txt"],
  );

  const g = await ctx.worktrees.removal(gone);
  assert.equal(g.kind, "missing");

  const lg = await ctx.worktrees.removal(lockedGone);
  assert.equal(lg.kind, "missing", "a locked worktree is never `prunable`, so the folder itself is asked");
  assert.equal(lg.kind === "missing" ? lg.entry.lockReason : undefined, "agent 42");

  assert.equal((await ctx.worktrees.removal(join(base, "nowhere"))).kind, "notListed");

  // And the forget itself: a missing folder goes with one plain remove, a
  // locked missing one only past the lock.
  assert.ok((await ctx.worktrees.remove(gone)).ok);
  assert.equal((await ctx.worktrees.remove(lockedGone)).ok, false);
  assert.ok((await ctx.worktrees.remove(lockedGone, { force: true, evenIfLocked: true })).ok);
  assert.deepEqual((await ctx.worktrees.list()).map((e) => e.branch), ["main", "clean", "dirty"]);
});

test("removal() finds a worktree whose folder is gone by any spelling of its folder — not only git's", async () => {
  // git names a worktree by the resolved path its folder had when it was
  // added: C:/Users/runneradmin/… on a Windows runner, where the same folder
  // was asked for as os.tmpdir()'s C:\Users\RUNNER~1\…; /private/var/… on
  // macOS beside tmpdir's /var/…. With the folder gone there is nothing to
  // resolve, and removal() answered "notListed" — a worktree git still has,
  // which Forget could then never let go. Here the other spelling is a link
  // to the repository's folder, which every system has.
  const { base, git, ctx } = repo();
  const gone = join(base, "wt", "gone");
  git("worktree", "add", "-q", "-b", "gone", gone);
  rmSync(gone, { recursive: true, force: true });
  const link = join(scratch, `link-r${seq}`);
  symlinkSync(base, link, "junction");
  const spelled = join(link, "wt", "gone");
  const r = await ctx.worktrees.removal(spelled);
  assert.equal(r.kind, "missing", spelled);
  assert.equal(r.kind === "missing" && r.entry.branch, "gone");
  assert.equal((await ctx.worktrees.removal(join(link, "wt", "never"))).kind, "notListed");
  // …and forgotten by the entry it found, which is git's own spelling — the
  // one both products hand git.
  assert.ok(r.kind === "missing" && (await ctx.worktrees.remove(r.entry.path)).ok);
  assert.deepEqual((await ctx.worktrees.list()).map((e) => e.branch), ["main"]);
});

test("an add -b that fails leaves no branch behind, so the retry works", async () => {
  const { base, git, ctx } = repo();
  const taken = join(base, "wt", "login");
  mkdirSync(taken, { recursive: true });
  writeFileSync(join(taken, "someone-elses.txt"), "x\n");

  const failed = await ctx.worktrees.add(taken, "bugfix/login", { newBranch: true });
  assert.equal(failed.ok, false);
  assert.equal(git("branch", "--list", "bugfix/login"), "", "the branch this add created is gone again");

  const retry = await ctx.worktrees.add(join(base, "wt", "bugfix-login"), "bugfix/login", { newBranch: true });
  assert.ok(retry.ok, retry.stderr);
});

test("an add -b that fails never deletes a branch that was there before it", async () => {
  const { base, git, ctx } = repo();
  git("branch", "keep");
  const before = git("rev-parse", "refs/heads/keep");
  const failed = await ctx.worktrees.add(join(base, "wt", "keep"), "keep", { newBranch: true });
  assert.equal(failed.ok, false);
  assert.equal(git("rev-parse", "refs/heads/keep"), before);
});

test("removeAsAgreed: past a lock without discarding, a change since the question is refused and the lock goes back", async () => {
  const { base, git, ctx } = repo();
  const wt = join(base, "wt", "agent");
  git("worktree", "add", "-q", "-b", "agent", wt);
  git("worktree", "lock", "--reason", "agent 7 (pid 42)", wt);

  // Asked while clean; the agent wrote a file before the answer ran.
  writeFileSync(join(wt, "late.txt"), "work\n");
  const refused = await ctx.worktrees.removeAsAgreed(wt, { pastLock: { reason: "agent 7 (pid 42)" } });
  assert.equal(refused.ok, false);
  assert.ok(existsSync(join(wt, "late.txt")), "nothing deleted");
  const entry = (await ctx.worktrees.list()).find((e) => e.branch === "agent");
  assert.equal(entry?.lockReason, "agent 7 (pid 42)", "locked again, with its reason");

  // Agreed with the change listed: it goes, lock and all.
  const removed = await ctx.worktrees.removeAsAgreed(wt, { discardChanges: { listed: ["late.txt"] }, pastLock: {} });
  assert.ok(removed.ok, removed.stderr);
  assert.equal(existsSync(wt), false);
});

test("removeAsAgreed: discarding what the question listed, a change it never listed stops it — nothing runs, nothing is deleted", async () => {
  const { base, git, ctx } = repo();
  // The owner's common case: a worktree an agent has locked, still at work,
  // so it already has changes when the question is asked.
  const wt = join(base, "wt", "agent");
  git("worktree", "add", "-q", "-b", "agent", wt);
  git("worktree", "lock", "--reason", "claude agent 7", wt);
  writeFileSync(join(wt, "a.txt"), "changed\n");
  writeFileSync(join(wt, "new.txt"), "n\n");
  const asked = await ctx.worktrees.removal(wt);
  const listed = asked.kind === "present" ? asked.changes : undefined;
  assert.deepEqual([...(listed ?? [])].sort(), ["a.txt", "new.txt"]);

  // The agent writes a file while the question is open.
  writeFileSync(join(wt, "written-while-asking.txt"), "agent output\n");
  const refused = await ctx.worktrees.removeAsAgreed(wt, { discardChanges: { listed }, pastLock: { reason: "claude agent 7" } });
  assert.equal(refused.ok, false);
  assert.equal(refused.changedSince, true, "says it changed since the question");
  assert.ok(existsSync(join(wt, "written-while-asking.txt")), "the file the question never named is still there");
  assert.equal(readFileSync(join(wt, "a.txt"), "utf8"), "changed\n", "…and so is everything else");
  const entry = (await ctx.worktrees.list()).find((e) => e.branch === "agent");
  assert.equal(entry?.lockReason, "claude agent 7", "still locked, with its reason");

  // Unlocked, the same: a --force never runs over a path nobody was told of.
  git("worktree", "unlock", wt);
  const unlocked = await ctx.worktrees.removeAsAgreed(wt, { discardChanges: { listed } });
  assert.equal(unlocked.changedSince, true);
  assert.ok(existsSync(join(wt, "written-while-asking.txt")));

  // A listed change that is gone again, or changed further, is no news: asked
  // again with all three listed, it goes.
  rmSync(join(wt, "new.txt"));
  writeFileSync(join(wt, "a.txt"), "changed again\n");
  const now = await ctx.worktrees.removal(wt);
  const all = [...(now.kind === "present" ? (now.changes ?? []) : []), "new.txt"];
  const removed = await ctx.worktrees.removeAsAgreed(wt, { discardChanges: { listed: all } });
  assert.ok(removed.ok, removed.stderr);
  assert.equal(existsSync(wt), false);
});

test("removeAsAgreed: when the question could not read the changes, it said any go — and they do", async () => {
  const { base, git, ctx } = repo();
  const wt = join(base, "wt", "unread");
  git("worktree", "add", "-q", "-b", "unread", wt);
  writeFileSync(join(wt, "x.txt"), "x\n");
  const r = await ctx.worktrees.removeAsAgreed(wt, { discardChanges: { listed: undefined } });
  assert.ok(r.ok, r.stderr);
  assert.equal(existsSync(wt), false);
});

test("removeAsAgreed: a clean locked worktree is unlocked and removed", async () => {
  const { base, git, ctx } = repo();
  const wt = join(base, "wt", "usb");
  git("worktree", "add", "-q", "-b", "usb", wt);
  git("worktree", "lock", wt);
  const r = await ctx.worktrees.removeAsAgreed(wt, { pastLock: {} });
  assert.ok(r.ok, r.stderr);
  assert.equal(existsSync(wt), false);
});

test("add and move hand git the path and ref after `--`: a branch named like an option is never read as one", async () => {
  const { base, git, ctx } = repo();
  git("update-ref", "refs/heads/-x", "HEAD");
  const r = await ctx.worktrees.add(join(base, "wt", "dash"), "-x");
  assert.doesNotMatch(r.stderr, /unknown switch|usage: git worktree/, "git never parsed -x as an option");
  assert.ok(r.ok, r.stderr);
  const moved = await ctx.worktrees.move(join(base, "wt", "dash"), join(base, "wt", "dash-2"));
  assert.ok(moved.ok, moved.stderr);
  assert.ok(existsSync(join(base, "wt", "dash-2")));
});

test("removal() names what git is stopped in THERE — a merge, a clean stopped rebase — and not a stale REBASE_HEAD", async () => {
  const { base, git, ctx } = repo();
  git("branch", "side");
  writeFileSync(join(base, "app", "a.txt"), "main\n");
  git("commit", "-qam", "main side");

  // A merge stopped on a conflict.
  const merging = join(base, "wt", "merging");
  git("worktree", "add", "-q", merging, "side");
  const m = at(merging);
  writeFileSync(join(merging, "a.txt"), "side\n");
  m("commit", "-qam", "side change");
  assert.throws(() => m("merge", "main"));
  const mr = await ctx.worktrees.removal(merging);
  assert.equal(mr.kind === "present" && mr.operation, "merge");
  assert.deepEqual(mr.kind === "present" && mr.changes, ["a.txt"]);

  // A rebase stopped on an `edit` with nothing uncommitted: git removes
  // this one with a plain remove, so the question is all there is.
  git("branch", "rb", "HEAD~1");
  const rebasing = join(base, "wt", "rebasing");
  git("worktree", "add", "-q", rebasing, "rb");
  const r = at(rebasing);
  writeFileSync(join(rebasing, "b.txt"), "b\n");
  r("add", "b.txt");
  r("commit", "-qm", "b");
  // The sequence editor is a NODE script: git runs it through its shell, where
  // a Windows path's backslashes are escapes (see operationInTheWay.test.ts).
  const seq = join(base, "seq.cjs");
  writeFileSync(seq, 'const fs=require("fs");const p=process.argv[2];fs.writeFileSync(p,fs.readFileSync(p,"utf8").replace(/^pick /,"edit "));\n');
  execFileSync("git", ["rebase", "-i", "main"], {
    cwd: rebasing,
    stdio: "ignore",
    env: { ...process.env, GIT_SEQUENCE_EDITOR: `node "${seq.replace(/\\/g, "/")}"`, GIT_EDITOR: "true" },
  });
  const rr = await ctx.worktrees.removal(rebasing);
  assert.equal(rr.kind === "present" && rr.operation, "rebase");
  assert.deepEqual(rr.kind === "present" && rr.changes, []);

  // Clean, and a REBASE_HEAD left behind by a finished rebase: nothing stopped.
  const clean = join(base, "wt", "clean");
  git("worktree", "add", "-q", "-b", "clean", clean);
  const gitDir = at(clean)("rev-parse", "--absolute-git-dir");
  writeFileSync(join(gitDir, "REBASE_HEAD"), git("rev-parse", "HEAD") + "\n");
  const cr = await ctx.worktrees.removal(clean);
  assert.equal(cr.kind, "present");
  assert.equal(cr.kind === "present" ? cr.operation : "x", undefined);

  // And this window's own stop is not read for another worktree's: the main
  // worktree mid-merge, the clean one still reads nothing stopped.
  git("branch", "other", "HEAD~1");
  const o = at(clean);
  o("checkout", "-q", "-b", "clean-2", "other");
  writeFileSync(join(clean, "a.txt"), "other\n");
  o("commit", "-qam", "other change");
  assert.throws(() => git("merge", "clean-2"));
  const again = await ctx.worktrees.removal(clean);
  assert.equal(again.kind === "present" ? again.operation : "x", undefined);
});
