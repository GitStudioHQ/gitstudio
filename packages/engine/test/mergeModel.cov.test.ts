// The three-way merge model (src/mergeModel.ts) — collisions the model tests
// leave: an insertion strictly inside the other side's change, and two
// whitespace-only edits on one side chained into one block by the other side.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergeModel } from "../src/mergeModel";

const L = (...l: string[]) => l.join("\n") + "\n";

test("an insertion strictly inside the other side's changed lines is a conflict over the whole span", () => {
  const model = buildMergeModel(L("a", "b", "c", "d", "e"), L("a", "B", "C", "D", "e"), L("a", "b", "X", "c", "d", "e"));
  assert.equal(model.blocks.length, 1);
  const [b] = model.blocks;
  assert.equal(b.kind, "conflict");
  assert.deepEqual(b.baseSpan, { start: 2, endExclusive: 5 });
  assert.deepEqual(b.right?.baseSpan, { start: 3, endExclusive: 3 }, "Theirs inserted at a point");
  assert.deepEqual(b.right?.sideSpan, { start: 3, endExclusive: 4 });
});

test("an insertion at the edge of the other side's change is its own block, not a conflict", () => {
  const model = buildMergeModel(L("a", "b", "c", "d"), L("a", "B", "c", "d"), L("a", "b", "c", "X", "d"));
  assert.deepEqual(model.blocks.map((b) => b.kind), ["left-only", "right-only"]);
});

test("two whitespace-only edits of one side, chained by the other side's change, stay whitespace-only together", () => {
  const model = buildMergeModel(L("a", "b", "c", "d", "e"), L("a", "b ", "c", "d ", "e"), L("a", "B", "C", "D", "e"), { whitespace: "trailing" });
  assert.equal(model.blocks.length, 1);
  const [b] = model.blocks;
  assert.equal(b.kind, "conflict");
  assert.equal(b.left?.whitespaceOnly, true, "Yours only touched whitespace, on both lines");
  assert.deepEqual(b.left?.baseSpan, { start: 2, endExclusive: 5 });
  assert.notEqual(b.right?.whitespaceOnly, true);
  assert.notEqual(b.whitespaceOnly, true, "the block as a whole is a real change");
});

test("an insertion and a whitespace-only edit where one side starts: the insertion comes first", () => {
  const model = buildMergeModel(L("a", "b", "c"), L("a", "N", "b ", "c"), L("a", "Q", "c"), { whitespace: "trailing" });
  assert.equal(model.blocks.length, 1);
  const [b] = model.blocks;
  assert.equal(b.kind, "conflict");
  assert.deepEqual(b.left?.sideSpan, { start: 2, endExclusive: 4 }, "Yours' insertion and its edited line are one change");
  assert.notEqual(b.left?.whitespaceOnly, true, "an inserted line is more than whitespace");
});
