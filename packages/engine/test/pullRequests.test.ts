// A pull request's shared rules and words (src/forge/pullRequests.ts): a PR's
// state, what its checks add up to, what its reviews decided, where GitHub
// lets a review comment land, and the review GitHub is sent. The extension's
// feature-level behaviour is in apps/extension/test/prFeature.test.ts; these
// pin the rules themselves, one table each.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CI_STATES,
  PR_STATES,
  REVIEW_DECISIONS,
  REVIEW_VERDICTS,
  ciFromRollup,
  ciFromRollupState,
  ciWords,
  commentsOutsideHunks,
  desktopPrKind,
  hunkSpans,
  prKind,
  reviewDecisionOf,
  reviewPayload,
  rollupCi,
  type CiState,
  type PrKind,
} from "../src/forge/pullRequests";

test("the vocabulary: every state, check result and review decision has words, a codicon and a tone — and no two states share a tone", () => {
  const kinds: PrKind[] = ["open", "draft", "merged", "closed"];
  // The owner's table: open green, merged purple, closed-unmerged red, draft muted.
  assert.deepEqual(
    kinds.map((k) => [PR_STATES[k].word, PR_STATES[k].tone]),
    [
      ["Open", "open"],
      ["Draft", "draft"],
      ["Merged", "merged"],
      ["Closed", "closed"],
    ],
  );
  assert.equal(new Set(kinds.map((k) => PR_STATES[k].tone)).size, 4, "four kinds, four inks");
  assert.equal(new Set(kinds.map((k) => PR_STATES[k].codicon)).size, 4, "four kinds, four glyphs");
  const cis: CiState[] = ["success", "failure", "pending", "none"];
  // A glyph per result, not a colour alone: red and green are one colour to
  // a red-green colour-blind eye.
  assert.equal(new Set(cis.map((c) => CI_STATES[c].codicon)).size, 4);
  assert.deepEqual(cis.map((c) => CI_STATES[c].codicon), ["check", "close", "sync", "circle-slash"]);
  assert.deepEqual(
    Object.values(REVIEW_DECISIONS).map((d) => d.word),
    ["Approved", "Changes requested", "Review required"],
  );
  assert.deepEqual(REVIEW_VERDICTS.map((v) => v.label), ["Comment", "Approve", "Request changes"]);
  for (const t of [...Object.values(PR_STATES), ...Object.values(CI_STATES), ...Object.values(REVIEW_DECISIONS)]) {
    assert.match(t.codicon, /^[a-z][a-z-]*$/, "a codicon name");
  }
  assert.equal(desktopPrKind({ state: "open", draft: false }), "open-pr", "the desktop's class for Open");
  assert.equal(desktopPrKind({ state: "closed", draft: false, mergedAt: "x" }), "merged");
});

test("reviewDecisionOf: GitHub's three decisions, and nothing else", () => {
  assert.equal(reviewDecisionOf("APPROVED"), "APPROVED");
  assert.equal(reviewDecisionOf("CHANGES_REQUESTED"), "CHANGES_REQUESTED");
  assert.equal(reviewDecisionOf("REVIEW_REQUIRED"), "REVIEW_REQUIRED");
  assert.equal(reviewDecisionOf(null), undefined);
  assert.equal(reviewDecisionOf("DISMISSED"), undefined, "a value GitHub may add later is not guessed at");
});

test("ciFromRollup: GitHub's state, and the counts the words need — check runs and statuses together", () => {
  const counts = (runs: Record<string, number>, statuses: Record<string, number> = {}) => ({
    checkRunCountsByState: Object.entries(runs).map(([state, count]) => ({ state, count })),
    statusContextCountsByState: Object.entries(statuses).map(([state, count]) => ({ state, count })),
  });
  const failed = ciFromRollup({ state: "FAILURE", contexts: counts({ SUCCESS: 3, FAILURE: 1, SKIPPED: 1 }, { ERROR: 1 }) });
  assert.deepEqual(failed, { state: "failure", total: 6, failed: 2, pending: 0 });
  assert.equal(ciWords(failed), "2 of 6 checks failed");
  const running = ciFromRollup({ state: "PENDING", contexts: counts({ SUCCESS: 2, IN_PROGRESS: 1 }, { EXPECTED: 1 }) });
  assert.equal(ciWords(running), "2 of 4 checks running");
  assert.equal(ciWords(ciFromRollup({ state: "SUCCESS", contexts: counts({ SUCCESS: 1 }) })), "All 1 check passed");
  // No rollup at all: the commit has no checks.
  assert.deepEqual(ciFromRollup(null), { state: "none", total: 0, failed: 0, pending: 0 });
  // A state the counts don't back says it plainly, never "0 of 5 checks failed".
  assert.equal(ciWords(ciFromRollup({ state: "FAILURE", contexts: counts({ SUCCESS: 5 }) })), "Checks failed");
  assert.equal(ciWords(ciFromRollup({ state: "SUCCESS" })), "Checks passed", "no counts read");
});

