// Where the default diff viewer (gitstudio.merge.useAsDefaultDiffViewer)
// opens GitStudio's comparison: everywhere once it is on, or only in some
// places, chosen with gitstudio.diff.comparisonIn. VS Code's diff editor
// stays the default; this is the opt-in's reach.
//
// Every diff GitStudio opens names its place and goes through openDiff, which
// marks it for the router (@gitstudio/merge-vscode/ownDiffs): routable where
// the place is ticked, VS Code's diff editor where it is not. Diffs VS Code
// and other extensions open are one place, `vscode`: the router cannot tell
// Source Control from Explorer or the Timeline. Pull request review diffs are
// not a place: their review threads live in VS Code's diff editor, so they
// always open there.

import * as vscode from "vscode";
import { openRoutable, openWithoutRouting } from "@gitstudio/merge-vscode/ownDiffs";

/** GitStudio's own places, in the order the setting lists them (after `vscode`). */
export const DIFF_PLACES = ["changes", "graph", "stashes", "history", "blame", "compare", "worktrees", "push"] as const;
export type DiffPlace = (typeof DIFF_PLACES)[number];

export const COMPARISON_IN_SECTION = "gitstudio.diff";
export const COMPARISON_IN_KEY = "comparisonIn";

/**
 * Whether `place` opens GitStudio's comparison when the default diff viewer
 * is on. A place the setting does not mention is ticked (the default).
 */
export function comparisonIn(place: DiffPlace | "vscode"): boolean {
  const value = vscode.workspace.getConfiguration(COMPARISON_IN_SECTION).get<Record<string, unknown>>(COMPARISON_IN_KEY);
  return value?.[place] !== false;
}

/**
 * Open a diff from one of GitStudio's places. With the default diff viewer
 * on and the place ticked it opens in the comparison, taking focus unless
 * `options.preserveFocus` says not to; otherwise in VS Code's diff editor.
 * `"pullRequests"`: always VS Code's diff editor.
 */
export async function openDiff(
  original: vscode.Uri,
  modified: vscode.Uri,
  title: string | undefined,
  options: vscode.TextDocumentShowOptions | undefined,
  place: DiffPlace | "pullRequests",
): Promise<void> {
  const open = place !== "pullRequests" && comparisonIn(place) ? openRoutable : openWithoutRouting;
  await open(original, modified, title, options);
}
