import { test } from "node:test";
import assert from "node:assert/strict";
import { FIVE, edit, germanLocale } from "./opRepo";
import * as S from "./opScenarios";
import type { Stopped } from "./opScenarios";

/**
 * THE STATE TABLE (PLAN §4 P2; memory: state-tables-beat-sweeps).
 *
 * Rows: every stopped state git can leave — merge, rebase on both backends, a
 * `--rebase-merges` merge step, cherry-pick (single and range), revert,
 * `am -3`, a plain `am` that left nothing unmerged, stash pop, an autostash
 * that conflicted on the way back, and none.
 *
 * Columns: conflicted, resolved to stage 2, resolved to stage 3, resolved by
 * hand, and the three deliberate pauses (edit / break / exec).
 *
 * Each cell asserts what the state is NAMED (kind, backend, which stage is
 * Yours, the real branch names, step N of M), what its verbs CAN do
 * (canContinue / canSkip / continueBlocked / willDrop) and what the repository
 * looks like after pressing the verb it offers. A cell asserts capability,
 * never a button's wording — the UI may say anything; git must agree.
 */

async function withStop<T>(build: () => Stopped, fn: (s: Stopped) => Promise<T>): Promise<T> {
  const s = build();
  try {
    return await fn(s);
  } finally {
    s.r.cleanup();
  }
}

const line = (text: string, n: number): string => text.split("\n")[n - 1];

// ── merge ───────────────────────────────────────────────────────────────────

test("merge × conflicted: named, blocked, and Abort puts master back", () =>
  withStop(S.mergeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "merge");
    assert.equal(v.backend, undefined);
    assert.equal(v.yours.stage, 2, "a merge is not reversed");
    assert.equal(v.yours.name, "master");
    assert.equal(v.theirs.name, "test");
    assert.equal(v.title, "Merging test into master");
    assert.deepEqual(v.direction, { from: "theirs", verb: "into", to: "yours" });
    assert.equal(v.step, undefined);
    assert.equal(v.canContinue, false);
    assert.equal(v.canSkip, false, "there is no merge --skip");
    assert.equal(v.verbs.skip, undefined);
    assert.equal(v.continueBlocked, "f.txt still has conflicts");
    assert.equal((await ctx.operation.skip()).refused, "not-allowed");

    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Merge aborted");
    assert.equal(r.exists(".git/MERGE_HEAD"), false);
    assert.equal(r.sha("HEAD"), sha.master);
    assert.equal(r.git("status", "--porcelain").trim(), "");
  }));

test("merge × resolved to stage 2: Continue records a two-parent merge", () =>
  withStop(S.mergeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeStage("f.txt", 2)).ok, true);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, true, "an empty merge commit is legal");
    assert.equal(v.willDrop, undefined);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Merge complete");
    assert.equal(r.git("log", "-1", "--format=%P").trim().split(" ").length, 2);
    assert.equal(r.sha("HEAD^1"), sha.master);
    assert.equal(r.sha("HEAD^2"), sha.test);
  }));

test("merge × resolved to stage 3: Continue keeps theirs", () =>
  withStop(S.mergeStop, async ({ r }) => {
    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeStage("f.txt", 3)).ok, true);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("show", "HEAD:f.txt"), edit(FIVE, { three: "three-test", five: "five-test" }));
  }));

test("merge × resolved by hand: the commit message carries no '# Conflicts:' lines", () =>
  withStop(S.mergeStop, async ({ r }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-R", five: "five-R" }));
    r.git("add", "f.txt");
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    const msg = r.git("log", "-1", "--format=%B");
    assert.equal(msg.trim(), "Merge branch 'test'", "git's '# Conflicts:' block is stripped (continue.out)");
    assert.doesNotMatch(msg, /Conflicts/);
  }));

test("merge × markers staged: Continue is refused and names the file", () =>
  withStop(S.mergeStop, async ({ r }) => {
    const ctx = r.ctx();
    r.git("add", "f.txt"); // markers and all — git now thinks it is resolved
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, false);
    assert.equal(v.continueBlocked, "f.txt still has conflict markers staged");
    const out = await ctx.operation.continue();
    assert.equal(out.refused, "blocked");
    assert.equal(r.exists(".git/MERGE_HEAD"), true, "nothing was committed");
  }));

