import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSide, splitLines } from "../src/lineDiff";
import { buildMergeModel } from "../src/mergeModel";

/**
 * `DiffOptions.innerLineBudget` promised to skip the character-level (word)
 * diff above a combined line count, and nothing ever read it. The views skip
 * DRAWING word ranges on a large file (LARGE_FILE_LINE_THRESHOLD), but the
 * engine still computed them — and in "all" whitespace mode it computes them
 * twice (a second diff per change on the original lines), which is what a
 * large rewritten file pays for nothing.
 */

const base = splitLines("one\ntwo three\nfour\nfive\nsix\n");
const side = splitLines("one\ntwo 3\nfour\nfive\nsix\n");

test("without a budget, a modified line carries its word ranges", () => {
  for (const whitespace of ["none", "all"] as const) {
    const [c] = diffSide(base, side, "right", { whitespace });
    assert.ok(c.innerBase.length > 0 && c.innerSide.length > 0, whitespace);
  }
});

test("over the budget, no word ranges are computed — in every whitespace mode", () => {
  for (const whitespace of ["none", "trailing", "all"] as const) {
    const [c] = diffSide(base, side, "right", { whitespace, innerLineBudget: 4 });
    assert.ok(c, `${whitespace}: the line change itself is still found`);
    assert.deepEqual(c.innerBase, [], whitespace);
    assert.deepEqual(c.innerSide, [], whitespace);
  }
});

test("under the budget nothing changes", () => {
  const [c] = diffSide(base, side, "right", { whitespace: "all", innerLineBudget: 1000 });
  assert.ok(c.innerBase.length > 0);
});

test("the merge model honours it too (both sides)", () => {
  const m = buildMergeModel(base.join("\n"), side.join("\n"), base.join("\n").replace("six", "SIX"), {
    whitespace: "all",
    innerLineBudget: 4,
  });
  for (const b of m.blocks) {
    for (const ch of [b.left, b.right]) {
      if (!ch) continue;
      assert.deepEqual(ch.innerBase, []);
      assert.deepEqual(ch.innerSide, []);
    }
  }
});
