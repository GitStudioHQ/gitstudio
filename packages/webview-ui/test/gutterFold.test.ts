import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireRow } from "@gitstudio/host-bridge/graphProtocol";
import { renderRowGutterSVG, laneCenterX } from "../src/graph/gutter";

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

test("without a cap nothing is folded — the rail and any narrow host keep the old geometry", () => {
  const svg = renderRowGutterSVG(row(24), opts(undefined), 1200);
  assert.equal(nodeXs(svg)[0], laneCenterX(24, COL, INSET), "lane 24 draws at lane 24");
});
