// A repository's pull requests, a page at a time — the list's data layer,
// shared by the VS Code extension and the desktop app. Pure: the GraphQL
// transport is handed in (each product has its own authenticated client), so
// every rule here — which query, which qualifiers, what a row carries, what a
// failure means — is unit-tested without a network (test/prList.test.ts).
//
// ONE REQUEST PER PAGE, with everything a row shows: state, draft, author and
// avatar, head → base, labels, the review decision, the comment count, and
// the checks' rollup (GitHub's statusCheckRollup, which weighs check runs AND
// statuses — the combined-status endpoint alone called every Actions run
// "pending"). The first page also carries the three segment counts and the
// signed-in account, so the list's header is complete with the rows.
//
// TWO SHAPES. With no filter, `repository.pullRequests` (GitHub's own list,
// exact counts, no search-index lag: a PR opened a second ago is there).
// With one — text, author, review requested, assignee, label — `search`,
// which is the only place GitHub answers those, team review requests
// included (`review-requested:@me` counts your teams; the REST list's
// requested_reviewers did not).
//
// A NUMBER IS NOT AN IDENTITY. Search text is the user's, and `repo:other/x`
// in it would widen the search to another repository — whose #12 the list
// would then show, and act on, as this one's. Scope-changing qualifiers are
// taken out of the text, and any row from another repository is dropped.

import type {
  PrFacet,
  PrListCounts,
  PrListFilters,
  PrListItem,
  PrListState,
  PrPerson,
  PrReviewRequest,
} from "@gitstudio/host-bridge/prProtocol";
import { ciFromRollup, prKind, reviewDecisionOf } from "./pullRequests";
import * as l10n from "@vscode/l10n";

export type { PrFacet, PrListCounts, PrListFilters, PrListItem, PrListState, PrPerson, PrReviewRequest };

// ── What a page is ───────────────────────────────────────────────────────────

export const PR_LIST_STATES: readonly PrListState[] = ["open", "merged", "closed", "all"];

/** The segments' words — "Closed" is closed WITHOUT merging, so the two never overlap. */
export const PR_LIST_STATE_WORDS: Record<PrListState, string> = {
  open: "Open",
  merged: "Merged",
  closed: "Closed",
  all: "All",
};

/** The Assignee facet's "no one". */
export const NO_ONE = "@none";

export const PR_FACETS: readonly PrFacet[] = ["author", "reviewRequested", "assignee", "label"];

/** Each facet's name, as its control says it. */
export const PR_FACET_WORDS: Record<PrFacet, string> = {
  author: "Author",
  reviewRequested: l10n.t("Review requested"),
  assignee: "Assignee",
  label: "Label",
};

export interface PrListRequest {
  owner: string;
  repo: string;
  state: PrListState;
  filters?: PrListFilters;
  /** Rows per page (GitHub answers at most 100). */
  first: number;
  /** Where this page starts: the previous page's cursor. */
  after?: string;
}

export interface PrListPage {
  items: PrListItem[];
  /** How many pull requests match — the segment's count, filters applied. */
  total: number;
  hasMore: boolean;
  /** Where the next page starts. */
  cursor: string | null;
  /** The segments' counts (the first page only), filters applied. */
  counts?: PrListCounts;
  /** Who is signed in (the first page only). */
  viewer?: PrPerson;
}

/** A segment's count: All is the three together. */
export function countFor(counts: PrListCounts, state: PrListState): number {
  return state === "all" ? counts.open + counts.merged + counts.closed : counts[state];
}

// ── The transport ────────────────────────────────────────────────────────────

export interface GraphqlErrorLike {
  type?: string;
  message?: string;
  path?: readonly (string | number)[];
}

/**
 * One GraphQL request, as the host's client makes it: the answer's `data`
 * and `errors`, as GitHub sent them. An HTTP or network failure is the
 * host's to throw, in its own words.
 */
export type GraphqlFn = (
  query: string,
  variables: Record<string, unknown>,
) => Promise<{ data?: unknown; errors?: readonly GraphqlErrorLike[] }>;

/** Why a page couldn't be read, in the list's terms. */
export class PrListError extends Error {
  constructor(
    message: string,
    readonly kind: "not-found" | "forbidden" | "rate-limit" | "query",
  ) {
    super(message);
    this.name = "PrListError";
  }
}

