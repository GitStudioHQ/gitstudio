// What a sign-in may ask GitHub (src/forge/prList.ts's SignInReach), for the
// list and the page (#82). A team's fields take read:org, and GitHub weighs a
// question's fields against the token's scopes before it runs it: one
// `... on Team { slug }` refuses the whole question. The extension's sign-in
// asks for `repo` only, so a token with nothing more listed no pull request
// at all. Here GitHub is a stub that refuses as api.github.com refuses —
// the refusal's shape is the live API's, read with a token short of another
// scope — in both shapes a refusal can take: `errors` alone, and `data` with
// the field nulled beside the error.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PR_ROW_FRAGMENT,
  PrListError,
  fetchFacetOptions,
  fetchPrListPage,
  fetchRepoInfo,
  prListQuery,
  prRowFragment,
  refusesTeams,
  scopesNamed,
  type GraphqlErrorLike,
  type GraphqlFn,
  type PrListRequest,
  type SignInReach,
} from "../src/forge/prList";
import { PR_PAGE_QUERY, fetchPrPage, markReadyForReview, prPageQuery, timelineEventWords } from "../src/forge/prPage";
import { fetchCreateData } from "../src/forge/prCreate";

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub's JSON */

const REQ: PrListRequest = { owner: "acme", repo: "app", state: "open", first: 30 };

/** A refusal for the token's scopes, worded as api.github.com words it. */
function refusal(field: string, needs: string[], has: string[] = ["repo"]): GraphqlErrorLike & { locations: unknown } {
  const list = (xs: string[]) => `[${xs.map((s) => `'${s}'`).join(", ")}]`;
  return {
    type: "INSUFFICIENT_SCOPES",
    locations: [{ line: 13, column: 141 }],
    message: `Your token has not been granted the required scopes to execute this query. The '${field}' field requires one of the following scopes: ${list(needs)}, but your token has only been granted the: ${list(has)} scopes. Please modify your token's scopes at: https://github.com/settings/tokens.`,
  };
}

