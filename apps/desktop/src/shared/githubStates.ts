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
 * True when a GitHub error message says the repository has no commits.
 *
 * Matches GitHub's own wordings as well as our normalised one, because this is
 * also what the RAW body is tested with before it is normalised.
 */
export function isEmptyRepoMessage(message: string | undefined | null): boolean {
  return typeof message === "string" && /\brepository is empty\b/i.test(message);
}
