import { test } from "node:test";
import assert from "node:assert/strict";

// Which local clone does "Open" mean, on a GitHub row whose repository is on
// this machine more than once?
//
// This machine has three such cases: ~/Developer/TrustGlobe holds `trust-globe`
// and `trust-globe copy`, and ~/Developer/FlexiMeal holds three directories all
// reporting `antonarnaudov/v0-meal-planning-app` (one of them a worktree).
// The map was built by writing every copy into it in scan order, so the LAST
// one won — and the scan sorts by name, which put "trust-globe copy" after
// "trust-globe". Open on the GitHub row opened the copy.
//
// The rule lives in shared/repoGrouping so the two screens that join GitHub
// results against local copies cannot drift; this pins the ORDER, which is the
// part that was wrong.

interface Copy {
  root: string;
  current: boolean;
  missing: boolean;
}

import { betterCopy } from "../src/shared/repoGrouping";

/** The map the view builds, with the fix applied. */
function pick(copies: Copy[]): Copy {
  let best: Copy | undefined;
  for (const c of copies) if (!best || betterCopy(c, best)) best = c;
  return best!;
}

const at = (root: string, over: Partial<Copy> = {}): Copy => ({
  root,
  current: false,
  missing: false,
  ...over,
});

test("scan order does not decide which copy Open means", () => {
  const a = at("/d/TrustGlobe/trust-globe");
  const b = at("/d/TrustGlobe/trust-globe copy");
  // Name-sorted, which is how the scan hands them over: the copy came last and
  // therefore used to win.
  assert.equal(pick([a, b]).root, a.root);
  assert.equal(pick([b, a]).root, a.root, "and the other order agrees");
});

test("the repository you are standing in wins", () => {
  const plain = at("/d/x/repo");
  const open = at("/d/somewhere/much/deeper/repo", { current: true });
  assert.equal(pick([plain, open]).root, open.root);
  assert.equal(pick([open, plain]).root, open.root);
});

test("a copy that is actually on disk beats one that is not", () => {
  const gone = at("/d/a/repo", { missing: true });
  const there = at("/d/aaaa/deeper/repo");
  assert.equal(pick([gone, there]).root, there.root, "even though it is deeper");
});

test("otherwise the one nearer the top of the tree wins", () => {
  const shallow = at("/d/repo");
  const deep = at("/d/archive/2019/repo");
  assert.equal(pick([deep, shallow]).root, shallow.root);
});

test("the clone beats its own worktree, whatever the path lengths say", () => {
  const clone = { root: "/u/dev/really-long-project-name", current: false, missing: false };
  const wt = { root: "/u/wt", current: false, missing: false, worktreeOf: clone.root };
  assert.equal(betterCopy(clone, wt), true, "clone wins despite the longer path");
  assert.equal(betterCopy(wt, clone), false);
  // But an OPEN worktree still wins — "current" is the strongest claim there is.
  assert.equal(betterCopy({ ...wt, current: true }, clone), true);
});
