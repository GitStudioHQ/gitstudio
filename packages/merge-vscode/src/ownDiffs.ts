// Diffs a product opens from its own views and wants in VS Code's diff
// editor (where its staging tools and keyboard focus are): the default diff
// viewer's router (diffAutoRoute.ts) leaves them alone. A mark is made just
// before the diff opens; the router, seeing the tab appear, remembers that
// tab as the product's own. A mark lapses after OWN_DIFF_MARK_MS, so the same
// two sides opened later from Source Control are routed as usual. Marks are
// read, never used up: both products' routers may look at the same tab.

import * as vscode from "vscode";

export const OWN_DIFF_MARK_MS = 5_000;

const marks = new Map<string, number>();
const key = (original: string, modified: string): string => `${original}\u0000${modified}`;

/** The next diff of exactly these two sides is the product's own. */
export function markOwnDiff(original: vscode.Uri, modified: vscode.Uri, now = Date.now()): void {
  for (const [k, until] of marks) {
    if (until <= now) {
      marks.delete(k);
    }
  }
  marks.set(key(original.toString(), modified.toString()), now + OWN_DIFF_MARK_MS);
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
