import { test } from "node:test";
import assert from "node:assert/strict";
import { branchStartCopy } from "../src/shared/branchStart";

// The words the New-branch dialog uses, and whether "Switch to it after
// creating" starts ticked. Pure on purpose: the graph and commit-page entry
// points live inside web components, so a harness check there would have to
// fire synthetic events into a shadow root — the kind of check that passes on a
// broken build. This pins the copy and the defaults instead.

test("from HEAD it says where you are", () => {
  const c = branchStartCopy({ kind: "head", label: "main", sha: "a1b2c3d" });
  assert.equal(c.title, "New branch");
  assert.equal(c.hint, "Starts at main (a1b2c3d) — where you are now.");
  assert.equal(c.seed, "");
  assert.equal(c.switchByDefault, true);
});

test("a detached HEAD does not pretend to be a branch", () => {
  const c = branchStartCopy({ kind: "head", label: "HEAD", sha: "a1b2c3d", detached: true });
  assert.equal(c.hint, "Starts at the commit you have checked out (a1b2c3d).");
});

test("from a branch it names the branch", () => {
  const c = branchStartCopy({ kind: "branch", label: "release/1.7", sha: "9f8e7d6" });
  assert.equal(c.title, "New branch from release/1.7");
  assert.equal(c.hint, "Starts at release/1.7 (9f8e7d6).");
  assert.equal(c.switchByDefault, true);
});

test("from a remote branch it seeds the local name and promises tracking", () => {
  const c = branchStartCopy({ kind: "remote", label: "origin/feature/x", sha: "1234567" });
  assert.equal(c.title, "New branch from origin/feature/x");
  assert.equal(c.hint, "Starts at origin/feature/x (1234567). The new branch tracks it.");
  assert.equal(c.seed, "feature/x", "the remote name drops its remote, as Check out here promises");
  assert.equal(branchStartCopy({ kind: "remote", label: "origin/main" }).seed, "main");
});

test("from a tag it says it is a tag", () => {
  const c = branchStartCopy({ kind: "tag", label: "v1.7.0", sha: "abcdef1" });
  assert.equal(c.title, "New branch from v1.7.0");
  assert.equal(c.hint, "Starts at the tag v1.7.0 (abcdef1).");
});

test("at a commit it is bookmarking, so it does NOT switch by default", () => {
  const c = branchStartCopy({ kind: "commit", label: "a1b2c3d", sha: "a1b2c3d", subject: "fix: the thing" });
  assert.equal(c.title, "New branch at a1b2c3d");
  assert.equal(c.hint, "fix: the thing — the branch starts here.");
  assert.equal(c.switchByDefault, false, "naming a point in history should not move you");
});

test("a commit with no subject still says what will happen", () => {
  const c = branchStartCopy({ kind: "commit", label: "a1b2c3d", sha: "a1b2c3d" });
  assert.equal(c.hint, "The branch starts at this commit.");
});

test("an unknown sha is omitted rather than rendered empty", () => {
  assert.equal(branchStartCopy({ kind: "branch", label: "main" }).hint, "Starts at main.");
  assert.equal(branchStartCopy({ kind: "head", label: "main" }).hint, "Starts at main — where you are now.");
});
