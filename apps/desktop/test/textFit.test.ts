import { test } from "node:test";
import assert from "node:assert/strict";

/**
 * `"a\nb\n".split("\n")` is `["a", "b", ""]`, and every code viewer in the app
 * numbered that trailing empty string as a real line — so a 5-line file showed
 * six numbers and a line reference was off by one against the editor the reader
 * would go on to open. A POSIX text file ends in a newline: this was every file,
 * not an edge case.
 */
test("fileLines counts the lines a reader would count", async () => {
  const { fileLines } = await import("../src/renderer/textFit.ts");
  assert.deepEqual(fileLines("a\nb\n"), ["a", "b"], "the trailing newline ends the last line");
  assert.deepEqual(fileLines("a\nb"), ["a", "b"], "a file with no trailing newline is unchanged");
  assert.deepEqual(fileLines("a\n\n"), ["a", ""], "a genuinely blank final line survives");
  assert.deepEqual(fileLines(""), [""], "an empty file is one empty line, not zero");
  assert.deepEqual(fileLines("\n"), [""], "a file that is only a newline is one empty line");
  assert.deepEqual(fileLines("only"), ["only"], "a single line with no newline");
  assert.deepEqual(fileLines("a\nb\n\n\n"), ["a", "b", "", ""], "only ONE trailing empty is dropped");
});

/** The other half of the same helper file: the plural nobody should ship. */
test("plural never renders the placeholder", async () => {
  const { plural } = await import("../src/renderer/textFit.ts");
  assert.equal(plural(1, "commit"), "1 commit");
  assert.equal(plural(0, "commit"), "0 commits");
  assert.equal(plural(2, "commit"), "2 commits");
  assert.equal(plural(1200, "download"), `${(1200).toLocaleString()} downloads`, "grouped");
  assert.equal(plural(1, "entry", "entries"), "1 entry");
  assert.equal(plural(3, "entry", "entries"), "3 entries");
});
