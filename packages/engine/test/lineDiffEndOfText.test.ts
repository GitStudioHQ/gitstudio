import { test, after } from "node:test";
import assert from "node:assert/strict";
import { linesDiffComputers } from "vscode-diff";
import { computeLineChanges, diffSide, endIsAtRisk, splitLines, type LineChange } from "../src/lineDiff";
import { computeHunks, applySelectedChanges } from "../src/staging/applyLineChanges";
import { computeChangeBlocks } from "../src/staging/blockStaging";

// Crash report #19: "Assertion Failed" from vscode-diff's computeDiff, six times
// from Windows, thrown from a timer by the editor gutter's refresh. vscode-diff
// mis-numbers a blank line added (or removed) at the very end of a text whose
// last line is blank on both sides, when the two texts' blank lines are not all
// spelled the same — every CRLF file with an empty line in it (its blank lines
// split as "\r", its last as ""), or "" beside "  ". Its own consistency check
// then fails, and it reports that by throwing from a setTimeout. Worse than the
// noise: the changes it returned did not add up, so staging them all wrote a
// different text from the one on disk.

/**
 * Every soft assertion vscode-diff raises surfaces as an uncaught exception a
 * tick later. Counted here, so a regression is named rather than being an
 * anonymous failure of whichever test happens to be running.
 */
const asserted: string[] = [];
const onUncaught = (err: Error): void => {
  if (/Assertion Failed/.test(String(err?.message))) asserted.push(err.message.split("\n")[0]);
  else throw err;
};
process.prependListener("uncaughtException", onUncaught);
after(() => process.off("uncaughtException", onUncaught));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

const EXACT = { ignoreTrimWhitespace: false, maxComputationTimeMs: 5000, computeMoves: false };

/** Stage every change of original → modified: the result must be `modified`. */
function stageAll(original: string, modified: string): string {
  return applySelectedChanges(
    original,
    modified,
    computeHunks(original, modified).map((h) => h.modified),
  );
}

