import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeAlignmentZones,
  computeDiffAlignment,
} from "../src/alignment";
import { buildMergeModel } from "../src/mergeModel";
import { buildDiffModel } from "../src/diffModel";

const lines = (arr: string[]): string => arr.join("\n");

test("pads result and right when left replaces 1 line with 3", () => {
  const model = buildMergeModel(
    lines(["a", "b", "c"]),
    lines(["a", "X", "Y", "Z", "c"]),
    lines(["a", "b", "c"]),
  );
  const zones = computeAlignmentZones(model);
  assert.deepEqual(zones.left, []);
  assert.deepEqual(zones.result, [{ afterLineNumber: 2, lines: 2 }]);
  assert.deepEqual(zones.right, [{ afterLineNumber: 2, lines: 2 }]);
});

test("no spacers when all blocks are single-line replacements", () => {
  const model = buildMergeModel(
    lines(["a", "b", "c"]),
    lines(["a", "B1", "c"]),
    lines(["a", "b", "C1"]),
  );
  const zones = computeAlignmentZones(model);
  assert.deepEqual(zones.left, []);
  assert.deepEqual(zones.result, []);
  assert.deepEqual(zones.right, []);
});

test("insertion on one side adds a spacer at the gap on the other panes", () => {
  const model = buildMergeModel(
    lines(["a", "b"]),
    lines(["a", "NEW", "b"]),
    lines(["a", "b"]),
  );
  const zones = computeAlignmentZones(model);
  assert.deepEqual(zones.left, []);
  assert.deepEqual(zones.result, [{ afterLineNumber: 1, lines: 1 }]);
  assert.deepEqual(zones.right, [{ afterLineNumber: 1, lines: 1 }]);
});

test("re-balances spacers from the CURRENT result span after an accept", () => {
  // Left replaces 1 line with 3; the user accepts left, so the result block
  // grows from 1 line (base) to 3 lines and no longer needs a spacer.
  const model = buildMergeModel(
    lines(["a", "b", "c"]),
    lines(["a", "X", "Y", "Z", "c"]),
    lines(["a", "b", "c"]),
  );
  const zones = computeAlignmentZones(model, () => ({
    start: 2,
    endExclusive: 5, // accepted left text now occupies result lines 2-4
  }));
  assert.deepEqual(zones.left, []);
  assert.deepEqual(zones.result, []);
  assert.deepEqual(zones.right, [{ afterLineNumber: 2, lines: 2 }]);
});

test("re-balances spacers when an accepted deletion empties the result span", () => {
  // Left deleted line "b"; accepting left collapses the result span to empty,
  // so result needs the same gap spacer the left pane gets.
  const model = buildMergeModel(
    lines(["a", "b", "c"]),
    lines(["a", "c"]),
    lines(["a", "b", "c"]),
  );
  const zones = computeAlignmentZones(model, () => ({
    start: 2,
    endExclusive: 2,
  }));
  assert.deepEqual(zones.left, [{ afterLineNumber: 1, lines: 1 }]);
  assert.deepEqual(zones.result, [{ afterLineNumber: 1, lines: 1 }]);
  assert.deepEqual(zones.right, []);
});

test("clustered block counts each side's untouched passthrough lines", () => {
  // Left modifies b,c -> X,Y (keeps d); right deletes c,d (keeps b). The two
  // changes overlap into ONE conflict block whose union baseSpan covers b,c,d.
  // Inside that union, "d" is passthrough for left and "b" is passthrough for
  // right — both must count toward their pane's height. Counting only sideSpan
  // (the old bug) over-spaced the left pane and drifted every pane below it.
  const model = buildMergeModel(
    lines(["a", "b", "c", "d", "e"]),
    lines(["a", "X", "Y", "d", "e"]),
    lines(["a", "b", "e"]),
  );
  const zones = computeAlignmentZones(model);
  // ours = [X,Y,d] = 3 lines, result = [b,c,d] = 3, theirs = [b] = 1 → pad +2.
  assert.deepEqual(zones.left, []);
  assert.deepEqual(zones.result, []);
  assert.deepEqual(zones.right, [{ afterLineNumber: 2, lines: 2 }]);
});

test("no cumulative drift across many mixed clustered blocks", () => {
  // Repeats a 4-line unit where ours and theirs touch DIFFERENT base lines that
  // cluster together. Total visual height must stay equal across all three
  // panes — otherwise pixel-locked scroll sync makes them drift further apart
  // the deeper you scroll (the reported load-test failure).
  const base: string[] = [];
  const ours: string[] = [];
  const theirs: string[] = [];
  for (let i = 0; i < 50; i++) {
    base.push(`k${i}a`, `k${i}b`, `k${i}c`, `k${i}d`);
    ours.push(`k${i}A`, `k${i}B`, `k${i}c`, `k${i}d`); // modifies a,b
    theirs.push(`k${i}a`, `k${i}b`); // deletes c,d
  }
  const model = buildMergeModel(lines(base), lines(ours), lines(theirs));
  const zones = computeAlignmentZones(model);
  const sum = (s: { lines: number }[]): number =>
    s.reduce((t, z) => t + z.lines, 0);
  const heightRes = base.length + sum(zones.result);
  assert.equal(ours.length + sum(zones.left), heightRes);
  assert.equal(theirs.length + sum(zones.right), heightRes);
});

test("diff: a right-side insertion pads the left pane at the gap", () => {
  const model = buildDiffModel(lines(["a", "b"]), lines(["a", "NEW", "b"]));
  const zones = computeDiffAlignment(model);
  assert.deepEqual(zones.right, []);
  assert.deepEqual(zones.left, [{ afterLineNumber: 1, lines: 1 }]);
});

test("diff: a right-side deletion pads the right pane at the gap", () => {
  const model = buildDiffModel(lines(["a", "b", "c"]), lines(["a", "c"]));
  const zones = computeDiffAlignment(model);
  assert.deepEqual(zones.left, []);
  assert.deepEqual(zones.right, [{ afterLineNumber: 1, lines: 1 }]);
});

test("diff: single-line modification needs no spacers", () => {
  const model = buildDiffModel(lines(["a", "b", "c"]), lines(["a", "B", "c"]));
  const zones = computeDiffAlignment(model);
  assert.deepEqual(zones.left, []);
  assert.deepEqual(zones.right, []);
});

test("alignment handles a no-common-ancestor model (base='') without throwing", () => {
  // With the `hasBase` guard removed, the no-base model now reaches the
  // alignment math; the span arithmetic must stay well-defined.
  const model = buildMergeModel("", lines(["x", "y"]), lines(["p", "q", "r"]));
  let zones!: ReturnType<typeof computeAlignmentZones>;
  assert.doesNotThrow(() => {
    zones = computeAlignmentZones(model);
  });
  assert.ok(Array.isArray(zones.left));
  assert.ok(Array.isArray(zones.result));
  assert.ok(Array.isArray(zones.right));
});
