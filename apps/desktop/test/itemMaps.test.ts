import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapComment,
  mapIssue,
  mapPull,
  mapReactions,
  type RawIssue,
  type RawPull,
} from "../src/main/github/maps";

// The PR/Issue/comment mappers, now the single home for both former copies.
// These assert the METADATA the UI newly depends on — and the absent-field
// defaults, since GitHub omits far more than its docs admit.

function rawPull(over: Partial<RawPull> = {}): RawPull {
  return {
    number: 31,
    title: "Add the thing",
    body: "why",
    state: "closed",
    html_url: "https://github.com/acme/w/pull/31",
    user: { login: "author", avatar_url: "https://a/1" },
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-05T10:00:00Z",
    head: { ref: "feat", sha: "aaa", repo: { full_name: "acme/w" } },
    base: { ref: "main", sha: "bbb", repo: { full_name: "acme/w" } },
    ...over,
  };
}

test("a merged PR carries who merged it, when it closed, and its counts", () => {
  const p = mapPull(
    rawPull({
      merged_at: "2026-08-05T09:00:00Z",
      closed_at: "2026-08-05T09:00:00Z",
      merged_by: { login: "maintainer", avatar_url: "https://a/2" },
      review_comments: 4,
      commits: 7,
      author_association: "CONTRIBUTOR",
    }),
  );
  assert.equal(p.mergedAt, "2026-08-05T09:00:00Z");
  assert.equal(p.closedAt, "2026-08-05T09:00:00Z");
  assert.equal(p.mergedBy?.login, "maintainer");
  assert.equal(p.reviewComments, 4);
  assert.equal(p.commits, 7);
  assert.equal(p.authorAssociation, "CONTRIBUTOR");
});

test("requested reviewers map to users, nulls dropped", () => {
  const p = mapPull(
    rawPull({ requested_reviewers: [{ login: "a" }, { login: "b", avatar_url: "https://a/b" }] }),
  );
  assert.deepEqual(p.requestedReviewers?.map((u) => u.login), ["a", "b"]);
  assert.equal(p.requestedReviewers?.[0].avatarUrl, null);
});

test("a fork PR reports its head repo; a same-repo PR reports null", () => {
  assert.equal(mapPull(rawPull()).headRepoFullName, null);
  const forked = mapPull(
    rawPull({ head: { ref: "feat", sha: "aaa", repo: { full_name: "someone/w" } } }),
  );
  assert.equal(forked.headRepoFullName, "someone/w");
});

test("a PR with no optional metadata still maps to concrete defaults", () => {
  const p = mapPull(rawPull());
  assert.equal(p.mergedAt, null);
  assert.equal(p.closedAt, null);
  assert.equal(p.mergedBy, null);
  assert.deepEqual(p.assignees, []);
  assert.deepEqual(p.requestedReviewers, []);
  assert.equal(p.milestone, null);
  assert.equal(p.reactions, undefined);
});

// ── issues ───────────────────────────────────────────────────────────────────

function rawIssue(over: Partial<RawIssue> = {}): RawIssue {
  return {
    number: 12,
    title: "Broken",
    body: null,
    state: "closed",
    html_url: "https://github.com/acme/w/issues/12",
    user: { login: "reporter" },
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-02T10:00:00Z",
    comments: 2,
    ...over,
  };
}

test("a closed issue carries WHY it closed and who closed it", () => {
  const i = mapIssue(
    rawIssue({
      state_reason: "not_planned",
      closed_at: "2026-08-02T10:00:00Z",
      closed_by: { login: "triager" },
    }),
  );
  assert.equal(i.stateReason, "not_planned");
  assert.equal(i.closedAt, "2026-08-02T10:00:00Z");
  assert.equal(i.closedBy?.login, "triager");
});

test("an open issue has null closure fields, not undefined", () => {
  const i = mapIssue(rawIssue({ state: "open" }));
  assert.equal(i.stateReason, null);
  assert.equal(i.closedAt, null);
  assert.equal(i.closedBy, null);
});

test("string labels (the search API's shorthand) still map", () => {
  const i = mapIssue(rawIssue({ labels: ["bug", { name: "p1", color: "ff0000" }] }));
  assert.deepEqual(i.labels, [
    { name: "bug", color: "888888" },
    { name: "p1", color: "ff0000" },
  ]);
});

// ── comments ─────────────────────────────────────────────────────────────────

test("a comment edited after posting keeps both timestamps", () => {
  const c = mapComment({
    id: 5,
    user: { login: "x" },
    body: "hi",
    created_at: "2026-08-01T10:00:00Z",
    updated_at: "2026-08-01T11:00:00Z",
    author_association: "MEMBER",
  });
  assert.equal(c.createdAt, "2026-08-01T10:00:00Z");
  assert.equal(c.updatedAt, "2026-08-01T11:00:00Z");
  assert.equal(c.authorAssociation, "MEMBER");
});

test("a comment with a null body maps to an empty string, never null", () => {
  const c = mapComment({ id: 6, user: null, body: null, created_at: "2026-08-01T10:00:00Z" });
  assert.equal(c.body, "");
  assert.equal(c.author, null);
});

// ── reactions ────────────────────────────────────────────────────────────────

test("reactions map only when someone actually reacted", () => {
  assert.equal(mapReactions(undefined), undefined);
  assert.equal(mapReactions(null), undefined);
  assert.equal(mapReactions({ total_count: 0, "+1": 0 }), undefined);
  assert.deepEqual(mapReactions({ total_count: 3, "+1": 2, heart: 1 }), {
    total: 3,
    plusOne: 2,
    minusOne: 0,
    laugh: 0,
    hooray: 0,
    confused: 0,
    heart: 1,
    rocket: 0,
    eyes: 0,
  });
});
