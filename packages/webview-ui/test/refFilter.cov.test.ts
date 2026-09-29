import { test } from "node:test";
import assert from "node:assert/strict";
import type { GraphRefEntry, WireRef, WireRow } from "@gitstudio/host-bridge/graphProtocol";
import { presetUnavailable, refFilterHint } from "../src/graph/refFilter";
import { REFS_PADDING, estimateChipWidth, foldRefs, legibleRefsWidth } from "../src/graph/refLayout";
import { rowMatches } from "../src/graph/search";

// The Branches picker's footnote and excuses, the refs column's legibility
// floor, and the "refs" search scope — the corners the picker/layout/search
// tests leave out.

const REFS: GraphRefEntry[] = [
  { fullName: "refs/heads/main", name: "main", kind: "head", isCurrent: true, upstream: "refs/remotes/origin/main" },
  { fullName: "refs/remotes/origin/main", name: "origin/main", kind: "remoteHead" },
  { fullName: "refs/tags/v1", name: "v1", kind: "tag" },
];

test("'Current + upstream' on a detached HEAD says there is no current branch", () => {
  const detached = REFS.map((r) => ({ ...r, isCurrent: undefined }));
  assert.equal(presetUnavailable("currentUpstream", detached), "HEAD is detached — there is no current branch");
});

test("'Local only' in a repository of nothing but remotes and tags says so", () => {
  const remotesOnly = REFS.filter((r) => r.kind !== "head");
  assert.equal(presetUnavailable("local", remotesOnly), "No local branches");
  assert.equal(presetUnavailable("local", REFS), "");
  assert.equal(presetUnavailable("all", []), "", "All is always available");
});

test("the picker's footnote says what the selection follows, and how to get back to All", () => {
  assert.equal(refFilterHint(null, REFS, "current"), "Follows the branch you are on · All for every branch");
  assert.equal(refFilterHint(["refs/heads/main"], REFS, "currentUpstream"), "Follows the branch you are on · All for every branch");
  assert.equal(refFilterHint(null, REFS, "local"), "Follows your local branches · All for every branch");
  assert.equal(refFilterHint(["refs/heads/main", "refs/tags/v1"], REFS), "2 of 3 ticked · untick the last for all");
  assert.equal(refFilterHint(null, REFS), "Showing every branch and tag · tick one to narrow");
  assert.equal(refFilterHint(null, []), "No branches or tags");
});

const ref = (fullName: string, kind: WireRef["kind"], name = fullName.replace(/^refs\/(heads|remotes|tags)\//, "")): WireRef =>
  ({ name, fullName, kind }) as WireRef;

test("the refs column's floor is one readable chip of the busiest row, or nothing when no row has refs", () => {
  assert.equal(legibleRefsWidth([]), 0);
  assert.equal(legibleRefsWidth([{}, { refs: [] }]), 0, "no refs anywhere: the column may collapse");

  const rows = [
    { refs: [ref("refs/heads/a", "head")] },
    { refs: [ref("refs/heads/feature/login", "head"), ref("refs/remotes/origin/feature/login", "remoteHead")] },
  ];
  const widest = foldRefs(rows[1].refs).map((e) => estimateChipWidth(e, 150));
  assert.equal(widest.length, 1, "the remote twin folds into its local chip");
  assert.equal(legibleRefsWidth(rows), REFS_PADDING + widest[0]);
  assert.ok(legibleRefsWidth(rows) > legibleRefsWidth([rows[0]]), "the busier chip sets the floor");
});

test("a very long branch name cannot make the floor demand half the window", () => {
  const long = [{ refs: [ref(`refs/heads/${"x".repeat(200)}`, "head")] }];
  assert.equal(legibleRefsWidth(long), REFS_PADDING + 150);
});

test("the 'refs' search scope matches a ref's name and nothing else", () => {
  const row = {
    sha: "9fceb02d0ae598e95dc970b74767f19372d61af8",
    shortSha: "9fceb02",
    subject: "Release notes",
    author: "Mira",
    authorEmail: "mira@example.com",
    refs: [ref("refs/tags/v2.0.0", "tag", "v2.0.0"), ref("refs/heads/Release/2.0", "head", "Release/2.0")],
  } as unknown as WireRow;
  assert.equal(rowMatches(row, "release/", "refs"), true, "case-insensitive against the ref name");
  assert.equal(rowMatches(row, "v2.0", "refs"), true);
  assert.equal(rowMatches(row, "notes", "refs"), false, "the subject is not a ref");
  assert.equal(rowMatches({ ...row, refs: [] } as WireRow, "v2", "refs"), false);
});
