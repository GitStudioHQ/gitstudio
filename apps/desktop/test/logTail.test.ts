import { test } from "node:test";
import assert from "node:assert/strict";
import { sliceLogDelta } from "../src/main/github/logTail";

test("first fetch (offset 0) returns the whole text as an append", () => {
  const d = sliceLogDelta("line1\nline2\n", 0);
  assert.equal(d.text, "line1\nline2\n");
  assert.equal(d.totalLength, 12);
  assert.equal(d.reset, false);
  assert.equal(d.truncated, false);
});

test("subsequent fetch appends only the unseen remainder", () => {
  const d = sliceLogDelta("line1\nline2\nline3\n", 12);
  assert.equal(d.text, "line3\n");
  assert.equal(d.reset, false);
});

test("unchanged log yields an empty append", () => {
  const d = sliceLogDelta("abc", 3);
  assert.equal(d.text, "");
  assert.equal(d.totalLength, 3);
  assert.equal(d.reset, false);
});

test("a shrunken log (re-run attempt) resets", () => {
  const d = sliceLogDelta("new run\n", 500);
  assert.equal(d.reset, true);
  assert.equal(d.text, "new run\n");
  assert.equal(d.truncated, false);
});

test("a log over the cap resets to a truncated tail window on a line boundary", () => {
  const line = "x".repeat(99) + "\n"; // 100 chars per line
  const full = line.repeat(50); // 5000 chars
  const d = sliceLogDelta(full, 0, 1000);
  assert.equal(d.reset, true);
  assert.equal(d.truncated, true);
  assert.ok(d.text.length <= 1000);
  assert.ok(d.text.startsWith("x")); // starts at a line boundary, not mid-line
  assert.equal(d.totalLength, 5000);
  assert.ok(full.endsWith(d.text));
});

test("exact-boundary append (remainder == cap) stays an append", () => {
  const d = sliceLogDelta("a".repeat(10), 5, 5);
  assert.equal(d.reset, false);
  assert.equal(d.text, "aaaaa");
});
