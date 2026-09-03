import { test } from "node:test";
import assert from "node:assert/strict";
import { issueSearchQuery, issueSearchPath } from "../src/main/github/searchQuery";

/**
 * A wrong search query returns results — just not the right ones — which is
 * why this file exists at all. Every case below is a qualifier someone types.
 */

test("it scopes to the repository and to issues", () => {
  assert.equal(
    issueSearchQuery("GitStudioHQ/gitstudio", "crash on rebase"),
    "repo:GitStudioHQ/gitstudio is:issue crash on rebase",
  );
});

test("the state segment is applied unless the query already says one", () => {
  assert.equal(
    issueSearchQuery("o/r", "boom", { state: "closed" }),
    "repo:o/r is:issue is:closed boom",
  );
  // Typing `is:open` must not fight the Closed segment: the typed one wins.
  assert.equal(issueSearchQuery("o/r", "is:open boom", { state: "closed" }), "repo:o/r is:issue is:open boom");
  assert.equal(issueSearchQuery("o/r", "state:open boom", { state: "closed" }), "repo:o/r is:issue state:open boom");
  // "all" means no state qualifier at all.
  assert.equal(issueSearchQuery("o/r", "boom", { state: "all" }), "repo:o/r is:issue boom");
});

test("a typed is:pr is respected rather than doubled", () => {
  assert.equal(issueSearchQuery("o/r", "is:pr review"), "repo:o/r is:pr review");
  assert.equal(issueSearchQuery("o/r", "review", { kind: "pr" }), "repo:o/r is:pr review");
});

test("an empty query still scopes — it is 'everything here', not 'everything'", () => {
  assert.equal(issueSearchQuery("o/r", "   "), "repo:o/r is:issue");
});

test("the qualifiers people actually type survive intact", () => {
  const q = issueSearchQuery("o/r", 'author:@me label:"needs design" no:assignee sort:comments-desc');
  assert.equal(q, 'repo:o/r is:issue author:@me label:"needs design" no:assignee sort:comments-desc');
});

test("whitespace is collapsed, so the same search is the same string", () => {
  assert.equal(issueSearchQuery("o/r", "  two   words  "), "repo:o/r is:issue two words");
});

test("the path escapes the query rather than pasting it in raw", () => {
  const path = issueSearchPath("o/r", 'label:"needs design"', { state: "open" });
  assert.ok(path.startsWith("/search/issues?"), path);
  // A raw quote or space in a URL is how a search silently becomes a 422.
  assert.ok(!/[ "]/.test(path), `unescaped character in ${path}`);
  const q = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q");
  assert.equal(q, 'repo:o/r is:issue is:open label:"needs design"');
});
