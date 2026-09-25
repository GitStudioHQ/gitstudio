import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "../src/GitContext";
import {
  fetchResetTarget,
  isResetRefusal,
  localMovedOnFrom,
  planReset,
  resetQuestion,
  resetTargetOf,
  resettableBranches,
  runReset,
  type ResetPlan,
  type ResetTarget,
} from "../src/branchReset";
import { removeTempRepo } from "./tmpRepo";

// "Reset 'feature' to 'origin/feature'" (issue #32), against real git, over
// the state space rather than one case:
//
//   the branch    checked out here · not checked out
//   × vs remote   equal · behind · ahead · diverged
//   × your work   clean · uncommitted edits (staged and not)
//
// Per cell: what the plan reads (after a FETCH — the remote moved since the
// last one in every cell that is behind), what the question says and whether
// it is scary, what the reset does to the branch, HEAD and the working tree,
// and that the Undo snapshot puts it all back. Then the refusals — no
// upstream, a local upstream, one gone from the remote, checked out in
// another worktree, a name git reads as an option, a stopped merge — and the
// traps: a tag sharing the branch's name, the branch moving between the
// question and the answer, the remote unreachable.

const scratch = mkdtempSync(join(tmpdir(), "gs-branch-reset-"));
after(() => removeTempRepo(scratch));
let seq = 0;

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function identify(g: (...a: string[]) => string): void {
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "T");
  g("config", "commit.gpgsign", "false");
  g("config", "gc.auto", "0");
}

interface Fixture {
  dir: string;
  git: (...a: string[]) => string;
  /** A second clone, for moving the remote behind the work clone's back. */
  other: (...a: string[]) => string;
  otherDir: string;
  ctx: GitContext;
}

/**
 * A bare remote with main and feature (f.txt = "base"), a work clone with both
 * branches tracking it, and a second clone that pushes to it.
 */
