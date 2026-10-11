import { test } from "node:test";
import assert from "node:assert/strict";
import { lineMenuTarget, selectionLines } from "../src/changes/lineTargets";
import { stageSelection, unstageSelection } from "@gitstudio/engine/staging/selectionStaging";

// Which lines a staging command takes from a selection, and which document a
// line-number menu command acts on (#87). Both decide what gets written to the
// index, and nothing on screen says when either is wrong.

const sel = (sl: number, sc: number, el: number, ec: number) => ({
  start: { line: sl, character: sc },
  end: { line: el, character: ec },
});

test("a selection inside one line is that line", () => {
  assert.deepEqual(selectionLines([sel(200, 0, 200, 15)]), [{ start: 200, end: 200 }]);
});

test("a cursor is its own line", () => {
  assert.deepEqual(selectionLines([sel(7, 4, 7, 4)]), [{ start: 7, end: 7 }]);
});

test("a whole line picked by its line number does not take the line below — only the boundary before it", () => {
  // Clicking line number 201 selects (200, 0) → (201, 0).
  assert.deepEqual(selectionLines([sel(200, 0, 201, 0)]), [{ start: 200, end: 200 }, { start: 201, end: 200 }]);
  // Dragging down three line numbers.
  assert.deepEqual(selectionLines([sel(10, 0, 13, 0)]), [{ start: 10, end: 12 }, { start: 13, end: 12 }]);
});

test("a selection ending inside a later line keeps that line", () => {
  assert.deepEqual(selectionLines([sel(10, 3, 12, 1)]), [{ start: 10, end: 12 }]);
});

test("every cursor of a multi-cursor selection counts", () => {
  assert.deepEqual(selectionLines([sel(1, 0, 1, 2), sel(5, 0, 6, 0), sel(9, 9, 9, 9)]), [
    { start: 1, end: 1 },
    { start: 5, end: 5 },
    { start: 6, end: 5 },
    { start: 9, end: 9 },
  ]);
});

test("the line-number menu's own document and 1-based line win over the active editor", () => {
  // Right-clicking a gutter does not focus its editor: the active one can be the
  // diff's other side, or another file in another group.
  assert.deepEqual(
    lineMenuTarget({ lineNumber: 131, uri: "file:///repo/sample.txt" }, { uri: "gitstudio-rev:/sample.txt", line: 4 }),
    { uri: "file:///repo/sample.txt", line: 130 },
  );
});

test("a keybinding (no argument) means the active editor's cursor", () => {
  assert.deepEqual(lineMenuTarget(undefined, { uri: "file:///a.txt", line: 12 }), { uri: "file:///a.txt", line: 12 });
});

test("a menu argument without a document falls back to the active one, keeping its line", () => {
  assert.deepEqual(lineMenuTarget({ lineNumber: 3 }, { uri: "file:///a.txt", line: 40 }), { uri: "file:///a.txt", line: 2 });
});

test("nothing to act on is nothing, not a crash", () => {
  assert.equal(lineMenuTarget(undefined, undefined), undefined);
  assert.equal(lineMenuTarget({ lineNumber: 0, uri: "file:///a.txt" }, undefined), undefined);
});

// ── deletions (round 2) ──────────────────────────────────────────────────────
// A deletion has no line of its own in the working file: it sits on the edge
// above the line after it. These go from the editor's selection all the way
// to what is staged, because the column-0 rule alone dropped them.

/** Select All in a document, as VS Code reports it, and the document's end. */
function selectAll(text: string) {
  const lines = text.split("\n");
  const last = lines.length - 1;
  const end = { line: last, character: lines[last].length };
  return selectionLines([{ start: { line: 0, character: 0 }, end }], end);
}

test("Select All stages a deletion at the end of the file", () => {
  // "a\nb\n" has rows 0, 1 and the empty row 2; Select All ends at (2, 0).
  const index = "a\nb\nc\n";
  const working = "a\nb\n";
  assert.equal(stageSelection(index, working, selectAll(working))?.content, working);
});

test("Select All over an edit and an end-of-file deletion stages both", () => {
  const index = "a\nb\nc\n";
  const working = "A\nb\n";
  assert.deepEqual(stageSelection(index, working, selectAll(working)), { content: working, changes: 2 });
});

test("Select All unstages a staged end-of-file deletion", () => {
  const head = "a\nb\nc\n";
  const index = "a\nb\n";
  assert.equal(unstageSelection(head, index, index, selectAll(index))?.content, head);
});

test("Select All in a file without a final line break reaches the deletion after its last line", () => {
  const index = "a\nb\nc";
  const working = "a\nb";
  assert.equal(stageSelection(index, working, selectAll(working))?.content, working);
  // A caret at the end of the document is still just its line.
  const end = { line: 1, character: 1 };
  assert.equal(stageSelection(index, working, selectionLines([{ start: end, end }], end)), undefined);
});

test("dragging line numbers down to a deletion in the middle takes the deletion, not the next line's edit", () => {
  // 'c' was deleted between 'b' and 'd'; rows a, b dragged: (0,0) → (2,0).
  const drag = selectionLines([sel(0, 0, 2, 0)]);
  assert.equal(stageSelection("a\nb\nc\nd\n", "a\nb\nd\n", drag)?.content, "a\nb\nd\n");
  // An edit ON the row the drag stopped at is not taken.
  assert.equal(stageSelection("a\nb\nc\n", "a\nb\nC\n", drag), undefined);
});

// ── the final empty row (round 3) ────────────────────────────────────────────
// Adding a file's final line break — or emptying its last line — is a change
// ON the empty row after the last line break. Select All ends at column 0 of
// that row, and the column-0 rule dropped it: "nothing to stage", or the edit
// staged without its line break. A selection that reaches the end of the
// document keeps that row.

for (const [index, working, what] of [
  ["foo\nbar", "foo\nbar\n", "adding the final line break"],
  ["foo\nbar", "FOO\nbar\n", "an edit and the final line break"],
  ["foo\nbar", "foo\n", "emptying the last line"],
] as const) {
  test(`Select All stages ${what}, and unstages it again`, () => {
    assert.equal(stageSelection(index, working, selectAll(working))?.content, working);
    assert.equal(unstageSelection(index, working, working, selectAll(working))?.content, index);
  });
}

test("the last line picked by its line number takes its line break, which sits on the final row", () => {
  // "foo\nbar\n": clicking row 1's number selects (1,0) → (2,0), the document's end.
  const end = { line: 2, character: 0 };
  const click = selectionLines([sel(1, 0, 2, 0)], end);
  assert.deepEqual(click, [{ start: 1, end: 2 }, { start: 3, end: 2 }]);
  assert.equal(stageSelection("foo\nbar", "foo\nbar\n", click)?.content, "foo\nbar\n");
  // A line number in the middle still stops short of the next row.
  assert.deepEqual(selectionLines([sel(0, 0, 1, 0)], end), [{ start: 0, end: 0 }, { start: 1, end: 0 }]);
});
