import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireRow } from "@gitstudio/host-bridge/graphProtocol";
import { renderRowGutterSVG, laneCenterX, lastDrawableLane } from "../src/graph/gutter";

/**
 * `.gutter` hides its overflow and the SVG is sized to the (capped) gutter
 * width, while lane x came straight from the row's column with no bound. So a
 * commit on lane 17 of a busy repo drew its node past the right edge and was
 * CLIPPED AWAY: the row rendered its subject, author and date with nothing at
 * all in the graph beside it — which reads as "this commit is not in the
 * history", the one thing a commit graph exists to answer.
 *
 * Deep lanes now fold onto the last one that fits, marked with an outward
 * chevron so a folded lane is never mistaken for a real one.
 */
const COL = 26;
const INSET = 16;
const R = 5;

function row(column: number, over: Partial<WireRow> = {}): WireRow {
  return {
    sha: "a".repeat(40),
    column,
    color: 1,
    isMerge: false,
    refs: [],
    segments: [],
    subject: "s",
    author: "a",
    authorEmail: "a@b",
    ...over,
  } as WireRow;
}

const opts = (maxColumn?: number): Parameters<typeof renderRowGutterSVG>[1] => ({
  colWidth: COL,
  rowHeight: 28,
  nodeRadius: R,
  nodeInset: INSET,
  palette: ["#111", "#222", "#333"],
  maxColumn,
});

/** Every `cx="…"` the markup draws a circle at. */
function nodeXs(svg: string): number[] {
  return [...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1]));
}

test("a lane deeper than the gutter still gets a node, inside the canvas", () => {
  const width = 458; // the 16-column cap
  const svg = renderRowGutterSVG(row(24), opts(15), width);
  const xs = nodeXs(svg);
  assert.ok(xs.length > 0, "the commit has a node at all");
  for (const x of xs) {
    assert.ok(x + R <= width, `the node is inside the ${width}px canvas (drawn at ${x})`);
  }
  assert.equal(xs[0], laneCenterX(15, COL, INSET), "folded onto the last lane that fits");
});

test("a folded node is marked as folded, and an ordinary one is not", () => {
  const deep = renderRowGutterSVG(row(24), opts(15), 458);
  const near = renderRowGutterSVG(row(3), opts(15), 458);
  assert.match(deep, /<path d="M[\d.]+ [\d.]+l3\.2/, "the deep lane carries the beyond-marker");
  assert.ok(
    !/l3\.2 3\.5/.test(near),
    "a lane that genuinely fits carries no marker — the marker means 'stacked', " +
      "so putting it on a real lane would be a lie in the other direction",
  );
});

test("segments into and out of a folded lane are folded with it", () => {
  const svg = renderRowGutterSVG(
    row(20, { segments: [{ fromColumn: 20, toColumn: 22, color: 1 }] }),
    opts(15),
    458,
  );
  const maxX = Math.max(
    ...[...svg.matchAll(/[ML]([\d.]+) /g)].map((m) => Number(m[1])),
    ...[...svg.matchAll(/C([\d.]+) [\d.]+ ([\d.]+) /g)].flatMap((m) => [
      Number(m[1]),
      Number(m[2]),
    ]),
  );
  assert.ok(maxX <= 458, `no path control point escapes the canvas (max x ${maxX})`);
});

/**
 * The fold marker must be INSIDE the canvas at every gutter width.
 *
 * The first version reserved only the node's radius when picking the last
 * drawable lane, so the chevron was clipped away at roughly one width in four —
 * and a folded node with no marker is indistinguishable from a real lane, which
 * is worse than the clipping the fold exists to prevent. Measured before the
 * fix: 26 of 112 sampled widths overflowed, by up to 5.2px.
 */
test("the fold marker is inside the canvas at every gutter width", () => {
  // The REAL function the graph uses — not a copy of its arithmetic here. The
  // first version of this test reimplemented the walk, so it passed happily
  // while the production reach was wrong: it was checking itself.
  const lastLane = (width: number): number => lastDrawableLane(width, COL, INSET, R);

  const overflows: string[] = [];
  for (let width = 100; width <= 1400; width++) {
    const cap = lastLane(width);
    const svg = renderRowGutterSVG(row(cap + 9), opts(cap), width);
    // Every x the markup draws at — circles and path coordinates alike.
    const xs = [
      ...[...svg.matchAll(/<circle cx="([\d.]+)"/g)].map((m) => Number(m[1])),
      ...[...svg.matchAll(/[ML]([\d.]+) /g)].map((m) => Number(m[1])),
    ];
    // The chevron is relative (`l3.2 3.5`), so account for its full extent.
    const right = Math.max(...xs) + 3.2 + 0.8;
    if (right > width) overflows.push(`w=${width} lane=${cap} right=${right.toFixed(1)}`);
  }
  assert.deepEqual(overflows.slice(0, 5), [], `${overflows.length} width(s) overflow`);
});

test("without a cap nothing is folded — the rail and any narrow host keep the old geometry", () => {
  const svg = renderRowGutterSVG(row(24), opts(undefined), 1200);
  assert.equal(nodeXs(svg)[0], laneCenterX(24, COL, INSET), "lane 24 draws at lane 24");
});
