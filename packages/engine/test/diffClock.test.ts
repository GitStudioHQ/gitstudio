// How often a diff reads the clock (#115).
//
// vscode-diff checks its time budget with Date.now() in its innermost loops —
// for texts under 1,700 lines together, once per cell of an n×m table. On a
// machine whose clock read is a system call (Linux on the hpet clocksource,
// ~1.2 µs) that alone blocked the extension host ~0.8 s every time the editor
// gutter re-diffed an 800-line file. lineDiff.ts makes 256 of those checks
// share one read; these pin that, and that a budget that runs out still does.

import { test } from "node:test";
import assert from "node:assert/strict";
import { computeChangeBlocks } from "../src/staging/blockStaging";
import { computeLineChanges, splitLines } from "../src/lineDiff";

function source(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    out.push(i % 4 === 0 ? `function f${i}(a, b) {` : i % 4 === 3 ? "}" : `  const v${i} = a * ${i} + b;`);
  }
  return out.join("\n") + "\n";
}

function countingClock<T>(run: () => T, step = 0): { result: T; reads: number } {
  const real = Date.now;
  let reads = 0;
  let fake = real();
  Date.now = () => {
    reads++;
    fake += step;
    return step ? fake : real();
  };
  try {
    return { result: run(), reads };
  } finally {
    Date.now = real;
  }
}

test("re-diffing an 800-line file after a keystroke reads the clock thousands of times, not 640,000", () => {
  const head = source(800);
  const lines = splitLines(head);
  lines[400] += " // typed";
  const working = lines.join("\n");
  const { result, reads } = countingClock(() => computeChangeBlocks(head, head, working));
  assert.deepEqual(
    result.map((b) => [b.working.start, b.working.end, b.state]),
    [[400, 400, "unstaged"]],
  );
  // One read per cell was 643,765 for this edit.
  assert.ok(reads < 10_000, `${reads} clock reads`);
});

test("a diff that runs out of time still says so", () => {
  const a = splitLines(source(600));
  const b = a.map((l, i) => (i % 3 === 0 ? `${l} // changed` : l));
  // Every read of the clock is ten seconds later: the 5 s budget is spent at
  // the first look after the start.
  const { result, reads } = countingClock(
    () => computeLineChanges(a, b, { ignoreTrimWhitespace: false, maxComputationTimeMs: 5000, computeMoves: false }),
    10_000,
  );
  assert.equal(result.hitTimeout, true);
  assert.ok(reads >= 2);
});
