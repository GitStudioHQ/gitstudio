import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergeModel } from "../src/mergeModel";
import { isEmptySpan, sideBlockSpan } from "../src/types";

const lines = (arr: string[]): string => arr.join("\n");

/** What `acceptSide` writes for a side: the side's full block region. */
function acceptedText(
  block: ReturnType<typeof buildMergeModel>["blocks"][number],
  side: "left" | "right",
  oursLines: string[],
  theirsLines: string[],
): string {
  const span = sideBlockSpan(block, side);
  const src = side === "left" ? oursLines : theirsLines;
  return src.slice(span.start - 1, span.endExclusive - 1).join("\n");
}

const BASE = lines([
  'const greeting = "hello";',
  "const unchangedA = 1;",
  "const unchangedB = 2;",
  "let counter = 0;",
  "const unchangedC = 3;",
  "const unchangedD = 4;",
  'const footer = "base footer";',
]);

test("classifies the canonical fixture (2 conflicts + 1 auto-mergeable)", () => {
  const ours = lines([
    'const greeting = "hello from main";', // conflict (line 1)
    "const unchangedA = 1;",
    "const unchangedB = 2;",
    "let counter = 0;", // unchanged by ours
    "const unchangedC = 3;",
    "const unchangedD = 4;",
    'const footer = "main footer";', // conflict (line 7)
  ]);
  const theirs = lines([
    'const greeting = "hi from feature";', // conflict (line 1)
    "const unchangedA = 1;",
    "const unchangedB = 2;",
    "let counter = 100;", // right-only auto-merge (line 4)
    "const unchangedC = 3;",
    "const unchangedD = 4;",
    'const footer = "feature footer";', // conflict (line 7)
  ]);

  const model = buildMergeModel(BASE, ours, theirs);

  assert.equal(model.counts.total, 3);
  assert.equal(model.counts.conflicts, 2);
  assert.equal(model.counts.autoResolvable, 1);

  const [first, second, third] = model.blocks;
  assert.equal(first.kind, "conflict");
  assert.deepEqual(first.baseSpan, { start: 1, endExclusive: 2 });
  assert.ok(first.left && first.right);

  assert.equal(second.kind, "right-only");
  assert.deepEqual(second.baseSpan, { start: 4, endExclusive: 5 });
  assert.ok(second.right && !second.left);
  assert.equal(second.right?.role, "modified");

  assert.equal(third.kind, "conflict");
  assert.deepEqual(third.baseSpan, { start: 7, endExclusive: 8 });
});

test("a change on only one side is auto-mergeable, not a conflict", () => {
  const ours = lines(["a", "B-changed", "c"]);
  const theirs = lines(["a", "b", "c"]);
  const model = buildMergeModel(lines(["a", "b", "c"]), ours, theirs);

  assert.equal(model.counts.total, 1);
  assert.equal(model.counts.conflicts, 0);
  assert.equal(model.blocks[0].kind, "left-only");
  assert.equal(model.blocks[0].left?.role, "modified");
});

test("identical edits on both sides are 'both-same', not a conflict", () => {
  const ours = lines(["a", "SAME", "c"]);
  const theirs = lines(["a", "SAME", "c"]);
  const model = buildMergeModel(lines(["a", "b", "c"]), ours, theirs);

  assert.equal(model.counts.total, 1);
  assert.equal(model.counts.conflicts, 0);
  assert.equal(model.blocks[0].kind, "both-same");
});

test("an insertion produces an empty base span with role 'inserted'", () => {
  const ours = lines(["a", "NEW", "b", "c"]);
  const theirs = lines(["a", "b", "c"]);
  const model = buildMergeModel(lines(["a", "b", "c"]), ours, theirs);

  const block = model.blocks[0];
  assert.equal(block.kind, "left-only");
  assert.equal(block.left?.role, "inserted");
  assert.ok(isEmptySpan(block.left!.baseSpan));
});