// ── The query ────────────────────────────────────────────────────────────────

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;
/** A GitHub login: letters, digits and single hyphens, at most 39. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/** A person facet's value as GitHub's search takes it, or undefined when it isn't one. */
export function personQualifierValue(v: string | undefined): string | undefined {
  if (!v) return undefined;
  if (v === "@me") return v;
  if (v === NO_ONE) return undefined;
  const login = v.replace(/^@/, "");
  // A bot's login reads `name[bot]` on GitHub; search takes it as `app/name`.
  const bot = /^([A-Za-z0-9-]+)\[bot\]$/.exec(login);
  if (bot) return `app/${bot[1]}`;
  return LOGIN.test(login) ? login : undefined;
}

/**
 * The user's search words, safe to put beside `repo:owner/repo`: any
 * qualifier that would widen the search to other repositories (`repo:`,
 * `org:`, `user:`), turn it to issues, fight the segment (`is:open` on
 * Merged) or reorder it is taken out. The rest (`is:draft`, `base:main`,
 * plain words) is GitHub's to read.
 */
export function searchText(text: string | undefined): string {
  if (!text) return "";
  return text
    .replace(/[\r\n\t]+/g, " ")
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 0 &&
        !/^-?(repo|org|user|owner|type|sort):/i.test(w) &&
        !/^-?is:(issue|pr|pull-request|open|closed|merged|unmerged)$/i.test(w),
    )
    .join(" ")
    .slice(0, 256)
    .trim();
}

/** True when the list is narrowed by anything but its segment. */
export function hasFilters(f: PrListFilters | undefined): boolean {
  if (!f) return false;
  return (
    searchText(f.text).length > 0 ||
    personQualifierValue(f.author) !== undefined ||
    personQualifierValue(f.reviewRequested) !== undefined ||
    f.assignee === NO_ONE ||
    personQualifierValue(f.assignee) !== undefined ||
    !!labelValue(f.label)
  );
}

function labelValue(v: string | undefined): string | undefined {
  const s = (v ?? "").replace(/["\r\n]/g, "").trim();
  return s.length > 0 ? s : undefined;
}

/** The search string for one segment of the request: repository, state, filters, order. */
export function searchQueryFor(req: Pick<PrListRequest, "owner" | "repo" | "filters">, state: PrListState): string {
  checkRepo(req.owner, req.repo);
  const f = req.filters ?? {};
  const parts = [`repo:${req.owner}/${req.repo}`, "is:pr"];
  if (state === "open") parts.push("is:open");
  else if (state === "merged") parts.push("is:merged");
  else if (state === "closed") parts.push("is:closed", "is:unmerged");
  const author = personQualifierValue(f.author);
  if (author) parts.push(`author:${author}`);
  const reviewer = personQualifierValue(f.reviewRequested);
  if (reviewer) parts.push(`review-requested:${reviewer}`);
  const assignee = personQualifierValue(f.assignee);
  if (f.assignee === NO_ONE) parts.push("no:assignee");
  else if (assignee) parts.push(`assignee:${assignee}`);
  const label = labelValue(f.label);
  if (label) parts.push(`label:"${label}"`);
  const text = searchText(f.text);
  if (text) parts.push(text);
  parts.push("sort:updated-desc");
  return parts.join(" ");
}

function checkRepo(owner: string, repo: string): void {
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo)) {
    throw new PrListError(l10n.t("\"{0}/{1}\" isn't a GitHub repository name.", owner, repo), "query");
  }
}

/** What one row asks GitHub for. */
export const PR_ROW_FRAGMENT = `fragment PrRow on PullRequest {
  number title url state isDraft mergedAt closedAt createdAt updatedAt
  repository { nameWithOwner }
  author { login avatarUrl(size: 40) }
  headRefName headRefOid baseRefName baseRefOid isCrossRepository maintainerCanModify
  headRepositoryOwner { login }
  headRepository { nameWithOwner url }
  reviewDecision
  comments { totalCount }
  labels(first: 10) { nodes { name color } }
  assignees(first: 5) { nodes { login avatarUrl(size: 40) } }
  reviewRequests(first: 10) { nodes { requestedReviewer { __typename ... on User { login avatarUrl(size: 40) } ... on Team { slug } ... on Bot { login } ... on Mannequin { login } } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state contexts(first: 0) { checkRunCountsByState { state count } statusContextCountsByState { state count } } } } } }
}`;

const GRAPHQL_STATES: Record<PrListState, string[] | null> = {
  open: ["OPEN"],
  merged: ["MERGED"],
  closed: ["CLOSED"],
  all: null,
};

