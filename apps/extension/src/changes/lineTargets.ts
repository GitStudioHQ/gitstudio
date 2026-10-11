import type { LineRange } from "@gitstudio/engine/staging/applyLineChanges";

// Which lines, and which document, a staging command means — kept free of the
// vscode module so the rules can be pinned by plain unit tests.

/** The shape of a vscode.Selection this needs (a Position is `line` + `character`). */
export interface SelectionLike {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

/**
 * The lines a set of editor selections covers, 0-based inclusive — plus the
 * line BOUNDARIES they reach, as empty ranges (`{ start: L, end: L - 1 }`, the
 * edge just before line L; see selectionTakes in the engine).
 *
 * A selection that ends at the very START of a later line does not take that
 * line. Clicking a line number, or dragging down the line numbers, selects up to
 * column 0 of the NEXT line, so reading `end.line` as-is staged one line more
 * than the highlight showed — the same convention VS Code's own Move Line and
 * Indent use. It does reach the boundary before that line, though, and a
 * deletion anchored there is taken: Select All in a file that ends in a line
 * break stops at column 0 of the empty last row, exactly where a deletion of
 * the file's last lines sits, and dropping the boundary left that deletion out
 * of the commit while saying "Staged".
 *
 * `documentEnd` (the last line and its length) marks a selection that reaches
 * the END of the document. Such a selection keeps its last row even when that
 * row is the empty one after a final line break — that row is where adding
 * the final line break, or emptying the last line, shows as a change, and
 * Select All dropped it (stage and unstage alike, "nothing to stage" or the
 * line break silently left out). It also adds the boundary AFTER the last
 * line, where a file without a final line break anchors the deletion of its
 * last lines.
 *
 * An empty selection is the cursor's line.
 */
export function selectionLines(
  selections: readonly SelectionLike[],
  documentEnd?: { line: number; character: number },
): LineRange[] {
  const out: LineRange[] = [];
  for (const s of selections) {
    const empty = s.start.line === s.end.line && s.start.character === s.end.character;
    const reachesEnd =
      !!documentEnd && !empty && s.end.line === documentEnd.line && s.end.character === documentEnd.character;
    const endsAtLineStart = !reachesEnd && s.end.character === 0 && s.end.line > s.start.line;
    out.push({ start: s.start.line, end: endsAtLineStart ? s.end.line - 1 : s.end.line });
    if (endsAtLineStart) out.push({ start: s.end.line, end: s.end.line - 1 });
    if (reachesEnd) out.push({ start: documentEnd.line + 1, end: documentEnd.line });
  }
  return out;
}

/** What the line-number menu hands its commands: a 1-BASED line and the editor's document. */
export interface LineMenuArg<U> {
  lineNumber?: number;
  uri?: U;
}

/**
 * The document and 0-based line a "this line" command acts on.
 *
 * The line-number menu NAMES the document it was opened on, and that name is
 * the one to trust: right-clicking a gutter does not focus its editor, so the
 * active editor can be the other side of a diff, or another file in another
 * group, and acting on it toggled a change the user was not pointing at. A
 * keybinding passes nothing and means the active editor's cursor.
 */
export function lineMenuTarget<U>(
  arg: LineMenuArg<U> | undefined,
  active: { uri: U; line: number } | undefined,
): { uri: U; line: number } | undefined {
  const line = typeof arg?.lineNumber === "number" ? arg.lineNumber - 1 : active?.line;
  const uri = arg?.uri ?? active?.uri;
  if (uri === undefined || line === undefined || line < 0) return undefined;
  return { uri, line };
}
