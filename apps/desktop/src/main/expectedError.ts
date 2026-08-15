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
