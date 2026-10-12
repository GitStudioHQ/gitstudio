import {
  applySelectedChanges,
  computeHunks,
  isEmptyRange,
  rangesIntersect,
  type Hunk,
  type LineRange,
} from "./applyLineChanges";
import { revertSelectedLines, takeSelectedLines } from "./applySelectedLines";

/**
 * Staging and unstaging what an editor SELECTION touches — the pure half of the
 * "Stage / Unstage Selected Lines" and "Stage / Unstage Hunk" commands.
 *
 * The selection is always numbered like the WORKING tree, because it was made
 * in an editor showing the working file (or the working side of a diff). The
 * staging direction is diffed index → working, so the selection is already in
 * the right coordinates. The unstaging direction is diffed HEAD → index, and a
 * selection matched against it without translation picks the wrong change as
 * soon as an unstaged edit above it shifts the lines: a staged change the user
 * never pointed at is rolled back, and the one they did point at stays. The
 * desktop app found and fixed exactly that in its own copy; this is the shared
 * one.
 *
 * A selection may also hold EMPTY ranges: line boundaries, where an editor
 * selection ended at the very start of a line (see selectionTakes). A boundary
 * takes the deletion anchored there and nothing else, so Select All still
 * takes a deletion at the end of the file while a click on a line number
 * still does not take the next line's change.
 */

/** What a selection did: the new index text, and how many changes it moved. */
export interface SelectionWrite {
  content: string;
  changes: number;
}

/**
 * Re-expresses ranges numbered on the MODIFIED side of `hunks` in ORIGINAL-side
 * coordinates.
 *
 * Used to carry a working-tree selection back into index numbering before it is
 * matched against the index→HEAD hunks. Lines outside every hunk shift by the
 * running length difference of the hunks before them; a line inside a hunk maps
 * to that hunk's whole original span. Lines the original does not have at all —
 * a working-only insertion — map to nothing, because there is no staged change
 * under them to pick up.
 */
export function toOriginalRanges(ranges: LineRange[], hunks: Hunk[]): LineRange[] {
  const len = (r: LineRange): number => (r.end < r.start ? 0 : r.end - r.start + 1);
  const mapped: LineRange[] = [];
  // The mapping is monotonic, so folding each result into the previous one keeps
  // the output the size of the selection's shape rather than its line count.
  const add = (r: LineRange): void => {
    const last = mapped[mapped.length - 1];
    if (last && r.start >= last.start && r.start <= last.end + 1) {
      last.end = Math.max(last.end, r.end);
      return;
    }
    mapped.push(r);
  };
  for (const range of ranges) {
    for (let line = range.start; line <= range.end; line++) {
      let delta = 0;
      let landed = false;
      for (const h of hunks) {
        if (len(h.modified) > 0 && line >= h.modified.start && line <= h.modified.end) {
          if (len(h.original) > 0) add({ ...h.original });
          landed = true;
          break;
        }
        if (h.modified.start > line) break;
        delta += len(h.modified) - len(h.original);
      }
      if (!landed) add({ start: line - delta, end: line - delta });
    }
  }
  return mapped;
}

/**
 * toOriginalRanges for a whole selection, boundaries included: a boundary
 * before working line L becomes the boundary just after the index lines the
 * line above it maps to (or, when that line exists only in the working tree,
 * just before the index line L maps to).
 */
export function toOriginalSelection(selected: LineRange[], hunks: Hunk[]): LineRange[] {
  const out: LineRange[] = [];
  for (const range of selected) {
    if (!isEmptyRange(range)) {
      out.push(...toOriginalRanges([range], hunks));
      continue;
    }
    const line = range.start;
    const above = line > 0 ? toOriginalRanges([{ start: line - 1, end: line - 1 }], hunks) : [];
    const below = toOriginalRanges([{ start: line, end: line }], hunks);
    const at = above.length ? above[above.length - 1].end + 1 : below.length ? below[0].start : undefined;
    if (at !== undefined) out.push({ start: at, end: at - 1 });
  }
  return out;
}

/**
 * The index text that stages every change the WORKING-tree lines `selected`
 * touch, leaving the rest of the file's unstaged changes alone — or undefined
 * when the selection touches no unstaged change.
 *
 * Only the selected LINES of a change are staged where a line of it can stand
 * alone — an insertion, or a modification with as many lines on each side —
 * and the whole change otherwise (see applySelectedLines). The tick beside a
 * change in a diff stays whole-block on purpose; this is the selection's rule.
 *
 * A selection that moves no line is nothing to stage — a caret on the empty
 * row after a new file's last line used to "stage" an empty file.
 */
export function stageSelection(
  indexText: string,
  workingText: string,
  selected: LineRange[],
): SelectionWrite | undefined {
  const staged = takeSelectedLines(indexText, workingText, selected);
  return staged.changes === 0 ? undefined : staged;
}

/**
 * The index text with every STAGED change under the working-tree lines
 * `selected` rolled back to HEAD — or undefined when none is under them.
 *
 * `workingText` is what the selection is numbered against; it is translated
 * into index numbering through the index→working diff before it is matched.
 *
 * The same line rule as staging, backwards (see revertSelectedLines): only the
 * selected lines of a staged insertion or same-length edit leave the index.
 * A working line inside an UNSTAGED change maps to that change's whole index
 * span (toOriginalRanges), so there the unit is that span.
 */
export function unstageSelection(
  headText: string,
  indexText: string,
  workingText: string,
  selected: LineRange[],
): SelectionWrite | undefined {
  const inIndex = toOriginalSelection(selected, computeHunks(indexText, workingText));
  const unstaged = revertSelectedLines(headText, indexText, inIndex);
  return unstaged.changes === 0 ? undefined : unstaged;
}

/**
 * Stage Hunk: every unstaged change under a cursor line (WORKING numbering),
 * whole — a hunk command moves hunks, whatever rule a selection follows. A
 * deletion counts as the line it sits above, so a cursor there stages it (it
 * never could: the cursor was tested against the change's own lines, and a
 * deletion has none).
 */
export function stageHunks(
  indexText: string,
  workingText: string,
  cursorLines: number[],
): SelectionWrite | undefined {
  const picked = computeHunks(indexText, workingText).filter((h) =>
    cursorLines.some((line) => rangesIntersect(h.modified, { start: line, end: line })),
  );
  if (picked.length === 0) return undefined;
  return {
    content: applySelectedChanges(indexText, workingText, picked.map((h) => h.modified)),
    changes: picked.length,
  };
}

/**
 * Unstage Hunk: every STAGED change under a cursor line (WORKING numbering,
 * carried into the index's), rolled back to HEAD whole.
 */
export function unstageHunks(
  headText: string,
  indexText: string,
  workingText: string,
  cursorLines: number[],
): SelectionWrite | undefined {
  const staged = computeHunks(headText, indexText);
  const inIndex = toOriginalRanges(
    cursorLines.map((line) => ({ start: line, end: line })),
    computeHunks(indexText, workingText),
  );
  const dropped = staged.filter((h) => inIndex.some((r) => rangesIntersect(h.modified, r)));
  if (dropped.length === 0) return undefined;
  const kept = staged.filter((h) => !dropped.includes(h));
  return {
    content: applySelectedChanges(headText, indexText, kept.map((h) => h.modified)),
    changes: dropped.length,
  };
}
