import { test } from "node:test";
import assert from "node:assert/strict";
import { applySelectedLines, revertSelectedLines, takeSelectedLines } from "../src/staging/applySelectedLines";
import { applySelectedChanges, computeHunks, type LineRange } from "../src/staging/applyLineChanges";

// Sub-block line staging (#87): only the selected lines of a change, wherever
// that is well defined — a pure insertion, or a modification with as many lines
// on each side (VS Code's intersectDiffWithRange rule). Everything else stays
// whole, exactly as applySelectedChanges stages it.

const lf = (arr: string[]): string => arr.join("\n") + "\n";
const line = (n: number): LineRange => ({ start: n, end: n });
const lines = (start: number, end: number): LineRange => ({ start, end });

// ── same-length modifications ────────────────────────────────────────────────

test("one line of a three-line modification stages only that line", () => {
  const original = lf(["a", "b", "c", "d", "e"]);
  const modified = lf(["a", "B", "C", "D", "e"]);
  assert.equal(applySelectedLines(original, modified, [line(2)]), lf(["a", "b", "C", "d", "e"]));
  // The block rule, for contrast: all three.
  assert.equal(applySelectedChanges(original, modified, [line(2)]), modified);
});

test("the first and last lines of a modified block, each alone", () => {
  const original = lf(["a", "b", "c", "d", "e"]);
  const modified = lf(["a", "B", "C", "D", "e"]);
  assert.equal(applySelectedLines(original, modified, [line(1)]), lf(["a", "B", "c", "d", "e"]));
  assert.equal(applySelectedLines(original, modified, [line(3)]), lf(["a", "b", "c", "D", "e"]));
});

test("a selection covering the whole block stages the whole block", () => {
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["a", "B", "C", "d"]);
  assert.equal(applySelectedLines(original, modified, [lines(0, 3)]), modified);
});

test("a selection reaching past the block takes only the block's lines it covers", () => {
  const original = lf(["a", "b", "c", "d", "e"]);
  const modified = lf(["a", "B", "C", "D", "e"]);
  // Lines 3–4: the block's last line, and an unchanged line after it.
  assert.equal(applySelectedLines(original, modified, [lines(3, 4)]), lf(["a", "b", "c", "D", "e"]));
});

test("several selections in ONE block all count (VS Code keeps only the first)", () => {
  const original = lf(["a", "b", "c", "d", "e"]);
  const modified = lf(["a", "B", "C", "D", "e"]);
  assert.equal(applySelectedLines(original, modified, [line(1), line(3)]), lf(["a", "B", "c", "D", "e"]));
});

test("the first and the last line of the file", () => {
  const original = lf(["a", "b", "c"]);
  const modified = lf(["A", "b", "C"]);
  // Two separate one-line blocks; each is staged alone.
  assert.equal(applySelectedLines(original, modified, [line(0)]), lf(["A", "b", "c"]));
  assert.equal(applySelectedLines(original, modified, [line(2)]), lf(["a", "b", "C"]));

  const o2 = lf(["a", "b"]);
  const m2 = lf(["A", "B"]);
  assert.equal(applySelectedLines(o2, m2, [line(0)]), lf(["A", "b"]));
  assert.equal(applySelectedLines(o2, m2, [line(1)]), lf(["a", "B"]));
});

// ── insertions ───────────────────────────────────────────────────────────────

test("one line of a multi-line insertion inserts only that line", () => {
  const original = lf(["a", "b"]);
  const modified = lf(["a", "x", "y", "z", "b"]);
  assert.equal(applySelectedLines(original, modified, [line(2)]), lf(["a", "y", "b"]));
  assert.equal(applySelectedLines(original, modified, [lines(1, 2)]), lf(["a", "x", "y", "b"]));
});

test("non-adjacent inserted lines keep their order", () => {
  const original = lf(["a", "b"]);
  const modified = lf(["a", "x", "y", "z", "b"]);
  assert.equal(applySelectedLines(original, modified, [line(3), line(1)]), lf(["a", "x", "z", "b"]));
});

test("an insertion at the top of the file", () => {
  const original = lf(["b"]);
  const modified = lf(["x", "y", "b"]);
  assert.equal(applySelectedLines(original, modified, [line(1)]), lf(["y", "b"]));
});

test("an insertion at the end of the file", () => {
  const original = lf(["a"]);
  const modified = lf(["a", "x", "y"]);
  assert.equal(applySelectedLines(original, modified, [line(2)]), lf(["a", "y"]));
});

