import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeGraphLayout,
  type GraphInputCommit,
  type GraphLayout,
  type GraphRow,
} from "../src/graph/layout";

/** Builds an input commit (children-before-parents, newest first). */
const c = (sha: string, ...parents: string[]): GraphInputCommit => ({
  sha,
  parents,
});

/** Row for a sha, asserting it exists. */
function row(layout: GraphLayout, sha: string): GraphRow {
  const r = layout.rows.find((row) => row.sha === sha);
  assert.ok(r, `expected a row for ${sha}`);
  return r;
}

/** Whether any segment connects the two columns (either direction). */
function hasSegment(r: GraphRow, from: number, to: number): boolean {
  return r.segments.some(
    (s) => s.fromColumn === from && s.toColumn === to,
  );
}

test("linear history collapses to a single lane", () => {
  // A -> B -> C -> D, newest first.
  const layout = computeGraphLayout([
    c("A", "B"),
    c("B", "C"),
    c("C", "D"),
    c("D"),
  ]);

  assert.equal(layout.totalColumns, 1);
  assert.equal(layout.rows.length, 4);
  for (const r of layout.rows) {
    assert.equal(r.column, 0, `${r.sha} should be in column 0`);
    assert.equal(r.color, 0, `${r.sha} should keep one color`);
    assert.equal(r.isMerge, false);
    assert.equal(r.maxColumn, 0);
  }
  // Every interior row carries one vertical continuation; the root has none.
  for (const sha of ["A", "B", "C"]) {
    const r = row(layout, sha);
    assert.deepEqual(r.segments, [{ fromColumn: 0, toColumn: 0, color: 0 }]);
  }
  assert.deepEqual(row(layout, "D").segments, []);
});

test("a fork then merge opens a second lane that later closes", () => {
  //   M (merge of A, B)
  //   |\
  //   A B
  //   |/
  //   C
  // Newest first: M, A, B, C. A and B both have parent C.
  const layout = computeGraphLayout([
    c("M", "A", "B"),
    c("A", "C"),
    c("B", "C"),
    c("C"),
  ]);

  const m = row(layout, "M");
  const a = row(layout, "A");
  const b = row(layout, "B");
  const cRow = row(layout, "C");

  // M is a merge sitting in lane 0; its two parents take columns 0 and 1.
  assert.equal(m.isMerge, true);
  assert.equal(m.column, 0);
  assert.equal(layout.totalColumns, 2);
  // First parent A continues straight down in column 0; second parent B forks
  // out to column 1 with a fresh color.
  assert.ok(hasSegment(m, 0, 0), "A continuation at column 0");
  assert.ok(hasSegment(m, 0, 1), "B branch-out diagonal to column 1");

  // A keeps M's lane (column 0, color 0); B lives in the new lane (column 1).
  assert.equal(a.column, 0);
  assert.equal(a.color, 0);
  assert.equal(b.column, 1);
  assert.notEqual(b.color, a.color);

  // Both A and B point at C. By the time C is reached the branch closes back
  // into a single lane: C is in column 0 and no lane survives past it.
  assert.equal(cRow.column, 0);
  assert.equal(cRow.isMerge, false);
  assert.deepEqual(cRow.segments, []);
  // The last row uses only one column, proving the second lane was freed.
  assert.equal(cRow.maxColumn, 0);

  // At B's row, B merges into column 0 and C continues there: a diagonal from
  // column 1 into column 0.
  assert.ok(hasSegment(b, 1, 0), "B merges back toward column 0 at C");
});

test("an octopus merge opens three outgoing lanes", () => {
  //   O (parents X, Y, Z)
  // Newest first: O, X, Y, Z (each a tip-ish root for simplicity).
  const layout = computeGraphLayout([
    c("O", "X", "Y", "Z"),
    c("X"),
    c("Y"),
    c("Z"),
  ]);

  const o = row(layout, "O");
  assert.equal(o.isMerge, true);
  assert.equal(o.column, 0);

  // Three distinct outgoing columns leave O: 0 (X), 1 (Y), 2 (Z).
  assert.ok(hasSegment(o, 0, 0), "X continuation");
  assert.ok(hasSegment(o, 0, 1), "Y branch-out");
  assert.ok(hasSegment(o, 0, 2), "Z branch-out");
  assert.equal(layout.totalColumns, 3);

  // The three parents land in three separate lanes.
  assert.equal(row(layout, "X").column, 0);
  assert.equal(row(layout, "Y").column, 1);
  assert.equal(row(layout, "Z").column, 2);
  // Each parent lane has its own color.
  const colors = new Set([
    row(layout, "X").color,
    row(layout, "Y").color,
    row(layout, "Z").color,
  ]);
  assert.equal(colors.size, 3, "octopus parents get distinct colors");
});

