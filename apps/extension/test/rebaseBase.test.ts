import { test } from "node:test";
import assert from "node:assert/strict";
import { describeRebaseBase } from "../src/rebase/rebaseBase";

// Both interactive-rebase doors hand git "<sha>^" (the picked commit's
// parent). Their Undo labels, and the workspace's header, said it with the
// full 40-character sha — "Interactive rebase onto 1a2b3c4d…(40)^" — because
// each shortened only a bare 40-character sha.

test("a rebase base reads short: '<sha>^' as the short sha and '^', --root in words, a ref as typed", () => {
  const sha = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d";
  assert.equal(describeRebaseBase(`${sha}^`), "1a2b3c4^");
  assert.equal(describeRebaseBase(sha), "1a2b3c4");
  assert.equal(describeRebaseBase("--root"), "the root commit");
  assert.equal(describeRebaseBase("origin/main"), "origin/main");
  assert.equal(describeRebaseBase("HEAD~5"), "HEAD~5");
});
