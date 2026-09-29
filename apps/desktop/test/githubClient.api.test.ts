// GitHubClient against a fake api.github.com: what each call SENDS (method,
// path, headers, body) and what it makes of GitHub's answer — the paging
// rules, the failure policy (network / HTTP / GraphQL), and the PR + issue
// mappers the Pull Requests and Issues views render.

import { test } from "node:test";
import assert from "node:assert/strict";
import { fakeGitHub, page, reply } from "./ghFakeApi";
import { GitHubClient } from "../src/main/githubClient";
import { isExpectedError } from "../src/main/expectedError";

const pull = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `PR ${n}`,
  body: null,
  state: "open",
  html_url: `https://github.com/o/r/pull/${n}`,
  user: { login: "ann", avatar_url: "https://a/ann" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-02T00:00:00Z",
  head: { ref: "feat", sha: "h".repeat(40) },
  base: { ref: "main", sha: "b".repeat(40) },
  ...extra,
});

const issue = (n: number, extra: Record<string, unknown> = {}) => ({
  number: n,
  title: `Issue ${n}`,
  body: "text",
  state: "open",
  html_url: `https://github.com/o/r/issues/${n}`,
  user: { login: "bob" },
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-03T00:00:00Z",
  comments: 2,
  ...extra,
});

// ── The request primitives ──

test("every REST call carries the token, the API version and the JSON media type", async (t) => {
  const gh = fakeGitHub(t, { "GET /user": { login: "ann" } });
  assert.equal(await gh.client.currentLogin(), "ann");
  const h = gh.calls[0].headers;
  assert.equal(h.Authorization, "Bearer ghp_test");
  assert.equal(h.Accept, "application/vnd.github+json");
  assert.equal(h["X-GitHub-Api-Version"], "2022-11-28");
  assert.equal(h["User-Agent"], "GitStudio");
  assert.equal("Content-Type" in h, false, "a GET with no body declares no content type");
});

test("a body is sent as JSON with a content type, and a caller can ask for another media type", async (t) => {
  const gh = fakeGitHub(t, { "POST /x": { ok: 1 } });
  const out = await gh.client.request<{ ok: number }>("POST", "/x", { a: 1 }, { accept: "application/vnd.github.text-match+json" });
  assert.deepEqual(out, { ok: 1 });
  assert.deepEqual(gh.calls[0].body, { a: 1 });
  assert.equal(gh.calls[0].headers["Content-Type"], "application/json");
  assert.equal(gh.calls[0].headers.Accept, "application/vnd.github.text-match+json");
});

test("a 204 and an empty 200 both answer undefined rather than failing to parse", async (t) => {
  const gh = fakeGitHub(t, {
    "DELETE /a": () => reply(204),
    "GET /b": () => new Response("", { status: 200 }),
  });
  assert.equal(await gh.client.request("DELETE", "/a"), undefined);
  assert.equal(await gh.client.request("GET", "/b"), undefined);
});

test("with no token every primitive refuses as an expected 'not connected' before any request", async (t) => {
  const gh = fakeGitHub(t, {}, null);
  const attempts: Array<() => Promise<unknown>> = [
    () => gh.client.request("GET", "/user"),
    () => gh.client.requestBody("POST", "/x", {}),
    () => gh.client.graphql("query{viewer{login}}", {}),
    () => gh.client.uploadReleaseAsset("o", "r", 1, "a.zip", new Uint8Array([1]), "application/zip"),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (e: Error) => {
      assert.equal(e.message, "Not connected to GitHub.");
      assert.equal(isExpectedError(e), true);
      return true;
    });
  }
  assert.equal(gh.calls.length, 0, "nothing was sent without a token");
});

test("a request that never reaches GitHub is a network condition, not a TypeError", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /a": new TypeError("fetch failed"),
    "POST /b": new TypeError("fetch failed"),
    "POST /graphql": new TypeError("fetch failed"),
    "POST https://uploads.github.com/repos/o/r/releases/9/assets?name=a.zip": new TypeError("fetch failed"),
  });
  const attempts: Array<() => Promise<unknown>> = [
    () => gh.client.request("GET", "/a"),
    () => gh.client.requestBody("POST", "/b", {}),
    () => gh.client.graphql("q", {}),
    () => gh.client.uploadReleaseAsset("o", "r", 9, "a.zip", new Uint8Array([1]), "application/zip"),
  ];
  for (const attempt of attempts) {
    await assert.rejects(attempt(), (e: Error) => {
      assert.match(e.message, /Couldn't reach GitHub/);
      assert.equal(isExpectedError(e), true);
      return true;
    });
  }
});

