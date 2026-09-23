// The merge matrix cannot silently shrink.
//
//   npx tsx --test scripts/merge-e2e/matrix.test.ts
//
// 1. Builds the whole matrix with fixtures.sh (every operation × every conflict
//    style), regenerates the oracle from it with the engine and git, and holds
//    it to cases.ts: every operation present, every content case conflicted in
//    every operation with the shape both hosts must give it, nothing conflicted
//    that no case claims, and the invariants later checks lean on.
// 2. Requires the committed oracle.json to be exactly what that build produced,
//    so the expectations every later check reads cannot go stale either.
// 3. Proves the checker itself catches a shrunken matrix — a check that cannot
//    fail is not one (memory: adversarial-resweep).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildMatrix, buildOracle, ORACLE_PATH, serializeOracle, type Oracle } from "./oracle";
import { matrixProblems } from "./completeness";
import { CONTENT_CASES, MATRIX_FILE_COUNT, OPERATIONS, STYLES } from "./cases";

const committed = (): Oracle => JSON.parse(readFileSync(ORACLE_PATH, "utf8")) as Oracle;

// What was asked for, pinned by name: removing one is an edit to THIS list,
// never a quiet deletion from cases.ts and fixtures.sh together.
const REQUIRED_OPERATIONS = [
  "merge",
  "rebase",
  "rebase-apply",
  "rebase-merges",
  "cherry-pick",
  "cherry-pick-range",
  "revert",
  "am",
  "stash",
  "issue12",
  "issue12-exact",
];
const REQUIRED_CASES = [
  // the owner's merge-conflict-tests
  "uu-one-line",
  "uu-dict-value",
  "uu-two-regions",
  "uu-multiline-automerge",
  "ud-deleted-by-stage3",
  "du-deleted-by-stage2",
  "aa-added-both",
  // Merge Studio's stress and load fixtures
  "stress",
  "stress-config",
  "load-service",
  "load-list",
  "load-config",
  // the rest
  "whitespace-only",
  "resolvable",
  "crlf",
  "eol-mismatch",
  "no-trailing-newline",
  "empty-base-added-both",
  "empty-base-file",
  "binary",
  "too-large",
  "rename-one-side",
  "rename-rename",
  "file-directory",
  "path-spaces-unicode",
  "symlink",
  "submodule",
  "reporter-line3",
];

test("the matrix definition still has everything that was asked for", () => {
  assert.deepEqual(
    OPERATIONS.map((o) => o.id),
    REQUIRED_OPERATIONS,
  );
  assert.deepEqual([...STYLES], ["merge", "diff3", "zdiff3"]);
  assert.deepEqual(
    CONTENT_CASES.map((c) => c.id),
    REQUIRED_CASES,
  );
  assert.equal(MATRIX_FILE_COUNT, 30, "28 cases; rename-rename conflicts three paths");
  // Every shape the merge UI distinguishes is reached by some case.
  const shapes = new Set(CONTENT_CASES.flatMap((c) => c.files.map((f) => f.shape)));
  assert.deepEqual(
    [...shapes].sort(),
    ["added-both", "added-one-side", "binary", "both-deleted", "modify-delete", "submodule", "symlink", "text", "too-large"],
  );
});

test("the committed oracle covers every operation × style × content case", () => {
  const o = committed();
  assert.deepEqual(matrixProblems(o), []);
  assert.equal(Object.keys(o.scenarios).length, OPERATIONS.length * STYLES.length);
  const matrixOps = OPERATIONS.filter((d) => d.matrix);
  let files = 0;
  for (const d of matrixOps) for (const s of STYLES) files += Object.keys(o.scenarios[`${d.id}.${s}`].files).length;
  assert.equal(files, matrixOps.length * STYLES.length * MATRIX_FILE_COUNT);
});

test("the completeness check fails on a shrunken or drifted matrix", () => {
  const cases: Array<[string, (o: Oracle) => void, RegExp]> = [
    ["a scenario dropped", (o) => delete o.scenarios["am.zdiff3"], /am\.zdiff3 is missing/],
    [
      "a content case's file no longer conflicted",
      (o) => delete o.scenarios["stash.diff3"].files["vendor/lib"],
      /stash\.diff3: case submodule: vendor\/lib is not conflicted/,
    ],
    [
      "a file no case claims",
      (o) => {
        o.scenarios["merge.merge"].files["stray.txt"] = { ...o.scenarios["merge.merge"].files["f.txt"], case: "UNKNOWN" };
      },
      /merge\.merge: stray\.txt: conflicted, but no content case claims it/,
    ],
    [
      "a shape the case does not allow",
      (o) => (o.scenarios["revert.merge"].files["data/huge.log"].shape = "text"),
      /revert\.merge: case too-large: data\/huge\.log is "text"/,
    ],
    [
      "the desktop disagreeing with the extensions",
      (o) => (o.scenarios["cherry-pick.diff3"].files["assets/logo.bin"].desktop.shape = "text"),
      /the desktop calls it "text"/,
    ],
    [
      "Yours on the wrong stage",
      (o) => (o.scenarios["rebase.merge"].yours.stage = 2),
      /rebase\.merge: Yours is stage 2, expected 3/,
    ],
    [
      "the stop moved",
      (o) => (o.scenarios["rebase-apply.diff3"].step = { n: 3, m: 3, unit: "commit" }),
      /rebase-apply\.diff3: stopped at/,
    ],
    [
      "a case losing what makes it the case",
      (o) => (o.scenarios["issue12.zdiff3"].files["stress/userService.js"].engine!.blocks = "cccc"),
      /case stress: stress\/userService\.js: no "s" block/,
    ],
  ];
  for (const [what, mutate, expected] of cases) {
    const o = committed();
    mutate(o);
    const problems = matrixProblems(o);
    assert.ok(
      problems.some((p) => expected.test(p)),
      `${what}: expected a problem matching ${expected}, got ${JSON.stringify(problems.slice(0, 5))}`,
    );
  }
});

test(
  "fixtures.sh builds the whole matrix, and oracle.json is exactly what it produces",
  { timeout: 20 * 60_000 },
  async () => {
    const target = mkdtempSync(join(tmpdir(), "gs-merge-matrix-test-"));
    try {
      buildMatrix(target);
      const oracle = await buildOracle(target);
      assert.deepEqual(matrixProblems(oracle), [], "the freshly built matrix is complete");
      const fresh = serializeOracle(oracle);
      const saved = readFileSync(ORACLE_PATH, "utf8");
      if (fresh !== saved) {
        const a = saved.split("\n");
        const b = fresh.split("\n");
        const i = a.findIndex((line, k) => line !== b[k]);
        assert.fail(
          `oracle.json is stale — regenerate with: npx tsx scripts/merge-e2e/oracle.ts\n` +
            `first difference at line ${i + 1}:\n  committed: ${(a[i] ?? "").slice(0, 300)}\n  built:     ${(b[i] ?? "").slice(0, 300)}`,
        );
      }
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  },
);
