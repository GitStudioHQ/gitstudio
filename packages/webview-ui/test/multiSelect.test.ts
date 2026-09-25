import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_SELECTION,
  clickSelect,
  collapse,
  contextSelect,
  inOrder,
  isMany,
  moveTo,
  only,
  rangeBetween,
  reconcile,
  sameRows,
  type Selection,
} from "../src/graph/multiSelect";

// The selection state machine behind the graph's and the Commits list's
// multi-select (issue #32), as a table: every gesture from every kind of
// starting state, and what is selected, anchored and focused after it.

const ORDER = ["w", "a", "b", "c", "d", "e"]; // newest first; "w" is the uncommitted-changes row
const canJoin = (sha: string) => sha !== "w";

/** "b c d | a>b": selected rows in list order, then anchor>focus. */
const show = (s: Selection): string =>
  `${inOrder(s, ORDER).join(" ") || "-"} | ${s.anchor ?? "?"}>${s.focus ?? "?"}`;

const sel = (rows: string[], anchor?: string, focus?: string): Selection => ({ selected: new Set(rows), anchor, focus });

const START = {
  none: NO_SELECTION,
  one: only("b"),
  range: sel(["b", "c", "d"], "b", "d"),
  gappy: sel(["a", "c", "e"], "c", "e"),
  wip: only("w"),
  cursorOff: sel(["a", "c"], "b", "b"), // Cmd-clicked b off: the cursor on an unselected row
};

type Gesture = [string, (s: Selection) => Selection];
const click = (sha: string, mods = {}): Gesture[1] => (s) => clickSelect(s, ORDER, sha, mods, canJoin);

const GESTURES: Record<string, Gesture[1]> = {
  "click c": click("c"),
  "cmd+click c": click("c", { metaKey: true }),
  "ctrl+click c": click("c", { ctrlKey: true }),
  "shift+click e": click("e", { shiftKey: true }),
  "shift+click a": click("a", { shiftKey: true }),
  "cmd+shift+click e": click("e", { metaKey: true, shiftKey: true }),
  "cmd+click w": click("w", { metaKey: true }),
  "shift+click w": click("w", { shiftKey: true }),
  "↓ to e": (s) => moveTo(s, ORDER, "e", false, canJoin),
  "shift+↓ to e": (s) => moveTo(s, ORDER, "e", true, canJoin),
  "shift+↑ to w": (s) => moveTo(s, ORDER, "w", true, canJoin),
  "right-click c": (s) => contextSelect(s, "c"),
  "right-click a": (s) => contextSelect(s, "a"),
  escape: (s) => collapse(s),
};

// [start, gesture, expected]
const TABLE: Array<[keyof typeof START, keyof typeof GESTURES, string]> = [
  // A plain click always leaves exactly one row, anchored and focused there.
  ["none", "click c", "c | c>c"],
  ["range", "click c", "c | c>c"],
  ["gappy", "click c", "c | c>c"],
  ["wip", "click c", "c | c>c"],
  // Cmd/Ctrl toggles, and moves the anchor to the toggled row.
  ["none", "cmd+click c", "c | c>c"],
  ["one", "cmd+click c", "b c | c>c"],
  ["one", "ctrl+click c", "b c | c>c"],
  ["range", "cmd+click c", "b d | c>c"],
  ["gappy", "cmd+click c", "a e | c>c"],
  ["wip", "cmd+click c", "c | c>c"], // the uncommitted row cannot share it
  ["range", "cmd+click w", "w | w>w"], // …and a Cmd-click on it selects it alone
  // Shift selects from the anchor, replacing what was there.
  ["one", "shift+click e", "b c d e | b>e"],
  ["one", "shift+click a", "a b | b>a"],
  ["range", "shift+click e", "b c d e | b>e"],
  ["range", "shift+click a", "a b | b>a"],
  ["gappy", "shift+click e", "c d e | c>e"],
  ["none", "shift+click e", "e | e>e"], // no anchor: a plain click
  ["one", "shift+click w", "a b | b>w"], // the uncommitted row is left out of a range
  // Cmd+Shift adds the range to what is selected.
  ["gappy", "cmd+shift+click e", "a c d e | c>e"],
  // The keyboard.
  ["range", "↓ to e", "e | e>e"],
  ["one", "shift+↓ to e", "b c d e | b>e"],
  ["range", "shift+↓ to e", "b c d e | b>e"],
  ["gappy", "shift+↓ to e", "c d e | c>e"],
  ["none", "shift+↓ to e", "e | e>e"],
  ["one", "shift+↑ to w", "a b | b>w"],
  // Right-click: inside a selection of several keeps it; elsewhere it is just that row.
  ["range", "right-click c", "b c d | b>c"],
  ["gappy", "right-click c", "a c e | c>c"],
  ["range", "right-click a", "a | a>a"],
  ["one", "right-click c", "c | c>c"],
  ["one", "right-click a", "a | a>a"],
  // Escape keeps only the focused row, and does nothing to one or none.
  ["range", "escape", "d | d>d"],
  ["gappy", "escape", "e | e>e"],
  ["cursorOff", "escape", "b | b>b"],
  ["one", "escape", "b | b>b"],
  ["none", "escape", "- | ?>?"],
];

for (const [start, gesture, want] of TABLE) {
  test(`${start} → ${gesture} → ${want}`, () => {
    assert.equal(show(GESTURES[gesture](START[start])), want);
  });
}

test("a Shift-range from an anchor that is no longer listed is a plain click", () => {
  assert.equal(show(clickSelect(sel(["gone"], "gone", "gone"), ORDER, "c", { shiftKey: true }, canJoin)), "c | c>c");
});

test("rangeBetween is inclusive either way round, and empty for a row not listed", () => {
  assert.deepEqual(rangeBetween(ORDER, "b", "d"), ["b", "c", "d"]);
  assert.deepEqual(rangeBetween(ORDER, "d", "b"), ["b", "c", "d"]);
  assert.deepEqual(rangeBetween(ORDER, "b", "b"), ["b"]);
  assert.deepEqual(rangeBetween(ORDER, "b", "x"), []);
});

test("isMany and inOrder read the selection in list order, whatever order it was made in", () => {
  const s = sel(["e", "a", "c"], "e", "c");
  assert.equal(isMany(s), true);
  assert.equal(isMany(only("a")), false);
  assert.deepEqual(inOrder(s, ORDER), ["a", "c", "e"]);
});

test("reconcile forgets rows that are gone, and moves a lost cursor and anchor onto what is left", () => {
  const s = sel(["b", "c", "d"], "b", "d");
  assert.equal(reconcile(s, ORDER), s, "unchanged rows: the same object, nothing to repaint");
  const after = reconcile(s, ["a", "c", "e"]);
  assert.equal(show(after), "c | c>c");
  assert.equal(show(reconcile(s, ["x", "y"])), "- | ?>?");
});

test("sameRows compares the rows, not the cursor", () => {
  assert.equal(sameRows(sel(["a", "b"], "a", "a"), sel(["b", "a"], "b", "b")), true);
  assert.equal(sameRows(sel(["a"]), sel(["a", "b"])), false);
});
