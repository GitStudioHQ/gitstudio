import { test } from "node:test";
import assert from "node:assert/strict";
import { computeHunks } from "../src/staging/applyLineChanges";
import {
  stageHunks,
  stageSelection,
  toOriginalRanges,
  toOriginalSelection,
  unstageHunks,
  unstageSelection,
} from "../src/staging/selectionStaging";

// Staging and unstaging what an editor selection touches. The selection is
// numbered like the WORKING tree in both directions — it was made in an editor
// showing the working file — so unstaging has to carry it into index numbering
// before matching it against what is staged.

const lf = (arr: string[]): string => arr.join("\n") + "\n";
const line = (n: number) => ({ start: n, end: n });

test("stageSelection stages the change under the selection and leaves the others unstaged", () => {
  const index = lf(["a", "b", "c", "d", "e"]);
  const working = lf(["a", "B", "c", "D", "e"]);
  const r = stageSelection(index, working, [line(3)]);
  assert.deepEqual(r, { content: lf(["a", "b", "c", "D", "e"]), changes: 1 });
});

test("stageSelection: one line of a same-length change stages only that line", () => {
  const index = lf(["a", "b", "c", "d", "e"]);
  const working = lf(["a", "B", "C", "D", "e"]);
  assert.deepEqual(stageSelection(index, working, [line(2)]), { content: lf(["a", "b", "C", "d", "e"]), changes: 1 });
});

test("stageSelection: one line of a change that alters the line count stages the whole change", () => {
  const index = lf(["a", "b", "c", "d", "e"]);
  const working = lf(["a", "B+C+D", "e"]);
  assert.equal(stageSelection(index, working, [line(1)])?.content, working);
});

test("stageSelection: a selection on unchanged lines stages nothing", () => {
  const index = lf(["a", "b", "c"]);
  const working = lf(["a", "B", "c"]);
  assert.equal(stageSelection(index, working, [line(0)]), undefined);
  assert.equal(stageSelection(index, index, [line(1)]), undefined);
});

test("stageSelection: a deletion is staged from the line it sits above", () => {
  const index = lf(["a", "gone", "c"]);
  const working = lf(["a", "c"]);
  assert.equal(stageSelection(index, working, [line(1)])?.content, working);
});

test("stageSelection counts every change it stages", () => {
  const index = lf(["1", "2", "3", "4", "5"]);
  const working = lf(["ONE", "2", "THREE", "4", "FIVE"]);
  const r = stageSelection(index, working, [{ start: 0, end: 4 }]);
  assert.equal(r?.changes, 3);
  assert.equal(r?.content, working);
});

test("toOriginalRanges shifts lines past an insertion back into the original's numbering", () => {
  const original = lf(["a", "b", "c"]);
  const modified = lf(["a", "NEW", "NEW2", "b", "c"]);
  const hunks = computeHunks(original, modified);
  // Modified line 3 ("b") is original line 1; line 4 ("c") is original line 2.
  assert.deepEqual(toOriginalRanges([line(3)], hunks), [line(1)]);
  assert.deepEqual(toOriginalRanges([{ start: 3, end: 4 }], hunks), [{ start: 1, end: 2 }]);
  // The inserted lines have no original line under them.
  assert.deepEqual(toOriginalRanges([{ start: 1, end: 2 }], hunks), []);
});

test("toOriginalRanges maps a line inside a modified block to the block's whole original span", () => {
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["a", "X", "d"]);
  assert.deepEqual(toOriginalRanges([line(1)], computeHunks(original, modified)), [{ start: 1, end: 2 }]);
});

test("toOriginalRanges shifts lines past a deletion forward", () => {
  const original = lf(["a", "gone1", "gone2", "b"]);
  const modified = lf(["a", "b"]);
  assert.deepEqual(toOriginalRanges([line(1)], computeHunks(original, modified)), [line(3)]);
});

test("unstageSelection rolls back the staged change under the selection, keeping the other staged one", () => {
  const head = lf(["a", "b", "c", "d"]);
  const index = lf(["a", "B", "c", "D"]);
  const r = unstageSelection(head, index, index, [line(1)]);
  assert.deepEqual(r, { content: lf(["a", "b", "c", "D"]), changes: 1 });
});

test("unstageSelection matches WORKING lines, not index lines, when an unstaged edit shifts them (git's MM)", () => {
  // Staged: line 5 → "FIVE". Then two unstaged lines were inserted at the top,
  // so the staged change shows on working line 7 — and working line 5 is an
  // untouched "4".
  const head = lf(["1", "2", "3", "4", "5", "6"]);
  const index = lf(["1", "2", "3", "4", "FIVE", "6"]);
  const working = lf(["new-a", "new-b", "1", "2", "3", "4", "FIVE", "6"]);

  // Selecting the staged line where the user SEES it (working line 6, 0-based)
  // unstages it…
  assert.deepEqual(unstageSelection(head, index, working, [line(6)]), { content: head, changes: 1 });
  // …and selecting working line 4 (0-based; it holds "4" in the working tree,
  // the index's line 4 is "FIVE") must NOT. Matched as index numbering, it did.
  assert.equal(unstageSelection(head, index, working, [line(4)]), undefined);
});

