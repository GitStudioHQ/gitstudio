import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAccountTarget,
  parseExploreTarget,
  parseRepoRoute,
  repoRouteId,
  searchTargetId,
} from "../src/renderer/exploreRoutes";

// Explore states are `target.id` micro-paths so ⌘[ walks the trail without
// widening SectionTarget. That makes the parser load-bearing for navigation:
// a wrong parse silently strands the user on the wrong page.

test("a bare repo target parses to the root at the default branch", () => {
  assert.deepEqual(parseRepoRoute("repo/acme/widgets"), {
    fullName: "acme/widgets",
    kind: "tree",
    ref: undefined,
    path: "",
  });
});

test("a tree target carries the ref and path", () => {
  assert.deepEqual(parseRepoRoute("repo/acme/widgets/tree/main/src/renderer"), {
    fullName: "acme/widgets",
    kind: "tree",
    ref: "main",
    path: "src/renderer",
  });
});

test("a blob target is distinguished from a tree", () => {
  const r = parseRepoRoute("repo/acme/widgets/blob/main/src/index.ts");
  assert.equal(r?.kind, "blob");
  assert.equal(r?.path, "src/index.ts");
});

test("the HEAD sentinel parses back to 'the default branch', never a pinned ref", () => {
  // Walking into a file from the root writes HEAD; if that came back as a real
  // ref, the switcher would relabel itself and pin the branch behind the user.
  const r = parseRepoRoute("repo/acme/widgets/blob/HEAD/README.md");
  assert.equal(r?.ref, undefined);
  assert.equal(r?.path, "README.md");
});

test("a ref containing a slash survives the round trip", () => {
  const id = repoRouteId({ fullName: "acme/widgets", ref: "release/1.2", path: "src/a.ts", kind: "blob" });
  const r = parseRepoRoute(id);
  assert.equal(r?.ref, "release/1.2");
  assert.equal(r?.path, "src/a.ts");
  assert.equal(r?.kind, "blob");
});

test("round-tripping the root produces the bare form", () => {
  assert.equal(repoRouteId({ fullName: "acme/widgets" }), "repo/acme/widgets");
});

test("non-repo ids are ignored rather than throwing", () => {
  assert.equal(parseRepoRoute(undefined), undefined);
  assert.equal(parseRepoRoute("q/repos/git"), undefined);
  assert.equal(parseRepoRoute("user/anton"), undefined);
  assert.equal(parseRepoRoute("repo/onlyowner"), undefined);
});

// ── accounts ─────────────────────────────────────────────────────────────────

test("user and org targets both resolve to a login", () => {
  assert.deepEqual(parseAccountTarget("user/anton"), { login: "anton" });
  assert.deepEqual(parseAccountTarget("org/GitStudioHQ"), { login: "GitStudioHQ" });
});

test("an account target with extra path segments is not an account page", () => {
  assert.equal(parseAccountTarget("user/anton/repos"), undefined);
  assert.equal(parseAccountTarget("repo/acme/widgets"), undefined);
  assert.equal(parseAccountTarget(undefined), undefined);
});

// ── searches ─────────────────────────────────────────────────────────────────

test("a search target round-trips, tab and all", () => {
  const id = searchTargetId("code", "createLogPane");
  assert.deepEqual(parseExploreTarget(id), { tab: "code", query: "createLogPane" });
});

test("a query containing slashes and spaces survives", () => {
  const id = searchTargetId("repos", "org:acme path:src/renderer");
  assert.deepEqual(parseExploreTarget(id), { tab: "repos", query: "org:acme path:src/renderer" });
});

test("an unknown tab is not a search target", () => {
  assert.equal(parseExploreTarget("q/wat/hello"), undefined);
  assert.equal(parseExploreTarget("repo/acme/widgets"), undefined);
  assert.equal(parseExploreTarget(undefined), undefined);
});

test("an empty query still parses (the page shows its start state)", () => {
  assert.deepEqual(parseExploreTarget("q/repos/"), { tab: "repos", query: "" });
});
