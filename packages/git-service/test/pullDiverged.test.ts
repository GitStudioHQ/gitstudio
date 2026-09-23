// A pull on a branch that has diverged from its upstream.
//
// Report #12, verbatim from a real GitStudio Desktop 1.4.0 user who pressed
// Pull:
//
//     hint: You have divergent branches and need to specify how to reconcile
//     hint: them. You can do so by running one of the following commands
//     hint:   git config pull.rebase false  # merge
//     hint:   git config pull.rebase true   # rebase
//     hint:   git config pull.ff only       # fast-forward only
//     fatal: Need to specify how to reconcile divergent branches.
//
// That is git talking to a terminal. Since 2.27 it refuses a pull outright when
// both sides have moved and neither `pull.rebase` nor `pull.ff` is set, and
// `SyncOps.pull` passed no flag, so the advice went straight to a toast.
//
// What these pin:
//   · the refusal comes back as `diverged` — a fact with counts, not a wall of
//     text — and NOTHING in the repo moved;
//   · merge and rebase each do what they say when passed as a mode;
//   · the mode is a FLAG, never a config write. The choice belongs to the
//     press, not to the repository;
//   · git's own configuration, when the user has any, still wins.

import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";

let bare: string;
let clone: string;
let ctx: GitContext;
const trash: string[] = [];

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

function commitIn(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  gitIn(cwd, ["add", name]);
  gitIn(cwd, ["commit", "-m", msg]);
}

