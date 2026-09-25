import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_SELECTION,
  PLAN_ACTIONS,
  actionForKey,
  actionTooltip,
  arrowRow,
  clickRow,
  collapseSelection,
  dragKeys,
  foldTargetIndex,
  isOrphanFold,
  moveKeysToGap,
  moveSelected,
  pruneSelection,
  reachRow,
  refusalText,
  selectAll,
  selectOnly,
  selectedInOrder,
  setActions,
  type PlanAction,
  type PlanSelection,
} from "../src/rebase/planEdit";

// Editing a rebase plan as a list (issue #32). One set of rules drives three
// surfaces — the extension's workspace, its todo editor and the desktop's
// Rebase view — so these tables are the whole contract: every selection
// state against every gesture, and every fold against both display orders.

const ORDER = ["a", "b", "c", "d", "e"];
const sel = (selected: string[], anchor: string | null, focus: string | null): PlanSelection => ({
  selected,
  anchor,
  focus,
});
const norm = (s: PlanSelection) => ({ selected: [...s.selected].sort(), anchor: s.anchor, focus: s.focus });

test("a click: plain, ⌘/Ctrl, Shift and Shift+⌘ from every starting selection", () => {
  // [name, before, key, mods, expected]
  const cases: Array<[string, PlanSelection, string, { range?: boolean; toggle?: boolean }, PlanSelection]> = [
    ["plain from nothing", NO_SELECTION, "c", {}, sel(["c"], "c", "c")],
    ["plain from one", selectOnly("a"), "c", {}, sel(["c"], "c", "c")],
    ["plain from many collapses", sel(["a", "b", "d"], "a", "d"), "b", {}, sel(["b"], "b", "b")],
    ["toggle adds", selectOnly("a"), "c", { toggle: true }, sel(["a", "c"], "c", "c")],
    ["toggle removes", sel(["a", "c"], "c", "c"), "a", { toggle: true }, sel(["c"], "a", "a")],
    ["toggle the last one off leaves none", selectOnly("a"), "a", { toggle: true }, sel([], "a", "a")],
    ["range down from the anchor", selectOnly("b"), "d", { range: true }, sel(["b", "c", "d"], "b", "d")],
    ["range up from the anchor", selectOnly("d"), "b", { range: true }, sel(["b", "c", "d"], "d", "b")],
    ["range replaces what was toggled", sel(["a", "e"], "b", "b"), "c", { range: true }, sel(["b", "c"], "b", "c")],
    ["range re-aims from the same anchor", sel(["b", "c", "d"], "b", "d"), "a", { range: true }, sel(["a", "b"], "b", "a")],
    ["range with no anchor starts at the row", NO_SELECTION, "c", { range: true }, sel(["c"], "c", "c")],
    ["range+toggle adds a range", sel(["e"], "a", "e"), "b", { range: true, toggle: true }, sel(["a", "b", "e"], "a", "b")],
    ["a key that is not a row changes nothing", selectOnly("a"), "zz", {}, selectOnly("a")],
  ];
  for (const [name, before, key, mods, want] of cases) {
    assert.deepEqual(norm(clickRow(before, ORDER, key, mods)), norm(want), name);
  }
});

