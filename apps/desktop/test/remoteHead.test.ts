import { test } from "node:test";
import assert from "node:assert/strict";
import { isRemoteHead } from "../src/renderer/branchRequests";

// A remote's own HEAD (refs/remotes/origin/HEAD) is git's pointer at the
// remote's default branch, not a branch to check out, compare or copy. Three
// lists had to leave it out — the Branches view, the graph's ref menu and the
// branch switcher (#32 review) — and each carried its own guess at how to
// spot it. Two of the guesses asked the SHORT name to end in "/HEAD", which it
// never does: git shortens refs/remotes/origin/HEAD to "origin". One test,
// asked of the full name, as `git for-each-ref` reports each ref.

test("the remote's HEAD, as refs:list carries it, is recognised", () => {
  assert.equal(isRemoteHead({ name: "origin", fullName: "refs/remotes/origin/HEAD", symref: "origin/main" }), true);
  // Without the symref too — a payload that drops it still names the ref.
  assert.equal(isRemoteHead({ name: "origin", fullName: "refs/remotes/origin/HEAD" }), true);
  // A remote whose name has a slash in it.
  assert.equal(isRemoteHead({ name: "team/fork", fullName: "refs/remotes/team/fork/HEAD" }), true);
});

test("a branch is not the remote's HEAD", () => {
  assert.equal(isRemoteHead({ name: "origin/main", fullName: "refs/remotes/origin/main" }), false);
  // A branch that merely contains the word.
  assert.equal(isRemoteHead({ name: "origin/HEAD-fix", fullName: "refs/remotes/origin/HEAD-fix" }), false);
  assert.equal(isRemoteHead({ name: "origin/fix/HEADER", fullName: "refs/remotes/origin/fix/HEADER" }), false);
  // A local branch or a tag never is, whatever it is called.
  assert.equal(isRemoteHead({ name: "x/HEAD", fullName: "refs/heads/x/HEAD" }), false);
  assert.equal(isRemoteHead({ name: "HEAD", fullName: "refs/tags/HEAD" }), false);
});

test("a ref with no full name falls back to the short one", () => {
  assert.equal(isRemoteHead({ name: "origin/HEAD" }), true);
  assert.equal(isRemoteHead({ name: "origin/main" }), false);
});
