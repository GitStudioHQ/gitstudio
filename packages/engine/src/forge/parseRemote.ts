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

/**
 * True when `host` (lowercased) is github.com under any name a real remote
 * uses for it:
 *   github.com
 *   www.github.com                — what a browser's address bar gives you
 *   ssh.github.com                — SSH over port 443, for networks that block 22
 *   github.com-work               — an SSH host ALIAS: the multi-account
 *                                   ~/.ssh/config pattern (`Host github.com-work`)
 * Host-anchored: "evilnotgithub.com" and "github.com.evil.io" never match, and
 * GitHub Enterprise hosts (github.example.com) are not github.com.
 */
export function isGitHubHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === "github.com" ||
    h === "www.github.com" ||
    h === "ssh.github.com" ||
    /^github\.com-[\w.-]+$/.test(h)
  );
}

/**
 * True when a parsed remote points at github.com (the only forge M11
 * supports), under any of the names {@link isGitHubHost} knows.
 */
export function isGitHubRemote(remote: ParsedRemote | null): remote is ParsedRemote {
  return remote !== null && isGitHubHost(remote.host);
}

/**
 * A remote URL → the github.com repository it names, or undefined when it
 * isn't one. Exactly `owner/repo`: github.com has no deeper namespaces, so
 * `https://github.com/o/r/extra` is not a repository.
 *
 * `resolveHost` maps an SSH host alias to the host it stands for — the
 * `HostName` of a `Host` block in ~/.ssh/config (see sshConfigHostName) — so
 * `git@work:o/r` with `Host work / HostName github.com` is github.com too.
 */
export function parseGitHubRemote(
  url: string,
  resolveHost?: (host: string) => string | undefined,
): { owner: string; repo: string } | undefined {
  const trimmed = url.trim();
  const parsed = parseRemote(trimmed);
  if (!parsed) {
    return undefined;
  }
  const host = isGitHubHost(parsed.host)
    ? parsed.host
    : (resolveHost?.(parsed.host) ?? parsed.host);
  if (!isGitHubHost(host)) {
    return undefined;
  }
  // parseRemote keeps first and last segments; github.com wants exactly two.
  const path = trimmed.includes("://")
    ? (() => {
        try {
          return new URL(trimmed).pathname;
        } catch {
          return "";
        }
      })()
    : trimmed.slice(trimmed.indexOf(":") + 1);
  const segments = path
    .replace(/\.git\/?$/i, "")
    .split("/")
    .filter((s) => s.length > 0);
  if (segments.length !== 2) {
    return undefined;
  }
  return { owner: parsed.owner, repo: parsed.repo };
}

/**
 * The `HostName` an SSH config gives `alias`, or undefined when no `Host`
 * block matching it sets one. The first match wins, as in ssh itself, and a
 * `Host` line's patterns may use `*` and `?` and be negated with `!`.
 * `Match` blocks and `Include`d files are not followed — an alias defined only
 * there stays unresolved, never wrongly resolved.
 */
export function sshConfigHostName(configText: string, alias: string): string | undefined {
  const wanted = alias.toLowerCase();
  let matching = false;
  for (const raw of configText.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }
    const m = /^(\S+?)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) {
      continue;
    }
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "host") {
      const patterns = value.split(/\s+/).filter(Boolean);
      const hit = (p: string) => globMatch(p.toLowerCase(), wanted);
      matching =
        patterns.some((p) => !p.startsWith("!") && hit(p)) &&
        !patterns.some((p) => p.startsWith("!") && hit(p.slice(1)));
      continue;
    }
    if (key === "match") {
      matching = false;
      continue;
    }
    if (matching && key === "hostname" && value) {
      return value.replace(/^"(.*)"$/, "$1").toLowerCase();
    }
  }
  return undefined;
}

/** ssh_config(5) patterns: `*` any run, `?` one character, nothing else special. */
function globMatch(pattern: string, text: string): boolean {
  const re = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`,
  );
  return re.test(text);
}
