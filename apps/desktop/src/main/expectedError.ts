/**
 * A condition the user can be in, not a defect.
 *
 * Every IPC handler is wrapped in a catch that files a crash report, because a
 * handler that throws is normally a bug. But some throws are just answers: you
 * have not connected GitHub yet, or this repo has no github.com remote. Those
 * reached the crash reporter and were filed as failures — one of them three
 * times over, for a user who simply had not signed in.
 *
 * Throw this instead. The renderer still receives the same Error with the same
 * message, so nothing about the UI changes; only the reporter treats it
 * differently.
 */
export class ExpectedError extends Error {
  /** Structural marker: survives the class identity being lost across bundles. */
  readonly expected = true as const;

  // Deliberately does NOT set `this.name`.
  //
  // Electron serializes a rejected IPC handler with the error's toString(), i.e.
  // "<name>: <message>", and the renderer's cleanErr() strips a leading "Error:"
  // — but not "ExpectedError:". Naming this class would put the class name in
  // front of every message the user reads, which is the opposite of the point.
  // `isExpectedError` never looks at `name`, so there is nothing to gain.
}

/** True when `err` is an expected condition that must not be crash-reported. */
export function isExpectedError(err: unknown): boolean {
  return (
    err instanceof ExpectedError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { expected?: unknown }).expected === true)
  );
}

/**
 * The message an IPC result should be crash-reported with, or undefined when it
 * should not be reported at all.
 *
 * A handler that RETURNS `{ok:false, message}` is the desktop analog of the
 * extension's showGitError, and reporting it is how we hear about git commands
 * that failed for a reason worth knowing about. But most `ok:false` results are
 * not failures at all — no repository open, nothing staged, a feature this
 * build does not carry — and those say so with `expected`.
 *
 * Lives here rather than inline in main.ts's wrapper so the decision is
 * testable without an Electron app around it. The rule itself is unchanged.
 */
export function reportableResultMessage(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  if ((result as { ok?: unknown }).ok !== false) return undefined;
  if (isExpectedError(result)) return undefined;
  const message = (result as { message?: unknown }).message;
  if (typeof message !== "string" || !message.trim()) return undefined;
  return remoteOutcome(message) ? undefined : message;
}

/**
 * What a remote said, when it is an answer about the remote or the user's
 * setup rather than about anything this app did.
 *
 * Push, pull and fetch hand git's own stderr back as the result's message, so
 * every refusal a remote can give arrived in the crash tracker as "Push" /
 * "Push branch": the branch moved on the remote (reports #24, #25, #33), a
 * protected branch (#22), no credentials and no terminal to ask for them in
 * (#31, #32), a repository with no remote at all (#30). None of them is
 * something we can fix by reading a report, and the renderer already shows
 * the user git's words — so they are not filed. What the app DOES build — a
 * refspec, a remote name, a lease — keeps reporting: "src refspec … does not
 * match any" and "does not appear to be a git repository" are deliberately
 * not here (reportingVerdicts.test.ts files the second).
 *
 * Matched on git's English, because the reporter only ever sees the words. A
 * git that speaks another language does not match, and reports as before:
 * the side to err on.
 */
const REMOTE_OUTCOMES: ReadonlyArray<{ name: string; re: RegExp }> = [
  {
    // "! [rejected] main -> main (fetch first)" / "(non-fast-forward)", with
    // git's "Updates were rejected because …" hint. NOT "(stale info)": that is
    // a --force-with-lease refused, and the lease's expected sha is ours
    // (SyncOps.push) — a wrong one looks exactly like that, so it reports.
    name: "the remote branch moved on",
    re: /\bUpdates were rejected because (?:the tip of your current branch is behind|the remote contains work|a pushed branch tip is behind|the tag already exists)|\[rejected\][^\n]*\((?:fetch first|non-fast-forward|already exists)\)/,
  },
  {
    // The server's own policy: a protected branch (GitHub's GH006, a ruleset's
    // GH013, GitLab's), a pre-receive or update hook. Not every
    // "[remote rejected]": "(funny refname)" or "(deny updating a hidden ref)"
    // is about a ref the app may have spelled, and reports.
    name: "the remote's own rules refused it",
    re: /\[remote rejected\][^\n]*\((?:pre-receive|update|protected branch) hook declined\)|\bGH006\b|\bGH013\b|\bProtected branch update failed\b|push declined due to repository rule violations|not allowed to push code to protected branches/i,
  },
  {
    name: "no credentials, or not these ones",
    re: /could not read (?:Username|Password) for|\bAuthentication failed for\b|Permission denied \(publickey|Host key verification failed|The requested URL returned error: (?:401|403)\b|Invalid username or (?:password|token)|Support for password authentication was removed/i,
  },
  {
    // GitHub's answer for a repository you cannot see, and a repo with no remote.
    name: "nowhere to push, or no access to it",
    re: /\bremote: Repository not found\b|\bNo configured push destination\b/i,
  },
  {
    name: "the network",
    re: /Could not resolve host|Could not resolve hostname|Failed to connect to|Connection (?:timed out|refused|reset)|Operation timed out|Network is unreachable/i,
  },
];

/** The kind of remote answer `message` is (see REMOTE_OUTCOMES), or undefined. */
export function remoteOutcome(message: string): string | undefined {
  return REMOTE_OUTCOMES.find((c) => c.re.test(message))?.name;
}