const ORG = ["read:org", "read:discussion"];
const asksTeamNames = (q: string) => /\.\.\. on Team \{/.test(q);

/** A requested team, as an answer has it: by name only where the question asked for one. */
const team = (q: string) => (asksTeamNames(q) ? { __typename: "Team", slug: "core" } : { __typename: "Team" });
const dana = { __typename: "User", login: "dana", avatarUrl: null };

/** One PullRequest node of the list, asked of `core` and of dana. */
function row(q: string, n = 12, reviewer: unknown = team(q)): Record<string, unknown> {
  return {
    number: n,
    title: `PR ${n}`,
    url: `https://github.com/acme/app/pull/${n}`,
    state: "OPEN",
    isDraft: false,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: "2026-10-02T00:00:00Z",
    repository: { nameWithOwner: "acme/app" },
    author: { login: "alice", avatarUrl: null },
    reviewRequests: { nodes: [{ requestedReviewer: reviewer }, { requestedReviewer: dana }] },
    commits: { nodes: [] },
  };
}

function listAnswer(q: string, reviewer?: unknown): any {
  return {
    data: {
      viewer: { login: "me", avatarUrl: null },
      repository: {
        nameWithOwner: "acme/app",
        open: { totalCount: 1 },
        merged: { totalCount: 0 },
        closed: { totalCount: 0 },
        list: { totalCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [row(q, 12, reviewer === undefined ? team(q) : reviewer)] },
      },
    },
  };
}

function searchAnswer(q: string, reviewer?: unknown): any {
  return {
    data: {
      viewer: { login: "me", avatarUrl: null },
      open: { issueCount: 1 },
      merged: { issueCount: 0 },
      closed: { issueCount: 0 },
      list: { issueCount: 1, pageInfo: { hasNextPage: false, endCursor: null }, nodes: [row(q, 12, reviewer === undefined ? team(q) : reviewer)] },
    },
  };
}

function pageAnswer(q: string, reviewer?: unknown): any {
  const who = reviewer === undefined ? team(q) : reviewer;
  return {
    data: {
      viewer: { login: "sam", avatarUrl: null },
      repository: {
        nameWithOwner: "acme/app",
        viewerPermission: "WRITE",
        pullRequest: {
          id: "PR_12",
          number: 12,
          title: "PR 12",
          state: "OPEN",
          author: { login: "alice", avatarUrl: null },
          reviewRequests: { nodes: [{ requestedReviewer: who }, { requestedReviewer: dana }] },
          latestReviews: { nodes: [] },
          timelineItems: {
            totalCount: 1,
            nodes: [{ __typename: "ReviewRequestedEvent", id: "E_1", actor: { login: "alice", avatarUrl: null }, createdAt: "2026-10-02T00:00:00Z", requestedReviewer: who }],
          },
        },
      },
    },
  };
}

/**
 * GitHub as a token with `scopes` meets it. A question asking a team's fields
 * without read:org is refused — `"refused"`: as api.github.com does, errors
 * and no data; `"partial"`: data with the team nulled, and the error beside
 * it — else answered by `answer`, with a team's slug only where asked.
 */
function github(
  scopes: string[],
  answer: (q: string, reviewer?: unknown) => any,
  shape: "refused" | "partial" = "refused",
): GraphqlFn & { asked: string[] } {
  const asked: string[] = [];
  const fn: GraphqlFn = async (q) => {
    asked.push(q);
    if (asksTeamNames(q) && !scopes.some((s) => ORG.includes(s) || s.endsWith(":org"))) {
      const refused = refusal("slug", ORG, scopes);
      return shape === "refused" ? { errors: [refused] } : { ...answer(q, null), errors: [{ ...refused, path: ["repository", "pullRequest", "reviewRequests", "nodes", 0, "requestedReviewer", "slug"] }] };
    }
    return answer(q);
  };
  return Object.assign(fn, { asked });
}

// ── The questions ────────────────────────────────────────────────────────────

test("the questions without team names ask a team's __typename and nothing of it; with them, they are what they were", () => {
  for (const req of [REQ, { ...REQ, filters: { text: "fix" } }, { ...REQ, after: "C" }]) {
    const lean = prListQuery(req, false).query;
    assert.ok(!/on Team/.test(lean), "no team field, anywhere in the list's question");
    assert.ok(lean.includes("reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 40) } ... on Bot { login } ... on Mannequin { login } } } }"));
    assert.ok(prListQuery(req).query.includes("... on Team { slug }"), "a question without a reach asks for team names, as it did");
    assert.equal(prListQuery(req, false).shape, prListQuery(req, true).shape);
    assert.deepEqual(prListQuery(req, false).variables, prListQuery(req, true).variables);
  }
  assert.equal(PR_ROW_FRAGMENT, prRowFragment(true));
  assert.ok(!/on Team/.test(prRowFragment(false)));
  // The page names a team in two places: who is asked, and the timeline's
  // review requests. Both go.
  const lean = prPageQuery(false);
  assert.ok(!/on Team/.test(lean), "no team field, anywhere in the page's question");
  assert.equal((lean.match(/requestedReviewer \{ __typename/g) ?? []).length, 2);
  assert.equal(PR_PAGE_QUERY, prPageQuery(true));
  assert.equal((PR_PAGE_QUERY.match(/\.\.\. on Team \{ slug \}/g) ?? []).length, 2);
});

test("what a refusal names: the scopes, any one of which would do; a refusal for a team's scope — or one whose words can't be read — is one the team fields may be behind", () => {
  assert.deepEqual(scopesNamed([refusal("slug", ORG)]), ["read:org", "read:discussion"]);
  assert.deepEqual(scopesNamed([refusal("slug", ORG), refusal("name", ["read:org"]), { type: "NOT_FOUND", message: "requires one of the following scopes: ['x']" }]), ["read:org", "read:discussion"]);
  assert.deepEqual(scopesNamed(undefined), []);
  assert.equal(refusesTeams([refusal("slug", ORG)]), true);
  assert.equal(refusesTeams([refusal("title", ["read:project"])]), false, "a project's scope is no team's");
  assert.equal(refusesTeams([{ type: "INSUFFICIENT_SCOPES", message: "Insufficient scopes." }]), true, "GitHub's words changed: asking without the team fields is still worth one request");
  assert.equal(refusesTeams([{ type: "FORBIDDEN", message: "read:org" }]), false);
  assert.equal(refusesTeams(undefined), false);
});

// ── A sign-in without read:org (#82) ─────────────────────────────────────────

test("a sign-in without read:org lists pull requests: refused once, asked again without team names — and the sign-in's next question is asked that way first", async () => {
  const reach: SignInReach = { teams: true };
  const gh = github(["repo"], listAnswer);
  const page = await fetchPrListPage(gh, REQ, reach);
  assert.deepEqual(page.items.map((i) => i.number), [12], "the list loads");
  assert.deepEqual(page.items[0].reviewRequests, [{ login: "dana", avatarUrl: null }], "the team the sign-in can't name isn't a row's reviewer — and not a ghost");
  assert.deepEqual(page.counts, { open: 1, merged: 0, closed: 0 });
  assert.equal(gh.asked.length, 2);
  assert.ok(asksTeamNames(gh.asked[0]) && !asksTeamNames(gh.asked[1]));
  assert.equal(reach.teams, false, "remembered for the sign-in");

  // Refresh, the next page, a search, the page: one question each, without names.
  await fetchPrListPage(gh, { ...REQ, after: "C" }, reach);
  const search = await fetchPrListPage(github(["repo"], searchAnswer), { ...REQ, filters: { author: "@me" } }, reach);
  assert.deepEqual(search.items.map((i) => i.number), [12]);
  assert.equal(gh.asked.length, 3);
  assert.ok(!asksTeamNames(gh.asked[2]));

  const pageGh = github(["repo"], pageAnswer);
  const d = await fetchPrPage(pageGh, "acme", "app", 12, reach);
  assert.equal(pageGh.asked.length, 1, "the page is asked once: the sign-in's reach is the list's");
  assert.ok(!asksTeamNames(pageGh.asked[0]));
  assert.deepEqual(d.reviewers, [{ login: "dana", avatarUrl: null, requested: true }, { unnamedTeams: 1, requested: true }], "GitHub says a team was asked, not which: one row says so");
  const asked = d.timeline.find((t) => t.kind === "event");
  assert.ok(asked && asked.kind === "event" && asked.event === "reviewRequested" && asked.detail === undefined, "the timeline names no one it wasn't told");
  assert.equal(timelineEventWords(asked, "main").text, "asked for a review");
});

test("a page asked first, by a sign-in without read:org: refused once, then the page — and the list after it asks without names", async () => {
  const reach: SignInReach = { teams: true };
  const pageGh = github(["repo"], pageAnswer);
  const d = await fetchPrPage(pageGh, "acme", "app", 12, reach);
  assert.equal(d.title, "PR 12");
  assert.equal(pageGh.asked.length, 2);
  assert.deepEqual(d.reviewers.at(-1), { unnamedTeams: 1, requested: true });
  assert.equal(reach.teams, false);
  const gh = github(["repo"], listAnswer);
  await fetchPrListPage(gh, REQ, reach);
  assert.equal(gh.asked.length, 1);
});

test("GitHub's other shape — data with the team nulled, and the refusal beside it — is asked again the same way, for the list and the page", async () => {
  const reach: SignInReach = { teams: true };
  const gh = github(["repo"], listAnswer, "partial");
  const page = await fetchPrListPage(gh, REQ, reach);
  assert.deepEqual(page.items.map((i) => i.number), [12]);
  assert.equal(gh.asked.length, 2, "asked again: the team is then counted, not dropped");
  assert.equal(reach.teams, false);

  const fresh: SignInReach = { teams: true };
  const pageGh = github(["repo"], pageAnswer, "partial");
  const d = await fetchPrPage(pageGh, "acme", "app", 12, fresh);
  assert.equal(pageGh.asked.length, 2);
  assert.deepEqual(d.reviewers, [{ login: "dana", avatarUrl: null, requested: true }, { unnamedTeams: 1, requested: true }]);
});

test("without a reach — as every caller asked before — the full question comes first, and a refusal is still asked again", async () => {
  const gh = github(["repo"], listAnswer);
  assert.deepEqual((await fetchPrListPage(gh, REQ)).items.map((i) => i.number), [12]);
  assert.deepEqual((await fetchPrListPage(gh, REQ)).items.map((i) => i.number), [12]);
  assert.equal(gh.asked.length, 4, "no reach, nothing remembered: refused and asked again each time");
  assert.ok(asksTeamNames(gh.asked[0]) && asksTeamNames(gh.asked[2]));
});

// ── A sign-in with read:org ──────────────────────────────────────────────────

test("a sign-in with read:org is asked for team names, once, and gets them — its reach unchanged", async () => {
  const reach: SignInReach = { teams: true };
  const gh = github(["repo", "read:org"], listAnswer);
  const page = await fetchPrListPage(gh, REQ, reach);
  assert.equal(gh.asked.length, 1);
  assert.ok(asksTeamNames(gh.asked[0]));
  assert.deepEqual(page.items[0].reviewRequests, [{ team: "core" }, { login: "dana", avatarUrl: null }]);
  const pageGh = github(["repo", "admin:org"], pageAnswer);
  const d = await fetchPrPage(pageGh, "acme", "app", 12, reach);
  assert.equal(pageGh.asked.length, 1);
  assert.deepEqual(d.reviewers, [{ team: "core", requested: true }, { login: "dana", avatarUrl: null, requested: true }]);
  const asked = d.timeline.find((t) => t.kind === "event");
  assert.ok(asked && asked.kind === "event");
  assert.equal(timelineEventWords(asked, "main").text, "asked core for a review");
  assert.equal(reach.teams, true);
});

// ── What isn't the team fields ───────────────────────────────────────────────

test("refused for another scope: not asked again, and said in words that send no one to github.com/settings/tokens", async () => {
  const reach: SignInReach = { teams: true };
  let asked = 0;
  const project: GraphqlFn = async () => {
    asked++;
    return { errors: [refusal("title", ["read:project"])] };
  };
  const err = await fetchPrListPage(project, REQ, reach).then(
    () => assert.fail("refused"),
    (e: unknown) => e,
  );
  assert.ok(err instanceof PrListError);
  assert.equal(err.kind, "scope");
  assert.deepEqual(err.scopes, ["read:project"]);
  assert.equal(err.message, "GitHub won't answer without the read:project permission, which this sign-in wasn't given.");
  assert.equal(asked, 1, "without the team fields it would be refused the same");
  assert.equal(reach.teams, true, "and the team names aren't given up for it");
  await assert.rejects(fetchPrListPage(project, { ...REQ, filters: { text: "x" } }, reach), (e: PrListError) => e.kind === "scope");
  await assert.rejects(fetchPrPage(project, "acme", "app", 12, reach), (e: PrListError) => e.kind === "scope" && !/settings\/tokens/.test(e.message));
});

test("refused again without the team fields: two questions, then why — never GitHub's 'modify your token's scopes'", async () => {
  const reach: SignInReach = { teams: true };
  let asked = 0;
  const always: GraphqlFn = async () => {
    asked++;
    return { errors: [refusal("login", ORG)] };
  };
  await assert.rejects(fetchPrListPage(always, REQ, reach), (e: PrListError) => {
    assert.equal(e.kind, "scope");
    assert.deepEqual(e.scopes, ORG);
    assert.equal(e.message, "GitHub won't answer without one of the permissions read:org, read:discussion, which this sign-in wasn't given.");
    return true;
  });
  assert.equal(asked, 2);
  await assert.rejects(fetchPrListPage(always, REQ, reach), (e: PrListError) => e.kind === "scope");
  assert.equal(asked, 3, "the sign-in asks without team names now: one question");
  const words = await fetchPrListPage(async () => ({ errors: [{ type: "INSUFFICIENT_SCOPES", message: "Nope." }] }), REQ).catch((e: PrListError) => e);
  assert.ok(words instanceof PrListError && words.kind === "scope" && words.message === "GitHub won't answer without a permission this sign-in wasn't given.");
});

test("the other questions say a scope refusal the same way: the repository, the filter menus, the New pull request form, a change to the page", async () => {
  const refused: GraphqlFn = async () => ({ errors: [refusal("name", ["read:org"])] });
  const isScope = (e: PrListError) => e instanceof PrListError && e.kind === "scope" && e.scopes.join() === "read:org";
  await assert.rejects(fetchRepoInfo(refused, "acme", "app"), isScope);
  await assert.rejects(fetchFacetOptions(refused, "acme", "app"), isScope);
  await assert.rejects(fetchCreateData(refused, "acme", "app"), isScope);
  await assert.rejects(markReadyForReview(refused, "PR_12"), isScope);
});
