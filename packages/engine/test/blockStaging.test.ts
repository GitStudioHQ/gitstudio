import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeChangeBlocks,
  rangesToStage,
  rangesToUnstage,
  sameBlock,
} from "../src/staging/blockStaging";
import { computeHunks, applySelectedChanges } from "../src/staging/applyLineChanges";

// The truth table behind a tick beside each change in a diff. Every case is
// stated as three texts — HEAD, index, working — because that triple is the only
// thing that decides what a tick should show.

const T = (...lines: string[]): string => lines.join("\n") + "\n";

test("no changes at all means no blocks, not an empty-looking file", () => {
  const same = T("a", "b", "c");
  assert.deepEqual(computeChangeBlocks(same, same, same), []);
});

test("a change present in neither the index nor HEAD reads unstaged", () => {
  const head = T("a", "b", "c");
  const working = T("a", "B", "c");
  const blocks = computeChangeBlocks(head, head, working);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].state, "unstaged");
});

test("a change already in the index reads staged", () => {
  const head = T("a", "b", "c");
  const staged = T("a", "B", "c");
  // index and working agree: the edit has been staged and nothing new since.
  const blocks = computeChangeBlocks(head, staged, staged);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].state, "staged");
});

test("two independent edits can be in different states at once", () => {
  const head = T("a", "b", "c", "d", "e", "f", "g");
  // "b" staged; "f" only in the working tree.
  const index = T("a", "B", "c", "d", "e", "f", "g");
  const working = T("a", "B", "c", "d", "e", "F", "g");

  const blocks = computeChangeBlocks(head, index, working);
  assert.equal(blocks.length, 2, "two separate changes since HEAD");
  assert.deepEqual(
    blocks.map((b) => b.state),
    ["staged", "unstaged"],
  );
});

test("the case the whole design turns on: a block half staged reads partial", () => {
  // One contiguous 3-line block since HEAD, of which the middle line is staged.
  // A per-line tick would claim the other two could be ticked independently;
  // "partial" is the honest answer, and staging it stages the remainder.
  const head = T("a", "b", "c", "d", "e");
  const index = T("a", "b", "C", "d", "e");
  const working = T("a", "B", "C", "D", "e");

  const blocks = computeChangeBlocks(head, index, working);
  assert.equal(blocks.length, 1, "still one change since HEAD");
  assert.equal(blocks[0].state, "partial");
});

test("a pure deletion is staged or unstaged, never stuck at partial", () => {
  // A deletion occupies no line on the working side, so line arithmetic would
  // report it as never fully covered and leave a tick that cannot be filled.
  const head = T("a", "b", "c");
  const working = T("a", "c");

  const unstagedBlocks = computeChangeBlocks(head, head, working);
  assert.equal(unstagedBlocks.length, 1);
  assert.equal(unstagedBlocks[0].state, "unstaged");

  const stagedBlocks = computeChangeBlocks(head, working, working);
  assert.equal(stagedBlocks.length, 1);
  assert.equal(stagedBlocks[0].state, "staged");
});

test("an insertion at end of file is a block like any other", () => {
  const head = T("a", "b");
  const working = T("a", "b", "c");
  const blocks = computeChangeBlocks(head, head, working);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].state, "unstaged");
});

test("a brand-new file diffs from empty and yields one block", () => {
  const working = T("hello", "world");
  const blocks = computeChangeBlocks("", "", working);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].state, "unstaged");
});

test("staging a block applies exactly that block onto the index", () => {
  const head = T("a", "b", "c", "d", "e");
  const index = head; // nothing staged yet
  const working = T("a", "B", "c", "D", "e");

  const blocks = computeChangeBlocks(head, index, working);
  assert.equal(blocks.length, 2);

  const unstagedHunks = computeHunks(index, working);
  const ranges = rangesToStage(blocks[0], unstagedHunks);
  const next = applySelectedChanges(index, working, ranges);

  assert.equal(next, T("a", "B", "c", "d", "e"), "only the first block moved");
});

test("staging the remainder of a partial block completes it, changing nothing else", () => {
  const head = T("a", "b", "c", "d", "e");
  const index = T("a", "b", "C", "d", "e"); // middle line already staged
  const working = T("a", "B", "C", "D", "e");

  const [block] = computeChangeBlocks(head, index, working);
  assert.equal(block.state, "partial");

  const next = applySelectedChanges(index, working, rangesToStage(block, computeHunks(index, working)));
  assert.equal(next, working, "the index now matches the working tree for this block");

  // And the model agrees the block is done.
  const after = computeChangeBlocks(head, next, working);
  assert.equal(after[0].state, "staged");
});

test("unstaging rolls the index back to HEAD for that block only", () => {
  const head = T("a", "b", "c", "d", "e");
  // Two blocks staged; we roll back only the first.
  const index = T("a", "B", "c", "D", "e");
  const working = index;

  const blocks = computeChangeBlocks(head, index, working);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.state), ["staged", "staged"]);

  const stagedHunks = computeHunks(index, head);
  const next = applySelectedChanges(index, head, rangesToUnstage(blocks[0], stagedHunks));

  assert.equal(next, T("a", "b", "c", "D", "e"), "second block still staged");
});

test("CRLF content survives a round trip unchanged", () => {
  // Line endings are decided by git's clean filters at write time, not here —
  // this layer must not quietly normalise anything on its own.
  const head = "a\r\nb\r\nc\r\n";
  const working = "a\r\nB\r\nc\r\n";
  const [block] = computeChangeBlocks(head, head, working);
  const next = applySelectedChanges(head, working, rangesToStage(block, computeHunks(head, working)));
  assert.equal(next, working);
  assert.ok(next.includes("\r\n"), "CRLF preserved");
});

test("block identity survives a shift caused by an edit above it", () => {
  // The point of content-derived identity: inserting a line above must not make
  // the block below unrecognisable, or every tick would go stale on any edit.
  const head = T("a", "b", "c", "d");
  const workingA = T("a", "b", "c", "D");
  const workingB = T("NEW", "a", "b", "c", "D");

  const [beforeShift] = computeChangeBlocks(head, head, workingA);
  const shifted = computeChangeBlocks(head, head, workingB);

  const moved = shifted.find((b) => b.head.start === beforeShift.head.start);
  assert.ok(moved, "the same HEAD-side change is still present after the shift");
  assert.notEqual(moved.working.start, beforeShift.working.start, "and it did move");
});

test("sameBlock distinguishes different changes and matches identical ones", () => {
  const head = T("a", "b", "c", "d", "e");
  const working = T("a", "B", "c", "D", "e");
  const blocks = computeChangeBlocks(head, head, working);

  assert.ok(sameBlock(blocks[0], { ...blocks[0] }));
  assert.ok(!sameBlock(blocks[0], blocks[1]));
});
