import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDiffModel } from "../src/diffModel";
import { isEmptySpan } from "../src/types";

const lines = (arr: string[]): string => arr.join("\n");

test("no blocks for identical texts", () => {
  const model = buildDiffModel(lines(["a", "b", "c"]), lines(["a", "b", "c"]));
  assert.equal(model.blocks.length, 0);
});

test("a single-line modification is one 'modified' block", () => {
  const model = buildDiffModel(
    lines(["a", "b", "c"]),
    lines(["a", "B", "c"]),
  );
  assert.equal(model.blocks.length, 1);
  const [block] = model.blocks;
  assert.equal(block.role, "modified");
  assert.deepEqual(block.leftSpan, { start: 2, endExclusive: 3 });
  assert.deepEqual(block.rightSpan, { start: 2, endExclusive: 3 });
});

test("an inserted line yields an empty left span with role 'inserted'", () => {
  const model = buildDiffModel(
    lines(["a", "b"]),
    lines(["a", "NEW", "b"]),
  );
  assert.equal(model.blocks.length, 1);
  const [block] = model.blocks;
  assert.equal(block.role, "inserted");
  assert.ok(isEmptySpan(block.leftSpan));
  assert.deepEqual(block.rightSpan, { start: 2, endExclusive: 3 });
});

test("a deleted line yields an empty right span with role 'deleted'", () => {
  const model = buildDiffModel(
    lines(["a", "b", "c"]),
    lines(["a", "c"]),
  );
  assert.equal(model.blocks.length, 1);
  const [block] = model.blocks;
  assert.equal(block.role, "deleted");
  assert.ok(isEmptySpan(block.rightSpan));
});

test("'ignore all whitespace' hides whitespace-only changes", () => {
  const left = lines(["a", "b", "c"]);
  const right = lines(["a", "  b  ", "c"]);
  const noisy = buildDiffModel(left, right, { whitespace: "none" });
  assert.equal(noisy.blocks.length, 1);
  const clean = buildDiffModel(left, right, { whitespace: "all" });
  assert.equal(clean.blocks.length, 0);
});

test("'ignore trailing whitespace' hides trailing-only changes", () => {
  const left = lines(["a", "b", "c"]);
  const right = lines(["a", "b   ", "c"]);
  const clean = buildDiffModel(left, right, { whitespace: "trailing" });
  assert.equal(clean.blocks.length, 0);
});

test("'ignore all whitespace' still reports genuine content changes", () => {
  const left = lines(["a", "b", "c"]);
  const right = lines(["a", "B", "c"]);
  const model = buildDiffModel(left, right, { whitespace: "all" });
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].role, "modified");
});