/** The query and variables for one page — which shape, and whether the header's counts come with it. */
export function prListQuery(req: PrListRequest): { query: string; variables: Record<string, unknown>; shape: "list" | "search" } {
  checkRepo(req.owner, req.repo);
  const first = Math.max(1, Math.min(100, Math.floor(req.first)));
  const firstPage = !req.after;
  if (!hasFilters(req.filters)) {
    const counts = firstPage
      ? `open: pullRequests(states: [OPEN]) { totalCount }
    merged: pullRequests(states: [MERGED]) { totalCount }
    closed: pullRequests(states: [CLOSED]) { totalCount }`
      : "";
    const query = `query($owner: String!, $name: String!, $first: Int!, $after: String, $states: [PullRequestState!]) {
  ${firstPage ? "viewer { login avatarUrl(size: 40) }" : ""}
  repository(owner: $owner, name: $name) {
    nameWithOwner
    ${counts}
    list: pullRequests(states: $states, first: $first, after: $after, orderBy: {field: UPDATED_AT, direction: DESC}) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { ...PrRow }
    }
  }
}
${PR_ROW_FRAGMENT}`;
    return {
      query,
      variables: { owner: req.owner, name: req.repo, first, after: req.after ?? null, states: GRAPHQL_STATES[req.state] },
      shape: "list",
    };
  }
  const counts = firstPage
    ? `open: search(query: $qOpen, type: ISSUE, first: 0) { issueCount }
  merged: search(query: $qMerged, type: ISSUE, first: 0) { issueCount }
  closed: search(query: $qClosed, type: ISSUE, first: 0) { issueCount }`
    : "";
  const query = `query($q: String!, $first: Int!, $after: String${firstPage ? ", $qOpen: String!, $qMerged: String!, $qClosed: String!" : ""}) {
  ${firstPage ? "viewer { login avatarUrl(size: 40) }" : ""}
  ${counts}
  list: search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes { ... on PullRequest { ...PrRow } }
  }
}
${PR_ROW_FRAGMENT}`;
  const variables: Record<string, unknown> = {
    q: searchQueryFor(req, req.state),
    first,
    after: req.after ?? null,
  };
  if (firstPage) {
    variables.qOpen = searchQueryFor(req, "open");
    variables.qMerged = searchQueryFor(req, "merged");
    variables.qClosed = searchQueryFor(req, "closed");
  }
  return { query, variables, shape: "search" };
}

// ── The answer ───────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub's JSON, read field by field */
type Json = any;

function person(u: Json): PrPerson | null {
  if (!u || typeof u.login !== "string") return null;
  return { login: u.login, avatarUrl: typeof u.avatarUrl === "string" ? u.avatarUrl : null };
}

/** One GraphQL PullRequest node → a row. Null for anything that isn't one. */
export function mapPrNode(n: Json): PrListItem | null {
  if (!n || typeof n.number !== "number" || typeof n.title !== "string") return null;
  const gqlState = String(n.state ?? "OPEN");
  const mergedAt = typeof n.mergedAt === "string" ? n.mergedAt : null;
  const state: "open" | "closed" = gqlState === "OPEN" ? "open" : "closed";
  const draft = n.isDraft === true;
  const reviewRequests: PrReviewRequest[] = [];
  for (const r of n.reviewRequests?.nodes ?? []) {
    const who = r?.requestedReviewer;
    if (!who) continue;
    if (who.__typename === "Team" && typeof who.slug === "string") reviewRequests.push({ team: who.slug });
    else if (typeof who.login === "string") reviewRequests.push({ login: who.login, avatarUrl: who.avatarUrl ?? null });
  }
  return {
    number: n.number,
    title: n.title,
    url: String(n.url ?? ""),
    kind: prKind({ state, draft, mergedAt }),
    draft,
    state,
    mergedAt,
    closedAt: typeof n.closedAt === "string" ? n.closedAt : null,
    createdAt: String(n.createdAt ?? ""),
    updatedAt: String(n.updatedAt ?? n.createdAt ?? ""),
    author: person(n.author),
    headRef: String(n.headRefName ?? ""),
    headSha: String(n.headRefOid ?? ""),
    headOwner: typeof n.headRepositoryOwner?.login === "string" ? n.headRepositoryOwner.login : null,
    headRepo: typeof n.headRepository?.nameWithOwner === "string" ? n.headRepository.nameWithOwner : null,
    headUrl: typeof n.headRepository?.url === "string" ? n.headRepository.url : null,
    baseRef: String(n.baseRefName ?? ""),
    baseSha: String(n.baseRefOid ?? ""),
    isFork: n.isCrossRepository === true,
    maintainerCanModify: n.maintainerCanModify === true,
    labels: (n.labels?.nodes ?? [])
      .filter((l: Json) => l && typeof l.name === "string")
      .map((l: Json) => ({ name: l.name, color: /^[0-9a-fA-F]{6}$/.test(String(l.color)) ? String(l.color) : "888888" })),
    assignees: (n.assignees?.nodes ?? []).map(person).filter((p: PrPerson | null): p is PrPerson => p !== null),
    reviewRequests,
    reviewDecision: reviewDecisionOf(n.reviewDecision),
    ci: ciFromRollup(n.commits?.nodes?.[0]?.commit?.statusCheckRollup),
    comments: Number(n.comments?.totalCount ?? 0) || 0,
    repository: String(n.repository?.nameWithOwner ?? ""),
  };
}