test("prKind: merged beats closed beats draft beats open", () => {
  const cases: Array<[Parameters<typeof prKind>[0], ReturnType<typeof prKind>]> = [
    [{ state: "open", draft: false }, "open"],
    [{ state: "open", draft: true }, "draft"],
    [{ state: "closed", draft: false, mergedAt: null }, "closed"],
    [{ state: "closed", draft: false, mergedAt: "2026-09-01T00:00:00Z" }, "merged"],
    // A draft can be closed; it is closed, not a draft.
    [{ state: "closed", draft: true }, "closed"],
  ];
  for (const [pr, want] of cases) assert.equal(prKind(pr), want, JSON.stringify(pr));
});

test("rollupCi: check runs AND statuses; a failure wins, then running; none only when both are empty", () => {
  const ok = { status: "completed", conclusion: "success" };
  const skipped = { status: "completed", conclusion: "skipped" };
  const failed = { status: "completed", conclusion: "failure" };
  const running = { status: "in_progress", conclusion: null };
  const cases: Array<[string, Parameters<typeof rollupCi>[0], Parameters<typeof rollupCi>[1], string]> = [
    // An Actions-only repository: no statuses at all. The combined-status
    // endpoint calls this "pending"; the runs say what really happened.
    ["actions failed", [ok, failed], [], "failure"],
    ["actions passed", [ok, ok, ok, skipped], [], "success"],
    ["actions running", [ok, running], [], "pending"],
    ["statuses only", [], [{ state: "success" }], "success"],
    ["a status failing", [ok], [{ state: "error" }], "failure"],
    ["a status pending", [ok], [{ state: "pending" }], "pending"],
    ["failure beats running", [running, failed], [], "failure"],
    ["cancelled is a failure", [{ status: "completed", conclusion: "cancelled" }], [], "failure"],
    ["nothing", [], [], "none"],
  ];
  for (const [name, runs, statuses, want] of cases) {
    assert.equal(rollupCi(runs, statuses).state, want, name);
  }
  assert.equal(ciWords(rollupCi([ok, failed], [])), "1 of 2 checks failed");
  assert.equal(ciWords(rollupCi([ok, ok], [{ state: "success" }])), "All 3 checks passed");
  assert.equal(ciWords(rollupCi([], [])), "No checks");
});

test("ciFromRollupState: GraphQL's statusCheckRollup, and no rollup means no checks", () => {
  assert.equal(ciFromRollupState("SUCCESS"), "success");
  assert.equal(ciFromRollupState("FAILURE"), "failure");
  assert.equal(ciFromRollupState("ERROR"), "failure");
  assert.equal(ciFromRollupState("PENDING"), "pending");
  assert.equal(ciFromRollupState("EXPECTED"), "pending");
  assert.equal(ciFromRollupState(null), "none");
  assert.equal(ciFromRollupState(undefined), "none");
});

const PATCH = [
  "@@ -1,3 +1,4 @@",
  " one",
  "+new",
  " two",
  " three",
  "@@ -40,5 +41,2 @@ function tail() {",
  " a",
  "-b",
  "-c",
  "-d",
  " e",
].join("\n");

test("hunkSpans: each hunk's lines, per side — and nothing for a file with no patch", () => {
  assert.deepEqual(hunkSpans(PATCH), { left: [[1, 3], [40, 44]], right: [[1, 4], [41, 42]] });
  // A deleted file: every line on the left, none on the right.
  assert.deepEqual(hunkSpans("@@ -1,3 +0,0 @@\n-a\n-b\n-c"), { left: [[1, 3]], right: [] });
  // An added one-line file (counts omitted mean 1).
  assert.deepEqual(hunkSpans("@@ -0,0 +1 @@\n+x"), { left: [], right: [[1, 1]] });
  // Binary / too large: GitHub sends no patch, and no line takes a comment.
  assert.deepEqual(hunkSpans(undefined), { left: [], right: [] });
});

test("commentsOutsideHunks names every queued comment GitHub would refuse", () => {
  const patchFor = () => PATCH;
  const bad = commentsOutsideHunks(
    [
      { path: "a.ts", line: 2, side: "RIGHT", body: "in" },
      { path: "a.ts", line: 20, side: "RIGHT", body: "between hunks" },
      { path: "a.ts", line: 43, side: "LEFT", body: "removed line" },
      { path: "a.ts", startLine: 3, line: 41, side: "RIGHT", body: "spans two hunks" },
      { path: "a.ts", line: 44, side: "RIGHT", body: "past the right side" },
    ],
    patchFor,
  );
  assert.deepEqual(bad, ["a.ts:20", "a.ts:3-41", "a.ts:44"]);
});

test("reviewPayload: pinned to the head the diffs showed, multi-line as start_line + line", () => {
  const body = reviewPayload({
    event: "REQUEST_CHANGES",
    body: "see inline",
    commitId: "abc123",
    comments: [
      { path: "a.ts", line: 12, startLine: 10, side: "RIGHT", body: "these three" },
      { path: "gone.md", line: 3, side: "LEFT", body: "why remove this?" },
      { path: "b.ts", line: 5, startLine: 5, side: "RIGHT", body: "one line" },
    ],
  });
  assert.deepEqual(body, {
    event: "REQUEST_CHANGES",
    body: "see inline",
    commit_id: "abc123",
    comments: [
      { path: "a.ts", line: 12, side: "RIGHT", start_line: 10, start_side: "RIGHT", body: "these three" },
      { path: "gone.md", line: 3, side: "LEFT", body: "why remove this?" },
      { path: "b.ts", line: 5, side: "RIGHT", body: "one line" },
    ],
  });
});
