// Unsent text, kept.
//
// Every composer in the app threw away what you had typed if you pressed
// Escape: the release form, the issue form, the issue body edit. No warning, no
// undo, and Escape is the key people press to dismiss a menu they opened by
// accident — so the gesture that loses a paragraph of release notes is the same
// gesture that means "never mind" everywhere else.
//
// A confirm dialog is the obvious answer and the wrong one: it makes leaving
// expensive rather than making the text safe, and it still loses everything if
// the window closes, the app updates, or the view is routed away by a
// background refresh. Keeping the draft is the fix; a confirm is at best a
// second line.
//
// Keyed by REPO as well as by item, because issue #31 in one repository is not
// issue #31 in another — the app has already shipped that exact bug once, with
// comment drafts keyed by number alone being handed to the wrong repository's
// issue, pre-filled and ready to send to strangers.

import { cacheScope } from "./cache";

const PREFIX = "gitstudio.draft.";
/** Drop anything untouched for this long, so the store cannot grow forever. */
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

interface Stored {
  text: string;
  at: number;
}

/**
 * A draft's identity. `kind` names the surface ("release", "issue", "comment"),
 * `id` the thing being edited — a number, a tag, or "new".
 */
export function draftKey(kind: string, id: string | number): string {
  return `${PREFIX}${cacheScope()}|${kind}|${id}`;
}

function read(key: string): Stored | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const v = JSON.parse(raw) as Stored;
    return typeof v?.text === "string" ? v : undefined;
  } catch {
    // A private window, cleared site data, a browser refusing storage. A draft
    // that cannot be read is not an error worth surfacing — the field simply
    // starts empty, which is what would have happened anyway.
    return undefined;
  }
}

/** The saved text for this draft, or undefined. */
export function loadDraft(kind: string, id: string | number): string | undefined {
  const v = read(draftKey(kind, id));
  if (!v) return undefined;
  if (Date.now() - v.at > MAX_AGE_MS) {
    clearDraft(kind, id);
    return undefined;
  }
  return v.text || undefined;
}

/**
 * Save, debounced by the caller's typing. Empty text CLEARS rather than storing
 * an empty draft: otherwise deleting your text and leaving would restore an
 * empty box over whatever the server actually has, which reads as data loss the
 * next time the form opens.
 */
export function saveDraft(kind: string, id: string | number, text: string): void {
  const key = draftKey(kind, id);
  try {
    if (!text.trim()) {
      localStorage.removeItem(key);
      return;
    }
    localStorage.setItem(key, JSON.stringify({ text, at: Date.now() } satisfies Stored));
  } catch {
    /* storage full or refused — the draft is a convenience, never a promise */
  }
}

export function clearDraft(kind: string, id: string | number): void {
  try {
    localStorage.removeItem(draftKey(kind, id));
  } catch {
    /* nothing to do */
  }
}

/**
 * Wire a draft to an editor: restore on open, save as you type, clear on a
 * successful submit. Returns the restored text so the caller can decide whether
 * to prefer it over the server's value.
 *
 * The debounce is deliberate rather than a write per keystroke — `localStorage`
 * is synchronous and on the main thread, and a 400ms window costs at most a few
 * words if the app dies outright.
 */
export function wireDraft(
  kind: string,
  id: string | number,
  onRestore: (text: string) => void,
): { save: (text: string) => void; clear: () => void; restored: boolean } {
  const existing = loadDraft(kind, id);
  if (existing) onRestore(existing);
  let timer: number | undefined;
  return {
    save: (text: string) => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => saveDraft(kind, id, text), 400);
    },
    clear: () => {
      window.clearTimeout(timer);
      clearDraft(kind, id);
    },
    restored: existing !== undefined,
  };
}

/** Housekeeping: forget drafts nobody came back to. Called once at startup. */
export function pruneDrafts(): void {
  try {
    const dead: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIX)) continue;
      const v = read(k);
      if (!v || Date.now() - v.at > MAX_AGE_MS) dead.push(k);
    }
    for (const k of dead) localStorage.removeItem(k);
  } catch {
    /* storage unavailable */
  }
}
