// Query-driven search scheduling, as a pure state machine.
//
// The command palette's existing providers fire ONCE at open. A search mode is
// different: it fires per keystroke, against a rate-limited API, and answers
// arrive out of order. Three rules, and all three are easy to get subtly wrong:
//
//   1. debounce — don't spend a request on every keystroke
//   2. minimum length — one or two characters match everything
//   3. generation tokens — a slow answer to an OLD query must be DROPPED, not
//      rendered over a newer one (the bug where results flicker back to what
//      you typed three keystrokes ago)
//
// DOM-free and clock-free (the timer is injected), so all three are testable.

export interface SearchScheduleOpts {
  /** Wait this long after the last keystroke before searching. */
  delayMs?: number;
  /** Queries shorter than this never search. */
  minChars?: number;
  /** Injected for tests; defaults to window's timers. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface SearchScheduler {
  /** A new query was typed. Returns the generation this query will run as
   *  (or undefined when it won't run: too short, or unchanged). */
  queue: (query: string) => number | undefined;
  /** True when `gen` is still the newest generation — i.e. its results are
   *  still wanted. Anything older is a stale answer and must be discarded. */
  isCurrent: (gen: number) => boolean;
  /** Cancel any pending search (palette closed, mode switched). */
  cancel: () => void;
  /** The query the latest generation was issued for. */
  lastQuery: () => string;
}

export function createSearchScheduler(
  run: (query: string, generation: number) => void,
  o: SearchScheduleOpts = {},
): SearchScheduler {
  const delay = o.delayMs ?? 300;
  const minChars = o.minChars ?? 3;
  const setT = o.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearT = o.clearTimer ?? ((id) => window.clearTimeout(id));

  let timer: number | undefined;
  let generation = 0;
  let issued = "";

  const cancel = (): void => {
    if (timer !== undefined) clearT(timer);
    timer = undefined;
  };

  return {
    queue(raw: string) {
      const query = raw.trim();
      cancel();
      // Bumping the generation on EVERY queue (even ones that won't run) is
      // deliberate: typing back down to two characters must invalidate the
      // three-character search already in flight.
      const gen = ++generation;
      if (query.length < minChars) return undefined;
      if (query === issued) return undefined;
      timer = setT(() => {
        timer = undefined;
        issued = query;
        run(query, gen);
      }, delay);
      return gen;
    },
    isCurrent: (gen: number) => gen === generation,
    cancel,
    lastQuery: () => issued,
  };
}
