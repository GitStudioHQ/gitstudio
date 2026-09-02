/**
 * The handful of user preferences a VIEW needs to honour.
 *
 * `App` owns the preferences blob and parses it into fields, which is fine for
 * the app shell — but a view module cannot reach those fields, so it passed
 * `undefined` and silently ignored the setting. That is how Settings →
 * "Prune on fetch" came to be honoured by two of the app's four fetch buttons.
 *
 * Read from the same localStorage key `App` persists to, so there is one source
 * of truth and no wiring to forget.
 */
const PREFS_KEY = "gitstudio.ui.prefs";

function read(): Record<string, unknown> {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    const v: unknown = raw ? JSON.parse(raw) : undefined;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** Fetch with `--prune`, so branches deleted on the remote drop out (issue #23).
 *  Defaults to true, matching `App`'s own default. */
export function pruneOnFetch(): boolean {
  const v = read().pruneOnFetch;
  return typeof v === "boolean" ? v : true;
}
