// Merge/diff toolbar icons — the real VS Code codicon font, the same icon
// vocabulary every other GitStudio surface uses (commit graph, rebase, commit
// window, the desktop shell). These were previously hand-drawn inline SVGs at
// mismatched stroke weights, which read as a second, lighter icon set sitting
// pixel-adjacent to the codicons in the same window — exactly the inconsistency
// we don't want. Each export is now codicon markup; the `.codicon` @font-face +
// class rules live at document scope in diff.css (esbuild inlines the .ttf), so
// they render in both the extension's diff/merge webview and the desktop renderer.
//
// The export names are unchanged so every call site stays the same.

/** A codicon span. `currentColor`-tinted, so it inherits the control's color. */
function codicon(name: string): string {
  return `<span class="codicon codicon-${name}" aria-hidden="true"></span>`;
}

/** → apply a change from the left pane into the result. */
export const chevronDoubleRight = codicon("arrow-right");

/** ← apply a change from the right pane into the result. */
export const chevronDoubleLeft = codicon("arrow-left");

/** ✕ — ignore a change (keep the base text). */
export const cross = codicon("close");

/** Navigation arrows (previous / next change). */
export const arrowUp = codicon("arrow-up");
export const arrowDown = codicon("arrow-down");

/** Merge — apply all non-conflicting changes from both sides. */
export const chevronsInward = codicon("merge");

/** Magic wand — resolve simple (identical) conflicts. */
export const magicWand = codicon("wand");

/** Synchronized scrolling toggle. */
export const syncScroll = codicon("sync");

/** Restart — reset the merge to its initial state. */
export const resetIcon = codicon("debug-restart");

/** Padlock — read-only pane marker. */
export const lockIcon = codicon("lock");

/** Undo the last merge action. */
export const undoIcon = codicon("discard");

/** Redo the last undone merge action. */
export const redoIcon = codicon("redo");

/** Clock — the merge action history dropdown. */
export const historyIcon = codicon("history");

/** Open the merge in the external JetBrains/VS Code editor. */
export const openExternal = codicon("link-external");

/** Builds a DOM element from one of the codicon markup strings above. */
export function iconElement(markup: string, className = "jb-svg"): HTMLElement {
  const span = document.createElement("span");
  span.className = className;
  span.innerHTML = markup;
  return span;
}