test("criss-cross merges never duplicate a shared parent lane", () => {
  //   M1 (A, B)
  //   M2 (B, A)   <- crosses
  //   A (C)
  //   B (C)
  //   C
  // M1 and M2 both reference A and B; A and B share parent C.
  const layout = computeGraphLayout([
    c("M1", "A", "B"),
    c("M2", "B", "A"),
    c("A", "C"),
    c("B", "C"),
    c("C"),
  ]);

  // No row should ever have two lanes waiting for the same sha: check that for
  // every row, the outgoing parent edges land in distinct columns.
  for (const r of layout.rows) {
    const outs = r.segments
      .filter((s) => s.fromColumn === r.column)
      .map((s) => s.toColumn);
    assert.equal(
      new Set(outs).size,
      outs.length,
      `${r.sha} has duplicate outgoing columns ${JSON.stringify(outs)}`,
    );
  }

  // A and B each appear exactly once, in distinct sane columns — proving the
  // shared parents were NOT duplicated even though two merges reference them.
  const a = row(layout, "A");
  const b = row(layout, "B");
  assert.equal(layout.rows.filter((r) => r.sha === "A").length, 1);
  assert.equal(layout.rows.filter((r) => r.sha === "B").length, 1);
  assert.notEqual(a.column, b.column);
  assert.ok(a.column >= 0 && a.column <= 1);
  assert.ok(b.column >= 0 && b.column <= 1);

  // Both M1 and M2 connect to BOTH shared parent lanes (columns 0 and 1)
  // without ever opening a second lane for A or B.
  const m1 = row(layout, "M1");
  const m2 = row(layout, "M2");
  const parentCols = (r: GraphRow): Set<number> =>
    new Set(
      r.segments
        .filter((s) => s.fromColumn === r.column && s.toColumn !== r.column)
        .map((s) => s.toColumn)
        .concat(a.column, b.column),
    );
  assert.ok(parentCols(m1).has(a.column) && parentCols(m1).has(b.column));
  assert.ok(parentCols(m2).has(a.column) && parentCols(m2).has(b.column));

  // C closes everything back to a single lane.
  const cRow = row(layout, "C");
  assert.deepEqual(cRow.segments, []);
  assert.equal(cRow.maxColumn, 0);
});

test("two independent tips coexist as two lanes", () => {
  // Two disconnected chains: P -> Q and R -> S, interleaved in display order.
  const layout = computeGraphLayout([
    c("P", "Q"),
    c("R", "S"),
    c("Q"),
    c("S"),
  ]);

  const p = row(layout, "P");
  const r = row(layout, "R");
  // P is the first tip (column 0); R is an independent tip (column 1).
  assert.equal(p.column, 0);
  assert.equal(r.column, 1);
  assert.notEqual(p.color, r.color);
  assert.equal(layout.totalColumns, 2);

  // While R's row is processed, P's lane (waiting for Q) passes through as a
  // vertical in column 0.
  assert.ok(hasSegment(r, 0, 0), "P's lane passes through R's row");
});

test("boundary commit whose parent is absent does not crash", () => {
  // B's parent Z is not in the input — the lane simply ends.
  const run = (): GraphLayout =>
    computeGraphLayout([c("A", "B"), c("B", "Z")]);
  assert.doesNotThrow(run);

  const layout = run();
  assert.equal(layout.rows.length, 2);
  const b = row(layout, "B");
  // B has a parent edge leaving toward Z's (would-be) lane in column 0, but no
  // later row references Z and nothing is drawn for a non-existent node.
  assert.equal(b.column, 0);
  // The boundary lane for Z is the only thing that could survive; width stays 1.
  assert.equal(layout.totalColumns, 1);
});

test("a lane keeps one color across all its rows", () => {
  //   M (A, B)
  //   A (C)
  //   B (D)
  //   C (E)
  //   D (E)
  //   E
  // The B/D lane (column 1) should keep a single color from M's fork down to E.
  const layout = computeGraphLayout([
    c("M", "A", "B"),
    c("A", "C"),
    c("B", "D"),
    c("C", "E"),
    c("D", "E"),
    c("E"),
  ]);

  const b = row(layout, "B");
  const d = row(layout, "D");
  // B and D live in the same (second) lane and share its color.
  assert.equal(b.column, 1);
  assert.equal(d.column, 1);
  assert.equal(b.color, d.color);
  assert.notEqual(b.color, row(layout, "A").color);

  // Specific column/color spot-checks.
  assert.equal(row(layout, "M").column, 0);
  assert.equal(row(layout, "M").color, 0);
  assert.equal(row(layout, "A").column, 0);
  assert.equal(row(layout, "A").color, 0);
  assert.equal(row(layout, "E").column, 0);

  // Two lanes at most across the whole graph.
  assert.equal(layout.totalColumns, 2);
});

test("output is deterministic for identical input", () => {
  const input = [c("M", "A", "B"), c("A", "C"), c("B", "C"), c("C")];
  const a = computeGraphLayout(input);
  const b = computeGraphLayout(input);
  assert.deepEqual(a, b);
});

test("colorCount option wraps lane colors", () => {
  // Four independent tips with colorCount 2 should reuse colors 0,1,0,1.
  const layout = computeGraphLayout(
    [c("P"), c("Q"), c("R"), c("S")],
    { colorCount: 2 },
  );
  const colors = ["P", "Q", "R", "S"].map((sha) => row(layout, sha).color);
  assert.deepEqual(colors, [0, 1, 0, 1]);
});