function fixture(): Fixture {
  const base = join(scratch, `cell-${++seq}`);
  const remote = join(base, "remote.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const seed = join(base, "seed");
  execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
  const s = at(seed);
  identify(s);
  writeFileSync(join(seed, "f.txt"), "base\n");
  writeFileSync(join(seed, "g.txt"), "g\n");
  s("add", ".");
  s("commit", "-qm", "base");
  s("push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/feature");

  const dir = join(base, "work");
  execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
  const git = at(dir);
  identify(git);
  git("branch", "-q", "--track", "feature", "refs/remotes/origin/feature");

  const otherDir = join(base, "other");
  execFileSync("git", ["clone", "-q", remote, otherDir], { stdio: "ignore" });
  const other = at(otherDir);
  identify(other);
  return { dir, git, other, otherDir, ctx: new GitContext({ root: dir }) };
}

type Relation = "equal" | "behind" | "ahead" | "diverged";

/** Put `feature` in `relation` to origin/feature. The remote's commits are pushed but NOT fetched here. */
function shape(f: Fixture, relation: Relation): void {
  if (relation === "behind" || relation === "diverged") {
    f.other("checkout", "-q", "-b", "feature", "origin/feature");
    writeFileSync(join(f.otherDir, "r.txt"), "remote 1\n");
    f.other("add", ".");
    f.other("commit", "-qm", "remote one");
    writeFileSync(join(f.otherDir, "f.txt"), "remote\n");
    f.other("commit", "-qam", "remote two");
    f.other("push", "-q", "origin", "refs/heads/feature:refs/heads/feature");
  }
  if (relation === "ahead" || relation === "diverged") {
    // Local commits on feature, made without checking it out.
    const tip = f.git("rev-parse", "refs/heads/feature");
    const tree = f.git("rev-parse", `${tip}^{tree}`);
    let parent = tip;
    for (const subject of ["local one", "local two", "local three"]) {
      parent = f.git("commit-tree", tree, "-p", parent, "-m", subject);
    }
    f.git("update-ref", "refs/heads/feature", parent);
  }
}

const read = (f: Fixture, p: string): string => readFileSync(join(f.dir, p), "utf8");

/** Edits on whatever is checked out: one staged, one not. */
function makeDirty(f: Fixture): void {
  writeFileSync(join(f.dir, "g.txt"), "my staged edit\n");
  f.git("add", "g.txt");
  writeFileSync(join(f.dir, "f.txt"), "my unstaged edit\n");
}

async function target(f: Fixture, full = "refs/heads/feature", to?: string): Promise<ResetTarget> {
  const t = await resetTargetOf(f.ctx.process, full, to);
  assert.ok(!isResetRefusal(t), `refused: ${isResetRefusal(t) ? t.refused : ""}`);
  return t as ResetTarget;
}
async function plan(f: Fixture, t: ResetTarget, fetchFailed = false): Promise<ResetPlan> {
  const p = await planReset(f.ctx.process, t, { fetchFailed });
  assert.ok(!isResetRefusal(p), `refused: ${isResetRefusal(p) ? p.refused : ""}`);
  return p as ResetPlan;
}

const EXPECT: Record<Relation, { ahead: number; behind: number }> = {
  equal: { ahead: 0, behind: 0 },
  behind: { ahead: 0, behind: 2 },
  ahead: { ahead: 3, behind: 0 },
  diverged: { ahead: 3, behind: 2 },
};

for (const current of [true, false]) {
  for (const relation of ["equal", "behind", "ahead", "diverged"] as Relation[]) {
    for (const dirty of [false, true]) {
      const cell = `${current ? "checked out" : "not checked out"} · ${relation} · ${dirty ? "uncommitted edits" : "clean"}`;
      test(`reset to upstream: ${cell}`, async () => {
        const f = fixture();
        try {
          shape(f, relation);
          if (current) f.git("checkout", "-q", "feature");
          if (dirty) makeDirty(f);
          const before = f.git("rev-parse", "refs/heads/feature");
          const headBefore = f.git("symbolic-ref", "HEAD");
          const staleRemote = f.git("rev-parse", "refs/remotes/origin/feature");

          const t = await target(f);
          assert.equal(t.current, current);
          assert.equal(t.target, "refs/remotes/origin/feature");
          assert.equal(t.targetName, "origin/feature");
          assert.equal(t.remote, "origin");
          assert.equal(await fetchResetTarget(f.ctx.process, t), true);
          const fresh = f.git("rev-parse", "refs/remotes/origin/feature");
          if (relation === "behind" || relation === "diverged") {
            assert.notEqual(fresh, staleRemote, "the fetch brought the remote's new commits");
          }

          const p = await plan(f, t);
          assert.equal(p.ahead, EXPECT[relation].ahead, "commits the reset drops");
          assert.equal(p.behind, EXPECT[relation].behind, "commits it gains — seen only after the fetch");
          assert.equal(p.targetSha, fresh, "it resets to the remote as fetched now");
          assert.deepEqual(
            p.dropped.map((c) => c.subject),
            EXPECT[relation].ahead ? ["local three", "local two", "local one"] : [],
            "the dropped commits, newest first",
          );
          assert.equal(p.dirty, current && dirty ? 2 : 0, "uncommitted files — only the checked-out branch's count");

          const q = resetQuestion(p);
          const losesSomething = EXPECT[relation].ahead > 0 || (current && dirty);
          if (!losesSomething && relation === "equal") {
            assert.equal(q.kind, "nothing");
            assert.match(q.kind === "nothing" ? q.message : "", /already matches 'origin\/feature'\. Nothing to reset\./);
            return; // nothing to run
          }
          assert.equal(q.kind, "confirm");
          if (q.kind !== "confirm") return;
          if (!losesSomething) {
            assert.equal(q.danger, false, "behind with nothing of its own: a fast-forward, not a warning");
            assert.equal(q.title, "Fast-forward 'feature' to 'origin/feature'?");
            assert.equal(q.confirmLabel, "Fast-forward");
            assert.match(q.message, /2 commits behind 'origin\/feature' and has no commits of its own, so nothing is lost/);
          } else {
            assert.equal(q.danger, true);
            assert.equal(q.title, "Reset 'feature' to 'origin/feature'?");
            assert.equal(q.confirmLabel, "Reset");
            if (EXPECT[relation].ahead) {
              assert.match(q.message, /3 commits on 'feature' are not on 'origin\/feature', and the reset takes them off the branch:/);
              assert.match(q.message, /local three\n.*local two\n.*local one/);
            } else {
              assert.doesNotMatch(q.message, /commits? on 'feature'/);
            }
            if (current && dirty) {
              assert.match(q.message, /Uncommitted changes to 2 files are discarded\./);
              assert.match(q.message, /Undo can put the branch back, with your uncommitted changes\./);
            } else {
              assert.doesNotMatch(q.message, /Uncommitted/, "a branch that isn't checked out takes no working tree with it");
            }
            if (EXPECT[relation].behind) {
              assert.match(q.message, /also gets the 2 commits on 'origin\/feature' it doesn't have yet/);
            }
          }

          // Run it, as the Undo envelope does: snapshot, op, settle.
          const snap = await f.ctx.snapshot.capture("Reset feature to origin/feature", { branch: "refs/heads/feature" });
          assert.deepEqual(snap.branch && { ref: snap.branch.ref, sha: snap.branch.sha, checkedOut: snap.branch.checkedOut }, {
            ref: "refs/heads/feature",
            sha: before,
            checkedOut: current,
          });
          const r = await runReset(f.ctx.process, p);
          assert.equal(r.ok, true, r.stderr);
          await f.ctx.snapshot.settle(snap);
          assert.equal(snap.branch?.after, fresh);

          assert.equal(f.git("rev-parse", "refs/heads/feature"), fresh, "the branch is the remote's, 1:1");
          assert.equal(f.git("symbolic-ref", "HEAD"), headBefore, "HEAD stays on the branch it was on");
          if (current) {
            assert.equal(f.git("status", "--porcelain"), "", "the working tree is the remote's too");
            assert.equal(read(f, "f.txt"), relation === "behind" || relation === "diverged" ? "remote\n" : "base\n");
          } else {
            // Another branch was moved: this worktree is not its business.
            assert.equal(read(f, "f.txt"), dirty ? "my unstaged edit\n" : "base\n");
            assert.equal(read(f, "g.txt"), dirty ? "my staged edit\n" : "g\n");
            assert.equal(f.git("diff", "--cached", "--name-only"), dirty ? "g.txt" : "", "the index is untouched");
          }

          // Undo puts it back.
          assert.equal(await f.ctx.snapshot.whyNotRestorable(snap), undefined);
          await f.ctx.snapshot.restore(snap);
          assert.equal(f.git("rev-parse", "refs/heads/feature"), before, "the branch is back where it was");
          assert.equal(f.git("symbolic-ref", "HEAD"), headBefore);
          assert.equal(read(f, "f.txt"), dirty ? "my unstaged edit\n" : "base\n", "and the uncommitted edits with it");
          assert.equal(read(f, "g.txt"), dirty ? "my staged edit\n" : "g\n");
        } finally {
          f.ctx.dispose();
        }
      });
    }
  }
}

test("refused up front: no upstream, a local upstream, not a local branch", async () => {
  const f = fixture();
  try {
    f.git("branch", "-q", "--no-track", "topic", "main");
    f.git("branch", "-q", "--track", "follows-main", "main"); // upstream: the LOCAL main
    const none = await resetTargetOf(f.ctx.process, "refs/heads/topic");
    assert.ok(isResetRefusal(none));
    assert.match(none.refused, /'topic' doesn't track a remote branch/);
    const local = await resetTargetOf(f.ctx.process, "refs/heads/follows-main");
    assert.ok(isResetRefusal(local));
    assert.match(local.refused, /'follows-main' tracks 'main', a branch in this repository, not on a remote/);
    const remote = await resetTargetOf(f.ctx.process, "refs/remotes/origin/main");
    assert.ok(isResetRefusal(remote));
    const gone = await resetTargetOf(f.ctx.process, "refs/heads/no-such-branch");
    assert.ok(isResetRefusal(gone));
    assert.match(gone.refused, /not in this repository any more/);
  } finally {
    f.ctx.dispose();
  }
});

test("refused after the fetch: the upstream is gone from the remote", async () => {
  const f = fixture();
  try {
    f.other("push", "-q", "origin", "--delete", "feature");
    const t = await target(f);
    assert.equal(await fetchResetTarget(f.ctx.process, t), true);
    // A plain fetch keeps the stale remote-tracking ref; a pruning one drops it.
    f.git("fetch", "-q", "--prune", "origin");
    const p = await planReset(f.ctx.process, t);
    assert.ok(isResetRefusal(p));
    assert.match(p.refused, /There is no 'origin\/feature' to reset to — it is not on origin any more\./);
  } finally {
    f.ctx.dispose();
  }
});

test("refused: checked out in another worktree — and git itself refuses it too", async () => {
  const f = fixture();
  try {
    shape(f, "ahead");
    const wt = join(scratch, `wt-${++seq}`);
    f.git("worktree", "add", "-q", wt, "feature");
    const t = await resetTargetOf(f.ctx.process, "refs/heads/feature");
    assert.ok(isResetRefusal(t));
    assert.match(t.refused, /'feature' is checked out in another worktree, at .*wt-\d+\. Reset it there/);
    // The belt behind the braces: branch -f, as runReset would run it.
    const forced = await f.ctx.process.run(["branch", "-f", "--", "feature", "refs/remotes/origin/feature"]);
    assert.notEqual(forced.code, 0, "git refuses to move a branch another worktree has checked out");
  } finally {
    f.ctx.dispose();
  }
});

test("refused: a branch named like an option is never put on argv", async () => {
  const f = fixture();
  try {
    const tip = f.git("rev-parse", "refs/heads/feature");
    f.git("update-ref", "refs/heads/-f", tip); // porcelain would never make one; update-ref does
    f.git("config", "branch.-f.remote", "origin");
    f.git("config", "branch.-f.merge", "refs/heads/feature");
    const t = await resetTargetOf(f.ctx.process, "refs/heads/-f");
    assert.ok(isResetRefusal(t));
    assert.match(t.refused, /a branch name that starts with "-" reads as an option/);
  } finally {
    f.ctx.dispose();
  }
});

test("refused on the checked-out branch while git is stopped in a merge — reset --hard would end it", async () => {
  const f = fixture();
  try {
    f.git("checkout", "-q", "feature");
    writeFileSync(join(f.dir, "f.txt"), "feature side\n");
    f.git("commit", "-qam", "feature side");
    f.git("checkout", "-q", "-b", "side", "origin/main");
    writeFileSync(join(f.dir, "f.txt"), "side\n");
    f.git("commit", "-qam", "side");
    f.git("checkout", "-q", "feature");
    try {
      f.git("merge", "side");
    } catch {
      /* stops on the conflict, as intended */
    }
    assert.ok(existsSync(join(f.dir, ".git", "MERGE_HEAD")));
    const t = await target(f);
    const p = await planReset(f.ctx.process, t);
    assert.ok(isResetRefusal(p));
    assert.match(p.refused, /A merge is still in progress, with 1 file still conflicted\. .* before resetting\./);
    assert.ok(existsSync(join(f.dir, ".git", "MERGE_HEAD")), "and nothing ended it");
  } finally {
    f.ctx.dispose();
  }
});

test("a tag sharing the branch's name: the BRANCH is reset, and the tag is left alone", async () => {
  const f = fixture();
  try {
    shape(f, "diverged");
    const tagAt = f.git("rev-parse", "refs/heads/main");
    f.git("tag", "feature", tagAt);
    const t = await target(f);
    await fetchResetTarget(f.ctx.process, t);
    const p = await plan(f, t);
    assert.equal(p.ahead, 3, "counted against the branch, not the tag");
    assert.equal((await runReset(f.ctx.process, p)).ok, true);
    assert.equal(f.git("rev-parse", "refs/heads/feature"), f.git("rev-parse", "refs/remotes/origin/feature"));
    assert.equal(f.git("rev-parse", "refs/tags/feature"), tagAt);
  } finally {
    f.ctx.dispose();
  }
});

test("the branch moves between the question and the answer: nothing runs", async () => {
  for (const current of [true, false]) {
    const f = fixture();
    try {
      shape(f, "ahead");
      if (current) f.git("checkout", "-q", "feature");
      const t = await target(f);
      await fetchResetTarget(f.ctx.process, t);
      const p = await plan(f, t);
      // Somebody commits on it while the dialog is up.
      const tip = f.git("rev-parse", "refs/heads/feature");
      const moved = f.git("commit-tree", f.git("rev-parse", `${tip}^{tree}`), "-p", tip, "-m", "made meanwhile");
      f.git("update-ref", "refs/heads/feature", moved);
      const r = await runReset(f.ctx.process, p);
      assert.equal(r.ok, false);
      assert.match(r.refused ?? "", /'feature' moved while you were being asked .* Nothing was reset/);
      assert.equal(f.git("rev-parse", "refs/heads/feature"), moved, "the commit made meanwhile is still there");
    } finally {
      f.ctx.dispose();
    }
  }
});

test("the remote cannot be reached: the plan uses the target as last fetched, and says so", async () => {
  const f = fixture();
  try {
    shape(f, "ahead");
    f.git("remote", "set-url", "origin", join(scratch, "no-such-remote.git"));
    const t = await target(f);
    assert.equal(await fetchResetTarget(f.ctx.process, t), false);
    const p = await plan(f, t, true);
    assert.equal(p.fetchFailed, true);
    const q = resetQuestion(p);
    assert.equal(q.kind, "confirm");
    assert.match(q.kind === "confirm" ? q.message : "", /origin couldn't be reached, so this uses 'origin\/feature' as it was when last fetched\./);
  } finally {
    f.ctx.dispose();
  }
});

test("untracked files the target has at their path are counted — reset --hard overwrites them unasked", async () => {
  const f = fixture();
  try {
    shape(f, "behind"); // the remote adds r.txt
    f.git("checkout", "-q", "feature");
    writeFileSync(join(f.dir, "r.txt"), "mine, untracked\n");
    writeFileSync(join(f.dir, "unrelated.txt"), "mine too\n");
    const t = await target(f);
    await fetchResetTarget(f.ctx.process, t);
    const p = await plan(f, t);
    assert.equal(p.untrackedOverwritten, 1, "r.txt, not unrelated.txt");
    const q = resetQuestion(p);
    assert.equal(q.kind === "confirm" && q.danger, true, "something is lost, so it is not a plain fast-forward");
    assert.match(q.kind === "confirm" ? q.message : "", /1 untracked file is overwritten by what 'origin\/feature' has at its path\./);
    assert.match(q.kind === "confirm" ? q.message : "", /It can't bring back the overwritten untracked file\./);
  } finally {
    f.ctx.dispose();
  }
});

test("a door's own target: 'Checkout origin/x' resets x to the ref it names", async () => {
  const f = fixture();
  try {
    shape(f, "diverged");
    const t = await target(f, "refs/heads/feature", "refs/remotes/origin/feature");
    assert.equal(t.remote, "origin");
    await fetchResetTarget(f.ctx.process, t);
    const p = await plan(f, t);
    assert.equal((await runReset(f.ctx.process, p)).ok, true);
    assert.equal(f.git("rev-parse", "refs/heads/feature"), f.git("rev-parse", "refs/remotes/origin/feature"));
  } finally {
    f.ctx.dispose();
  }
});

test("Undo refuses where putting the branch back would lose something, or land in the wrong place", async () => {
  // Moved since the reset.
  {
    const f = fixture();
    try {
      shape(f, "ahead");
      const t = await target(f);
      await fetchResetTarget(f.ctx.process, t);
      const p = await plan(f, t);
      const snap = await f.ctx.snapshot.capture("Reset", { branch: "refs/heads/feature" });
      await runReset(f.ctx.process, p);
      await f.ctx.snapshot.settle(snap);
      const tip = f.git("rev-parse", "refs/heads/feature");
      f.git("update-ref", "refs/heads/feature", f.git("commit-tree", f.git("rev-parse", `${tip}^{tree}`), "-p", tip, "-m", "later"));
      assert.match((await f.ctx.snapshot.whyNotRestorable(snap)) ?? "", /'feature' has moved since .* would throw that away/);
    } finally {
      f.ctx.dispose();
    }
  }
  // Reset while checked out, then switched away: its working tree is not here.
  {
    const f = fixture();
    try {
      shape(f, "ahead");
      f.git("checkout", "-q", "feature");
      const t = await target(f);
      await fetchResetTarget(f.ctx.process, t);
      const p = await plan(f, t);
      const snap = await f.ctx.snapshot.capture("Reset", { branch: "refs/heads/feature" });
      await runReset(f.ctx.process, p);
      await f.ctx.snapshot.settle(snap);
      f.git("checkout", "-q", "main");
      assert.match((await f.ctx.snapshot.whyNotRestorable(snap)) ?? "", /was checked out here when it was reset, and it isn't now/);
    } finally {
      f.ctx.dispose();
    }
  }
  // Reset while NOT checked out, then checked out ("Checkout origin/x → Reset"):
  // it goes back with `reset --keep`, and uncommitted edits stay.
  {
    const f = fixture();
    try {
      shape(f, "ahead");
      const before = f.git("rev-parse", "refs/heads/feature");
      const t = await target(f);
      await fetchResetTarget(f.ctx.process, t);
      const p = await plan(f, t);
      const snap = await f.ctx.snapshot.capture("Reset", { branch: "refs/heads/feature" });
      await runReset(f.ctx.process, p);
      await f.ctx.snapshot.settle(snap);
      f.git("checkout", "-q", "feature");
      writeFileSync(join(f.dir, "g.txt"), "edited after the checkout\n");
      assert.equal(await f.ctx.snapshot.whyNotRestorable(snap), undefined);
      await f.ctx.snapshot.restore(snap);
      assert.equal(f.git("rev-parse", "refs/heads/feature"), before);
      assert.equal(f.git("symbolic-ref", "HEAD"), "refs/heads/feature");
      assert.equal(read(f, "g.txt"), "edited after the checkout\n", "reset --keep kept the edit");
    } finally {
      f.ctx.dispose();
    }
  }
  // Checked out in another worktree since.
  {
    const f = fixture();
    try {
      shape(f, "ahead");
      const t = await target(f);
      await fetchResetTarget(f.ctx.process, t);
      const p = await plan(f, t);
      const snap = await f.ctx.snapshot.capture("Reset", { branch: "refs/heads/feature" });
      await runReset(f.ctx.process, p);
      await f.ctx.snapshot.settle(snap);
      f.git("worktree", "add", "-q", join(scratch, `wt-${++seq}`), "feature");
      assert.match((await f.ctx.snapshot.whyNotRestorable(snap)) ?? "", /checked out in another worktree, at .*\. Undo it there\./);
    } finally {
      f.ctx.dispose();
    }
  }
});

test("a snapshot that names no branch restores exactly as before", async () => {
  const f = fixture();
  try {
    const snap = await f.ctx.snapshot.capture("plain");
    assert.equal(snap.branch, undefined);
    assert.equal(await f.ctx.snapshot.whyNotRestorable(snap), undefined);
  } finally {
    f.ctx.dispose();
  }
});

test("which branches the menu offers the reset on: a tracked remote branch the repo has, and nothing else", async () => {
  const f = fixture();
  try {
    f.git("branch", "-q", "--no-track", "topic", "main");
    f.git("branch", "-q", "--track", "follows-main", "main");
    f.git("branch", "-q", "--track", "doomed", "refs/remotes/origin/main");
    f.git("push", "-q", "origin", "refs/heads/doomed:refs/heads/doomed");
    f.git("branch", "-q", "--set-upstream-to", "refs/remotes/origin/doomed", "doomed");
    f.other("push", "-q", "origin", "--delete", "doomed");
    f.git("fetch", "-q", "--prune", "origin"); // doomed's upstream is now [gone]
    // A LOCAL branch literally called "origin/feature" makes the short names
    // "remotes/origin/feature" — the rule still holds.
    f.git("branch", "-q", "--no-track", "origin/feature", "main");
    const set = resettableBranches(await f.ctx.refs.listRefs());
    assert.ok(set.has("main"), [...set].join(" "));
    assert.ok(set.has("feature"), [...set].join(" "));
    for (const no of ["topic", "follows-main", "doomed", "origin/feature"]) {
      assert.ok(!set.has(no), `${no} is not offered (${[...set].join(" ")})`);
    }
  } finally {
    f.ctx.dispose();
  }
});

test("'Checkout origin/x' over a local x: asked only when x has commits of its own", async () => {
  for (const relation of ["equal", "behind", "ahead", "diverged"] as Relation[]) {
    const f = fixture();
    try {
      shape(f, relation);
      f.git("fetch", "-q", "origin");
      const got = await localMovedOnFrom(f.ctx.process, "refs/remotes/origin/feature");
      if (relation === "equal" || relation === "behind") {
        assert.equal(got, undefined, `${relation}: the checkout just switches, as it always has`);
      } else {
        assert.deepEqual(got, {
          fullName: "refs/heads/feature",
          branch: "feature",
          ahead: 3,
          behind: relation === "diverged" ? 2 : 0,
        });
      }
    } finally {
      f.ctx.dispose();
    }
  }
  const f = fixture();
  try {
    assert.equal(await localMovedOnFrom(f.ctx.process, "refs/remotes/origin/main"), undefined, "main equals origin/main");
    f.git("branch", "-q", "-D", "feature");
    assert.equal(await localMovedOnFrom(f.ctx.process, "refs/remotes/origin/feature"), undefined, "no local branch: nothing to ask");
  } finally {
    f.ctx.dispose();
  }
});
