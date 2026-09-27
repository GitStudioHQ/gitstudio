// ~/.ssh/config's SSH host aliases, for the question "is this remote on
// github.com?" — asked by both products of the same URLs.
//
// `Host work` / `HostName github.com` makes `git@work:acme/app.git` a
// github.com remote. The engine's parser takes a resolver for exactly that
// (parseGitHubRemote's `resolveHost`), but reading the file is node's
// business, not the engine's: it lives here, and the VS Code extension and the
// desktop app both use it. Only the extension did, and the same clone was a
// GitHub repository in one product and not in the other.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseGitHubRemote, sshConfigHostName } from "@gitstudio/engine/forge/parseRemote";

/**
 * The home folder whose `.ssh` git's ssh reads.
 *
 * On macOS and Linux that is $HOME, which is what os.homedir() answers. On
 * Windows os.homedir() answers %USERPROFILE% and never reads %HOME% — but git
 * does: Git for Windows only sets HOME from the profile when it is unset, and
 * its ssh reads $HOME/.ssh/config. So with HOME set (a custom home, a CI
 * runner, a test), the aliases ssh resolves live under HOME, and reading the
 * profile's instead found none of them.
 */
export function sshHome(env: NodeJS.ProcessEnv = process.env, platform: string = process.platform): string {
  return platform === "win32" && env.HOME ? env.HOME : homedir();
}

/**
 * The HostName ~/.ssh/config gives an SSH alias — the file read on each call
 * (a few lines; a user who just added an alias should not need a restart).
 * No config: every alias stays unresolved.
 */
export async function sshAliasResolver(home: string = sshHome()): Promise<(host: string) => string | undefined> {
  let text = "";
  try {
    text = await readFile(join(home, ".ssh", "config"), "utf8");
  } catch {
    // No config: aliases stay unresolved.
  }
  return (host) => (text ? sshConfigHostName(text, host) : undefined);
}

/**
 * The github.com repository a remote URL names — through an SSH alias of
 * ~/.ssh/config too — or undefined. The config is read only for a URL the
 * parser can't place on its own.
 */
export async function githubRepoOfRemote(
  url: string,
  home?: string,
): Promise<{ owner: string; repo: string } | undefined> {
  const direct = parseGitHubRemote(url);
  if (direct || url.trim().length === 0) {
    return direct;
  }
  return parseGitHubRemote(url, await sshAliasResolver(home));
}
