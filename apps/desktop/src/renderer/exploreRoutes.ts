// Explore's routing vocabulary — pure, DOM-free, node-tested.
//
// Explore states ride in `target.id` as micro-paths rather than new
// SectionTarget fields, so ⌘[ / Esc walk search → repo → folder → file with no
// change to the shared navigation contract:
//
//   q/<tab>/<query>
//   repo/<owner>/<name>
//   repo/<owner>/<name>/(tree|blob)/<ref>/<path…>
//   repo/<owner>/<name>/commits/<ref>
//   user/<login>   org/<login>
//
// That makes these parsers load-bearing for navigation: a wrong parse doesn't
// throw, it silently strands someone on the wrong page. Hence the tests.

export type ExploreTab = "repos" | "users" | "orgs" | "code";

/** Where a search runs. "local" is this machine — no network, no account. */
export type ExploreScope = "github" | "local";

/** A parsed `repo/…` target. */
export interface RepoRoute {
  fullName: string;
  /** "" for the repo root. */
  path: string;
  /** Undefined = the repo's default branch. */
  ref?: string;
  /** "commits" is the history of `ref`; it carries no path. */
  kind: "tree" | "blob" | "commits";
}

/** `q/<tab>/<query>` — the routed form of a search. `q/local/<query>` is the
 *  this-machine scope, which has no tabs: local search is over repositories. */
export function searchTargetId(tab: ExploreTab, query: string): string {
  return `q/${tab}/${query}`;
}

export function localSearchTargetId(query: string): string {
  return `q/local/${query}`;
}

/** Parse a routed search target. Unknown shapes are ignored rather than
 *  throwing — a stale history entry must never break the view. */
export function parseExploreTarget(
  id: string | undefined,
): { tab: ExploreTab; query: string; scope: ExploreScope } | undefined {
  if (!id) return undefined;
  const m = /^q\/(repos|users|orgs|code|local)\/([\s\S]*)$/.exec(id);
  if (!m) return undefined;
  if (m[1] === "local") return { tab: "repos", query: m[2], scope: "local" };
  return { tab: m[1] as ExploreTab, query: m[2], scope: "github" };
}

/** `repo/<owner>/<name>[/tree|blob/<ref>/<path>]` → a route, or undefined. */
export function parseRepoRoute(id: string | undefined): RepoRoute | undefined {
  if (!id) return undefined;
  const m = /^repo\/([^/]+)\/([^/]+)(?:\/(tree|blob|commits)\/([^/]+)(?:\/([\s\S]*))?)?$/.exec(id);
  if (!m) return undefined;
  return {
    fullName: `${m[1]}/${m[2]}`,
    kind: (m[3] as "tree" | "blob" | "commits") ?? "tree",
    // "HEAD" is the sentinel a path-carrying route uses when no explicit ref
    // was chosen — it must parse back to "the default branch", or walking into
    // a file would silently pin the ref and relabel the switcher.
    ref: m[4] && m[4] !== "HEAD" ? decodeURIComponent(m[4]) : undefined,
    path: m[5] ?? "",
  };
}

/** The inverse — build the routed id for a location in a repo. */
export function repoRouteId(o: {
  fullName: string;
  path?: string;
  ref?: string;
  kind?: "tree" | "blob" | "commits";
}): string {
  const base = `repo/${o.fullName}`;
  // The history is a PLACE even on the default branch, so it always routes —
  // unlike a tree at the root, which is just the repo page.
  if (o.kind !== "commits" && !o.path && !o.ref) return base;
  const ref = encodeURIComponent(o.ref ?? "HEAD");
  if (o.kind === "commits") return `${base}/commits/${ref}`;
  return `${base}/${o.kind ?? "tree"}/${ref}${o.path ? `/${o.path}` : ""}`;
}

/** `user/<login>` or `org/<login>` → the login, or undefined. */
export function parseAccountTarget(id: string | undefined): { login: string } | undefined {
  if (!id) return undefined;
  const m = /^(?:user|org)\/([^/]+)$/.exec(id);
  return m ? { login: m[1] } : undefined;
}
