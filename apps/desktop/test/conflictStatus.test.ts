import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePorcelainStatus } from "../src/main/gitBridge";

/**
 * Porcelain v1's two status columns normally mean index-half and worktree-half.
 * For an UNMERGED path they mean something else entirely: the two SIDES of the
 * merge. The parser read them as halves regardless, and every downstream symptom
 * followed from that one mistake —
 *
 *   - one conflicted file produced TWO rows, so 7 conflicts listed as 13;
 *   - the phantom "staged" row carried an Unstage button, which destroys the
 *     merge stages and loses both sides of the conflict;
 *   - `UD` rendered a `D` badge on a file plainly sitting on disk;
 *   - nothing downstream could tell a conflict from an edit, because nothing in
 *     the model said which was which.
 *
 * The seven unmerged codes are git's own (git-status(1), "Short Format"):
 * DD, AU, UD, UA, DU, AA, UU.
 */
test("every unmerged code is one row, marked as a conflict", () => {
  const z = (...entries: string[]): string => entries.join("\0") + "\0";
  const cases: Array<[string, string]> = [
    ["DD", "both deleted"],
    ["AU", "added by us"],
    ["UD", "deleted by them"],
    ["UA", "added by them"],
    ["DU", "deleted by us"],
    ["AA", "both added"],
    ["UU", "both modified"],
  ];
  for (const [code, what] of cases) {
    const rows = parsePorcelainStatus(z(`${code} app/thing.py`));
    assert.equal(rows.length, 1, `${code} (${what}) is ONE row, not two`);
    assert.equal(rows[0].path, "app/thing.py");
    assert.equal(rows[0].conflicted, true, `${code} is marked conflicted`);
    assert.equal(rows[0].conflictKind, code, `${code} keeps its kind`);
    assert.equal(
      rows[0].staged,
      false,
      `${code} is never reported as staged — the Unstage button that came with ` +
        `that claim destroys the merge stages`,
    );
    assert.equal(rows[0].status, "U", `${code} reports U, not a letter that contradicts git`);
  }
});

/** The ordinary two-half reading must survive, or this fix breaks normal work. */
test("ordinary index/worktree halves are still read as halves", () => {
  const z = (...entries: string[]): string => entries.join("\0") + "\0";

  // Staged edit plus a NEWER unstaged edit to the same file: two real rows.
  const mm = parsePorcelainStatus(z("MM src/a.ts"));
  assert.equal(mm.length, 2, "MM is genuinely two halves");
  assert.deepEqual(
    mm.map((f) => f.staged),
    [true, false],
  );
  assert.ok(!mm.some((f) => f.conflicted), "and neither half is a conflict");

  // Untracked: one unstaged row. Discard DELETES these, which is why the
  // confirmation has to be able to tell them apart.
  const untracked = parsePorcelainStatus(z("?? new.txt"));
  assert.equal(untracked.length, 1);
  assert.equal(untracked[0].status, "?");
  assert.equal(untracked[0].staged, false);
  assert.ok(!untracked[0].conflicted);

  // A plain staged add, and a plain unstaged modification.
  assert.deepEqual(
    parsePorcelainStatus(z("A  added.ts")).map((f) => [f.status, f.staged, !!f.conflicted]),
    [["A", true, false]],
  );
  assert.deepEqual(
    parsePorcelainStatus(z(" M edited.ts")).map((f) => [f.status, f.staged, !!f.conflicted]),
    [["M", false, false]],
  );
});

/**
 * The real matrix, verbatim from `git status --porcelain=v1` after merging the
 * two branches of the merge-conflict-tests repo. Seven paths, seven rows.
 */
test("the real conflict matrix maps one row per path", () => {
  const raw =
    [
      "UU README.md",
      "UU app/calculator.py",
      "UD app/greeting.py",
      "DU app/legacy.py",
      "AA app/new_feature.py",
      "UU app/settings.py",
      "UU app/version.py",
    ].join("\0") + "\0";
  const rows = parsePorcelainStatus(raw);
  assert.equal(rows.length, 7, "seven conflicts are seven rows");
  assert.equal(new Set(rows.map((f) => f.path)).size, 7, "no path appears twice");
  assert.ok(
    rows.every((f) => f.conflicted),
    "and every one of them is marked as a conflict",
  );
  assert.deepEqual(
    rows.filter((f) => f.conflictKind === "UD" || f.conflictKind === "DU").map((f) => f.path),
    ["app/greeting.py", "app/legacy.py"],
    "modify/delete conflicts are identifiable — they carry no markers to detect, " +
      "so 'Stage all' has to hold them back on kind alone",
  );
});