test("a marker-shaped line in a file that was never conflicted does not block Continue", () =>
  withStop(S.mergeStop, async ({ r }) => {
    // A merge tool's own test fixture, added on master's side of the merge.
    const ctx = r.ctx();
    r.write("fixture.txt", "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n");
    r.git("add", "fixture.txt");
    r.write("f.txt", edit(FIVE, { three: "three-R", five: "five-R" }));
    r.git("add", "f.txt");
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, true, v.continueBlocked);
  }));

// ── rebase, merge backend ───────────────────────────────────────────────────

test("rebase (merge backend) × conflicted: Yours is test's commit, commit 2 of 3", () =>
  withStop(S.rebaseMergeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "rebase");
    assert.equal(v.backend, "merge");
    assert.equal(v.yours.stage, 3);
    assert.equal(v.yours.name, "test");
    assert.equal(v.theirs.name, "master");
    assert.deepEqual(v.step, { n: 2, m: 3, unit: "commit" });
    assert.equal(v.commit?.sha, sha.t2);
    assert.ok(v.title.startsWith("Rebasing test onto master · commit 2 of 3"), v.title);
    assert.equal(v.canContinue, false);
    assert.equal(v.canSkip, false);
    assert.equal(v.verbs.skip, undefined, "the merge backend has no Skip to offer");

    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Rebase aborted");
    assert.equal(r.exists(".git/rebase-merge"), false);
    assert.equal(r.git("symbolic-ref", "HEAD").trim(), "refs/heads/test");
    assert.equal(r.sha("test"), sha.test, "the branch is where it started");
  }));

test("rebase (merge backend) × resolved to stage 2: the emptied commit needs a confirm, then git drops it", () =>
  withStop(S.rebaseMergeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeStage("f.txt", 2)).ok, true);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, true);
    assert.deepEqual(v.willDrop, { sha: sha.t2, subject: "test: edit line 3", branch: "test" });
    assert.equal((await ctx.operation.continue()).refused, "confirm-drop");
    const out = await ctx.operation.continue({ confirmDrop: true });
    // T3 then conflicts with master's line 5: a stop at 3 of 3, not a failure.
    assert.equal(out.stopped, true, out.message);
    assert.deepEqual(out.view.step, { n: 3, m: 3, unit: "commit" });
    assert.equal(out.view.commit?.sha, sha.t3);
  }));

test("rebase (merge backend) × resolved to stage 3: Continue replays the rest", () =>
  withStop(S.rebaseMergeStop, async ({ r }) => {
    const ctx = r.ctx();
    assert.equal((await ctx.conflictOps.takeStage("f.txt", 3)).ok, true);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, true);
    assert.equal(v.willDrop, undefined);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(r.git("log", "--format=%s", "master..test").trim().split("\n"), [
      "test: edit line 5",
      "test: edit line 3",
      "test: add g",
    ]);
  }));

test("rebase (merge backend) × resolved by hand: Continue stops at the next conflict", () =>
  withStop(S.rebaseMergeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-R", five: "five-master" }));
    r.git("add", "f.txt");
    const out = await ctx.operation.continue();
    assert.equal(out.ok, false);
    assert.equal(out.stopped, true);
    assert.equal(out.view.commit?.sha, sha.t3);
    assert.equal(out.remainingConflicts, 1);
  }));

test("rebase × an unstaged change to a tracked file: Continue explains, instead of git's misleading refusal", () =>
  withStop(S.rebaseMergeStop, async ({ r }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 3);
    r.write("g.txt", "g\ndirty\n");
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, false);
    assert.equal(
      v.continueBlocked,
      "g.txt has changes that aren't staged. Stage or stash them first — git won't continue a rebase with unstaged changes.",
    );
    assert.equal((await ctx.operation.continue()).refused, "blocked");
    r.write("g.txt", "g\n");
    assert.equal((await ctx.operation.view()).canContinue, true, "and it clears once the change is gone");
  }));

test("rebase -i × a fast-forwarded first pick, then an emptied one: the drop still needs a confirm", () =>
  withStop(S.rebaseSkippedPicksStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v0 = await ctx.operation.view();
    assert.equal(v0.kind, "rebase");
    assert.equal(v0.commit?.sha, sha.t3, "stopped on T3, reordered before T2");
    assert.equal(r.sha("HEAD"), sha.t1, "T1 was fast-forwarded, not replayed");
    // Keep HEAD's side (git's stage 2): T3's change is gone from the result.
    assert.equal((await ctx.conflictOps.takeRole("f.txt", "theirs")).ok, true);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, true);
    assert.deepEqual(
      v.willDrop,
      { sha: sha.t3, subject: "T3 line 3 b", branch: "test" },
      "HEAD is where the rebase put it (a skipped pick), so git WILL drop T3 on Continue",
    );
    assert.equal((await ctx.operation.continue()).refused, "confirm-drop");
    assert.equal(r.exists(".git/rebase-merge"), true, "nothing ran");
    const out = await ctx.operation.continue({ confirmDrop: true });
    assert.equal(out.ok, true, out.message);
    assert.deepEqual(r.git("log", "--format=%s", `${sha.base}..test`).trim().split("\n"), [
      "T2 line 3 a",
      "T1 add g",
    ], "the drop the user confirmed");
  }));

