import type { WireRef } from "@gitstudio/host-bridge/graphProtocol";

/**
 * How the Branch/Tag column decides what to draw and how wide to be.
 *
 * Kept apart from commit-graph.ts because all of it is arithmetic over data —
 * no Lit, no DOM — and because the renderer and the column's auto-fit MUST
 * agree. When they were two separate code paths the track could be "wide
 * enough" by one calculation and still fold chips by the other.
 */

export interface ChipEntry {
  ref: WireRef;
  /** Remote names ("origin") whose same-named branch was merged into this chip. */
  remotes: string[];
}

/** Smallest cap a single ref chip is ever held to, however narrow the track. */
export const CHIP_BASE_CAP = 132;
/** Must equal `.refs { gap }`. */
export const REF_CHIP_GAP = 6;
/** Must equal `.refs` horizontal padding (6px left + 12px right). */
export const REFS_PADDING = 18;
/** Width the fold reserves for a "+N" pill before it stops adding chips. */
export const OVERFLOW_PILL_WIDTH = 40;

/**
 * Fold remote-tracking twins into their same-named local chip — GitKraken
 * style, so the common local+remote row is one chip and not two.
 */
export function foldRefs(refs: WireRef[]): ChipEntry[] {
  const locals = new Map<string, ChipEntry>();
  for (const ref of refs) {
    if (ref.kind === "head" || ref.kind === "currentHead") {
      locals.set(ref.name, { ref, remotes: [] });
    }
  }
  const entries: ChipEntry[] = [];
  for (const ref of refs) {
    if (ref.kind === "remoteHead") {
      const slash = ref.name.indexOf("/");
      const local = slash > 0 ? locals.get(ref.name.slice(slash + 1)) : undefined;
      if (local) {
        local.remotes.push(ref.name.slice(0, slash));
        continue;
      }
      entries.push({ ref, remotes: [] });
    } else if (ref.kind === "head" || ref.kind === "currentHead") {
      entries.push(locals.get(ref.name)!);
    } else {
      entries.push({ ref, remotes: [] });
    }
  }
  return entries;
}

/** Estimated rendered width of one chip, held to `cap`. */
export function estimateChipWidth(entry: ChipEntry, cap = CHIP_BASE_CAP): number {
  const w = 16 + 14 + entry.ref.name.length * 6.1 + (entry.remotes.length ? 14 : 0);
  return Math.max(44, Math.min(cap, Math.ceil(w)));
}

/**
 * How wide a single chip may grow in a track of `colW`.
 *
 * Mirrors the CSS `.chip { max-width }` exactly. The two MUST agree: the fold
 * decides how many chips fit using this number, and the CSS decides where the
 * ellipsis lands. A fixed cap here was the same trap as the old count cap
 * (issue #11) — "origin/feat/diff-tick-staging" needs ~185px, so it ellipsized
 * at EVERY column width and dragging the column wider silently did nothing.
 */
export function chipCap(colW: number): number {
  return Math.max(CHIP_BASE_CAP, colW - 22);
}

export interface RefFit {
  /** How many chips to draw, in order. */
  shown: number;
  /** The rest, which the "+N" pill stands for. Never silently dropped. */
  overflow: ChipEntry[];
  /** The cap to apply to each drawn chip. */
  cap: number;
}

/**
 * Which chips fit in a track of `colW`.
 *
 * Width is the ONLY thing that decides — no count cap, deliberately, so that
 * dragging the column wider always reveals more (issue #11). The first chip
 * always draws; CSS min-width plus ellipsis keep it legible even in a very
 * narrow column.
 */
export function fitRefs(entries: ChipEntry[], colW: number): RefFit {
  const cap = chipCap(colW);
  const budget = colW - REFS_PADDING;
  let used = 0;
  let shown = 0;
  for (const entry of entries) {
    const w = estimateChipWidth(entry, cap);
    const reserve = entries.length - shown - 1 > 0 ? OVERFLOW_PILL_WIDTH : 0;
    if (shown > 0 && used + w + reserve > budget) break;
    used += w + REF_CHIP_GAP;
    shown++;
  }
  return { shown, overflow: entries.slice(shown), cap };
}

/**
 * The auto-fit width for the Branch/Tag track.
 *
 * `wanted` is what the busiest loaded row needs; the result is what it may
 * actually have. Refs are content rather than metadata, so they get measured
 * first — but only out of what is genuinely spare, which is whatever remains
 * once the commit message has a COMFORTABLE width. Without that clamp the track
 * kept its full content fit as the window narrowed, reserving ~230px that most
 * rows leave blank while every commit message ellipsized.
 *
 * A `host` of 0 (not laid out yet) means there is no budget to reason about, so
 * the content fit stands until a real measurement arrives.
 */
export function fitRefsWidth(opts: {
  wanted: number;
  host: number;
  nonRefs: number;
  comfort: number;
  min: number;
  max: number;
}): number {
  const { wanted, host, nonRefs, comfort, min, max } = opts;
  const spare = host > 0 ? host - nonRefs - comfort : wanted;
  return Math.min(max, Math.max(min, Math.min(wanted, spare)));
}

/** The content width the busiest row among `rows` would like for its refs. */
export function wantedRefsWidth(
  rows: readonly { refs?: WireRef[] }[],
  max: number,
  min: number,
): number {
  const cap = chipCap(max);
  let widest = 0;
  for (const row of rows) {
    const refs = row.refs;
    if (!refs || refs.length === 0) continue;
    let w = 0;
    for (const entry of foldRefs(refs)) {
      w += estimateChipWidth(entry, cap) + REF_CHIP_GAP;
    }
    if (w > widest) widest = w;
  }
  // No refs anywhere: give the whole track to the subject rather than reserving
  // an empty column.
  return widest === 0 ? min : Math.ceil(widest) + REFS_PADDING;
}
