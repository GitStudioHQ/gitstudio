/**
 * Logging to a terminal that is no longer there must not take the app down.
 *
 * Start GitStudio from a terminal — an AppImage on Linux usually is — and close
 * that terminal while the app keeps running. Its stdout and stderr are still
 * the hung-up terminal, and every write to it now fails with EIO. Node's
 * console swallows the first such failure and not the rest: each later
 * console.* call surfaces as an uncaught "write EIO" (checked against Electron
 * 41's own Node, on a real pseudo-terminal whose other end was closed). The
 * updater logs "Checking for update" to the console (crash report 35); and the
 * main process's own uncaught-exception handler logs with console.error, so the
 * EIO it was handed raised another EIO, which raised another — about 57,000 a
 * second, a core spun for as long as the app stayed open (crash report 36).
 *
 * So: an error on stdout or stderr means that output is gone. It is listened
 * for, so it is never uncaught, and from then on that stream's writes go
 * nowhere — including a write that would THROW the error instead (a stdout
 * that is a file is written synchronously). Nothing the app does depends on
 * its console output being read.
 */

/** The part of a writable stream this needs. */
interface OutputStream {
  write: (...args: never[]) => boolean;
  on(event: "error", listener: (err: unknown) => void): unknown;
}

const GUARDED = Symbol.for("gitstudio.quietOutput");

/** Make `stream` drop its writes, quietly, once one has failed. Idempotent. */
export function quietOnFailure(stream: OutputStream | undefined): void {
  if (!stream || (stream as unknown as Record<symbol, boolean>)[GUARDED]) return;
  (stream as unknown as Record<symbol, boolean>)[GUARDED] = true;
  let gone = false;
  stream.on("error", () => {
    gone = true;
  });
  const write = stream.write.bind(stream) as (...args: unknown[]) => boolean;
  stream.write = ((...args: unknown[]): boolean => {
    if (!gone) {
      try {
        return write(...args);
      } catch {
        gone = true;
      }
    }
    // Writes are acknowledged — with no error, as a stream that wrote does — so
    // a caller waiting on one is not left waiting.
    const done = args.find((a) => typeof a === "function") as ((err: null) => void) | undefined;
    if (done) queueMicrotask(() => done(null));
    return true;
  }) as OutputStream["write"];
}

/** The main process's stdout and stderr. Call before anything logs. */
export function quietProcessOutput(): void {
  quietOnFailure(process.stdout as unknown as OutputStream);
  quietOnFailure(process.stderr as unknown as OutputStream);
}