test("a new file: only the selected lines of it, each with its line break", () => {
  // The line diff sees "" as one empty line MODIFIED into four — which would
  // stay whole — so an empty original is read as the insertion it is.
  const modified = lf(["one", "two", "three"]);
  assert.equal(applySelectedLines("", modified, [line(1)]), "two\n");
  assert.equal(applySelectedLines("", modified, [line(0), line(2)]), "one\nthree\n");
  assert.equal(applySelectedLines("", modified, [lines(0, 2)]), modified);
  assert.equal(applySelectedLines("", modified, [lines(0, 3)]), modified);
  // The last line has a break only if the file ends with one.
  assert.equal(applySelectedLines("", "one\ntwo", [line(1)]), "two");
  assert.equal(applySelectedLines("", "one\r\ntwo\r\n", [line(0)]), "one\r\n");
  assert.equal(applySelectedLines("", modified, [line(9)]), "");
});

// ── stays whole ──────────────────────────────────────────────────────────────

test("a modification that changes the line count stays whole", () => {
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["a", "MERGED", "d"]);
  assert.equal(applySelectedLines(original, modified, [line(1)]), modified);
  const grown = lf(["a", "B1", "B2", "B3", "c", "d"].filter((x) => x !== "c"));
  assert.equal(applySelectedLines(original, grown, [line(2)]), grown);
});

test("a pure deletion stays whole, picked from the line it sits above", () => {
  const original = lf(["a", "gone1", "gone2", "b"]);
  const modified = lf(["a", "b"]);
  assert.equal(applySelectedLines(original, modified, [line(1)]), modified);
});

test("a selection on unchanged lines changes nothing", () => {
  const original = lf(["a", "b", "c"]);
  const modified = lf(["a", "B", "c"]);
  assert.equal(applySelectedLines(original, modified, [line(0)]), original);
  assert.equal(applySelectedLines(original, modified, []), original);
});

// ── several blocks, line endings ─────────────────────────────────────────────

test("each block takes its own rule in one pass", () => {
  const original = lf(["1", "2", "3", "4", "5", "6", "7", "8"]);
  // block A: 2–3 modified (same length); block B: insertion after 5; block C: 7–8 → one line.
  const modified = lf(["1", "TWO", "THREE", "4", "5", "new1", "new2", "6", "SEVEN+EIGHT"]);
  const staged = applySelectedLines(original, modified, [line(2), line(6), line(8)]);
  assert.equal(staged, lf(["1", "2", "THREE", "4", "5", "new2", "6", "SEVEN+EIGHT"]));
  // Staging it really moved exactly those changes: what is left to stage are
  // the other line of block A and the other inserted line.
  const left = computeHunks(staged, modified).map((h) => h.modified);
  assert.deepEqual(left, [line(1), line(5)]);
});

test("CRLF stays CRLF, line by line", () => {
  const original = "a\r\nb\r\nc\r\nd\r\n";
  const modified = "a\r\nB\r\nC\r\nd\r\n";
  assert.equal(applySelectedLines(original, modified, [line(2)]), "a\r\nb\r\nC\r\nd\r\n");
  const inserted = "a\r\nx\r\ny\r\nb\r\nc\r\nd\r\n";
  assert.equal(applySelectedLines(original, inserted, [line(2)]), "a\r\ny\r\nb\r\nc\r\nd\r\n");
});

test("no trailing newline is kept as it is", () => {
  const original = "a\nb\nc";
  const modified = "a\nB\nC";
  assert.equal(applySelectedLines(original, modified, [line(2)]), "a\nb\nC");
  assert.equal(applySelectedLines(original, modified, [line(1)]), "a\nB\nc");
});

test("selecting every line of every change is the modified text, as with blocks", () => {
  const original = lf(["a", "b", "c", "d", "e", "f"]);
  const modified = lf(["A", "b", "x", "y", "c", "E", "f"].filter((l) => l !== "d"));
  const all = [lines(0, modified.split("\n").length - 1)];
  assert.equal(applySelectedLines(original, modified, all), modified);
  assert.equal(applySelectedLines(original, modified, all), applySelectedChanges(original, modified, all));
});

// ── round 2: change counts, the final line break, boundaries, reverting ─────

test("takeSelectedLines counts only the changes it altered", () => {
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["A", "b", "x", "c", "D"]);
  assert.deepEqual(takeSelectedLines(original, modified, [line(0), line(4)]), {
    content: lf(["A", "b", "c", "D"]),
    changes: 2,
  });
  assert.deepEqual(takeSelectedLines(original, modified, [line(1)]), { content: original, changes: 0 });
});

test("the final line break goes with the inserted last line, never on its own", () => {
  // "a" has no final break; the working text adds b and c, and the break.
  assert.deepEqual(takeSelectedLines("a", lf(["a", "b", "c"]), [line(3)]), { content: "a", changes: 0 });
  assert.equal(takeSelectedLines("a", lf(["a", "b", "c"]), [line(2)]).content, lf(["a", "c"]));
  // Only the break was added: the empty last row is the only way to select it.
  assert.deepEqual(takeSelectedLines("a", "a\n", [line(1)]), { content: "a\n", changes: 1 });
});

