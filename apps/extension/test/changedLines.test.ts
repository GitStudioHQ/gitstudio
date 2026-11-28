// Where the optional whole-line highlights go (#160): which lines are added,
// which are modified, and where a deletion's label sits.
//
// The blocks are the engine's own, from the same computeChangeBlocks the
// staging marks read, so the zero-width spans a deletion and an addition
// arrive with are the real encoding, not a guess at it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChangeBlocks } from "@gitstudio/engine/staging/blockStaging";
import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";
import { lineChangeKind, planChangedLines } from "../src/changes/changedLines";

/** The plan for HEAD `head` against working `working`, nothing staged. */
function plan(head: string, working: string) {
  const lines = working.split("\n").length; // what VS Code's lineCount says for this text
  return planChangedLines(computeChangeBlocks(head, head, working), lines);
}

test("an added line, a modified line and a deletion are told apart", () => {
  //          0   1   2   3   4   5   6   7
  const head = "a\nb\nc\nd\ne\nf\ng\nh\n";
  const working = "a\nB\nc\nf\ng\nX\nh\n"; // b→B, d and e deleted, X added before h
  assert.deepEqual(plan(head, working), {
    modified: [{ start: 1, end: 1 }],
    added: [{ start: 5, end: 5 }],
    // The label sits on "f", the first line after the cut — the line the
    // staging mark and the hover use for the same deletion.
    deleted: [{ line: 3, count: 2, above: true }],
  });
});

test("a run of added lines is one span, not a line each", () => {
  assert.deepEqual(plan("a\nb\n", "a\nX\nY\nZ\nb\n").added, [{ start: 1, end: 3 }]);
});

test("a deletion at the top of the file is labelled on the first line", () => {
  assert.deepEqual(plan("a\nb\nc\n", "c\n").deleted, [{ line: 0, count: 2, above: true }]);
});

test("a deletion at the very end is labelled on a line that exists", () => {
  // With a final newline the line after the cut is the buffer's last (empty) line.
  assert.deepEqual(plan("a\nb\nc\n", "a\n").deleted, [{ line: 1, count: 2, above: true }]);
  // Without one there is no line after the cut: the label goes on the last
  // line, and says the lines went BELOW it.
  assert.deepEqual(plan("a\nb\nc", "a").deleted, [{ line: 0, count: 2, above: false }]);
});

test("a change that replaces lines with fewer lines is modified, not deleted", () => {
  const p = plan("a\nb\nc\nd\n", "a\nX\nd\n");
  assert.deepEqual(p.modified, [{ start: 1, end: 1 }]);
  assert.deepEqual(p.deleted, []);
});

test("no change, no highlight", () => {
  assert.deepEqual(plan("a\nb\n", "a\nb\n"), { added: [], modified: [], deleted: [] });
});

test("blocks read for a longer text never point past the end of the buffer", () => {
  // The buffer shrank after git answered; the next refresh corrects the
  // lines, but this paint must not name a line the document no longer has.
  const blocks: ChangeBlock[] = [
    { head: { start: 3, end: 2 }, working: { start: 3, end: 9 }, state: "unstaged" },
    { head: { start: 12, end: 13 }, working: { start: 12, end: 11 }, state: "unstaged" },
  ];
  assert.deepEqual(planChangedLines(blocks, 5), {
    added: [{ start: 3, end: 4 }],
    modified: [],
    deleted: [{ line: 4, count: 2, above: false }],
  });
});

test("every kind is highlighted whatever its staging state", () => {
  // The marks say staged or not; the highlight says where the change is.
  const block = (state: ChangeBlock["state"]): ChangeBlock => ({
    head: { start: 1, end: 1 },
    working: { start: 1, end: 1 },
    state,
  });
  const p = planChangedLines([block("staged"), block("partial"), block("unstaged")], 3);
  assert.equal(p.modified.length, 3);
});

test("lines typed into an empty file HEAD has are added, and the empty last line is not", () => {
  // The diff reads HEAD's empty text as one empty line, so this arrives as a
  // block that REPLACES it — a modification taking in the line after the
  // final newline. Without the hint that HEAD's file is empty, that is what
  // would be painted.
  const blocks = computeChangeBlocks("", "", "one\ntwo\nthree\n");
  assert.deepEqual(planChangedLines(blocks, 4).modified, [{ start: 0, end: 3 }], "the raw blocks");
  assert.deepEqual(planChangedLines(blocks, 4, { emptyHead: true, finalNewline: true }), {
    added: [{ start: 0, end: 2 }],
    modified: [],
    deleted: [],
  });
  // No final newline: every line is text, and every line is added.
  const bare = computeChangeBlocks("", "", "one\ntwo");
  assert.deepEqual(planChangedLines(bare, 2, { emptyHead: true, finalNewline: false }).added, [{ start: 0, end: 1 }]);
});

test("a block with no lines on either side is no change", () => {
  const empty: ChangeBlock = { head: { start: 2, end: 1 }, working: { start: 2, end: 1 }, state: "unstaged" };
  assert.equal(lineChangeKind(empty), undefined);
  assert.deepEqual(planChangedLines([empty], 4), { added: [], modified: [], deleted: [] });
});
