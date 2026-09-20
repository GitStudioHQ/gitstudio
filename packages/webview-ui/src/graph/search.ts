// Commit search, shared by the editor-area graph and the sidebar rail: what a
// query can be scoped to, and whether a row matches it.
//
// Each component used to keep its own copy, and they drifted — the rail's
// "All" scope stopped looking at the author email while the graph's still
// did, so the same query counted different commits in the two lists.

import type { WireRow } from "@gitstudio/host-bridge/graphProtocol";

/** What the search query matches against. */
export type SearchScope = "all" | "message" | "author" | "sha" | "refs";

export const SEARCH_SCOPES: ReadonlyArray<{ id: SearchScope; label: string }> = [
  { id: "all", label: "All" },
  { id: "message", label: "Message" },
  { id: "author", label: "Author" },
  { id: "sha", label: "SHA" },
  { id: "refs", label: "Branch+Tag" },
];

/** One localStorage key for both lists, so the preference follows the user. */
export const LS_SEARCH_SCOPE = "gitstudio.graph.search.scope";

/** Whether a row matches the lowercased query under the chosen scope. */
export function rowMatches(r: WireRow, q: string, scope: SearchScope): boolean {
  switch (scope) {
    case "message":
      return r.subject.toLowerCase().includes(q);
    case "author":
      return (
        r.author.toLowerCase().includes(q) ||
        r.authorEmail.toLowerCase().includes(q)
      );
    case "sha":
      // SHA is prefix-matched against the full sha (so a long paste still hits).
      return r.sha.toLowerCase().startsWith(q) || r.shortSha.toLowerCase().startsWith(q);
    case "refs":
      return r.refs.some((ref) => ref.name.toLowerCase().includes(q));
    case "all":
    default:
      return (
        r.subject.toLowerCase().includes(q) ||
        r.author.toLowerCase().includes(q) ||
        r.authorEmail.toLowerCase().includes(q) ||
        r.sha.toLowerCase().startsWith(q) ||
        r.refs.some((ref) => ref.name.toLowerCase().includes(q))
      );
  }
}
