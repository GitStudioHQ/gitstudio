// Block staging (src/staging/blockStaging.ts) — a staged version that the
// working tree then cut a line out of, and blocks that differ by one edge.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChangeBlocks, sameBlock } from "../src/staging/blockStaging";

const T = (...lines: string[]): string => lines.join("\n") + "\n";

test("a line staged and then deleted in the working tree leaves its block partly staged", () => {
  // HEAD b → index X,Z,Y → working X,Y: the one change since HEAD is in the
  // index except for Z's deletion, a zero-width unstaged change inside it.
  const blocks = computeChangeBlocks(T("a", "b", "c"), T("a", "X", "Z", "Y", "c"), T("a", "X", "Y", "c"));
  assert.deepEqual(blocks, [{ head: { start: 1, end: 1 }, working: { start: 1, end: 2 }, state: "partial" }]);
});

test("the same block is the same four edges; any one differing is another block", () => {
  const b = { head: { start: 1, end: 2 }, working: { start: 3, end: 4 }, state: "staged" as const };
  assert.equal(sameBlock(b, { ...b, state: "partial" }), true, "the state is not identity");
  assert.equal(sameBlock(b, { ...b, head: { start: 0, end: 2 } }), false);
  assert.equal(sameBlock(b, { ...b, head: { start: 1, end: 3 } }), false);
  assert.equal(sameBlock(b, { ...b, working: { start: 2, end: 4 } }), false);
  assert.equal(sameBlock(b, { ...b, working: { start: 3, end: 5 } }), false);
});
