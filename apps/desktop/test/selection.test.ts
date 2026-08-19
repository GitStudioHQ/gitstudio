import { test } from "node:test";
import assert from "node:assert/strict";
import {
  rowKey, parseRowKey, selectionEntries, selectionPaths,
  rangeBetween, clickIntent, reconcile,
} from "../src/renderer/selection";

// Multi-select in the Changes list. The case worth the most attention is the
// one that only exists in the split staging model: a partly staged file is TWO
// rows for ONE path, and they do not mean the same thing.

const ORDER = [
  rowKey("staged", "src/a.ts"),
  rowKey("unstaged", "src/a.ts"),   // same file, partly staged — two rows
  rowKey("unstaged", "src/b.ts"),
  rowKey("unstaged", "README.md"),
];

test("a key round-trips, even when the path contains a colon", () => {
  const k = rowKey("unstaged", "weird:name.ts");
  assert.deepEqual(parseRowKey(k), { kind: "unstaged", path: "weird:name.ts" });
});

test("selecting one row of a partly staged file does not select the other", () => {
  const selected = new Set([rowKey("unstaged", "src/a.ts")]);
  assert.deepEqual(selectionEntries(ORDER, selected), [
    { kind: "unstaged", path: "src/a.ts" },
  ]);
});

test("both rows of one file collapse to a single path for git", () => {
  // Passing the same path twice to `git stash push` is at best noise.
  const selected = new Set([rowKey("staged", "src/a.ts"), rowKey("unstaged", "src/a.ts")]);
  assert.deepEqual(selectionPaths(ORDER, selected), ["src/a.ts"]);
});

test("entries come back in screen order, not selection order", () => {
  const selected = new Set([ORDER[3], ORDER[0]]);
  assert.deepEqual(selectionPaths(ORDER, selected), ["src/a.ts", "README.md"]);
});

test("a range covers both endpoints, in either direction", () => {
  assert.deepEqual(rangeBetween(ORDER, ORDER[1], ORDER[3]), ORDER.slice(1, 4));
  assert.deepEqual(rangeBetween(ORDER, ORDER[3], ORDER[1]), ORDER.slice(1, 4));
});

test("a range from a row to itself is that one row", () => {
  assert.deepEqual(rangeBetween(ORDER, ORDER[2], ORDER[2]), [ORDER[2]]);
});

test("a range anchored on a row that has vanished selects nothing", () => {
  // Better than throwing, and better than silently selecting from index 0.
  assert.deepEqual(rangeBetween(ORDER, "unstaged:gone.ts", ORDER[2]), []);
});

test("modifiers map to intents, and shift without an anchor is a plain click", () => {
  const mods = (o: Partial<{ shiftKey: boolean; ctrlKey: boolean; metaKey: boolean }>) =>
    ({ shiftKey: false, ctrlKey: false, metaKey: false, ...o });

  assert.equal(clickIntent(mods({}), true), "replace");
  assert.equal(clickIntent(mods({ ctrlKey: true }), true), "toggle");
  assert.equal(clickIntent(mods({ metaKey: true }), true), "toggle");
  assert.equal(clickIntent(mods({ shiftKey: true }), true), "range");
  assert.equal(clickIntent(mods({ shiftKey: true }), false), "replace",
    "nothing to extend from, so it behaves like an ordinary click");
});

test("reconcile drops rows that no longer exist and keeps the rest", () => {
  const selected = new Set([ORDER[1], "unstaged:deleted.ts", ORDER[3]]);
  assert.deepEqual([...reconcile(ORDER, selected)], [ORDER[1], ORDER[3]]);
});

test("reconcile of an empty order clears everything", () => {
  assert.equal(reconcile([], new Set([ORDER[0]])).size, 0);
});
