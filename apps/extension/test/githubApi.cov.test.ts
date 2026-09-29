// GitHubApi (src/pr/githubApi.ts) against a fake api.github.com: what each
// call asks GitHub (method, path, body, headers), what it makes of GitHub's
// answer, and the sentence every kind of failure turns into. No network: the
// fake replaces globalThis.fetch and refuses any other host.

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub JSON, read field by field */
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GitHubApi, GitHubApiError, PAGE_CAPS, nextPageUrl } from "../src/pr/githubApi";
import { installFakeGitHub, linkHeader, rawPull, type FakeGitHub, type Route } from "./fakeGitHub";

let fake: FakeGitHub | undefined;
afterEach(() => {
  fake?.restore();
  fake = undefined;
});

function gh(routes: Route[]): FakeGitHub {
  fake = installFakeGitHub(routes);
  return fake;
}

/** An API signed in as "tok"; `asked` records every token request's interactivity. */
function api(token: string | undefined = "tok") {
  const asked: (boolean | undefined)[] = [];
  const a = new GitHubApi({
    getToken: async (o) => {
      asked.push(o?.interactive);
      return token;
    },
  });
  return { a, asked };
}

async function rejects(p: Promise<unknown>): Promise<GitHubApiError> {
  try {
    await p;
  } catch (err) {
    assert.ok(err instanceof GitHubApiError, `expected a GitHubApiError, got ${String(err)}`);
    return err;
  }
  assert.fail("expected the call to fail");
}

// ── Requests: headers, auth, the network ───────────────────────────────────

test("a request carries the bearer token, GitHub's media type and API version", async () => {
  const f = gh([["GET", /^\/repos\/acme\/app\/pulls\/5$/, () => ({ body: rawPull(5) })]]);
  const { a, asked } = api("s3cret");
  const p = await a.getPull("acme", "app", 5);
  assert.equal(p.number, 5);
  const h = f.requests[0].headers;
  assert.equal(h.authorization, "Bearer s3cret");
  assert.equal(h.accept, "application/vnd.github+json");
  assert.equal(h["x-github-api-version"], "2022-11-28");
  assert.equal(h["content-type"], undefined, "a GET has no body, so no content type");
  assert.deepEqual(asked, [false], "a read never pops a sign-in");
});

test("with no token nothing is sent, and the failure asks to connect GitHub", async () => {
  const f = gh([]);
  const { a } = api("");
  const e = await rejects(a.getPull("acme", "app", 1));
  assert.equal(e.kind, "auth");
  assert.equal(e.status, 401);
  assert.match(e.message, /Connect GitHub/);
  assert.equal(f.requests.length, 0);
});

test("a fetch that throws is a network failure in the user's words", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  try {
    const e = await rejects(api().a.getPull("acme", "app", 1));
    assert.equal(e.kind, "network");
    assert.match(e.message, /Couldn't reach GitHub/);
  } finally {
    globalThis.fetch = original;
  }
});

test("an aborted fetch is passed through as the AbortError it is, not a network failure", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    const e = new Error("The operation was aborted");
    e.name = "AbortError";
    throw e;
  }) as typeof fetch;
  try {
    await assert.rejects(api().a.graphqlRaw("{ viewer { login } }", {}), (err: Error) => err.name === "AbortError" && !(err instanceof GitHubApiError));
  } finally {
    globalThis.fetch = original;
  }
});

// ── Errors: status → kind and sentence ─────────────────────────────────────

test("401 is an expired session", async () => {
  gh([["GET", /./, () => ({ status: 401, body: { message: "Bad credentials" } })]]);
  const e = await rejects(api().a.getPull("acme", "app", 1));
  assert.deepEqual([e.kind, e.status], ["auth", 401]);
  assert.match(e.message, /session expired/);
});

test("429 with Retry-After says when to try again, counted from now", async () => {
  gh([["GET", /./, () => ({ status: 429, body: { message: "slow down" }, headers: { "retry-after": "60" } })]]);
  const before = Date.now();
  const e = await rejects(api().a.getPull("acme", "app", 1));
  assert.deepEqual([e.kind, e.status], ["rate-limit", 429]);
  const expected = new Date(before + 60_000).toLocaleTimeString();
  const later = new Date(Date.now() + 60_000).toLocaleTimeString();
  assert.ok(e.message === `GitHub rate limit reached. Try again after ${expected}.` || e.message === `GitHub rate limit reached. Try again after ${later}.`, e.message);
});

