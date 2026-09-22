import { test } from "node:test";
import assert from "node:assert/strict";
import { buildMergeModel } from "../src/mergeModel";
import { normalizeEol, splitLines, type WhitespaceMode } from "../src/lineDiff";
import {
  blockTone,
  category,
  sideBlockSpan,
  type ChangeBlock,
  type ChangeRole,
  type ChangeType,
  type LineSpan,
  type Side,
} from "../src/types";

/**
 * The colour classification table (PLAN Appendix A). Every row is one merge
 * the engine must classify the way JetBrains does — git's own verdict
 * (`git merge-file`) is in the comment where the two used to disagree with us.
 *
 * Each row asserts what the merge UI paints (kind, type, per-side types),
 * what the wand may do (resolvable + resolvedText), and what accepting a side
 * WRITES (its full block region through sideBlockSpan) — because a wrong
 * category is not only the wrong colour: the old false "both-same" of row 10
 * let "Apply non-conflicting" drop Theirs' deletion without a word.
 */

interface Expect {
  /** Blocks expected (default 1). */
  blocks?: number;
  kind: ChangeBlock["kind"];
  type: ChangeRole;
  leftType?: ChangeType;
  rightType?: ChangeType;
  exact?: boolean;
  resolvable?: boolean;
  resolvedText?: string;
  whitespaceOnly?: boolean;
  baseSpan?: LineSpan;
  /** Accepting Yours / Theirs writes exactly this. */
  acceptLeft?: string;
  acceptRight?: string;
  eolMismatch?: boolean;
}

interface Row {
  n: number;
  name: string;
  base: string;
  ours: string;
  theirs: string;
  mode?: WhitespaceMode;
  expect: Expect;
}

