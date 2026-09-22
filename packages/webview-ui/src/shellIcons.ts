// Icons the merge shell, the no-text panel and the conflicts dashboard use on
// top of the merge view's own set (icons.ts, which P1 owns). The same codicon
// markup, so every glyph in the three surfaces comes from one font.
//
// The `.codicon-*::before` codepoints for these live in shell.css (the merge
// shell / no-text panel) and conflicts.css (the dashboard), because the
// extension's merge page links only its own bundle's stylesheet — a glyph whose
// codepoint is declared nowhere renders as an empty 16px box.

/** A codicon span, `currentColor`-tinted so it inherits the control's colour. */
export function codicon(name: string): string {
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

/** Continue the operation. */
export const continueIcon = codicon("debug-continue");
/** Skip this commit / patch. */
export const skipIcon = codicon("debug-step-over");
/** Abort / cancel the operation. */
export const abortIcon = codicon("circle-slash");
/** A finished, settled state. */
export const checkIcon = codicon("check");
/** A warning note (willDrop, unresolved Apply, EOL). */
export const warningIcon = codicon("warning");
/** A plain information note. */
export const infoIcon = codicon("info");
/** "Delete the file" — the one resolution that removes something. */
export const trashIcon = codicon("trash");
/** The direction bar's arrow. */
export const arrowRightIcon = codicon("arrow-right");
/** A binary file. */
export const binaryIcon = codicon("file-binary");
/** A file that is gone on one side. */
export const removedIcon = codicon("diff-removed");
/** Close the viewer. */
export const closeIcon = codicon("close");
/** The commit being replayed. */
export const commitIcon = codicon("git-commit");
/** A paused operation. */
export const pauseIcon = codicon("debug-pause");
/** Hold-to-undo. */
export const undoHoldIcon = codicon("discard");
/** Merge… (open the file in the merge editor). */
export const mergeIcon = codicon("git-merge");
/** An error line. */
export const errorIcon = codicon("error");

/** Builds a DOM element from codicon markup (same shape as icons.ts's helper). */
export function glyphEl(markup: string, className = "jb-svg"): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = markup;
  return span;
}
