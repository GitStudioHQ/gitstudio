// Where the merge view's Result STARTS (POLISH A1.2): from base, as always —
// unless the file on disk already holds a resolution the conflict does not.
//
// The Result was always seeded from base, so opening the merge editor on a
// file resolved by hand (or by git rerere: no markers left) showed the
// conflict from the start, and "Apply with N unresolved" wrote base over the
// resolution. Now the file's own text seeds the Result there, and every change
// stays PENDING — marked, with its controls — holding what the file had, the
// way a change edited by hand in the Result is: accept a side and it replaces
// that text; Apply as it is and the file keeps it.
//
// Two kinds, from the engine's seedFromWorking:
// - "working": no markers are left: the whole Result is the file, and each
//   change is placed in it by a line diff against base;
// - "markers" with kept regions: markers remain, but some regions were
//   settled OUTSIDE them (by hand, or by git's own merge where the engine
//   sees a conflict): those regions hold the file's lines, the rest is base.
//
// Pure: no Monaco, no DOM (unit-tested under node).

import { diffSide, normalizeEol, splitLines } from "@gitstudio/engine/lineDiff";
import { seedFromWorking, type PreparedMerge } from "@gitstudio/engine/conflict/documentText";
import type { LineSpan, MergeModel } from "@gitstudio/engine/types";

/** A region of the Result seeded from the file: base lines [baseFrom, baseTo) (0-based) became `lines`. */
export interface SeedRegion {
  blockIds: number[];
  baseFrom: number;
  baseTo: number;
  lines: string[];
}

export interface ResultSeed {
  kind: "working" | "markers";
  /** The Result's text ("\n" breaks). */
  text: string;
  /** Every block's span in that text (1-based, end-exclusive). */
  spans: Map<number, LineSpan>;
  /** The regions that hold the file's text rather than base. */
  regions: SeedRegion[];
  /** How many changes those regions hold. */
  changes: number;
}

/** The view's own model and lines, in the shape the engine's seed reads. */
export function preparedFrom(model: MergeModel, base: string, ours: string, theirs: string): PreparedMerge {
  return {
    model,
    base: splitLines(base),
    ours: splitLines(ours),
    theirs: splitLines(theirs),
    baseEmpty: base === "",
    oursEmpty: ours === "",
    theirsEmpty: theirs === "",
  };
}

/**
 * The seed for a Result, or undefined to start from base as usual: the file
 * adds nothing (it is base, or empty), holds only what git's markers hold, or
 * cannot be read against the merge.
 */
export function seedResult(prepared: PreparedMerge, working: string): ResultSeed | undefined {
  const seed = seedFromWorking(prepared, working);
  const blocks = [...prepared.model.blocks].sort(
    (a, b) => a.baseSpan.start - b.baseSpan.start || a.baseSpan.endExclusive - b.baseSpan.endExclusive,
  );
  if (seed.kind === "working") {
    const doc = splitLines(normalizeEol(seed.text));
    const spans = placeBlocks(prepared.base, doc, blocks.map((b) => ({ id: b.id, span: b.baseSpan })), prepared.baseEmpty);
    const regions: SeedRegion[] = [];
    for (const b of blocks) {
      regions.push({
        blockIds: [b.id],
        baseFrom: b.baseSpan.start - 1,
        baseTo: b.baseSpan.endExclusive - 1,
        lines: linesOf(doc, spans.get(b.id)!),
      });
    }
    return { kind: "working", text: doc.join("\n"), spans, regions, changes: blocks.length };
  }
  if (seed.kind !== "markers" || seed.keep.length === 0) {
    return undefined;
  }
  // Base, with each kept region's base lines replaced by the file's.
  const keep = [...seed.keep]
    .map((k) => ({ ...k, from: k.baseSpan.start - 1, to: k.baseSpan.endExclusive - 1 }))
    .sort((a, b) => a.from - b.from);
  const out: string[] = [];
  const spans = new Map<number, LineSpan>();
  const regions: SeedRegion[] = [];
  const inRegion = new Map<number, (typeof keep)[number]>();
  for (const k of keep) for (const id of k.blockIds) inRegion.set(id, k);
  let at = 0; // next base line (0-based) not yet copied
  let shift = 0; // Result line − base line, above the current point
  let ki = 0;
  for (const b of blocks) {
    // Copy through every kept region that starts before this block.
    while (ki < keep.length && keep[ki].from <= b.baseSpan.start - 1 && inRegion.get(b.id) !== keep[ki]) {
      const k = keep[ki++];
      out.push(...prepared.base.slice(at, k.from), ...k.lines);
      shift += k.lines.length - (k.to - k.from);
      at = k.to;
    }
    const k = inRegion.get(b.id);
    if (k) {
      if (keep[ki] === k) {
        // The region's first block: it takes the region.
        out.push(...prepared.base.slice(at, k.from));
        const start = out.length + 1;
        out.push(...k.lines);
        spans.set(b.id, { start, endExclusive: start + k.lines.length });
        shift += k.lines.length - (k.to - k.from);
        at = k.to;
        ki++;
        regions.push({ blockIds: [...k.blockIds], baseFrom: k.from, baseTo: k.to, lines: [...k.lines] });
      } else {
        // A later block of the same region: a point at its end.
        const end = spans.get(k.blockIds.find((id) => spans.has(id))!)!.endExclusive;
        spans.set(b.id, { start: end, endExclusive: end });
      }
      continue;
    }
    spans.set(b.id, { start: b.baseSpan.start + shift, endExclusive: b.baseSpan.endExclusive + shift });
  }
  while (ki < keep.length) {
    const k = keep[ki++];
    out.push(...prepared.base.slice(at, k.from), ...k.lines);
    at = k.to;
  }
  out.push(...prepared.base.slice(at));
  const changes = keep.reduce((n, k) => n + k.blockIds.length, 0);
  return { kind: "markers", text: out.join("\n"), spans, regions, changes };
}

