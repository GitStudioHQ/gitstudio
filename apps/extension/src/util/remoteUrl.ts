// Turning a git remote into a browsable commit URL. Shared by the blame
// annotation menu and the commit-details "open on remote" action.
//
// Which remote: both used to read `git remote get-url origin`, so a repository
// whose only remote is "upstream" (or a fork tracked under another name) was
// told "origin isn't a recognised … remote". The remote is chosen here from
// the repository's own: the current branch's upstream remote, then "origin",
// then any other — the first of those whose address can be linked to.

import type { GitContext } from "@gitstudio/git-service/GitContext";

/** A remote as `git remote -v` lists it (RemoteOps.list). */
export interface NamedRemote {
  name: string;
  fetchUrl: string;
}

/**
 * The remote to browse a commit on, in order: the current branch's upstream
 * remote, "origin", then the rest in git's order — the first whose address
 * is a host this can link to. Undefined when none is.
 */
export function browseRemote(
  remotes: readonly NamedRemote[],
  upstreamRemote: string | undefined,
): NamedRemote | undefined {
  const order = [
    ...remotes.filter((r) => r.name === upstreamRemote),
    ...remotes.filter((r) => r.name === "origin" && r.name !== upstreamRemote),
    ...remotes.filter((r) => r.name !== "origin" && r.name !== upstreamRemote),
  ];
  return order.find((r) => commitWebUrl(r.fetchUrl, "0") !== undefined);
}

/** The web address of `sha` on the repository's remote, or why there is none. */
export async function commitWebUrlIn(
  ctx: Pick<GitContext, "remotes" | "refs" | "process">,
  sha: string,
): Promise<{ url: string } | { reason: string }> {
  const remotes = await ctx.remotes.list();
  if (remotes.length === 0) {
    return { reason: "this repository has no remote to open the commit on." };
  }
  let upstreamRemote: string | undefined;
  try {
    const head = await ctx.refs.getHead();
    if (!head.detached && head.fullName?.startsWith("refs/heads/")) {
      const r = await ctx.process.run(["for-each-ref", "--format=%(upstream:remotename)", head.fullName]);
      upstreamRemote = r.code === 0 ? r.stdout.trim() || undefined : undefined;
    }
  } catch {
    // No HEAD to read (an unborn branch): origin, then the rest.
  }
  const remote = browseRemote(remotes, upstreamRemote);
  const url = remote ? commitWebUrl(remote.fetchUrl, sha) : undefined;
  if (!url) {
    const names = remotes.map((r) => r.name).join(", ");
    return { reason: `no remote of this repository (${names}) is a GitHub, GitLab or Bitbucket address.` };
  }
  return { url };
}

/**
 * Build a web URL for a commit from a remote's address. Handles both scp-style
 * (git@host:org/repo.git) and https remotes for GitHub/GitLab-shaped hosts;
 * returns undefined for anything unrecognised rather than guessing.
 */
export function commitWebUrl(remote: string, sha: string): string | undefined {
  if (!remote) {
    return undefined;
  }
  let host: string;
  let path: string;
  const scp = remote.match(/^[\w.+-]+@([^:]+):(.+)$/);
  if (scp) {
    host = scp[1];
    path = scp[2];
  } else {
    try {
      const u = new URL(remote);
      if (u.protocol !== "https:" && u.protocol !== "http:") {
        return undefined;
      }
      host = u.host;
      path = u.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  }
  path = path.replace(/\.git$/, "").replace(/\/+$/, "");
  if (!host || !path) {
    return undefined;
  }
  // GitHub and GitLab both use /commit/<sha>; Bitbucket uses /commits/<sha>.
  const segment = /bitbucket/i.test(host) ? "commits" : "commit";
  return `https://${host}/${path}/${segment}/${sha}`;
}
