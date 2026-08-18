import { test } from "node:test";
import assert from "node:assert/strict";
import { selectedLineNumbers } from "../src/renderer/selectionLines";

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

test("no selection at all is null, not an empty stage", () => {
  // The caller turns null into "select some lines first". An empty array would
  // instead go on to stage nothing and report success.
  assert.equal(selectedLineNumbers(null), null);
  assert.equal(selectedLineNumbers(undefined), null);
  assert.equal(selectedLineNumbers([]), null);
});
