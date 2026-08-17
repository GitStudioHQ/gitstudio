/**
 * One place that decides which GitHub failures are OUR defects.
 *
 * Every IPC handler is wrapped in a catch that files an anonymous crash report,
 * which is right for a handler that throws by mistake and wrong for a handler
 * that throws because the world is the way it is. 1.1.1 fixed the loudest case
 * ("Not connected to GitHub." was filed three times by someone who had simply
 * not signed in); its siblings are fixed here.
 *
 * The policy, stated once so it stops being decided case by case:
 *
 *   REPORT   — our bugs. A malformed request (400/422), a path we built wrong
 *              (404), a response we failed to parse.
 *   IGNORE   — the network, the user's auth state, and GitHub's own health.
 *              Being offline, a revoked or expired token, a scope the user did
 *              not grant, the rate limiter, and 5xx are all things a user can
 *              legitimately be in the middle of. None of them are ours to fix,
 *              and anyone on flaky wifi would otherwise generate a stream.
 *
 * 404 is the deliberate edge. GitHub answers 404 rather than 403 for a private
 * repo the token cannot see, so some 404s really are an auth state — but a
 * wrong endpoint is also the exact bug a crash report is best at catching, all
 * our paths are built from static strings, and the collector dedupes by
 * message, so the noise from a genuinely invisible repo is one issue, not a
 * stream. Reported, on purpose. Revisit if real reports say otherwise.
 *
 * Nothing here changes what the user sees: an ExpectedError carries the same
 * message and reaches the renderer as the same rejection. Only the reporter
 * treats it differently.
 */

import { ExpectedError, isExpectedError } from "./expectedError";

/**
 * We never reached GitHub at all — offline, DNS, a dropped TLS handshake. Node
 * surfaces these as a bare `TypeError: fetch failed`, which is both useless to
 * the user and pure noise in the crash reporter.
 */
export function networkError(
  message = "Couldn't reach GitHub. Check your network connection.",
): ExpectedError {
  return new ExpectedError(message);
}

/**
 * Turn a non-2xx GitHub response into a clean Error, expected or not per the
 * policy above. Consumes the body, so call it once per response.
 */
export async function githubHttpError(res: Response): Promise<Error> {
  let detail = "";
  try {
    detail = ((await res.json()) as { message?: string })?.message ?? "";
  } catch {
    /* non-JSON body */
  }
  // Our own wording, not GitHub's "Bad credentials" — which reads as an
  // accusation rather than "sign in again".
  if (res.status === 401) {
    return new ExpectedError("Your GitHub token is invalid or expired.");
  }
  // 403 covers both "you lack the scope" and, on REST, the secondary rate limit;
  // 429 is the primary one. Neither is a defect.
  if (res.status === 403) {
    return new ExpectedError(
      detail || "GitHub denied the request (permissions or rate limit).",
    );
  }
  if (res.status === 429) {
    return new ExpectedError(
      detail || "GitHub is rate-limiting this request. Try again shortly.",
    );
  }
  if (res.status >= 500) {
    return new ExpectedError(
      detail || `GitHub is having trouble right now (HTTP ${res.status}).`,
    );
  }
  if (res.status === 404) {
    return new Error(detail || "Not found on GitHub.");
  }
  return new Error(detail || `GitHub request failed (HTTP ${res.status}).`);
}

/**
 * GraphQL puts its failures in a 200 body, so `githubHttpError` never sees
 * them. Two of the machine-readable `type`s are the same expected conditions —
 * the rate limiter, and a permission the user has not granted.
 */
export function graphqlError(err: { message: string; type?: string }): Error {
  const message = err.message || "GitHub's GraphQL API returned an error.";
  return err.type === "RATE_LIMITED" || err.type === "FORBIDDEN"
    ? new ExpectedError(message)
    : new Error(message);
}

/**
 * The `{ message, expected? }` half of an `ok:false` result, for the mutation
 * handlers that CATCH a thrown error and hand the renderer a result instead:
 *
 *     return { ok: false, changed: false, ...errorFields(err) };
 *
 * These sites used to keep only `err.message`, which quietly undid everything
 * above: an ExpectedError thrown for an expired token or a rate limit arrived
 * at the IPC wrapper as a bare `{ok:false, message}`, and the wrapper's
 * ok:false branch filed the crash report the throw had just been spared. Every
 * mutation in the app — closing an issue, re-running a workflow, publishing a
 * release — went down this path.
 */
export function errorFields(err: unknown): { message: string; expected?: true } {
  const message = err instanceof Error ? err.message : String(err);
  return isExpectedError(err) ? { message, expected: true } : { message };
}
