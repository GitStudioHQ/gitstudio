import { test } from "node:test";
import assert from "node:assert/strict";
import {
  beyondCeiling,
  codeSearchPath,
  normalizeQuery,
  reachableCount,
  repoSearchPath,
  repoSortParams,
  userQuery,
  userSearchPath,
  SEARCH_PER_PAGE,
  SEARCH_RESULT_CEILING,
} from "../src/main/github/searchQuery";

// Every URL Explore can ask GitHub for. A wrong search query doesn't error —
// it returns results, just not the right ones — so the shapes are pinned here.

test("queries are trimmed and internally collapsed", () => {
  assert.equal(normalizeQuery("  react   hooks  "), "react hooks");
  assert.equal(normalizeQuery("\n\tone\t two \n"), "one two");
  assert.equal(normalizeQuery("   "), "");
});

test("a user search appends the type qualifier that separates the tabs", () => {
  assert.equal(userQuery("anton", "users"), "anton type:user");
  assert.equal(userQuery("gitstudio", "orgs"), "gitstudio type:org");
});

test("a user-supplied type: qualifier is respected, not doubled", () => {
  assert.equal(userQuery("anton type:org", "users"), "anton type:org");
  assert.equal(userQuery("anton TYPE:org", "users"), "anton TYPE:org");
});

test("'best' sends no sort — that IS GitHub's own ranking", () => {
  assert.deepEqual(repoSortParams("best"), {});
  assert.deepEqual(repoSortParams("stars"), { sort: "stars", order: "desc" });
  assert.deepEqual(repoSortParams("updated"), { sort: "updated", order: "desc" });
});

test("repo search path carries query, per_page, page and sort", () => {
  const p = repoSearchPath("git client", "stars", 2);
  assert.match(p, /^\/search\/repositories\?/);
  assert.match(p, /q=git\+client/);
  assert.match(p, new RegExp(`per_page=${SEARCH_PER_PAGE}`));
  assert.match(p, /page=2/);
  assert.match(p, /sort=stars/);
  assert.match(p, /order=desc/);
});

test("a best-sorted repo search sends no sort param at all", () => {
  const p = repoSearchPath("git client", "best");
  assert.equal(/[?&]sort=/.test(p), false);
});

test("qualifiers and special characters survive encoding", () => {
  const p = repoSearchPath("stars:>1000 language:TypeScript", "best");
  assert.match(p, /q=stars%3A%3E1000\+language%3ATypeScript/);
});

test("user and code search paths are well-formed", () => {
  assert.match(userSearchPath("anton", "orgs", 3), /^\/search\/users\?.*type%3Aorg.*page=3/);
  assert.match(codeSearchPath("addEventListener", 1), /^\/search\/code\?q=addEventListener/);
});

// ── the 1000-result ceiling ──────────────────────────────────────────────────

test("pages within the ceiling are allowed", () => {
  assert.equal(beyondCeiling(1), false);
  // page 33 ends at 990 — the last fully reachable page.
  assert.equal(beyondCeiling(33), false);
});

test("the first page past 1000 results is refused locally (GitHub 422s)", () => {
  assert.equal(beyondCeiling(34), true);
  assert.equal(beyondCeiling(100), true);
});

test("reachableCount never promises more than GitHub will serve", () => {
  assert.equal(reachableCount(12), 12);
  assert.equal(reachableCount(50_000), SEARCH_RESULT_CEILING);
});
