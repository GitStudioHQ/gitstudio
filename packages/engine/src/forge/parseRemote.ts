// Pure, host-agnostic parsing of a git remote URL into its forge coordinates.
// No vscode / node / fs imports — this stays unit-testable and lets the same
// logic power the future desktop app. The PR layer (apps/extension/src/pr) maps
// the active repo's `origin` remote through this to find {owner, repo} before
// talking to the GitHub REST API.

/** A parsed git remote: the forge host plus the owner/repo it points at. */
export interface ParsedRemote {
  /** The host, lowercased (e.g. "github.com"). */
  host: string;
  /** The repository owner / org (case preserved). */
  owner: string;
  /** The repository name, with any trailing ".git" stripped (case preserved). */
  repo: string;
}

/**
 * Parse a git remote URL into `{ host, owner, repo }`, or `null` when it isn't a
 * recognisable `owner/repo` remote. Pure and deterministic.
 *
 * Handles the three shapes git emits in practice:
 *   - scp-like ssh:   `git@github.com:OWNER/REPO.git`
 *   - https:          `https://github.com/OWNER/REPO.git`
 *   - explicit ssh:   `ssh://git@github.com/OWNER/REPO.git`
 *
 * A trailing `.git` and any trailing slash are stripped. Userinfo (`git@`),
 * ports, and the leading slash on ss:// paths are all tolerated. The host is
 * lowercased; owner/repo keep their original case. Callers decide which hosts
 * they support (M11 only acts on `github.com`).
 */
export function parseRemote(url: string): ParsedRemote | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let host: string;
  let path: string;

  const scpMatch = /^(?:[^@/]+@)?([^/:]+):(.+)$/.exec(trimmed);
  if (
    !trimmed.includes("://") &&
    scpMatch &&
    // A bare Windows drive path ("C:\...") is not a remote; require a non-empty,
    // non-absolute path component after the colon.
    !/^[A-Za-z]$/.test(scpMatch[1])
  ) {
    // scp-like ssh: `[user@]host:owner/repo[.git]`.
    host = scpMatch[1];
    path = scpMatch[2];
  } else {
    // URL forms: ssh://, https://, http://, git://, etc.
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    host = parsed.hostname;
    path = parsed.pathname;
  }

  const segments = path
    .replace(/^\/+/, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  let repo = segments[segments.length - 1];
  repo = repo.replace(/\.git$/i, "");

  const normalizedHost = host.toLowerCase();
  if (normalizedHost.length === 0 || owner.length === 0 || repo.length === 0) {
    return null;
  }

  return { host: normalizedHost, owner, repo };
}

/** True when a parsed remote points at github.com (the only forge M11 supports). */
export function isGitHubRemote(remote: ParsedRemote | null): remote is ParsedRemote {
  return remote !== null && remote.host === "github.com";
}