// ── rebase, apply backend ───────────────────────────────────────────────────

test("rebase (apply backend) × conflicted: named as a rebase with a Skip verb, not yet allowed", () =>
  withStop(S.rebaseApplyStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "rebase");
    assert.equal(v.backend, "apply");
    assert.equal(v.yours.stage, 3);
    assert.equal(v.yours.name, "test");
    assert.equal(v.theirs.name, "master");
    assert.deepEqual(v.step, { n: 2, m: 3, unit: "commit" });
    assert.equal(v.commit?.sha, sha.t2);
    assert.equal(v.verbs.skip, "Skip this commit");
    assert.equal(v.canSkip, false, "not while conflicted");
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.exists(".git/rebase-apply"), false);
    assert.equal(r.sha("test"), sha.test);
  }));

test("rebase (apply backend) × resolved to stage 2: Continue is refused, Skip is the way on", () =>
  withStop(S.rebaseApplyStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 2);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, false, "this backend refuses --continue on an emptied patch");
    assert.equal(v.continueBlocked, "The resolution leaves nothing to commit for this commit. Skip it instead.");
    assert.equal(v.canSkip, true);
    assert.equal(v.willDrop, undefined, "nothing is dropped silently here — git refuses instead");
    const out = await ctx.operation.skip();
    assert.equal(out.stopped, true, out.message);
    assert.equal(out.view.commit?.sha, sha.t3, "T3 conflicts next");
  }));

test("rebase (apply backend) × resolved to stage 3: Continue finishes", () =>
  withStop(S.rebaseApplyStop, async ({ r }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 3);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, true);
    assert.equal(v.canSkip, false);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.exists(".git/rebase-apply"), false);
    assert.equal(r.git("log", "--format=%s", "master..test").trim().split("\n").length, 3);
  }));

// ── rebase --rebase-merges, stopped in a merge step ─────────────────────────

test("rebase-merge-step × conflicted: named for the merge it re-creates, ended only by rebase verbs", () =>
  withStop(S.rebaseMergeStepStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "rebase-merge-step");
    assert.equal(v.backend, "merge");
    assert.equal(v.yours.stage, 2, "a merge step is not reversed");
    assert.equal(v.yours.name, "feat");
    assert.equal(v.theirs.name, "side", "the label git re-merges, not refs/rewritten/side");
    assert.equal(v.title, "Re-creating merge of side into feat · step 3 of 3");
    assert.deepEqual(v.step, { n: 3, m: 3, unit: "step" });
    assert.equal(v.verbs.continue, "Continue Rebase");
    assert.equal(v.verbs.abort, "Abort Rebase");
    assert.equal(v.canSkip, false);
    // Abort must be `rebase --abort`: `merge --abort` would drop the hand
    // resolution and leave the rebase running underneath.
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.exists(".git/rebase-merge"), false);
    assert.equal(r.exists(".git/MERGE_HEAD"), false);
    assert.equal(r.sha("feat"), sha.feat);
  }));

test("rebase-merge-step × resolved to stage 2: Continue still records the merge", () =>
  withStop(S.rebaseMergeStepStop, async ({ r }) => {
    // git alone finishes this rebase WITHOUT the merge commit and leaves
    // MERGE_HEAD dangling — `side` falls out of feat's history (exp4.sh).
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 2);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, true);
    assert.equal(v.willDrop, undefined, "a merge step never drops a commit");
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Rebase complete");
    assert.equal(r.exists(".git/MERGE_HEAD"), false, "no merge left dangling");
    assert.equal(r.git("log", "-1", "--format=%P", "feat").trim().split(" ").length, 2, "the merge is recorded");
    assert.equal(r.git("log", "-1", "--format=%s", "feat").trim(), "Merge branch 'side' into feat");
    assert.match(r.git("log", "--format=%s", "master..feat"), /side: line 2/, "side's commit is still in feat's history");
  }));

