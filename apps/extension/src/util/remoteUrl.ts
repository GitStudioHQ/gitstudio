// Turning a git remote into a browsable commit URL. Shared by the blame
// annotation menu and the commit-details "open on remote" action.
//
// Which remote: both used to read `git remote get-url origin`, so a repository
// whose only remote is "upstream" (or a fork tracked under another name) was
// told "origin isn't a recognised … remote". The remote is chosen here from
// the repository's own: the current branch's upstream remote, then "origin",
// then any other — the first of those whose address can be linked to.
//
// github.com is recognised by the parser the Pull Requests view uses (engine
// parseGitHubRemote, with git-service's ~/.ssh/config aliases), so a remote
// whose pull requests list there opens its commits on github.com too: ssh://,
// ssh.github.com:443, www.github.com, `github.com-work` and a `Host` alias.

import type { GitContext } from "@gitstudio/git-service/GitContext";
import { parseGitHubRemote } from "@gitstudio/engine/forge/parseRemote";
import { sshAliasResolver } from "@gitstudio/git-service/sshAliases";

/** An SSH host alias → the host it stands for (~/.ssh/config's HostName). */
type ResolveHost = (host: string) => string | undefined;

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
  resolveHost?: ResolveHost,
): NamedRemote | undefined {
  const order = [
    ...remotes.filter((r) => r.name === upstreamRemote),
    ...remotes.filter((r) => r.name === "origin" && r.name !== upstreamRemote),
    ...remotes.filter((r) => r.name !== "origin" && r.name !== upstreamRemote),
  ];
  return order.find((r) => commitWebUrl(r.fetchUrl, "0", resolveHost) !== undefined);
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
  const resolveHost = await sshAliasResolver();
  const remote = browseRemote(remotes, upstreamRemote, resolveHost);
  const url = remote ? commitWebUrl(remote.fetchUrl, sha, resolveHost) : undefined;
  if (!url) {
    const names = remotes.map((r) => r.name).join(", ");
    return { reason: `no remote of this repository (${names}) is a GitHub, GitLab or Bitbucket address.` };
  }
  return { url };
}

/**
 * Build a web URL for a commit from a remote's address. github.com under any
 * name the Pull Requests view knows (see the top of this file; `resolveHost`
 * for ~/.ssh/config aliases) is https://github.com/<owner>/<repo>. Otherwise
 * scp-style (git@host:org/repo.git), ssh:// and http(s) remotes of
 * GitHub/GitLab-shaped hosts; undefined for anything unrecognised rather than
 * guessing.
 */
export function commitWebUrl(remote: string, sha: string, resolveHost?: ResolveHost): string | undefined {
  if (!remote) {
    return undefined;
  }
  const gh = parseGitHubRemote(remote, resolveHost);
  if (gh) {
    return `https://github.com/${gh.owner}/${gh.repo}/commit/${sha}`;
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
      if (u.protocol === "ssh:") {
        // The web host, not ssh's port.
        host = u.hostname;
      } else if (u.protocol === "https:" || u.protocol === "http:") {
        host = u.host;
      } else {
        return undefined;
      }
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
