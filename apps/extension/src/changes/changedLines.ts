import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";

/**
 * Which lines the optional whole-line highlights paint (#160), worked out from
 * the change blocks the staging marks already read — never from a diff of its
 * own.
 *
 * Separate from changedLineHighlights.ts, which imports `vscode`, so node:test
 * can load the part that decides where every highlight goes.
 */

/** What a change did, in the three words VS Code's own change bars use. */
export type LineChangeKind = "added" | "modified" | "deleted";

/** A run of lines in the working text, 0-based and inclusive. */
export interface LineSpan {
  start: number;
  end: number;
}

export interface ChangedLinePlan {
  added: LineSpan[];
  modified: LineSpan[];
  /**
   * Where lines were taken out, and how many. A deletion leaves no line in the
   * buffer to paint, so its label sits on the line the staging mark and the
   * hover use for it: the line just after the cut, so the lines went ABOVE it.
   * At the very end of a file with no final newline there is no line after
   * the cut; the label goes on the last line, and the lines went below it.
   */
  deleted: { line: number; count: number; above: boolean }[];
}

/**
 * A block's kind. A zero-width span (`end < start`) is a side with no lines:
 * none on the working side is a deletion, none on the HEAD side an addition,
 * and lines on both sides a modification.
 */
export function lineChangeKind(block: ChangeBlock): LineChangeKind | undefined {
  const noWorking = block.working.end < block.working.start;
  const noHead = block.head.end < block.head.start;
  if (noWorking && noHead) return undefined;
  if (noWorking) return "deleted";
  if (noHead) return "added";
  return "modified";
}

/** What the planner needs to know about HEAD's side beyond the blocks. */
export interface PlanOptions {
  /**
   * HEAD has the file, and it is EMPTY (`__init__.py`, `.gitkeep`). The diff
   * reads an empty text as one empty line, so lines typed into such a file
   * arrive as a change that "replaces" that line — a modification, and one
   * that takes in the empty line after the final newline. Nothing was there to
   * modify: every line is an addition, and that last empty line is not one.
   */
  emptyHead?: boolean;
  /** The working text ends with a newline (its last line is the empty one after it). */
  finalNewline?: boolean;
}

/**
 * The highlights for `blocks` in a document of `lineCount` lines. Every line
 * is clamped into the document: the blocks were read for the text as it was a
 * moment ago, and a highlight must never point past the end of the buffer.
 */
export function planChangedLines(
  blocks: readonly ChangeBlock[],
  lineCount: number,
  options: PlanOptions = {},
): ChangedLinePlan {
  const plan: ChangedLinePlan = { added: [], modified: [], deleted: [] };
  const last = Math.max(0, lineCount - 1);
  const clamp = (line: number) => Math.min(Math.max(0, line), last);
  for (const block of blocks) {
    let kind = lineChangeKind(block);
    if (kind === undefined) continue;
    if (options.emptyHead) {
      // An empty file has no line to modify or delete.
      if (kind === "deleted") continue;
      kind = "added";
      const start = clamp(block.working.start);
      const end = Math.min(clamp(block.working.end), options.finalNewline ? last - 1 : last);
      if (end >= start) plan.added.push({ start, end });
      continue;
    }
    if (kind === "deleted") {
      const line = clamp(block.working.start);
      plan.deleted.push({ line, count: block.head.end - block.head.start + 1, above: line === block.working.start });
    } else {
      plan[kind].push({ start: clamp(block.working.start), end: clamp(block.working.end) });
    }
  }
  return plan;
}
