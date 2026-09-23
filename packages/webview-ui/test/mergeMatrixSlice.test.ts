import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findHeadlessChrome } from "../../../scripts/merge-e2e/cdp";
import { alignmentProblems, measureAlignment, type FileResult } from "../../../scripts/merge-e2e/alignment";
import { buildMatrix, ORACLE_PATH, type Oracle } from "../../../scripts/merge-e2e/oracle";

/**
 * A slice of the conflict matrix, measured on every run of this package's
 * tests — the whole matrix (every operation × style × case, both hosts, three
 * scales) is scripts/merge-e2e/alignment.test.ts, and takes an hour.
 *
 * Every content case once, the three conflict styles taking turns, each in a
 * different operation (a merge in merge style, a rebase in diff3, a stash pop
 * in zdiff3); and the #12 reporter's own file. In the real extension webview,
 * at 1.5x — a fractional scale, where the gutter's border showed through every
 * band — and the reporter's file at 2x too. Each file is walked as it opens,
 * half handled, and resolved; every band edge is compared in pane, ribbon and
 * result, the seams' pixels are read, and the result must look different once
 * one side of a conflict is in. (scripts/merge-e2e/alignment.ts says how.)
 *
 * The browser is chrome-headless-shell (GS_CHROME or Playwright's cache),
 * never the desktop Chrome; a machine with none skips this, and says so.
 */

let chrome: string | undefined;
try {
  chrome = findHeadlessChrome();
} catch {
  chrome = undefined;
}
const skip = !chrome && "no chrome-headless-shell on this machine (set GS_CHROME)";

/** One operation per conflict style. */
const SLICE = ["merge.merge", "rebase.diff3", "stash.zdiff3"] as const;

/**
 * A tall window: the 1201-change load file is walked a view at a time, three
 * times over, and a view twice as tall is half the views (the geometry is the
 * same at any height).
 */
const TALL = 4000;

test("a slice of the conflict matrix — every content case once, one operation per style — lines up on the device pixel, seams and all", { skip, timeout: 20 * 60_000 }, async (t) => {
  const oracle = JSON.parse(readFileSync(ORACLE_PATH, "utf8")) as Oracle;
  const target = mkdtempSync(join(tmpdir(), "gs-merge-slice-"));
  try {
    buildMatrix(target, { ops: ["merge", "rebase", "stash", "issue12-exact"], styles: ["merge", "diff3", "zdiff3"] });
    const results: FileResult[] = [];
    const cases = SLICE.map((s) => Object.keys(oracle.scenarios[s].files).sort());
    assert.ok(cases.every((c) => c.length === cases[0].length && c.length >= 30), `every scenario of the slice carries every case (${cases.map((c) => c.length)})`);
    for (const [i, scenario] of SLICE.entries()) {
      // Case k goes to scenario k mod 3: each case measured once.
      const files = cases[i].filter((_, k) => k % SLICE.length === i);
      results.push(...(await measureAlignment({ target, scenarios: [scenario], files, hosts: ["ext"], dprs: [1.5], height: TALL, log: (l) => t.diagnostic(l) })));
    }
    results.push(...(await measureAlignment({ target, scenarios: ["issue12-exact.diff3"], hosts: ["ext"], dprs: [1.5, 2], log: (l) => t.diagnostic(l) })));

    // Coverage: every case, and every block side the oracle expects of it.
    const measured = new Set(results.map((r) => r.file.replace(/~.*$/, "~")));
    const wanted = new Set(cases[0].map((f) => f.replace(/~.*$/, "~")));
    assert.deepEqual([...wanted].filter((f) => !measured.has(f)), [], "every content case was measured once");
    const sides = results.reduce((n, r) => n + r.expected.length, 0);
    const pixels = results.reduce((n, r) => n + r.pixels, 0);
    t.diagnostic(`${results.length} files, ${sides} block sides, ${pixels} seam rows read`);
    assert.ok(sides > 1000 && pixels > 10_000, `the slice measured its thousands (${sides} block sides, ${pixels} seam rows)`);

    const problems = alignmentProblems(results);
    assert.deepEqual(problems.slice(0, 40), [], `${problems.length} problems:\n${problems.slice(0, 40).join("\n")}`);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
});