test("a deletion produces an empty side span with role 'deleted'", () => {
  const ours = lines(["a", "c"]); // removed "b"
  const theirs = lines(["a", "b", "c"]);
  const model = buildMergeModel(lines(["a", "b", "c"]), ours, theirs);

  const block = model.blocks[0];
  assert.equal(block.kind, "left-only");
  assert.equal(block.left?.role, "deleted");
  assert.ok(isEmptySpan(block.left!.sideSpan));
});

test("overlapping edits on both sides at the same lines conflict", () => {
  const ours = lines(["a", "ours-x", "ours-y", "d"]);
  const theirs = lines(["a", "theirs-x", "theirs-y", "d"]);
  const model = buildMergeModel(lines(["a", "x", "y", "d"]), ours, theirs);

  assert.equal(model.counts.conflicts, 1);
  assert.equal(model.blocks[0].kind, "conflict");
});

test("clean input yields no blocks", () => {
  const model = buildMergeModel(BASE, BASE, BASE);
  assert.equal(model.counts.total, 0);
  assert.equal(model.blocks.length, 0);
});

test("accepting a side keeps its passthrough lines (modify/delete)", () => {
  // legacy.py: ours deleted the file, theirs changed only the body. The `def`
  // line is unchanged by theirs but part of the clustered conflict block.
  // Regression: accepting theirs used to write only its change hunk, dropping
  // the `def` line.
  const base = lines([
    "def old_handler(payload):",
    "    # legacy code path",
    "    return payload",
    "",
  ]);
  const ours = ""; // deleted on our side
  const theirs = lines([
    "def old_handler(payload):",
    "    # kept for the 1.5 line",
    '    return {"data": payload}',
    "",
  ]);
  const oursLines = ours.split("\n");
  const theirsLines = theirs.split("\n");

  const model = buildMergeModel(base, ours, theirs);
  assert.equal(model.counts.conflicts, 1);
  const block = model.blocks[0];

  // Accepting theirs keeps the whole function, including the unchanged def line.
  const right = acceptedText(block, "right", oursLines, theirsLines);
  assert.match(right, /^def old_handler\(payload\):/);
  assert.match(right, /return \{"data": payload\}/);

  // Accepting ours (the deleting side) removes the function.
  const left = acceptedText(block, "left", oursLines, theirsLines);
  assert.equal(left, "");
});

test("symmetric single-line conflict is unaffected by passthrough handling", () => {
  // leadIn/trailing are 0 here, so the accepted text is exactly the side line.
  const model = buildMergeModel(
    lines(["a", "b", "c"]),
    lines(["a", "OURS", "c"]),
    lines(["a", "THEIRS", "c"]),
  );
  const block = model.blocks[0];
  assert.equal(block.kind, "conflict");
  assert.equal(acceptedText(block, "left", ["a", "OURS", "c"], ["a", "THEIRS", "c"]), "OURS");
  assert.equal(acceptedText(block, "right", ["a", "OURS", "c"], ["a", "THEIRS", "c"]), "THEIRS");
});

test("a conflict with no common ancestor (base='') still conflicts", () => {
  // add/add conflicts, and the marker fallback for the default conflict style,
  // arrive with no base. Regression: the merge editor used to skip building
  // the model whenever there was no base (the `hasBase` guard), rendering
  // three dead panes and "0 conflicts".
  const ours = lines(["def feature_flag():", "    return 'main'"]);
  const theirs = lines(["def feature_flag():", "    return 'feature'"]);
  const model = buildMergeModel("", ours, theirs);

  assert.ok(model.counts.total > 0, "expected at least one block, got none");
  assert.ok(model.counts.conflicts > 0, "expected a conflict, got none");
});

test("'ignore all whitespace' suppresses whitespace-only side changes", () => {
  const base = lines(["a", "b", "c"]);
  const ours = lines(["a", "  b  ", "c"]); // whitespace-only change
  const theirs = lines(["a", "b", "c"]);

  const noisy = buildMergeModel(base, ours, theirs);
  assert.equal(noisy.counts.total, 1);

  const clean = buildMergeModel(base, ours, theirs, { whitespace: "all" });
  assert.equal(clean.counts.total, 0);
});