test("a non-2xx answer becomes GitHub's own message, on every primitive", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /a": () => reply(422, { message: "Validation Failed" }),
    "PUT /b": () => reply(409, { message: "Merge conflict" }),
    "POST /graphql": () => reply(401, { message: "Bad credentials" }),
    "POST https://uploads.github.com/repos/o/r/releases/9/assets?name=a.zip": () => reply(422, { message: "already_exists" }),
  });
  await assert.rejects(gh.client.request("GET", "/a"), /Validation Failed/);
  await assert.rejects(gh.client.requestBody("PUT", "/b", {}), (e: Error) => e.message === "Merge conflict" && isExpectedError(e));
  await assert.rejects(gh.client.graphql("q", {}), /token is invalid or expired/);
  await assert.rejects(
    gh.client.uploadReleaseAsset("o", "r", 9, "a.zip", new Uint8Array([1]), "application/zip"),
    /already_exists/,
  );
});

test("requestBody sends the JSON body and ignores whatever comes back", async (t) => {
  const gh = fakeGitHub(t, { "PATCH /repos/o/r/issues/1": { number: 1 } });
  assert.equal(await gh.client.requestBody("PATCH", "/repos/o/r/issues/1", { state: "closed" }), undefined);
  assert.deepEqual(gh.calls[0].body, { state: "closed" });
  assert.equal(gh.calls[0].headers["Content-Type"], "application/json");
});

test("a release asset goes to uploads.github.com as raw bytes under its own content type", async (t) => {
  const key = "POST https://uploads.github.com/repos/my%20org/r/releases/77/assets?name=GitStudio%201.0.dmg";
  const gh = fakeGitHub(t, { [key]: () => reply(201, { id: 5 }) });
  const bytes = new Uint8Array([1, 2, 3]);
  await gh.client.uploadReleaseAsset("my org", "r", 77, "GitStudio 1.0.dmg", bytes, "application/x-apple-diskimage");
  assert.deepEqual(gh.unmatched, [], "owner and asset name are URL-encoded");
  assert.equal(gh.calls[0].body, bytes, "the bytes are sent as they are, not JSON-encoded");
  assert.equal(gh.calls[0].headers["Content-Type"], "application/x-apple-diskimage");
  assert.equal(gh.calls[0].headers.Authorization, "Bearer ghp_test");
});

// ── Paging ──

test("requestPaged follows rel=next and concatenates the pages", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /l?per_page=2": () => page([1, 2], "/l?per_page=2&page=2"),
    "GET /l?per_page=2&page=2": () => page([3, 4], "/l?per_page=2&page=3"),
    "GET /l?per_page=2&page=3": () => page([5]),
  });
  assert.deepEqual(await gh.client.requestPaged<number>("/l?per_page=2", 5), [1, 2, 3, 4, 5]);
  assert.equal(gh.calls.length, 3, "and stops where the link chain ends");
});

test("requestPaged stops at the page cap even when GitHub offers more", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /l": () => page([1], "/l2"),
    "GET /l2": () => page([2], "/l3"),
    "GET /l3": () => page([3]),
  });
  assert.deepEqual(await gh.client.requestPaged<number>("/l", 2), [1, 2]);
  assert.equal(gh.calls.length, 2);
});

test("a failed follow-up page keeps what was already read; a failed first page throws", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /l": () => page(["a", "b"], "/l2"),
    "GET /l2": () => reply(502, { message: "Bad gateway" }),
    "GET /bad": () => reply(500, { message: "boom" }),
  });
  assert.deepEqual(await gh.client.requestPaged<string>("/l", 3), ["a", "b"]);
  await assert.rejects(gh.client.requestPaged("/bad", 3), /boom/);
});

