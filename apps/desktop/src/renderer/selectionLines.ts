// Turning Monaco selections into the line list the staging side wants.
//
// Extracted from DiffPanel so it can be tested without a DOM or a real editor:
// the bug this exists to prevent was invisible in the UI. Reading only the
// PRIMARY selection staged the first range and dropped every other cursor, so
// alt-clicking four scattered lines staged one of them and said nothing.

/** The only part of a Monaco selection this needs — 1-based, inclusive. */
export interface LineSpan {
  readonly startLineNumber: number;
  readonly endLineNumber: number;
}

/**
 * The 1-based line numbers covered by `selections`, deduplicated and ascending.
 *
 * Returns null when there is nothing to act on, which the caller reports as
 * "select some lines first" rather than staging an empty set.
 */
export function selectedLineNumbers(
  selections: readonly LineSpan[] | null | undefined,
): number[] | null {
  if (!selections || selections.length === 0) return null;

  const lines = new Set<number>();
  for (const sel of selections) {
    // Monaco normalises selections, but a reversed one (dragged upwards) would
    // otherwise contribute nothing at all rather than obviously misbehaving.
    const from = Math.min(sel.startLineNumber, sel.endLineNumber);
    const to = Math.max(sel.startLineNumber, sel.endLineNumber);
    // A zero-width selection (just a caret) still means that one line.
    for (let l = from; l <= to; l++) lines.add(l);
  }

  if (lines.size === 0) return null;
  // Ascending, so the staging side sees one stable order however the cursors
  // were placed — and so overlapping selections cannot stage a line twice.
  return [...lines].sort((a, b) => a - b);
}
