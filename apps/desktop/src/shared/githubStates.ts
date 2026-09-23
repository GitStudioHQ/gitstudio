// GitHub answers that describe the WORLD rather than a failure, named once so
// the main process and the renderer agree about them.
//
// A repository with no commits is the clearest case. GitHub reports it with a
// different status on every endpoint that meets it — the contents API answers
// 404, `/commits` and `/git/trees` answer 409 — and the only stable part of the
// answer is the sentence in the body ("This repository is empty.", or "Git
// Repository is empty." from the git endpoints). Classifying by STATUS alone
// therefore cannot see it, which is how crash report #13 came to be filed for
// somebody browsing a repository they had just created.
//
// The main process normalises every spelling to EMPTY_REPO_MESSAGE, so the
// renderer has one string to recognise across the IPC boundary — where an
// error is only ever its message — and the crash collector one to dedupe.

/** The one sentence the app uses for "this repository has no commits yet". */
export const EMPTY_REPO_MESSAGE = "This repository is empty.";

/**
 * GitHub's own answer for a repository with no commits — and only that answer:
 * a 404 (the contents API) or a 409 (`/commits`, `/git/trees`) whose whole
 * message is "This repository is empty." or "Git Repository is empty.".
 *
 * Classified by the sentence because the status differs per endpoint, but NOT
 * by the sentence alone. Matching "repository is empty" anywhere in any status
 * would normalise a 422 validation failure or a 5xx page that happened to
 * mention one into the benign empty state — hiding a request we built wrong
 * behind "nothing has been pushed yet".
 */
export function isEmptyRepoResponse(status: number, message: string | undefined | null): boolean {
  return (
    (status === 404 || status === 409) &&
    typeof message === "string" &&
    /^(?:this|git) repository is empty\.?$/i.test(message.trim())
  );
}

/**
 * True when an error the RENDERER received is the main process's normalised
 * empty-repository answer.
 *
 * Exactly that one sentence. Anything else that merely mentions an empty
 * repository crossed the IPC boundary un-normalised precisely because
 * `isEmptyRepoResponse` decided it was not one.
 */
export function isEmptyRepoMessage(message: string | undefined | null): boolean {
  return typeof message === "string" && message.trim() === EMPTY_REPO_MESSAGE;
}
