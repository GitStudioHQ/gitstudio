// The Get Started walkthrough checks its steps off from what people do, where
// they do it.
//
// "Stage a hunk & commit" completed only through the editor commands Stage
// Hunk / Stage Selected Lines — staging and committing in the Changes view,
// which is where almost everyone does it, never checked it off. The Changes
// view sets these context keys when it stages and when it commits, and the
// step's completionEvents listen for them (onContext:…).

import * as vscode from "vscode";

export type WalkthroughMilestone = "staged" | "committed";

/** The context key a step's `onContext:` completion event names. */
export function walkthroughKey(what: WalkthroughMilestone): string {
  return `gitstudio.walkthrough.${what}`;
}

const reached = new Set<WalkthroughMilestone>();

/** Mark a milestone reached (once per window). */
export function markWalkthrough(what: WalkthroughMilestone): void {
  if (reached.has(what)) return;
  reached.add(what);
  void vscode.commands.executeCommand("setContext", walkthroughKey(what), true);
}
