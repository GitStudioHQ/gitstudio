// The Pull Requests section's GitHub calls (main/github/prs.ts) over a fake
// api.github.com: create/review/state/reviewer/label/assignee writes and the
// requests they send, the Create-PR support reads, the per-file base/head
// diff (merge base, added/removed sides, binary and oversized files), review
// threads over GraphQL, and the never-throw mutation contract.

import { test } from "node:test";
import assert from "node:assert/strict";
import { b64, fakeGitHub, page, reply, type FakeCall } from "./ghFakeApi";
import {
  addReviewComment,
  edit,
  fileDiff,
  labels,
  prBranches,
  prComment,
  prCreate,
  prMarkReady,
  prRequestReviewers,
  prReview,
  prReviewers,
  prSetState,
  prefill,
  replyThread,
  resolveThread,
  reviewThreads,
  setAssignees,
  setLabels,
  updateBranch,
} from "../src/main/github/prs";

const R = "/repos/o/r";
const BASE = "b".repeat(40);
const HEAD = "h".repeat(40);
const MB = "m".repeat(40);

const rawPull = (n: number) => ({
  number: n,
  title: "t",
  body: null,
  state: "open",
  html_url: `https://github.com/o/r/pull/${n}`,
  user: null,
  created_at: "",
  updated_at: "",
  head: { ref: "feat", sha: HEAD },
  base: { ref: "main", sha: BASE },
});

// ── Mutations ──

test("creating a PR sends title/head/base with defaults and names the new number", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/pulls`]: () => reply(201, rawPull(42)) });
  const r = await prCreate(gh.client, "o", "r", { title: "Add x", head: "feat", base: "main" });
  assert.deepEqual(r, { ok: true, changed: false, message: "#42" });
  assert.deepEqual(gh.calls[0].body, { title: "Add x", head: "feat", base: "main", body: "", draft: false });
});

test("a draft PR with a body sends both", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/pulls`]: () => reply(201, rawPull(43)) });
  await prCreate(gh.client, "o", "r", { title: "WIP", head: "f", base: "main", body: "notes", draft: true });
  assert.deepEqual(gh.calls[0].body, { title: "WIP", head: "f", base: "main", body: "notes", draft: true });
});

test("a PR GitHub refuses to create comes back as its message", async (t) => {
  const gh = fakeGitHub(t, {
    [`POST ${R}/pulls`]: () => reply(422, { message: "A pull request already exists for o:feat." }),
  });
  assert.deepEqual(await prCreate(gh.client, "o", "r", { title: "x", head: "feat", base: "main" }), {
    ok: false,
    changed: false,
    message: "A pull request already exists for o:feat.",
  });
});

test("a PR comment goes to the issues endpoint and never claims the working tree changed", async (t) => {
  const gh = fakeGitHub(t, {
    [`POST ${R}/issues/7/comments`]: () => reply(201, {}),
    [`POST ${R}/issues/8/comments`]: () => reply(403, { message: "locked" }),
  });
  assert.deepEqual(await prComment(gh.client, "o", "r", { number: 7, body: "nice" }), { ok: true, changed: false });
  assert.deepEqual(gh.calls[0].body, { body: "nice" });
  assert.deepEqual(await prComment(gh.client, "o", "r", { number: 8, body: "x" }), {
    ok: false,
    changed: false,
    message: "locked",
    expected: true,
  });
});

test("a review sends the event, the body and the commit it was made against", async (t) => {
  const gh = fakeGitHub(t, { [`POST ${R}/pulls/3/reviews`]: {} });
  await prReview(gh.client, "o", "r", { number: 3, event: "REQUEST_CHANGES", body: "Please fix", commitId: HEAD });
  await prReview(gh.client, "o", "r", { number: 3, event: "APPROVE" });
  assert.deepEqual(gh.calls.map((c) => c.body), [
    { event: "REQUEST_CHANGES", body: "Please fix", commit_id: HEAD },
    { event: "APPROVE" },
  ]);
});

