import { test } from "node:test";
import assert from "node:assert/strict";
import { fuzzyScore } from "../src/shared/fuzzy";

// The scorer behind ⌘K and the repository search. A subsequence match alone is
// far too generous — these cases are the line between a match and noise.

const REPOS = [
  "v0-ckd-cats-guide",
  "antonarnaudov",
  "gistudio.dev",
  "reshapedpdf",
  "reshapedpdf-public",
  "spool",
  "gitstudio",
  "merge-conflict-tests",
  "merge-studio",
  "flexi-meal-ai",
];

const hits = (q: string): string[] =>
  REPOS.map((r) => [r, fuzzyScore(q, r)] as const)
    .filter(([, s]) => s > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([r]) => r);

test("a scattered typo is not a match", () => {
  // Every letter of "ckaude" is in "v0-ckd-cats-guide" in order, and it used to
  // score ABOVE the real substring "cats".
  assert.equal(fuzzyScore("ckaude", "v0-ckd-cats-guide"), 0);
  assert.deepEqual(hits("ckaude"), []);
  assert.deepEqual(hits("claude"), []);
});

test("real matches survive, and rank sensibly", () => {
  assert.deepEqual(hits("cats"), ["v0-ckd-cats-guide"]);
  assert.deepEqual(hits("spool"), ["spool"]);
  assert.equal(hits("reshaped")[0], "reshapedpdf");
  assert.deepEqual(hits("merge"), ["merge-studio", "merge-conflict-tests"]);
  assert.equal(hits("flexi")[0], "flexi-meal-ai");
});

test("a query stops dragging in names it only scatters through", () => {
  assert.deepEqual(hits("gitst"), ["gitstudio"]);
});

test("short queries stay forgiving", () => {
  // Under four characters the density rule does not apply — "gst" for
  // "gitstudio" is how people actually type.
  assert.ok(fuzzyScore("gst", "gitstudio") > 0);
  assert.ok(fuzzyScore("v0", "v0-ckd-cats-guide") > 0);
});

test("initials are a deliberate way to type a name", () => {
  assert.ok(fuzzyScore("fma", "flexi-meal-ai") > 0, "fma finds flexi-meal-ai");
  assert.ok(fuzzyScore("mct", "merge-conflict-tests") > 0);
  assert.equal(fuzzyScore("zzz", "flexi-meal-ai"), 0, "…but nonsense still finds nothing");
});

test("an exact name beats a partial one", () => {
  assert.ok(fuzzyScore("gitstudio", "gitstudio") > fuzzyScore("gitstudio", "gistudio.dev"));
});

test("an empty query matches everything", () => {
  assert.equal(fuzzyScore("", "anything"), 1);
});
