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
  /** Where on its first line the selection starts; 1 is before the first character. */
  readonly startColumn?: number;
  /** Where on its last line the selection ends; 1 is before the first character. */
  readonly endColumn?: number;
}

/**
 * The 1-based line numbers covered by `selections`, deduplicated and ascending.
 *
 * Returns null when there is nothing to act on, which the caller reports as
 * "select some lines first" rather than staging an empty set.
 */
export function selectedLineNumbers(
  selections: readonly LineSpan[] | null | undefined,
  documentEnd?: { lineNumber: number; column: number },
): number[] | null {
  if (!selections || selections.length === 0) return null;

  const lines = new Set<number>();
  for (const sel of selections) {
    // Monaco normalises selections, but a reversed one (dragged upwards) would
    // otherwise contribute nothing at all rather than obviously misbehaving.
    const from = Math.min(sel.startLineNumber, sel.endLineNumber);
    let to = Math.max(sel.startLineNumber, sel.endLineNumber);
    // A selection that ends at the very START of a later line does not take
    // that line: clicking a line number (or dragging down the line numbers)
    // selects up to column 1 of the NEXT line, and that line was staged too —
    // the next change along, if one started there. Monaco's own Move Line and
    // Indent read a selection the same way; so does the extension (#87).
    //
    // Except at the END of the document: Select All in a file ending in a line
    // break stops at column 1 of the empty last row, and that row is where
    // adding the final line break (or emptying the last line) shows as a
    // change — dropping it left that change out, or said "Nothing to apply".
    if (!reachesEnd(sel, documentEnd) && sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber) to -= 1;
    // A zero-width selection (just a caret) still means that one line.
    for (let l = from; l <= to; l++) lines.add(l);
  }

  if (lines.size === 0) return null;
  // Ascending, so the staging side sees one stable order however the cursors
  // were placed — and so overlapping selections cannot stage a line twice.
  return [...lines].sort((a, b) => a - b);
}

/**
 * The line BOUNDARIES the selections reach, as the 1-based number of the line
 * each one sits above, ascending — or null when there are none.
 *
 * A selection that ends at column 1 of a later line does not take that line
 * (selectedLineNumbers), but it does reach the edge before it, and a deletion
 * anchored there belongs to it: Select All in a file that ends in a line break
 * stops at column 1 of the empty last row, exactly where a deletion of the
 * file's last lines sits — dropping that edge left the deletion out of the
 * commit while saying "Staged selected lines." A selection that reaches
 * `documentEnd` (the last line and its max column) also reaches the edge after
 * the last line, where a file without a final line break anchors such a
 * deletion. The extension's twin is lineTargets.selectionLines.
 */
export function selectedBoundaries(
  selections: readonly LineSpan[] | null | undefined,
  documentEnd?: { lineNumber: number; column: number },
): number[] | null {
  if (!selections || selections.length === 0) return null;
  const edges = new Set<number>();
  for (const sel of selections) {
    if (reachesEnd(sel, documentEnd)) {
      // Its last row is kept (selectedLineNumbers); the edge after it is not a row.
      edges.add(documentEnd!.lineNumber + 1);
    } else if (sel.endColumn === 1 && sel.endLineNumber > sel.startLineNumber) {
      edges.add(sel.endLineNumber);
    }
  }
  return edges.size === 0 ? null : [...edges].sort((a, b) => a - b);
}

/** Whether a non-empty selection ends exactly at the end of the document. */
function reachesEnd(sel: LineSpan, documentEnd: { lineNumber: number; column: number } | undefined): boolean {
  if (!documentEnd) return false;
  const empty = sel.startLineNumber === sel.endLineNumber && sel.startColumn === sel.endColumn;
  return !empty && sel.endLineNumber === documentEnd.lineNumber && sel.endColumn === documentEnd.column;
}
