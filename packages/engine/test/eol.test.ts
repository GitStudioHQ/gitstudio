import { test } from "node:test";
import assert from "node:assert/strict";
import { detectEol, eolChars, normalizeEol } from "../src/lineDiff";
import { buildMergeModel } from "../src/mergeModel";

/**
 * Line endings. The merge runs on normalised text — otherwise a side that only
 * rewrote its endings (git's autocrlf, an editor setting) turned the whole file
 * into one conflict, and the same edit saved CRLF on one side and LF on the
 * other read as two different edits. What is written back is Yours' ending,
 * and the model says when the sides disagree so the UI can say so.
 */

test("detectEol names the dominant ending, or none", () => {
  assert.equal(detectEol(""), "none");
  assert.equal(detectEol("one line"), "none");
  assert.equal(detectEol("a\nb\n"), "LF");
  assert.equal(detectEol("a\r\nb\r\n"), "CRLF");
  assert.equal(detectEol("a\rb\r"), "CR");
  assert.equal(detectEol("a\r\nb\r\nc\n"), "CRLF", "two CRLF beat one LF");
  assert.equal(detectEol("a\nb\nc\r\n"), "LF");
});

test("a tie goes to the ending that comes first", () => {
  assert.equal(detectEol("a\r\nb\n"), "CRLF");
  assert.equal(detectEol("a\nb\r\n"), "LF");
});

test("normalizeEol turns every break into \\n and nothing else", () => {
  assert.equal(normalizeEol("a\r\nb\rc\nd"), "a\nb\nc\nd");
  assert.equal(normalizeEol("no breaks"), "no breaks");
  assert.equal(normalizeEol("a\r\n\r\n"), "a\n\n");
});

test("eolChars", () => {
  assert.equal(eolChars("LF"), "\n");
  assert.equal(eolChars("CRLF"), "\r\n");
  assert.equal(eolChars("CR"), "\r");
});

test("the same change with CRLF on one side is ONE identical change, and the mismatch is reported", () => {
  const model = buildMergeModel("a\nb\nc", "a\nX\nc", "a\r\nX\r\nc");
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].kind, "both-same");
  assert.equal(model.blocks[0].exact, true);
  assert.deepEqual(model.eolMismatch, { yours: "LF", theirs: "CRLF", result: "LF" });
  assert.equal(model.eol, "LF");
});

test("a side that only rewrote its endings changes nothing; the result keeps Yours' CRLF", () => {
  const model = buildMergeModel("a\nb\nc", "a\r\nb\r\nc", "a\nB\nc");
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].kind, "right-only");
  assert.equal(model.eol, "CRLF");
  assert.deepEqual(model.eolMismatch, { yours: "CRLF", theirs: "LF", result: "CRLF" });
});

test("no mismatch when the sides agree, or when one side has no line break at all", () => {
  assert.equal(buildMergeModel("a\r\nb", "a\r\nX", "a\r\nY").eolMismatch, undefined);
  assert.equal(buildMergeModel("a\r\nb", "a\r\nX", "single").eolMismatch, undefined);
  assert.equal(buildMergeModel("a\nb", "a\nX", "a\nY").eol, "LF");
});

test("Yours with no line break falls back to Theirs', then base's ending", () => {
  assert.equal(buildMergeModel("a\r\nb", "x", "a\r\nb").eol, "CRLF");
  assert.equal(buildMergeModel("a\rb", "x", "y").eol, "CR");
  assert.equal(buildMergeModel("", "x", "y").eol, "LF");
});

test("a CRLF conflict's texts are normalised, so resolvedText carries no \\r", () => {
  const model = buildMergeModel("a\r\nb\r\nc\r\nd", "a\r\nB\r\nc\r\nd", "a\r\nb\r\nC\r\nd");
  assert.equal(model.blocks.length, 1);
  assert.equal(model.blocks[0].resolvable, true);
  assert.equal(model.blocks[0].resolvedText, "B\nC");
  assert.equal(model.eol, "CRLF");
});
