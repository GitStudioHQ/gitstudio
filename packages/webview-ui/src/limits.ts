// Shared responsiveness thresholds for the merge/diff webviews.

/**
 * Combined line count (across all panes) above which we drop character-level
 * (inner) decorations and keep line-level only, to stay responsive. The
 * `vscode-diff` line diff still runs; only the word-level overlay is skipped.
 */
export const LARGE_FILE_LINE_THRESHOLD = 20000;

/**
 * How long an overlay repaint (ribbons, gutter buttons) waits for an animation
 * frame before it runs anyway. Two frames at 60 Hz: where frames come, the
 * frame always wins; where none come — headless Chrome under a virtual-time
 * budget, an occluded or minimised window — the repaint still lands.
 */
export const OVERLAY_FALLBACK_MS = 32;

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

/**
 * Host width below which the graph stops being a table of columns and becomes
 * a one-line list: the refs flow inline before the message and the column
 * header goes.
 *
 * This used to be 620, which sacrificed the two things that identify a commit
 * at a glance — the graph gutter's header and the Branch/Tag column — long
 * before the message was in any trouble. Between this and
 * COLUMN_DROP_TAIL_AT the graph now keeps gutter + Branch/Tag + message and
 * drops only the trailing metadata, so "which branch is this?" survives every
 * width a person would actually drag to. Below it the inline list is still the
 * right answer, because a fixed ref column in a genuinely narrow pane spends
 * ~120px on rows that have no refs at all.
 */
export const INLINE_LIST_BELOW = 460;
