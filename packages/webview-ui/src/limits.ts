// Shared responsiveness thresholds for the merge/diff webviews.

/**
 * Combined line count (across all panes) above which we drop character-level
 * (inner) decorations and keep line-level only, to stay responsive. The
 * `vscode-diff` line diff still runs; only the word-level overlay is skipped.
 */
export const LARGE_FILE_LINE_THRESHOLD = 20000;
