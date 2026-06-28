// Pure, dependency-free validation for user-supplied `git clone` URLs. Kept
// separate from cloneBridge (which imports electron) so it can be unit-tested.

/** Protocols git is permitted to use for a clone (passed via GIT_ALLOW_PROTOCOL).
 *  This hard-blocks the `ext`/`fd` remote-helper transports, which can run
 *  arbitrary shell commands embedded in a URL (CVE-2017-1000117 class). */
export const ALLOWED_PROTOCOLS = "https:http:git:ssh:file";

/**
 * Validate a user-supplied clone URL. Returns an error message string when the
 * URL is rejected, or null when it is safe to pass to `git clone`.
 *
 * The two real attacks this closes:
 *  1. Remote-helper transports — `ext::sh -c "<cmd>"` and `<transport>::<addr>`
 *     make git execute commands. We reject any `scheme::` form outright (and
 *     GIT_ALLOW_PROTOCOL is set as defense-in-depth at spawn time).
 *  2. Option injection — a URL beginning with `-` is parsed by git as a flag
 *     (e.g. `--upload-pack=…`) rather than a positional. We reject leading `-`.
 */
export function validateCloneUrl(raw: string): string | null {
  const url = raw.trim();
  if (!url) return "No repository URL was provided.";
  if (url.startsWith("-")) {
    return "That doesn't look like a valid repository URL.";
  }
  // `scheme::address` is git's remote-helper syntax (ext::, fd::, …) — never allow it.
  if (/^[a-z][a-z0-9+.-]*::/i.test(url)) {
    return "That URL uses an unsupported transport.";
  }
  // Explicit `scheme://` URLs must use an allowed protocol.
  const m = /^([a-z][a-z0-9+.-]*):\/\//i.exec(url);
  if (m) {
    if (!ALLOWED_PROTOCOLS.split(":").includes(m[1].toLowerCase())) {
      return "That URL uses an unsupported scheme.";
    }
    return null;
  }
  // SCP-like (git@host:path) and bare absolute local paths are fine.
  if (/^[^\s/]+@[^\s/:]+:.+/.test(url) || url.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(url)) {
    return null;
  }
  return "That doesn't look like a valid repository URL.";
}
