// The merge matrix's DEFINITION: which operations, which conflict styles, and
// which content cases every operation's conflict set must carry. fixtures.sh
// builds exactly this; matrix.test.ts holds the built matrix (and oracle.json)
// to it in both directions — a case with no conflicted file fails, and so does
// a conflicted file no case claims — so the matrix cannot silently shrink or
// drift.
//
// Expectations here are stated in STAGE terms, because fixtures.sh keeps one
// convention in every operation: stage 1 = BASE, stage 2 = X, stage 3 = Y.
// Which of those is "Yours" is the operation's (YOURS_STAGE); the oracle
// records it, from git and the engine.

import type { ConflictShape, OperationKind } from "@gitstudio/host-bridge/conflictsProtocol";

export const STYLES = ["merge", "diff3", "zdiff3"] as const;
export type ConflictStyle = (typeof STYLES)[number];

export interface OperationDef {
  /** The scenario id prefix and fixtures.sh's builder. */
  id: string;
  /** What OperationProvider.view() must call it. */
  kind: OperationKind;
  backend?: "merge" | "apply";
  /** Where it must be stopped. */
  step?: { n: number; m: number; unit: "commit" | "patch" | "step" };
  queued?: number;
  /** Carries the full content matrix (every case below). */
  matrix: boolean;
  /** An exact reproduction instead: exactly these conflicted paths. */
  files?: readonly string[];
  what: string;
}

export const OPERATIONS: readonly OperationDef[] = [
  { id: "merge", kind: "merge", matrix: true, what: "on main, git merge feature" },
  {
    id: "rebase",
    kind: "rebase",
    backend: "merge",
    step: { n: 2, m: 3, unit: "commit" },
    matrix: true,
    what: "on test (3 commits), git rebase master — the merge backend, stopped on commit 2 of 3",
  },
  {
    id: "rebase-apply",
    kind: "rebase",
    backend: "apply",
    step: { n: 2, m: 3, unit: "commit" },
    matrix: true,
    what: "the same, git rebase --apply master",
  },
  {
    id: "rebase-merges",
    kind: "rebase-merge-step",
    backend: "merge",
    matrix: true,
    what: "git rebase -i -r main, stopped re-creating the merge of side into feat",
  },
  { id: "cherry-pick", kind: "cherry-pick", matrix: true, what: "on main, git cherry-pick feature" },
  {
    id: "cherry-pick-range",
    kind: "cherry-pick",
    queued: 1,
    matrix: true,
    what: "on main, git cherry-pick main..feature — the 2nd of 3 stops, the 3rd is queued",
  },
  {
    id: "revert",
    kind: "revert",
    matrix: true,
    what: "on main, git revert HEAD~1 (the commit that reset every case to BASE)",
  },
  {
    id: "am",
    kind: "am",
    step: { n: 1, m: 1, unit: "patch" },
    matrix: true,
    what: "on main, git am -3 of feature's commit",
  },
  { id: "stash", kind: "stash", matrix: true, what: "Y stashed, X committed, git stash pop" },
  {
    id: "issue12",
    kind: "rebase",
    backend: "merge",
    step: { n: 1, m: 1, unit: "commit" },
    matrix: true,
    what: "the issue-#12 reporter's steps (master and test each change, git checkout test; git rebase master), every case in the one commit",
  },
  {
    id: "issue12-exact",
    kind: "rebase",
    backend: "merge",
    step: { n: 1, m: 1, unit: "commit" },
    matrix: false,
    files: ["f.txt"],
    what: "the reporter's EXACT repository: f.txt, line 3 changed on master and on test, nothing else",
  },
];

/** A conflicted path a case must produce, and what git must make of it. */
export interface CaseFile {
  /** The repository path, or — for a path git names after the operation (file/directory) — a pattern. */
  path: string;
  pattern?: RegExp;
  /** Every one of these is acceptable (git itself differs by operation for a file/directory conflict). */
  xy: readonly string[];
  shape: ConflictShape;
}

/**
 * What the ENGINE must make of a case's (first) file, whatever the operation —
 * the property that makes the case the case. Checked against oracle.json.
 */
