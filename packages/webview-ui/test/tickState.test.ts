import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deriveTickStates,
  tickLabel,
  ariaChecked,
  nextStaged,
} from "../src/tickState";

// The tick states, tested without Monaco or a DOM. What is being pinned here is
// the join: the i-th tick belongs to the i-th block the DiffView drew, with no
// matching heuristic in between. If that ever stops holding, every tick in a
// multi-change file points at the wrong change — which would silently stage the
// wrong edit, so it fails loudly instead.

const T = (...lines: string[]): string => lines.join("\n") + "\n";

test("states line up with the rendered blocks, in order", () => {
  const head = T("a", "b", "c", "d", "e", "f", "g");
  const index = T("a", "B", "c", "d", "e", "f", "g"); // first edit staged
  const working = T("a", "B", "c", "d", "e", "F", "g");

  const model = deriveTickStates(head, index, working, 2);
  assert.equal(model.trustworthy, true);
  assert.deepEqual(model.blocks.map((b) => b.state), ["staged", "unstaged"]);
});

test("a block-count mismatch yields NO ticks rather than misaligned ones", () => {
  // The view rendered three blocks, the texts produce two. Painting two ticks
  // onto three blocks would put each tick beside the wrong change.
  const head = T("a", "b", "c", "d", "e");
  const working = T("a", "B", "c", "D", "e");

  const model = deriveTickStates(head, head, working, 3);
  assert.equal(model.trustworthy, false);
  assert.deepEqual(model.blocks, []);
});

test("an unchanged file has no ticks and is still trustworthy", () => {
  const same = T("a", "b");
  const model = deriveTickStates(same, same, same, 0);
  assert.equal(model.trustworthy, true);
  assert.deepEqual(model.blocks, []);
});

test("a partial block is reported as such", () => {
  const head = T("a", "b", "c", "d", "e");
  const index = T("a", "b", "C", "d", "e");
  const working = T("a", "B", "C", "D", "e");
  const model = deriveTickStates(head, index, working, 1);
  assert.equal(model.blocks[0].state, "partial");
});

test("aria-checked covers all three states, including mixed", () => {
  assert.equal(ariaChecked("staged"), "true");
  assert.equal(ariaChecked("unstaged"), "false");
  assert.equal(ariaChecked("partial"), "mixed", "a tri-state checkbox is 'mixed', not 'false'");
});

test("clicking a partial block stages the rest rather than discarding it", () => {
  // Unstaging would throw away work the user explicitly staged earlier, which is
  // the more surprising direction of the two.
  assert.equal(nextStaged("partial"), true);
  assert.equal(nextStaged("unstaged"), true);
  assert.equal(nextStaged("staged"), false);
});

test("every state has a distinct label that says what a click will do", () => {
  const labels = (["staged", "unstaged", "partial"] as const).map(tickLabel);
  assert.equal(new Set(labels).size, 3, "three states, three labels");
  for (const l of labels) {
    assert.match(l, /click to/i, "the label must name the action, not just the state");
  }
});
