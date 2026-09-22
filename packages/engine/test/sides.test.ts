import { test } from "node:test";
import assert from "node:assert/strict";
import type { SideView } from "@gitstudio/host-bridge/conflictsProtocol";
import { byRole, roleOfStage, stageOf, type SideStages } from "../src/conflict/sides";

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
