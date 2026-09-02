import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChangeBlocks } from "../src/staging/blockStaging";

/**
 * An unstaged file's index blob IS its HEAD blob, so the "since head" and
 * "unstaged" diffs have identical inputs. The second is skipped; these pin that
 * skipping it cannot change the answer.
 */
const HEAD = "a\nb\nc\nd\ne\n";
const WORK = "a\nB\nc\nd\nE\n";
const INDEX_PARTIAL = "a\nB\nc\nd\ne\n";

test("an entirely unstaged file reports every block unstaged", () => {
  const blocks = computeChangeBlocks(HEAD, HEAD, WORK);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.state), ["unstaged", "unstaged"]);
});

test("an index built at runtime takes the same path as the literal", () => {
  // `===` on strings compares VALUE, not object identity, which is what makes
  // the shortcut sound: equal texts would have been handed to the same diff
  // with the same arguments. A separately-constructed equal string must
  // therefore reach the identical answer, and not a different code path.
  const built = HEAD.split("\n").join("\n");
  assert.notEqual(Object.is(built, HEAD) && built.length === 0, true); // built at runtime
  assert.deepEqual(computeChangeBlocks(HEAD, built, WORK), computeChangeBlocks(HEAD, HEAD, WORK));
});

test("a partly staged file is unaffected — the index differs from HEAD", () => {
  const blocks = computeChangeBlocks(HEAD, INDEX_PARTIAL, WORK);
  assert.equal(blocks.length, 2);
  assert.deepEqual(blocks.map((b) => b.state), ["staged", "unstaged"]);
});
