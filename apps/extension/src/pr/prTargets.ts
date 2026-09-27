// Which repository's pull requests the list shows — and which others it can.
//
// A clone's remotes name one or more GitHub repositories (origin first). The
// usual fork clone has origin = YOUR fork, whose pull requests are rarely
// the ones you mean: the owner's decision is that a fork targets the
// repository it was forked from (as github.com's own "Pull requests" button
// does), with origin one click away in the list's switcher. GitHub says
// what a repository was forked from; that answer is asked once per
// repository per session.
//
// A target the clone has no remote for (the parent of a fork cloned without
// an `upstream`) is fetched by its URL: `git fetch https://github.com/o/r.git`
// — a URL, never an option-like word, reaches git as the remote.

import type { PrRepoInfo } from "@gitstudio/engine/forge/prList";
import type { PrListTarget } from "@gitstudio/host-bridge/prProtocol";
import type { RepoEntry } from "../git/repoManager";
import type { GitHubRemote } from "./repoContext";
import type { GitHubRepoContext } from "./repoContext";

export interface PrTarget extends PrListTarget {
  /** The git remote whose URL names it, if the clone has one. */
  remoteName?: string;
}

export interface PrTargets {
  targets: PrTarget[];
  /** The one shown unless the user chose another: a fork's parent, else origin. */
  defaultId: string;
}

const sameId = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * The repositories a clone's GitHub remotes offer. `info` answers whether
 * the first remote's repository is a fork (and of what); a failure to ask
 * leaves the remotes as they are — never no list at all.
 */
export async function resolvePrTargets(
  remotes: readonly GitHubRemote[],
  info: (owner: string, repo: string) => Promise<PrRepoInfo | undefined>,
): Promise<PrTargets | undefined> {
  const first = remotes[0];
  if (!first) return undefined;
  const firstInfo = await info(first.owner, first.repo).catch(() => undefined);
  const remoteFor = (owner: string, repo: string) => remotes.find((r) => sameId(`${r.owner}/${r.repo}`, `${owner}/${repo}`));
  const targets: PrTarget[] = [];
  const add = (t: PrTarget) => {
    if (!targets.some((x) => sameId(x.id, t.id))) targets.push(t);
  };
  const parent = firstInfo?.isFork ? firstInfo.parent : undefined;
  if (parent) {
    const r = remoteFor(parent.owner, parent.repo);
    add({
      id: `${parent.owner}/${parent.repo}`,
      owner: parent.owner,
      repo: parent.repo,
      detail: r ? `remote ${r.name} — ${first.name} was forked from it` : `${first.name} was forked from it`,
      ...(r ? { remoteName: r.name } : {}),
    });
  }
  add({
    id: `${first.owner}/${first.repo}`,
    owner: first.owner,
    repo: first.repo,
    detail: parent ? `remote ${first.name} — a fork of ${parent.owner}/${parent.repo}` : `remote ${first.name}`,
    remoteName: first.name,
  });
  for (const r of remotes.slice(1)) {
    add({ id: `${r.owner}/${r.repo}`, owner: r.owner, repo: r.repo, detail: `remote ${r.name}`, remoteName: r.name });
  }
  return { targets, defaultId: targets[0].id };
}

/** The context the PR commands act in, for a target of this clone. */
export function contextFor(target: PrTarget, entry: RepoEntry): GitHubRepoContext {
  return {
    owner: target.owner,
    repo: target.repo,
    // What `git fetch` is given: the remote that names the repository, or its URL.
    remoteName: target.remoteName ?? `https://github.com/${target.owner}/${target.repo}.git`,
    entry,
  };
}
