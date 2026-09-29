import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireRow } from "@gitstudio/host-bridge/graphProtocol";
import { lastDrawableLane, laneCenterX, renderRowGutterSVG, segmentPath } from "../src/graph/gutter";

// One row of the commit graph as SVG path data: straight lanes, the S-curves
// between lanes, edges routed THROUGH the node, merges drawn as rings, and the
// focus dimming. Geometry pinned as numbers, since a half-pixel drift is the
// bug this renderer keeps having.

const COL = 20;
const H = 24;

function row(over: Partial<WireRow> = {}): WireRow {
  return {
    sha: "a".repeat(40),
    shortSha: "aaaaaaa",
    column: 0,
    color: 0,
    isMerge: false,
    refs: [],
    segments: [],
    subject: "s",
    author: "a",
    authorEmail: "a@b",
    authorDate: 0,
    ...over,
  };
}

const opts = (over: Partial<Parameters<typeof renderRowGutterSVG>[1]> = {}): Parameters<typeof renderRowGutterSVG>[1] => ({
  colWidth: COL,
  rowHeight: H,
  nodeRadius: 4,
  palette: ["#a00", "#0b0", "#00c"],
  ...over,
});

test("a lane that stays put is one straight vertical across the row", () => {
  assert.equal(segmentPath({ fromColumn: 1, toColumn: 1, color: 0 }, COL, H), "M30.5 0V24");
  assert.equal(segmentPath({ fromColumn: 1, toColumn: 1, color: 0 }, COL, H, 6), "M36.5 0V24", "the inset shifts every lane");
});

test("a lane shift is a full-height S with vertical tangents at both edges", () => {
  assert.equal(segmentPath({ fromColumn: 0, toColumn: 2, color: 0 }, COL, H), "M10.5 0C10.5 12 50.5 12 50.5 24");
});

test("curveSpan confines the bend to the middle, with straight lead-in and lead-out", () => {
  assert.equal(
    segmentPath({ fromColumn: 0, toColumn: 1, color: 0 }, COL, 40, 0, 16),
    "M10.5 0V12C10.5 20 30.5 20 30.5 28V40",
  );
  assert.equal(
    segmentPath({ fromColumn: 0, toColumn: 1, color: 0 }, COL, 40, 0, 40),
    "M10.5 0C10.5 20 30.5 20 30.5 40",
    "a span as tall as the row is the ordinary full sweep",
  );
});

test("an edge leaving the node drops to the node first, then peels out to its lane", () => {
  assert.equal(
    segmentPath({ fromColumn: 1, toColumn: 3, color: 0 }, COL, H, 0, undefined, 1),
    "M30.5 0V12C30.5 18 70.5 18 70.5 24",
  );
});

test("an edge merging into the node curves in and stops AT the node", () => {
  assert.equal(
    segmentPath({ fromColumn: 3, toColumn: 1, color: 0 }, COL, H, 0, 8, 1),
    "M70.5 0C70.5 6 30.5 6 30.5 12",
    "the node routing wins over curveSpan",
  );
});

test("a diagonal that does not touch the node is not routed through it", () => {
  assert.equal(
    segmentPath({ fromColumn: 2, toColumn: 3, color: 0 }, COL, H, 0, undefined, 0),
    "M50.5 0C50.5 12 70.5 12 70.5 24",
  );
});

test("an ordinary commit is a filled dot over a hole-coloured halo, in its lane colour", () => {
  const svg = renderRowGutterSVG(row({ column: 1, color: 2 }), opts(), 60);
  assert.ok(svg.startsWith('<svg class="gs-gutter-svg" width="60" height="24" viewBox="0 0 60 24" preserveAspectRatio="none" aria-hidden="true">'));
  assert.match(svg, /<circle cx="30.5" cy="12.5" r="5.6" fill="var\(--gs-graph-node-hole\)"\/>/);
  assert.match(svg, /<circle cx="30.5" cy="12.5" r="4" fill="#00c"\/>/);
  assert.doesNotMatch(svg, /stroke-width="2.4"/, "not a ring");
});