test("unstageSelection: a selection on a working-only insertion has nothing staged under it", () => {
  const head = lf(["a", "b"]);
  const index = lf(["a", "B"]);
  const working = lf(["a", "inserted", "B"]);
  assert.equal(unstageSelection(head, index, working, [line(1)]), undefined);
  assert.equal(unstageSelection(head, index, working, [line(2)])?.content, head);
});

test("unstageSelection: nothing staged means nothing to do", () => {
  const text = lf(["a", "b"]);
  assert.equal(unstageSelection(text, text, lf(["a", "B"]), [line(1)]), undefined);
});

test("unstageSelection of an added file's only change leaves empty text (the caller drops the entry)", () => {
  const index = lf(["new file"]);
  assert.deepEqual(unstageSelection("", index, index, [line(0)]), { content: "", changes: 1 });
});

// ── line boundaries (round 2) ────────────────────────────────────────────────
// An editor selection that ends at the very start of a line covers the lines
// above and the BOUNDARY before that line — an empty range. The boundary takes
// a deletion anchored there and nothing on the line itself: Select All in a
// file ending in a line break ends at column 0 of the empty last row, where a
// deletion at the end of the file is anchored.
const boundary = (n: number) => ({ start: n, end: n - 1 });

test("Select All takes a deletion at the end of the file (it sits on the boundary after the last line)", () => {
  const index = lf(["a", "b", "c"]);
  const working = lf(["a", "b"]);
  assert.deepEqual(stageSelection(index, working, [{ start: 0, end: 1 }, boundary(2)]), { content: working, changes: 1 });
  // Without the boundary nothing reaches it — what the column-0 rule alone did.
  assert.equal(stageSelection(index, working, [{ start: 0, end: 1 }]), undefined);
});

test("Select All over an edit AND an end-of-file deletion stages both, not just the edit", () => {
  const index = lf(["a", "b", "c"]);
  const working = lf(["A", "b"]);
  assert.deepEqual(stageSelection(index, working, [{ start: 0, end: 1 }, boundary(2)]), { content: working, changes: 2 });
});

test("a boundary in the middle takes the deletion sitting there, never a change ON the line below it", () => {
  // Line numbers 1–2 dragged: (0,0)→(2,0). 'c' was deleted between 'b' and 'd'.
  assert.equal(
    stageSelection(lf(["a", "b", "c", "d"]), lf(["a", "b", "d"]), [{ start: 0, end: 1 }, boundary(2)])?.content,
    lf(["a", "b", "d"]),
  );
  // 'c' edited on line 2 itself: the boundary before it does not reach it.
  assert.equal(stageSelection(lf(["a", "b", "c"]), lf(["a", "b", "C"]), [{ start: 0, end: 1 }, boundary(2)]), undefined);
});

test("unstaging with Select All restores a staged end-of-file deletion", () => {
  const head = lf(["a", "b", "c"]);
  const index = lf(["a", "b"]);
  assert.deepEqual(unstageSelection(head, index, index, [{ start: 0, end: 1 }, boundary(2)]), { content: head, changes: 1 });
  assert.equal(unstageSelection(head, index, index, [{ start: 0, end: 1 }]), undefined);
});

test("a boundary is carried into index numbering past an unstaged insertion above it", () => {
  // Staged: 'c' deleted. Unstaged: 'x' inserted at the top. Select All of the
  // working file ends at the boundary before working line 3.
  const head = lf(["a", "b", "c"]);
  const index = lf(["a", "b"]);
  const working = lf(["x", "a", "b"]);
  assert.deepEqual(toOriginalSelection([boundary(3)], computeHunks(index, working)), [boundary(2)]);
  assert.deepEqual(unstageSelection(head, index, working, [{ start: 0, end: 2 }, boundary(3)]), { content: head, changes: 1 });
});

test("toOriginalSelection: a boundary under a working-only line maps to the index line below it", () => {
  const index = lf(["a", "b"]);
  const working = lf(["new", "a", "b"]);
  // The boundary before working line 1 ('a'): the line above is 'new', which the
  // index does not have, so it lands just before index line 0.
  assert.deepEqual(toOriginalSelection([boundary(1)], computeHunks(index, working)), [boundary(0)]);
  // Non-empty ranges map as toOriginalRanges does.
  assert.deepEqual(toOriginalSelection([{ start: 1, end: 2 }], computeHunks(index, working)), [{ start: 0, end: 1 }]);
});

// ── option A: no-ops and line-granular unstaging (round 2) ─────────────────

test("a caret on the empty row after a NEW file's last line stages nothing — never an empty file", () => {
  assert.equal(stageSelection("", "a2\n", [line(1)]), undefined);
  assert.deepEqual(stageSelection("", "a2\n", [line(0)]), { content: "a2\n", changes: 1 });
});

