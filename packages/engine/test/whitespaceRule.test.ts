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

/**
 * The 2-way diff must keep HIDING whitespace-only changes when whitespace is
 * ignored (the Monaco agreement above); the merge asks for them explicitly.
 */
test("whitespace-only changes are reported only when asked for, and flagged", () => {
  assert.equal(diffSide(LEFT, REINDENTED, "right", { whitespace: "trailing" }).length, 0);
  const found = diffSide(LEFT, REINDENTED, "right", {
    whitespace: "trailing",
    whitespaceOnlyChanges: true,
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].whitespaceOnly, true);
  assert.deepEqual(found[0].baseSpan, { start: 2, endExclusive: 3 });
  assert.deepEqual(found[0].innerSide, []);
  // "none" already reports it as a real change — nothing to add or flag.
  const plain = diffSide(LEFT, REINDENTED, "right", { whitespace: "none", whitespaceOnlyChanges: true });
  assert.equal(plain.length, 1);
  assert.equal(plain[0].whitespaceOnly, undefined);
});

/**
 * Under "all" the diff runs on normalised lines (runs collapsed, ends
 * trimmed). Its character ranges used to be handed to the editor as they were
 * — columns into strings nobody sees — so every word highlight in "Ignore
 * whitespaces" mode was drawn in the wrong place on an indented line.
 */
test("under \"all\", word ranges point at the ORIGINAL columns", () => {
  const base = ["x", "    return  1;", "y"];
  const side = ["x", "    return  2;", "y"];
  const [change] = diffSide(base, side, "right", { whitespace: "all" });
  assert.ok(change, "the digit change is a real change");
  const inner = change.innerSide.find((r) => r.startLine === 2);
  assert.ok(inner, "a word range on line 2");
  // "    return  2;" — the 2 is column 13 (1-based), not column 8 as in the
  // normalised "return 2;".
  assert.equal(side[1].slice(inner.startColumn - 1, inner.endColumn - 1), "2");
  const innerBase = change.innerBase.find((r) => r.startLine === 2);
  assert.ok(innerBase);
  assert.equal(base[1].slice(innerBase.startColumn - 1, innerBase.endColumn - 1), "1");
});
