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
 * Two conditions are classified by what GitHub SAYS rather than by its status,
 * because the status alone is not the same twice:
 *
 *   - a repository with no commits ("This repository is empty.") — 404 from the
 *     contents API, 409 from `/commits` and `/git/trees`;
 *   - a GraphQL NOT_FOUND, which arrives inside a 200 and names the object it
 *     could not resolve.
 *
 * Both were filed as crashes (reports #13, #14, #17) and neither is a defect.
 *
 * Nothing here changes what the user sees: an ExpectedError carries the same
 * message and reaches the renderer as the same rejection. Only the reporter
 * treats it differently.
 */

import { EMPTY_REPO_MESSAGE, isEmptyRepoMessage } from "../shared/githubStates";
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
  // An empty repository, before any status branch can disagree about it.
  // GitHub answers 404 here from the contents API and 409 from `/commits` and
  // `/git/trees`, so only the sentence is stable — and under the 404 rule this
  // read as "a path we built wrong" and was crash-reported (#13) for somebody
  // browsing a repository they had just created. Normalised to one wording so
  // the renderer can recognise it across IPC, where an error is its message.
  if (isEmptyRepoMessage(detail)) {
    return new ExpectedError(EMPTY_REPO_MESSAGE);
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
  // 409 is GitHub's answer for "I understood you, and the repository is not in
  // a state where that can happen": an empty repository (handled above), a
  // merge that conflicts, a ref that moved under a request. None of them is a
  // request we built wrong.
  if (res.status === 409) {
    return new ExpectedError(detail || "GitHub couldn't apply that to the repository as it stands.");
  }
  if (res.status === 404) {
    return new Error(detail || "Not found on GitHub.");
  }
  return new Error(detail || `GitHub request failed (HTTP ${res.status}).`);
}

/** One entry of a GraphQL response's `errors` array, as GitHub sends it. */
export interface GraphqlFailure {
  message: string;
  type?: string;
  /** The field this error is about — `["repository"]`, `["node", "items"]`. */
  path?: (string | number)[];
}

/** `Could not resolve to a Repository with the name 'owner/name'.` → owner/name. */
function unresolvedName(message: string): string | undefined {
  return /^Could not resolve to an? \w+ with the name '(.+)'\.?$/.exec(message)?.[1];
}

/**
 * GraphQL puts its failures in a 200 body, so `githubHttpError` never sees
 * them. Three of the machine-readable `type`s are expected conditions — the
 * rate limiter, a permission the user has not granted, and NOT_FOUND.
 *
 * NOT_FOUND is the interesting one, because the REST policy above deliberately
 * REPORTS a 404. Which of the two a GraphQL NOT_FOUND is depends on WHAT it
 * could not resolve, and GitHub says so in the sentence:
 *
 *   "Could not resolve to a Repository with the name 'owner/name'."
 *       — an object named by the USER's world: the owner/name behind a git
 *         remote. Renamed, deleted, or moved into an org this account cannot
 *         see are all states a user is allowed to be in. Reports #14 and #17
 *         were exactly this, and they also read as GitHub jargon, so the
 *         wording is replaced with something that says what it might mean.
 *
 *   "Could not resolve to a node with the global id of '…'."
 *       — an id WE put in the request. A project item id, a review thread id,
 *         a pull request id: every one of them travels from a read, through
 *         the renderer, into a mutation payload, and building that payload
 *         wrong is this app's most-repeated defect (issues #12/#19, and three
 *         more found in one sweep). That is precisely the bug a crash report
 *         is best at catching, and it is the same judgement the REST 404 rule
 *         above makes about a path we built. Reported, as it was before the
 *         #14/#17 fix — which never set out to change this case.
 *
 * So: expected only when the message NAMES the object. Anything else keeps
 * GitHub's own wording and keeps reporting.
 */
export function graphqlError(err: GraphqlFailure): Error {
  const message = err.message || "GitHub's GraphQL API returned an error.";
  if (err.type === "NOT_FOUND") {
    const name = unresolvedName(message);
    return name
      ? new ExpectedError(
          `GitHub couldn't find ${name}. It may have been renamed or deleted, ` +
            `or this account may not have access to it.`,
        )
      : new Error(message);
  }
  return err.type === "RATE_LIMITED" || err.type === "FORBIDDEN"
    ? new ExpectedError(message)
    : new Error(message);
}

/**
 * Whether a GraphQL 200 that carries BOTH `data` and `errors` should keep its
 * data instead of throwing.
 *
 * GraphQL resolves every field it can and reports the rest, so an `errors`
 * array is not the same thing as a failed request — and treating it as one
 * threw away everything that *did* resolve. One unreadable repository named in
 * a query took the whole answer down with it.
 *
 * The rule is deliberately narrow, because the opposite mistake is worse:
 * laundering a read failure into a confident empty list. Only NOT_FOUND
 * survives — it means the object genuinely is not there, which is an answer —
 * and only when something non-null actually came back. A rate limit or a denied
 * scope means the answer is INCOMPLETE for a reason that would look exactly
 * like "empty" downstream, so those keep throwing.
 *
 * Note the asymmetry with `graphqlError`, which only treats a NOT_FOUND as a
 * condition when it NAMES its object. This rule is looser on purpose: keeping
 * partial data is about not discarding what resolved, not about classifying
 * what did not, and `opts.onPartial` hands the caller every error it kept. It
 * is also unreachable today — every query in this app has a single root, so a
 * NOT_FOUND always nulls the whole answer and this returns false. If a
 * multi-root query is ever added, pass `onPartial` and decide there.
 */
export function keepsPartialData(data: unknown, errors: GraphqlFailure[]): boolean {
  if (!errors.length || !errors.every((e) => e.type === "NOT_FOUND")) return false;
  if (typeof data !== "object" || data === null) return false;
  return Object.values(data as Record<string, unknown>).some((v) => v !== null && v !== undefined);
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
