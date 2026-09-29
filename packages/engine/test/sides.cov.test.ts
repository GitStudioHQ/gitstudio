// Operation words (src/conflict/sides.ts) — the pause and skip lines with
// nothing to name: no commit, no command, no sha, and a subject-less commit.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pauseDetail, skipEndedText } from "../src/conflict/sides";

test("the pause card with nothing to name still says why it stopped", () => {
  assert.equal(pauseDetail({}), "", "not paused: no line");
  assert.equal(pauseDetail({ pause: { reason: "edit" } }), "Paused to edit a commit");
  assert.equal(
    pauseDetail({ pause: { reason: "edit" }, commit: { sha: "837b3451c6d4622d4f3659aebacfe4ed5c73434b", subject: "" } }),
    "Paused to edit 837b345",
    "no trailing space when the commit has no subject",
  );
  assert.equal(pauseDetail({ pause: { reason: "exec-failed" } }), "Paused because a command in the rebase plan failed");
});

test("a skip that left picks queued, of a commit whose sha isn't known, says 'the current commit'", () => {
  assert.equal(skipEndedText({ kind: "cherry-pick", queued: 3 }), "The current commit skipped; the rest applied — cherry-pick complete");
  assert.equal(skipEndedText({ kind: "am", queued: 1 }), "The current commit skipped; the rest applied — the series is finished");
  // The last of a cherry-pick RANGE: the ones before it are in.
  assert.equal(
    skipEndedText({ kind: "cherry-pick", range: true }),
    "Last commit skipped. Cherry-pick complete, without it",
  );
});
