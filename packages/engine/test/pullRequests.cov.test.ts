// The pull-request vocabulary (src/forge/pullRequests.ts) — the corners
// test/pullRequests.test.ts leaves: runs and statuses with missing fields,
// counts GitHub sent garbled, the words for one check, a hunk with an
// implicit count, and a review with no body or head.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ciFromRollup,
  ciWords,
  commentsOutsideHunks,
  hunkSpans,
  prKey,
  reviewPayload,
  rollupCi,
} from "../src/forge/pullRequests";

test("rollupCi: a run with no conclusion is running; a finished run that passed isn't; a status with no state is pending", () => {
  assert.deepEqual(rollupCi([{ status: "completed", conclusion: "success" }, { status: null, conclusion: null }], []), { state: "pending", total: 2, failed: 0, pending: 1 });
  assert.deepEqual(rollupCi([{ status: "completed", conclusion: "neutral" }], [{ state: "success" }]), { state: "success", total: 2, failed: 0, pending: 0 });
  assert.deepEqual(rollupCi([], [{ state: null }, { state: "error" }]), { state: "failure", total: 2, failed: 1, pending: 1 });
  // A run whose status still says it is in progress counts as running.
  assert.deepEqual(rollupCi([{ status: "in_progress", conclusion: "skipped" }], []), { state: "pending", total: 1, failed: 0, pending: 1 });
});

test("ciFromRollup: counts that are missing, negative or not numbers count as none; a state-less count is neither", () => {
  const ci = ciFromRollup({
    state: "SUCCESS",
    contexts: {
      checkRunCountsByState: [{ state: "SUCCESS", count: 2 }, { state: "FAILURE", count: -3 }, { state: null, count: 1 }, { state: "QUEUED", count: null }],
      statusContextCountsByState: [{ state: "SUCCESS", count: 1 }, { count: 4 }],
    },
  });
  assert.deepEqual(ci, { state: "success", total: 8, failed: 0, pending: 0 });
  assert.deepEqual(ciFromRollup({ state: "PENDING", contexts: null }), { state: "pending", total: 0, failed: 0, pending: 0 });
  assert.deepEqual(ciFromRollup({ state: "ERROR", contexts: { checkRunCountsByState: null, statusContextCountsByState: [{ state: "ERROR", count: 2 }, { state: "EXPECTED", count: 1 }] } }), { state: "failure", total: 3, failed: 2, pending: 1 });
});

test("ciWords: one check is singular, and counts that don't back the state fall back to the plain sentence", () => {
  assert.equal(ciWords({ state: "success", total: 1, failed: 0, pending: 0 }), "All 1 check passed");
  assert.equal(ciWords({ state: "success", total: 0, failed: 0, pending: 0 }), "Checks passed");
  assert.equal(ciWords({ state: "failure", total: 1, failed: 1, pending: 0 }), "1 of 1 check failed");
  assert.equal(ciWords({ state: "failure", total: 5, failed: 0, pending: 0 }), "Checks failed");
  assert.equal(ciWords({ state: "pending", total: 1, failed: 0, pending: 1 }), "1 of 1 check running");
  assert.equal(ciWords({ state: "pending", total: 3, failed: 0, pending: 2 }), "2 of 3 checks running");
  assert.equal(ciWords({ state: "pending", total: 0, failed: 0, pending: 0 }), "Checks running");
  assert.equal(ciWords("failure"), "Checks failed");
  assert.equal(ciWords("pending"), "Checks running");
  assert.equal(ciWords("success"), "Checks passed");
  assert.equal(ciWords("none"), "No checks");
});

test("hunkSpans: a hunk with an implicit count covers one line; a pure insertion has no base lines", () => {
  const spans = hunkSpans("@@ -5 +5 @@\n-a\n+b\n@@ -0,0 +1,3 @@\n+x\n+y\n+z\n@@ -9,2 +11,0 @@\n-p\n-q\n");
  assert.deepEqual(spans.left, [[5, 5], [9, 10]]);
  assert.deepEqual(spans.right, [[5, 5], [1, 3]]);
  assert.deepEqual(hunkSpans(""), { left: [], right: [] });
});

test("commentsOutsideHunks: a comment on the base side is checked against the base's lines, and a range is named as one", () => {
  const patch = "@@ -10,3 +10,4 @@\n a\n-b\n+B\n+C\n c\n";
  const bad = commentsOutsideHunks(
    [
      { path: "f.ts", line: 11, side: "LEFT", body: "ok" },
      { path: "f.ts", line: 13, side: "LEFT", body: "past the base's lines" },
      { path: "f.ts", line: 13, side: "RIGHT", startLine: 13, body: "one line, start equals line" },
      { path: "f.ts", line: 14, side: "RIGHT", startLine: 8, body: "starts before the hunk" },
      { path: "none.bin", line: 1, side: "RIGHT", body: "no patch" },
    ],
    (p) => (p === "f.ts" ? patch : undefined),
  );
  assert.deepEqual(bad, ["f.ts:13", "f.ts:8-14", "none.bin:1"]);
});

test("reviewPayload: no body is an empty one, no head leaves commit_id out, and a one-line range is one line", () => {
  assert.deepEqual(reviewPayload({ event: "COMMENT", comments: [{ path: "a", line: 3, side: "RIGHT", startLine: 3, body: "x" }] }), {
    event: "COMMENT",
    body: "",
    comments: [{ path: "a", line: 3, side: "RIGHT", body: "x" }],
  });
});

test("a pull request's key names its repository", () => {
  assert.equal(prKey("acme", "app", 12), "acme/app#12");
  assert.notEqual(prKey("acme", "app", 12), prKey("acme", "other", 12));
});
