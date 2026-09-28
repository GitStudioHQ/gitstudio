import * as vscode from "vscode";

/**
 * `gitstudio.avatars.gravatar`: whether the graph surfaces look commit
 * authors' pictures up on the internet. On (the default), a page asks
 * www.gravatar.com for each author by an MD5 hash of their email address, and
 * avatars.githubusercontent.com for a GitHub noreply address. Off, it asks
 * neither and draws initials (webview-ui's graph/avatar.ts decides the URL; the
 * host only tells it which way the switch is).
 */
export const GRAVATAR_SETTING = "gitstudio.avatars.gravatar";

/** The switch as the user left it. Anything but an explicit `false` is on. */
export function gravatarAllowed(): boolean {
  return vscode.workspace.getConfiguration("gitstudio.avatars").get<boolean>("gravatar", true) !== false;
}

/** Calls `onChange` whenever the setting changes, in any scope. */
export function onGravatarSettingChange(onChange: () => void): vscode.Disposable {
  return vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(GRAVATAR_SETTING)) onChange();
  });
}
