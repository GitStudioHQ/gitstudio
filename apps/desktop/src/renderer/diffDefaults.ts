// Where every comparison in the app starts: whitespace, and whether changed
// words inside a line are marked (Settings ▸ Code and comparisons). The same
// two choices the extension has as `gitstudio.diff.whitespace` / `.highlight`
// (#146). A comparison's own controls — the whitespace button in Changes —
// still change it for the file on screen.
//
// The desktop's comparisons offer two whitespace modes, not the extension's
// three: the inline view is Monaco's diff editor, whose only whitespace option
// is ignoreTrimWhitespace, and both views must agree on what counts as a change.

export type DiffWhitespace = "none" | "trailing";

export interface DiffDefaults {
  whitespace: DiffWhitespace;
  /** Mark the changed words inside a line (false: whole lines only). */
  showInner: boolean;
}

/** Fired on `window` after the defaults change, so open comparisons follow. */
export const DIFF_DEFAULTS_CHANGED = "gs:diff-defaults-changed";

const KEY = "gitstudio.diffDefaults";

/** Best-effort: storage can be unavailable, and then these are the defaults. */
export function diffDefaults(): DiffDefaults {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || "{}") as Partial<DiffDefaults>;
    return { whitespace: v.whitespace === "trailing" ? "trailing" : "none", showInner: v.showInner !== false };
  } catch {
    return { whitespace: "none", showInner: true };
  }
}

export function setDiffDefaults(patch: Partial<DiffDefaults>): DiffDefaults {
  const next = { ...diffDefaults(), ...patch };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage may be unavailable; the choice then lasts this session's panels */
  }
  window.dispatchEvent(new Event(DIFF_DEFAULTS_CHANGED));
  return next;
}
