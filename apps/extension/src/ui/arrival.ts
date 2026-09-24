// A value that arrives LATER than the call that asked for it.
//
// The Changes view renders GitStudio's dialogs. When it has never been opened
// in the window, `<viewId>.focus` returns BEFORE VS Code calls
// resolveWebviewView, so a dialog asked for right then found no view, counted
// as "dismissed", and the command went on as if the user had pressed Cancel —
// the Commit Graph's Revert over an uncommitted edit asked nothing, did
// nothing, and said nothing (crash-report fix #18, verified r0923). The asker
// now waits for the view to arrive, briefly.

export class Arrival<T> {
  private current: T | undefined;
  private readonly waiters = new Set<(value: T) => void>();

  /** The value arrived (or was replaced). Everyone waiting gets it. */
  set(value: T): void {
    this.current = value;
    for (const resolve of [...this.waiters]) resolve(value);
    this.waiters.clear();
  }

  /** `value` went away (only if it is still the current one). */
  clear(value: T): void {
    if (this.current === value) this.current = undefined;
  }

  get(): T | undefined {
    return this.current;
  }

  /** The value now, else as soon as it arrives, else undefined after `ms`. */
  wait(ms: number): Promise<T | undefined> {
    if (this.current !== undefined) return Promise.resolve(this.current);
    return new Promise((resolve) => {
      const done = (value: T | undefined): void => {
        clearTimeout(timer);
        this.waiters.delete(done as (value: T) => void);
        resolve(value);
      };
      const timer = setTimeout(() => done(undefined), ms);
      this.waiters.add(done as (value: T) => void);
    });
  }
}
