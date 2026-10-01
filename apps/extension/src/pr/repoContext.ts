import { parseGitHubRemote, parseRemote } from "@gitstudio/engine/forge/parseRemote";
import { sshAliasResolver } from "@gitstudio/git-service/sshAliases";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import * as l10n from "@vscode/l10n";

// Resolves the active repository's GitHub coordinates ({owner, repo}) from its
// configured remotes, using the engine's `parseGitHubRemote` — the same parser
// the desktop app uses. `origin` is preferred; we fall back to the first
// github.com remote we find so a repo that names its GitHub remote "upstream"
// still works. Returns null when there is no active repo or no GitHub remote —
// `whyNoGitHub` then says which, for the view to show.
//
// github.com under another name counts: an SSH host alias (`github.com-work`,
// or any `Host` in ~/.ssh/config whose HostName is github.com), SSH over port
// 443 (ssh.github.com), www.github.com. Each used to turn the whole feature
// off without a word. ~/.ssh/config is read by git-service's sshAliases —
// the desktop app's readers of a remote use the same.

export interface GitHubRepoContext {
  owner: string;
  repo: string;
  /** The git remote whose URL we resolved (e.g. "origin"). */
  remoteName: string;
  /** The active repo entry, for git operations (fetch/checkout). */
  entry: RepoEntry;
}

interface Remote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** A remote that names a github.com repository. */
export interface GitHubRemote {
  name: string;
  owner: string;
  repo: string;
}

/** Every remote of `entry` that names a github.com repository, origin first. */
export async function listGitHubRemotes(entry: RepoEntry): Promise<GitHubRemote[]> {
  let remotes: Remote[];
  try {
    remotes = await entry.ctx.remotes.list();
  } catch {
    return [];
  }
  const resolve = await sshAliasResolver();
  const ordered = [...remotes].sort((a, b) => {
    if (a.name === "origin") return -1;
    if (b.name === "origin") return 1;
    return 0;
  });
  const out: GitHubRemote[] = [];
  for (const remote of ordered) {
    const parsed =
      parseGitHubRemote(remote.fetchUrl, resolve) ??
      parseGitHubRemote(remote.pushUrl, resolve);
    if (parsed) {
      out.push({ name: remote.name, owner: parsed.owner, repo: parsed.repo });
    }
  }
  return out;
}

/**
 * Resolves the active repo's GitHub {owner, repo}. Prefers the `origin` remote;
 * otherwise the first github.com remote. Returns null when not a GitHub repo.
 */
export async function resolveGitHubContext(
  repos: RepoManager,
): Promise<GitHubRepoContext | null> {
  const entry = repos.getActive();
  if (!entry) {
    return null;
  }
  const first = (await listGitHubRemotes(entry))[0];
  return first
    ? { owner: first.owner, repo: first.repo, remoteName: first.name, entry }
    : null;
}

/** Said while RepoManager is still finding the workspace's repositories. */
export const LOOKING_FOR_A_REPOSITORY = l10n.t("Looking for a repository…");

/**
 * Why the active repository has no GitHub context, in words for the Pull
 * Requests view: none found YET (repositories are still being found — the
 * words Changes and the Commit Graph use then), no repository, no remote at
 * all, or remotes that point somewhere other than github.com (named, so the
 * user can see what was read).
 */
export async function whyNoGitHub(repos: RepoManager): Promise<string> {
  const entry = repos.getActive();
  if (!entry) {
    return repos.isDiscovering?.() ? LOOKING_FOR_A_REPOSITORY : l10n.t("Open a Git repository to see its pull requests.");
  }
  let remotes: Remote[] = [];
  try {
    remotes = await entry.ctx.remotes.list();
  } catch {
    // Treated as no remotes.
  }
  if (remotes.length === 0) {
    return l10n.t("This repository has no remotes. Pull requests show here once a remote points at github.com.");
  }
  const hosts = Array.from(
    new Set(
      remotes.map((r) => {
        const host = parseRemote(r.fetchUrl || r.pushUrl)?.host;
        return host ? `${r.name} (${host})` : r.name;
      }),
    ),
  );
  return l10n.t("None of this repository's remotes is on github.com: {0}. Pull requests are available for github.com repositories.", hosts.join(", "));
}
