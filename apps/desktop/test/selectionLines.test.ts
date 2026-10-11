import { test } from "node:test";
import assert from "node:assert/strict";
import { selectedBoundaries, selectedLineNumbers } from "../src/renderer/selectionLines";

// "Stage lines" in the diff read only the PRIMARY Monaco selection, so holding
// alt and clicking four scattered lines staged the first one and silently
// dropped the other three — the worst shape a staging bug takes, because the
// diff repaints and looks like it did what you asked. The extension's editor
// commands always honoured every cursor (editor.selections, plural); the app
// did not. These pin the agreement.

const span = (start: number, end = start) => ({
  startLineNumber: start,
  endLineNumber: end,
});

test("a single caret stages exactly its own line", () => {
  assert.deepEqual(selectedLineNumbers([span(7)]), [7]);
});

test("a dragged range stages every line it covers, inclusive", () => {
  assert.deepEqual(selectedLineNumbers([span(3, 6)]), [3, 4, 5, 6]);
});

test("the reported bug: every cursor counts, not just the first", () => {
  const lines = selectedLineNumbers([span(2), span(40), span(88), span(120)]);
  assert.deepEqual(lines, [2, 40, 88, 120]);
});

test("cursors placed out of order still come back ascending", () => {
  // You alt-click bottom-up; git should not see a descending line list.
  assert.deepEqual(selectedLineNumbers([span(90), span(12), span(50)]), [12, 50, 90]);
});

test("overlapping selections stage each line once", () => {
  // Two ranges sharing lines must not send a duplicate — staging the same line
  // twice is at best wasted work and at worst a doubled edit.
  assert.deepEqual(selectedLineNumbers([span(4, 8), span(6, 10)]), [4, 5, 6, 7, 8, 9, 10]);
});

test("a selection dragged upwards is not silently empty", () => {
  // Monaco normalises, but if it ever hands back a reversed span the loop must
  // not run zero times and report "nothing selected" over a real selection.
  assert.deepEqual(selectedLineNumbers([{ startLineNumber: 9, endLineNumber: 5 }]), [5, 6, 7, 8, 9]);
});

test("a whole line picked by its line number does not take the line below", () => {
  // Clicking line number 201 selects 201:1 → 202:1. Read as lines 201–202, the
  // NEXT change was staged too whenever one started on 202 (#87, the
  // extension's twin of this function).
  assert.deepEqual(selectedLineNumbers([{ startLineNumber: 201, endLineNumber: 202, endColumn: 1 }]), [201]);
  // Dragging down three line numbers.
  assert.deepEqual(selectedLineNumbers([{ startLineNumber: 10, endLineNumber: 13, endColumn: 1 }]), [10, 11, 12]);
  // Ending INSIDE the later line keeps it; a caret at column 1 is its own line.
  assert.deepEqual(selectedLineNumbers([{ startLineNumber: 10, endLineNumber: 12, endColumn: 2 }]), [10, 11, 12]);
  assert.deepEqual(selectedLineNumbers([{ startLineNumber: 7, endLineNumber: 7, endColumn: 1 }]), [7]);
});

test("no selection at all is null, not an empty stage", () => {
  // The caller turns null into "select some lines first". An empty array would
  // instead go on to stage nothing and report success.
  assert.equal(selectedLineNumbers(null), null);
  assert.equal(selectedLineNumbers(undefined), null);
  assert.equal(selectedLineNumbers([]), null);
});

// The edges a selection reaches (#87, round 2). Dropping the line a selection
// stops at column 1 of also dropped the deletion anchored above it — Select
// All left a deletion at the end of the file out of the commit.

test("a selection ending at column 1 of a later line reaches the edge above that line", () => {
  assert.deepEqual(selectedBoundaries([{ startLineNumber: 10, endLineNumber: 13, endColumn: 1 }]), [13]);
  assert.equal(selectedBoundaries([{ startLineNumber: 10, endLineNumber: 12, endColumn: 2 }]), null);
  assert.equal(selectedBoundaries([{ startLineNumber: 7, endLineNumber: 7, startColumn: 1, endColumn: 1 }]), null);
});

test("Select All in a file ending in a line break reaches the empty last row and the edge after it", () => {
  // "a\nb\n": rows 1, 2 and the empty row 3 (max column 1). The row itself is
  // kept (round 3); without the document's end it would be an edge only.
  const end = { lineNumber: 3, column: 1 };
  const all = [{ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }];
  assert.deepEqual(selectedLineNumbers(all, end), [1, 2, 3]);
  assert.deepEqual(selectedBoundaries(all, end), [4]);
  assert.deepEqual(selectedLineNumbers(all), [1, 2]);
  assert.deepEqual(selectedBoundaries(all), [3]);
});

test("Select All in a file without a final line break reaches the edge after its last line; a caret there does not", () => {
  const end = { lineNumber: 2, column: 2 }; // "a\nb"
  assert.deepEqual(selectedBoundaries([{ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 2 }], end), [3]);
  assert.equal(selectedBoundaries([{ startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 2 }], end), null);
});

// The final empty row (#87, round 3): adding a file's final line break, or
// emptying its last line, is a change ON the empty row after the last line
// break. Select All ends at column 1 of that row; a selection that reaches the
// end of the document keeps it.

test("Select All keeps the final empty row, which is where a final line break is added", () => {
  const end = { lineNumber: 3, column: 1 }; // "foo\nbar\n"
  const all = [{ startLineNumber: 1, startColumn: 1, endLineNumber: 3, endColumn: 1 }];
  assert.deepEqual(selectedLineNumbers(all, end), [1, 2, 3]);
  assert.deepEqual(selectedBoundaries(all, end), [4]);
  // Not at the end of the document: the row the selection stopped at stays out.
  assert.deepEqual(selectedLineNumbers([{ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 }], end), [1]);
});
