// The recents list — small, but it is the app's memory of where your work is,
// and it is persisted as plain JSON that survives upgrades and can be edited by
// hand. So the rules that matter are the ones about paths that are the SAME
// repo spelled differently.
//
// Only the pure list math is exercised here; the RepoStore class itself owns a
// GitContext and a git adapter, which a unit test has no business constructing.

import { test } from "node:test";
import assert from "node:assert/strict";
import { promoteRecentList, sameRoot } from "../src/main/repoStore";

test("two spellings of one path are the same repo", () => {
  assert.equal(sameRoot("/x/repo", "/x/repo/"), true, "a trailing slash is not a different repo");
  assert.equal(sameRoot("/x/repo", "/x/./repo"), true);
  assert.equal(sameRoot("/x/a/../repo", "/x/repo"), true);
  assert.equal(sameRoot("/x/repo", "/x/repo2"), false);
  assert.equal(sameRoot("/x/repo", "/y/repo"), false);
});

test("opening a repo puts it first", () => {
  assert.deepEqual(promoteRecentList(["/b", "/c"], "/a"), ["/a", "/b", "/c"]);
});

test("re-opening a repo moves it to the front rather than duplicating it", () => {
  assert.deepEqual(promoteRecentList(["/a", "/b", "/c"], "/c"), ["/c", "/a", "/b"]);
});

test("a differently spelled path does not become a second entry", () => {
  // The persisted list held "/x/repo/"; discovery hands back "/x/repo". Raw
  // string equality listed the same repo twice, and the list is short enough
  // that two of the same thing pushes a real repo off the end.
  assert.deepEqual(promoteRecentList(["/x/repo/", "/y/other"], "/x/repo"), [
    "/x/repo",
    "/y/other",
  ]);
  assert.deepEqual(promoteRecentList(["/x/./repo", "/y/other"], "/x/repo"), [
    "/x/repo",
    "/y/other",
  ]);
});

test("the freshly opened spelling wins, so an odd entry heals", () => {
  assert.deepEqual(promoteRecentList(["/x/repo/"], "/x/repo")[0], "/x/repo");
});

test("the list is capped, oldest dropped", () => {
  const many = Array.from({ length: 12 }, (_, i) => `/r${i}`);
  const next = promoteRecentList(many, "/new", 12);
  assert.equal(next.length, 12);
  assert.equal(next[0], "/new");
  assert.equal(next.includes("/r11"), false, "the oldest fell off the end");
  assert.equal(next.includes("/r10"), true);
});

test("promoting an entry already in a full list does not shrink it", () => {
  const many = Array.from({ length: 12 }, (_, i) => `/r${i}`);
  const next = promoteRecentList(many, "/r11", 12);
  assert.equal(next.length, 12, "it moved, it did not push anything off");
  assert.equal(next[0], "/r11");
});

test("promoting is pure — the input list is not mutated", () => {
  const before = ["/a", "/b"];
  promoteRecentList(before, "/b");
  assert.deepEqual(before, ["/a", "/b"]);
});
