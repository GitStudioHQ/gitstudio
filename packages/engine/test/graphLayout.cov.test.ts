// Commit-graph lanes (src/graph/layout.ts) — the input guards and slot reuse
// test/graphLayout.test.ts leaves: a re-emitted commit, a parent that was
// already drawn above its child, an interior lane freed and taken again, a
// degenerate merge naming one parent twice, and a colour count below one.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeGraphLayout, type GraphInputCommit, type GraphLayout, type GraphRow } from "../src/graph/layout";

const c = (sha: string, ...parents: string[]): GraphInputCommit => ({ sha, parents });

function row(layout: GraphLayout, sha: string): GraphRow {
  const r = layout.rows.find((x) => x.sha === sha);
  assert.ok(r, `expected a row for ${sha}`);
  return r;
}

test("a commit re-emitted by the paginator is drawn once and opens no orphan lane", () => {
  const layout = computeGraphLayout([c("A", "B"), c("B", "C"), c("A", "B"), c("C")]);
  assert.deepEqual(layout.rows.map((r) => r.sha), ["A", "B", "C"]);
  assert.equal(layout.totalColumns, 1, "still one straight lane");
  assert.deepEqual(layout.rows.map((r) => r.column), [0, 0, 0]);
  assert.deepEqual(row(layout, "C").segments, [], "the root continues nowhere");
});

test("a parent already drawn above its child is not waited for", () => {
  const layout = computeGraphLayout([c("P"), c("K", "P"), c("Q")]);
  assert.deepEqual(row(layout, "K").segments, [], "no line to a commit already placed");
  assert.equal(row(layout, "K").isMerge, false);
  // K's lane was never kept open, so the next tip takes column 0 again.
  assert.equal(row(layout, "Q").column, 0);
  assert.equal(layout.totalColumns, 1);
});

test("a lane freed in the middle is the next tip's, before a new one on the right", () => {
  const layout = computeGraphLayout([
    c("T1", "R1"),
    c("T2", "R2"),
    c("T3", "R3"),
    c("R2"), // a root in the middle lane: lane 1 frees, lane 2 stays
    c("T4", "R4"),
    c("R1"),
    c("R3"),
    c("R4"),
  ]);
  assert.deepEqual(
    ["T1", "T2", "T3", "R2", "T4"].map((s) => row(layout, s).column),
    [0, 1, 2, 1, 1],
  );
  assert.equal(layout.totalColumns, 3, "no fourth column was opened");
  const r2 = row(layout, "R2");
  // Lanes 0 and 2 pass by the root; nothing continues from it.
  assert.deepEqual(
    r2.segments.map((s) => [s.fromColumn, s.toColumn]).sort(),
    [[0, 0], [2, 2]],
  );
  assert.equal(r2.maxColumn, 2);
});

test("a merge naming one parent twice draws one edge but is still a merge", () => {
  const layout = computeGraphLayout([c("M", "P", "P"), c("P")]);
  const m = row(layout, "M");
  assert.equal(m.isMerge, true);
  assert.deepEqual(m.segments, [{ fromColumn: 0, toColumn: 0, color: m.color }]);
  assert.equal(layout.totalColumns, 1);
});

test("a colour count below one still gives every lane colour 0", () => {
  const layout = computeGraphLayout([c("A", "B"), c("X", "Y"), c("B"), c("Y")], { colorCount: 0 });
  assert.deepEqual(layout.rows.map((r) => r.color), [0, 0, 0, 0]);
  assert.deepEqual(layout.rows.map((r) => r.column), [0, 1, 0, 1]);
});

test("an empty history lays out nothing", () => {
  assert.deepEqual(computeGraphLayout([]), { rows: [], totalColumns: 0 });
});
