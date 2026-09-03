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

/**
 * The `q` for searching the issues of ONE repository.
 *
 * This is what makes the qualifiers people actually type work — `author:@me`,
 * `label:"needs design"`, `no:assignee`, `sort:comments-desc` — none of which
 * meant anything when the search box was a substring test over the issues that
 * happened to be loaded.
 *
 * Two things are added only when the caller has not said otherwise:
 *
 *   `repo:` — always, and always FIRST, because this box searches this
 *   repository. A `repo:` the user typed themselves is left in place too: they
 *   would be asking about another repository on purpose, and the results are
 *   labelled with their own repo anyway.
 *
 *   `is:issue` / `is:pr` and the open/closed state — only if absent. Typing
 *   `is:closed` must not fight the segment above the list; whoever typed it
 *   meant it.
 */
export function issueSearchQuery(
  repoFullName: string,
  query: string,
  opts: { state?: "open" | "closed" | "all"; kind?: "issue" | "pr" } = {},
): string {
  const q = normalizeQuery(query);
  const parts = [`repo:${repoFullName}`];
  if (!/\bis:\s*(issue|pr)\b/i.test(q)) parts.push(`is:${opts.kind ?? "issue"}`);
  // `is:open`/`is:closed`, or `state:` which GitHub also accepts.
  const saysState = /\b(is:\s*(open|closed)|state:\s*(open|closed))\b/i.test(q);
  if (!saysState && opts.state && opts.state !== "all") parts.push(`is:${opts.state}`);
  if (q) parts.push(q);
  return parts.join(" ");
}

/** `/search/issues?…` for one page of one repository's issues. */
export function issueSearchPath(
  repoFullName: string,
  query: string,
  opts: { state?: "open" | "closed" | "all"; kind?: "issue" | "pr"; page?: number } = {},
): string {
  return `/search/issues?${qs({
    q: issueSearchQuery(repoFullName, query, opts),
    per_page: SEARCH_PER_PAGE,
    page: opts.page ?? 1,
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
