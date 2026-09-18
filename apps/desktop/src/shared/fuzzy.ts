// How well a typed query matches a name — the scorer behind the command palette
// and the repository search.
//
// Node-free and separate from the palette so it can be unit-tested without a
// browser, the same split as `refName.ts` and `branchStart.ts`.

/** The first letter of each word in a name — "flexi-meal-ai" -> "fma". */
function initialsOf(t: string): string {
  return (t.match(/(^|[\s/\-._])([a-z0-9])/g) ?? []).map((m) => m[m.length - 1]).join("");
}

/**
 * How well `query` matches `text`. 0 means "do not show this at all".
 *
 * A plain subsequence match is far too generous on its own: every character of
 * "ckaude" appears in order somewhere inside "v0-ckd-cats-guide", so a typo for
 * "claude" scored 43.8 there — ABOVE "cats" at 38.8, which is a real substring
 * of the same name. The letters being present in order says almost nothing; how
 * TIGHTLY they sit together is the thing that separates a match from noise.
 *
 * So the run is weighted by its density — matched characters over the span they
 * were found in — and a query of four or more characters scattered over more
 * than twice its own length is refused outright. "gitst" stops dragging in
 * "merge-conflict-tests"; "cats", "reshaped" and "merge" are untouched.
 *
 * Initials are matched separately rather than left to the scatter rule, because
 * "fma" for "flexi-meal-ai" is a deliberate way to type a name, not a near-miss.
 */
export function fuzzyScore(query: string, text: string): number {
  if (!query) return 1;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let qi = 0;
  let score = 0;
  let streak = 0;
  let first = -1;
  let last = -1;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      if (first < 0) first = ti;
      last = ti;
      qi++;
      streak++;
      score += 2 + streak; // consecutive hits compound
      if (ti === 0 || t[ti - 1] === " " || t[ti - 1] === "/" || t[ti - 1] === "-") score += 4;
    } else {
      streak = 0;
    }
  }
  if (qi < q.length) {
    // Not a subsequence — but it may still be how the name is abbreviated.
    return q.length >= 2 && initialsOf(t).startsWith(q) ? 30 + Math.max(0, 24 - t.length / 4) : 0;
  }
  const base = score + Math.max(0, 24 - t.length / 4); // shorter targets edge ahead
  const density = q.length / (last - first + 1);
  if (q.length >= 4 && density < 0.5) return 0;
  return base * density;
}
