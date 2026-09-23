import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireRow } from "@gitstudio/host-bridge/graphProtocol";
import { rowMatches, SEARCH_SCOPES } from "../src/graph/search";

// One rowMatches for both commit lists. The editor graph and the sidebar rail
// each kept a copy and they drifted: the rail's "All" had stopped looking at
// the author email. These pin what the shared one answers, scope by scope.

const row: WireRow = {
  sha: "9fceb02d0ae598e19e3c1b6e7c4e8c2a1b0f3d4e",
  shortSha: "9fceb02",
  column: 0,
  color: 0,
  isMerge: false,
  segments: [],
  subject: "fix: the Search box loses focus",
  author: "Mira Holt",
  authorEmail: "mira@example.com",
  authorDate: 1700000000,
  refs: [{ name: "origin/feature/search", fullName: "refs/remotes/origin/feature/search", kind: "remoteHead" }],
};

test("All matches the author email, not only the name", () => {
  assert.equal(rowMatches(row, "mira@", "all"), true);
  assert.equal(rowMatches(row, "mira@", "author"), true);
  assert.equal(rowMatches(row, "mira@", "message"), false);
});

test("All reaches every field a scope can", () => {
  assert.equal(rowMatches(row, "search box", "all"), true);
  assert.equal(rowMatches(row, "holt", "all"), true);
  assert.equal(rowMatches(row, "9fceb0", "all"), true);
  assert.equal(rowMatches(row, "feature/", "all"), true);
  assert.equal(rowMatches(row, "nowhere", "all"), false);
});

test("SHA is a prefix match on the full or the short sha, whatever the case of the paste", () => {
  // Callers lowercase the query; a sha pasted in upper case still has to hit.
  assert.equal(rowMatches(row, "9fceb02d0ae5", "sha"), true);
  assert.equal(rowMatches({ ...row, sha: row.sha.toUpperCase() }, "9fceb", "sha"), true);
  assert.equal(rowMatches(row, "ceb02", "sha"), false);
});

test("the scope list is the one both lists show, in the same order", () => {
  assert.deepEqual(
    SEARCH_SCOPES.map((s) => s.id),
    ["all", "message", "author", "sha", "refs"],
  );
});
