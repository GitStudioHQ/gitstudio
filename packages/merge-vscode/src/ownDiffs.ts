// Diffs a product opens from its own views and wants in VS Code's diff
// editor (where its staging tools and keyboard focus are): the default diff
// viewer's router (diffAutoRoute.ts) leaves them alone. A mark is made just
// before the diff opens; the router, seeing the tab appear, remembers that
// tab as the product's own. A mark lapses after OWN_DIFF_MARK_MS, so the same
// two sides opened later from Source Control are routed as usual. Marks are
// read, never used up: both products' routers may look at the same tab.
//
// A ROUTABLE open (openRoutable: the Changes list, the graph's files, stash
// files) is the opposite promise: with the setting on, the comparison opens.
// It says so with its own mark, which beats an earlier own mark of the same
// two sides, and a tab an own opener left open (VS Code shows that tab again
// rather than opening a second). The mark also carries whether the opener
// meant to move keyboard focus: the router cannot see focus, and guessing it
// from the tab sent a list click's focus nowhere.

import * as vscode from "vscode";

export const OWN_DIFF_MARK_MS = 5_000;

const marks = new Map<string, number>();
const routables = new Map<string, { until: number; focus: boolean }>();
const routableListeners = new Set<(original: string, modified: string) => void>();
const key = (original: string, modified: string): string => `${original}\u0000${modified}`;

function prune(now: number): void {
  for (const [k, until] of marks) {
    if (until <= now) {
      marks.delete(k);
    }
  }
  for (const [k, mark] of routables) {
    if (mark.until <= now) {
      routables.delete(k);
    }
  }
}

/** The next diff of exactly these two sides is the product's own. */
export function markOwnDiff(original: vscode.Uri, modified: vscode.Uri, now = Date.now()): void {
  prune(now);
  const k = key(original.toString(), modified.toString());
  routables.delete(k); // the latest open of these two sides decides
  marks.set(k, now + OWN_DIFF_MARK_MS);
}

/** What a routable open asked for: the diff may be redirected, and `focus` says whether it was to take keyboard focus. */
export interface RoutableIntent {
  focus: boolean;
}

/** The next diff of exactly these two sides is routable, whatever an earlier own open of them said. */
export function markRoutable(original: vscode.Uri, modified: vscode.Uri, focus: boolean, now = Date.now()): void {
  prune(now);
  const k = key(original.toString(), modified.toString());
  marks.delete(k);
  routables.set(k, { until: now + OWN_DIFF_MARK_MS, focus });
}

/** The intent of a routable open of these two sides (URI strings, for the peer extension's API too), if one was just made. */
export function routableIntent(original: string, modified: string, now = Date.now()): RoutableIntent | undefined {
  const mark = routables.get(key(original, modified));
  return mark && mark.until > now ? { focus: mark.focus } : undefined;
}

/**
 * Called after each routable open, with its two sides. VS Code fires no tab
 * event when the diff asked for is already the tab in front, so the router
 * looks at the tabs again here.
 */
export function onRoutableOpened(listener: (original: string, modified: string) => void): vscode.Disposable {
  routableListeners.add(listener);
  return new vscode.Disposable(() => routableListeners.delete(listener));
}

/**
 * Whether a diff of these two sides (URI strings, so the peer extension can
 * ask through its API) was just marked as the product's own.
 */
export function isOwnDiff(original: string, modified: string, now = Date.now()): boolean {
  const until = marks.get(key(original, modified));
  return until !== undefined && until > now;
}

/** `vscode.diff`, opened in VS Code's diff editor whatever the default diff viewer setting says. */
export async function openWithoutRouting(
  original: vscode.Uri,
  modified: vscode.Uri,
  title?: string,
  options?: vscode.TextDocumentShowOptions,
): Promise<void> {
  markOwnDiff(original, modified);
  await vscode.commands.executeCommand("vscode.diff", original, modified, title, options);
}

/**
 * `vscode.diff` that the default diff viewer may redirect: with the setting
 * on, the router opens GitStudio's comparison instead, taking keyboard focus
 * unless `options.preserveFocus` says not to (as VS Code's diff would). For
 * the Changes list, the graph's files and stash files, whose rows are what
 * the setting is meant to redirect.
 */
export async function openRoutable(
  original: vscode.Uri,
  modified: vscode.Uri,
  title?: string,
  options?: vscode.TextDocumentShowOptions,
): Promise<void> {
  markRoutable(original, modified, options?.preserveFocus !== true);
  await vscode.commands.executeCommand("vscode.diff", original, modified, title, options);
  for (const listener of [...routableListeners]) {
    listener(original.toString(), modified.toString());
  }
}
