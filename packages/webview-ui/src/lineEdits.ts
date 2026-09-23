// Replacing whole lines of a Monaco model with other lines — the one write
// both the merge view's accepts (mergeView.replaceResultLines) and the 2-way
// diff's copy arrow (diffView.transferBlock) make.
//
// Text is lines joined by "\n", so WHERE the lines sit decides who owns each
// line break, and every edge of the file has its own rule. Getting one wrong
// is not cosmetic: restoring a deleted unterminated last line glued it onto
// the line above ("a\nbc\n"), and restoring a single blank line or a final
// newline wrote nothing. Both views carried their own copy of these rules and
// only one had been fixed (memory: fix-both-siblings), so there is one now.
//
// Pure: it plans the edit from what the model says about itself and returns
// the range, the text and the span the lines will occupy.

import type { LineSpan } from "@gitstudio/engine/types";

/** What the plan needs to know about the document. */
export interface LineDoc {
  lineCount: number;
  /** Monaco's getLineMaxColumn (1 + the line's length). */
  maxColumn(line: number): number;
  /** The document holds no text at all (its one "line" is no line). */
  empty: boolean;
}

export interface LineWrite {
  range: { startLine: number; startColumn: number; endLine: number; endColumn: number };
  text: string;
  /** Where the written lines are afterwards (a point when none were written). */
  next: LineSpan;
}

/** A Monaco text model, as a LineDoc. */
export function lineDocOf(model: {
  getLineCount(): number;
  getLineMaxColumn(line: number): number;
  getValueLength(): number;
}): LineDoc {
  return {
    lineCount: model.getLineCount(),
    maxColumn: (line) => model.getLineMaxColumn(line),
    empty: model.getValueLength() === 0,
  };
}

/**
 * Plan replacing `span` (1-based, end-exclusive) with `lines`:
 * - lines follow it: every written line ends with a break;
 * - it runs to the end: the last written line takes none (a side whose file
 *   ends with a break carries that as a final empty line);
 * - nothing is written at the end: the break BEFORE the span goes too, or
 *   removing a final newline (or the file's last lines) left one behind;
 * - an insertion after the last line takes the break before it — unless the
 *   document is empty, whose one "line" is no line at all.
 * Undefined when there is nothing to write and nothing to remove.
 */
export function planLineWrite(doc: LineDoc, span: LineSpan, lines: string[]): LineWrite | undefined {
  const { lineCount } = doc;
  const at = (startLine: number, startColumn: number, endLine: number, endColumn: number) => ({
    startLine,
    startColumn,
    endLine,
    endColumn,
  });
  const whole = () => at(1, 1, lineCount, doc.maxColumn(lineCount));
  let next: LineSpan = { start: span.start, endExclusive: span.start + lines.length };
  if (span.endExclusive <= lineCount) {
    return { range: at(span.start, 1, span.endExclusive, 1), text: lines.map((l) => `${l}\n`).join(""), next };
  }
  if (doc.empty) {
    next = lines.length ? { start: 1, endExclusive: 1 + lines.length } : { start: 2, endExclusive: 2 };
    return { range: whole(), text: lines.join("\n"), next };
  }
  if (lines.length && span.start <= lineCount) {
    return { range: at(span.start, 1, lineCount, doc.maxColumn(lineCount)), text: lines.join("\n"), next };
  }
  if (lines.length) {
    const end = doc.maxColumn(lineCount);
    next = { start: lineCount + 1, endExclusive: lineCount + 1 + lines.length };
    return { range: at(lineCount, end, lineCount, end), text: `\n${lines.join("\n")}`, next };
  }
  if (span.start <= lineCount) {
    const range =
      span.start > 1
        ? at(span.start - 1, doc.maxColumn(span.start - 1), lineCount, doc.maxColumn(lineCount))
        : whole();
    // The span is now the point after whatever is left.
    next = { start: Math.max(span.start, 2), endExclusive: Math.max(span.start, 2) };
    return { range, text: "", next };
  }
  return undefined;
}
