import { test } from "node:test";
import assert from "node:assert/strict";
import { blockAtLine } from "../src/changes/blockAtLine";
import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";

// Which change a keypress or a line-number right-click actually hits. Getting
// this wrong stages a change the user was not pointing at, and nothing on screen
// would say so — so the deletion case in particular is pinned here rather than
// left to range arithmetic.

const block = (
  workingStart: number,
  workingEnd: number,
  state: ChangeBlock["state"] = "unstaged",
): ChangeBlock => ({
  head: { start: workingStart, end: workingEnd },
  working: { start: workingStart, end: workingEnd },
  state,
});

test("a line inside a block matches it", () => {
  const blocks = [block(2, 4), block(10, 10)];
  assert.equal(blockAtLine(blocks, 3), blocks[0]);
  assert.equal(blockAtLine(blocks, 10), blocks[1]);
});

test("both edges of a block are inside it", () => {
  const blocks = [block(2, 4)];
  assert.equal(blockAtLine(blocks, 2), blocks[0]);
  assert.equal(blockAtLine(blocks, 4), blocks[0]);
});

test("a line between blocks matches nothing", () => {
  const blocks = [block(2, 4), block(10, 12)];
  assert.equal(blockAtLine(blocks, 7), undefined);
  assert.equal(blockAtLine(blocks, 0), undefined);
  assert.equal(blockAtLine(blocks, 99), undefined);
});

test("a pure DELETION is matchable at all", () => {
  // A deletion occupies no line on the working side, so its range arrives with
  // end < start. Plain `line >= start && line <= end` can never be true for
  // that, which would make every deletion silently unstageable from the gutter.
  const deletion: ChangeBlock = {
    head: { start: 5, end: 7 },
    working: { start: 5, end: 4 },
    state: "unstaged",
  };
  assert.equal(blockAtLine([deletion], 5), deletion);
  assert.equal(blockAtLine([deletion], 4), undefined);
  assert.equal(blockAtLine([deletion], 6), undefined);
});

test("a deletion next to a real block does not swallow its lines", () => {
  const deletion: ChangeBlock = {
    head: { start: 5, end: 7 },
    working: { start: 5, end: 4 },
    state: "unstaged",
  };
  const after = block(6, 8);
  assert.equal(blockAtLine([deletion, after], 6), after);
});

test("no blocks means no match, not a crash", () => {
  assert.equal(blockAtLine([], 0), undefined);
});
