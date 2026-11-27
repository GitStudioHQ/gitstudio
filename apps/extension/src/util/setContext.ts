import * as vscode from "vscode";

/**
 * Publish a `when`-clause context key. Never rejects.
 *
 * `setContext` is a command, so it runs over the extension host's RPC to the
 * window — and a window that is reloading or closing cancels the call. The
 * promise then rejects with VS Code's bare `Canceled`, and every
 * `void executeCommand("setContext", …)` left that rejection unhandled:
 * report #100 was one, from RepoManager.updateHasRepoContext during startup on
 * a WSL window. A context key nobody is left to read has nothing to say, so the
 * failure is dropped here, once, for every caller.
 */
export function setContext(key: string, value: unknown): Promise<void> {
  const settled = (): undefined => undefined;
  try {
    return Promise.resolve(vscode.commands.executeCommand("setContext", key, value)).then(settled, settled);
  } catch {
    return Promise.resolve();
  }
}
