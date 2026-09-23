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
import {
  pullBlockedMessage,
  pullDetachedMessage,
  pullPauseMessage,
  pullStoppedMessage,
  type PullBlock,
} from "../src/SyncOps";

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

// …but it is not a failure either. The stop lands the user in Changes while
// every Pull door is still on screen, still counting "1 behind" — HEAD has not
// moved. Pressing one again is the most ordinary next click there is, and git
// refuses it before doing anything. That refusal used to fall through to the
// divergence check (a mid-merge branch IS still one ahead and one behind), so
// the app asked "merge or rebase?" over a merge already under way; either
// answer then failed with git's terminal hint, and the desktop filed it as a
// crash. It is its own answer: `blocked`, naming what is under way.

test("a pull pressed over a merge still stopped on conflicts is blocked, not diverged", async () => {
  const { ctx } = collidingClone({ alsoClean: true });
  assert.ok((await ctx.sync.pull({ mode: "merge" })).stopped, "precondition: stopped");

  const again = await ctx.sync.pull();
  assert.equal(again.ok, false);
  assert.equal(again.diverged, undefined, "no reconcile question over a merge already under way");
  assert.equal(again.stopped, undefined, "this press stopped nothing");
  assert.deepEqual(again.blocked, { operation: "merge", conflicted: 1 });

  for (const mode of ["merge", "rebase"] as const) {
    const withMode = await ctx.sync.pull({ mode });
    assert.deepEqual(withMode.blocked, { operation: "merge", conflicted: 1 }, mode);
  }
});

test("a merge resolved but not yet committed still blocks a pull, with nothing conflicted", async () => {
  const { clone, ctx } = collidingClone();
  assert.ok((await ctx.sync.pull({ mode: "merge" })).stopped, "precondition: stopped");
  writeFileSync(join(clone, "shared.txt"), "one\nBOTH\nthree\n");
  gitIn(clone, ["add", "shared.txt"]);

  const again = await ctx.sync.pull();
  assert.equal(again.diverged, undefined);
  assert.deepEqual(again.blocked, { operation: "merge", conflicted: 0 });
});

test("a rebase still stopped blocks a pull — conflicted, and resolved but not continued", async () => {
  const { clone, ctx } = collidingClone();
  assert.ok((await ctx.sync.pull({ mode: "rebase" })).stopped, "precondition: stopped");

  const conflicted = await ctx.sync.pull();
  assert.deepEqual(conflicted.blocked, { operation: "rebase", conflicted: 1 });

  // Staged, `rebase --continue` not run: HEAD is detached and git's pull exits
  // 1 — the same code as a stop — having found no branch to merge into.
  writeFileSync(join(clone, "shared.txt"), "one\nBOTH\nthree\n");
  gitIn(clone, ["add", "shared.txt"]);
  const resolved = await ctx.sync.pull();
  assert.equal(resolved.stopped, undefined, "nothing new stopped");
  assert.deepEqual(resolved.blocked, { operation: "rebase", conflicted: 0 });
});

test("a pull refused over the user's uncommitted edits is neither blocked nor a stop", async () => {
  // Behind only, with a local edit to the very file the upstream changed: git
  // refuses to overwrite it. Nothing is under way — the user has work in
  // progress, which is a different conversation.
  const { clone, ctx } = collidingClone();
  gitIn(clone, ["reset", "-q", "--hard", "HEAD~1"]);
  writeFileSync(join(clone, "shared.txt"), "one\nEDITING\nthree\n");
  const r = await ctx.sync.pull();
  assert.equal(r.ok, false);
  assert.equal(r.blocked, undefined);
  assert.equal(r.stopped, undefined);
  assert.equal(r.diverged, undefined);
});

