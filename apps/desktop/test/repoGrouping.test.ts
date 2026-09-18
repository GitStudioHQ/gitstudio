import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claimRepos,
  countFolder,
  isUnder,
  relativeDir,
  splitBand,
} from "../src/shared/repoGrouping";

// Driven by the machine this was written for, read off the running app:
//
//   ~/Developer               tracked — 6 repositories loose in it
//   ~/Developer/GitStudioHQ   tracked TOO, and inside the one above — 4
//   ~/Developer/{FlexiMeal,Uncaged,Yugo,TrustGlobe,coding}  17 between them
//
// The screen showed the 6, then the 4, then the other 17 under a heading
// reading "Opened from elsewhere" — false twice: they are inside a folder he
// tracked on purpose, and the app found them itself.

const HOME = "/Users/antonarnaudov";
const DEV = `${HOME}/Developer`;
const GSHQ = `${DEV}/GitStudioHQ`;

/** Every repository the scan finds under those two folders, as it finds them. */
export const REAL_ROOTS = [
  `${DEV}/antonarnaudov`,
  `${DEV}/gistudio.dev`,
  `${DEV}/reshapedpdf`,
  `${DEV}/reshapedpdf-public`,
  `${DEV}/reshapedpdf-site`,
  `${DEV}/spool`,
  `${GSHQ}/gitstudio`,
  `${GSHQ}/merge-conflict-tests`,
  `${GSHQ}/merge-studio`,
  `${GSHQ}/vscode-extension-starter`,
  `${DEV}/FlexiMeal/flexi-meal-ai`,
  `${DEV}/FlexiMeal/flexi-meal-api`,
  `${DEV}/FlexiMeal/v0-meal-planning-app`,
  `${DEV}/FlexiMeal/v0-meal-planning-app-design-lab`,
  `${DEV}/FlexiMeal/wt-design`,
  `${DEV}/Uncaged/getuncaged.dev`,
  `${DEV}/Uncaged/homebrew-tap`,
  `${DEV}/Uncaged/uncaged`,
  `${DEV}/Uncaged/uncaged-brand`,
  `${DEV}/Uncaged/warp`,
  `${DEV}/Yugo/backend`,
  `${DEV}/Yugo/real-finance-web`,
  `${DEV}/Yugo/yugo-telegram-bot`,
  `${DEV}/TrustGlobe/trust-globe`,
  `${DEV}/TrustGlobe/trust-globe copy`,
  `${DEV}/coding/price-models-testing-ui`,
  `${DEV}/coding/v0-ckd-cats-guide`,
];

// The order he actually has them in — the inner one first, which is exactly the
// order that would break a rule that trusted the array.
const TRACKED = [GSHQ, DEV];

test("containment is by segment, not by string prefix", () => {
  assert.equal(isUnder("/a/Dev", "/a/Dev/repo"), true);
  assert.equal(isUnder("/a/Dev", "/a/Developer/repo"), false, "~/Dev does not contain ~/Developer");
  assert.equal(isUnder("/a/Dev", "/a/Dev"), false, "a folder does not contain itself");
  assert.equal(isUnder("/a/Dev/", "/a/Dev/repo"), true, "a trailing slash changes nothing");
});

test("a repository belongs to the SHALLOWEST tracked folder holding it", () => {
  const claims = claimRepos(TRACKED, REAL_ROOTS);
  // The one that decides the whole screen: GitStudioHQ is tracked in its own
  // right and lives inside tracked ~/Developer. It renders inside ~/Developer,
  // as a group — not as a second top-level band that tears it out of the
  // alphabetical run and leaves its parent claiming 23 of 27.
  assert.deepEqual(claims.get(`${GSHQ}/gitstudio`), { band: DEV, group: "GitStudioHQ" });
  assert.deepEqual(claims.get(`${DEV}/spool`), { band: DEV, group: "" });
  assert.deepEqual(claims.get(`${DEV}/Yugo/backend`), { band: DEV, group: "Yugo" });
  assert.equal(claims.size, REAL_ROOTS.length, "every repository is placed exactly once");
});

