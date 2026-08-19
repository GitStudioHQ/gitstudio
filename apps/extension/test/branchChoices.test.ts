import { test } from "node:test";
import assert from "node:assert/strict";
import { branchChoices, shortenRemote } from "../src/statusBar/branchChoices";
import type { GitRef } from "@gitstudio/host-bridge/git";

// Clicking the branch in the status bar switches branch, the way VS Code's own
// does — it used to sync, which on an up-to-date branch looks like a dead
// button. This is the list it offers.

const head = (name: string, extra: Partial<GitRef> = {}): GitRef => ({
  type: "head", name, fullName: `refs/heads/${name}`, sha: "0".repeat(40),
  isCurrent: false, ...extra,
});
const remote = (name: string): GitRef => ({
  type: "remote", name, fullName: `refs/remotes/${name}`, sha: "0".repeat(40),
  isCurrent: false,
});

test("local branches are offered, current one marked", () => {
  const c = branchChoices([head("main", { isCurrent: true }), head("feature")]);
  assert.deepEqual(c.map((x) => x.id), ["main", "feature"]);
  assert.equal(c[0].icon, "check");
  assert.equal(c[0].description, "current branch");
  assert.equal(c[1].icon, "git-branch");
});

test("a tracking branch says what it tracks", () => {
  const [c] = branchChoices([head("feature", { upstream: "origin/feature" })]);
  assert.equal(c.description, "tracking origin/feature");
});

test("THE POINT: a remote branch with a local counterpart is not offered twice", () => {
  // Offering origin/main beside main means two rows for one destination, and
  // the remote row is the worse of the two to pick.
  const c = branchChoices([head("main", { isCurrent: true }), remote("origin/main")]);
  assert.deepEqual(c.map((x) => x.id), ["main"]);
});

test("a remote branch with NO local counterpart is offered", () => {
  const c = branchChoices([head("main"), remote("origin/main"), remote("origin/wip")]);
  assert.deepEqual(c.map((x) => x.id), ["main", "origin/wip"]);
  assert.equal(c[1].icon, "cloud");
  assert.equal(c[1].description, "remote branch");
});

test("locals come before remotes, whatever order they arrive in", () => {
  const c = branchChoices([remote("origin/wip"), head("main")]);
  assert.deepEqual(c.map((x) => x.id), ["main", "origin/wip"]);
});

test("a second remote for the same branch is still deduped against the local", () => {
  const c = branchChoices([head("main"), remote("origin/main"), remote("upstream/main")]);
  assert.deepEqual(c.map((x) => x.id), ["main"]);
});

test("tags and stashes never appear in a branch switcher", () => {
  const tag: GitRef = { type: "tag", name: "v1.0", fullName: "refs/tags/v1.0", sha: "0".repeat(40), isCurrent: false };
  const stash: GitRef = { type: "stash", name: "stash@{0}", fullName: "refs/stash", sha: "0".repeat(40), isCurrent: false };
  assert.deepEqual(branchChoices([head("main"), tag, stash]).map((x) => x.id), ["main"]);
});

test("no branches at all yields nothing to pick", () => {
  assert.deepEqual(branchChoices([]), []);
});

test("shortenRemote strips only the first segment", () => {
  assert.equal(shortenRemote("origin/main"), "main");
  // A slash in the branch name itself must survive.
  assert.equal(shortenRemote("origin/feature/login"), "feature/login");
  assert.equal(shortenRemote("noslash"), "noslash");
});