const ROWS: Row[] = [
  {
    n: 1, name: "identical modify",
    base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\nX\nc",
    expect: { kind: "both-same", type: "modified", leftType: "modified", rightType: "modified", exact: true, acceptLeft: "X", acceptRight: "X" },
  },
  {
    n: 2, name: "identical insert",
    base: "a\nc", ours: "a\nN\nc", theirs: "a\nN\nc",
    expect: { kind: "both-same", type: "inserted", leftType: "inserted", rightType: "inserted", exact: true, acceptLeft: "N" },
  },
  {
    n: 3, name: "identical delete",
    base: "a\nb\nc", ours: "a\nc", theirs: "a\nc",
    expect: { kind: "both-same", type: "deleted", leftType: "deleted", rightType: "deleted", exact: true, acceptLeft: "", acceptRight: "" },
  },
  {
    n: 4, name: "different modify",
    base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\nY\nc",
    expect: { kind: "conflict", type: "conflict", leftType: "modified", rightType: "modified", resolvable: false, acceptLeft: "X", acceptRight: "Y" },
  },
  {
    n: 5, name: "sides differ in whitespace only, mode none",
    base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx  =  1\nc",
    expect: { kind: "conflict", type: "conflict", resolvable: false },
  },
  {
    n: 6, name: "sides differ in trailing whitespace, mode trailing (≈)",
    base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx = 1   \nc", mode: "trailing",
    // Today: conflict. The pick decides whose whitespace wins.
    expect: { kind: "both-same", type: "modified", exact: false, acceptLeft: "x = 1", acceptRight: "x = 1   " },
  },
  {
    n: 7, name: "sides differ in internal whitespace, mode all (≈)",
    base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx  =  1\nc", mode: "all",
    expect: { kind: "both-same", type: "modified", exact: false },
  },
  {
    n: 8, name: "internal whitespace, mode trailing — trim does not equalise inner runs",
    base: "a\nb\nc", ours: "a\nx = 1\nc", theirs: "a\nx  =  1\nc", mode: "trailing",
    expect: { kind: "conflict", type: "conflict" },
  },
  {
    n: 9, name: "delete vs modify",
    base: "a\nb\nc", ours: "a\nc", theirs: "a\nB2\nc",
    expect: { kind: "conflict", type: "conflict", leftType: "deleted", rightType: "modified", resolvable: false, acceptLeft: "", acceptRight: "B2" },
  },
  {
    n: 10, name: "FALSE both-same: overlapping regions whose change hunks read the same",
    base: "a\nb\nc\nd", ours: "a\nQ\nc\nd", theirs: "a\nQ\nd",
    // Today: both-same, and "Apply non-conflicting" took Yours — keeping `c`,
    // which Theirs deleted. git merge-file: 1 conflict.
    expect: { kind: "conflict", type: "conflict", baseSpan: { start: 2, endExclusive: 4 }, resolvable: false, acceptLeft: "Q\nc", acceptRight: "Q" },
  },
  {
    n: 11, name: "final newline differs",
    base: "a\nb\n", ours: "a\nX\n", theirs: "a\nX",
    // Today: both-same (dropping Theirs' removal of the final newline).
    expect: { kind: "conflict", type: "conflict", acceptLeft: "X\n", acceptRight: "X" },
  },
  {
    n: 12, name: "overlapping 2-3 vs 3-4",
    base: "a\nb\nc\nd\ne", ours: "a\nB\nC\nd\ne", theirs: "a\nb\nC2\nD\ne",
    expect: { kind: "conflict", type: "conflict", baseSpan: { start: 2, endExclusive: 5 }, resolvable: false },
  },
  {
    n: 13, name: "adjacent (touching) edits are ONE conflict — and resolvable",
    base: "a\nb\nc\nd", ours: "a\nB\nc\nd", theirs: "a\nb\nC\nd",
    // Today: two independent auto-merged blocks. git merge-file: 1 conflict.
    expect: {
      kind: "conflict", type: "conflict", baseSpan: { start: 2, endExclusive: 4 },
      resolvable: true, resolvedText: "B\nC", acceptLeft: "B\nc", acceptRight: "b\nC",
    },
  },
  {
    n: 14, name: "separated by one line: two one-sided changes",
    base: "a\nb\nc\nd", ours: "a\nB\nc\nd", theirs: "a\nb\nc\nD",
    expect: { blocks: 2, kind: "left-only", type: "modified", leftType: "modified", acceptLeft: "B" },
  },
  {
    n: 15, name: "inserts at the same point",
    base: "a\nc", ours: "a\nN1\nc", theirs: "a\nN2\nc",
    // Which goes first is not decidable: not resolvable.
    expect: { kind: "conflict", type: "conflict", leftType: "inserted", rightType: "inserted", resolvable: false },
  },
  {
    n: 16, name: "insert touching a modify",
    base: "a\nb\nc", ours: "a\nN\nb\nc", theirs: "a\nB\nc",
    expect: { kind: "conflict", type: "conflict", resolvable: true, resolvedText: "N\nB", acceptLeft: "N\nb", acceptRight: "B" },
  },
  {
    n: 17, name: "add/add identical",
    base: "", ours: "x\ny", theirs: "x\ny",
    // Today: blue (modified) — the phantom line of splitLines("") counted as base.
    expect: { kind: "both-same", type: "inserted", leftType: "inserted", rightType: "inserted", exact: true, acceptLeft: "x\ny" },
  },
  {
    n: 18, name: "add/add different",
    base: "", ours: "def f():\n  return 1", theirs: "def f():\n  return 2",
    expect: { kind: "conflict", type: "conflict", leftType: "inserted", rightType: "inserted", resolvable: false },
  },
  {
    n: 19, name: "same change, one side CRLF",
    base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\r\nX\r\nc",
    // Today: a whole-file conflict.
    expect: { kind: "both-same", type: "modified", exact: true, eolMismatch: true },
  },
  {
    n: 20, name: "one side only rewrote its line endings",
    base: "a\nb\nc", ours: "a\r\nb\r\nc", theirs: "a\nB\nc",
    // Today: a whole-file conflict.
    expect: { kind: "right-only", type: "modified", rightType: "modified", baseSpan: { start: 2, endExclusive: 3 }, eolMismatch: true, acceptRight: "B" },
  },
  {
    n: 21, name: "whitespace-only edit on one side, mode all",
    base: "a\nb\nc", ours: "a\n  b  \nc", theirs: "a\nb\nc", mode: "all",
    // Today: dropped — zero blocks, and the result kept base's bytes.
    expect: { kind: "left-only", type: "modified", leftType: "modified", whitespaceOnly: true, acceptLeft: "  b  " },
  },
  {
    n: 22, name: "whitespace-only on both sides, different, mode trailing",
    base: "a\nb\nc", ours: "a\nb  \nc", theirs: "a\nb\t\nc", mode: "trailing",
    // Today: dropped.
    expect: { kind: "both-same", type: "modified", whitespaceOnly: true, exact: false, acceptLeft: "b  ", acceptRight: "b\t" },
  },
  {
    n: 23, name: "both delete the whole file",
    base: "a\nb\n", ours: "", theirs: "",
    // Today: the wrong type (the phantom line again).
    expect: { kind: "both-same", type: "deleted", leftType: "deleted", rightType: "deleted", exact: true, acceptLeft: "", acceptRight: "" },
  },
  {
    n: 24, name: "Yours deletes the whole file, Theirs edits it",
    base: "a\nb\n", ours: "", theirs: "a\nB\n",
    expect: { kind: "conflict", type: "conflict", leftType: "deleted", rightType: "modified", resolvable: false, acceptLeft: "", acceptRight: "a\nB\n" },
  },
  {
    n: 25, name: "same change plus an extra edit on one side",
    base: "a\nb\nc", ours: "a\nX\nc", theirs: "a\nX\nZ",
    expect: { kind: "conflict", type: "conflict", baseSpan: { start: 2, endExclusive: 4 }, resolvable: false, acceptLeft: "X\nc", acceptRight: "X\nZ" },
  },
  {
    n: 26, name: "both delete a line, one also edits its neighbour",
    base: "a\nb\nc\nd", ours: "a\nd", theirs: "a\nC2\nd",
    expect: { kind: "conflict", type: "conflict", baseSpan: { start: 2, endExclusive: 4 }, leftType: "deleted", rightType: "modified", resolvable: false },
  },
];