function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** The first error of a type GitHub names, if any. */
function errorOf(errors: readonly GraphqlErrorLike[] | undefined, type: string): GraphqlErrorLike | undefined {
  return errors?.find((e) => e.type === type);
}

/**
 * GitHub's answer → a page. A repository GitHub doesn't know (or this
 * sign-in can't see) is `not-found`; GraphQL's own rate limit, `rate-limit`.
 * Partial answers are kept: a row GitHub couldn't fill is left out, not the
 * whole list.
 */
export function parsePrListResponse(
  req: PrListRequest,
  shape: "list" | "search",
  res: { data?: unknown; errors?: readonly GraphqlErrorLike[] },
): PrListPage {
  const data = (res.data ?? null) as Json;
  const errors = res.errors;
  const limited = errorOf(errors, "RATE_LIMITED");
  if (limited) {
    throw new PrListError(limited.message || l10n.t("GitHub's rate limit was reached. Try again in a few minutes."), "rate-limit");
  }
  const where = `${req.owner}/${req.repo}`;
  if (shape === "list" && (!data || !data.repository)) {
    if (errorOf(errors, "NOT_FOUND") || (data && data.repository === null)) {
      throw new PrListError(
        l10n.t("GitHub has no repository {0} — or this sign-in can't see it.", where),
        "not-found",
      );
    }
    const forbidden = errorOf(errors, "FORBIDDEN");
    if (forbidden) throw new PrListError(forbidden.message || l10n.t("GitHub refused to list {0}'s pull requests.", where), "forbidden");
    throw new PrListError(errors?.[0]?.message || l10n.t("GitHub couldn't answer the query."), "query");
  }
  if (shape === "search" && (!data || !data.list)) {
    const forbidden = errorOf(errors, "FORBIDDEN");
    if (forbidden) throw new PrListError(forbidden.message || l10n.t("GitHub refused to search {0}.", where), "forbidden");
    throw new PrListError(errors?.[0]?.message || l10n.t("GitHub couldn't answer the query."), "query");
  }
  const list = shape === "list" ? data.repository.list : data.list;
  const items: PrListItem[] = [];
  for (const node of list?.nodes ?? []) {
    const item = mapPrNode(node);
    // Another repository's pull request is never this list's row.
    if (item && (item.repository === "" || sameRepo(item.repository, where))) items.push(item);
  }
  const total = Number(shape === "list" ? list?.totalCount : list?.issueCount) || 0;
  const counted = shape === "list" ? data.repository : data;
  const counts =
    counted?.open && counted?.merged && counted?.closed
      ? {
          open: Number(counted.open.totalCount ?? counted.open.issueCount) || 0,
          merged: Number(counted.merged.totalCount ?? counted.merged.issueCount) || 0,
          closed: Number(counted.closed.totalCount ?? counted.closed.issueCount) || 0,
        }
      : undefined;
  const viewer = person(data?.viewer) ?? undefined;
  return {
    items,
    total,
    hasMore: list?.pageInfo?.hasNextPage === true,
    cursor: typeof list?.pageInfo?.endCursor === "string" ? list.pageInfo.endCursor : null,
    ...(counts ? { counts } : {}),
    ...(viewer ? { viewer } : {}),
  };
}

/** Read one page of a repository's pull requests. */
export async function fetchPrListPage(graphql: GraphqlFn, req: PrListRequest): Promise<PrListPage> {
  const { query, variables, shape } = prListQuery(req);
  return parsePrListResponse(req, shape, await graphql(query, variables));
}

// ── The repository behind the list ───────────────────────────────────────────

export interface PrRepoInfo {
  owner: string;
  repo: string;
  url: string;
  isFork: boolean;
  /** The repository this one was forked from. */
  parent?: { owner: string; repo: string; url: string };
  defaultBranch?: string;
}

