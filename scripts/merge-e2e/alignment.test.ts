// Every band edge in the merge view sits on ONE device row across the side
// pane, the ribbon and the result — for every block of every file of every
// matrix scenario, in the extension's webview and the desktop app, at 1x and
// 2x. And the measurement is proven to fail on the build the owner saw.
//
//   GS_CHROME=…/chrome-headless-shell npx tsx --test scripts/merge-e2e/alignment.test.ts
//
// Narrow a run (the full one walks every distinct file in both hosts at both
// scales): GS_ALIGN_HOSTS=ext GS_ALIGN_DPR=2 GS_ALIGN_SCENARIOS=merge.diff3,…
// GS_ALIGN_TARGET=<a built matrix> reuses one instead of building it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { alignmentProblems, expectedSides, measureAlignment, type FileResult } from "./alignment";
import { ORACLE_PATH, type Oracle } from "./oracle";
import type { Host } from "./render";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "../..");
const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

/** The commit whose merge view the owner saw the offset dashed lines in. */
const BEFORE = "562966a";

test("the oracle's block letters give every block side a ribbon must be drawn for", () => {
  assert.deepEqual(expectedSides("cyts"), ["0:left", "0:right", "1:left", "2:right", "3:left", "3:right"]);
});

test("every band edge of every block of every matrix scenario meets its pane on the same device row", { timeout: 4 * 60 * 60_000 }, async (t) => {
  const oracle = JSON.parse(readFileSync(ORACLE_PATH, "utf8")) as Oracle;
  const hosts = (list(process.env.GS_ALIGN_HOSTS) ?? ["ext", "desktop"]) as Host[];
  const dprs = (list(process.env.GS_ALIGN_DPR) ?? ["1", "2"]).map(Number);
  const scenarios = list(process.env.GS_ALIGN_SCENARIOS) ?? Object.keys(oracle.scenarios);
  const results: FileResult[] = await measureAlignment({
    target: process.env.GS_ALIGN_TARGET,
    hosts,
    dprs,
    scenarios,
    log: (line) => t.diagnostic(line),
  });

  // Coverage first: a clean run over too little proves nothing.
  const wanted = scenarios.flatMap((s) => Object.keys(oracle.scenarios[s].files).map((f) => `${s} ${f}`));
  for (const host of hosts) {
    for (const dpr of dprs) {
      const got = new Set(results.filter((r) => r.host === host && r.dpr === dpr).map((r) => `${r.scenario} ${r.file}`));
      assert.deepEqual(wanted.filter((w) => !got.has(w)), [], `${host} @${dpr}x measured every file of every scenario`);
    }
  }
  const sides = results.reduce((n, r) => n + r.expected.length, 0);
  const edges = results.reduce((n, r) => n + r.checked, 0);
  t.diagnostic(`${results.length} file renders (${new Set(results.map((r) => r.key)).size} distinct), ${sides} block sides, ${edges} edge comparisons`);
  assert.ok(sides > 10_000, `the matrix has its thousands of block sides (${sides})`);

  const problems = alignmentProblems(results);
  assert.deepEqual(problems.slice(0, 50), [], `${problems.length} problems:\n${problems.slice(0, 50).join("\n")}`);
});

test(`the measurement FAILS on ${BEFORE}'s merge view — the owner's offset dashed lines`, { timeout: 10 * 60_000 }, () => {
  // That build's webview source, beside a node_modules link so it bundles.
  const dir = mkdtempSync(join(tmpdir(), "gs-merge-align-before-"));
  try {
    const tar = join(dir, "src.tar");
    execFileSync("git", ["-C", REPO, "archive", BEFORE, "packages/webview-ui/src", "-o", tar]);
    execFileSync("tar", ["-xf", tar, "-C", dir]);
    symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
    const run = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        join(HERE, "alignment.ts"),
        "--scenarios",
        "issue12-exact.diff3",
        "--hosts",
        "ext",
        "--dpr",
        "2",
        ...(process.env.GS_ALIGN_TARGET ? ["--target", process.env.GS_ALIGN_TARGET] : []),
      ],
      {
        cwd: REPO,
        encoding: "utf8",
        env: { ...process.env, GS_MERGE_WEBVIEW_ENTRY: join(dir, "packages/webview-ui/src/main.ts") },
      },
    );
    const out = `${run.stdout}\n${run.stderr}`;
    assert.equal(run.status, 1, `the old build must fail the check:\n${out.slice(-3000)}`);
    // What the owner saw: after Accept Yours, the dashed bottom edge in the
    // gutter sits one CSS pixel (two device rows at 2x) BELOW the one in the
    // pane — the gutter's line starts on the row where the pane's ends.
    const offset = [...out.matchAll(/stroke at yours\|gutter: \[half\] the pane draws no edge of this band on these rows — ribbon rows (\d+)–(\d+), pane ([\d– ]+)/g)]
      .map((m) => {
        const [top, bottom] = [Number(m[1]), Number(m[2])];
        const pane = m[3].trim().split(" ").map((p) => p.split("–").map(Number));
        return pane.some(([pt, pb]) => pb === top && pb - pt === bottom - top);
      });
    assert.ok(offset.includes(true), `the report names the edge drawn a line-width below the pane's:\n${out.slice(-3000)}`);
    // …and its ribbons start off the device-pixel grid, beside the panes.
    assert.match(out, /off the device-pixel grid horizontally/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