test("an empty page body reads as no items", async (t) => {
  const gh = fakeGitHub(t, { "GET /l": () => new Response("", { status: 200 }) });
  assert.deepEqual(await gh.client.requestPaged("/l", 3), []);
});

test("requestPagedKey gathers the named array out of object-bodied pages", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /runs": () => page({ total_count: 3, workflow_runs: [{ id: 1 }, { id: 2 }] }, "/runs?page=2"),
    "GET /runs?page=2": () => page({ total_count: 3, workflow_runs: [{ id: 3 }] }, "/runs?page=3"),
    "GET /runs?page=3": () => reply(503, {}),
    "GET /none": () => page({ total_count: 0 }),
    "GET /empty": () => new Response("", { status: 200 }),
    "GET /bad": () => reply(500, {}),
  });
  assert.deepEqual(await gh.client.requestPagedKey("/runs", "workflow_runs", 5), [{ id: 1 }, { id: 2 }, { id: 3 }]);
  assert.deepEqual(await gh.client.requestPagedKey("/none", "workflow_runs", 5), [], "a missing key is no items");
  assert.deepEqual(await gh.client.requestPagedKey("/empty", "workflow_runs", 5), []);
  await assert.rejects(gh.client.requestPagedKey("/bad", "workflow_runs", 5), /HTTP 500/);
});

// ── GraphQL ──

test("graphql posts the query and variables and returns data", async (t) => {
  const gh = fakeGitHub(t, { "POST /graphql": { data: { viewer: { login: "ann" } } } });
  const data = await gh.client.graphql<{ viewer: { login: string } }>("query($a:Int){viewer{login}}", { a: 1 });
  assert.equal(data.viewer.login, "ann");
  assert.deepEqual(gh.calls[0].body, { query: "query($a:Int){viewer{login}}", variables: { a: 1 } });
  assert.equal(gh.calls[0].headers.Authorization, "Bearer ghp_test");
});

test("a GraphQL error in a 200 body throws, and a rate limit is an expected condition", async (t) => {
  const gh = fakeGitHub(t, {
    "POST /graphql": { data: null, errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] },
  });
  await assert.rejects(gh.client.graphql("q", {}), (e: Error) => {
    assert.equal(e.message, "API rate limit exceeded");
    assert.equal(isExpectedError(e), true);
    return true;
  });
});

// ── User ──

test("currentLogin answers undefined rather than throwing when GitHub refuses", async (t) => {
  const gh = fakeGitHub(t, { "GET /user": () => reply(401, { message: "Bad credentials" }) });
  assert.equal(await gh.client.currentLogin(), undefined);
});

// ── Pull requests ──

test("listPulls asks for the state newest-updated first and maps every page", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/pulls?state=closed&sort=updated&direction=desc&per_page=100": () =>
      page([pull(3, { merged_at: "2026-02-01T00:00:00Z" })], "/repos/o/r/pulls?page=2"),
    "GET /repos/o/r/pulls?page=2": () => page([pull(2, { draft: true })]),
  });
  const prs = await gh.client.listPulls("o", "r", "closed");
  assert.deepEqual(prs.map((p) => p.number), [3, 2]);
  assert.equal(prs[0].mergedAt, "2026-02-01T00:00:00Z");
  assert.equal(prs[1].draft, true);
  assert.equal(prs[0].user?.login, "ann");
});

test("listPulls defaults to open pulls", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/pulls?state=open&sort=updated&direction=desc&per_page=100": () => page([pull(1)]),
  });
  assert.equal((await gh.client.listPulls("o", "r"))[0].title, "PR 1");
});

test("getPull maps one pull request, including a fork's head repository", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/pulls/9": pull(9, {
      head: { ref: "fix", sha: "1".repeat(40), repo: { full_name: "fork/r" } },
      base: { ref: "main", sha: "2".repeat(40), repo: { full_name: "o/r" } },
    }),
  });
  const p = await gh.client.getPull("o", "r", 9);
  assert.equal(p.number, 9);
  assert.equal(p.headRepoFullName, "fork/r");
  assert.deepEqual(p.head, { ref: "fix", sha: "1".repeat(40) });
});

