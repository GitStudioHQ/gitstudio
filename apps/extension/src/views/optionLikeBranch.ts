import * as vscode from "vscode";
import {
  renameArgs,
  suggestedRename,
  type OptionLikeRef,
} from "@gitstudio/git-service/checkoutRef";
import { promptInput } from "../ui/dialogs";

// A checkout refused because the branch's NAME reads as an option (issue #30's
// follow-up, after 4c72977): planRefCheckout will not hand git "-f", because
// `git checkout -f` throws away every uncommitted change. The refusal was
// right; what the doors said about it was not — the Branches view blamed a
// stale list ("not in this repository any more — refresh and try again"),
// and the graph's menus said nothing at all. Both come here instead, and say
// what is true: git cannot check it out safely by that name. A LOCAL branch
// can be fixed where it stands, so that is offered — renamed by its FULL
// name (renameArgs: `git branch -m -- -f <new>`), never a short form.

/** The one action the warning offers, for a local branch. */
export const RENAME_OPTION_LIKE = "Rename…";

/** What a door needs to run the rename: something that runs git. */
export interface OptionLikeRenameContext {
  process: { run(args: string[]): Promise<{ code: number; stderr: string }> };
}

/**
 * Say why `fullName` was not checked out, and — for a local branch — offer to
 * rename it. Resolves once the question is answered (or dismissed): true when
 * the branch was renamed, so a caller that refreshes on "something changed"
 * (the graph's menu arms) can.
 */
export async function explainOptionLikeCheckout(
  ctx: OptionLikeRenameContext,
  refusal: OptionLikeRef,
  fullName: string,
  refresh: () => void,
): Promise<boolean> {
  const pick = await vscode.window.showWarningMessage(
    `GitStudio: ${refusal.message}`,
    ...(refusal.local ? [RENAME_OPTION_LIKE] : []),
  );
  if (pick !== RENAME_OPTION_LIKE) {
    return false;
  }
  const neu = (
    await promptInput({
      title: `Rename branch ${refusal.name}`,
      hint: "A name that does not start with \"-\" — git can check that out like any other branch.",
      value: suggestedRename(refusal.name),
      confirmLabel: "Rename",
      validate: "refName",
    })
  )?.trim();
  if (!neu) {
    return false;
  }
  const args = renameArgs(fullName, neu);
  if (!args) {
    return false;
  }
  const r = await ctx.process.run(args);
  if (r.code === 0) {
    void vscode.window.setStatusBarMessage(`$(check) Renamed ${refusal.name} to ${neu}`, 2500);
    refresh();
    return true;
  }
  void vscode.window.showErrorMessage(r.stderr.trim() || `GitStudio: couldn't rename ${refusal.name}.`);
  return false;
}