const REPO_INFO_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    nameWithOwner url isFork
    defaultBranchRef { name }
    parent { nameWithOwner url }
  }
}`;

function splitName(nameWithOwner: unknown): { owner: string; repo: string } | undefined {
  if (typeof nameWithOwner !== "string") return undefined;
  const [owner, repo, ...rest] = nameWithOwner.split("/");
  return owner && repo && rest.length === 0 ? { owner, repo } : undefined;
}

/**
 * Is `owner/repo` a fork, and of what? Undefined when GitHub doesn't know the
 * repository (or this sign-in can't see it).
 */
export async function fetchRepoInfo(graphql: GraphqlFn, owner: string, repo: string): Promise<PrRepoInfo | undefined> {
  checkRepo(owner, repo);
  const res = await graphql(REPO_INFO_QUERY, { owner, name: repo });
  const limited = errorOf(res.errors, "RATE_LIMITED");
  if (limited) throw new PrListError(limited.message || l10n.t("GitHub's rate limit was reached."), "rate-limit");
  const r = (res.data as Json)?.repository;
  const name = splitName(r?.nameWithOwner);
  if (!r || !name) return undefined;
  const parent = splitName(r.parent?.nameWithOwner);
  return {
    ...name,
    url: String(r.url ?? `https://github.com/${name.owner}/${name.repo}`),
    isFork: r.isFork === true,
    ...(parent ? { parent: { ...parent, url: String(r.parent.url ?? `https://github.com/${parent.owner}/${parent.repo}`) } } : {}),
    ...(typeof r.defaultBranchRef?.name === "string" ? { defaultBranch: r.defaultBranchRef.name } : {}),
  };
}

// ── What the filter menus offer ──────────────────────────────────────────────

export interface PrFacetOptions {
  labels: { name: string; color: string }[];
  /** People who can be assigned (the repository's collaborators). */
  people: PrPerson[];
  /** More labels or people than were read. */
  truncated: boolean;
}

const FACET_OPTIONS_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    labels(first: 100, orderBy: {field: NAME, direction: ASC}) { totalCount nodes { name color } }
    assignableUsers(first: 100) { totalCount nodes { login avatarUrl(size: 40) } }
  }
}`;

/** The labels and people the filter menus list, in one request. */
export async function fetchFacetOptions(graphql: GraphqlFn, owner: string, repo: string): Promise<PrFacetOptions> {
  checkRepo(owner, repo);
  const res = await graphql(FACET_OPTIONS_QUERY, { owner, name: repo });
  const r = (res.data as Json)?.repository;
  if (!r) {
    throw new PrListError(res.errors?.[0]?.message || l10n.t("GitHub has no repository {0}/{1}.", owner, repo), "not-found");
  }
  const labels = (r.labels?.nodes ?? [])
    .filter((l: Json) => l && typeof l.name === "string")
    .map((l: Json) => ({ name: l.name, color: /^[0-9a-fA-F]{6}$/.test(String(l.color)) ? String(l.color) : "888888" }));
  const people = (r.assignableUsers?.nodes ?? []).map(person).filter((p: PrPerson | null): p is PrPerson => p !== null);
  const truncated =
    Number(r.labels?.totalCount ?? 0) > labels.length || Number(r.assignableUsers?.totalCount ?? 0) > people.length;
  return { labels, people, truncated };
}

// ── Is it checked out here? ──────────────────────────────────────────────────

/** The local branch checked out, and what it tracks. */
export interface LocalHead {
  /** Undefined on a detached HEAD. */
  branch?: string;
  upstream?: {
    /** "owner/repo" of the remote it tracks, when that remote is on GitHub. */
    repo?: string;
    branch: string;
  };
}

/**
 * Is this pull request's branch the one checked out? Its head branch,
 * tracked from the repository the head lives in; GitStudio's own `pr/<n>`
 * copy; or, with nothing tracked, a same-repository head of the same name.
 * A fork's `main` is never your `main`.
 */
export function isCheckedOut(item: Pick<PrListItem, "number" | "headRef" | "headRepo" | "isFork">, local: LocalHead | undefined): boolean {
  if (!local?.branch) return false;
  const up = local.upstream;
  if (up?.repo && item.headRepo) {
    if (up.branch === item.headRef && sameRepo(up.repo, item.headRepo)) return true;
  }
  if (local.branch === `pr/${item.number}`) return true;
  if (!up?.repo && !item.isFork && local.branch === item.headRef) return true;
  return false;
}
