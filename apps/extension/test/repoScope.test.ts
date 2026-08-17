import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isGitMetadata,
  isInsideRepo,
  isSamePathOrInside,
  isWorkingTreeFileOf,
} from "../src/util/repoScope";

// The Changes view refreshes itself when you save a file (issue #17), which means
// it now asks "was that MY repo's file?" on every save in the window. Every part
// of that question has a wrong-looking-right answer, and this repo has already
// been bitten by one of them: repoManager's own comment records the active repo
// falling back to the wrong root because a boundary check only understood
// forward slashes.
//
// `platform` is passed explicitly throughout so each filesystem's behaviour is
// exercised wherever the tests happen to run — the CI matrix covers ubuntu,
// macos and windows, but a rule that only bites on Windows should not depend on
// which leg is green.
const LINUX = "linux";
const MAC = "darwin";
const WIN = "win32";

test("a file under the root is in scope", () => {
  assert.equal(isInsideRepo("/code/app/src/index.ts", "/code/app", LINUX), true);
  assert.equal(isInsideRepo("/code/app/README.md", "/code/app", LINUX), true);
});

test("the root itself is in scope", () => {
  assert.equal(isInsideRepo("/code/app", "/code/app", LINUX), true);
});

test("a SIBLING whose name merely starts with the root is NOT in scope", () => {
  // The bug a bare startsWith() would ship: an edit in the wrong checkout would
  // refresh — and re-scan — an unrelated repository.
  assert.equal(isInsideRepo("/code/app-old/src/index.ts", "/code/app", LINUX), false);
  assert.equal(isInsideRepo("/code/apple/src/index.ts", "/code/app", LINUX), false);
  assert.equal(isInsideRepo("/code/app2", "/code/app", LINUX), false);
});

test("a file outside the root entirely is not in scope", () => {
  assert.equal(isInsideRepo("/etc/hosts", "/code/app", LINUX), false);
  assert.equal(isInsideRepo("/code/other/x.ts", "/code/app", LINUX), false);
});

test("trailing separators on either side are ignored", () => {
  assert.equal(isInsideRepo("/code/app/x.ts", "/code/app/", LINUX), true);
  assert.equal(isInsideRepo("/code/app/", "/code/app", LINUX), true);
});

test("both separators are understood, whichever the host uses", () => {
  // vscode hands back fsPath with "\" on Windows; a forward-slash-only boundary
  // is exactly what sent repoManager to the wrong root once already.
  assert.equal(isInsideRepo("C:\\code\\app\\src\\x.ts", "C:\\code\\app", WIN), true);
  assert.equal(isInsideRepo("C:\\code\\app-old\\src\\x.ts", "C:\\code\\app", WIN), false);
  assert.equal(isInsideRepo("C:\\code\\app", "C:\\code\\app", WIN), true);
  // Mixed separators still resolve, because either one closes the boundary.
  assert.equal(isInsideRepo("C:\\code\\app/src/x.ts", "C:\\code\\app", WIN), true);
});

test("case is folded on macOS and Windows, and respected on Linux", () => {
  // The case that silently dropped saves: macOS and Windows will hand back a
  // path whose casing differs from the root git reported.
  assert.equal(isInsideRepo("/Code/App/src/x.ts", "/code/app", MAC), true);
  assert.equal(isInsideRepo("C:\\CODE\\App\\x.ts", "c:\\code\\app", WIN), true);
  // Linux filesystems really are case-sensitive, so these are different paths.
  assert.equal(isInsideRepo("/Code/App/src/x.ts", "/code/app", LINUX), false);
});

test("empty inputs are never in scope", () => {
  assert.equal(isInsideRepo("", "/code/app", LINUX), false);
  assert.equal(isInsideRepo("/code/app/x.ts", "", LINUX), false);
});

test("isSamePathOrInside is the shared helper repoManager also uses", () => {
  // repoManager asks it BOTH ways round to decide whether git's symlink-resolved
  // root matches the opened folder, so identity must hold in both directions.
  assert.equal(isSamePathOrInside("/code/app", "/code/app", LINUX), true);
  assert.equal(isSamePathOrInside("/code/app/sub", "/code/app", LINUX), true);
  assert.equal(isSamePathOrInside("/code/app", "/code/app/sub", LINUX), false);
});

test("git's own directory is metadata, at any depth and either separator", () => {
  assert.equal(isGitMetadata("/code/app/.git/index"), true);
  assert.equal(isGitMetadata("/code/app/.git/refs/heads/main"), true);
  assert.equal(isGitMetadata("C:\\code\\app\\.git\\index"), true);
  // A linked worktree keeps its admin files under the main repo's .git too.
  assert.equal(isGitMetadata("/code/app/.git/worktrees/wt1/HEAD"), true);
  // The directory itself, with nothing after it.
  assert.equal(isGitMetadata("/code/app/.git"), true);
});

test("ordinary files are not metadata, even when '.git' is part of a name", () => {
  // `.gitignore` and `.github/` are files people edit and expect to see land in
  // the Changes list — a naive `includes(".git")` would swallow both.
  assert.equal(isGitMetadata("/code/app/.gitignore"), false);
  assert.equal(isGitMetadata("/code/app/.gitattributes"), false);
  assert.equal(isGitMetadata("/code/app/.github/workflows/ci.yml"), false);
  assert.equal(isGitMetadata("/code/app/src/git/index.ts"), false);
  assert.equal(isGitMetadata("/code/app/legit/x.ts"), false);
});

test("the combined check wants both: inside the repo AND not metadata", () => {
  assert.equal(isWorkingTreeFileOf("/code/app/src/x.ts", "/code/app", LINUX), true);
  assert.equal(isWorkingTreeFileOf("/code/app/.gitignore", "/code/app", LINUX), true);
  assert.equal(isWorkingTreeFileOf("/code/app/.git/index", "/code/app", LINUX), false);
  assert.equal(isWorkingTreeFileOf("/code/app-old/src/x.ts", "/code/app", LINUX), false);
  // And it inherits the case rule, so a differently-cased save still counts.
  assert.equal(isWorkingTreeFileOf("/Code/App/src/x.ts", "/code/app", MAC), true);
});
