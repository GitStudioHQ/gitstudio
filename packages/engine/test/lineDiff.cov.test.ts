// Line diffing (src/lineDiff.ts) — the dominant line ending when the first
// one seen isn't it, and a pure insertion under whitespace "all".

import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEol, diffSide } from "../src/lineDiff";

test("the dominant line ending wins over the first one seen; a tie goes to the first", () => {
  assert.equal(detectEol("a\r\nb\nc\n"), "LF");
  assert.equal(detectEol("a\rb\rc\r\nd"), "CR");
  assert.equal(detectEol("a\nb\r\nc"), "LF", "one each: the first");
  assert.equal(detectEol("no breaks"), "none");
});

test("under whitespace 'all' a pure insertion is found, with no word ranges (there is nothing to compare)", () => {
  const changes = diffSide(["a", "b"], ["a", "x   y", "b"], "left", { whitespace: "all" });
  assert.deepEqual(changes, [
    { side: "left", role: "inserted", baseSpan: { start: 2, endExclusive: 2 }, sideSpan: { start: 2, endExclusive: 3 }, innerBase: [], innerSide: [] },
  ]);
});

test("under whitespace 'all' a line that changed words carries word ranges on its original columns", () => {
  const [change] = diffSide(["a", "one  two", "c"], ["a", "one  TWO", "c"], "right", { whitespace: "all" });
  assert.equal(change.role, "modified");
  assert.deepEqual([change.baseSpan, change.sideSpan], [{ start: 2, endExclusive: 3 }, { start: 2, endExclusive: 3 }]);
  assert.ok(change.innerSide.length > 0);
  // "TWO" starts at column 6 of the original line (1-based), after the double space.
  assert.ok(change.innerSide.every((r) => r.startLine === 2 && r.startColumn >= 6), JSON.stringify(change.innerSide));
});
