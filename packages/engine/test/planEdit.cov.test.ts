// The rebase plan's editing rules (src/rebase/planEdit.ts) — the corners
// test/rebasePlanEdit.test.ts leaves: a range whose anchor left the list, the
// keyboard on an empty list, Escape with no focus, ⌘A with a stale focus, a
// prune that loses the anchor, and the refusal's words in their other forms.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_SELECTION,
  actionTooltip,
  arrowRow,
  clickRow,
  collapseSelection,
  pruneSelection,
  reachRow,
  refusalText,
  selectAll,
  selectOnly,
  selectionCountText,
  type PlanAction,
} from "../src/rebase/planEdit";

const ROWS = ["a", "b", "c", "d"];

test("a Shift range whose anchor left the list extends from the focus, else from the row clicked", () => {
  const staleAnchor = { selected: ["b"], anchor: "gone", focus: "b" };
  assert.deepEqual(clickRow(staleAnchor, ROWS, "d", { range: true }), { selected: ["b", "c", "d"], anchor: "b", focus: "d" });
  const bothGone = { selected: [], anchor: "gone", focus: "also-gone" };
  assert.deepEqual(clickRow(bothGone, ROWS, "c", { range: true }), { selected: ["c"], anchor: "c", focus: "c" });
  // Shift+⌘ adds the range to what was selected, in the order it was chosen.
  assert.deepEqual(clickRow({ selected: ["d"], anchor: "a", focus: "a" }, ROWS, "b", { range: true, toggle: true }), { selected: ["d", "a", "b"], anchor: "a", focus: "b" });
  // A key that isn't a row changes nothing — the same object comes back.
  const sel = selectOnly("a");
  assert.equal(clickRow(sel, ROWS, "zzz"), sel);
});

test("the keyboard on an empty list selects nothing", () => {
  assert.equal(reachRow(selectOnly("a"), [], 3), NO_SELECTION);
  assert.equal(arrowRow(selectOnly("a"), [], 1), NO_SELECTION);
  assert.equal(selectAll(selectOnly("a"), []), NO_SELECTION);
});

test("Shift+arrow with a stale anchor grows from the focus", () => {
  const sel = { selected: ["b"], anchor: "gone", focus: "b" };
  assert.deepEqual(arrowRow(sel, ROWS, 1, true), { selected: ["b", "c"], anchor: "b", focus: "c" });
  // From no focus at all, Shift+Up lands on the last row and anchors there.
  assert.deepEqual(arrowRow(NO_SELECTION, ROWS, -1, true), { selected: ["d"], anchor: "d", focus: "d" });
  // Reaching past either end is clamped.
  assert.deepEqual(reachRow(NO_SELECTION, ROWS, 99), selectOnly("d"));
  assert.deepEqual(reachRow(NO_SELECTION, ROWS, -5), selectOnly("a"));
});

test("Escape with no focus clears a selection, and returns an empty one unchanged", () => {
  assert.equal(collapseSelection({ selected: ["a", "b"], anchor: "a", focus: null }), NO_SELECTION);
  const empty = { selected: [], anchor: null, focus: null };
  assert.equal(collapseSelection(empty), empty, "nothing to collapse: Escape is someone else's");
  assert.deepEqual(collapseSelection({ selected: ["a", "c"], anchor: "a", focus: "c" }), selectOnly("c"));
});

test("⌘A with a focus that left the list puts the keyboard on the first row", () => {
  assert.deepEqual(selectAll({ selected: [], anchor: null, focus: "gone" }, ROWS), { selected: ROWS, anchor: "a", focus: "a" });
  assert.deepEqual(selectAll({ selected: [], anchor: null, focus: null }, ROWS).focus, "a");
});

test("prune: a lost anchor falls back to the focus; a lost focus leaves none", () => {
  assert.deepEqual(pruneSelection({ selected: ["a", "x"], anchor: "x", focus: "a" }, ROWS), { selected: ["a"], anchor: "a", focus: "a" });
  assert.deepEqual(pruneSelection({ selected: ["x"], anchor: "a", focus: "x" }, ROWS), { selected: [], anchor: "a", focus: null });
  assert.deepEqual(pruneSelection({ selected: ["x"], anchor: "y", focus: "x" }, ROWS), { selected: [], anchor: null, focus: null });
});

test("the refusal's other words: an article before a vowel, one commit set, and a row left as it was", () => {
  assert.equal(
    refusalText("edit", { changed: [], refused: [0] }, "oldest-first"),
    "The first commit you keep can't be an edit — there's nothing above it to fold into.",
  );
  assert.equal(
    refusalText("fixup", { changed: [0], refused: [1] }, "newest-first"),
    "Fixup set on 1 commit. The oldest one stays as it was — there's nothing below it to fold into.",
  );
  assert.equal(
    refusalText("squash", { changed: [0, 1], refused: [2, 3] }, "oldest-first", "pick"),
    "Squash set on 2 commits. The 2 first stay as they were — nothing above them is kept to fold into.",
  );
  assert.equal(
    refusalText("frobnicate" as PlanAction, { changed: [], refused: [0, 1] }, "newest-first"),
    "None of these can be a frobnicate — nothing below them is kept to fold into.",
    "an action the toolbar doesn't know is named as given",
  );
});

test("the toolbar says each action with its key, and nothing for one it doesn't know", () => {
  assert.equal(actionTooltip("squash"), "Squash: fold each into the commit before it, keeping both messages (S)");
  assert.equal(actionTooltip("nope" as PlanAction), "");
});

test("the selection count, and what a screen reader hears for none", () => {
  assert.equal(selectionCountText(0), "None selected");
  assert.equal(selectionCountText(1), "1 selected");
  assert.equal(selectionCountText(12), "12 selected");
});
