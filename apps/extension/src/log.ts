// A tiny shared logger that writes to the "GitStudio" output channel.
//
// Extension `console.error` does not reliably reach a readable log in every
// host (Cursor buffers it separately), but the output channel does — the
// activation breadcrumbs ("RepoManager ready") already prove it. Route
// diagnostics here so they're actually observable from Output → GitStudio.

let sink: ((message: string) => void) | undefined;

/** Wire the real output-channel writer (called once from activate). */
export function setLogSink(fn: (message: string) => void): void {
  sink = fn;
}

/** Log a diagnostic line to the GitStudio output channel (no-op until wired). */
export function log(message: string): void {
  try {
    sink?.(message);
  } catch {
    /* logging must never throw */
  }
}