test("a merge is a hollow ring stroked in the lane colour, larger than a dot", () => {
  const svg = renderRowGutterSVG(row({ column: 0, color: 1, isMerge: true }), opts(), 40);
  assert.match(svg, /<circle cx="10.5" cy="12.5" r="6" fill="var\(--gs-graph-node-hole\)"\/>/);
  assert.match(svg, /<circle cx="10.5" cy="12.5" r="4.7" fill="var\(--gs-graph-node-hole\)" stroke="#0b0" stroke-width="2.4"\/>/);
  assert.doesNotMatch(svg, /fill="#0b0"/, "the ring is hollow");
});

test("diagonals are drawn before verticals, so a through-lane reads continuous over a curve", () => {
  const svg = renderRowGutterSVG(
    row({
      column: 0,
      segments: [
        { fromColumn: 0, toColumn: 0, color: 0 },
        { fromColumn: 0, toColumn: 1, color: 1 },
      ],
    }),
    opts({ strokeWidth: 3 }),
    60,
  );
  const paths = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="([^"]+)" stroke-width="3"/g)].map((m) => [m[1], m[2]]);
  assert.deepEqual(paths, [
    ["M10.5 0V12C10.5 18 30.5 18 30.5 24", "#0b0"],
    ["M10.5 0V24", "#a00"],
  ]);
});

test("focusing a lane dims every other lane and node, and draws the dimmed ones first", () => {
  const svg = renderRowGutterSVG(
    row({
      column: 0,
      color: 0,
      segments: [
        { fromColumn: 1, toColumn: 1, color: 1 }, // focused vertical
        { fromColumn: 0, toColumn: 0, color: 0 }, // dimmed vertical
        { fromColumn: 2, toColumn: 1, color: 2 }, // dimmed diagonal
        { fromColumn: 1, toColumn: 2, color: 1 }, // focused diagonal
      ],
    }),
    opts({ focusColor: 1 }),
    80,
  );
  const order = [...svg.matchAll(/<path d="([^"]+)" fill="none" stroke="([^"]+)"[^>]*?( opacity="0.2")?\/>/g)].map(
    (m) => `${m[2]}${m[3] ? " dim" : ""}`,
  );
  assert.deepEqual(order, ["#00c dim", "#a00 dim", "#0b0", "#0b0"]);
  assert.match(svg, /r="4" fill="#a00" opacity="0.2"\/>/, "the node of an unfocused lane is dimmed too");
  const focusedNode = renderRowGutterSVG(row({ color: 1 }), opts({ focusColor: 1 }), 40);
  assert.doesNotMatch(focusedNode, /opacity/, "the focused lane's own node stays at full strength");
});

test("a colour index past the palette wraps around it", () => {
  const svg = renderRowGutterSVG(row({ color: 4 }), opts(), 40);
  assert.match(svg, /r="4" fill="#0b0"\/>/);
});

test("a segment reaching past the fold is clamped onto the last lane with the node", () => {
  const svg = renderRowGutterSVG(
    row({ column: 1, segments: [{ fromColumn: 1, toColumn: 5, color: 0 }] }),
    opts({ maxColumn: 2 }),
    60,
  );
  assert.match(svg, /<path d="M30.5 0V12C30.5 18 50.5 18 50.5 24"/, "lane 5 is drawn on lane 2");
  assert.doesNotMatch(svg, /l3\.2 3\.5/, "the node itself is not folded, so it carries no marker");
});

test("lastDrawableLane is 0 when not even the second lane fits, and grows with the width", () => {
  assert.equal(lastDrawableLane(10, COL, 0, 4), 0);
  const wide = lastDrawableLane(400, COL, 8, 4);
  assert.ok(wide > 0);
  assert.ok(laneCenterX(wide, COL, 8) + 4 + 7.5 <= 400, "the chosen lane's node and marker fit");
  assert.ok(laneCenterX(wide + 1, COL, 8) + 4 + 7.5 > 400, "and the next one would not");
});
