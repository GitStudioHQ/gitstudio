// Pure line/hunk staging core. No vscode/fs imports — this is the algorithm that
// makes "stage exactly this one line" possible: given a base version and a
// modified version of a file, reconstruct the text that results from applying
// ONLY the selected changes, leaving every other change at its base state.
//
// This is what the VS Code extension feeds to `git update-index --cacheinfo`
// (via git-service's StagingProvider.stageContent) to stage a precise subset of
// the working-tree edits, and the inverse for partial unstaging.
//
// Implementation note: we splice over the RAW line arrays produced by the
// engine's `splitLines` (a plain `text.split("\n")`), the very same arrays the
// diff is computed against. The diff block spans therefore align 1:1 with these
// arrays. CRLF endings ride inside each element (the trailing "\r"), and a
// trailing newline rides as a final "" element — so reassembling with "\n"
// reproduces the source's EOL style and trailing-newline presence for free,
// hunk-by-hunk, with no separate EOL bookkeeping.

import { buildDiffModel } from "../diffModel";
import { splitLines } from "../lineDiff";
import type { DiffBlock, LineSpan } from "../types";

/**
 * A 0-based, inclusive range of lines in the MODIFIED document. `start`/`end`
 * are line indices; a single line is `{ start: n, end: n }`. Used to express
 * "the user selected these lines" for staging.
 */
export interface LineRange {
  start: number;
  end: number;
}

/** A diff hunk expressed in 0-based, inclusive line coordinates on each side. */
export interface Hunk {
  /** The affected span in the ORIGINAL document. */
  original: LineRange;
  /** The affected span in the MODIFIED document. */
  modified: LineRange;
}

/**
 * Converts an engine LineSpan (1-based, end-exclusive) into a 0-based inclusive
 * LineRange. A zero-width span (insertion / deletion point) yields `end < start`
 * (specifically `end === start - 1`), so callers can detect it via isEmptyRange.
 */
function spanToRange(span: LineSpan): LineRange {
  return { start: span.start - 1, end: span.endExclusive - 2 };
}

/** True for a zero-width (insertion-point) range, where end < start. */
function isEmptyRange(range: LineRange): boolean {
  return range.end < range.start;
}

/**
 * Whether two 0-based inclusive ranges overlap. A zero-width range (insertion
 * point) is treated as covering the single line at its `start`, so a selection
 * landing on that line still picks the change up.
 */
function rangesIntersect(a: LineRange, b: LineRange): boolean {
  const aEnd = isEmptyRange(a) ? a.start : a.end;
  const bEnd = isEmptyRange(b) ? b.start : b.end;
  return a.start <= bEnd && b.start <= aEnd;
}

/**
 * Computes the diff hunks between two texts as 0-based inclusive line ranges on
 * each side. A pure list the UI can render ("3 hunks in this file").
 */
export function computeHunks(originalText: string, modifiedText: string): Hunk[] {
  const model = buildDiffModel(originalText, modifiedText);
  return model.blocks.map((block: DiffBlock) => ({
    original: spanToRange(block.leftSpan),
    modified: spanToRange(block.rightSpan),
  }));
}

/**
 * Reconstructs the text to stage by taking `originalText` and applying ONLY the
 * hunks whose MODIFIED span intersects any `selected` range. Every other hunk is
 * left at its original state. Preserves the original's EOL style and
 * trailing-newline presence (per-hunk; see the module note).
 *
 * Walks the diff blocks in order, splicing original raw-lines for unselected
 * hunks (and the gaps between hunks) and modified raw-lines for selected hunks.
 * Because the blocks are ordered and non-overlapping, a single forward pass over
 * both documents yields the merged result.
 */
export function applySelectedChanges(
  originalText: string,
  modifiedText: string,
  selected: LineRange[],
): string {
  const model = buildDiffModel(originalText, modifiedText);
  const originalLines = splitLines(originalText);
  const modifiedLines = splitLines(modifiedText);

  const result: string[] = [];
  let origCursor = 0; // 0-based index into originalLines

  for (const block of model.blocks) {
    // Half-open [start, endExclusive) windows (0-based) for each side.
    const origStart = block.leftSpan.start - 1;
    const origEndExclusive = block.leftSpan.endExclusive - 1;
    const modStart = block.rightSpan.start - 1;
    const modEndExclusive = block.rightSpan.endExclusive - 1;

    // Copy untouched original lines before this block.
    for (; origCursor < origStart; origCursor++) {
      result.push(originalLines[origCursor]);
    }

    const modRange = spanToRange(block.rightSpan);
    const isSelected = selected.some((sel) => rangesIntersect(modRange, sel));
    if (isSelected) {
      for (let i = modStart; i < modEndExclusive; i++) {
        result.push(modifiedLines[i]);
      }
    } else {
      for (let i = origStart; i < origEndExclusive; i++) {
        result.push(originalLines[i]);
      }
    }
    origCursor = origEndExclusive;
  }

  // Trailing original lines after the last block.
  for (; origCursor < originalLines.length; origCursor++) {
    result.push(originalLines[origCursor]);
  }

  return result.join("\n");
}

/**
 * Convenience: stage the whole file (apply every change). Equivalent to staging
 * the full modified content, so it returns `modifiedText` verbatim.
 */
export function applyAllChanges(
  originalText: string,
  modifiedText: string,
): string {
  const hunks = computeHunks(originalText, modifiedText);
  if (hunks.length === 0) {
    return modifiedText;
  }
  return applySelectedChanges(
    originalText,
    modifiedText,
    hunks.map((h) => h.modified),
  );
}