/** What `acceptSide` writes for a side: the side's full block region. */
function accepted(block: ChangeBlock, side: Side, text: string): string {
  if (normalizeEol(text) === "") {
    return "";
  }
  const lines = splitLines(normalizeEol(text));
  const span = sideBlockSpan(block, side);
  return lines.slice(span.start - 1, span.endExclusive - 1).join("\n");
}

for (const row of ROWS) {
  test(`Appendix A #${row.n}: ${row.name}`, () => {
    const model = buildMergeModel(row.base, row.ours, row.theirs, {
      whitespace: row.mode ?? "none",
    });
    const e = row.expect;
    assert.equal(model.blocks.length, e.blocks ?? 1, "block count");
    const block = model.blocks[0];
    assert.equal(block.kind, e.kind, "kind");
    assert.equal(block.type, e.type, "type");
    if ("leftType" in e) assert.equal(block.leftType, e.leftType, "leftType");
    if ("rightType" in e) assert.equal(block.rightType, e.rightType, "rightType");
    if ("exact" in e) assert.equal(block.exact, e.exact, "exact");
    if (e.kind !== "both-same") assert.equal(block.exact, undefined, "exact is only set on identical blocks");
    if ("resolvable" in e) assert.equal(block.resolvable ?? false, e.resolvable, "resolvable");
    if ("resolvedText" in e) assert.equal(block.resolvedText, e.resolvedText, "resolvedText");
    if (!block.resolvable) assert.equal(block.resolvedText, undefined, "no resolvedText without resolvable");
    if ("whitespaceOnly" in e) assert.equal(block.whitespaceOnly ?? false, e.whitespaceOnly, "whitespaceOnly");
    if (e.baseSpan) assert.deepEqual(block.baseSpan, e.baseSpan, "baseSpan");
    if ("acceptLeft" in e) assert.equal(accepted(block, "left", row.ours), e.acceptLeft, "accepting Yours writes");
    if ("acceptRight" in e) assert.equal(accepted(block, "right", row.theirs), e.acceptRight, "accepting Theirs writes");
    assert.equal(!!model.eolMismatch, e.eolMismatch ?? false, "eolMismatch");

    // The counts agree with the blocks.
    const conflicts = model.blocks.filter((b) => b.kind === "conflict").length;
    assert.equal(model.counts.conflicts, conflicts);
    assert.equal(model.counts.identical, model.blocks.filter((b) => b.kind === "both-same").length);
    assert.equal(model.counts.resolvableConflicts, model.blocks.filter((b) => b.resolvable).length);
    assert.equal(model.counts.autoResolvable, model.blocks.length - conflicts);
  });
}

