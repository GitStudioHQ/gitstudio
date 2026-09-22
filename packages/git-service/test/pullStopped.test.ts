// A pull that STOPS on conflicts, and a pull that never reached the remote.
//
// Report #12 taught Pull to ask "merge or rebase?" when the branch has
// diverged. The answer to that question is a merge or a rebase — and either can
// stop on conflicts, which is the most ordinary outcome a diverged branch has.
// What reached the user from that new door was the old symptom again:
//
//   · Merge: git writes CONFLICT to STDOUT and nothing to stderr, and `pull()`
//     returned only stderr — so the app said "The operation failed.";
//   · Rebase: git writes its terminal hint to stderr ("Resolve all conflicts
//     manually, mark them as resolved with git add/rm … then run git rebase
//     --continue"), and that landed in a red toast AND a crash report.
//
// A pull that stopped on conflicts has done exactly what was asked, up to the
// point where a human has to decide. So it comes back as its OWN answer — a
// `stopped` fact naming the operation and the files — never as a failure, and
// never by reading git's English (the unmerged index and the operation's marker
// ref are the same in every locale).
//
// And the second half: with no mode, a pull that could not REACH the remote
// must say so. It used to consult the stale remote-tracking ref after any
// failure and, when that ref showed divergence from an earlier fetch, ask
// "merge or rebase?" about a remote nobody had been able to talk to.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeTempRepo } from "./tmpRepo";
import { GitContext } from "../src/GitContext";
import { pullStoppedMessage } from "../src/SyncOps";

const trash: string[] = [];
const contexts: GitContext[] = [];

afterEach(() => {
  for (const c of contexts.splice(0)) c.dispose();
  for (const d of trash.splice(0)) removeTempRepo(d);
});

function gitIn(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

/** Exit status of a git command that is allowed to fail. */
function gitOk(cwd: string, args: string[]): boolean {
  try {
    gitIn(cwd, args);
    return true;
  } catch {
    return false;
  }
}

function identify(dir: string): void {
  gitIn(dir, ["config", "user.email", "dev@example.com"]);
  gitIn(dir, ["config", "user.name", "Dev"]);
  gitIn(dir, ["config", "commit.gpgsign", "false"]);
  gitIn(dir, ["config", "gc.auto", "0"]);
}

function commitIn(cwd: string, name: string, content: string, msg: string): void {
  writeFileSync(join(cwd, name), content);
  gitIn(cwd, ["add", name]);
  gitIn(cwd, ["commit", "-q", "-m", msg]);
}

/**
 * A tracking clone whose branch and upstream have each changed THE SAME LINES
 * of `shared.txt` — so reconciling them, either way, stops on a conflict. With
 * `alsoClean`, both sides also touch a file of their own that merges cleanly,
 * so "how many files conflict" has a wrong answer to avoid.
 */
function collidingClone(opts: { alsoClean?: boolean } = {}): { clone: string; bare: string; ctx: GitContext } {
  const bare = mkdtempSync(join(tmpdir(), "gitstudio-stop-bare-"));
  execFileSync("git", ["init", "--bare", "-q", "-b", "main", bare]);
  const seed = mkdtempSync(join(tmpdir(), "gitstudio-stop-seed-"));
  execFileSync("git", ["clone", "-q", bare, seed]);
  identify(seed);
  commitIn(seed, "shared.txt", "one\ntwo\nthree\n", "base");
  gitIn(seed, ["push", "-q", "origin", "main"]);

  const clone = mkdtempSync(join(tmpdir(), "gitstudio-stop-clone-"));
  execFileSync("git", ["clone", "-q", bare, clone]);
  identify(clone);

  commitIn(seed, "shared.txt", "one\nTHEIRS\nthree\n", "theirs");
  if (opts.alsoClean) commitIn(seed, "theirs-only.txt", "theirs\n", "theirs, clean");
  gitIn(seed, ["push", "-q", "origin", "main"]);
  commitIn(clone, "shared.txt", "one\nMINE\nthree\n", "mine");
  if (opts.alsoClean) commitIn(clone, "mine-only.txt", "mine\n", "mine, clean");

  trash.push(bare, seed, clone);
  const ctx = new GitContext({ root: clone });
  contexts.push(ctx);
  return { clone, bare, ctx };
}

test("a merge that stops on conflicts comes back as a stop, not a failure", async () => {
  const { clone, ctx } = collidingClone({ alsoClean: true });
  const r = await ctx.sync.pull({ mode: "merge" });

  assert.equal(r.ok, false, "the pull did not complete — nothing may treat it as done");
  assert.deepEqual(r.stopped, { operation: "merge", conflicted: ["shared.txt"] });
  assert.equal(r.diverged, undefined, "it is not a question any more — it was answered");
  // git said CONFLICT on stdout and nothing useful on stderr; the stream that
  // carries the explanation is no longer thrown away.
  assert.match(r.stdout ?? "", /CONFLICT/);
  // And the repository really is mid-merge, which is what the Changes view's
  // paused-operation banner and the merge editor read.
  assert.ok(gitOk(clone, ["rev-parse", "--verify", "--quiet", "MERGE_HEAD"]), "MERGE_HEAD is set");
});

test("a rebase that stops on conflicts names the rebase", async () => {
  const { clone, ctx } = collidingClone();
  const r = await ctx.sync.pull({ mode: "rebase" });

  assert.equal(r.ok, false);
  assert.deepEqual(r.stopped, { operation: "rebase", conflicted: ["shared.txt"] });
  assert.ok(gitOk(clone, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]), "REBASE_HEAD is set");
});

