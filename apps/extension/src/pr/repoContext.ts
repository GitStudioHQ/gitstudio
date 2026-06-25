import {
  parseRemote,
  isGitHubRemote,
  type ParsedRemote,
} from "@gitstudio/engine/forge/parseRemote";
import type { RepoManager, RepoEntry } from "../git/repoManager";

// Resolves the active repository's GitHub coordinates ({owner, repo}) from its
// configured remotes, using the pure `parseRemote` from the engine. `origin` is
// preferred; we fall back to the first github.com remote we find so a repo that
// names its GitHub remote "upstream" still works. Returns null when there is no
// active repo or no GitHub remote — the PR features then stay silently
// unavailable, never erroring.

export interface GitHubRepoContext {
  owner: string;
  repo: string;
  /** The git remote whose URL we resolved (e.g. "origin"). */
  remoteName: string;
  /** The active repo entry, for git operations (fetch/checkout). */
  entry: RepoEntry;
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

  let remotes: { name: string; fetchUrl: string; pushUrl: string }[];
  try {
    remotes = await entry.ctx.remotes.list();
  } catch {
    return null;
  }
  if (remotes.length === 0) {
    return null;
  }

  // origin first, then any other github.com remote.
  const ordered = [...remotes].sort((a, b) => {
    if (a.name === "origin") return -1;
    if (b.name === "origin") return 1;
    return 0;
  });

  for (const remote of ordered) {
    const url = remote.fetchUrl || remote.pushUrl;
    const parsed: ParsedRemote | null = parseRemote(url);
    if (isGitHubRemote(parsed)) {
      return {
        owner: parsed.owner,
        repo: parsed.repo,
        remoteName: remote.name,
        entry,
      };
    }
  }
  return null;
}