test("a review GitHub refuses is a result", async (t) => {
  const gh = fakeGitHub(t, {
    [`POST ${R}/pulls/3/reviews`]: () => reply(422, { message: "Can not approve your own pull request" }),
  });
  assert.deepEqual(await prReview(gh.client, "o", "r", { number: 3, event: "APPROVE" }), {
    ok: false,
    changed: false,
    message: "Can not approve your own pull request",
  });
});

test("closing and reopening PATCH the pull's state", async (t) => {
  const gh = fakeGitHub(t, {
    [`PATCH ${R}/pulls/4`]: {},
    [`PATCH ${R}/pulls/5`]: () => reply(404, { message: "Not Found" }),
  });
  assert.deepEqual(await prSetState(gh.client, "o", "r", { number: 4, state: "closed" }), { ok: true, changed: false });
  assert.deepEqual(gh.calls[0].body, { state: "closed" });
  assert.equal((await prSetState(gh.client, "o", "r", { number: 5, state: "open" })).ok, false);
});

test("requesting reviewers posts their logins; a non-collaborator's 422 is the message", async (t) => {
  const gh = fakeGitHub(t, {
    [`POST ${R}/pulls/4/requested_reviewers`]: () => reply(201, {}),
    [`POST ${R}/pulls/5/requested_reviewers`]: () =>
      reply(422, { message: "Reviews may only be requested from collaborators." }),
  });
  assert.deepEqual(await prRequestReviewers(gh.client, "o", "r", { number: 4, reviewers: ["ann", "cat"] }), {
    ok: true,
    changed: false,
  });
  assert.deepEqual(gh.calls[0].body, { reviewers: ["ann", "cat"] });
  const r = await prRequestReviewers(gh.client, "o", "r", { number: 5, reviewers: ["x"] });
  assert.equal(r.message, "Reviews may only be requested from collaborators.");
});

test("mark-ready resolves the PR's node id, then runs the mutation with it", async (t) => {
  const bodies: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const gh = fakeGitHub(t, {
    "POST /graphql": (c: FakeCall) => {
      const b = c.body as { query: string; variables: Record<string, unknown> };
      bodies.push(b);
      return b.query.startsWith("query")
        ? { data: { repository: { pullRequest: { id: "PR_kw1" } } } }
        : { data: { markPullRequestReadyForReview: { pullRequest: { number: 12 } } } };
    },
  });
  assert.deepEqual(await prMarkReady(gh.client, "o", "r", 12), { ok: true, changed: false });
  assert.deepEqual(bodies[0].variables, { owner: "o", repo: "r", n: 12 });
  assert.match(bodies[1].query, /markPullRequestReadyForReview/);
  assert.deepEqual(bodies[1].variables, { id: "PR_kw1" });
});

test("mark-ready on a PR GitHub can't resolve says so and runs no mutation", async (t) => {
  const gh = fakeGitHub(t, { "POST /graphql": { data: { repository: { pullRequest: null } } } });
  assert.deepEqual(await prMarkReady(gh.client, "o", "r", 12), {
    ok: false,
    changed: false,
    message: "Couldn't resolve the pull request to mark ready.",
  });
  assert.equal(gh.calls.length, 1);
});

test("mark-ready denied by a missing scope is an expected result", async (t) => {
  const gh = fakeGitHub(t, {
    "POST /graphql": { errors: [{ type: "FORBIDDEN", message: "Resource not accessible by integration" }] },
  });
  assert.deepEqual(await prMarkReady(gh.client, "o", "r", 12), {
    ok: false,
    changed: false,
    message: "Resource not accessible by integration",
    expected: true,
  });
});

// ── Create-PR support reads ──