function linesOf(doc: readonly string[], span: LineSpan): string[] {
  return doc.slice(span.start - 1, span.endExclusive - 1);
}

/**
 * Each block's span in `doc`, a text derived from base by edits a line diff
 * finds. Base lines the diff keeps map one to one; a block takes everything
 * between the kept lines around it — lines inserted right at its edges
 * included — and never overlaps the block before it.
 */
export function placeBlocks(
  base: readonly string[],
  doc: readonly string[],
  blocks: ReadonlyArray<{ id: number; span: LineSpan }>,
  baseEmpty = false,
): Map<number, LineSpan> {
  const out = new Map<number, LineSpan>();
  const baseLines = baseEmpty ? [] : [...base];
  // An empty document has no lines at all.
  const docLines = doc.length === 1 && doc[0] === "" ? [] : [...doc];
  const changes =
    baseLines.length === 0 || docLines.length === 0
      ? [
          {
            baseSpan: { start: 1, endExclusive: baseLines.length + 1 },
            sideSpan: { start: 1, endExclusive: docLines.length + 1 },
          },
        ]
      : diffSide(baseLines, docLines, "left").map((c) => ({ baseSpan: c.baseSpan, sideSpan: c.sideSpan }));
  /**
   * The doc boundary for base boundary b (1-based: the point before base
   * line b). A block's start takes the point BEFORE lines inserted at it, its
   * end the point AFTER them; inside a change, the change's own edges.
   */
  const map = (b: number, edge: "start" | "end"): number => {
    let delta = 0;
    for (const c of changes) {
      const { start: bs, endExclusive: be } = c.baseSpan;
      const { start: ss, endExclusive: se } = c.sideSpan;
      if (be < b) {
        delta = se - be;
        continue;
      }
      if (bs > b) break;
      // The change touches b: bs <= b <= be.
      if (bs === be) return edge === "start" ? ss : se; // lines inserted at b
      if (b === bs) return ss; // a change starts here
      if (b === be) return se; // a change ends here
      return edge === "start" ? ss : se; // inside a change
    }
    return b + delta;
  };
  let prevEnd = 1;
  for (const { id, span } of [...blocks].sort((a, b) => a.span.start - b.span.start || a.span.endExclusive - b.span.endExclusive)) {
    const start = Math.max(prevEnd, Math.min(map(span.start, "start"), docLines.length + 1));
    const end = Math.max(start, Math.min(map(span.endExclusive, "end"), docLines.length + 1));
    out.set(id, { start, endExclusive: end });
    prevEnd = end;
  }
  return out;
}
