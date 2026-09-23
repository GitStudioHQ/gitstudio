import { test } from "node:test";
import assert from "node:assert/strict";
import type { OperationKind, SideView } from "@gitstudio/host-bridge/conflictsProtocol";
import {
  byRole,
  describeSides,
  pauseDetail,
  roleOfStage,
  skipEndedText,
  stageOf,
  YOURS_STAGE,
  type SideStages,
} from "../src/conflict/sides";

// The role helpers are the ONE place contents, missing sides, badges and the
// JetBrains LOCAL/REMOTE files are re-keyed from git stages to Yours/Theirs.
// They must follow `op.yours.stage` — during a rebase Yours is stage 3 (your
// commit being replayed), and reading stage 2 as "yours" there is how
// "Accept Yours" silently dropped the reporter's only commit (issue #12).

function side(role: "yours" | "theirs", stage: 2 | 3): SideView {
  return { role, stage, name: role, paneTitle: role, description: role };
}

/** An operation whose Yours side is `yoursStage`. */
function op(yoursStage: 2 | 3): SideStages {
  return {
    yours: side("yours", yoursStage),
    theirs: side("theirs", yoursStage === 2 ? 3 : 2),
  };
}

test("byRole: a merge keeps stage 2 as Yours", () => {
  assert.deepEqual(byRole(op(2), "stage-2 text", "stage-3 text"), {
    yours: "stage-2 text",
    theirs: "stage-3 text",
  });
});

test("byRole: a rebase puts stage 3 (your replayed commit) on the Yours side", () => {
  assert.deepEqual(byRole(op(3), "three-master", "three-test"), {
    yours: "three-test",
    theirs: "three-master",
  });
});

// ── describeSides: the §3.1 table ────────────────────────────────────────────

test("describeSides: Yours is stage 3 for a rebase and a stash re-apply, stage 2 everywhere else", () => {
  const kinds: OperationKind[] = ["merge", "rebase", "rebase-merge-step", "cherry-pick", "revert", "am", "stash", "none"];
  for (const kind of kinds) {
    const d = describeSides({ kind, current: "master" });
    const reversed = kind === "rebase" || kind === "stash";
    assert.equal(d.yours.stage, reversed ? 3 : 2, kind);
    assert.equal(d.theirs.stage, reversed ? 2 : 3, kind);
    assert.equal(d.yours.role, "yours");
    assert.equal(d.theirs.role, "theirs");
    assert.equal(YOURS_STAGE[kind], d.yours.stage, `${kind}: the one swap column`);
  }
});

test("describeSides: the reporter's rebase, word for word", () => {
  const d = describeSides({
    kind: "rebase",
    backend: "merge",
    current: "3fbf4c0",
    branch: "test",
    onto: "master",
    commit: { sha: "89876df007ab00fe0f31047a85a89a84f7623015", subject: "test change" },
    step: { n: 1, m: 1, unit: "commit" },
  });
  assert.equal(d.title, "Rebasing test onto master · commit 1 of 1: 89876df test change");
  assert.deepEqual(d.direction, { from: "yours", verb: "onto", to: "theirs" });
  assert.equal(d.yours.name, "test");
  assert.equal(d.yours.paneTitle, "Rebasing 89876df from test");
  assert.equal(d.yours.description, "Your commit 89876df “test change” from test");
  assert.equal(d.theirs.name, "master");
  assert.equal(d.theirs.paneTitle, "Already rebased commits and commits from master");
  assert.deepEqual(d.verbs, { continue: "Continue Rebase", abort: "Abort Rebase" });
});

test("describeSides: a rebase whose onto nothing names, onto a new root, and on the apply backend", () => {
  const unnamed = describeSides({
    kind: "rebase",
    current: "x",
    branch: "test",
    ontoCommit: { sha: "1ed0f71aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", subject: "master: edit" },
  });
  assert.equal(unnamed.title, "Rebasing test onto 1ed0f71 (master: edit)");
  assert.equal(unnamed.theirs.name, "1ed0f71");
  assert.equal(unnamed.theirs.paneTitle, "Already rebased commits");
  const root = describeSides({ kind: "rebase", current: "x", branch: "test", ontoIsRoot: true });
  assert.equal(root.title, "Rebasing test onto a new root");
  assert.equal(root.theirs.name, "new root");
  const apply = describeSides({ kind: "rebase", backend: "apply", current: "x", branch: "test", onto: "master" });
  assert.equal(apply.verbs.skip, "Skip this commit", "only the apply backend has a Skip");
});

