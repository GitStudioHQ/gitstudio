// Merge-model helpers (src/types.ts) — a side that made no change in a block,
// and the block's role.

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergeModel } from "../src/mergeModel";
import { blockRole, sideBlockSpan } from "../src/types";

const L = (...l: string[]) => l.join("\n") + "\n";

test("a side that made no change in a block spans nothing, at the block's start", () => {
  const model = buildMergeModel(L("a", "b", "c"), L("a", "b", "c"), L("a", "B", "c"));
  assert.equal(model.blocks.length, 1);
  const [block] = model.blocks;
  assert.equal(block.kind, "right-only");
  assert.equal(block.left, undefined);
  assert.deepEqual(sideBlockSpan(block, "left"), { start: block.baseSpan.start, endExclusive: block.baseSpan.start });
  assert.deepEqual(sideBlockSpan(block, "right"), { start: 2, endExclusive: 3 });
});

test("a block's role is what the change did, or conflict", () => {
  const mod = buildMergeModel(L("a", "b", "c"), L("a", "b", "c"), L("a", "B", "c")).blocks[0];
  assert.equal(blockRole(mod), "modified");
  const ins = buildMergeModel(L("a", "c"), L("a", "X", "c"), L("a", "c")).blocks[0];
  assert.equal(blockRole(ins), "inserted");
  const del = buildMergeModel(L("a", "b", "c"), L("a", "c"), L("a", "b", "c")).blocks[0];
  assert.equal(blockRole(del), "deleted");
  const conflict = buildMergeModel(L("a", "b", "c"), L("a", "X", "c"), L("a", "Y", "c")).blocks[0];
  assert.equal(blockRole(conflict), "conflict");
});
