// One voice for GitStudio's notifications.
//
// The same kind of event read several ways: "Push failed: …" from the status
// bar and "GitStudio: push failed — …" from the Changes view for the same
// push; "No active repository.", "No active Git repository." and "GitStudio:
// no repository is open." for the same state; a copied SHA in a toast from
// blame and in the status bar from the graph. The rules, in one place:
//
//   · a toast says who is speaking once: "GitStudio: " and then a sentence
//     that starts with a capital letter and ends with a full stop;
//   · a failure is "GitStudio: <Action> failed — <git's reason>";
//   · "nothing is open" is one sentence, NO_REPOSITORY;
//   · a copy is confirmed in the status bar, for a moment, never in a toast.
//
// The text builders are vscode-free and unit-tested (notifyStyle.test.ts); the
// senders are thin.

import * as vscode from "vscode";

const PREFIX = "GitStudio: ";

/** "GitStudio: <Sentence>." — the prefix once, a capital, a full stop. */
export function notice(text: string): string {
  let t = text.trim();
  while (t.startsWith(PREFIX) || t.startsWith("GitStudio:")) t = t.slice(t.indexOf(":") + 1).trim();
  if (!t) return PREFIX.trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (!/[.!?…)"”]$/.test(t)) t += ".";
  return PREFIX + t;
}

/** "GitStudio: Push failed — <reason>." (the reason whole, its lines run together). */
export function failed(action: string, reason?: string): string {
  const why = (reason ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join(" ");
  return notice(why ? `${action} failed — ${why}` : `${action} failed`);
}

/** The one sentence for "there is no repository to act on". */
export const NO_REPOSITORY = notice("No repository is open");

/** What the status bar says after a copy. */
export function copiedText(what: string): string {
  return `$(check) Copied ${what}`;
}

export function notifyInfo(text: string, ...items: string[]): Thenable<string | undefined> {
  return vscode.window.showInformationMessage(notice(text), ...items);
}

export function notifyWarning(text: string, ...items: string[]): Thenable<string | undefined> {
  return vscode.window.showWarningMessage(notice(text), ...items);
}

export function notifyError(text: string, ...items: string[]): Thenable<string | undefined> {
  return vscode.window.showErrorMessage(notice(text), ...items);
}

/** A copy is confirmed where the eye already is: the status bar, for a moment. */
export function notifyCopied(what: string): void {
  vscode.window.setStatusBarMessage(copiedText(what), 2500);
}