test("403 with no requests remaining is the rate limit, retried at the reset time", async () => {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  gh([["GET", /./, () => ({ status: 403, body: { message: "API rate limit exceeded" }, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } })]]);
  const e = await rejects(api().a.getPull("acme", "app", 1));
  assert.deepEqual([e.kind, e.status], ["rate-limit", 403]);
  assert.equal(e.message, `GitHub rate limit reached. Try again after ${new Date(reset * 1000).toLocaleTimeString()}.`);
});

test("a 403 that only SAYS rate limit, with no reset header, says 'a few minutes'", async () => {
  gh([["GET", /./, () => ({ status: 403, body: { message: "You have exceeded a secondary rate limit" } })]]);
  const e = await rejects(api().a.getPull("acme", "app", 1));
  assert.equal(e.kind, "rate-limit");
  assert.match(e.message, /a few minutes/);
});

test("a 403 from SAML SSO is refused access, with GitHub's authorize page as the way out", async () => {
  gh([
    [
      "GET",
      /./,
      () => ({ status: 403, body: { message: "Resource protected by organization SAML enforcement." }, headers: { "x-github-sso": "required; url=https://github.com/orgs/acme/sso?authorization_request=abc" } }),
    ],
  ]);
  const e = await rejects(api().a.getPull("acme", "app", 1));
  assert.deepEqual([e.kind, e.status], ["auth", 403]);
  assert.equal(e.helpUrl, "https://github.com/orgs/acme/sso?authorization_request=abc");
  assert.match(e.message, /SAML/);
});

test("a bare 403 with a non-JSON body falls back to 'insufficient permissions'", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => new Response("<html>nope</html>", { status: 403 })) as typeof fetch;
  try {
    const e = await rejects(api().a.getPull("acme", "app", 1));
    assert.deepEqual([e.kind, e.status, e.helpUrl], ["auth", 403, undefined]);
    assert.match(e.message, /insufficient permissions/);
  } finally {
    globalThis.fetch = original;
  }
});

test("404 keeps GitHub's message, or says 'Not found' when there is none", async () => {
  gh([
    ["GET", /pulls\/1$/, () => ({ status: 404, body: { message: "Not Found" } })],
    ["GET", /pulls\/2$/, () => ({ status: 404, body: {} })],
  ]);
  const one = await rejects(api().a.getPull("acme", "app", 1));
  assert.deepEqual([one.kind, one.status, one.message], ["not-found", 404, "Not Found"]);
  const two = await rejects(api().a.getPull("acme", "app", 2));
  assert.equal(two.message, "Not found on GitHub.");
});

test("422 names what GitHub refused, from string and object errors alike", async () => {
  gh([
    [
      "POST",
      /pulls$/,
      () => ({
        status: 422,
        body: { message: "Validation Failed", errors: ["No commits between main and x", { resource: "PullRequest", field: "head", code: "invalid" }, { message: "" }] },
      }),
    ],
    ["PUT", /merge$/, () => ({ status: 422, body: { message: "Unprocessable Entity" } })],
  ]);
  const e = await rejects(api().a.createPull("acme", "app", { title: "t", head: "x", base: "main" }));
  assert.deepEqual([e.kind, e.status], ["validation", 422]);
  assert.equal(e.message, "Validation Failed: No commits between main and x; PullRequest head invalid");
  const bare = await rejects(api().a.mergePull("acme", "app", 1, "merge"));
  assert.equal(bare.message, "GitHub rejected the request.");
});

test("any other status is a server failure naming the HTTP status", async () => {
  gh([
    ["GET", /pulls\/1$/, () => ({ status: 502, body: {} })],
    ["GET", /pulls\/2$/, () => ({ status: 500, body: { message: "Server Error" } })],
  ]);
  const e = await rejects(api().a.getPull("acme", "app", 1));
  assert.deepEqual([e.kind, e.status, e.message], ["server", 502, "GitHub request failed (HTTP 502)."]);
  const m = await rejects(api().a.getPull("acme", "app", 2));
  assert.equal(m.message, "Server Error");
});

// ── Paging ─────────────────────────────────────────────────────────────────