test("the arrows, Home and End: the selection follows the keyboard; Shift grows it from the anchor", () => {
  const cases: Array<[string, PlanSelection, -1 | 1, boolean, PlanSelection]> = [
    ["Down from nothing lands on the first row", NO_SELECTION, 1, false, selectOnly("a")],
    ["Up from nothing lands on the last row", NO_SELECTION, -1, false, selectOnly("e")],
    ["Down moves one row", selectOnly("b"), 1, false, selectOnly("c")],
    ["Up moves one row", selectOnly("b"), -1, false, selectOnly("a")],
    ["clamped at the top", selectOnly("a"), -1, false, selectOnly("a")],
    ["clamped at the bottom", selectOnly("e"), 1, false, selectOnly("e")],
    ["a plain arrow collapses a range", sel(["b", "c", "d"], "b", "d"), 1, false, selectOnly("e")],
    ["Shift+Down grows", selectOnly("b"), 1, true, sel(["b", "c"], "b", "c")],
    ["Shift+Up grows the other way", selectOnly("b"), -1, true, sel(["a", "b"], "b", "a")],
    ["Shift+Up shrinks a downward range", sel(["b", "c", "d"], "b", "d"), -1, true, sel(["b", "c"], "b", "c")],
    ["Shift past the anchor flips the range", sel(["b", "c"], "c", "b"), -1, true, sel(["a", "b", "c"], "c", "a")],
    ["Shift at the edge stays", sel(["d", "e"], "d", "e"), 1, true, sel(["d", "e"], "d", "e")],
    ["Shift from nothing starts at the first row", NO_SELECTION, 1, true, selectOnly("a")],
  ];
  for (const [name, before, delta, extend, want] of cases) {
    assert.deepEqual(norm(arrowRow(before, ORDER, delta, extend)), norm(want), name);
  }
  assert.deepEqual(norm(reachRow(selectOnly("c"), ORDER, 0)), norm(selectOnly("a")), "Home");
  assert.deepEqual(norm(reachRow(selectOnly("c"), ORDER, 99)), norm(selectOnly("e")), "End is clamped");
  assert.deepEqual(norm(reachRow(selectOnly("c"), ORDER, 99, true)), norm(sel(["c", "d", "e"], "c", "e")), "Shift+End");
  assert.deepEqual(norm(reachRow(selectOnly("c"), ORDER, 0, true)), norm(sel(["a", "b", "c"], "c", "a")), "Shift+Home");
  assert.deepEqual(arrowRow(selectOnly("a"), [], 1), NO_SELECTION, "an empty list has nothing to reach");
});

test("Escape collapses to the row the keyboard is on, and says when there was nothing to do", () => {
  const many = sel(["b", "c", "d"], "b", "d");
  assert.deepEqual(norm(collapseSelection(many)), norm(selectOnly("d")));
  const one = selectOnly("c");
  assert.equal(collapseSelection(one), one, "one row: the same object — Escape is not this list's");
  assert.equal(collapseSelection(NO_SELECTION), NO_SELECTION, "nothing: the same object");
  // ⌘-clicked the focus OFF, then Escape: back to the row you are on.
  assert.deepEqual(norm(collapseSelection(sel(["a"], "c", "c"))), norm(selectOnly("c")));
});

test("⌘A selects every row and keeps the keyboard where it is; prune forgets rows that left", () => {
  assert.deepEqual(norm(selectAll(selectOnly("c"), ORDER)), norm(sel(ORDER, "a", "c")));
  assert.deepEqual(norm(selectAll(NO_SELECTION, ORDER)), norm(sel(ORDER, "a", "a")));
  const s = sel(["b", "x"], "x", "b");
  assert.deepEqual(norm(pruneSelection(s, ORDER)), norm(sel(["b"], "b", "b")));
  const kept = sel(["b"], "b", "b");
  assert.equal(pruneSelection(kept, ORDER), kept, "nothing to forget: the same object");
  assert.deepEqual(selectedInOrder(sel(["d", "a", "c"], "a", "c"), ORDER), ["a", "c", "d"]);
});

// ── folds ───────────────────────────────────────────────────────────────────

const P = "pick" as PlanAction;

test("a fold rests on the nearest OLDER kept commit — below in a newest-first list, above in git's todo", () => {
  //                 0       1        2       3       4
  const acts: PlanAction[] = ["squash", "fixup", "drop", "pick", "pick"];
  assert.equal(foldTargetIndex(acts, 0, "newest-first"), 3, "chains through a fold and a drop");
  assert.equal(foldTargetIndex(acts, 4, "newest-first"), -1, "the bottom row has nothing older");
  assert.equal(foldTargetIndex(acts, 4, "oldest-first"), 3, "in git's order, older is above");
  assert.equal(foldTargetIndex(acts, 0, "oldest-first"), -1, "and the top row has nothing older");
  assert.equal(foldTargetIndex(["reword", "squash"], 1, "oldest-first"), 0, "reword is kept");
  assert.equal(foldTargetIndex(["edit", "squash"], 1, "oldest-first"), 0, "so is edit");
  assert.equal(foldTargetIndex(["drop", "squash"], 1, "oldest-first"), -1, "a drop is not");
  assert.ok(isOrphanFold(["pick", "squash"], 1, "newest-first"), "a squash at the bottom of a newest-first list");
  assert.ok(!isOrphanFold(["pick", "squash"], 1, "oldest-first"), "is fine at the bottom of git's todo");
  assert.ok(!isOrphanFold(["pick", "drop"], 1, "newest-first"), "only folds can be orphans");
});