test("getPullFiles keeps where a renamed file came from, and nothing extra on the rest", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/pulls/4/files?per_page=100": () =>
      page([
        { filename: "new.ts", status: "renamed", additions: 1, deletions: 0, previous_filename: "old.ts" },
        { filename: "a.ts", status: "modified", additions: 3, deletions: 2 },
      ]),
  });
  const files = await gh.client.getPullFiles("o", "r", 4);
  assert.deepEqual(files, [
    { filename: "new.ts", status: "renamed", additions: 1, deletions: 0, previousFilename: "old.ts" },
    { filename: "a.ts", status: "modified", additions: 3, deletions: 2 },
  ]);
});

test("mergePull PUTs the chosen method and approvePull posts an APPROVE review", async (t) => {
  const gh = fakeGitHub(t, {
    "PUT /repos/o/r/pulls/5/merge": { merged: true },
    "POST /repos/o/r/pulls/5/reviews": { id: 1 },
  });
  await gh.client.mergePull("o", "r", 5, "squash");
  await gh.client.approvePull("o", "r", 5);
  assert.deepEqual(gh.sent("PUT", "/repos/o/r/pulls/5/merge")[0].body, { merge_method: "squash" });
  assert.deepEqual(gh.sent("POST", "/repos/o/r/pulls/5/reviews")[0].body, { event: "APPROVE" });
});

test("listPrCommits splits subject from body and flags signed and merge commits", async (t) => {
  const sha1 = "a".repeat(40);
  const sha2 = "b".repeat(40);
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/pulls/6/commits?per_page=100": () =>
      page([
        {
          sha: sha1,
          commit: {
            message: "Fix the parser\n\nIt re-read the block.\n",
            author: { name: "Ann A", date: "2026-03-01T00:00:00Z" },
            verification: { verified: true },
          },
          author: { login: "ann", avatar_url: "https://a/ann" },
          parents: [{ sha: "p" }],
        },
        { sha: sha2, commit: { message: "Merge main" }, author: null, parents: [{ sha: "p" }, { sha: "q" }] },
        { sha: "c".repeat(40), author: { login: "cat" } },
      ]),
  });
  const [a, b, c] = await gh.client.listPrCommits("o", "r", 6);
  assert.deepEqual(a, {
    sha: sha1,
    shortSha: "aaaaaaa",
    message: "Fix the parser",
    body: "It re-read the block.",
    author: "Ann A",
    login: "ann",
    avatarUrl: "https://a/ann",
    date: "2026-03-01T00:00:00Z",
    verified: true,
    isMerge: false,
  });
  assert.equal(b.message, "Merge main");
  assert.equal(b.body, "", "a one-line message has no body");
  assert.equal(b.author, "unknown", "no git author and no account");
  assert.equal(b.isMerge, true, "two parents is a merge");
  assert.equal(b.verified, false);
  assert.equal(c.author, "cat", "the account's login stands in for a missing git author");
  assert.equal(c.message, "");
  assert.equal(c.date, "");
});

test("the conversation interleaves comments and submitted reviews by time, dropping pending ones", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/issues/8/comments?per_page=100": () =>
      page([
        {
          id: 11,
          user: { login: "ann" },
          body: "second",
          created_at: "2026-01-02T00:00:00Z",
          updated_at: "2026-01-02T01:00:00Z",
          author_association: "OWNER",
          reactions: { total_count: 1, heart: 1 },
          html_url: "https://github.com/o/r/pull/8#c11",
        },
        { id: 12, user: null, created_at: "2026-01-04T00:00:00Z" },
      ]),
    "GET /repos/o/r/pulls/8/reviews?per_page=100": () =>
      page([
        { user: { login: "rev" }, body: "lgtm", state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z" },
        { user: { login: "rev" }, body: "draft", state: "PENDING" },
        { user: null, state: "COMMENTED", submitted_at: "2026-01-03T00:00:00Z" },
      ]),
  });
  const conv = await gh.client.listConversation("o", "r", 8);
  assert.deepEqual(
    conv.map((c) => [c.kind, c.author, c.body]),
    [
      ["review", "rev", "lgtm"],
      ["comment", "ann", "second"],
      ["review", "unknown", ""],
      ["comment", "unknown", ""],
    ],
  );
  assert.equal(conv[0].state, "APPROVED");
  assert.equal(conv[1].id, 11);
  assert.equal(conv[1].authorAssociation, "OWNER");
  assert.equal(conv[1].reactions?.heart, 1);
  assert.equal(conv[1].htmlUrl, "https://github.com/o/r/pull/8#c11");
  assert.equal(conv[1].updatedAt, "2026-01-02T01:00:00Z");
});

