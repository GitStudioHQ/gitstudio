// Pure query + path builders for GitHub search.
//
// Split from the fetchers so every URL this app can ask for is node-testable
// without a network — search paths are the easiest place to quietly build a
// wrong query (an unescaped qualifier, a sort GitHub rejects) and the hardest
// place to notice, since a wrong query returns results, just not the right
// ones.

export type SearchKind = "repos" | "users" | "orgs" | "code";
export type RepoSort = "best" | "stars" | "updated";

/** GitHub caps every search at 1000 results, however many it claims to match. */
export const SEARCH_RESULT_CEILING = 1000;
export const SEARCH_PER_PAGE = 30;

/** Trim, collapse whitespace — the form a query is cached and compared by. */
export function normalizeQuery(raw: string): string {
  return raw.trim().replace(/\s+/g, " ");
}

/**
 * The `q` for a user/org search. GitHub has no "orgs" endpoint — orgs are
 * users with `type:org`, and the qualifier is what separates the two tabs.
 * A user-supplied `type:` is left alone: someone who types it means it.
 */
export function userQuery(query: string, kind: "users" | "orgs"): string {
  const q = normalizeQuery(query);
  if (/\btype:\s*\S+/i.test(q)) return q;
  return `${q} type:${kind === "orgs" ? "org" : "user"}`;
}

/** `sort`/`order` params for a repo search; "best" means GitHub's own ranking
 *  (which is expressed by sending NO sort at all). */
export function repoSortParams(sort: RepoSort): Record<string, string> {
  if (sort === "stars") return { sort: "stars", order: "desc" };
  if (sort === "updated") return { sort: "updated", order: "desc" };
  return {};
}

function qs(params: Record<string, string | number>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) sp.set(k, String(v));
  return sp.toString();
}

/** `/search/repositories?…` for one page (1-based). */
export function repoSearchPath(query: string, sort: RepoSort, page = 1): string {
  return `/search/repositories?${qs({
    q: normalizeQuery(query),
    per_page: SEARCH_PER_PAGE,
    page,
    ...repoSortParams(sort),
  })}`;
}

/** `/search/users?…` for one page — `kind` picks the type: qualifier. */
export function userSearchPath(query: string, kind: "users" | "orgs", page = 1): string {
  return `/search/users?${qs({
    q: userQuery(query, kind),
    per_page: SEARCH_PER_PAGE,
    page,
  })}`;
}

/** `/search/code?…` for one page. */
export function codeSearchPath(query: string, page = 1): string {
  return `/search/code?${qs({
    q: normalizeQuery(query),
    per_page: SEARCH_PER_PAGE,
    page,
  })}`;
}

/** True when this page would reach past GitHub's hard 1000-result ceiling —
 *  asking anyway earns a 422, so the UI stops offering "Load more" instead. */
export function beyondCeiling(page: number): boolean {
  return page * SEARCH_PER_PAGE > SEARCH_RESULT_CEILING;
}

/** How many of `total` are actually reachable. The difference is what the UI
 *  must be honest about: "1,284 matches, first 1,000 available". */
export function reachableCount(total: number): number {
  return Math.min(total, SEARCH_RESULT_CEILING);
}
