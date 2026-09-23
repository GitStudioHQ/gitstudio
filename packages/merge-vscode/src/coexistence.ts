// The one-time question about VS Code's own merge UI (PLAN matrix row 5).
//
// VS Code's built-in 3-way merge editor (`git.mergeEditor`) and the
// merge-conflict extension's CodeLens and decorations compete with ours for
// the same file. The product asks ONCE whether to turn them off, and only
// applies anything on an explicit yes. It asks through `product.ask`:
// GitStudio's own in-view dialog (never a modal — noVsCodePrompts.test.ts),
// Merge Studio's modal. Nothing is asked when nothing competes, or while
// another product owns the automatic behaviour (D4).

import * as vscode from "vscode";
import type { MergeHostCore } from "./host";
import { COMPETING_BUILT_INS, competingBuiltIns } from "./product";

/** Products that have started asking this session (scans call in quick succession). */
const asking = new WeakSet<object>();

export async function maybeOfferCoexistence(host: MergeHostCore): Promise<void> {
  const { context, product } = host;
  if (
    asking.has(context) ||
    host.defers() ||
    context.globalState.get<boolean>(product.coexistencePromptKey)
  ) {
    return;
  }
  // Claimed synchronously: the globalState write below is async, and a second
  // scan landing before it resolves must not ask again.
  asking.add(context);
  const config = vscode.workspace.getConfiguration();
  const competing = competingBuiltIns((key) => config.get(key));
  // Asked at most once, answered or not; a later change in Settings is the user's.
  await context.globalState.update(product.coexistencePromptKey, true);
  if (competing.length === 0) {
    return;
  }
  const ok = await product.ask({
    title: "Turn off VS Code's built-in merge editor?",
    message:
      `${product.displayName} opens conflicted files in its own merge editor. VS Code's ` +
      "built-in merge editor and its conflict highlights would compete with it for the same " +
      "file. You can turn them back on in Settings (git.mergeEditor, merge-conflict).",
    confirmLabel: "Turn them off",
  });
  if (!ok) {
    return;
  }
  // All three, stated explicitly — `git.mergeEditor` is off by default today,
  // and an explicit value keeps it off if that default ever changes.
  for (const { key, off } of COMPETING_BUILT_INS) {
    await config.update(key, off, vscode.ConfigurationTarget.Global);
  }
  void host.notify("info", "VS Code's built-in merge editor is off.");
}
