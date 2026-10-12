// Sub-block line staging: stage the selected LINES of a change, where a line
// of a change can be staged on its own without inventing anything.
//
// applySelectedChanges stages whole diff blocks — one selected line of a
// three-line edit stages all three — and that stays the rule for the tick
// beside each change, which governs a block by design. A SELECTION asks for
// more: the reporter of #87 expected "stage only some lines" because VS Code's
// own git does it. Its rule (intersectDiffWithRange, extensions/git/src/
// staging.ts) is adopted here, block by block:
//
//   - a pure INSERTION: only the selected inserted lines are added;
//   - a MODIFICATION with as many lines on each side: line i of the original is
//     taken to have become line i of the modified, so only the selected lines
//     change and the others keep their original text;
//   - anything else — a pure deletion, or a modification that changes the line
//     count: the whole block, as before, because staging part of it would mean
//     guessing which old line became which new one.
//
// Two departures from VS Code, both towards doing what was selected: every
// selection touching a block counts (VS Code keeps only the first one, so a
// second cursor in the same block was silently ignored), and the selected lines
// are taken from all of them.
//
// UNSTAGING is the same rule run backwards (revertSelectedLines): the selected
// lines of a staged insertion leave the index, the selected lines of a
// same-length staged edit go back to HEAD's text, and anything else goes back
// whole. Staging two lines one at a time and unstaging one of them therefore
// leaves the other staged — with whole-block unstaging it took both.
//
// Same raw-line splice as applySelectedChanges (see its module note): the
// arrays are the very ones the diff ran on, so CRLF rides inside each line and
// a trailing newline is the final "" element — nothing to re-derive.

import { buildDiffModel } from "../diffModel";
import { splitLines } from "../lineDiff";
import { isEmptyRange, selectionTakes, spanToRange, type LineRange } from "./applyLineChanges";

/** What a line splice did: the new text, and how many changes it moved. */
export interface LineSplice {
  content: string;
  /** Changes whose text the splice actually altered; 0 means `content` is the text it started from. */
  changes: number;
}

/**
 * Reconstructs the text to stage: `originalText` with the selected lines of
 * each change taken from `modifiedText`, where the change allows it (see the
 * module note), and every untouched change left at its original state.
 *
 * `selected` is 0-based inclusive ranges in MODIFIED coordinates — the lines
 * the user selected in an editor showing `modifiedText`.
 */
export function applySelectedLines(
  originalText: string,
  modifiedText: string,
  selected: LineRange[],
): string {
  return takeSelectedLines(originalText, modifiedText, selected).content;
}

/** applySelectedLines, saying how many changes it moved (none: nothing to stage). */
export function takeSelectedLines(
  originalText: string,
  modifiedText: string,
  selected: LineRange[],
): LineSplice {
  return splice(originalText, modifiedText, selected, "take");
}

/**
 * The reverse: `modifiedText` with the selected lines of each change put back
 * to `originalText` — a selected inserted line removed, a selected line of a
 * same-length edit restored, and any other change it touches restored whole.
 * Untouched changes stay as `modifiedText` has them.
 *
 * Unstaging calls it with HEAD as the original and the INDEX as the modified
 * text, so `selected` is in index coordinates.
 */
export function revertSelectedLines(
  originalText: string,
  modifiedText: string,
  selected: LineRange[],
): LineSplice {
  return splice(originalText, modifiedText, selected, "revert");
}

function splice(
  originalText: string,
  modifiedText: string,
  selected: LineRange[],
  mode: "take" | "revert",
): LineSplice {
  const originalLines = splitLines(originalText);
  const modifiedLines = splitLines(modifiedText);
  // An empty selection range is a line boundary (selectionTakes): it takes the
  // deletion anchored there, and selects no line of its own.
  const spans = selected.filter((r) => !isEmptyRange(r));
  const isSelected = (line: number): boolean => spans.some((r) => line >= r.start && line <= r.end);

  // The final "" of a text that ends in a line break is not a line: it is the
  // break after the line before it, and the caret on that empty last row
  // selects nothing of its own. Inside an inserted run it goes with its line —
  // taken or reverted when that line is, never alone — so a caret there cannot
  // stage a lone line break, and an inserted last line keeps its break.
  const last = modifiedLines.length - 1;
  const endsWithBreak = last > 0 && modifiedLines[last] === "";
  const pickedIn = (line: number, runStart: number): boolean =>
    line === last && endsWithBreak && line - 1 >= runStart ? isSelected(line - 1) : isSelected(line);

  // An empty original is ONE empty line to the line diff, so a new file reads
  // as that line modified into many — a count-changing modification, which
  // would move whole. It is an insertion: each line comes or goes with its own
  // line break (the last line has one only if the file ends in one).
  if (originalText === "") {
    let out = "";
    for (let i = 0; i < modifiedLines.length; i++) {
      const selectedHere = isSelected(i) && !(i === last && endsWithBreak);
      if (selectedHere === (mode === "take")) out += modifiedLines[i] + (i < last ? "\n" : "");
    }
    const untouched = mode === "take" ? "" : modifiedText;
    return { content: out, changes: out === untouched ? 0 : 1 };
  }

  const model = buildDiffModel(originalText, modifiedText);
  const result: string[] = [];
  let changes = 0;
  let origCursor = 0; // 0-based index into originalLines

  for (const block of model.blocks) {
    // Half-open [start, endExclusive) windows (0-based) for each side.
    const origStart = block.leftSpan.start - 1;
    const origEnd = block.leftSpan.endExclusive - 1;
    const modStart = block.rightSpan.start - 1;
    const modEnd = block.rightSpan.endExclusive - 1;

    // Between changes the two texts are the same lines.
    for (; origCursor < origStart; origCursor++) {
      result.push(originalLines[origCursor]);
    }
    origCursor = origEnd;

    const original = originalLines.slice(origStart, origEnd);
    const modified = modifiedLines.slice(modStart, modEnd);
    // What this change is when the selection leaves it alone.
    const untouched = mode === "take" ? original : modified;
    const touched = selected.some((sel) => selectionTakes(spanToRange(block.rightSpan), sel));

    let out: string[];
    if (!touched) {
      out = untouched;
    } else if (original.length === 0) {
      // Pure insertion: take the selected inserted lines, or drop them.
      const kept = modified
        .map((_, k) => modStart + k)
        .filter((line) => pickedIn(line, modStart) === (mode === "take"));
      out = kept.map((line) => modifiedLines[line]);
      // At the very end of the text nothing follows the run to end its last
      // line, so a line that HAD a line break in the modified text kept none —
      // and a CRLF line kept only its CR. It keeps its break.
      if (origStart === originalLines.length && kept.length > 0 && kept[kept.length - 1] < last) out.push("");
    } else if (original.length === modified.length) {
      // Same-length modification: line by line.
      out = modified.map((line, k) => (isSelected(modStart + k) === (mode === "take") ? line : original[k]));
    } else {
      // A deletion, or a modification that changes the line count: whole.
      out = mode === "take" ? modified : original;
    }
    if (out.length !== untouched.length || out.some((line, k) => line !== untouched[k])) changes++;
    result.push(...out);
  }

  for (; origCursor < originalLines.length; origCursor++) {
    result.push(originalLines[origCursor]);
  }
  return { content: result.join("\n"), changes };
}
