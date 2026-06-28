// A small, dependency-free fuzzy matcher (clean-room).
//
// Subsequence matching with positional scoring: contiguous runs, matches at the
// start of the string or right after a separator (/ - _ . space) or at a
// camelCase boundary score higher. "Smart case" — a query with any uppercase is
// matched case-sensitively; an all-lowercase query is case-insensitive. Returns
// the score and the matched character indices (for highlighting), or null when
// the query is not a subsequence of the candidate.
//
// Used by terminal autocomplete and (later) the command palette / file finder.

export interface FuzzyMatch {
  score: number;
  /** Indices into the candidate string that matched, ascending. */
  indices: number[];
}

const SEPARATORS = new Set(["/", "\\", "-", "_", ".", " ", ":", "@"]);

function isBoundary(text: string, i: number): boolean {
  if (i === 0) return true;
  if (SEPARATORS.has(text[i - 1])) return true;
  // camelCase boundary: lower→Upper.
  const prev = text[i - 1];
  const cur = text[i];
  return prev === prev.toLowerCase() && cur === cur.toUpperCase() && cur !== cur.toLowerCase();
}

/**
 * Score `query` against `candidate`. Higher is better. Empty query matches with
 * score 1 and no indices (everything is a candidate). Returns null on no match.
 */
export function fuzzyMatch(query: string, candidate: string): FuzzyMatch | null {
  if (query === "") return { score: 1, indices: [] };
  const caseSensitive = query !== query.toLowerCase();
  const q = caseSensitive ? query : query.toLowerCase();
  const c = caseSensitive ? candidate : candidate.toLowerCase();

  const indices: number[] = [];
  let score = 0;
  let qi = 0;
  let lastMatch = -2;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) continue;
    indices.push(ci);
    let bonus = 1;
    if (ci === lastMatch + 1) bonus += 5; // contiguous with the previous match
    if (isBoundary(candidate, ci)) bonus += 8; // start / after-separator / camel
    if (ci === 0) bonus += 4; // very start of the candidate
    score += bonus;
    lastMatch = ci;
    qi++;
  }
  if (qi < q.length) return null; // not all query chars consumed → no match

  // Prefer shorter, denser candidates; penalise gaps and trailing length.
  const span = (indices[indices.length - 1] ?? 0) - (indices[0] ?? 0) + 1;
  score -= Math.max(0, span - query.length) * 0.5;
  score -= Math.max(0, candidate.length - query.length) * 0.05;
  return { score, indices };
}

/** Classify how `query` matches `candidate` (for ranking tiers). */
export type MatchKind = "exact" | "prefix" | "fuzzy" | "none";

export function matchKind(query: string, candidate: string): MatchKind {
  if (!query) return "prefix";
  const cs = query !== query.toLowerCase();
  const q = cs ? query : query.toLowerCase();
  const c = cs ? candidate : candidate.toLowerCase();
  if (q === c) return "exact";
  if (c.startsWith(q)) return "prefix";
  return fuzzyMatch(query, candidate) ? "fuzzy" : "none";
}