test("setting an action on a selection: the state table", () => {
  // [name, order, before, indices, action, after, refused]
  const cases: Array<[string, "newest-first" | "oldest-first", PlanAction[], number[], PlanAction, PlanAction[], number[]]> = [
    ["one row, a plain action", "newest-first", [P, P, P], [1], "drop", [P, "drop", P], []],
    ["many rows, a plain action", "newest-first", [P, P, P, P], [0, 2, 3], "edit", ["edit", P, "edit", "edit"], []],
    ["a drop is never refused, even stranding a fold", "newest-first", ["squash", P], [1], "drop", ["squash", "drop"], []],
    ["squash the newest: folds into the one below", "newest-first", [P, P, P], [0], "squash", ["squash", P, P], []],
    ["squash the oldest alone: refused", "newest-first", [P, P, P], [2], "squash", [P, P, P], [2]],
    [
      "squash all of them: the oldest stays, the rest fold into it",
      "newest-first", [P, P, P, P], [0, 1, 2, 3], "squash", ["squash", "squash", "squash", P], [3],
    ],
    [
      "squash a block with a kept commit below it: nothing refused",
      "newest-first", [P, P, P, P], [0, 1, 2], "fixup", ["fixup", "fixup", "fixup", P], [],
    ],
    [
      "a block over a DROPPED oldest: the lowest selected stays",
      "newest-first", [P, P, "drop"], [0, 1], "squash", ["squash", P, "drop"], [1],
    ],
    [
      "only drops below the selection: every row of it stays as it was",
      "newest-first", [P, "drop", "drop"], [0, 1, 2], "squash", [P, "drop", "drop"], [0, 1, 2],
    ],
    ["git's order: the first row alone is refused", "oldest-first", [P, P, P], [0], "squash", [P, P, P], [0]],
    ["git's order: the last row folds up", "oldest-first", [P, P, P], [2], "fixup", [P, P, "fixup"], []],
    [
      "git's order: select all, fixup: the first stays",
      "oldest-first", [P, P, P], [0, 1, 2], "fixup", [P, "fixup", "fixup"], [0],
    ],
    ["indices out of range are ignored", "newest-first", [P, P], [-1, 5, 0], "drop", ["drop", P], []],
    ["duplicates count once", "newest-first", [P, P], [0, 0], "reword", ["reword", P], []],
  ];
  for (const [name, order, before, indices, action, after, refused] of cases) {
    const r = setActions(before, indices, action, order);
    assert.deepEqual(r.actions, after, `${name}: actions`);
    assert.deepEqual(r.refused, refused, `${name}: refused`);
    assert.deepEqual(
      r.changed,
      after.map((a, i) => (a !== before[i] ? i : -1)).filter((i) => i >= 0),
      `${name}: changed`,
    );
    // Whatever was asked, the result never holds a fold git would refuse
    // that the request created.
    for (const i of indices) {
      if (i < 0 || i >= before.length) continue;
      if (r.actions[i] === action && (action === "squash" || action === "fixup")) {
        assert.ok(foldTargetIndex(r.actions, i, order) >= 0, `${name}: row ${i} has something to fold into`);
      }
    }
  }
});

test("the refusal says what happened, in the list's own direction", () => {
  const one = setActions([P, P], [1], "squash", "newest-first");
  assert.equal(
    refusalText("squash", one, "newest-first"),
    "The oldest commit you keep can't be a squash — there's nothing below it to fold into.",
  );
  const first = setActions([P, P], [0], "fixup", "oldest-first");
  assert.equal(
    refusalText("fixup", first, "oldest-first"),
    "The first commit you keep can't be a fixup — there's nothing above it to fold into.",
  );
  const partial = setActions([P, P, P], [0, 1, 2], "squash", "newest-first");
  assert.equal(
    refusalText("squash", partial, "newest-first", "pick"),
    "Squash set on 2 commits. The oldest one stays Pick — there's nothing below it to fold into.",
  );
  const several = setActions([P, "drop", "drop"], [0, 1, 2], "squash", "newest-first");
  assert.equal(several.changed.length, 0);
  assert.match(refusalText("squash", several, "newest-first"), /None of these can be a squash/);
  assert.equal(refusalText("drop", setActions([P], [0], "drop", "newest-first"), "newest-first"), "", "nothing refused, nothing said");
});