test("describeSides: merge, merge step, cherry-pick, revert, am, stash and none", () => {
  const c = { sha: "a88fcbe01c53132d9c6a3ea2f02da396e944c874", subject: "fix it", author: "Ann" };
  const merge = describeSides({ kind: "merge", current: "master", incoming: "test (from origin)" });
  assert.equal(merge.title, "Merging test (from origin) into master");
  assert.deepEqual(merge.direction, { from: "theirs", verb: "into", to: "yours" });
  assert.equal(merge.yours.paneTitle, "Changes from master");
  assert.equal(merge.theirs.paneTitle, "Changes from test (from origin)");
  assert.deepEqual(merge.verbs, { continue: "Continue Merge", abort: "Abort Merge" });

  const step = describeSides({ kind: "rebase-merge-step", current: "x", branch: "feat", label: "side", step: { n: 3, m: 3, unit: "step" } });
  assert.equal(step.title, "Re-creating merge of side into feat · step 3 of 3");
  assert.equal(step.yours.paneTitle, "Changes from feat (rewritten)");
  assert.equal(step.theirs.paneTitle, "Changes from side (rewritten)");
  assert.deepEqual(step.verbs, { continue: "Continue Rebase", abort: "Abort Rebase" }, "never merge --*");

  const pick = describeSides({ kind: "cherry-pick", current: "master", commit: c, queued: 2 });
  assert.equal(pick.title, "Cherry-picking a88fcbe fix it onto master · 2 more queued");
  assert.equal(pick.theirs.name, "a88fcbe");
  assert.equal(pick.theirs.paneTitle, "Changes from cherry-pick a88fcbe fix it");
  assert.deepEqual(pick.direction, { from: "theirs", verb: "onto", to: "yours" });

  const revert = describeSides({ kind: "revert", current: "master", commit: c });
  assert.equal(revert.title, "Reverting a88fcbe fix it on master");
  assert.equal(revert.theirs.name, "undo of a88fcbe");
  assert.equal(revert.theirs.paneTitle, "Undo of a88fcbe fix it");
  assert.doesNotMatch(JSON.stringify(revert), /parent of/);

  const am = describeSides({ kind: "am", current: "master", commit: { sha: "", subject: "fix it", author: "Ann" }, step: { n: 2, m: 5, unit: "patch" } });
  assert.equal(am.title, "Applying patch 2 of 5: fix it (by Ann) onto master");
  assert.equal(am.theirs.name, "patch 2/5");
  assert.equal(am.theirs.paneTitle, "Patch 2/5: fix it");
  assert.deepEqual(am.verbs, { continue: "Continue (git am)", skip: "Skip patch", abort: "Abort (git am)" });

  const stash = describeSides({ kind: "stash", current: "master" });
  assert.equal(stash.title, "Applying stashed changes on master");
  assert.equal(stash.yours.paneTitle, "Your stashed changes");
  assert.equal(stash.theirs.paneTitle, "Committed on master");
  assert.deepEqual(stash.direction, { from: "yours", verb: "on", to: "theirs" });
  assert.deepEqual(stash.verbs, { abort: "Cancel" });

  assert.equal(describeSides({ kind: "none", current: "master" }).title, "");
  assert.equal(describeSides({ kind: "none", current: "master", unmerged: 2 }).title, "Unmerged files on master");
  assert.equal(describeSides({ kind: "none", current: "" }).yours.paneTitle, "Current (HEAD)");
  assert.equal(describeSides({ kind: "none", current: "master" }).direction, undefined);
});

test("describeSides: the pause card's words", () => {
  const edit = describeSides({
    kind: "rebase",
    current: "x",
    branch: "test",
    commit: { sha: "837b3451c6d4622d4f3659aebacfe4ed5c73434b", subject: "A" },
    pause: { reason: "edit" },
  });
  assert.deepEqual(edit.pause, { reason: "edit", detail: "Paused to edit 837b345 A" });
  assert.equal(pauseDetail({ pause: { reason: "break" } }), "Paused at a break in the rebase plan");
  assert.equal(
    pauseDetail({ pause: { reason: "exec-failed", command: "npm test" } }),
    "Paused because the command “npm test” failed",
  );
  assert.equal(describeSides({ kind: "rebase", current: "x" }).pause, undefined);
});

test("roleOfStage and stageOf agree with each other for both orientations", () => {
  for (const yoursStage of [2, 3] as const) {
    const o = op(yoursStage);
    assert.equal(stageOf(o, "yours"), yoursStage);
    assert.equal(stageOf(o, "theirs"), yoursStage === 2 ? 3 : 2);
    assert.equal(roleOfStage(o, yoursStage), "yours");
    assert.equal(roleOfStage(o, yoursStage === 2 ? 3 : 2), "theirs");
    for (const role of ["yours", "theirs"] as const) {
      assert.equal(roleOfStage(o, stageOf(o, role)), role);
    }
  }
});

// A Skip that ENDED the operation said "Last commit skipped" every time — also
// of commit 2 of 3, after which git applied commit 3. The words now follow the
// stop the Skip ended: which one, and whether anything came after it.
test("a Skip that ended the operation says which one it left out, and whether the rest applied", () => {
  const commit = { sha: "1a2b3c4d5e6f708192a3", subject: "fix" };
  assert.equal(
    skipEndedText({ kind: "rebase", step: { n: 2, m: 3, unit: "commit" } }),
    "Commit 2 of 3 skipped; the rest applied — rebase complete",
  );
  assert.equal(skipEndedText({ kind: "rebase", step: { n: 3, m: 3, unit: "commit" } }), "Last commit skipped. Rebase complete, without it");
  assert.equal(
    skipEndedText({ kind: "am", step: { n: 2, m: 5, unit: "patch" } }),
    "Patch 2 of 5 skipped; the rest applied — the series is finished",
  );
  assert.equal(skipEndedText({ kind: "am", step: { n: 1, m: 1, unit: "patch" } }), "Last patch skipped. The series is finished, without it");
  assert.equal(
    skipEndedText({ kind: "cherry-pick", queued: 2, commit }),
    "Commit 1a2b3c4 skipped; the rest applied — cherry-pick complete",
  );
  assert.equal(skipEndedText({ kind: "revert", queued: 1, commit }), "Commit 1a2b3c4 skipped; the rest applied — revert complete");
  assert.equal(skipEndedText({ kind: "cherry-pick", commit }), "Last commit skipped. Cherry-pick complete, without it");
  assert.equal(skipEndedText({ kind: "rebase" }), "Last commit skipped. Rebase complete, without it", "nothing known after it: the last");
});