test("rebase-merge-step × resolved by hand: Continue finishes the rebase with the merge", () =>
  withStop(S.rebaseMergeStepStop, async ({ r }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { two: "two-merged", five: "five-master" }));
    r.git("add", "f.txt");
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("show", "feat:f.txt"), edit(FIVE, { two: "two-merged", five: "five-master" }));
    assert.equal(r.git("log", "-1", "--format=%P", "feat").trim().split(" ").length, 2);
  }));

// ── cherry-pick ─────────────────────────────────────────────────────────────

test("cherry-pick × conflicted: the picked commit is Theirs, Skip always offered", () =>
  withStop(S.cherryPickStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "cherry-pick");
    assert.equal(v.yours.stage, 2);
    assert.equal(v.yours.name, "master");
    assert.equal(v.theirs.name, sha.t2.slice(0, 7));
    assert.equal(v.title, `Cherry-picking ${sha.t2.slice(0, 7)} test: edit line 3 onto master`);
    assert.equal(v.queued, undefined);
    assert.equal(v.canSkip, true);
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true);
    assert.equal(r.exists(".git/CHERRY_PICK_HEAD"), false);
    assert.equal(r.sha("HEAD"), sha.master);
  }));

test("cherry-pick × resolved to stage 2: nothing to commit, so Skip", () =>
  withStop(S.cherryPickStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 2);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, false);
    assert.equal(v.continueBlocked, "The resolution leaves nothing to commit for this commit. Skip it instead.");
    assert.equal(v.canSkip, true);
    const refused = await ctx.operation.continue();
    assert.equal(refused.refused, "blocked", "refused before git ever said 'now empty'");
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Last commit skipped. Cherry-pick complete, without it");
    assert.equal(r.exists(".git/CHERRY_PICK_HEAD"), false);
    assert.equal(r.sha("HEAD"), sha.master);
  }));

test("cherry-pick × resolved to stage 3: Continue commits the pick", () =>
  withStop(S.cherryPickStop, async ({ r }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 3);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Cherry-pick complete");
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "test: edit line 3");
  }));

test("cherry-pick range × conflicted then continued: queued count, next stop, then Skip ends it", () =>
  withStop(S.cherryPickRangeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.queued, 1);
    assert.ok(v.title.endsWith(" · 1 more queued"), v.title);
    r.write("f.txt", edit(FIVE, { three: "three-R", five: "five-master" }));
    r.git("add", "f.txt");
    const out = await ctx.operation.continue();
    assert.equal(out.stopped, true, out.message);
    assert.equal(out.view.commit?.sha, sha.t3);
    assert.equal(out.view.queued, undefined, "nothing after the last one");
    const skipped = await ctx.operation.skip();
    assert.equal(skipped.ok, true, skipped.message);
    assert.equal(skipped.message, "Last commit skipped. Cherry-pick complete, without it", "T3 was the last one");
    assert.equal(r.exists(".git/sequencer"), false);
  }));

test("cherry-pick range × the current pick committed by hand: still an operation, Continue carries on", () =>
  withStop(S.cherryPickRangeStop, async ({ r }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-R", five: "five-master" }));
    r.git("add", "f.txt");
    r.git("commit", "-q", "--no-edit");
    const v = await ctx.operation.view();
    assert.equal(v.kind, "cherry-pick", "CHERRY_PICK_HEAD is gone; sequencer/todo is not");
    assert.equal(v.canContinue, true);
    assert.equal(v.canSkip, false, "there is no current pick to skip");
    const out = await ctx.operation.continue();
    assert.equal(out.stopped, true, out.message); // T3 conflicts next
  }));

test("cherry-pick range × a commit made by hand, then Abort: git does not rewind, and says so", () =>
  withStop(S.cherryPickRangeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-R", five: "five-master" }));
    r.git("add", "f.txt");
    r.git("commit", "-q", "--no-edit");
    const handMade = r.sha("HEAD");
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.exists(".git/sequencer"), false, "the queue is gone");
    assert.equal(r.sha("HEAD"), handMade, "git declined to rewind: the picks are still on the branch");
    assert.notEqual(r.sha("HEAD"), sha.master);
    assert.match(out.message ?? "", /git left the branch where it is/, "never a bare 'aborted' over commits that stayed");
  }));

test("cherry-pick range × Abort at the stop: the whole range is rewound, with no caveat", () =>
  withStop(S.cherryPickRangeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Cherry-pick aborted");
    assert.equal(r.sha("HEAD"), sha.master, "T1, already picked, is undone too");
  }));

// ── revert ──────────────────────────────────────────────────────────────────

