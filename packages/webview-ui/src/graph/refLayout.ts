import type { WireRef } from "@gitstudio/host-bridge/graphProtocol";
import { refLabel } from "@gitstudio/host-bridge/graphRefFilter";

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
  /** What the chip SAYS: its full name shorn of the namespace ("release"),
   *  never git's disambiguated short form ("heads/release"). */
  label: string;
  /** Remote names ("origin") whose same-named branch was merged into this chip. */
  remotes: string[];
  /** Those remote twins' FULL names ("refs/remotes/origin/release") — what
   *  the chip's menu moves along with it (chipRefs). */
  twins: string[];
}

/** Smallest cap a single ref chip is ever held to, however narrow the track. */
export const CHIP_BASE_CAP = 132;
/** Must equal `.refs { gap }`. */
export const REF_CHIP_GAP = 6;
/** Must equal `.refs` horizontal padding (6px left + 12px right). */
export const REFS_PADDING = 18;
/** Width the fold reserves for a "+N" pill before it stops adding chips. */
export const OVERFLOW_PILL_WIDTH = 40;

/** A chip's label: the ref's full name shorn of its namespace (refLabel). A
 *  ref from a host that sent no full name keeps the name it was given. */
export function chipLabel(ref: Pick<WireRef, "name" | "fullName">): string {
  return ref.fullName ? refLabel(ref.fullName) : ref.name;
}

/**
 * Fold remote-tracking twins into their same-named local chip — GitKraken
 * style, so the common local+remote row is one chip and not two.
 *
 * By FULL name (issue #30's follow-up): refs/remotes/<remote>/<branch> folds
 * into refs/heads/<branch>. It used to split the SHORT names, and beside a tag
 * of the same name the branch's short name is "heads/release" — so its twin
 * was sought as "origin/heads/release", never found, and the row drew two
 * chips where it meant one. The remote is the first segment after
 * refs/remotes/ (a branch may contain slashes; a remote rarely does).
 */
export function foldRefs(refs: WireRef[]): ChipEntry[] {
  const locals = new Map<string, ChipEntry>();
  const entry = (ref: WireRef): ChipEntry => ({ ref, label: chipLabel(ref), remotes: [], twins: [] });
  for (const ref of refs) {
    if ((ref.kind === "head" || ref.kind === "currentHead") && ref.fullName?.startsWith("refs/heads/")) {
      locals.set(ref.fullName.slice("refs/heads/".length), entry(ref));
    }
  }
  const entries: ChipEntry[] = [];
  for (const ref of refs) {
    if (ref.kind === "remoteHead") {
      const rest = ref.fullName?.startsWith("refs/remotes/") ? ref.fullName.slice("refs/remotes/".length) : "";
      const slash = rest.indexOf("/");
      const local = slash > 0 ? locals.get(rest.slice(slash + 1)) : undefined;
      if (local) {
        local.remotes.push(rest.slice(0, slash));
        local.twins.push(ref.fullName);
        continue;
      }
      entries.push(entry(ref));
    } else if (ref.kind === "head" || ref.kind === "currentHead") {
      const key = ref.fullName?.startsWith("refs/heads/") ? ref.fullName.slice("refs/heads/".length) : undefined;
      entries.push((key !== undefined && locals.get(key)) || entry(ref));
    } else {
      entries.push(entry(ref));
    }
  }
  return entries;
}

/** Estimated rendered width of one chip, held to `cap`. */
export function estimateChipWidth(entry: ChipEntry, cap = CHIP_BASE_CAP): number {
  const w = 16 + 14 + entry.label.length * 6.1 + (entry.remotes.length ? 14 : 0);
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
/**
 * The narrowest track that can still show a NAME rather than just chrome.
 *
 * `min` (60) is the track's structural floor and is load-bearing elsewhere: a
 * repo with no refs anywhere asks for exactly `min` so the whole width goes to
 * the subject instead of reserving an empty column, and the manual drag clamps
 * to it. But 60px is less than one chip's own furniture — REFS_PADDING (18)
 * leaves 42, while estimateChipWidth's own floor is 44 — so a track at `min`
 * mathematically cannot fit a chip, and the "first chip always draws" guard
 * rendered a bare icon with a zero-width name beside it.
 *
 * This floor applies only when the rows actually WANT refs, so the empty-column
 * case keeps collapsing to `min`.
 */
/** Chip width past which the legibility floor stops growing: a 40-character
 *  branch name must not be allowed to demand half the window. */
const LEGIBLE_CHIP_CAP = 150;

/**
 * The narrowest track in which the busiest row still shows ONE readable chip.
 *
 * Derived from the same estimator that computes `wanted`, rather than guessed:
 * a chip is 16px of icon + 14px of gap + the name + an optional 14px remote
 * tail, and the track adds REFS_PADDING around it. A floor short of that draws
 * the chip's furniture and none of its name.
 */
export function legibleRefsWidth(rows: readonly { refs?: WireRef[] }[]): number {
  let widest = 0;
  for (const row of rows) {
    if (!row.refs?.length) continue;
    for (const entry of foldRefs(row.refs)) {
      widest = Math.max(widest, estimateChipWidth(entry, LEGIBLE_CHIP_CAP));
    }
  }
  return widest === 0 ? 0 : REFS_PADDING + widest;
}

export function fitRefsWidth(opts: {
  wanted: number;
  host: number;
  nonRefs: number;
  comfort: number;
  min: number;
  max: number;
  /** How far the subject may be squeezed before refs stop yielding to it. */
  subjectFloor?: number;
  /** The width at which one ref name is still readable — see legibleRefsWidth. */
  legible?: number;
}): number {
  const { wanted, host, nonRefs, comfort, min, max, subjectFloor, legible = 0 } = opts;
  if (host <= 0) return Math.min(max, Math.max(min, wanted));
  // Two budgets: `comfort` is what the subject would LIKE, `hard` is what it
  // actually needs. Refs yield to comfort first — that is the whole point of
  // the clamp — but never past the point where they can show a name, because a
  // column of names showing no names is not a smaller column, it is an empty
  // one. Between roughly 1300 and 1550px this pinned the track to 60px and
  // rendered zero readable characters, and widening the window made it
  // NARROWER, so the app looked broken precisely when maximised on a laptop.
  const comfortable = host - nonRefs - comfort;
  const hard = subjectFloor === undefined ? comfortable : host - nonRefs - subjectFloor;
  const spare = Math.max(comfortable, Math.min(hard, legible));
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
