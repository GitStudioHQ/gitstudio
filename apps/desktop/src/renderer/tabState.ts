// Module state that belongs to ONE repository tab (issue #32).
//
// The section views keep what they remember — a search, a state segment, a
// sort, facet ticks, the open sub-tab, the live diff — at module scope, so it
// outlives a list ⇄ detail round trip. With one window that was one window's
// state. With tabs, every tab keeps its OWN kept-alive page of the same view,
// and a module-level `let` is shared by all of them: the last tab to mount a
// section left its query, its GitHub search hits (another repository's
// issues) and its router behind for the next click in any other tab's page —
// whose search box still showed its own words.
//
// `perTab(init)` hands each tab its own copy, keyed by the repository the tab
// is for (the cache scope — one tab per repository, "" for the window with
// none open). A view reads it where it is BUILT and keeps the object in the
// closures that need it, so a late timer or observer can never write into the
// tab that happens to be in front; a helper that runs only from a click in the
// tab in front may read it afresh. A closed tab's copies go with it
// (`dropTabState`), so reopening the repository starts clean, as a new tab.

import { cacheScope } from "./cache";

const registry = new Set<Map<string, unknown>>();

/** A getter for this module's state in the tab in front, made on first use. */
export function perTab<T>(init: () => T): () => T {
  const byTab = new Map<string, T>();
  registry.add(byTab as Map<string, unknown>);
  return () => {
    const key = cacheScope();
    let s = byTab.get(key);
    if (s === undefined) {
      s = init();
      byTab.set(key, s);
    }
    return s;
  };
}

/** A tab closed: every module forgets what it kept for that repository. */
export function dropTabState(root: string): void {
  for (const m of registry) m.delete(root);
}
