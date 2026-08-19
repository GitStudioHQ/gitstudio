import { test } from "node:test";
import assert from "node:assert/strict";
import { changesLabel, changesTooltip } from "../src/statusBar/changesLabel";

// The Changes status-bar segment. It is two lines of logic, but it is read
// dozens of times a day and sits next to VS Code's own git segment, so getting
// the zero case or the plurals wrong is conspicuous.

test("a clean tree says so rather than going blank", () => {
  // An empty segment reads as "this is broken", not "there is nothing here".
  assert.equal(changesLabel(0, 0), "$(check) clean");
  assert.equal(changesTooltip(0, 0), "GitStudio: no local changes");
});

test("with nothing staged, the label is just the count", () => {
  assert.equal(changesLabel(0, 7), "$(diff) 7");
});

test("staged work is called out, because it is what is committable", () => {
  assert.match(changesLabel(3, 4), /^\$\(diff\) 7 /);
  assert.match(changesLabel(3, 4), /3 staged$/);
});

test("the total counts both halves, not just one", () => {
  assert.match(changesLabel(2, 5), /\b7\b/);
});

test("the tooltip names unstaged first, then staged", () => {
  assert.equal(changesTooltip(3, 4), "GitStudio: 4 unstaged, 3 staged");
});

test("a zero half is omitted from the tooltip rather than shown as 0", () => {
  assert.equal(changesTooltip(0, 4), "GitStudio: 4 unstaged");
  assert.equal(changesTooltip(3, 0), "GitStudio: 3 staged");
});

test("everything staged still reports a total, not an empty label", () => {
  assert.equal(changesLabel(5, 0), "$(diff) 5 · 5 staged");
});