test("what is under way is described in the app's words, with the way out", () => {
  const merge = pullBlockedMessage({ operation: "merge", conflicted: 2 });
  assert.match(merge, /merge is still in progress/i);
  assert.match(merge, /\b2 files\b/);
  const rebase = pullBlockedMessage({ operation: "rebase", conflicted: 0 });
  assert.match(rebase, /rebase is still in progress/i);
  assert.match(rebase, /continue/i);
  const bare = pullBlockedMessage({ conflicted: 1 });
  assert.match(bare, /\b1 file\b/);
  for (const m of [merge, rebase, bare]) {
    assert.doesNotMatch(m, /git (add|rm|rebase|commit|merge)|--continue|hint:|Pulling is not possible/i);
    assert.match(m, /pulling again/i);
  }
  assert.match(merge, /abort/i);
  assert.match(rebase, /abort/i);
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

// ── Pulling AGAIN from the state a stop leaves behind ────────────────────────
//
// A stop lands the user in Changes, mid-merge or mid-rebase — and the branch is
// still ahead AND behind, so the top bar still offers "Pull 2". git refuses a
// pull from there before it does anything (128: "Pulling is not possible
// because you have unmerged files" / "You have not concluded your merge"), or,
// mid-rebase, fails because HEAD is detached. The mode-less pull read that
// refusal as a divergence and asked "merge or rebase?" all over again; the
// answer then put git's `git add/rm` hint in a red toast and a crash report.
// Driven on a real repository in the real app before these were written.

test("pulling again while the merge is still stopped asks nothing, and names the merge", async () => {
  const { ctx } = collidingClone();
  assert.ok((await ctx.sync.pull({ mode: "merge" })).stopped, "precondition: the merge stopped");

  const again = await ctx.sync.pull();
  assert.equal(again.ok, false);
  assert.equal(again.diverged, undefined, "not a question: git refused before fetching anything");
  assert.equal(again.stopped, undefined, "…and not a new stop either");
  assert.deepEqual(again.blocked, { operation: "merge", conflicted: 1 });
});

test("a pull with a mode is blocked the same way", async () => {
  const { ctx } = collidingClone();
  assert.ok((await ctx.sync.pull({ mode: "merge" })).stopped, "precondition: the merge stopped");
  for (const mode of ["merge", "rebase"] as const) {
    const r = await ctx.sync.pull({ mode });
    assert.deepEqual(r.blocked, { operation: "merge", conflicted: 1 }, `mode ${mode}`);
  }
});

test("a merge whose conflicts are resolved but not yet committed still blocks, with none left", async () => {
  const { clone, ctx } = collidingClone();
  assert.ok((await ctx.sync.pull({ mode: "merge" })).stopped, "precondition: the merge stopped");
  writeFileSync(join(clone, "shared.txt"), "one\nBOTH\nthree\n");
  gitIn(clone, ["add", "shared.txt"]);
  const r = await ctx.sync.pull();
  assert.equal(r.diverged, undefined);
  assert.deepEqual(r.blocked, { operation: "merge", conflicted: 0 });
});

test("pulling again mid-rebase names the rebase — conflicted or already resolved", async () => {
  const { clone, ctx } = collidingClone();
  assert.ok((await ctx.sync.pull({ mode: "rebase" })).stopped, "precondition: the rebase stopped");
  const conflicted = await ctx.sync.pull();
  assert.deepEqual(conflicted.blocked, { operation: "rebase", conflicted: 1 });

  // Resolved, not continued: nothing is unmerged and HEAD is detached — git
  // itself would fetch and then fail with exit 1 ("You are not currently on a
  // branch"). Still the paused rebase's doing, and the pull is not run over it.
  writeFileSync(join(clone, "shared.txt"), "one\nBOTH\nthree\n");
  gitIn(clone, ["add", "shared.txt"]);
  for (const mode of [undefined, "merge", "rebase"] as const) {
    const r = await ctx.sync.pull(mode ? { mode } : undefined);
    assert.equal(r.stopped, undefined, `mode ${mode}: not a new stop`);
    assert.deepEqual(r.blocked, { operation: "rebase", conflicted: 0 }, `mode ${mode}`);
  }
});

test("a stopped cherry-pick with nothing unmerged blocks the pull before it runs — and a failure once it is finished is its own", async () => {
  // CHERRY_PICK_HEAD with nothing unmerged is a cherry-pick still in progress
  // (git status: "You are currently cherry-picking"), and git's own merge
  // refuses over it ("You have not concluded your cherry-pick"). The pull is
  // not run over it at all — running one over a stopped revert ENDED the
  // revert (test/operationInTheWay.test.ts) — so nothing is fetched and the
  // cherry-pick is what is said. The pull's own failure is not silenced: once
  // the cherry-pick is finished it comes back as itself, and keeps reporting.
  // (See unresolvedConflictsMessage for the report marker-based matching once
  // silenced: a pick's OWN failure, which the pick's door still reports.)
  const { clone, ctx } = collidingClone();
  const gone = join(tmpdir(), `gitstudio-stop-gone-cp-${process.pid}-${Date.now()}.git`);
  gitIn(clone, ["remote", "set-url", "origin", gone]);
  const head = gitIn(clone, ["rev-parse", "HEAD"]).trim();
  gitIn(clone, ["update-ref", "CHERRY_PICK_HEAD", head]);
  const r = await ctx.sync.pull();
  assert.equal(r.ok, false);
  assert.deepEqual(r.blocked, { operation: "cherry-pick", conflicted: 0 });
  gitIn(clone, ["update-ref", "-d", "CHERRY_PICK_HEAD"]);
  const after = await ctx.sync.pull();
  assert.equal(after.ok, false);
  assert.equal(after.blocked, undefined);
  assert.match(after.stderr, /does not appear to be a git repository|Could not read from remote/i);
});

test("the block is described in the app's words: what is paused, and the two ways out", () => {
  const cases: [PullBlock, RegExp[]][] = [
    [{ operation: "merge", conflicted: 2 }, [/merge is still in progress/, /\b2 files\b/, /commit the merge/]],
    [{ operation: "merge", conflicted: 0 }, [/merge is still in progress/, /commit it/i]],
    [{ operation: "rebase", conflicted: 1 }, [/rebase is still in progress/, /\b1 file\b/, /continue the rebase/]],
    [{ operation: "rebase", conflicted: 0 }, [/rebase is still in progress/, /continue it/i]],
    [{ operation: "cherry-pick", conflicted: 1 }, [/cherry-pick is still in progress/]],
    [{ conflicted: 3 }, [/\b3 files\b/, /conflicted/]],
  ];
  for (const [b, want] of cases) {
    const m = pullBlockedMessage(b);
    for (const re of want) assert.match(m, re, JSON.stringify(b));
    assert.doesNotMatch(m, /git (add|rm|rebase|commit|merge)|--continue|--abort|hint:/i, m);
    assert.match(m, /before pulling again/, m);
    if (b.operation) assert.match(m, /abort/i, m);
  }
});

// REBASE_HEAD is NOT a "rebase in progress" marker: git leaves it behind when a
// rebase FINISHES — by --continue, by --skip to the end, and by --quit (checked
// against git 2.49). Only the state directory (rebase-merge / rebase-apply) has
// exactly the rebase's lifetime (see RebaseRunner.rebaseStateDir). Any repo
// that has ever finished a stopped rebase therefore carries one.

/** A clone that stopped on a rebase, and then FINISHED it. */
async function afterAFinishedRebase(): Promise<{ clone: string; bare: string; ctx: GitContext }> {
  const made = collidingClone();
  assert.ok((await made.ctx.sync.pull({ mode: "rebase" })).stopped, "precondition: the rebase stopped");
  writeFileSync(join(made.clone, "shared.txt"), "one\nBOTH\nthree\n");
  gitIn(made.clone, ["add", "shared.txt"]);
  execFileSync("git", ["rebase", "--continue"], {
    cwd: made.clone,
    env: { ...process.env, GIT_EDITOR: "true", GIT_OPTIONAL_LOCKS: "0" },
    stdio: "ignore",
  });
  assert.ok(gitOk(made.clone, ["symbolic-ref", "-q", "HEAD"]), "precondition: the rebase finished, back on the branch");
  assert.ok(
    gitOk(made.clone, ["rev-parse", "--verify", "--quiet", "REBASE_HEAD"]),
    "precondition: …and git left REBASE_HEAD behind",
  );
  return made;
}

test("a finished rebase's leftover REBASE_HEAD does not blame a later failure on a rebase", async () => {
  const { clone, ctx } = await afterAFinishedRebase();
  const gone = join(tmpdir(), `gitstudio-stop-gone-rh-${process.pid}-${Date.now()}.git`);
  gitIn(clone, ["remote", "set-url", "origin", gone]);
  const r = await ctx.sync.pull({ mode: "merge" });
  assert.equal(r.ok, false);
  assert.equal(r.blocked, undefined, "no rebase is in progress — the remote is gone");
  assert.match(r.stderr, /does not appear to be a git repository|Could not read from remote/i);
});

test("a merge that stops after an earlier, finished rebase is named a merge", async () => {
  const { clone, bare, ctx } = await afterAFinishedRebase();
  gitIn(clone, ["push", "-q", "origin", "main"]);
  // A second round of colliding work, reconciled by MERGE this time.
  const seed2 = mkdtempSync(join(tmpdir(), "gitstudio-stop-seed2-"));
  execFileSync("git", ["clone", "-q", bare, seed2]);
  trash.push(seed2);
  identify(seed2);
  commitIn(seed2, "shared.txt", "one\nTHEIRS AGAIN\nthree\n", "theirs again");
  gitIn(seed2, ["push", "-q", "origin", "main"]);
  commitIn(clone, "shared.txt", "one\nMINE AGAIN\nthree\n", "mine again");
  const r = await ctx.sync.pull({ mode: "merge" });
  assert.deepEqual(r.stopped, { operation: "merge", conflicted: ["shared.txt"] }, "not 'continue the rebase'");
  assert.match(pullStoppedMessage(r.stopped!), /commit the merge/);
  // …and pulling again over it names the merge too.
  const again = await ctx.sync.pull();
  assert.deepEqual(again.blocked, { operation: "merge", conflicted: 1 });
});

test("the extension's settler has a sentence for both faces of a stop, and for nothing else", () => {
  const stop = { operation: "rebase" as const, conflicted: ["a.ts"] };
  const block: PullBlock = { operation: "rebase", conflicted: 1 };
  assert.equal(pullPauseMessage({ stopped: stop }), pullStoppedMessage(stop));
  assert.equal(pullPauseMessage({ blocked: block }), pullBlockedMessage(block));
  assert.equal(pullPauseMessage({}), undefined, "an ordinary failure is not settled as a stop");
});

test("a diverged branch whose remote IS reachable still asks", async () => {
  // The guard above must not swallow the question it exists beside.
  const { ctx } = collidingClone();
  const r = await ctx.sync.pull();
  assert.ok(r.diverged, "diverged and reachable → the question");
  assert.equal(r.stopped, undefined, "…and nothing was merged or rebased yet");
});

// ── A detached HEAD: there is no branch to pull into ─────────────────────────
//
// `git pull` on a detached HEAD fetches and then fails with 1: "You are not
// currently on a branch. Please specify which branch you want to merge with.
// See git-pull(1) for details. git pull <remote> <branch>" — advice for a
// terminal, which the extension's status-bar Sync and Pull showed verbatim as
// an error. Nothing is broken and nothing is paused; the user checked out a
// commit or a tag. `detached` says so, read from git (`symbolic-ref`), never
// from its English.

test("a pull on a detached HEAD says there is no branch — not git's advice", async () => {
  const { clone, ctx } = collidingClone();
  gitIn(clone, ["checkout", "-q", "--detach", "HEAD"]);
  for (const mode of [undefined, "merge", "rebase"] as const) {
    const r = await ctx.sync.pull(mode ? { mode } : undefined);
    assert.equal(r.ok, false, `mode ${mode}`);
    assert.equal(r.detached, true, `mode ${mode}: the fact the caller acts on`);
    assert.equal(r.blocked, undefined, `mode ${mode}: nothing is paused`);
    assert.equal(r.stopped, undefined, `mode ${mode}`);
    assert.equal(r.diverged, undefined, `mode ${mode}`);
  }
  const said = pullDetachedMessage();
  assert.match(said, /no branch to pull into/i);
  assert.doesNotMatch(said, /git pull|<remote>|git-pull\(1\)|hint:/i);
});

test("a rebase paused on its detached HEAD is still a paused rebase, not a detached HEAD", async () => {
  const { clone, ctx } = collidingClone();
  assert.ok((await ctx.sync.pull({ mode: "rebase" })).stopped, "precondition: the rebase stopped");
  writeFileSync(join(clone, "shared.txt"), "one\nBOTH\nthree\n");
  gitIn(clone, ["add", "shared.txt"]);
  const r = await ctx.sync.pull();
  assert.deepEqual(r.blocked, { operation: "rebase", conflicted: 0 });
  assert.equal(r.detached, undefined, "what is left to do is finish the rebase, not check out a branch");
});

test("a pull on a branch that fails for another reason is not called detached", async () => {
  const { clone, ctx } = collidingClone();
  const gone = join(tmpdir(), `gitstudio-stop-gone-dh-${process.pid}-${Date.now()}.git`);
  gitIn(clone, ["remote", "set-url", "origin", gone]);
  const r = await ctx.sync.pull({ mode: "merge" });
  assert.equal(r.ok, false);
  assert.equal(r.detached, undefined);
});