test("a boundary takes the deletion anchored on it, and selects no line", () => {
  const original = lf(["a", "b", "c"]);
  const boundary = { start: 2, end: 1 };
  assert.equal(applySelectedLines(original, lf(["a", "b"]), [boundary]), lf(["a", "b"]));
  assert.deepEqual(takeSelectedLines(original, lf(["a", "b", "C"]), [boundary]), { content: original, changes: 0 });
  assert.deepEqual(takeSelectedLines(original, lf(["a", "x", "b", "c"]), [{ start: 1, end: 0 }]), { content: original, changes: 0 });
});

test("revertSelectedLines removes selected inserted lines and keeps the rest", () => {
  const original = lf(["a", "z"]);
  const modified = lf(["a", "x", "y", "z"]);
  assert.deepEqual(revertSelectedLines(original, modified, [line(2)]), { content: lf(["a", "x", "z"]), changes: 1 });
  assert.deepEqual(revertSelectedLines(original, modified, [line(1), line(2)]), { content: original, changes: 1 });
  assert.deepEqual(revertSelectedLines(original, modified, [line(0)]), { content: modified, changes: 0 });
});

test("revertSelectedLines restores selected lines of a same-length edit, whole otherwise", () => {
  const original = lf(["a", "b", "c", "d"]);
  assert.equal(revertSelectedLines(original, lf(["a", "B", "C", "d"]), [line(2)]).content, lf(["a", "B", "c", "d"]));
  assert.equal(revertSelectedLines(original, lf(["a", "BC", "d"]), [line(1)]).content, original);
  // A deletion: picked from the line it sits above, or from a boundary on it.
  assert.equal(revertSelectedLines(original, lf(["a", "d"]), [line(1)]).content, original);
  assert.equal(revertSelectedLines(original, lf(["a", "d"]), [{ start: 1, end: 0 }]).content, original);
});

test("revertSelectedLines on a new file: each line leaves with its own break", () => {
  const modified = lf(["one", "two", "three"]);
  assert.deepEqual(revertSelectedLines("", modified, [line(1)]), { content: lf(["one", "three"]), changes: 1 });
  assert.deepEqual(revertSelectedLines("", modified, [{ start: 0, end: 2 }]), { content: "", changes: 1 });
  assert.deepEqual(revertSelectedLines("", modified, [line(3)]), { content: modified, changes: 0 });
});

test("revertSelectedLines: CRLF, and an inserted last line takes its break with it", () => {
  assert.equal(revertSelectedLines("a\r\nb\r\n", "a\r\nx\r\nb\r\n", [line(1)]).content, "a\r\nb\r\n");
  assert.equal(revertSelectedLines("a", lf(["a", "b"]), [line(1)]).content, "a");
  assert.deepEqual(revertSelectedLines("a", lf(["a", "b"]), [line(2)]), { content: lf(["a", "b"]), changes: 0 });
});

test("take then revert of the same lines returns the original, line by line", () => {
  const original = lf(["1", "2", "3", "4", "5"]);
  const modified = lf(["1", "TWO", "THREE", "4", "x", "5"]);
  for (const sel of [[line(1)], [line(2)], [line(4)], [line(1), line(4)], [{ start: 0, end: 5 }]]) {
    const taken = takeSelectedLines(original, modified, sel).content;
    // Revert from the taken text, the selection carried into ITS numbering:
    // the taken text keeps the original's line count except for taken inserts.
    const back = revertSelectedLines(original, taken, [{ start: 0, end: taken.split("\n").length - 1 }]).content;
    assert.equal(back, original, JSON.stringify(sel));
  }
});

// ── round 3: an inserted line at the very end keeps its line break ──────────
// Nothing follows a run inserted after the text's last line, so the join that
// ends every other line did not end its last kept line. A line that had a
// break in the modified text lost it — and a CRLF line kept only its CR.

test("taking one line of a run inserted at the very end keeps that line's break (no lone CR)", () => {
  // Mixed line endings, from the re-sweep: the CRLF empty row stays "\r\n".
  assert.equal(takeSelectedLines("\n", "\r\n\n\r\na", [line(2)]).content, "\n\n\r\n");
  assert.equal(takeSelectedLines("a\n", "a\n\nb\nc", [line(2)]).content, "a\n\nb\n");
  // The run's own last line has no break of its own to keep.
  assert.equal(takeSelectedLines("a\n", "a\n\nb\nc", [line(3)]).content, "a\n\nc");
});

test("reverting the last line of a run at the very end keeps the line before it ended", () => {
  assert.equal(revertSelectedLines("a\n", "a\n\nb\nc", [line(3)]).content, "a\n\nb\n");
  // Both inserted lines reverted: the original, line break and all.
  assert.equal(revertSelectedLines("a\n", "a\n\nb\nc", [{ start: 2, end: 3 }]).content, "a\n");
});