test("a caret on the empty last row of an existing file stages nothing", () => {
  assert.equal(stageSelection(lf(["a"]), lf(["a", "b"]), [line(2)]), undefined);
  // The index has no final line break and the working file adds lines after it:
  // the break belongs to the inserted last line, never staged on its own.
  assert.equal(stageSelection("a", lf(["a", "b", "c"]), [line(3)]), undefined);
  assert.equal(stageSelection("a", lf(["a", "b", "c"]), [line(2)])?.content, lf(["a", "c"]));
  assert.equal(stageSelection("a", lf(["a", "b", "c"]), [{ start: 1, end: 2 }])?.content, lf(["a", "b", "c"]));
});

test("stage x, stage y, unstage y: x stays staged (unstaging is per line too)", () => {
  const head = lf(["a", "z"]);
  const working = lf(["a", "x", "y", "z"]);
  const s1 = stageSelection(head, working, [line(1)])!;
  assert.equal(s1.content, lf(["a", "x", "z"]));
  const s2 = stageSelection(s1.content, working, [line(2)])!;
  assert.equal(s2.content, working);
  assert.deepEqual(unstageSelection(head, s2.content, working, [line(2)]), { content: lf(["a", "x", "z"]), changes: 1 });
  assert.deepEqual(unstageSelection(head, s2.content, working, [line(1)]), { content: lf(["a", "y", "z"]), changes: 1 });
});

test("per-line unstaging when unstaged edits shift the lines (git's MM)", () => {
  // Staged: x and y inserted after 'a'. Unstaged on top: two lines at the top,
  // and 'c' edited.
  const head = lf(["a", "b", "c"]);
  const index = lf(["a", "x", "y", "b", "c"]);
  const working = lf(["w1", "w2", "a", "x", "y", "b", "C"]);
  assert.equal(unstageSelection(head, index, working, [line(4)])?.content, lf(["a", "x", "b", "c"]));
  assert.equal(unstageSelection(head, index, working, [line(3)])?.content, lf(["a", "y", "b", "c"]));
  // 'C' is an unstaged edit over an unstaged-from-HEAD line: nothing staged there.
  assert.equal(unstageSelection(head, index, working, [line(6)]), undefined);
});

test("per-line unstaging of a same-length staged edit; a working line inside an unstaged edit maps to its whole index span", () => {
  const head = lf(["a", "b", "c"]);
  const index = lf(["a", "B", "C"]);
  const working = lf(["a", "B!", "C"]);
  assert.equal(unstageSelection(head, index, working, [line(2)])?.content, lf(["a", "B", "c"]));
  assert.equal(unstageSelection(head, index, working, [line(1)])?.content, lf(["a", "b", "C"]));
});

test("unstaging lines of a newly added file removes just those; all of them leaves nothing (the caller drops the entry)", () => {
  const index = lf(["x", "y"]);
  assert.deepEqual(unstageSelection("", index, index, [line(1)]), { content: "x\n", changes: 1 });
  assert.deepEqual(unstageSelection("", index, index, [{ start: 0, end: 1 }]), { content: "", changes: 1 });
  assert.equal(unstageSelection("", index, index, [line(2)]), undefined, "the empty last row unstages nothing");
});

test("a staged change that altered the line count unstages whole; so does a staged deletion", () => {
  const head = lf(["a", "b", "c", "d"]);
  assert.equal(unstageSelection(head, lf(["a", "BC", "d"]), lf(["a", "BC", "d"]), [line(1)])?.content, head);
  const deleted = lf(["a", "b"]);
  assert.equal(unstageSelection(lf(["a", "gone", "b"]), deleted, deleted, [line(1)])?.content, lf(["a", "gone", "b"]));
});

// ── Stage Hunk / Unstage Hunk: whole hunks, whatever a selection does ───────

test("Stage Hunk stages the whole change under the cursor", () => {
  const index = lf(["a", "b", "c", "d", "e"]);
  const working = lf(["a", "B", "C", "D", "e"]);
  assert.deepEqual(stageHunks(index, working, [2]), { content: working, changes: 1 });
  assert.equal(stageHunks(index, working, [0]), undefined);
});

test("Stage Hunk with the cursor on the line a deletion sits above stages the deletion", () => {
  // It never could: the cursor was tested against the change's own lines.
  assert.equal(stageHunks(lf(["a", "gone", "b"]), lf(["a", "b"]), [1])?.content, lf(["a", "b"]));
});

test("Unstage Hunk unstages the whole staged change under the cursor, carried into index numbering", () => {
  const head = lf(["a", "z"]);
  const index = lf(["a", "x", "y", "z"]);
  // Both x and y staged; an unstaged line above shifts the working numbering.
  const working = lf(["top", "a", "x", "y", "z"]);
  assert.deepEqual(unstageHunks(head, index, working, [3]), { content: head, changes: 1 });
  assert.equal(unstageHunks(head, index, working, [0]), undefined);
});
