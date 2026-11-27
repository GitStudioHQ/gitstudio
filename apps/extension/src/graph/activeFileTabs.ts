// The editor's tabs, as activeFile.ts reads them (#158): which diff is in
// front and which are open, re-read on every tab change. One walk over the
// open tabs per change, and nothing at all while no diff was opened.

import * as vscode from "vscode";
import { GITSTUDIO_MERGE_VIEW_TYPES } from "../merge/mergeIds";
import type { ActiveFileTracker, TabSeen, TabsSeen } from "./activeFile";

/**
 * GitStudio's comparison, and Merge Studio's (its twin role under jbMerge.*,
 * mergeIds.ts) when that is the one routing. A webview's tab names its
 * viewType with VS Code's prefix.
 */
const COMPARISONS = [GITSTUDIO_MERGE_VIEW_TYPES.diffView, "jbMerge.diffView"];

const isComparison = (viewType: string): boolean =>
  COMPARISONS.some((v) => viewType === v || viewType.endsWith(`-${v}`));

const isUri = (u: unknown): u is vscode.Uri =>
  typeof u === "object" && u !== null && typeof (u as { scheme?: unknown }).scheme === "string";

/** One tab: a diff by its two sides, a comparison by its label, or neither. */
export function tabSeen(tab: vscode.Tab): TabSeen {
  const input = tab.input as { original?: unknown; modified?: unknown; viewType?: unknown } | undefined;
  if (input && isUri(input.original) && isUri(input.modified)) {
    return { kind: "diff", original: input.original.toString(), modified: input.modified.toString() };
  }
  if (input && typeof input.viewType === "string" && isComparison(input.viewType)) {
    return { kind: "comparison", label: tab.label };
  }
  return { kind: "other" };
}

/** The tabs now, or undefined where there are none to read. */
export function tabsSeen(): TabsSeen | undefined {
  const groups = vscode.window.tabGroups;
  if (!groups?.all) return undefined;
  const front = groups.activeTabGroup?.activeTab;
  return {
    front: front ? tabSeen(front) : undefined,
    all: groups.all.flatMap((g) => g.tabs.map(tabSeen)),
  };
}

/**
 * Re-decide the open file on every tab change; `moved` hears it when the
 * answer changes (for any repository: the host asks for its own). Inert
 * where the editor has no tab API to listen to.
 */
export function followTabs(tracker: ActiveFileTracker, moved: () => void): vscode.Disposable {
  const groups = vscode.window.tabGroups;
  if (typeof groups?.onDidChangeTabs !== "function") return { dispose() {} };
  const look = (): void => {
    // No diff of the pane's is open or on its way: nothing to follow.
    if (!tracker.following) return;
    const tabs = tabsSeen();
    if (tabs && tracker.settle(tabs)) moved();
  };
  const subs = [groups.onDidChangeTabs(look), groups.onDidChangeTabGroups(look)];
  return { dispose: () => subs.forEach((s) => s.dispose()) };
}
