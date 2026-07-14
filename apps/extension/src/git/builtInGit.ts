import * as vscode from "vscode";
import type { API, GitExtension } from "./git";

// Bridge to VS Code's built-in `vscode.git` extension. We lean on it for repo
// discovery, the resolved git binary path, and open/close + state events — the
// same plumbing Cursor/Open VSX ship — rather than re-implementing repo
// detection ourselves. All the actual git reads go through @gitstudio/git-service.

/** Cached API handle; resolved lazily on first use and reused thereafter. */
let cachedApi: API | undefined;

/**
 * Resolves the built-in git extension's API (v1), activating it if needed.
 * Returns `undefined` (rather than throwing) when git is unavailable or
 * disabled, so callers can degrade to a no-repo state gracefully.
 */
export async function getBuiltInGitApi(): Promise<API | undefined> {
  if (cachedApi) {
    return cachedApi;
  }
  try {
    const extension =
      vscode.extensions.getExtension<GitExtension>("vscode.git");
    if (!extension) {
      return undefined;
    }
    const exports = extension.isActive
      ? extension.exports
      : await extension.activate();
    if (!exports.enabled) {
      return undefined;
    }
    cachedApi = exports.getAPI(1);
    return cachedApi;
  } catch {
    return undefined;
  }
}