test("the conversation still shows reviews when the comments read fails, and vice versa", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/issues/8/comments?per_page=100": () => reply(500, {}),
    "GET /repos/o/r/pulls/8/reviews?per_page=100": () =>
      page([{ user: { login: "rev" }, body: "ok", state: "APPROVED", submitted_at: "2026-01-01T00:00:00Z" }]),
  });
  assert.deepEqual((await gh.client.listConversation("o", "r", 8)).map((c) => c.kind), ["review"]);
});

test("listCheckRuns maps runs at the ref, and degrades to none when the read fails", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/commits/feat%2Fx/check-runs?per_page=100": {
      check_runs: [
        { name: "build", status: "completed", conclusion: "success", details_url: "https://ci/1" },
        { name: "lint" },
      ],
    },
    "GET /repos/o/r/commits/gone/check-runs?per_page=100": () => reply(404, { message: "No commit found" }),
    "GET /repos/o/r/commits/empty/check-runs?per_page=100": {},
  });
  assert.deepEqual(await gh.client.listCheckRuns("o", "r", "feat/x"), [
    { name: "build", status: "completed", conclusion: "success", detailsUrl: "https://ci/1" },
    { name: "lint", status: "", conclusion: "", detailsUrl: undefined },
  ]);
  assert.deepEqual(await gh.client.listCheckRuns("o", "r", "gone"), []);
  assert.deepEqual(await gh.client.listCheckRuns("o", "r", "empty"), []);
});

test("getCombinedStatus reads state and count, and a failure reads as no status", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/commits/abc/status": { state: "pending", total_count: 3 },
    "GET /repos/o/r/commits/blank/status": {},
    "GET /repos/o/r/commits/bad/status": () => reply(500, {}),
  });
  assert.deepEqual(await gh.client.getCombinedStatus("o", "r", "abc"), { state: "pending", totalCount: 3 });
  assert.deepEqual(await gh.client.getCombinedStatus("o", "r", "blank"), { state: "", totalCount: 0 });
  assert.deepEqual(await gh.client.getCombinedStatus("o", "r", "bad"), { state: "", totalCount: 0 });
});

// ── Issues ──

test("listOpenIssues drops the pull requests the issues endpoint also returns", async (t) => {
  const gh = fakeGitHub(t, {
    "GET /repos/o/r/issues?state=open&sort=updated&direction=desc&per_page=100": () =>
      page([issue(1), issue(2, { pull_request: { url: "x" } }), issue(3, { labels: ["bug", { name: "ui", color: "00ff00" }] })]),
  });
  const list = await gh.client.listOpenIssues("o", "r");
  assert.deepEqual(list.map((i) => i.number), [1, 3]);
  assert.deepEqual(list[1].labels, [
    { name: "bug", color: "888888" },
    { name: "ui", color: "00ff00" },
  ]);
});

test("getIssue maps one issue", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/o/r/issues/7": issue(7, { state: "closed", state_reason: "not_planned" }) });
  const i = await gh.client.getIssue("o", "r", 7);
  assert.equal(i.number, 7);
  assert.equal(i.stateReason, "not_planned");
  assert.equal(i.user?.login, "bob");
});

test("owner and repo are URL-encoded into every path", async (t) => {
  const gh = fakeGitHub(t, { "GET /repos/a%20b/c%23d/issues/1": issue(1) });
  await gh.client.getIssue("a b", "c#d", 1);
  assert.deepEqual(gh.unmatched, []);
});

test("an empty token is not a connection", async () => {
  const c = new GitHubClient(() => "");
  await assert.rejects(c.request("GET", "/user"), /Not connected/);
});