function identify(dir: string): void {
  gitIn(dir, ["config", "user.email", "dev@example.com"]);
  gitIn(dir, ["config", "user.name", "Dev"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
}

/** A tracking clone whose branch and upstream have each gained one commit. */
function diverge(): void {
  bare = mkdtempSync(join(tmpdir(), "gitstudio-div-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "gitstudio-div-seed-"));
  execFileSync("git", ["clone", "-q", bare, seed]);
  identify(seed);
  commitIn(seed, "base.txt", "base\n", "base");
  gitIn(seed, ["push", "-q", "origin", "main"]);

  clone = mkdtempSync(join(tmpdir(), "gitstudio-div-clone-"));
  execFileSync("git", ["clone", "-q", bare, clone]);
  identify(clone);

  // THEIR commit, then OURS. Neither side has the other's.
  commitIn(seed, "theirs.txt", "theirs\n", "theirs");
  gitIn(seed, ["push", "-q", "origin", "main"]);
  commitIn(clone, "mine.txt", "mine\n", "mine");
  trash.push(seed);

  ctx = new GitContext({ root: clone });
}

/** `git config --get <key>` in the clone, or undefined when it is unset. */
function config(key: string): string | undefined {
  try {
    return gitIn(clone, ["config", "--get", key]).trim();
  } catch {
    return undefined; // exit 1 = the key is not set, which is the answer
  }
}

beforeEach(() => diverge());
afterEach(() => {
  ctx?.dispose();
  for (const dir of [bare, clone, ...trash.splice(0)]) removeTempRepo(dir);
});

test("a diverged pull comes back as a question, not as git's config advice", async () => {
  const before = gitIn(clone, ["rev-parse", "HEAD"]).trim();
  const r = await ctx.sync.pull();

  assert.equal(r.ok, false);
  assert.deepEqual(r.diverged, {
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 1,
  });
  // The counts are the point: the caller can say "1 commit here, 1 there"
  // without reading a word of git's output.
  assert.equal(
    gitIn(clone, ["rev-parse", "HEAD"]).trim(),
    before,
    "a refused pull moves nothing",
  );
  assert.equal(
    gitIn(clone, ["status", "--porcelain"]).trim(),
    "",
    "…and leaves no half-done merge in the worktree",
  );
  // Nothing was written to the config, either — least of all by us.
  assert.equal(config("pull.rebase"), undefined);
  assert.equal(config("pull.ff"), undefined);
});

test("fast-forward-only refuses a diverged branch, and says so in one line", async () => {
  const before = gitIn(clone, ["rev-parse", "HEAD"]).trim();
  const r = await ctx.sync.pull({ mode: "ff-only" });
  assert.equal(r.ok, false);
  // git's OWN ff-only refusal — one sentence. Not the divergent-branches hint,
  // which is what a pull with no flag at all prints and what report #12 is.
  assert.match(r.stderr, /Not possible to fast-forward/i);
  assert.doesNotMatch(
    r.stderr,
    /git config pull\.(rebase|ff)/,
    "a pull that named its mode must never print git's config advice",
  );
  assert.equal(gitIn(clone, ["rev-parse", "HEAD"]).trim(), before, "nothing moved");
  // An EXPLICIT ff-only is the user's answer, not a state to ask about again.
  assert.equal(r.diverged, undefined);
});

test("merge combines the two sides and keeps our sha", async () => {
  const mine = gitIn(clone, ["rev-parse", "HEAD"]).trim();
  const r = await ctx.sync.pull({ mode: "merge" });
  assert.ok(r.ok, r.stderr);

  // Both files are present, and our commit is still one of HEAD's parents —
  // i.e. it was merged, not replayed.
  const log = gitIn(clone, ["log", "--format=%H %s"]);
  assert.match(log, /theirs/);
  assert.match(log, /mine/);
  const parents = gitIn(clone, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  assert.equal(parents.length, 3, "HEAD is a merge commit");
  assert.ok(parents.includes(mine), "our commit is a parent, with its sha intact");
  assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 2, behind: 0 });
});

test("rebase replays our commit on top and leaves history linear", async () => {
  const mine = gitIn(clone, ["rev-parse", "HEAD"]).trim();
  const r = await ctx.sync.pull({ mode: "rebase" });
  assert.ok(r.ok, r.stderr);

  const head = gitIn(clone, ["rev-parse", "HEAD"]).trim();
  assert.notEqual(head, mine, "a rebase rewrites the commit");
  assert.equal(gitIn(clone, ["log", "--format=%s", "-1"]).trim(), "mine", "…ours is on top");
  const parents = gitIn(clone, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  assert.equal(parents.length, 2, "one parent — no merge commit");
  assert.equal(
    gitIn(clone, ["rev-parse", "HEAD~1"]).trim(),
    gitIn(clone, ["rev-parse", "origin/main"]).trim(),
    "…sitting directly on the upstream tip",
  );
  assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 1, behind: 0 });
});

// The whole point of passing a flag. git's own advice tells the user to run
// `git config pull.rebase <x>`, which answers the question for EVERY future
// pull in that repo. A dialog answers it for this one.
test("choosing merge or rebase writes nothing to the user's git config", async () => {
  for (const mode of ["merge", "rebase"] as const) {
    diverge(); // a fresh diverged clone per mode
    const r = await ctx.sync.pull({ mode });
    assert.ok(r.ok, r.stderr);
    for (const key of ["pull.rebase", "pull.ff", "branch.main.rebase"]) {
      assert.equal(config(key), undefined, `${mode} must not set ${key}`);
    }
    ctx.dispose();
  }
});

// A user who HAS configured git has already answered. We must not take the
// question back off them — and with pull.rebase set there is no wall to hit.
test("an existing pull.rebase setting decides the pull without asking", async () => {
  gitIn(clone, ["config", "pull.rebase", "true"]);
  const r = await ctx.sync.pull();
  assert.ok(r.ok, r.stderr);
  assert.equal(r.diverged, undefined, "nothing to ask — the repo already said");
  const parents = gitIn(clone, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  assert.equal(parents.length, 2, "it rebased, as configured");
});

test("a per-branch branch.<name>.rebase setting counts too", async () => {
  // git honours this above pull.rebase, so reading only the global keys would
  // have us overriding a preference the user set on this very branch.
  gitIn(clone, ["config", "branch.main.rebase", "false"]);
  const r = await ctx.sync.pull();
  assert.ok(r.ok, r.stderr);
  assert.equal(r.diverged, undefined);
  const parents = gitIn(clone, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  assert.equal(parents.length, 3, "it merged, as configured");
});

// The extension's "Pull using Merge" asks the user and then passes a boolean.
// `false` meant "no --rebase flag", which is not the same as "--no-rebase" —
// so the item that had ALREADY asked the question walked into git's wall.
test("rebase:false means merge, not 'leave it to git'", async () => {
  const r = await ctx.sync.pull({ rebase: false });
  assert.ok(r.ok, r.stderr);
  const parents = gitIn(clone, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  assert.equal(parents.length, 3, "merged");
});

test("rebase:true still means rebase", async () => {
  const r = await ctx.sync.pull({ rebase: true });
  assert.ok(r.ok, r.stderr);
  const parents = gitIn(clone, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(/\s+/);
  assert.equal(parents.length, 2, "rebased");
});

// Not every failed pull is a divergence, and offering "merge or rebase" for a
// network error would be a lie with buttons on it.
test("a branch that is merely behind fast-forwards, with nothing to ask", async () => {
  gitIn(clone, ["fetch", "-q"]);
  gitIn(clone, ["reset", "--hard", "-q", "origin/main~1"]);
  assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 0, behind: 1 });
  const r = await ctx.sync.pull();
  assert.ok(r.ok, r.stderr);
  assert.equal(r.diverged, undefined);
  assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 0, behind: 0 });
});

test("a branch that is merely ahead pulls cleanly, with nothing to ask", async () => {
  // Reset to the upstream tip, then commit on top: ahead only.
  gitIn(clone, ["fetch", "-q"]);
  gitIn(clone, ["reset", "--hard", "-q", "origin/main"]);
  commitIn(clone, "ahead.txt", "ahead\n", "ahead");
  assert.deepEqual(await ctx.sync.aheadBehind(), { ahead: 1, behind: 0 });
  const r = await ctx.sync.pull();
  assert.ok(r.ok, r.stderr);
  assert.equal(r.diverged, undefined);
});

// divergence() is the fact the bridge and both UIs ask for. It must never
// invent one where there is no branch or no upstream to diverge FROM.
test("divergence() answers null for a detached HEAD and for an untracked branch", async () => {
  gitIn(clone, ["checkout", "-q", "--detach", "HEAD"]);
  assert.equal(await ctx.sync.divergence(), null, "detached");
  gitIn(clone, ["checkout", "-q", "-b", "lone"]);
  assert.equal(await ctx.sync.divergence(), null, "no upstream");
});

// divergence() READS; it never fetches. Before a fetch the remote-tracking ref
// has not seen their commit, so the honest answer is "not diverged (yet)" —
// which is exactly why `pull()` consults it AFTER `pull --ff-only` has fetched,
// and not before.
test("divergence() is null until the remote-tracking ref has actually moved", async () => {
  assert.equal(await ctx.sync.divergence(), null, "nothing fetched yet");
  gitIn(clone, ["fetch", "-q"]);
  assert.ok(await ctx.sync.divergence(), "…and a fact once it has");
});

test("divergence() reports the branch and upstream by name when both moved", async () => {
  gitIn(clone, ["fetch", "-q"]);
  assert.deepEqual(await ctx.sync.divergence(), {
    branch: "main",
    upstream: "origin/main",
    ahead: 1,
    behind: 1,
  });
});
