import { userStateOutcome } from "@gitstudio/host-bridge/gitOutcomes";

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
 * What a remote — or the user's setup, or their working tree — said, when it
 * is an answer about their situation rather than about anything this app did.
 *
 * Push, pull and fetch hand git's own stderr back as the result's message, so
 * every refusal a remote can give arrived in the crash tracker as "Push" /
 * "Push branch": the branch moved on the remote (reports #24, #25, #33), a
 * protected branch (#22), no credentials and no terminal to ask for them in
 * (#31, #32), a repository with no remote at all (#30). The classes now live
 * in host-bridge's gitOutcomes.ts, shared with the extension's reporter, and
 * cover the working tree too (a rebase stopped on a conflict, a name taken).
 * What the app DOES build — a refspec, a remote name, a lease — keeps
 * reporting.
 */
/** The kind of user situation `message` is (gitOutcomes.ts), or undefined. */
export function remoteOutcome(message: string): string | undefined {
  return userStateOutcome(message);
}