// ── moving ──────────────────────────────────────────────────────────────────

test("Alt+↑/↓ moves the selection as a block; scattered rows each move one; an edge stops it", () => {
  const cases: Array<[string, string[], -1 | 1, string[] | null]> = [
    ["one row up", ["c"], -1, ["a", "c", "b", "d", "e"]],
    ["one row down", ["c"], 1, ["a", "b", "d", "c", "e"]],
    ["a block up", ["c", "d"], -1, ["a", "c", "d", "b", "e"]],
    ["a block down", ["b", "c"], 1, ["a", "d", "b", "c", "e"]],
    ["scattered, up", ["b", "d"], -1, ["b", "a", "d", "c", "e"]],
    ["scattered, down", ["b", "d"], 1, ["a", "c", "b", "e", "d"]],
    ["the top row cannot go up", ["a", "c"], -1, null],
    ["the bottom row cannot go down", ["c", "e"], 1, null],
    ["nothing selected moves nothing", [], 1, null],
    ["keys that are not rows move nothing", ["zz"], -1, null],
  ];
  for (const [name, selected, delta, want] of cases) {
    assert.deepEqual(moveSelected(ORDER, selected, delta), want, name);
  }
});

test("a drag carries the selection when it picks up a selected row, else just that row", () => {
  const s = sel(["d", "b"], "b", "d");
  assert.deepEqual(dragKeys(s, ORDER, "d"), ["b", "d"], "in list order");
  assert.deepEqual(dragKeys(s, ORDER, "a"), ["a"]);
});

test("a drop puts the dragged rows in the gap the line was drawn at", () => {
  // Gap g sits above row g; gap 5 is below the last row.
  const cases: Array<[string, string[], number, string[]]> = [
    ["one row to the top", ["d"], 0, ["d", "a", "b", "c", "e"]],
    ["one row to the bottom", ["b"], 5, ["a", "c", "d", "e", "b"]],
    ["one row into its own gap is no move", ["c"], 2, ORDER],
    ["one row into the gap below itself is no move", ["c"], 3, ORDER],
    ["a block down past one", ["a", "b"], 3, ["c", "a", "b", "d", "e"]],
    ["a block up to the top", ["d", "e"], 0, ["d", "e", "a", "b", "c"]],
    ["scattered rows gather at the gap, in list order", ["a", "e"], 3, ["b", "c", "a", "e", "d"]],
    ["a gap inside the dragged block keeps it where it is", ["b", "c", "d"], 2, ORDER],
    ["a gap past the end is clamped", ["a"], 99, ["b", "c", "d", "e", "a"]],
  ];
  for (const [name, moving, gap, want] of cases) {
    assert.deepEqual(moveKeysToGap(ORDER, moving, gap), want, name);
  }
});

test("git's todo letters are the keys, either case, and nothing else is", () => {
  assert.deepEqual(
    PLAN_ACTIONS.map((a) => a.key).join(""),
    "PRSFED",
    "pick reword squash fixup edit drop",
  );
  for (const a of PLAN_ACTIONS) {
    assert.equal(actionForKey(a.key), a.id);
    assert.equal(actionForKey(a.key.toLowerCase()), a.id);
    assert.match(actionTooltip(a.id), new RegExp(`\\(${a.key}\\)$`), "the tooltip names the key");
    assert.ok(actionTooltip(a.id).startsWith(a.label), "and leads with the word");
  }
  for (const k of ["x", "b", "a", "ArrowUp", "Enter", " ", "", "pp"]) {
    assert.equal(actionForKey(k), undefined, `"${k}" is not an action`);
  }
});
