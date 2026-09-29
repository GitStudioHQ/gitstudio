// A repository's pull requests (src/forge/prList.ts) — the corners
// test/prList.test.ts leaves: every person-facet spelling, filters that are
// only whitespace, a later page's query, a sparse row, the failures without a
// message, and the repository/facet reads when GitHub answers little.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NO_ONE,
  PrListError,
  countFor,
  fetchFacetOptions,
  fetchPrListPage,
  fetchRepoInfo,
  hasFilters,
  isCheckedOut,
  mapPrNode,
  parsePrListResponse,
  personQualifierValue,
  prListQuery,
  searchQueryFor,
  searchText,
  type PrListRequest,
} from "../src/forge/prList";

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub's JSON */

const REQ: PrListRequest = { owner: "acme", repo: "app", state: "open", first: 30 };

test("a person facet: @me as is, a login with or without @, a bot as app/name, and nothing else", () => {
  assert.equal(personQualifierValue(undefined), undefined);
  assert.equal(personQualifierValue(""), undefined);
  assert.equal(personQualifierValue("@me"), "@me");
  assert.equal(personQualifierValue(NO_ONE), undefined, "no one is a facet of its own, not a login");
  assert.equal(personQualifierValue("@octo-cat"), "octo-cat");
  assert.equal(personQualifierValue("dependabot[bot]"), "app/dependabot");
  assert.equal(personQualifierValue("@renovate[bot]"), "app/renovate");
  assert.equal(personQualifierValue("bad login"), undefined);
  assert.equal(personQualifierValue("-leading"), undefined);
  assert.equal(personQualifierValue("x".repeat(40)), undefined, "longer than GitHub allows");
});

test("filters that say nothing are no filter at all", () => {
  assert.equal(hasFilters(undefined), false);
  assert.equal(hasFilters({}), false);
  assert.equal(hasFilters({ text: "  repo:other/x  is:open " }), false, "only qualifiers the list takes out");
  assert.equal(hasFilters({ label: ' "\n ' }), false);
  assert.equal(hasFilters({ author: "not a login" }), false);
  assert.equal(hasFilters({ reviewRequested: "@me" }), true);
  assert.equal(hasFilters({ assignee: NO_ONE }), true);
  assert.equal(hasFilters({ assignee: "bob" }), true);
  assert.equal(hasFilters({ label: "bug" }), true);
  // A filter-less request is GitHub's own list.
  assert.equal(prListQuery({ ...REQ, filters: { label: "   " } }).shape, "list");
});

test("search text: whitespace of any kind is one space, and it is capped", () => {
  assert.equal(searchText(undefined), "");
  assert.equal(searchText("a\tb\r\nc"), "a b c");
  assert.equal(searchText("-org:x -IS:PR keep is:draft SORT:created"), "keep is:draft");
  assert.equal(searchText("w".repeat(300)).length, 256);
});

test("each segment's search: merged, closed-without-merging, all; an assignee by name; a quoted label", () => {
  const f = { assignee: "@bob", label: 'needs "review"' };
  assert.equal(searchQueryFor({ owner: "acme", repo: "app", filters: f }, "merged"), 'repo:acme/app is:pr is:merged assignee:bob label:"needs review" sort:updated-desc');
  assert.equal(searchQueryFor({ owner: "acme", repo: "app", filters: f }, "closed"), 'repo:acme/app is:pr is:closed is:unmerged assignee:bob label:"needs review" sort:updated-desc');
  assert.equal(searchQueryFor({ owner: "acme", repo: "app" }, "all"), "repo:acme/app is:pr sort:updated-desc");
  assert.throws(() => searchQueryFor({ owner: "acme", repo: "a b" }, "open"), (e: any) => e instanceof PrListError && e.kind === "query");
});