test("branches come back flagged with the repository's default", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/branches?per_page=100`]: () => page([{ name: "main" }], `${R}/branches?page=2`),
    [`GET ${R}/branches?page=2`]: () => page([{ name: "develop" }, { name: "feat" }]),
    [`GET ${R}`]: { default_branch: "develop" },
  });
  assert.deepEqual(await prBranches(gh.client, "o", "r"), [
    { name: "main", isDefault: false },
    { name: "develop", isDefault: true },
    { name: "feat", isDefault: false },
  ]);
});

test("when the repository read fails, the default is taken to be main", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/branches?per_page=100`]: () => page([{ name: "main" }, { name: "x" }]),
    [`GET ${R}`]: () => reply(500, {}),
  });
  assert.deepEqual((await prBranches(gh.client, "o", "r")).map((b) => b.isDefault), [true, false]);
});

test("a failed branch list throws at the caller", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/branches?per_page=100`]: () => reply(401, {}),
    [`GET ${R}`]: {},
  });
  await assert.rejects(prBranches(gh.client, "o", "r"), /token is invalid/);
});

test("reviewers are the collaborators, and a 403 degrades to an empty list for free text", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/collaborators?per_page=100`]: () => page([{ login: "ann", avatar_url: "https://a/ann" }, { login: "bob" }]),
  });
  assert.deepEqual(await prReviewers(gh.client, "o", "r"), [
    { login: "ann", avatarUrl: "https://a/ann" },
    { login: "bob", avatarUrl: null },
  ]);
  gh.route(`GET ${R}/collaborators?per_page=100`, () => reply(403, { message: "Must have push access" }));
  assert.deepEqual(await prReviewers(gh.client, "o", "r"), []);
});

