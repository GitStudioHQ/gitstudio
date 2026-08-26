// The `origin` remote parser — pure, dependency-free, and deliberately in its
// OWN module: githubBridge imports electron, and the local-repo scanner (plus
// its node tests) must not drag that in just to read a remote URL.

/**
 * Parse a git remote URL into github.com owner/repo — or undefined when it
 * isn't github.com. Handles what real machines actually have:
 *   https://github.com/o/r(.git)(/)      — plus http
 *   git@github.com:o/r.git               — scp-like
 *   git@github.com-work:o/r.git          — SSH host ALIASES (multi-account)
 *   ssh://git@github.com:22/o/r.git      — ssh with a port (the old regex
 *                                           parsed owner="22" and 404'd forever)
 *   git://github.com/o/r
 * Host-anchored: "evilnotgithub.com" never matches.
 */
export function parseGitHubRemote(url: string): { owner: string; repo: string } | undefined {
  const u = url.trim();
  if (!u) return undefined;
  let path: string | undefined;
  // scp-like: [user@]HOST:path — HOST must be github.com or a github.com-* alias.
  let m = /^(?:[\w.-]+@)?github\.com(?:-[\w.-]+)?:([^/].*)$/i.exec(u);
  if (m) path = m[1];
  if (!path) {
    // URL forms: scheme://[user@]github.com[:port]/path
    m = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[\w.-]+@)?github\.com(?:-[\w.-]+)?(?::\d+)?\/(.+)$/i.exec(u);
    if (m) path = m[1];
  }
  if (!path) return undefined;
  const parts = path
    .replace(/\.git\/?$/i, "")
    .replace(/\/+$/, "")
    .split("/")
    .filter(Boolean);
  // Exactly owner/repo — github.com has no deeper namespaces.
  if (parts.length !== 2) return undefined;
  return { owner: parts[0], repo: parts[1] };
}