/** The changes as plain numbers, character ranges included, to compare whole answers. */
function shape(changes: readonly LineChange[]): unknown {
  const r = (x: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => [
    x.startLineNumber,
    x.startColumn,
    x.endLineNumber,
    x.endColumn,
  ];
  return changes.map((c) => ({
    original: [c.original.startLineNumber, c.original.endLineNumberExclusive],
    modified: [c.modified.startLineNumber, c.modified.endLineNumberExclusive],
    inner: (c.innerChanges ?? []).map((i) => [r(i.originalRange), r(i.modifiedRange)]),
  }));
}

/** Every text of up to `max` lines made from `tokens`, joined by "\n". */
function texts(tokens: readonly string[], max: number): string[] {
  const out: string[] = [];
  const grow = (lines: string[]): void => {
    if (lines.length) out.push(lines.join("\n"));
    if (lines.length < max) for (const t of tokens) grow([...lines, t]);
  };
  grow([]);
  return out;
}

test("#19: a whitespace-only line added at the end is inserted, and staging it stages exactly it", async () => {
  const head = "x\n";
  const working = "x\n \n";
  assert.deepEqual(computeHunks(head, working).map((h) => [h.original, h.modified]), [
    // Nothing of HEAD's replaced; the working text's line 2 (0-based 1) added.
    // It was "line 2 modified, nothing added": one line short on the right.
    [{ start: 1, end: 0 }, { start: 1, end: 1 }],
  ]);
  assert.equal(stageAll(head, working), working);
  await settle();
  assert.deepEqual(asserted, []);
});

test("#19 on Windows: a blank line added to a CRLF file is that line, inserted — not a block over the untouched last line", async () => {
  const head = "a\r\nb\r\n";
  const longer = "a\r\nb\r\n\r\n";
  // It staged "a\r\nb\r\n\r" — a lone CR at the end of the file in the index.
  assert.equal(stageAll(head, longer), longer);
  // …and the other way it staged "a\r\nb\r\n\n".
  assert.equal(stageAll(longer, head), head);
  assert.equal(stageAll(head, "a\r\nb\r\n\r\n\r\n"), "a\r\nb\r\n\r\n\r\n");
  // One change: the new line 3 (0-based 2) inserted after b. Not lines 3–4,
  // which would also mark the empty last line that nobody touched.
  assert.deepEqual(computeHunks(head, longer).map((h) => [h.original, h.modified]), [
    [{ start: 2, end: 1 }, { start: 2, end: 2 }],
  ]);
  // The gutter's three-way read of the same file: one block, on the new line.
  const blocks = computeChangeBlocks(head, head, longer);
  assert.deepEqual(blocks.map((b) => [b.working, b.state]), [[{ start: 2, end: 2 }, "unstaged"]]);
  await settle();
  assert.deepEqual(asserted, []);
});

test("a trailing blank line deleted (files.trimFinalNewlines on save) stays on a line the working text has", async () => {
  // The first fix put these one past the end — "line 4 of a 3-line file" —
  // where no selection, cursor or gutter mark can reach them.
  const cases: Array<[string, string]> = [
    ["def f():\n    return 1\n\n", "def f():\n    return 1\n"],
    ["  x\n\n", "  x\n"],
    ["a\n  b\n\n", "a\n  b\n"],
    // The same edits in the shape that still takes the guarded path.
    ["def f():\n  \n    return 1\n\n", "def f():\n  \n    return 1\n"],
    ["def f():\r\n\r\n    return 1\r\n\r\n", "def f():\r\n\r\n    return 1\r\n"],
    ["a\n  b\n\n\n", "a\n  b\n \n"],
  ];
  for (const [head, working] of cases) {
    const label = JSON.stringify([head, working]);
    const last = splitLines(working).length - 1;
    const hunks = computeHunks(head, working);
    assert.ok(hunks.length > 0, label);
    for (const h of hunks) {
      assert.ok(h.modified.start <= last, `${label}: anchored on working line ${h.modified.start} of 0..${last}`);
    }
    assert.equal(stageAll(head, working), working, label);
    const blocks = computeChangeBlocks(head, head, working);
    assert.ok(blocks.every((b) => b.working.start <= last), label);
  }
  // Outside the guarded shape the answer IS vscode-diff's: the first blank line goes.
  assert.deepEqual(
    computeHunks("def f():\n    return 1\n\n", "def f():\n    return 1\n").map((h) => [h.original, h.modified]),
    [[{ start: 2, end: 2 }, { start: 2, end: 1 }]],
  );
});

test("a diff the defect cannot reach is exactly vscode-diff's own — every pair of small texts, and ignoring whitespace", async () => {
  // "  a" too: an indented line is what made the first fix's end-of-text line
  // re-place a deleted trailing blank line where vscode-diff had it right.
  const all = texts(["", " ", "\r", "a", "  a"], 3);
  let compared = 0;
  for (const x of all) {
    for (const y of all) {
      const from = splitLines(x);
      const to = splitLines(y);
      const raw = (ignoreTrimWhitespace: boolean) =>
        shape(linesDiffComputers.getDefault().computeDiff(from, to, { ...EXACT, ignoreTrimWhitespace }).changes);
      const ours = (ignoreTrimWhitespace: boolean) =>
        shape(computeLineChanges(from, to, { ...EXACT, ignoreTrimWhitespace }).changes);
      // Ignoring whitespace never needs the guard, at-risk shape or not.
      assert.deepEqual(ours(true), raw(true), JSON.stringify([x, y, "trim"]));
      if (!endIsAtRisk(from, to)) {
        assert.deepEqual(ours(false), raw(false), JSON.stringify([x, y]));
        compared++;
      }
    }
  }
  assert.ok(compared > 15000, `${compared} pairs compared`);
  // …and vscode-diff never failed on one of them: the guard covers every case
  // it fails on. (An uncaught "Assertion Failed" would also fail this file.)
  await settle();
  assert.deepEqual(asserted, []);
});

test("in the guarded shape: every change stages and unstages exactly, nothing sits past the end, nothing asserts", async () => {
  const all = texts(["", " ", "\r", "a"], 3);
  const wrong: string[] = [];
  let guarded = 0;
  for (const original of all) {
    for (const modified of all) {
      const from = splitLines(original);
      const to = splitLines(modified);
      if (endIsAtRisk(from, to)) guarded++;
      if (stageAll(original, modified) !== modified) wrong.push(`all: ${JSON.stringify([original, modified])}`);
      if (applySelectedChanges(original, modified, []) !== original) {
        wrong.push(`none: ${JSON.stringify([original, modified])}`);
      }
      // Two texts that end in a newline: no change may sit after the last line.
      if (original.endsWith("\n") && modified.endsWith("\n")) {
        for (const c of computeLineChanges(from, to, EXACT).changes) {
          const pastO = c.original.startLineNumber === c.original.endLineNumberExclusive && c.original.startLineNumber > from.length;
          const pastM = c.modified.startLineNumber === c.modified.endLineNumberExclusive && c.modified.startLineNumber > to.length;
          if (pastO || pastM) wrong.push(`past the end: ${JSON.stringify([original, modified])}`);
        }
      }
    }
  }
  assert.ok(guarded > 1000, `${guarded} guarded pairs`);
  assert.deepEqual(wrong.slice(0, 5), [], `${wrong.length} of ${all.length ** 2} pairs`);
  await settle();
  assert.deepEqual(asserted, [], `${asserted.length} soft assertions`);
});

test("the changes add up: equal lines before the first, after the last, and between each", () => {
  const cases: Array<[string, string]> = [
    ["x\n", "x\n \n"],
    ["x\n \n", "x\n"],
    ["x\n", "x\n\t\n"],
    ["a\r\nb\r\n", "a\r\nb\r\n\r\n"],
    ["q\n\n", "q\n \n\n"],
    ["\n", "\n \na\n"],
  ];
  for (const [a, b] of cases) {
    const from = splitLines(a);
    const to = splitLines(b);
    const { changes } = computeLineChanges(from, to, EXACT);
    const label = JSON.stringify([a, b]);
    assert.ok(changes.length > 0, label);
    assert.equal(changes[0].original.startLineNumber, changes[0].modified.startLineNumber, label);
    const last = changes[changes.length - 1];
    assert.equal(
      from.length + 1 - last.original.endLineNumberExclusive,
      to.length + 1 - last.modified.endLineNumberExclusive,
      label,
    );
    for (let i = 1; i < changes.length; i++) {
      assert.equal(
        changes[i].original.startLineNumber - changes[i - 1].original.endLineNumberExclusive,
        changes[i].modified.startLineNumber - changes[i - 1].modified.endLineNumberExclusive,
        label,
      );
    }
  }
});

test("character ranges stay inside the text, though the diff ran on one line more", () => {
  // Every pair of small texts, so the changes whose ranges end on the added
  // line — "x\n" → "x\n\n " ends its insertion there — are among them.
  const all = texts(["", " ", "\r", "a"], 3);
  const inside = (lines: string[], line: number, column: number): boolean =>
    line >= 1 && line <= lines.length && column >= 1 && column <= lines[line - 1].length + 1;
  const outside: string[] = [];
  for (const a of all) {
    for (const b of all) {
      const base = splitLines(a);
      const side = splitLines(b);
      for (const c of diffSide(base, side, "right")) {
        if (c.baseSpan.endExclusive > base.length + 1 || c.sideSpan.endExclusive > side.length + 1) {
          outside.push(`span ${JSON.stringify([a, b])}`);
        }
        for (const r of c.innerBase) {
          if (!inside(base, r.startLine, r.startColumn) || !inside(base, r.endLine, r.endColumn)) outside.push(JSON.stringify([a, b, r]));
        }
        for (const r of c.innerSide) {
          if (!inside(side, r.startLine, r.startColumn) || !inside(side, r.endLine, r.endColumn)) outside.push(JSON.stringify([a, b, r]));
        }
      }
    }
  }
  assert.deepEqual(outside.slice(0, 5), [], `${outside.length} out of the text`);
});