test("revert × conflicted: Theirs is the undo, never 'parent of'", () =>
  withStop(S.revertStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "revert");
    assert.equal(v.yours.stage, 2);
    assert.equal(v.theirs.name, `undo of ${sha.m1.slice(0, 7)}`);
    assert.equal(v.theirs.paneTitle, `Undo of ${sha.m1.slice(0, 7)} M1 line 3`);
    assert.equal(v.title, `Reverting ${sha.m1.slice(0, 7)} M1 line 3 on master`);
    assert.deepEqual(v.direction, { from: "theirs", verb: "on", to: "yours" });
    assert.equal(v.canSkip, true);
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true);
    assert.equal(r.sha("HEAD"), sha.m2);
  }));

test("revert × resolved by hand: Continue commits the revert", () =>
  withStop(S.revertStop, async ({ r }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-R" }));
    r.git("add", "f.txt");
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("log", "-1", "--format=%s").trim(), 'Revert "M1 line 3"');
  }));

test("revert × resolved to stage 2: Skip ends it", () =>
  withStop(S.revertStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 2);
    assert.equal((await ctx.operation.view()).canContinue, false);
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.sha("HEAD"), sha.m2);
  }));

test("revert range × conflicted: a revert with one more queued", () =>
  withStop(S.revertRangeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "revert");
    assert.equal(v.queued, 1);
    assert.equal(v.commit?.sha, sha.a);
    assert.equal(v.verbs.continue, "Continue Revert");
  }));

test("revert range × the current revert committed by hand: still a REVERT, and Continue carries on", () =>
  withStop(S.revertRangeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-by-hand" }));
    r.git("add", "f.txt");
    r.git("commit", "-q", "-m", "hand revert of A");
    const v = await ctx.operation.view();
    assert.equal(v.kind, "revert", "REVERT_HEAD is gone; the queue of reverts is not");
    assert.equal((await ctx.operation.detect()).kind, "revert");
    assert.equal(v.canContinue, true);
    assert.equal(v.canSkip, false, "there is no current revert to skip");
    // `cherry-pick --continue` here is refused by git: "cannot cherry-pick during a revert".
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Revert complete");
    assert.deepEqual(r.git("log", "--format=%s", `${sha.c}..HEAD`).trim().split("\n"), [
      'Revert "C add h"',
      "hand revert of A",
    ]);
    assert.equal(r.exists(".git/sequencer"), false);
  }));

test("revert range × a revert made by hand, then Abort: the warning names the revert", () =>
  withStop(S.revertRangeStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-by-hand" }));
    r.git("add", "f.txt");
    r.git("commit", "-q", "-m", "hand revert of A");
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.match(out.message ?? "", /^The revert was stopped, but HEAD had moved/);
    assert.notEqual(r.sha("HEAD"), sha.c);
    assert.equal(r.exists(".git/sequencer"), false);
  }));

// ── am ──────────────────────────────────────────────────────────────────────

test("am -3 × conflicted: named as git am, and Abort runs am --abort (not rebase --abort)", () =>
  withStop(S.am3Stop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "am");
    assert.equal(v.yours.stage, 2, "am is not reversed");
    assert.equal(v.yours.name, "master");
    assert.equal(v.theirs.name, "patch 1/1");
    assert.equal(v.title, "Applying patch 1 of 1: test: edit line 3 (by Dev) onto master");
    assert.deepEqual(v.step, { n: 1, m: 1, unit: "patch" });
    assert.equal(v.canSkip, true);
    assert.equal(v.verbs.abort, "Abort (git am)");
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Patch series abandoned");
    assert.equal(r.exists(".git/rebase-apply"), false, "the am session is over");
    assert.equal(r.sha("HEAD"), sha.master);
  }));

test("am -3 × resolved by hand: Continue applies the patch with its own message", () =>
  withStop(S.am3Stop, async ({ r }) => {
    const ctx = r.ctx();
    r.write("f.txt", edit(FIVE, { three: "three-R", five: "five-master" }));
    r.git("add", "f.txt");
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "All patches applied");
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "test: edit line 3");
  }));

test("am × HEAD moved since the stop: Abort says git declined to rewind", () =>
  withStop(S.am3Stop, async ({ r }) => {
    const ctx = r.ctx();
    r.git("reset", "-q", "--hard", "HEAD");
    r.write("j.txt", "moved\n");
    r.git("add", "j.txt");
    r.git("commit", "-q", "-m", "moved");
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.match(out.message ?? "", /HEAD had moved/);
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "moved", "git left HEAD where it was");
  }));

