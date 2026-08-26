// Pure pagination helpers for the GitHub REST client — kept in their own
// module (no client / Electron imports) so they unit-test in isolation.
//
// GitHub paginates list endpoints with an RFC-5988 `Link` response header:
//   <https://api.github.com/repos/o/r/issues?page=2>; rel="next",
//   <https://api.github.com/repos/o/r/issues?page=9>; rel="last"
// Following rel="next" until it disappears (or a page cap) is the ONLY correct
// way to read a full list — `per_page=100` alone silently truncates busy repos.

/**
 * The rel="next" target from a `Link` header, as a PATH relative to `apiBase`
 * (the form `GitHubClient.request` takes), or undefined on the last page.
 * A rel="next" pointing at a different host is ignored — we never follow a
 * redirect off api.github.com.
 */
export function nextPagePath(
  linkHeader: string | null | undefined,
  apiBase: string,
): string | undefined {
  if (!linkHeader) return undefined;
  for (const part of linkHeader.split(",")) {
    const m = /<([^>]+)>\s*;\s*(?:[^,]*;\s*)?rel="next"/.exec(part.trim());
    if (!m) continue;
    const url = m[1];
    if (url.startsWith(apiBase)) return url.slice(apiBase.length);
    // A relative path is fine too (not what GitHub sends, but harmless).
    if (url.startsWith("/")) return url;
    return undefined; // absolute URL on some other host — refuse to follow
  }
  return undefined;
}

/**
 * Page caps per surface: how many pages `requestPaged` follows before stopping.
 * Deliberate ceilings — a repo with 4,000 open issues should not stall the
 * section behind 40 sequential requests. When a list comes back at exactly
 * cap × per_page items, the UI says "showing the first N" instead of lying.
 */
export const PAGE_CAPS = {
  /** Issues / PRs: 3 × 100 = 300 items. */
  list: 3,
  /** Workflow runs (heavy payloads): 2 × 100 = 200 runs. */
  runs: 2,
  /** Timeline comments / reviews / files / commits on one item: 3 × 100. */
  detail: 3,
  /** Org repos / members, branches, gists: 3 × 100. */
  account: 3,
  /** Notifications (endpoint max per_page=50): 3 × 50 = 150 threads. */
  notifications: 3,
} as const;