test("array order does not decide which folder claims a repository", () => {
  const a = claimRepos([GSHQ, DEV], REAL_ROOTS).get(`${GSHQ}/gitstudio`);
  const b = claimRepos([DEV, GSHQ], REAL_ROOTS).get(`${GSHQ}/gitstudio`);
  assert.deepEqual(a, b);
  assert.equal(a?.band, DEV);
});

test("a repository outside every tracked folder is claimed by none", () => {
  const claims = claimRepos(TRACKED, ["/somewhere/else/repo"]);
  assert.equal(claims.size, 0, "and is therefore genuinely 'opened from elsewhere'");
});

test("the relative directory is what sits between the folder and the repository", () => {
  assert.equal(relativeDir(DEV, `${DEV}/spool`), "", "loose in the folder");
  assert.equal(relativeDir(DEV, `${DEV}/Yugo/backend`), "Yugo");
  assert.equal(relativeDir(DEV, `${DEV}/a/b/c`), "a/b", "deeper reports its whole way down");
  assert.equal(relativeDir(DEV, "/elsewhere/repo"), "", "not inside: nothing to say");
});

test("his real ~/Developer reads as six loose repositories and six projects", () => {
  const claims = claimRepos(TRACKED, REAL_ROOTS);
  const mine = REAL_ROOTS.filter((r) => claims.get(r)?.band === DEV);
  const { loose, groups } = splitBand(DEV, mine, (r) => claims.get(r)!.group);

  assert.deepEqual(
    loose.map((r) => r.split("/").pop()),
    ["antonarnaudov", "gistudio.dev", "reshapedpdf", "reshapedpdf-public", "reshapedpdf-site", "spool"],
    "the plain repositories he said were there",
  );
  assert.deepEqual(
    groups.map((g) => `${g.label}:${g.items.length}`),
    ["coding:2", "FlexiMeal:5", "GitStudioHQ:4", "TrustGlobe:2", "Uncaged:5", "Yugo:3"],
    "case-insensitive, so 'coding' is not exiled below every capitalised project",
  );
  assert.equal(
    loose.length + groups.reduce((n, g) => n + g.items.length, 0),
    27,
    "all twenty-seven placed under one band, none twice",
  );
});

test("a band prints what renders under it, and gates deletion on what it holds", () => {
  const claims = claimRepos(TRACKED, REAL_ROOTS);

  const dev = countFolder(DEV, REAL_ROOTS, claims);
  assert.equal(dev.direct, 6, "the head prints the rows directly beneath it");
  assert.equal(dev.contained, 27, "and knows the whole subtree is not empty");

  // The bug this pair exists to kill: a folder whose repositories all sit one
  // level down looked EMPTY, so "Delete this folder" was offered over it.
  const gshq = countFolder(GSHQ, REAL_ROOTS, claims);
  assert.equal(gshq.direct, 0, "it claims nothing directly — ~/Developer claimed its four");
  assert.equal(gshq.contained, 4, "but four repositories are inside it");

  const yugo = countFolder(`${DEV}/Yugo`, REAL_ROOTS, claims);
  assert.equal(yugo.contained, 3);
});

test("a sub-group carries the path it is, so it can be revealed or tracked", () => {
  const { groups } = splitBand(DEV, [`${DEV}/Yugo/backend`], () => "Yugo");
  assert.equal(groups[0].path, `${DEV}/Yugo`);
  assert.equal(groups[0].label, "Yugo");
});

test("a group is keyed by its whole directory, not by its first segment", () => {
  // Two different places. Folding them together would put a row under a head
  // that does not contain it.
  const { groups } = splitBand(
    DEV,
    [
      { g: "FlexiMeal" },
      { g: "FlexiMeal/archive" },
    ],
    (x) => x.g,
  );
  assert.deepEqual(groups.map((g) => g.label), ["FlexiMeal", "FlexiMeal/archive"]);
});

test("a directory holding no repository produces no group", () => {
  // ~/Developer/code, ClaudeCode and CursorRules all exist and hold none.
  // repos:local returns repositories, never directories, so nothing reaches
  // here for them and nothing may be drawn.
  const { loose, groups } = splitBand(DEV, [] as string[], (r) => r);
  assert.deepEqual(loose, []);
  assert.deepEqual(groups, []);
});