export interface EngineExpect {
  /** Exactly this many conflicts. */
  conflicts?: number;
  minBlocks?: number;
  /** At least one block of each of these letters (oracle.ts LEGEND). */
  has?: string;
  /** The last block's letter (a conflict at end of file: "c"). */
  last?: string;
  /** Yours and Theirs disagree about line endings. */
  eolMismatch?: boolean;
  eol?: "LF" | "CRLF";
  /** With whitespace ignored, at least one block is the same change up to whitespace. */
  sameIgnoringWhitespace?: boolean;
}

export interface ContentCase {
  id: string;
  source: "merge-conflict-tests" | "merge-studio stress" | "merge-studio load" | "matrix";
  what: string;
  files: readonly CaseFile[];
  engine?: EngineExpect;
}

const uu = (path: string, shape: ConflictShape = "text"): CaseFile => ({ path, xy: ["UU"], shape });

export const CONTENT_CASES: readonly ContentCase[] = [
  // The owner's merge-conflict-tests (HOW-TO-TEST.md), main = X, feature = Y.
  {
    id: "uu-one-line",
    source: "merge-conflict-tests",
    what: "both modified, one line",
    files: [uu("app/version.py")],
    engine: { conflicts: 1 },
  },
  {
    id: "uu-dict-value",
    source: "merge-conflict-tests",
    what: "both modified, one value in a dict",
    files: [uu("app/settings.py")],
  },
  {
    id: "uu-two-regions",
    source: "merge-conflict-tests",
    what: "both modified, two separate regions",
    files: [uu("app/calculator.py")],
    engine: { conflicts: 2 },
  },
  {
    id: "uu-multiline-automerge",
    source: "merge-conflict-tests",
    what: "a multi-line hunk plus an auto-mergeable edit",
    files: [uu("README.md")],
  },
  {
    id: "ud-deleted-by-stage3",
    source: "merge-conflict-tests",
    what: "X edits, Y deletes (UD)",
    files: [{ path: "app/greeting.py", xy: ["UD"], shape: "modify-delete" }],
  },
  {
    id: "du-deleted-by-stage2",
    source: "merge-conflict-tests",
    what: "X deletes, Y edits (DU)",
    files: [{ path: "app/legacy.py", xy: ["DU"], shape: "modify-delete" }],
  },
  {
    id: "aa-added-both",
    source: "merge-conflict-tests",
    what: "added on both sides with different bodies (AA)",
    files: [{ path: "app/new_feature.py", xy: ["AA"], shape: "added-both" }],
  },
  // Merge Studio's stress fixture, master = X, feature = Y.
  {
    id: "stress",
    source: "merge-studio stress",
    what: "unequal-height conflicts, delete-vs-modify, an overlapping insertion, one-line values, an identical both-side edit, one-sided insert/modify/delete, a conflict at end of file",
    files: [uu("stress/userService.js")],
    engine: { has: "cryts", last: "c" },
  },
  {
    id: "stress-config",
    source: "merge-studio stress",
    what: "a second conflicted file (JSON)",
    files: [uu("stress/config.json")],
  },
  // Merge Studio's load fixture (1200 blocks), master = X, feature = Y.
  {
    id: "load-service",
    source: "merge-studio load",
    what: "a large file: 1200 blocks cycling six kinds",
    files: [uu("load/bigService.js")],
    engine: { minBlocks: 1200, has: "cyts" },
  },
  {
    id: "load-list",
    source: "merge-studio load",
    what: "a tall file of one-line conflicts",
    files: [uu("load/giantList.js")],
  },
  {
    id: "load-config",
    source: "merge-studio load",
    what: "the load fixture's small JSON",
    files: [uu("load/config.json")],
  },
  // Everything else the merge UI supports.
  {
    id: "whitespace-only",
    source: "matrix",
    what: "X's change is whitespace only; and an edit both made, Y's with trailing spaces (the same up to whitespace)",
    files: [uu("cases/whitespace.txt")],
    engine: { sameIgnoringWhitespace: true },
  },
  {
    id: "resolvable",
    source: "matrix",
    what: "adjacent, non-overlapping edits: a conflict to git, resolvable by the wand",
    files: [uu("cases/adjacent.txt")],
    engine: { has: "r" },
  },
  {
    id: "crlf",
    source: "matrix",
    what: "CRLF line endings on every side",
    files: [uu("cases/windows.txt")],
    engine: { eol: "CRLF" },
  },
  {
    id: "eol-mismatch",
    source: "matrix",
    what: "X converts the file to CRLF, Y keeps LF: every line differs to git",
    files: [uu("cases/eol-mixed.txt")],
    engine: { eolMismatch: true },
  },
  {
    id: "no-trailing-newline",
    source: "matrix",
    what: "no newline at end of file, the conflict on the last line",
    files: [uu("cases/no-eol.txt")],
    engine: { conflicts: 1 },
  },
  {
    id: "empty-base-added-both",
    source: "matrix",
    what: "an empty base: added on both sides, no stage 1",
    files: [{ path: "cases/added-both.txt", xy: ["AA"], shape: "added-both" }],
    engine: { conflicts: 1 },
  },
  {
    id: "empty-base-file",
    source: "matrix",
    what: "an empty base: stage 1 is the empty file, both sides fill it",
    files: [uu("cases/empty-base.txt")],
    engine: { conflicts: 1 },
  },
  { id: "binary", source: "matrix", what: "a binary conflict (NUL bytes)", files: [uu("assets/logo.bin", "binary")] },
  {
    id: "too-large",
    source: "matrix",
    what: "a file over the 512 KiB text cap",
    files: [uu("data/huge.log", "too-large")],
  },
  {
    id: "rename-one-side",
    source: "matrix",
    what: "X renames old_name.py → new_name.py and edits a line Y edits in the old name",
    files: [uu("rename/new_name.py")],
    engine: { conflicts: 1 },
  },
  {
    id: "rename-rename",
    source: "matrix",
    what: "renamed differently on both sides: the original both-deleted, each new name on one side",
    files: [
      { path: "rename2/orig.txt", xy: ["DD"], shape: "both-deleted" },
      { path: "rename2/by-x.txt", xy: ["AU"], shape: "added-one-side" },
      { path: "rename2/by-y.txt", xy: ["UA"], shape: "added-one-side" },
    ],
  },
  {
    id: "file-directory",
    source: "matrix",
    what: "X adds a file where Y adds a directory (git may move X's file aside as layout/panel~<label>)",
    files: [{ path: "layout/panel", pattern: /^layout\/panel(~.+)?$/, xy: ["AU"], shape: "added-one-side" }],
  },
  {
    id: "path-spaces-unicode",
    source: "matrix",
    what: "a path with spaces and non-ASCII characters",
    files: [uu("docs/naïve café/résumé – notes.md")],
    engine: { conflicts: 1 },
  },
  {
    id: "symlink",
    source: "matrix",
    what: "a symlink whose target both sides changed",
    files: [uu("links/current", "symlink")],
  },
  {
    id: "submodule",
    source: "matrix",
    what: "a submodule (gitlink) both sides moved",
    files: [uu("vendor/lib", "submodule")],
  },
  {
    id: "reporter-line3",
    source: "matrix",
    what: "the issue-#12 reporter's file: line 3 changed on both branches",
    files: [uu("f.txt")],
    engine: { conflicts: 1 },
  },
];

/** The case (and its file entry) a conflicted path belongs to, if any. */
export function caseOf(path: string): { c: ContentCase; f: CaseFile } | undefined {
  for (const c of CONTENT_CASES) {
    for (const f of c.files) {
      if (f.pattern ? f.pattern.test(path) : f.path === path) return { c, f };
    }
  }
  return undefined;
}

/** Every conflicted path the full content matrix produces, per operation. */
export const MATRIX_FILE_COUNT = CONTENT_CASES.reduce((n, c) => n + c.files.length, 0);

/** The operations × styles every run builds: "merge.diff3", … */
export function scenarioIds(): string[] {
  return OPERATIONS.flatMap((o) => STYLES.map((s) => `${o.id}.${s}`));
}