test("labels maps the repo's labels", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/labels?per_page=100`]: () => page([{ name: "bug", color: "f00", description: null }]),
  });
  assert.deepEqual(await labels(gh.client, "o", "r"), [{ name: "bug", color: "f00", description: null }]);
});

test("prefill proposes the default branch as base, or main when it can't be read", async (t) => {
  const gh = fakeGitHub(t, { [`GET ${R}`]: { default_branch: "trunk" } });
  assert.deepEqual(await prefill(gh.client, "o", "r"), { baseRef: "trunk" });
  gh.route(`GET ${R}`, {});
  assert.deepEqual(await prefill(gh.client, "o", "r"), { baseRef: "main" });
  gh.route(`GET ${R}`, () => reply(500, {}));
  assert.deepEqual(await prefill(gh.client, "o", "r"), { baseRef: "main" });
});

// ── Per-file diff ──

/** Routes for PR 9's file `src/a b.ts`: base read at the merge base, head at head. */
function diffRoutes(left: unknown, right: unknown, compare: unknown = { merge_base_commit: { sha: MB } }) {
  const file = "src/a%20b.ts";
  return {
    [`GET ${R}/pulls/9`]: rawPull(9),
    [`GET ${R}/compare/${BASE}...${HEAD}?per_page=1`]: compare,
    [`GET ${R}/contents/${file}?ref=${MB}`]: left,
    [`GET ${R}/contents/${file}?ref=${BASE}`]: left,
    [`GET ${R}/contents/${file}?ref=${HEAD}`]: right,
  };
}

test("a file's diff reads the base side at the merge base and the head side at head", async (t) => {
  const gh = fakeGitHub(
    t,
    diffRoutes({ encoding: "base64", content: b64("old\n"), size: 4 }, { encoding: "base64", content: b64("new\n"), size: 4 }),
  );
  const d = await fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" });
  assert.deepEqual(d, {
    path: "src/a b.ts",
    leftLabel: "base",
    rightLabel: "head",
    leftText: "old\n",
    rightText: "new\n",
    conflicted: false,
  });
  assert.ok(gh.calls.some((c) => c.path.endsWith(`?ref=${MB}`)), "the base side was read at the merge base");
  assert.ok(!gh.calls.some((c) => c.path.endsWith(`?ref=${BASE}`)), "not at the base branch's tip");
});

test("with no merge base from GitHub the base side falls back to the base tip", async (t) => {
  const gh = fakeGitHub(
    t,
    diffRoutes({ encoding: "base64", content: b64("tip\n") }, { encoding: "base64", content: b64("x\n") }, () => reply(404, {})),
  );
  const d = await fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" });
  assert.equal(d?.leftText, "tip\n");
  assert.ok(gh.calls.some((c) => c.path.endsWith(`?ref=${BASE}`)));
});

test("an empty merge-base answer also falls back to the base tip", async (t) => {
  const gh = fakeGitHub(
    t,
    diffRoutes({ encoding: "base64", content: b64("tip\n") }, { encoding: "base64", content: b64("x\n") }, { merge_base_commit: { sha: "" } }),
  );
  assert.equal((await fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" }))?.leftText, "tip\n");
});

test("a file added by the PR has an empty base side, not an error", async (t) => {
  const gh = fakeGitHub(
    t,
    diffRoutes(() => reply(404, { message: "Not Found" }), { encoding: "base64", content: b64("added\n") }),
  );
  const d = await fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" });
  assert.equal(d?.leftText, "");
  assert.equal(d?.rightText, "added\n");
  assert.equal(d?.binary, undefined);
});

test("a binary file is flagged binary, never two identical placeholder texts", async (t) => {
  const bin = new Uint8Array([0x89, 0x50, 0x00, 0x47]);
  const gh = fakeGitHub(
    t,
    diffRoutes({ encoding: "base64", content: b64(bin) }, { encoding: "base64", content: b64("text\n") }),
  );
  const d = await fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" });
  assert.equal(d?.binary, true);
  assert.equal(d?.leftText, "");
});

test("an oversized or un-inlined side is flagged truncated", async (t) => {
  const gh = fakeGitHub(t, diffRoutes({ size: 3 * 1024 * 1024 }, { encoding: "none", size: 10 }));
  const d = await fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" });
  assert.equal(d?.truncated, true);
  assert.equal(d?.leftText, "");
  assert.equal(d?.rightText, "");
});

test("a side served as plain (non-base64) content is used as-is", async (t) => {
  const gh = fakeGitHub(t, diffRoutes({ encoding: "utf-8", content: "raw text" }, { encoding: "base64", content: b64("y") }));
  const d = await fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" });
  assert.equal(d?.leftText, "raw text");
  assert.equal(d?.truncated, undefined);
});

test("a real failure reading a side throws, so the panel can offer Retry", async (t) => {
  const gh = fakeGitHub(t, diffRoutes(() => reply(401, {}), { encoding: "base64", content: b64("y") }));
  await assert.rejects(fileDiff(gh.client, "o", "r", { number: 9, path: "src/a b.ts" }), /token is invalid/);
});

// ── Review threads ──

test("review threads map their anchor, state and comments, with a ghost for a deleted author", async (t) => {
  const gh = fakeGitHub(t, {
    "POST /graphql": {
      data: {
        repository: {
          pullRequest: {
            reviewThreads: {
              nodes: [
                {
                  id: "T1",
                  path: "src/a.ts",
                  line: 12,
                  isResolved: false,
                  isOutdated: true,
                  comments: {
                    nodes: [
                      { id: "C1", author: { login: "ann", avatarUrl: "https://a/ann" }, body: "why?", createdAt: "2026-01-01" },
                      { id: "C2", author: null, body: "because", createdAt: "2026-01-02" },
                      null,
                    ],
                  },
                },
                { id: "T2", path: null, line: null, isResolved: true, isOutdated: false },
              ],
            },
          },
        },
      },
    },
  });
  const r = await reviewThreads(gh.client, "o", "r", 5);
  assert.deepEqual((gh.calls[0].body as { variables: unknown }).variables, { owner: "o", repo: "r", n: 5 });
  assert.equal(r.unreadable, 0);
  assert.deepEqual(r.threads[0], {
    id: "T1",
    path: "src/a.ts",
    line: 12,
    isResolved: false,
    isOutdated: true,
    comments: [
      { id: "C1", author: { login: "ann", avatarUrl: "https://a/ann" }, body: "why?", createdAt: "2026-01-01" },
      { id: "C2", author: { login: "ghost", avatarUrl: null }, body: "because", createdAt: "2026-01-02" },
    ],
  });
  assert.deepEqual(r.threads[1], { id: "T2", path: "", line: null, isResolved: true, isOutdated: false, comments: [] });
});

test("a PR with no review threads is an empty list", async (t) => {
  const gh = fakeGitHub(t, { "POST /graphql": { data: { repository: { pullRequest: { reviewThreads: { nodes: [] } } } } } });
  assert.deepEqual(await reviewThreads(gh.client, "o", "r", 5), { threads: [], unreadable: 0 });
});

// ── Inline review writes ──

test("an inline comment is anchored to the PR's head commit, on the right side by default", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/pulls/9`]: rawPull(9),
    [`POST ${R}/pulls/9/comments`]: () => reply(201, {}),
  });
  assert.deepEqual(await addReviewComment(gh.client, "o", "r", { number: 9, path: "a.ts", line: 3, body: "nit" }), {
    ok: true,
    changed: false,
  });
  await addReviewComment(gh.client, "o", "r", { number: 9, path: "a.ts", line: 2, side: "LEFT", body: "gone?" });
  const posts = gh.sent("POST", `${R}/pulls/9/comments`);
  assert.deepEqual(posts[0].body, { body: "nit", commit_id: HEAD, path: "a.ts", line: 3, side: "RIGHT" });
  assert.equal((posts[1].body as { side: string }).side, "LEFT");
});