test("a later page asks for no counts and no account, in either shape", () => {
  const list = prListQuery({ ...REQ, state: "all", after: "CURSOR", first: 500 });
  assert.equal(list.shape, "list");
  assert.doesNotMatch(list.query, /^\s*viewer \{/m);
  assert.doesNotMatch(list.query, /open: pullRequests/);
  assert.deepEqual(list.variables, { owner: "acme", name: "app", first: 100, after: "CURSOR", states: null });

  const search = prListQuery({ ...REQ, filters: { author: "@me" }, after: "C2", first: 0.5 });
  assert.equal(search.shape, "search");
  assert.doesNotMatch(search.query, /^\s*viewer \{/m);
  assert.doesNotMatch(search.query, /\$qOpen/);
  assert.deepEqual(Object.keys(search.variables).sort(), ["after", "first", "q"]);
  assert.equal(search.variables.first, 1, "at least one row");
});

test("All counts the three segments together", () => {
  const counts = { open: 3, merged: 5, closed: 2 };
  assert.equal(countFor(counts, "all"), 10);
  assert.equal(countFor(counts, "merged"), 5);
});

test("a sparse row: what GitHub left out reads as empty, and a reviewer without a name is skipped", () => {
  const row = mapPrNode({
    number: 7,
    title: "T",
    createdAt: "2026-01-01T00:00:00Z",
    comments: { totalCount: "x" },
    labels: { nodes: [null, { name: "l", color: "zzz" }] },
    assignees: { nodes: [null, { login: "bob" }] },
    reviewRequests: {
      nodes: [
        null,
        { requestedReviewer: null },
        { requestedReviewer: { __typename: "Team", slug: "core" } },
        { requestedReviewer: { __typename: "Team" } },
        { requestedReviewer: { __typename: "User", login: "dana" } },
      ],
    },
  })!;
  assert.equal(row.state, "open", "no state reads as open");
  assert.equal(row.kind, "open");
  assert.equal(row.url, "");
  assert.equal(row.updatedAt, "2026-01-01T00:00:00Z");
  assert.deepEqual([row.headRef, row.headSha, row.baseRef, row.baseSha, row.repository], ["", "", "", "", ""]);
  assert.deepEqual([row.headOwner, row.headRepo, row.headUrl, row.author, row.closedAt], [null, null, null, null, null]);
  assert.equal(row.comments, 0);
  assert.deepEqual(row.labels, [{ name: "l", color: "888888" }]);
  assert.deepEqual(row.assignees, [{ login: "bob", avatarUrl: null }]);
  assert.deepEqual(row.reviewRequests, [{ team: "core" }, { login: "dana", avatarUrl: null }]);
  assert.equal(mapPrNode({ number: "7", title: "T" }), null);
  assert.equal(mapPrNode({ number: 7 }), null);
  assert.equal(mapPrNode(null), null);
  const closed = mapPrNode({ number: 1, title: "t", state: "CLOSED", closedAt: "2026-02-02T00:00:00Z", updatedAt: "2026-02-03T00:00:00Z" })!;
  assert.deepEqual([closed.kind, closed.closedAt, closed.updatedAt], ["closed", "2026-02-02T00:00:00Z", "2026-02-03T00:00:00Z"]);
});

test("a page without counts, account or cursor: only what GitHub sent", () => {
  const page = parsePrListResponse(REQ, "list", {
    data: { repository: { list: { totalCount: null, pageInfo: { hasNextPage: "yes", endCursor: 5 }, nodes: [{ number: 1, title: "a", repository: { nameWithOwner: "ACME/App" } }, { number: 2, title: "b" }, "junk"] } } },
  });
  assert.deepEqual(page.items.map((i) => i.number), [1, 2], "the same repository in another case, and a row with no repository, are this list's");
  assert.equal(page.total, 0);
  assert.equal(page.hasMore, false, "only true is true");
  assert.equal(page.cursor, null);
  assert.equal("counts" in page, false);
  assert.equal("viewer" in page, false);

  const search = parsePrListResponse(REQ, "search", {
    data: { open: { issueCount: 2 }, merged: { issueCount: "x" }, closed: { issueCount: 1 }, viewer: { login: "sam" }, list: { issueCount: 3, nodes: null } },
  });
  assert.deepEqual(search.counts, { open: 2, merged: 0, closed: 1 });
  assert.deepEqual(search.viewer, { login: "sam", avatarUrl: null });
  assert.deepEqual(search.items, []);
  assert.equal(search.total, 3);
});

test("failures without GitHub's words still say what went wrong", () => {
  const fail = (shape: "list" | "search", res: any): string => {
    try {
      parsePrListResponse(REQ, shape, res);
    } catch (e: any) {
      assert.ok(e instanceof PrListError);
      return `${e.kind}: ${e.message}`;
    }
    return "no error";
  };
  assert.match(fail("list", { errors: [{ type: "RATE_LIMITED" }] }), /^rate-limit: GitHub's rate limit was reached/);
  assert.match(fail("list", { data: null, errors: [{ type: "NOT_FOUND" }] }), /^not-found: GitHub has no repository acme\/app/);
  assert.equal(fail("list", { errors: [{ type: "FORBIDDEN" }] }), "forbidden: GitHub refused to list acme/app's pull requests.");
  assert.equal(fail("list", { data: {} }), "query: GitHub couldn't answer the query.");
  assert.equal(fail("list", { errors: [{ message: "Bad query" }] }), "query: Bad query");
  assert.equal(fail("search", { errors: [{ type: "FORBIDDEN" }] }), "forbidden: GitHub refused to search acme/app.");
  assert.equal(fail("search", { errors: [{ type: "FORBIDDEN", message: "SAML" }] }), "forbidden: SAML");
  assert.equal(fail("search", { data: { list: null } }), "query: GitHub couldn't answer the query.");
  assert.equal(fail("search", { errors: [{ message: "Timeout" }] }), "query: Timeout");
});

test("fetching a page sends the page's own query and reads the answer in its shape", async () => {
  const seen: any[] = [];
  const page = await fetchPrListPage(async (q, v) => {
    seen.push(v);
    assert.match(q, /list: search/);
    return { data: { list: { issueCount: 1, nodes: [{ number: 4, title: "x", repository: { nameWithOwner: "acme/app" } }] } } };
  }, { ...REQ, filters: { text: "fix" } });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].q, "repo:acme/app is:pr is:open fix sort:updated-desc");
  assert.deepEqual(page.items.map((i) => i.number), [4]);
});

test("the repository behind the list: GitHub's own URLs when given, made up when not, and nothing for a name that isn't one", async () => {
  const info = await fetchRepoInfo(async () => ({ data: { repository: { nameWithOwner: "me/app", isFork: true, parent: { nameWithOwner: "acme/app" } } } }), "me", "app");
  assert.deepEqual(info, { owner: "me", repo: "app", url: "https://github.com/me/app", isFork: true, parent: { owner: "acme", repo: "app", url: "https://github.com/acme/app" } });
  const withUrls = await fetchRepoInfo(
    async () => ({ data: { repository: { nameWithOwner: "me/app", url: "https://ghe.example/me/app", isFork: false, parent: { nameWithOwner: "a/b/c" }, defaultBranchRef: { name: "trunk" } } } }),
    "me",
    "app",
  );
  assert.deepEqual(withUrls, { owner: "me", repo: "app", url: "https://ghe.example/me/app", isFork: false, defaultBranch: "trunk" }, "a parent name that isn't owner/repo is no parent");
  assert.equal(await fetchRepoInfo(async () => ({ data: { repository: { nameWithOwner: "noslash" } } }), "me", "app"), undefined);
  assert.equal(await fetchRepoInfo(async () => ({ data: { repository: null } }), "me", "app"), undefined);
  await assert.rejects(fetchRepoInfo(async () => ({ errors: [{ type: "RATE_LIMITED" }] }), "me", "app"), (e: any) => e.kind === "rate-limit" && /rate limit was reached/.test(e.message));
  await assert.rejects(fetchRepoInfo(async () => ({}), "me", "../app"), (e: any) => e.kind === "query");
});

test("the filter menus: not found in GitHub's words or the list's, and truncated only when there is more", async () => {
  await assert.rejects(fetchFacetOptions(async () => ({ data: { repository: null } }), "acme", "app"), (e: any) => e.kind === "not-found" && e.message === "GitHub has no repository acme/app.");
  await assert.rejects(fetchFacetOptions(async () => ({ errors: [{ message: "Could not resolve" }] }), "acme", "app"), (e: any) => e.kind === "not-found" && e.message === "Could not resolve");
  const empty = await fetchFacetOptions(async () => ({ data: { repository: {} } }), "acme", "app");
  assert.deepEqual(empty, { labels: [], people: [], truncated: false });
  const more = await fetchFacetOptions(async () => ({ data: { repository: { labels: { totalCount: 2, nodes: [{ name: "a", color: "ABCDEF" }] }, assignableUsers: { totalCount: 1, nodes: [{ login: "x" }] } } } }), "acme", "app");
  assert.deepEqual(more, { labels: [{ name: "a", color: "ABCDEF" }], people: [{ login: "x", avatarUrl: null }], truncated: true });
  const people = await fetchFacetOptions(async () => ({ data: { repository: { assignableUsers: { totalCount: 5, nodes: [] } } } }), "acme", "app");
  assert.equal(people.truncated, true);
});

test("checked out here: a tracked branch from another repository, or a detached HEAD, is not this pull request", () => {
  const item = { number: 3, headRef: "feat", headRepo: "acme/app", isFork: false };
  assert.equal(isCheckedOut(item, undefined), false);
  assert.equal(isCheckedOut(item, {}), false, "detached");
  assert.equal(isCheckedOut(item, { branch: "feat", upstream: { repo: "ACME/APP", branch: "feat" } }), true);
  assert.equal(isCheckedOut(item, { branch: "feat", upstream: { repo: "other/app", branch: "feat" } }), false);
  assert.equal(isCheckedOut(item, { branch: "feat", upstream: { branch: "feat" } }), true, "tracked from a remote that isn't on GitHub");
  assert.equal(isCheckedOut({ ...item, headRepo: null }, { branch: "feat", upstream: { repo: "acme/app", branch: "feat" } }), false);
});