test("the user's own pull.rebase setting can stop on conflicts too, and says so", async () => {
  // No mode: the config drives a plain `git pull`, which is the path the
  // desktop's first press takes for anyone who has configured git.
  const { clone, ctx } = collidingClone();
  gitIn(clone, ["config", "pull.rebase", "true"]);
  const r = await ctx.sync.pull();
  assert.deepEqual(r.stopped, { operation: "rebase", conflicted: ["shared.txt"] });
});

test("a pull git REFUSES over conflicts it already had is not a new stop", async () => {
  // A merge is already stopped on shared.txt. Pulling again is refused by git
  // before it does anything (exit 128, "Pulling is not possible because you
  // have unmerged files"). That is a refusal, not this pull stopping — calling
  // it one would announce conflicts this press did not create.
  const { ctx } = collidingClone();
  const first = await ctx.sync.pull({ mode: "merge" });
  assert.ok(first.stopped, "precondition: the first pull stopped");
  const again = await ctx.sync.pull({ mode: "merge" });
  assert.equal(again.ok, false);
  assert.equal(again.stopped, undefined);
});

test("the stop is described in the app's words, with the count and the next step", () => {
  const merge = pullStoppedMessage({ operation: "merge", conflicted: ["a.ts"] });
  assert.match(merge, /\b1 file\b/);
  assert.match(merge, /commit the merge/);
  const rebase = pullStoppedMessage({ operation: "rebase", conflicted: ["a.ts", "b.ts", "c.ts"] });
  assert.match(rebase, /\b3 files\b/);
  assert.match(rebase, /continue the rebase/);
  for (const m of [merge, rebase]) {
    // Nothing a terminal would say: no `git add/rm`, no `--continue` flag.
    assert.doesNotMatch(m, /git (add|rm|rebase|commit)|--continue|hint:/i);
    // And it offers the way back, because stopping is a choice point.
    assert.match(m, /abort/i);
  }
});

test("a pull that could not reach the remote says THAT, whatever the stale refs show", async () => {
  // An earlier fetch left origin/main showing divergence. Now the remote is
  // unreachable. The old code saw `pull --ff-only` fail, read the stale ref,
  // and asked "merge or rebase?" — a question about a remote it had not been
  // able to talk to, whose answer then failed with the transport error anyway.
  const { clone, ctx } = collidingClone();
  gitIn(clone, ["fetch", "-q"]);
  assert.ok(await ctx.sync.divergence(), "precondition: the stale ref shows divergence");
  const gone = join(tmpdir(), `gitstudio-stop-gone-${process.pid}-${Date.now()}.git`);
  assert.equal(existsSync(gone), false);
  gitIn(clone, ["remote", "set-url", "origin", gone]);

  const r = await ctx.sync.pull();
  assert.equal(r.ok, false);
  assert.equal(r.diverged, undefined, "no reconcile question about a remote we never reached");
  assert.match(r.stderr, /does not appear to be a git repository|Could not read from remote/i);
});

test("a diverged branch whose remote IS reachable still asks", async () => {
  // The guard above must not swallow the question it exists beside.
  const { ctx } = collidingClone();
  const r = await ctx.sync.pull();
  assert.ok(r.diverged, "diverged and reachable → the question");
  assert.equal(r.stopped, undefined, "…and nothing was merged or rebased yet");
});