test("an inline comment on a line outside the diff is GitHub's 422, as a result", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/pulls/9`]: rawPull(9),
    [`POST ${R}/pulls/9/comments`]: () => reply(422, { message: "line must be part of the diff" }),
  });
  assert.deepEqual(await addReviewComment(gh.client, "o", "r", { number: 9, path: "a.ts", line: 99, body: "x" }), {
    ok: false,
    changed: false,
    message: "line must be part of the diff",
  });
});

test("replying to a thread sends the thread id and body through GraphQL", async (t) => {
  const gh = fakeGitHub(t, { "POST /graphql": { data: { addPullRequestReviewThreadReply: { comment: { id: "C9" } } } } });
  assert.deepEqual(await replyThread(gh.client, "o", "r", { number: 9, threadId: "T1", body: "done" }), {
    ok: true,
    changed: false,
  });
  const b = gh.calls[0].body as { query: string; variables: unknown };
  assert.match(b.query, /addPullRequestReviewThreadReply/);
  assert.deepEqual(b.variables, { threadId: "T1", body: "done" });
});

test("a reply GitHub refuses is a result", async (t) => {
  const gh = fakeGitHub(t, { "POST /graphql": () => reply(502, {}) });
  const r = await replyThread(gh.client, "o", "r", { number: 9, threadId: "T1", body: "x" });
  assert.equal(r.ok, false);
  assert.equal(r.expected, true);
});

test("resolving and unresolving pick the matching mutation", async (t) => {
  const gh = fakeGitHub(t, { "POST /graphql": { data: {} } });
  await resolveThread(gh.client, "o", "r", { threadId: "T1", resolved: true });
  await resolveThread(gh.client, "o", "r", { threadId: "T1", resolved: false });
  const [a, b] = gh.calls.map((c) => (c.body as { query: string }).query);
  assert.match(a, /\bresolveReviewThread\b/);
  assert.match(b, /\bunresolveReviewThread\b/);
});

test("a thread id GitHub can't resolve is a reported (not expected) failure result", async (t) => {
  const gh = fakeGitHub(t, {
    "POST /graphql": { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'T9'." }] },
  });
  assert.deepEqual(await resolveThread(gh.client, "o", "r", { threadId: "T9", resolved: true }), {
    ok: false,
    changed: false,
    message: "Could not resolve to a node with the global id of 'T9'.",
  });
});

// ── Metadata writes ──

test("editing a PR sends only the fields given", async (t) => {
  const gh = fakeGitHub(t, { [`PATCH ${R}/pulls/2`]: {} });
  await edit(gh.client, "o", "r", { number: 2, title: "New" });
  await edit(gh.client, "o", "r", { number: 2, body: "" });
  assert.deepEqual(gh.calls.map((c) => c.body), [{ title: "New" }, { body: "" }]);
  gh.route(`PATCH ${R}/pulls/2`, () => reply(422, { message: "bad" }));
  assert.deepEqual(await edit(gh.client, "o", "r", { number: 2, title: "x" }), { ok: false, changed: false, message: "bad" });
});

test("a PR's labels are replaced through the issues endpoint", async (t) => {
  const gh = fakeGitHub(t, { [`PUT ${R}/issues/2/labels`]: [] });
  assert.deepEqual(await setLabels(gh.client, "o", "r", { number: 2, labels: ["a"] }), { ok: true, changed: false });
  assert.deepEqual(gh.calls[0].body, { labels: ["a"] });
  gh.route(`PUT ${R}/issues/2/labels`, () => reply(404, { message: "Not Found" }));
  assert.equal((await setLabels(gh.client, "o", "r", { number: 2, labels: ["a"] })).ok, false);
});

test("assignees are reconciled: only the missing are added and only the extra removed", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/issues/2`]: { assignees: [{ login: "ann" }, { login: "bob" }] },
    [`POST ${R}/issues/2/assignees`]: () => reply(201, {}),
    [`DELETE ${R}/issues/2/assignees`]: {},
  });
  assert.deepEqual(await setAssignees(gh.client, "o", "r", { number: 2, assignees: ["bob", "cat"] }), {
    ok: true,
    changed: false,
  });
  assert.deepEqual(gh.sent("POST", `${R}/issues/2/assignees`)[0].body, { assignees: ["cat"] });
  assert.deepEqual(gh.sent("DELETE", `${R}/issues/2/assignees`)[0].body, { assignees: ["ann"] });
});