test("nextPageUrl follows only api.github.com, and only rel=next", () => {
  assert.equal(nextPageUrl(null), undefined);
  assert.equal(nextPageUrl('<https://api.github.com/x?page=3>; rel="last"'), undefined);
  assert.equal(nextPageUrl('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'), "https://api.github.com/x?page=2");
  assert.equal(nextPageUrl('<https://evil.example/x?page=2>; rel="next"'), undefined);
});

test("a PR's files are read across every Link page and mapped field by field", async () => {
  const path = "/repos/acme/app/pulls/9/files?per_page=100";
  const f = gh([
    [
      "GET",
      /\/pulls\/9\/files/,
      (req) => {
        const page = Number(/[?&]page=(\d+)$/.exec(req.path)?.[1] ?? 1);
        const body =
          page === 1
            ? [{ filename: "a.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@" }]
            : [{ filename: "new.ts", previous_filename: "old.ts", status: "renamed" }];
        return { body, headers: linkHeader(path, page, 2) };
      },
    ],
  ]);
  const got = await api().a.getPullFiles("acme", "app", 9);
  assert.equal(f.requests.length, 2);
  assert.equal(got.truncated, false);
  assert.deepEqual(got.items, [
    { filename: "a.ts", status: "modified", additions: 2, deletions: 1, changes: 3, patch: "@@" },
    { filename: "new.ts", previousFilename: "old.ts", status: "renamed", additions: 0, deletions: 0, changes: 0 },
  ]);
});

test("a list with more pages than its cap stops there and says it is truncated", async () => {
  const path = "/repos/acme/app/pulls?state=open&sort=updated&direction=desc&per_page=100";
  const f = gh([
    [
      "GET",
      /\/pulls\?state=open/,
      (req) => {
        const page = Number(/[?&]page=(\d+)$/.exec(req.path)?.[1] ?? 1);
        return { body: [rawPull(page)], headers: linkHeader(path, page, 99) };
      },
    ],
  ]);
  const got = await api().a.listOpenPulls("acme", "app");
  assert.equal(f.requests.length, PAGE_CAPS.pulls);
  assert.equal(got.items.length, PAGE_CAPS.pulls);
  assert.equal(got.truncated, true);
});

test("an aborted signal stops a paged read before it asks", async () => {
  const f = gh([["GET", /./, () => ({ body: [] })]]);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(api().a.listOpenPulls("acme", "app", { signal: ac.signal }));
  assert.equal(f.requests.length, 0);
});

// ── Reads ──────────────────────────────────────────────────────────────────

test("currentLogin maps /user, and answers undefined (not a throw) when signed out or refused", async () => {
  gh([["GET", /^\/user$/, () => ({ body: { login: "octo", avatar_url: "https://a/x.png", html_url: "https://github.com/octo" } })]]);
  const { a, asked } = api();
  assert.deepEqual(await a.currentLogin(true), { login: "octo", avatarUrl: "https://a/x.png", htmlUrl: "https://github.com/octo" });
  assert.deepEqual(asked, [true], "an interactive login may pop the sign-in");
  fake!.routes.splice(0, 1, ["GET", /^\/user$/, () => ({ status: 401, body: {} })]);
  assert.equal(await a.currentLogin(), undefined);
});

test("repoSettings lists only the merge methods the repository allows", async () => {
  gh([
    ["GET", /^\/repos\/acme\/app$/, () => ({ body: { default_branch: "trunk", allow_merge_commit: false, allow_squash_merge: true } })],
    ["GET", /^\/repos\/acme\/all$/, () => ({ body: { default_branch: "main" } })],
  ]);
  const a = api().a;
  assert.deepEqual(await a.repoSettings("acme", "app"), { defaultBranch: "trunk", mergeMethods: ["squash", "rebase"] });
  assert.deepEqual(await a.repoSettings("acme", "all"), { defaultBranch: "main", mergeMethods: ["merge", "squash", "rebase"] });
  assert.equal(await a.defaultBranch("acme", "app"), "trunk");
});

test("defaultBranch is best-effort: a failure answers undefined", async () => {
  gh([["GET", /./, () => ({ status: 404, body: { message: "Not Found" } })]]);
  assert.equal(await api().a.defaultBranch("acme", "gone"), undefined);
});

