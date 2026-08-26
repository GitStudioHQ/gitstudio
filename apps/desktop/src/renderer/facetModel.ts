// The pure half of the facet system: what a facet IS, which items survive it,
// and which values are the server's problem rather than ours.
//
// DOM-free on purpose (like logModel.ts next to logView.ts) so the filtering
// rules unit-test under plain node. `views/common.ts` builds the buttons and
// menus on top of this and re-exports these names, so views import one place.

/** One option in a facet menu. `value` is what lands in the state. */
export interface FacetOption {
  value: string;
  label?: string;
  /** Optional leading glyph (e.g. a state icon). */
  icon?: string;
  /** A pre-built leading element — a label swatch, an avatar. Wins over `icon`,
   *  and is a FACTORY because a DOM node can only live in one menu at a time. */
  iconEl?: () => HTMLElement;
}

/**
 * One facet — a named dimension a list can be narrowed by.
 *
 * `options` is either fixed, harvested from the items on screen (so a Label
 * facet offers exactly the labels present), or loaded asynchronously
 * (workflows, which the rows don't name).
 *
 * `predicate` is what makes a facet CLIENT-side. Omit it and the facet is
 * declared server-side: its value surfaces through `serverValues()` and the
 * view passes it to the API instead of filtering on screen. That distinction
 * is the whole design — a server facet that ALSO filtered locally would
 * silently hide rows the server already excluded.
 */
export interface FacetSpec<T> {
  /** Stable key — also the state key and the API parameter name. */
  key: string;
  /** Human label, shown on the button when nothing is selected. */
  label: string;
  icon: string;
  options?: FacetOption[];
  /** Derive options from the items currently loaded. */
  harvest?: (items: T[]) => FacetOption[];
  /** Load options on first open (cached for the bar's lifetime). */
  load?: () => Promise<FacetOption[]>;
  /** Client-side test. OMIT for a server-side facet. */
  predicate?: (item: T, value: string) => boolean;
  /** Label for the "no filter" menu entry (default "Any <label>"). */
  anyLabel?: string;
}

export type FacetState = Record<string, string | undefined>;

/** True when `item` survives every ACTIVE client-side facet. Server-side
 *  facets always pass here — their filtering already happened upstream. */
export function facetPasses<T>(specs: FacetSpec<T>[], state: FacetState, item: T): boolean {
  return specs.every((spec) => {
    const v = state[spec.key];
    if (v == null || !spec.predicate) return true;
    return spec.predicate(item, v);
  });
}

/** Active values for server-side facets (those declaring no predicate). */
export function facetServerValues<T>(
  specs: FacetSpec<T>[],
  state: FacetState,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const spec of specs) {
    const v = state[spec.key];
    if (v != null && !spec.predicate) out[spec.key] = v;
  }
  return out;
}

/** How many facets are currently narrowing the list. */
export function facetActiveCount<T>(specs: FacetSpec<T>[], state: FacetState): number {
  return specs.reduce((n, s) => n + (state[s.key] != null ? 1 : 0), 0);
}

/** Distinct values off the loaded items, sorted — the usual `harvest`.
 *  Empty and nullish values are dropped: an option nothing matches is a dead
 *  row in the menu. */
export function harvestValues<T>(pick: (item: T) => string | string[] | null | undefined) {
  return (items: T[]): FacetOption[] => {
    const seen = new Set<string>();
    for (const it of items) {
      const v = pick(it);
      if (!v) continue;
      for (const one of Array.isArray(v) ? v : [v]) if (one) seen.add(one);
    }
    return [...seen].sort((a, b) => a.localeCompare(b)).map((value) => ({ value }));
  };
}
