// Global GitHub search — the data half of the Explore page.
//
// Unlike every other section here, search is ACCOUNT-scoped and metered on its
// own budget (30/min, 10/min for code). So the model is deliberately one API
// request per invoke: an explicit page of 30, never an automatic Link-follow.
// Pagination is a user action ("Load more"), because each page is real money
// out of a small purse.
//
// Every failure mode the UI must distinguish is expressed in the RESULT, not
// as a throw: `limited` (our own budget says wait), `incomplete` (GitHub gave
// up early), and `hasMore: false` at the hard 1000-result ceiling.

import { GitHubClient } from "../githubClient";
import { SearchGuard } from "./searchGuard";
import {
  beyondCeiling,
  codeSearchPath,
  normalizeQuery,
  repoSearchPath,
  userSearchPath,
  SEARCH_PER_PAGE,
  SEARCH_RESULT_CEILING,
  type RepoSort,
} from "./searchQuery";
import { mapUser, type RawUser } from "./maps";
import type {
  SearchCodeItem,
  SearchPage,
  SearchRepoItem,
  SearchUserItem,
} from "../../shared/ipc";

/** The process-wide budget. One guard for the app: two windows fighting over
 *  the same GitHub quota is exactly how you earn a surprise 403. */
const guard = new SearchGuard();

interface RawSearchEnvelope<T> {
  total_count?: number;
  incomplete_results?: boolean;
  items?: T[];
}

interface RawSearchRepo {
  id: number;
  full_name: string;
  owner?: RawUser | null;
  description?: string | null;
  language?: string | null;
  stargazers_count?: number;
  forks_count?: number;
  open_issues_count?: number;
  updated_at?: string;
  pushed_at?: string;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  topics?: string[];
  license?: { spdx_id?: string | null; name?: string } | null;
  html_url?: string;
  default_branch?: string;
}

interface RawSearchCode {
  name?: string;
  path?: string;
  html_url?: string;
  repository?: { full_name?: string } | null;
  text_matches?: { fragment?: string }[];
}

function mapRepo(r: RawSearchRepo): SearchRepoItem {
  return {
    id: r.id,
    fullName: r.full_name,
    owner: r.owner?.login ?? r.full_name.split("/")[0] ?? "",
    ownerAvatarUrl: r.owner?.avatar_url ?? null,
    description: r.description ?? null,
    language: r.language ?? null,
    stars: r.stargazers_count ?? 0,
    forks: r.forks_count ?? 0,
    openIssues: r.open_issues_count ?? 0,
    updatedAt: r.updated_at ?? "",
    pushedAt: r.pushed_at ?? "",
    private: r.private ?? false,
    fork: r.fork ?? false,
    archived: r.archived ?? false,
    topics: r.topics ?? [],
    license: r.license?.spdx_id && r.license.spdx_id !== "NOASSERTION" ? r.license.spdx_id : null,
    htmlUrl: r.html_url ?? `https://github.com/${r.full_name}`,
    defaultBranch: r.default_branch ?? "",
  };
}

function mapCode(c: RawSearchCode): SearchCodeItem {
  return {
    name: c.name ?? "",
    path: c.path ?? "",
    repoFullName: c.repository?.full_name ?? "",
    htmlUrl: c.html_url ?? "",
    fragments: (c.text_matches ?? [])
      .map((m) => m.fragment ?? "")
      .filter((f) => f.trim().length > 0),
  };
}

/** An empty page — what an empty query returns without spending anything. */
function emptyPage<T>(): SearchPage<T> {
  return { items: [], totalCount: 0, incomplete: false, hasMore: false };
}

/** Shared envelope handling: budget check → fetch → page metadata. */
async function runSearch<Raw, Item>(
  client: GitHubClient,
  o: {
    query: string;
    page: number;
    category: "core" | "code";
    path: string;
    map: (raw: Raw) => Item;
    accept?: string;
  },
): Promise<SearchPage<Item>> {
  if (!normalizeQuery(o.query)) return emptyPage<Item>();
  // Past the ceiling GitHub answers 422 — refuse locally and keep the budget.
  if (beyondCeiling(o.page)) {
    return { items: [], totalCount: SEARCH_RESULT_CEILING, incomplete: false, hasMore: false };
  }
  const claim = guard.take(o.category);
  if (!claim.ok) {
    return { ...emptyPage<Item>(), limited: { retryInMs: claim.retryInMs } };
  }
  const env = await client.request<RawSearchEnvelope<Raw>>("GET", o.path, undefined, {
    accept: o.accept,
  });
  const items = (env.items ?? []).map(o.map);
  const total = env.total_count ?? items.length;
  return {
    items,
    totalCount: total,
    incomplete: env.incomplete_results ?? false,
    // More exists only if GitHub has more AND the next page is reachable.
    hasMore: items.length === SEARCH_PER_PAGE && !beyondCeiling(o.page + 1) && o.page * SEARCH_PER_PAGE < total,
  };
}

export function searchRepos(
  client: GitHubClient,
  req: { query: string; sort?: RepoSort; page?: number },
): Promise<SearchPage<SearchRepoItem>> {
  const page = req.page ?? 1;
  return runSearch<RawSearchRepo, SearchRepoItem>(client, {
    query: req.query,
    page,
    category: "core",
    path: repoSearchPath(req.query, req.sort ?? "best", page),
    map: mapRepo,
  });
}

export function searchUsers(
  client: GitHubClient,
  req: { query: string; kind: "users" | "orgs"; page?: number },
): Promise<SearchPage<SearchUserItem>> {
  const page = req.page ?? 1;
  return runSearch<RawUser & { html_url?: string; type?: string }, SearchUserItem>(client, {
    query: req.query,
    page,
    category: "core",
    path: userSearchPath(req.query, req.kind, page),
    map: (u) => ({
      login: mapUser(u)?.login ?? u.login,
      avatarUrl: u.avatar_url ?? null,
      htmlUrl: u.html_url ?? `https://github.com/${u.login}`,
      type: u.type ?? (req.kind === "orgs" ? "Organization" : "User"),
    }),
  });
}

export function searchCode(
  client: GitHubClient,
  req: { query: string; page?: number },
): Promise<SearchPage<SearchCodeItem>> {
  const page = req.page ?? 1;
  return runSearch<RawSearchCode, SearchCodeItem>(client, {
    query: req.query,
    page,
    category: "code",
    path: codeSearchPath(req.query, page),
    map: mapCode,
    // The text-match media type is what turns a file list into readable hits.
    accept: "application/vnd.github.text-match+json",
  });
}