test("row 14's second block is the Theirs-only change", () => {
  const model = buildMergeModel("a\nb\nc\nd", "a\nB\nc\nd", "a\nb\nc\nD");
  const [, second] = model.blocks;
  assert.equal(second.kind, "right-only");
  assert.equal(second.rightType, "modified");
  assert.deepEqual(second.baseSpan, { start: 4, endExclusive: 5 });
  assert.equal(model.counts.conflicts, 0);
});

test("category() is exactly the merge UI's four categories", () => {
  const cats = (base: string, ours: string, theirs: string) =>
    buildMergeModel(base, ours, theirs).blocks.map(category);
  assert.deepEqual(cats("a\nb\nc", "a\nX\nc", "a\nY\nc"), ["conflict"]);
  assert.deepEqual(cats("a\nb\nc", "a\nX\nc", "a\nX\nc"), ["same"]);
  assert.deepEqual(cats("a\nb\nc\nd", "a\nB\nc\nd", "a\nb\nc\nD"), ["yours-only", "theirs-only"]);
});

test("blockTone paints one-sided changes by what they did, the rest by category", () => {
  const tones = (base: string, ours: string, theirs: string) =>
    buildMergeModel(base, ours, theirs).blocks.map(blockTone);
  // Yours inserts, Theirs deletes further down: green, then grey.
  assert.deepEqual(tones("a\nb\nc\nd", "a\nN\nb\nc\nd", "a\nb\nc"), ["inserted", "deleted"]);
  assert.deepEqual(tones("a\nb\nc", "a\nX\nc", "a\nX\nc"), ["same"]);
  assert.deepEqual(tones("a\nb\nc", "a\nX\nc", "a\nY\nc"), ["conflict"]);
});

test("a whitespace-only change beside a real one on the same side joins it, and is not flagged", () => {
  // Yours re-indents line 2 and rewrites line 3: one region, one real change.
  const model = buildMergeModel("a\nb\nc\nd", "a\n  b\nC\nd", "a\nb\nc\nd", { whitespace: "all" });
  assert.equal(model.blocks.length, 1);
  const block = model.blocks[0];
  assert.equal(block.kind, "left-only");
  assert.equal(block.whitespaceOnly, undefined);
  assert.equal(accepted(block, "left", "a\n  b\nC\nd"), "  b\nC", "accepting Yours keeps its re-indent too");
});

test("a whitespace-only edit that touches the other side's real edit is a conflict, never a silent loss", () => {
  // Under "Trim", Yours re-indents line 2 and Theirs rewrites line 3. Taking
  // Theirs alone would throw Yours' edit away, so the two are reconciled —
  // and since they do not overlap, the wand can apply both.
  const model = buildMergeModel("a\nb\nc\nd", "a\n  b\nc\nd", "a\nb\nC\nd", { whitespace: "trailing" });
  assert.equal(model.blocks.length, 1);
  const block = model.blocks[0];
  assert.equal(block.kind, "conflict");
  assert.equal(block.resolvable, true);
  assert.equal(block.resolvedText, "  b\nC");
});

test("an identical-up-to-whitespace block is exact once whitespace counts again", () => {
  // Row 6 under "none": the sides really differ, so it is a conflict, not ≈.
  const model = buildMergeModel("a\nb\nc", "a\nx = 1\nc", "a\nx = 1   \nc");
  assert.equal(model.blocks[0].kind, "conflict");
});