test("am -3 × resolved to stage 2: nothing left of the patch, so Skip", () =>
  withStop(S.am3Stop, async ({ r, sha }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 2);
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, false);
    assert.equal(v.continueBlocked, "Nothing is staged for this patch. Apply it by hand and stage the result, or skip the patch.");
    assert.equal(v.canSkip, true);
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    // The verifier: skipping the last patch said "All patches applied" — of a
    // series whose one patch was just left out.
    assert.equal(out.message, "Last patch skipped. The series is finished, without it");
    assert.equal(r.sha("HEAD"), sha.master);
    assert.equal(r.exists(".git/rebase-apply"), false);
  }));

test("am -3 × resolved to stage 3: Continue applies the patch as it was", () =>
  withStop(S.am3Stop, async ({ r }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 3);
    assert.equal((await ctx.operation.view()).canContinue, true);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("show", "HEAD:f.txt").split("\n")[2], "three-test");
  }));

test("cherry-pick range × resolved to stage 3: Continue records it and the rest of the range", () =>
  withStop(S.cherryPickRangeStop, async ({ r }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 3);
    const out = await ctx.operation.continue();
    // Taking T2's WHOLE file drops master's line 5 too, so T3 (line 5) then
    // applies cleanly and the range finishes.
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Cherry-pick complete");
    assert.deepEqual(r.git("log", "-3", "--format=%s").trim().split("\n"), [
      "test: edit line 5",
      "test: edit line 3",
      "test: add g",
    ]);
    assert.equal(r.exists(".git/sequencer"), false);
  }));

test("stash pop × resolved: nothing is stopped any more, and the stash entry is still there", () =>
  withStop(S.stashStop, async ({ r }) => {
    const ctx = r.ctx();
    const took = await ctx.conflictOps.takeRole("f.txt", "yours");
    assert.equal(took.ok, true, took.message);
    assert.equal(line(r.read("f.txt"), 3), "three-stashed", "Yours = the stashed change");
    const v = await ctx.operation.view();
    assert.equal(v.kind, "none");
    assert.equal(v.title, "");
    assert.equal(r.git("stash", "list").trim().split("\n").length, 1, "git keeps the entry after a conflicted pop");
  }));

test("autostash re-apply × Cancel: the autostash stays safe in the stash list", () =>
  withStop(S.autostashStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Cancelled. Your stashed changes are still in the stash.");
    assert.equal(r.git("ls-files", "-u").trim(), "");
    assert.match(r.git("stash", "list"), /autostash/);
    assert.equal(r.sha("HEAD"), r.sha("test"));
    assert.ok(sha.test);
  }));

test("plain am × the patch did not apply: nothing unmerged, Continue explains, Skip works", () =>
  withStop(S.amPlainStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const ins = await ctx.operation.inspect();
    assert.equal(ins.view.kind, "am");
    assert.equal(ins.unmerged.length, 0);
    assert.equal(ins.view.canContinue, false);
    assert.equal(ins.view.continueBlocked, "Nothing is staged for this patch. Apply it by hand and stage the result, or skip the patch.");
    assert.equal(ins.view.canSkip, true);
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.exists(".git/rebase-apply"), false);
    assert.equal(r.sha("HEAD"), sha.master);
  }));

// ── stash ───────────────────────────────────────────────────────────────────

test("stash pop × conflicted: Yours is the stash (stage 3), Cancel keeps the stash", () =>
  withStop(S.stashStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "stash");
    assert.equal(v.yours.stage, 3);
    assert.equal(v.yours.paneTitle, "Your stashed changes");
    assert.equal(v.theirs.paneTitle, "Committed on master");
    assert.equal(v.title, "Applying stashed changes on master");
    assert.deepEqual(v.verbs, { abort: "Cancel" });
    assert.equal(v.canContinue, false);
    assert.equal(v.canSkip, false);
    assert.equal(v.continueBlocked, undefined, "there is no Continue to explain");
    const sides = await ctx.conflictOps.readSides("f.txt", { op: v });
    assert.equal(line(sides.yours, 3), "three-stashed");
    assert.equal(line(sides.theirs, 3), "three-committed");
    assert.equal((await ctx.operation.continue()).refused, "not-allowed");

    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Cancelled. Your stashed changes are still in the stash.");
    assert.equal(r.git("ls-files", "-u").trim(), "");
    assert.equal(r.git("stash", "list").trim().split("\n").length, 1, "the stash entry is kept");
    assert.equal(r.sha("HEAD"), sha.master);
    assert.equal(line(r.read("f.txt"), 3), "three-committed");
  }));