test("commitAuthorAvatars keys avatars by lower-cased commit email, at a ref when given", async () => {
  const f = gh([
    [
      "GET",
      /\/commits\?/,
      () => ({
        body: [
          { commit: { author: { email: "Alice@Example.COM" } }, author: { login: "alice", avatar_url: "https://a/alice.png" } },
          { commit: { author: { email: "ghost@example.com" } }, author: null },
          { commit: null, author: { login: "x", avatar_url: "https://a/x.png" } },
        ],
      }),
    ],
  ]);
  const a = api().a;
  assert.deepEqual(await a.commitAuthorAvatars("acme", "app", "feat/x"), { "alice@example.com": "https://a/alice.png" });
  assert.equal(f.requests[0].path, "/repos/acme/app/commits?sha=feat%2Fx&per_page=100");
  await a.commitAuthorAvatars("acme", "app");
  assert.equal(f.requests[1].path, "/repos/acme/app/commits?per_page=100");
});

test("findOpenPullForHead asks for the one open PR of that head, or none", async () => {
  const f = gh([
    ["GET", /head=acme%3Ahas/, () => ({ body: [rawPull(4)] })],
    ["GET", /head=acme%3Anone/, () => ({ body: [] })],
  ]);
  const a = api().a;
  assert.equal((await a.findOpenPullForHead("acme", "app", "acme:has"))?.number, 4);
  assert.equal(await a.findOpenPullForHead("acme", "app", "acme:none"), undefined);
  assert.match(f.requests[0].path, /state=open&head=acme%3Ahas&per_page=1$/);
});

test("getPull maps a fork's head, labels, reviewers and a missing author", async () => {
  gh([
    [
      "GET",
      /pulls\/8$/,
      () => ({
        body: rawPull(8, {
          user: null,
          draft: undefined,
          merged_at: undefined,
          maintainer_can_modify: true,
          head: { ref: "main", sha: "h", label: "alice:main", repo: { full_name: "alice/app", clone_url: "https://github.com/alice/app.git" } },
          base: { ref: "main", sha: "b", repo: null },
          labels: [{ name: "bug", color: "d73a4a", id: 1 }],
          requested_reviewers: [{ login: "bob" }],
          additions: 3,
          deletions: 1,
          changed_files: 2,
        }),
      }),
    ],
  ]);
  const p = await api().a.getPull("acme", "app", 8);
  assert.equal(p.user, null);
  assert.equal(p.draft, false);
  assert.equal(p.mergedAt, null);
  assert.equal(p.maintainerCanModify, true);
  assert.deepEqual(p.head, { ref: "main", sha: "h", label: "alice:main", repoFullName: "alice/app", cloneUrl: "https://github.com/alice/app.git" });
  assert.deepEqual(p.base, { ref: "main", sha: "b", label: "main", repoFullName: null, cloneUrl: null });
  assert.deepEqual(p.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(p.requestedReviewers, [{ login: "bob", avatarUrl: null, htmlUrl: null }]);
  assert.deepEqual([p.additions, p.deletions, p.changedFiles], [3, 1, 2]);
});

test("mergeBase reads the compare answer's merge base, and nothing when GitHub gives none", async () => {
  const f = gh([
    ["GET", /compare\/main\.\.\.h1/, () => ({ body: { merge_base_commit: { sha: "mb1" } } })],
    ["GET", /compare\/main\.\.\.h2/, () => ({ body: { merge_base_commit: { sha: "" } } })],
    ["GET", /compare\/main\.\.\.h3/, () => ({ body: { merge_base_commit: null } })],
  ]);
  const a = api().a;
  assert.equal(await a.mergeBase("acme", "app", "main", "h1"), "mb1");
  assert.equal(await a.mergeBase("acme", "app", "main", "h2"), undefined);
  assert.equal(await a.mergeBase("acme", "app", "main", "h3"), undefined);
  assert.match(f.requests[0].path, /\?per_page=1$/);
});

test("getCi combines check runs and legacy statuses", async () => {
  const f = gh([
    ["GET", /\/check-runs/, () => ({ body: { total_count: 2, check_runs: [{ status: "completed", conclusion: "success" }, { status: "in_progress", conclusion: null }] } })],
    ["GET", /\/status\?/, () => ({ body: { state: "success", statuses: [{ state: "success" }] } })],
  ]);
  assert.deepEqual(await api().a.getCi("acme", "app", "abc"), { state: "pending", total: 3, failed: 0, pending: 1 });
  assert.deepEqual(f.requests.map((r) => r.path).sort(), ["/repos/acme/app/commits/abc/check-runs?per_page=100", "/repos/acme/app/commits/abc/status?per_page=100"]);

  fake!.routes.splice(1, 1, ["GET", /\/status\?/, () => ({ body: { statuses: [{ state: "error" }] } })]);
  assert.equal((await api().a.getCi("acme", "app", "abc")).state, "failure");
});

test("getCi with no runs and no statuses is 'none'", async () => {
  gh([
    ["GET", /\/check-runs/, () => ({ body: { check_runs: [] } })],
    ["GET", /\/status\?/, () => ({ body: {} })],
  ]);
  assert.deepEqual(await api().a.getCi("acme", "app", "abc"), { state: "none", total: 0, failed: 0, pending: 0 });
});

test("ciForPulls asks GraphQL once per 50 valid PRs and maps each rollup", async () => {
  const numbers = Array.from({ length: 60 }, (_, i) => i + 1);
  const f = gh([
    [
      "POST",
      /^\/graphql$/,
      (req) => {
        const q = String((req.body as any).query);
        const asked = [...q.matchAll(/pr(\d+): pullRequest/g)].map((m) => Number(m[1]));
        const repository: Record<string, unknown> = {};
        for (const n of asked) {
          if (n === 2) continue; // absent from the answer
          const state = n === 1 ? "FAILURE" : n === 3 ? null : n === 51 ? "PENDING" : "SUCCESS";
          repository[`pr${n}`] = { commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] } };
        }
        return { body: { data: { repository } } };
      },
    ],
  ]);
  const got = await api().a.ciForPulls("acme", "app", [...numbers, -1, 1.5]);
  const posts = f.requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 2);
  assert.deepEqual((posts[0].body as any).variables, { owner: "acme", name: "app" });
  assert.equal([...String((posts[1].body as any).query).matchAll(/pullRequest\(/g)].length, 10, "the second batch has the last 10 (and never -1 or 1.5)");
  assert.equal(got.get(1), "failure");
  assert.equal(got.has(2), false);
  assert.equal(got.get(3), "none");
  assert.equal(got.get(4), "success");
  assert.equal(got.get(51), "pending");
  assert.equal(got.size, 59);
});

