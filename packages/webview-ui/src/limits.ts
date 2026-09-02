// Shared responsiveness thresholds for the merge/diff webviews.

/**
 * Combined line count (across all panes) above which we drop character-level
 * (inner) decorations and keep line-level only, to stay responsive. The
 * `vscode-diff` line diff still runs; only the word-level overlay is skipped.
 */
export const LARGE_FILE_LINE_THRESHOLD = 20000;

/**
 * Host width at which the commit graph drops its Date and SHA columns.
 *
 * Shared because TWO packages need to agree on it and did not: the desktop
 * app's graph|details resizer clamps the details column so the graph is never
 * squeezed past this point — "otherwise columns silently vanish and their
 * resize handles go with them" — and it restated the number as a literal,
 * beside a comment quoting a third value. The graph then moved its breakpoint
 * and nothing connected the two, so the resizer allowed exactly the drag it
 * exists to prevent.
 */
export const COLUMN_DROP_TAIL_AT = 860;