test("assignees already as wanted send no writes at all", async (t) => {
  const gh = fakeGitHub(t, { [`GET ${R}/issues/2`]: {} });
  assert.deepEqual(await setAssignees(gh.client, "o", "r", { number: 2, assignees: [] }), { ok: true, changed: false });
  assert.equal(gh.calls.length, 1);
});

test("an assignee write GitHub refuses is a result", async (t) => {
  const gh = fakeGitHub(t, {
    [`GET ${R}/issues/2`]: { assignees: [] },
    [`POST ${R}/issues/2/assignees`]: () => reply(403, { message: "nope" }),
  });
  assert.deepEqual(await setAssignees(gh.client, "o", "r", { number: 2, assignees: ["x"] }), {
    ok: false,
    changed: false,
    message: "nope",
    expected: true,
  });
});

test("update-branch PUTs to the PR and surfaces 'already up to date' as a result", async (t) => {
  const gh = fakeGitHub(t, { [`PUT ${R}/pulls/2/update-branch`]: () => reply(202, { message: "Updating" }) });
  assert.deepEqual(await updateBranch(gh.client, "o", "r", 2), { ok: true, changed: false });
  assert.deepEqual(gh.calls[0].body, {});
  gh.route(`PUT ${R}/pulls/2/update-branch`, () => reply(422, { message: "There are no new commits on the base branch." }));
  assert.deepEqual(await updateBranch(gh.client, "o", "r", 2), {
    ok: false,
    changed: false,
    message: "There are no new commits on the base branch.",
  });
});