test("ciForPulls with nothing valid to ask asks nothing", async () => {
  const f = gh([]);
  const got = await api().a.ciForPulls("acme", "app", [0, -2]);
  assert.equal(got.size, 0);
  assert.equal(f.requests.length, 0);
});

test("ciForPulls throws GraphQL's own error when GitHub answers no data", async () => {
  gh([["POST", /^\/graphql$/, () => ({ body: { errors: [{ message: "Something went wrong while executing your query." }] } })]]);
  const e = await rejects(api().a.ciForPulls("acme", "app", [1]));
  assert.equal(e.kind, "server");
  assert.equal(e.message, "Something went wrong while executing your query.");
  fake!.routes.splice(0, 1, ["POST", /^\/graphql$/, () => ({ body: {} })]);
  const bare = await rejects(api().a.ciForPulls("acme", "app", [1]));
  assert.equal(bare.message, "GitHub couldn't answer the query.");
});

test("ciForPulls stops between batches once its signal aborts", async () => {
  const ac = new AbortController();
  const f = gh([
    [
      "POST",
      /^\/graphql$/,
      () => {
        ac.abort();
        return { body: { data: { repository: {} } } };
      },
    ],
  ]);
  await assert.rejects(api().a.ciForPulls("acme", "app", Array.from({ length: 70 }, (_, i) => i + 1), { signal: ac.signal }));
  assert.equal(f.requests.length, 1);
});

test("graphqlRaw hands back data and errors both, as GitHub sent them", async () => {
  const f = gh([["POST", /^\/graphql$/, () => ({ body: { data: { a: 1 }, errors: [{ type: "NOT_FOUND", message: "x" }] } })]]);
  assert.deepEqual(await api().a.graphqlRaw("query Q { a }", { v: 1 }), { data: { a: 1 }, errors: [{ type: "NOT_FOUND", message: "x" }] });
  assert.deepEqual(f.requests[0].body, { query: "query Q { a }", variables: { v: 1 } });
  assert.equal(f.requests[0].headers["content-type"], "application/json");
});

