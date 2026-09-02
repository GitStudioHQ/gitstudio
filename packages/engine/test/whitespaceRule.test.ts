import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSide, ignoreTrimWhitespaceFor, splitLines } from "../src/lineDiff";

/**
 * The desktop app draws the same file two ways: the split view through
 * `diffSide` here, the unified view through Monaco's own diff worker. Both are
 * the same vscode-diff computer, so they agree — but only while they are handed
 * the same `ignoreTrimWhitespace`. When each derived it from the app's toggle
 * separately they drifted, and the two views of one file disagreed about
 * whether it had changed at all.
 *
 * These pin the rule itself, and the behaviour each answer buys.
 */

test("the rule is off only when whitespace is not being ignored", () => {
  assert.equal(ignoreTrimWhitespaceFor("none"), false);
  assert.equal(ignoreTrimWhitespaceFor("trailing"), true);
  assert.equal(ignoreTrimWhitespaceFor("all"), true);
});

const LEFT = splitLines('export function pad(n: number): string {\n  return " ".repeat(n);\n}\n');
const REINDENTED = splitLines('export function pad(n: number): string {\n      return " ".repeat(n);\n}\n');
const TRAILING = splitLines('export function pad(n: number): string {\n  return " ".repeat(n);\n}   \n');
const INNER = splitLines('export function pad(n: number): string {\n  return  " ".repeat(n);\n}\n');

test("with whitespace shown, a re-indent is a change", () => {
  assert.equal(diffSide(LEFT, REINDENTED, "right", { whitespace: "none" }).length, 1);
});

test("with trailing whitespace ignored, a re-indent is not", () => {
  assert.equal(diffSide(LEFT, REINDENTED, "right", { whitespace: "trailing" }).length, 0);
});

test("nor are trailing spaces", () => {
  assert.equal(diffSide(LEFT, TRAILING, "right", { whitespace: "none" }).length, 1);
  assert.equal(diffSide(LEFT, TRAILING, "right", { whitespace: "trailing" }).length, 0);
});

/**
 * The reason the desktop toggle sends "trailing" and never "all": "all"
 * collapses runs of whitespace INSIDE a line — git's `-b`, roughly — which no
 * Monaco option does. Offering it beside a unified view would recreate the
 * disagreement in the other direction: split silent, unified drawing a change.
 */
test("only \"all\" reaches inside a line, which is why Monaco cannot match it", () => {
  assert.equal(diffSide(LEFT, INNER, "right", { whitespace: "trailing" }).length, 1);
  assert.equal(diffSide(LEFT, INNER, "right", { whitespace: "all" }).length, 0);
});
