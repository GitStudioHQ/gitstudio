import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySelectedChanges,
  applyAllChanges,
  computeHunks,
  type LineRange,
} from "../src/staging/applyLineChanges";

const lf = (arr: string[]): string => arr.join("\n") + "\n";

// Convenience: a single-line selection (0-based, inclusive) in modified coords.
const line = (n: number): LineRange => ({ start: n, end: n });

test("stage a single changed line out of several — only that line is staged", () => {
  // Lines 1 and 3 (0-based) both change; we stage ONLY line 1.
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["a", "B", "c", "D"]);

  const staged = applySelectedChanges(original, modified, [line(1)]);
  // Line 1 took the modified value (B); line 3 reverted to original (d).
  assert.equal(staged, lf(["a", "B", "c", "d"]));
});

test("stage the OTHER changed line — symmetric, line 3 only", () => {
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["a", "B", "c", "D"]);

  const staged = applySelectedChanges(original, modified, [line(3)]);
  assert.equal(staged, lf(["a", "b", "c", "D"]));
});

test("stage one hunk of two (multi-line hunks)", () => {
  // Two separate contiguous hunks; stage just the first.
  const original = lf(["1", "2", "3", "4", "5", "6"]);
  const modified = lf(["1", "TWO", "THREE", "4", "5", "SIX"]);

  // Hunk A covers modified lines 1-2; hunk B covers modified line 5.
  const stagedA = applySelectedChanges(original, modified, [
    { start: 1, end: 2 },
  ]);
  assert.equal(stagedA, lf(["1", "TWO", "THREE", "4", "5", "6"]));

  const stagedB = applySelectedChanges(original, modified, [line(5)]);
  assert.equal(stagedB, lf(["1", "2", "3", "4", "5", "SIX"]));
});

test("stage an inserted block", () => {
  const original = lf(["a", "b", "c"]);
  const modified = lf(["a", "NEW1", "NEW2", "b", "c"]);

  // The inserted lines are modified indices 1-2.
  const staged = applySelectedChanges(original, modified, [
    { start: 1, end: 2 },
  ]);
  assert.equal(staged, modified);

  // Selecting nothing in the insertion region → original unchanged.
  const none = applySelectedChanges(original, modified, [line(0)]);
  assert.equal(none, original);
});

test("stage a deleted block", () => {
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["a", "d"]);

  // The deletion appears at modified line index 1 (the boundary). Selecting it
  // applies the deletion.
  const staged = applySelectedChanges(original, modified, [line(1)]);
  assert.equal(staged, modified);
});

test("selecting nothing leaves the original unchanged", () => {
  const original = lf(["a", "b", "c"]);
  const modified = lf(["a", "B", "C"]);
  const staged = applySelectedChanges(original, modified, []);
  assert.equal(staged, original);
});

test("CRLF line endings are preserved", () => {
  // An unchanged line (c) sits between the two edits so they form two distinct
  // hunks; we stage only the first.
  const original = "a\r\nb\r\nc\r\nd\r\n";
  const modified = "a\r\nB\r\nc\r\nD\r\n";
  const staged = applySelectedChanges(original, modified, [line(1)]);
  assert.equal(staged, "a\r\nB\r\nc\r\nd\r\n");
  // The result must use CRLF, never bare LF.
  assert.ok(!/[^\r]\n/.test(staged), "no bare LF allowed");
});

test("no-trailing-newline files preserve the missing final newline", () => {
  const original = "a\nb\nc"; // no trailing newline
  const modified = "a\nB\nc"; // no trailing newline
  const staged = applySelectedChanges(original, modified, [line(1)]);
  assert.equal(staged, "a\nB\nc");
  assert.ok(!staged.endsWith("\n"), "trailing newline must stay absent");
});

test("new file: original '' stages the whole modified content", () => {
  const original = "";
  const modified = lf(["hello", "world"]);
  const hunks = computeHunks(original, modified);
  assert.ok(hunks.length >= 1);
  // Select every modified line.
  const staged = applySelectedChanges(original, modified, [
    { start: 0, end: 1 },
  ]);
  assert.equal(staged, modified);
});

test("applyAllChanges stages the entire modified file", () => {
  const original = lf(["a", "b", "c"]);
  const modified = lf(["a", "B", "c", "D"]);
  assert.equal(applyAllChanges(original, modified), modified);

  // No changes → returns the (identical) modified content unchanged.
  assert.equal(applyAllChanges(original, original), original);
});

test("computeHunks reports 0-based inclusive ranges per side", () => {
  const original = lf(["a", "b", "c", "d"]);
  const modified = lf(["a", "B", "c", "D"]);
  const hunks = computeHunks(original, modified);
  assert.equal(hunks.length, 2);
  assert.deepEqual(hunks[0].modified, { start: 1, end: 1 });
  assert.deepEqual(hunks[1].modified, { start: 3, end: 3 });
});

test("staging two of three changes leaves the third at original", () => {
  const original = lf(["1", "2", "3", "4", "5"]);
  const modified = lf(["ONE", "2", "THREE", "4", "FIVE"]);
  // Stage hunks at modified lines 0 and 4, leave line 2 alone.
  const staged = applySelectedChanges(original, modified, [line(0), line(4)]);
  assert.equal(staged, lf(["ONE", "2", "3", "4", "FIVE"]));
});

test("adding a trailing newline is honored when the whole file is staged", () => {
  const original = "a\nb"; // no trailing newline
  const modified = "a\nb\n"; // added trailing newline
  const staged = applyAllChanges(original, modified);
  assert.equal(staged, modified);
});
