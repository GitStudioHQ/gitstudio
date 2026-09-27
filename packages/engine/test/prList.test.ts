// The Pull Requests list's data layer (src/forge/prList.ts): which query a
// page is, what the search says, what a row carries, what a failure means,
// and when a PR is the branch checked out. The transport is a stub here; the
// same query text was run read-only against api.github.com while writing it.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PrListError,
  countFor,
  fetchFacetOptions,
  fetchPrListPage,
  fetchRepoInfo,
  hasFilters,
  isCheckedOut,
  mapPrNode,
  personQualifierValue,
  prListQuery,
  searchQueryFor,
  searchText,
  type GraphqlFn,
  type PrListRequest,
} from "../src/forge/prList";

const REQ: PrListRequest = { owner: "acme", repo: "app", state: "open", first: 30 };

/** A PullRequest node in GitHub's GraphQL shape. */
function node(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/app/pull/${n}`,
    state: "OPEN",
    isDraft: false,
    mergedAt: null,
    closedAt: null,
    createdAt: "2026-09-01T00:00:00Z",
    updatedAt: "2026-09-20T00:00:00Z",
    repository: { nameWithOwner: "acme/app" },
    author: { login: "alice", avatarUrl: "https://avatars.githubusercontent.com/u/1?s=40" },
    headRefName: `feature-${n}`,
    headRefOid: `${n}head`,
    baseRefName: "main",
    baseRefOid: "basesha",
    isCrossRepository: false,
    maintainerCanModify: false,
    headRepositoryOwner: { login: "acme" },
    headRepository: { nameWithOwner: "acme/app", url: "https://github.com/acme/app" },
    reviewDecision: null,
    comments: { totalCount: 0 },
    labels: { nodes: [] },
    assignees: { nodes: [] },
    reviewRequests: { nodes: [] },
    commits: { nodes: [{ commit: { statusCheckRollup: null } }] },
    ...over,
  };
}

test("no filter: GitHub's own list — exact counts, no search-index lag — with the segment's states", () => {
  const cases: Array<[PrListRequest["state"], unknown]> = [
    ["open", ["OPEN"]],
    ["merged", ["MERGED"]],
    ["closed", ["CLOSED"]],
    ["all", null],
  ];
  for (const [state, states] of cases) {
    const q = prListQuery({ ...REQ, state });
    assert.equal(q.shape, "list", state);
    assert.deepEqual(q.variables.states, states, state);
    assert.match(q.query, /open: pullRequests\(states: \[OPEN\]\)/, "the first page carries the three counts");
    assert.match(q.query, /viewer \{ login/, "and who is signed in");
  }
  const next = prListQuery({ ...REQ, after: "CURSOR" });
  assert.equal(next.variables.after, "CURSOR");
  assert.doesNotMatch(next.query, /open: pullRequests|\bviewer \{/, "a later page asks only for its rows");
  assert.equal(prListQuery({ ...REQ, first: 500 }).variables.first, 100, "GitHub answers at most 100");
});

test("a filter: search, with the segment, every facet and the counts under the same filters", () => {
  const q = prListQuery({
    ...REQ,
    state: "closed",
    filters: { text: "crash on save", author: "@me", reviewRequested: "@me", assignee: "@none", label: "good first issue" },
  });
  assert.equal(q.shape, "search");
  assert.equal(
    q.variables.q,
    'repo:acme/app is:pr is:closed is:unmerged author:@me review-requested:@me no:assignee label:"good first issue" crash on save sort:updated-desc',
  );
  assert.match(String(q.variables.qMerged), /^repo:acme\/app is:pr is:merged author:@me/);
  assert.match(String(q.variables.qOpen), /^repo:acme\/app is:pr is:open /);
  assert.equal(searchQueryFor({ ...REQ, filters: { assignee: "bob" } }, "all"), "repo:acme/app is:pr assignee:bob sort:updated-desc");
  assert.equal(searchQueryFor({ ...REQ, filters: { author: "dependabot[bot]" } }, "open"), "repo:acme/app is:pr is:open author:app/dependabot sort:updated-desc", "a bot is app/<name> to search");
});

test("search text never widens the list to another repository, fights the segment, or reorders it", () => {
  assert.equal(searchText("fix repo:facebook/react org:evil user:x -repo:a/b"), "fix");
  assert.equal(searchText("is:open is:issue is:draft base:main"), "is:draft base:main", "is:draft and base: are GitHub's to read");
  assert.equal(searchText("sort:created-asc type:issue  words\nhere"), "words here");
  assert.equal(hasFilters({ text: "repo:x/y" }), false, "nothing left: no filter, GitHub's own list");
  assert.equal(hasFilters({ text: "   " }), false);
  assert.equal(hasFilters({ label: '"' }), false);
  assert.equal(hasFilters({ author: "not a login!" }), false, "a value that isn't a login is not sent");
  assert.equal(hasFilters({ assignee: "@none" }), true);
  assert.equal(
    searchQueryFor({ ...REQ, filters: { assignee: "none" } }, "open"),
    "repo:acme/app is:pr is:open assignee:none sort:updated-desc",
    "none, alone, is someone's login",
  );
  assert.equal(personQualifierValue("@alice"), "alice");
  assert.equal(personQualifierValue("-rf"), undefined, "an option-like word is no login");
  assert.equal(personQualifierValue("@none"), undefined, "no one is an assignee's value only");
  assert.throws(() => prListQuery({ ...REQ, owner: "a b" }), PrListError);
});

test("a row carries what it shows: kind, draft, checks with counts, review decision, fork, labels, reviewers", () => {
  const item = mapPrNode(
    node(37, {
      isDraft: true,
      isCrossRepository: true,
      maintainerCanModify: true,
      headRepositoryOwner: { login: "bob" },
      headRepository: { nameWithOwner: "bob/app", url: "https://github.com/bob/app" },
      reviewDecision: "CHANGES_REQUESTED",
      comments: { totalCount: 4 },
      labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "odd", color: "not-hex" }] },
      reviewRequests: { nodes: [{ requestedReviewer: { __typename: "User", login: "carol", avatarUrl: null } }, { requestedReviewer: { __typename: "Team", slug: "core" } }] },
      commits: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "FAILURE",
                contexts: { checkRunCountsByState: [{ state: "SUCCESS", count: 2 }, { state: "FAILURE", count: 1 }], statusContextCountsByState: [] },
              },
            },
          },
        ],
      },
    }),
  );
  assert.ok(item);
  assert.equal(item.kind, "draft");
  assert.deepEqual(item.ci, { state: "failure", total: 3, failed: 1, pending: 0 });
  assert.equal(item.reviewDecision, "CHANGES_REQUESTED");
  assert.equal(item.isFork, true);
  assert.equal(item.headOwner, "bob");
  assert.equal(item.headRepo, "bob/app");
  assert.equal(item.comments, 4);
  assert.deepEqual(item.labels, [{ name: "bug", color: "d73a4a" }, { name: "odd", color: "888888" }], "a colour that isn't one never reaches a stylesheet");
  assert.deepEqual(item.reviewRequests, [{ login: "carol", avatarUrl: null }, { team: "core" }]);
  const kinds = [
    mapPrNode(node(1, { state: "MERGED", mergedAt: "2026-09-02T00:00:00Z" }))?.kind,
    mapPrNode(node(2, { state: "CLOSED" }))?.kind,
    mapPrNode(node(3, { state: "CLOSED", isDraft: true }))?.kind,
    mapPrNode(node(4))?.kind,
  ];
  assert.deepEqual(kinds, ["merged", "closed", "closed", "open"]);
  assert.equal(mapPrNode(node(5, { commits: { nodes: [] } }))?.ci.state, "none", "no commit, no checks");
  assert.equal(mapPrNode({})?.number, undefined);
  assert.equal(mapPrNode(node(6, { author: null }))?.author, null, "a deleted account (ghost)");
});

test("a page: rows, total, cursor, counts and the account — and another repository's rows are never this list's", async () => {
  const calls: Array<{ query: string; variables: Record<string, unknown> }> = [];
  const graphql: GraphqlFn = async (query, variables) => {
    calls.push({ query, variables });
    return {
      data: {
        viewer: { login: "me", avatarUrl: null },
        open: { issueCount: 3 },
        merged: { issueCount: 7 },
        closed: { issueCount: 1 },
        list: {
          issueCount: 3,
          pageInfo: { hasNextPage: true, endCursor: "C2" },
          nodes: [node(3), node(99, { repository: { nameWithOwner: "facebook/react" } }), node(2), {}],
        },
      },
    };
  };
  const page = await fetchPrListPage(graphql, { ...REQ, filters: { text: "fix" } });
  assert.equal(calls.length, 1, "one request for the whole first page");
  assert.deepEqual(page.items.map((i) => i.number), [3, 2]);
  assert.deepEqual(page.counts, { open: 3, merged: 7, closed: 1 });
  assert.equal(countFor(page.counts!, "all"), 11);
  assert.equal(page.viewer?.login, "me");
  assert.equal(page.hasMore, true);
  assert.equal(page.cursor, "C2");
});

test("failures, in the list's terms: a repository GitHub doesn't know, GraphQL's rate limit, a refused search", async () => {
  const answer = (res: Awaited<ReturnType<GraphqlFn>>): GraphqlFn => async () => res;
  await assert.rejects(
    fetchPrListPage(answer({ data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] }), REQ),
    (e: PrListError) => e.kind === "not-found" && /acme\/app/.test(e.message),
  );
  await assert.rejects(
    fetchPrListPage(answer({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), REQ),
    (e: PrListError) => e.kind === "rate-limit",
  );
  await assert.rejects(
    fetchPrListPage(answer({ data: { list: null }, errors: [{ type: "FORBIDDEN", message: "Resource protected by SAML" }] }), { ...REQ, filters: { text: "x" } }),
    (e: PrListError) => e.kind === "forbidden" && /SAML/.test(e.message),
  );
  // A row GitHub couldn't fill is left out, not the list.
  const partial = await fetchPrListPage(
    answer({
      data: { repository: { nameWithOwner: "acme/app", list: { totalCount: 2, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node(1), null] } } },
      errors: [{ type: "SERVICE_UNAVAILABLE", path: ["repository", "list", "nodes", 1] }],
    }),
    { ...REQ, after: "C" },
  );
  assert.deepEqual(partial.items.map((i) => i.number), [1]);
  assert.equal(partial.counts, undefined, "a later page carries no counts");
});

test("the repository behind the list: a fork names its parent; the filter menus' labels and people", async () => {
  const info = await fetchRepoInfo(
    async () => ({
      data: {
        repository: {
          nameWithOwner: "me/app",
          url: "https://github.com/me/app",
          isFork: true,
          defaultBranchRef: { name: "main" },
          parent: { nameWithOwner: "acme/app", url: "https://github.com/acme/app" },
        },
      },
    }),
    "me",
    "app",
  );
  assert.deepEqual(info, {
    owner: "me",
    repo: "app",
    url: "https://github.com/me/app",
    isFork: true,
    parent: { owner: "acme", repo: "app", url: "https://github.com/acme/app" },
    defaultBranch: "main",
  });
  assert.equal(await fetchRepoInfo(async () => ({ data: { repository: null } }), "me", "gone"), undefined);
  const opts = await fetchFacetOptions(
    async () => ({
      data: {
        repository: {
          labels: { totalCount: 101, nodes: [{ name: "bug", color: "d73a4a" }] },
          assignableUsers: { totalCount: 1, nodes: [{ login: "alice", avatarUrl: null }] },
        },
      },
    }),
    "acme",
    "app",
  );
  assert.deepEqual(opts.labels, [{ name: "bug", color: "d73a4a" }]);
  assert.deepEqual(opts.people, [{ login: "alice", avatarUrl: null }]);
  assert.equal(opts.truncated, true);
});

test("checked out here: its head tracked from where it lives, GitStudio's pr/<n>, or a same-repository branch of its name — never a fork's namesake", () => {
  const same = { number: 7, headRef: "feature", headRepo: "acme/app", isFork: false };
  const fork = { number: 8, headRef: "main", headRepo: "bob/app", isFork: true };
  const cases: Array<[string, Parameters<typeof isCheckedOut>[0], Parameters<typeof isCheckedOut>[1], boolean]> = [
    ["tracking its head", same, { branch: "feature", upstream: { repo: "acme/app", branch: "feature" } }, true],
    ["tracking under another local name", same, { branch: "my-copy", upstream: { repo: "ACME/app", branch: "feature" } }, true],
    ["tracking the fork's branch", fork, { branch: "bob-main", upstream: { repo: "bob/app", branch: "main" } }, true],
    ["your main is not the fork's main", fork, { branch: "main", upstream: { repo: "acme/app", branch: "main" } }, false],
    ["your untracked main is not the fork's main", fork, { branch: "main" }, false],
    ["GitStudio's pr/7", same, { branch: "pr/7" }, true],
    ["a same-named branch with nothing tracked", same, { branch: "feature" }, true],
    ["a same-named branch tracking something else", same, { branch: "feature", upstream: { repo: "acme/app", branch: "other" } }, false],
    ["detached", same, { upstream: { repo: "acme/app", branch: "feature" } }, false],
    ["nothing known", same, undefined, false],
  ];
  for (const [name, item, local, want] of cases) assert.equal(isCheckedOut(item, local), want, name);
});