test("autostash re-apply × conflicted: read as a stash, swapped the same way", () =>
  withStop(S.autostashStop, async ({ r }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "stash");
    assert.equal(v.yours.stage, 3);
    assert.equal(v.title, "Applying stashed changes on test");
    const sides = await ctx.conflictOps.readSides("f.txt", { op: v });
    assert.equal(line(sides.yours, 3), "three-dirty", "your uncommitted edit, on the left");
    assert.equal(line(sides.theirs, 3), "three-master");
  }));

// ── none ────────────────────────────────────────────────────────────────────

test("none × clean: nothing stopped, nothing allowed", () =>
  withStop(S.cleanRepo, async ({ r }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "none");
    assert.equal(v.title, "");
    assert.equal(v.episode, "none");
    assert.equal(v.canContinue, false);
    assert.equal(v.canSkip, false);
    assert.equal((await ctx.operation.continue()).refused, "not-allowed");
    assert.equal((await ctx.operation.skip()).refused, "not-allowed");
    assert.equal((await ctx.operation.abort()).refused, "not-allowed");
    assert.deepEqual(await ctx.operation.detect(), { kind: "none", unmerged: 0 });
  }));

test("none × unmerged files with no operation: Cancel resets them", () =>
  withStop(S.bareUnmergedStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "none", "no stash markers left: neutral labels, no swap");
    assert.equal(v.yours.stage, 2);
    assert.equal(v.title, "Unmerged files on master");
    const out = await ctx.operation.abort();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("ls-files", "-u").trim(), "");
    assert.equal(r.sha("HEAD"), sha.master);
  }));

// ── pauses ──────────────────────────────────────────────────────────────────

test("pause × edit: Continue only, never a Skip, never willDrop", () =>
  withStop(() => S.pauseStop("edit"), async ({ r, sha }) => {
    const ctx = r.ctx();
    const ins = await ctx.operation.inspect();
    const v = ins.view;
    assert.equal(v.kind, "rebase");
    assert.equal(ins.indexMatchesHead, true, "exactly like an emptied commit, from the index's point of view");
    assert.deepEqual(v.pause, { reason: "edit", detail: `Paused to edit ${sha.a.slice(0, 7)} A` });
    assert.equal(v.canContinue, true);
    assert.equal(v.canSkip, false, "rebase --skip would hard-reset the amend this pause is for");
    assert.equal(v.willDrop, undefined);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("log", "--format=%s", "master..test").trim(), "B\nA");
  }));

test("pause × break: named, and Continue carries on", () =>
  withStop(() => S.pauseStop("break"), async ({ r }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.deepEqual(v.pause, { reason: "break", detail: "Paused at a break in the rebase plan" });
    assert.equal(v.canContinue, true);
    assert.equal(v.willDrop, undefined);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
  }));

test("pause × a failed exec: named with the command, and Continue carries on", () =>
  withStop(() => S.pauseStop("exec"), async ({ r }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.deepEqual(v.pause, { reason: "exec-failed", detail: "Paused because the command “false” failed" });
    assert.equal(v.canContinue, true);
    const out = await ctx.operation.continue();
    assert.equal(out.ok, true, out.message);
    assert.equal(r.git("log", "--format=%s", "master..test").trim(), "B\nA");
  }));

