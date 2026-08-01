// Turning a git remote into a browsable commit URL. Shared by the blame
// annotation menu and the commit-details "open on remote" action.

/**
 * Build a web URL for a commit from an `origin` remote. Handles both scp-style
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