// ── File contents ──────────────────────────────────────────────────────────

test("fileAt reads raw text at a ref, with every path segment encoded", async () => {
  const f = gh([["GET", /\/contents\//, () => ({ bytes: new TextEncoder().encode("héllo\n") })]]);
  assert.deepEqual(await api().a.fileAt("acme", "app", "src/a b/c#.ts", "feat/x"), { kind: "text", text: "héllo\n" });
  assert.equal(f.requests[0].path, "/repos/acme/app/contents/src/a%20b/c%23.ts?ref=feat%2Fx");
  assert.equal(f.requests[0].headers.accept, "application/vnd.github.raw+json");
});

test("fileAt: 404 is the missing side, a NUL byte is binary, other failures throw", async () => {
  gh([
    ["GET", /contents\/gone/, () => ({ status: 404, body: { message: "Not Found" } })],
    ["GET", /contents\/bin/, () => ({ bytes: new Uint8Array([1, 2, 0, 3]) })],
    ["GET", /contents\/locked/, () => ({ status: 401, body: {} })],
  ]);
  const a = api().a;
  assert.deepEqual(await a.fileAt("acme", "app", "gone", "h"), { kind: "missing" });
  assert.deepEqual(await a.fileAt("acme", "app", "bin", "h"), { kind: "binary", bytes: 4 });
  const e = await rejects(a.fileAt("acme", "app", "locked", "h"));
  assert.equal(e.kind, "auth");
});

test("fileAt never decodes a blob over 5 MB: declared by content-length, or counted", async () => {
  const big = 5 * 1024 * 1024 + 1;
  gh([
    ["GET", /contents\/declared/, () => ({ bytes: new Uint8Array(4), headers: { "content-length": String(big) } })],
    ["GET", /contents\/counted/, () => ({ bytes: new Uint8Array(big).fill(65) })],
  ]);
  const a = api().a;
  assert.deepEqual(await a.fileAt("acme", "app", "declared", "h"), { kind: "too-large", bytes: big });
  assert.deepEqual(await a.fileAt("acme", "app", "counted", "h"), { kind: "too-large", bytes: big });
});

// ── Writes ─────────────────────────────────────────────────────────────────

test("mergePull sends the method, the commit title and the head it was shown", async () => {
  const f = gh([["PUT", /\/pulls\/3\/merge$/, () => ({ body: { merged: true } })]]);
  const { a, asked } = api();
  await a.mergePull("acme", "app", 3, "squash", { title: "Squash it", sha: "abc" });
  await a.mergePull("acme", "app", 3, "rebase");
  assert.deepEqual(f.requests.map((r) => r.body), [{ merge_method: "squash", commit_title: "Squash it", sha: "abc" }, { merge_method: "rebase" }]);
  assert.deepEqual(asked, [true, true], "a write may pop the sign-in");
});

test("updateBranch PUTs the expected head, so GitHub refuses a head that moved", async () => {
  const f = gh([["PUT", /\/pulls\/3\/update-branch$/, () => ({ status: 202, body: { message: "Updating pull request branch." } })]]);
  await api().a.updateBranch("acme", "app", 3, "abc123");
  assert.equal(f.requests[0].path, "/repos/acme/app/pulls/3/update-branch");
  assert.deepEqual(f.requests[0].body, { expected_head_sha: "abc123" });
});

test("setPullState PATCHes the state; deleteBranch DELETEs the head ref, slashes kept", async () => {
  const f = gh([
    ["PATCH", /\/pulls\/3$/, () => ({ body: rawPull(3, { state: "closed" }) })],
    ["DELETE", /\/git\/refs\/heads\//, () => ({ status: 204 })],
  ]);
  const a = api().a;
  await a.setPullState("acme", "app", 3, "closed");
  await a.deleteBranch("acme", "app", "feat/a b");
  assert.deepEqual(f.requests[0].body, { state: "closed" });
  assert.equal(f.requests[1].path, "/repos/acme/app/git/refs/heads/feat/a%20b");
});

test("addComment answers what the page draws: node id, URL, time and author", async () => {
  const f = gh([
    ["POST", /issues\/3\/comments$/, () => ({ body: { id: 77, node_id: "IC_x", html_url: "https://github.com/acme/app/pull/3#c", created_at: "2026-01-02T00:00:00Z", user: { login: "me" } } })],
    ["POST", /issues\/4\/comments$/, () => ({ body: { id: 78 } })],
  ]);
  const a = api().a;
  assert.deepEqual(await a.addComment("acme", "app", 3, "hi"), {
    id: "IC_x",
    url: "https://github.com/acme/app/pull/3#c",
    createdAt: "2026-01-02T00:00:00Z",
    author: { login: "me", avatarUrl: null, htmlUrl: null },
  });
  assert.deepEqual(f.requests[0].body, { body: "hi" });
  const bare = await a.addComment("acme", "app", 4, "x");
  assert.equal(bare.id, "78");
  assert.equal(bare.url, "");
  assert.equal(bare.author, null);
  assert.ok(!Number.isNaN(Date.parse(bare.createdAt)));
});

test("submitReview answers the review's id and URL; a 204 answers nothing", async () => {
  const f = gh([
    ["POST", /pulls\/3\/reviews$/, () => ({ body: { id: 9, html_url: "https://github.com/r", submitted_at: "2026-01-01T00:00:00Z" } })],
    ["POST", /pulls\/4\/reviews$/, () => ({ status: 204 })],
  ]);
  const a = api().a;
  const payload = { event: "APPROVE", body: "lgtm", commit_id: "h", comments: [] } as any;
  assert.deepEqual(await a.submitReview("acme", "app", 3, payload), { id: "9", url: "https://github.com/r", submittedAt: "2026-01-01T00:00:00Z" });
  assert.deepEqual(f.requests[0].body, payload);
  assert.equal(await a.submitReview("acme", "app", 4, payload), undefined);
});

test("commitFiles reads the first parent; compareFiles the comparison's files", async () => {
  gh([
    ["GET", /\/commits\/c1$/, () => ({ body: { parents: [{ sha: "p1" }, { sha: "p2" }], files: [{ filename: "a", status: "added", patch: "@@" }] } })],
    ["GET", /\/commits\/root$/, () => ({ body: { parents: [], files: [] } })],
    ["GET", /\/compare\/b\.\.\.h/, () => ({ body: { files: [{ filename: "z", status: "removed" }] } })],
  ]);
  const a = api().a;
  assert.deepEqual(await a.commitFiles("acme", "app", "c1"), {
    parent: "p1",
    files: [{ filename: "a", status: "added", additions: 0, deletions: 0, changes: 0, patch: "@@" }],
    truncated: false,
  });
  assert.deepEqual(await a.commitFiles("acme", "app", "root"), { files: [], truncated: false });
  assert.deepEqual(await a.compareFiles("acme", "app", "b", "h"), [{ filename: "z", status: "removed", additions: 0, deletions: 0, changes: 0 }]);
});

test("labels, assignees and reviewers are POSTed where GitHub keeps each", async () => {
  const f = gh([
    ["POST", /issues\/3\/labels$/, () => ({ body: [] })],
    ["POST", /issues\/3\/assignees$/, () => ({ body: {} })],
    ["POST", /pulls\/3\/requested_reviewers$/, () => ({ body: {} })],
  ]);
  const a = api().a;
  await a.addLabels("acme", "app", 3, ["bug"]);
  await a.addAssignees("acme", "app", 3, ["me"]);
  await a.requestReviewers("acme", "app", 3, ["bob"]);
  assert.deepEqual(
    f.requests.map((r) => [r.path, r.body]),
    [
      ["/repos/acme/app/issues/3/labels", { labels: ["bug"] }],
      ["/repos/acme/app/issues/3/assignees", { assignees: ["me"] }],
      ["/repos/acme/app/pulls/3/requested_reviewers", { reviewers: ["bob"] }],
    ],
  );
});

test("createPull POSTs the input and maps the new PR", async () => {
  const f = gh([["POST", /\/pulls$/, () => ({ status: 201, body: rawPull(12, { title: "New" }) })]]);
  const p = await api().a.createPull("acme", "app", { title: "New", head: "alice:x", base: "main", draft: true, body: "b" });
  assert.equal(p.number, 12);
  assert.equal(p.title, "New");
  assert.deepEqual(f.requests[0].body, { title: "New", head: "alice:x", base: "main", draft: true, body: "b" });
});
