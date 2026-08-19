import { test } from "node:test";
import assert from "node:assert/strict";
import { describeStashScope } from "../src/views/stashScope";

// The stash button never said what it would take, because there was only one
// answer: everything. Now that a stash can be narrowed, the prompt has to name
// its own scope BEFORE the user commits to it — this is the string that does it.

test("no request means the whole tree", () => {
  assert.equal(describeStashScope(), "all changes");
  assert.equal(describeStashScope({}), "all changes");
  assert.equal(describeStashScope({ paths: [] }), "all changes");
});

test("a single file is singular", () => {
  assert.equal(describeStashScope({ paths: ["src/a.ts"] }), "1 selected file");
});

test("several files are counted", () => {
  assert.equal(describeStashScope({ paths: ["a", "b", "c"] }), "3 selected files");
});

test("staged-only says so, and beats a path count", () => {
  assert.equal(describeStashScope({ stagedOnly: true }), "everything staged");
  // The combination is refused downstream; the description must not imply the
  // paths were honoured.
  assert.equal(describeStashScope({ stagedOnly: true, paths: ["a"] }), "everything staged");
});

test("every scope reads as a noun phrase that completes \"Stash …\"", () => {
  for (const req of [undefined, { paths: ["a"] }, { paths: ["a", "b"] }, { stagedOnly: true }]) {
    const s = describeStashScope(req);
    assert.doesNotMatch(s, /^[A-Z]/, "lower case, since it follows the verb");
    assert.ok(s.length > 0);
  }
});
