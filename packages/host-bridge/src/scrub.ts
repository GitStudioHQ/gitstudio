/**
 * PII scrubbing for anonymous crash reports — shared by the VS Code extension
 * and the desktop app so this security-critical logic can never drift between
 * them. Pure and environment-neutral (no `node:*` imports), so it belongs in
 * this host-agnostic package and is exercised directly in test/scrub.test.ts.
 *
 * This is the last line of defense before anything leaves a user's machine.
 */

/**
 * Remove anything that could identify a user or their work: private keys, home
 * dirs, absolute paths (POSIX, Windows, and UNC) INCLUDING the file/project
 * names in the tail, remote URLs (creds AND org/repo), SSH remotes, emails, IPs,
 * JWTs, cloud/access tokens, and SHAs.
 *
 * Order matters — each step assumes the earlier ones already ran:
 *   - private-key blocks are nuked whole, before anything can partially match;
 *   - URL/remote redaction runs before the email pass (so an embedded token or
 *     an `org/repo` path is stripped before `user@host` collapses to `<email>`);
 *   - path redaction preserves a trailing `:line:col` (it stops at the first
 *     `:`) so crash stacks stay locatable without leaking file names;
 *   - JWT/AWS/SHA passes run before the generic long-token pass so they get a
 *     precise label instead of a blanket `<token>`.
 */
export function scrub(input: string): string {
  if (!input) {
    return "";
  }
  let s = input;
  const home = safeHome();
  if (home) {
    s = s.split(home).join("~");
  }
  s = s
    // whole private-key blocks (before any base64 body gets partially matched)
    .replace(/-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g, "<private-key>")
    // http(s) userinfo (https://user:token@host -> https://host)
    .replace(/(\bhttps?:\/\/)[^/\s@"']*@/gi, "$1")
    // http(s) path (keep scheme+host, drop org/repo/query which can identify)
    .replace(/(\bhttps?:\/\/[^/\s"']+)\/[^\s"')]*/gi, "$1/<path>")
    // scp-style git remote (git@host:org/repo -> git@host:<path>), before email
    .replace(/\b([\w.+-]+@[\w.-]+):[\w./~+-]+/g, "$1:<path>")
    // emails
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "<email>")
    // POSIX home/user paths: anonymize the user AND redact the tail (file and
    // project names), keeping any :line:col suffix (the tail stops at ':').
    .replace(
      /(~|\/Users\/[^/\s"':]+|\/home\/[^/\s"':]+)(\/[^\s"':]*)?/g,
      (_m, prefix: string, tail: string | undefined) => {
        const p = prefix.startsWith("/Users/")
          ? "/Users/<user>"
          : prefix.startsWith("/home/")
            ? "/home/<user>"
            : "~";
        return tail ? `${p}/<path>` : p;
      },
    )
    // Windows drive paths and UNC paths -> redact whole (keeps :line:col)
    .replace(/\b[A-Za-z]:\\[^\s"':]+/g, "<path>")
    .replace(/\\\\[^\s"':]+/g, "<path>")
    // IPv4 addresses
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>")
    // JWTs (always start with the base64 of `{"` -> eyJ)
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "<jwt>")
    // AWS access key ids
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<token>")
    // full commit shas -> short (before the generic token pass below)
    .replace(/\b[0-9a-f]{40}\b/gi, (m) => m.slice(0, 7))
    // access tokens / long hex-ish secrets
    .replace(/\b(gh[posur]_[A-Za-z0-9]{20,}|[A-Za-z0-9_-]{40,})\b/g, "<token>");
  return s;
}

/**
 * The current user's home directory, read from the environment so this stays
 * `node:*`-free (works in the extension host, Electron main, and under tsx).
 */
/**
 * Scrub a GIT ERROR MESSAGE down to its error CLASS.
 *
 * `scrub()` handles absolute paths, emails, URLs, tokens and SHAs, but git
 * stderr routinely names the things PRIVACY.md promises never to send:
 *   "error: Your local changes to the following files would be overwritten by
 *    merge:\n\tsrc/billing/secret-project.ts"
 *   "fatal: couldn't find remote ref 'feature/acme-migration'"
 * Both the file list and the quoted ref are repo-relative, so nothing above
 * touches them. This keeps the diagnostic sentence and redacts the identifiers.
 */
export function scrubGitMessage(input: string): string {
  if (!input) {
    return "";
  }
  return (
    scrub(input)
      // git quotes refs, branches and pathspecs in single quotes. The opening
      // quote must NOT follow a letter, or the apostrophe in "couldn't" opens a
      // bogus span and eats the rest of the sentence.
      .replace(/(^|[\s(:=[])'[^']{1,200}'/g, "$1'<ref>'")
      // ...and in double quotes in a few messages.
      .replace(/"[^"]{1,200}"/g, '"<ref>"')
      // Indented file lists under "the following files would be…".
      .replace(/^[ \t]+\S.*$/gm, "\t<path>")
      // Any surviving repo-relative path (a/b.ts, src/x/y).
      .replace(/\b[\w.-]+(?:\/[\w.-]+)+\b/g, "<path>")
      // A bare filename with a code-ish extension.
      .replace(/\b[\w.-]+\.(?:ts|tsx|js|jsx|py|go|rs|java|rb|c|h|cpp|cs|php|swift|kt|md|json|ya?ml|txt|lock)\b/gi, "<file>")
      // Collapse the runs of <path> a file list turns into.
      .replace(/(?:<path>[\s,]*){2,}/g, "<path> ")
      .trim()
  );
}

export function safeHome(): string {
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
  return proc?.env?.HOME || proc?.env?.USERPROFILE || "";
}

export function scrubExtra(extra?: Record<string, string>): Record<string, string> {
  if (!extra) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    out[safeShort(k, 40)] = scrub(String(v)).slice(0, 200);
  }
  return out;
}

export function safeShort(s: string, n: number): string {
  return (s || "").replace(/[\r\n]+/g, " ").slice(0, n);
}

export function randomId(): string {
  // A random, non-identifying install id (rotatable by clearing local state).
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
