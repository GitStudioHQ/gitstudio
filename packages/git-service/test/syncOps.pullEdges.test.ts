// Pull results the other pull tests do not reach: a pull that names its remote
// and branch, a merge commit refused by a hook (the merge is left for the user,
// so the pull comes back `blocked`), a branch that is not on the remote, and
// `merge.autoStash` deciding which uncommitted files are "in the way".
// Plus the force-push lease question (`upstreamUnseen`) with an explicit lease
// and with the remote branch gone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { synced } from "./syncOps.fixture";

test("a pull that names its remote and branch merges exactly that branch", async () => {
  const s = synced("named-pull");
  try {
    const o = s.other();
    o.git("checkout", "-q", "-b", "side");
    o.write("side.txt", "side\n");
    const sideTip = o.commitAll("side");
    o.git("push", "-q", "origin", "side");

    const ctx = s.ctx();
    const r = await ctx.sync.pull({ remote: "origin", branch: "side", mode: "merge" });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(s.me.read("side.txt"), "side\n", "side's file arrived on main");
    s.me.git("merge-base", "--is-ancestor", sideTip, "HEAD"); // throws unless side is merged in
    const pull = s.runs.find((a) => a[0] === "pull");
    assert.deepEqual(pull, ["pull", "--no-rebase", "origin", "side"]);
  } finally {
    s.cleanup();
  }
});

test("a pull with only a remote named pulls the branch's upstream from it", async () => {
  const s = synced("remote-only");
  try {
    const o = s.other();
    o.write("up.txt", "up\n");
    const tip = o.commitAll("up");
    o.git("push", "-q", "origin", "main");
    const r = await s.ctx().sync.pull({ remote: "origin", mode: "ff-only" });
    assert.equal(r.ok, true, r.stderr);
    assert.equal(s.me.sha("HEAD"), tip, "fast-forwarded");
    assert.deepEqual(s.runs.find((a) => a[0] === "pull"), ["pull", "--ff-only", "origin"]);
  } finally {
    s.cleanup();
  }
});

test("a pull whose merge commit a hook refused comes back blocked by the merge it left", async () => {
  const s = synced("hook");
  try {
    const o = s.other();
    o.write("theirs.txt", "theirs\n");
    o.commitAll("theirs");
    o.git("push", "-q", "origin", "main");
    s.me.write("mine.txt", "mine\n");
    const mine = s.me.commitAll("mine");
    // git runs hooks through sh on every platform (Git for Windows ships one).
    const hooks = join(s.me.root, ".git", "hooks");
    mkdirSync(hooks, { recursive: true });
    const hook = join(hooks, "pre-merge-commit");
    writeFileSync(hook, "#!/bin/sh\necho 'merge commits are reviewed here' >&2\nexit 1\n");
    chmodSync(hook, 0o755);

    const r = await s.ctx().sync.pull({ mode: "merge" });
    assert.equal(r.ok, false);
    assert.deepEqual(r.blocked, { operation: "merge", conflicted: 0 }, "the merge git left behind is what is in the way");
    assert.equal(r.stopped, undefined, "nothing conflicted");
    assert.equal(r.diverged, undefined);
    assert.equal(s.me.sha("HEAD"), mine, "no merge commit was made");
    assert.ok(s.me.exists(".git/MERGE_HEAD"), "the merge is waiting to be committed");
  } finally {
    s.cleanup();
  }
});

test("pulling a branch the remote does not have is a plain failure, never uncommitted work in the way", async () => {
  const s = synced("nope");
  try {
    s.me.git("checkout", "-q", "-b", "lone");
    s.me.write("scratch.txt", "untracked\n");
    const r = await s.ctx().sync.pull({ remote: "origin", branch: "no-such-branch", mode: "merge" });
    assert.equal(r.ok, false);
    assert.match(r.stderr, /no-such-branch/, "git's reason names the missing branch");
    assert.equal(r.dirty, undefined, "an untracked file is not 'in the way' of nothing");
    assert.equal(r.blocked, undefined);
    assert.equal(r.stopped, undefined);
    assert.equal(r.diverged, undefined);
    assert.equal(s.me.read("scratch.txt"), "untracked\n");
  } finally {
    s.cleanup();
  }
});

test("with merge.autoStash set, only the untracked file the pull would overwrite is reported in the way", async () => {
  const s = synced("autostash");
  try {
    const o = s.other();
    o.write("f.txt", "base\nupstream\n");
    o.write("new.txt", "from upstream\n");
    o.commitAll("upstream edits f and adds new");
    o.git("push", "-q", "origin", "main");
    s.me.git("config", "merge.autoStash", "true");
    s.me.write("f.txt", "base\nmine, uncommitted\n"); // tracked: git stashes it itself
    s.me.write("new.txt", "mine, untracked\n"); // untracked: git refuses over it
    const r = await s.ctx().sync.pull({ mode: "merge" });
    assert.equal(r.ok, false);
    assert.deepEqual(r.dirty, { paths: ["new.txt"] }, "the tracked edit is autostashed, so only new.txt blocks");
    assert.equal(s.me.read("new.txt"), "mine, untracked\n", "the untracked file is untouched");
  } finally {
    s.cleanup();
  }
});

test("upstreamUnseen: a lease the branch never had is unseen, its own old tip is not, and a gone remote branch is nothing to compare", async () => {
  const s = synced("unseen");
  try {
    const pushed = s.me.sha("HEAD");
    s.me.git("commit", "-q", "--amend", "-m", "base, amended");
    const ctx = s.ctx();
    assert.equal(await ctx.sync.upstreamUnseen(pushed), false, "the tip we amended is in our reflog");
    assert.equal(await ctx.sync.upstreamUnseen(), false, "the tracking ref is that same tip");

    const o = s.other();
    o.write("x.txt", "x\n");
    const theirs = o.commitAll("theirs");
    assert.equal(await ctx.sync.upstreamUnseen(theirs), true, "a commit that only exists elsewhere was never ours");
    assert.equal(await ctx.sync.upstreamUnseen("not-a-sha"), false, "a malformed lease falls back to the tracking ref");

    // The remote branch deleted and pruned: the config still names it.
    s.me.git("update-ref", "-d", "refs/remotes/origin/main");
    assert.equal(await ctx.sync.upstreamUnseen(), false, "no tracking tip — nothing to be unseen");
    assert.equal(await ctx.sync.upstreamTip(), null);
  } finally {
    s.cleanup();
  }
});

test("aheadBehind honours an abort signal that never fires", async () => {
  const s = synced("signal");
  try {
    s.me.write("a.txt", "a\n");
    s.me.commitAll("a");
    const ac = new AbortController();
    assert.deepEqual(await s.ctx().sync.aheadBehind("main", { signal: ac.signal }), { ahead: 1, behind: 0 });
  } finally {
    s.cleanup();
  }
});