test("pause × edit with an unstaged change: Continue is blocked with the real reason", () =>
  withStop(() => S.pauseStop("edit"), async ({ r }) => {
    const ctx = r.ctx();
    r.write("f.txt", "dirty\n");
    const v = await ctx.operation.view();
    assert.equal(v.canContinue, false);
    assert.match(v.continueBlocked ?? "", /^f\.txt has changes that aren't staged/);
  }));

// ── a Skip that ENDS the operation says what it left out ─────────────────────
//
// "Last commit skipped" was said of every Skip that finished the operation —
// also when the skipped commit was the MIDDLE one and git went on to apply the
// rest. The outcome now says which one was skipped, and that the rest applied.

test("skip × a middle commit of a rebase, the rest applies: says which, and that the rest applied", () =>
  withStop(S.rebaseApplyMiddleStop, async ({ r }) => {
    const ctx = r.ctx();
    assert.deepEqual((await ctx.operation.view()).step, { n: 2, m: 3, unit: "commit" });
    await ctx.conflictOps.takeStage("f.txt", 2);
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Commit 2 of 3 skipped; the rest applied — rebase complete");
    assert.equal(r.exists(".git/rebase-apply"), false, "the rebase is over");
    assert.deepEqual(
      r.git("log", "--format=%s", "master..test").trim().split("\n"),
      ["test: add h", "test: add g"],
      "commit 3 was applied after the skipped one",
    );
  }));

test("skip × the last commit of a rebase: says it finished without it", () =>
  withStop(S.rebaseApplyStop, async ({ r }) => {
    const ctx = r.ctx();
    await ctx.conflictOps.takeStage("f.txt", 2);
    const first = await ctx.operation.skip();
    assert.equal(first.stopped, true, first.message);
    assert.deepEqual(first.view.step, { n: 3, m: 3, unit: "commit" }, "commit 3 conflicts next");
    await ctx.conflictOps.takeStage("f.txt", 2);
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Last commit skipped. Rebase complete, without it");
    assert.equal(r.exists(".git/rebase-apply"), false);
  }));

test("skip × a middle patch of a series, the rest applies: says which, and that the rest applied", () =>
  withStop(S.amMiddleStop, async ({ r }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "am");
    assert.deepEqual(v.step, { n: 2, m: 3, unit: "patch" });
    await ctx.conflictOps.takeStage("f.txt", 2);
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, "Patch 2 of 3 skipped; the rest applied — the series is finished");
    assert.equal(r.exists(".git/rebase-apply"), false, "the am session is over");
    assert.deepEqual(
      r.git("log", "--format=%s", "-2").trim().split("\n"),
      ["test: add h", "test: add g"],
      "patch 3 was applied after the skipped one",
    );
  }));

test("skip × a picked commit with more queued, the rest applies: names it, and says the rest applied", () =>
  withStop(S.cherryPickMiddleStop, async ({ r, sha }) => {
    const ctx = r.ctx();
    const v = await ctx.operation.view();
    assert.equal(v.kind, "cherry-pick");
    assert.equal(v.commit?.sha, sha.t2);
    assert.equal(v.queued, 1);
    await ctx.conflictOps.takeStage("f.txt", 2);
    const out = await ctx.operation.skip();
    assert.equal(out.ok, true, out.message);
    assert.equal(out.message, `Commit ${sha.t2.slice(0, 7)} skipped; the rest applied — cherry-pick complete`);
    assert.equal(r.exists(".git/sequencer"), false);
    assert.equal(r.git("log", "-1", "--format=%s").trim(), "test: add h", "the queued commit was picked");
  }));

// ── Locale-freedom: the conflicted column again, under a German git ─────────

test("the table's conflicted column reads the same under LANG=de_DE.UTF-8", async (t) => {
  const de = germanLocale();
  if (!de) {
    t.skip("no German git catalog on this machine");
    return;
  }
  const saved = { LANG: process.env.LANG, LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  Object.assign(process.env, { LANG: de.LANG, LC_ALL: de.LC_ALL, LANGUAGE: de.LANGUAGE });
  try {
    const cells: Array<[() => Stopped, string, 2 | 3, boolean]> = [
      [S.mergeStop, "merge", 2, false],
      [S.rebaseMergeStop, "rebase", 3, false],
      [S.rebaseApplyStop, "rebase", 3, false],
      [S.rebaseMergeStepStop, "rebase-merge-step", 2, false],
      [S.cherryPickStop, "cherry-pick", 2, true],
      [S.cherryPickRangeStop, "cherry-pick", 2, true],
      [S.revertStop, "revert", 2, true],
      [S.am3Stop, "am", 2, true],
      [S.amPlainStop, "am", 2, true],
      [S.stashStop, "stash", 3, false],
      [S.autostashStop, "stash", 3, false],
      [S.cleanRepo, "none", 2, false],
      [() => S.pauseStop("edit"), "rebase", 3, false],
    ];
    for (const [build, kind, stage, canSkip] of cells) {
      await withStop(build, async ({ r }) => {
        const v = await r.ctx().operation.view();
        assert.equal(v.kind, kind, `${kind} under de_DE`);
        assert.equal(v.yours.stage, stage, `${kind}: yours.stage`);
        assert.equal(v.canSkip, canSkip, `${kind}: canSkip`);
      });
    }
    // And a verb whose outcome is decided from the repository, not git's words.
    await withStop(S.am3Stop, async ({ r }) => {
      const out = await r.ctx().operation.abort();
      assert.equal(out.ok, true, out.message);
      assert.equal(r.exists(".git/rebase-apply"), false);
    });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
