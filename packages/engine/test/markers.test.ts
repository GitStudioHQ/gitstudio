import { test } from "node:test";
import assert from "node:assert/strict";
import { parseConflictMarkers } from "../src/conflict/markers";

test("returns no conflicts for clean text", () => {
  const parsed = parseConflictMarkers("line one\nline two\n");
  assert.equal(parsed.hasConflicts, false);
  assert.equal(parsed.isDiff3, false);
  assert.equal(parsed.ours, "line one\nline two\n");
  assert.equal(parsed.theirs, "line one\nline two\n");
});

test("parses a classic (2-way) conflict block", () => {
  const text = [
    "common top",
    "<<<<<<< HEAD",
    "our change",
    "=======",
    "their change",
    ">>>>>>> feature",
    "common bottom",
  ].join("\n");

  const parsed = parseConflictMarkers(text);
  assert.equal(parsed.hasConflicts, true);
  assert.equal(parsed.isDiff3, false);
  assert.equal(parsed.ours, "common top\nour change\ncommon bottom");
  assert.equal(parsed.theirs, "common top\ntheir change\ncommon bottom");
  // Without diff3 markers, base only contains the common (unconflicted) lines.
  assert.equal(parsed.base, "common top\ncommon bottom");
});

test("parses a diff3 conflict block with a base section", () => {
  const text = [
    "alpha",
    "<<<<<<< HEAD",
    "ours line",
    "||||||| merged common ancestors",
    "base line",
    "=======",
    "theirs line",
    ">>>>>>> branch",
    "omega",
  ].join("\n");

  const parsed = parseConflictMarkers(text);
  assert.equal(parsed.hasConflicts, true);
  assert.equal(parsed.isDiff3, true);
  assert.equal(parsed.ours, "alpha\nours line\nomega");
  assert.equal(parsed.base, "alpha\nbase line\nomega");
  assert.equal(parsed.theirs, "alpha\ntheirs line\nomega");
});

test("handles multiple conflict blocks", () => {
  const text = [
    "<<<<<<< HEAD",
    "a-ours",
    "=======",
    "a-theirs",
    ">>>>>>> x",
    "middle",
    "<<<<<<< HEAD",
    "b-ours",
    "=======",
    "b-theirs",
    ">>>>>>> x",
  ].join("\n");

  const parsed = parseConflictMarkers(text);
  assert.equal(parsed.ours, "a-ours\nmiddle\nb-ours");
  assert.equal(parsed.theirs, "a-theirs\nmiddle\nb-theirs");
});

test("does not treat content equals-signs as separators outside a block", () => {
  const text = "const x = a======= b;\nplain line\n";
  const parsed = parseConflictMarkers(text);
  assert.equal(parsed.hasConflicts, false);
  assert.equal(parsed.ours, text);
});
