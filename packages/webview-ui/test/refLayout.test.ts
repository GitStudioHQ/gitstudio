import { test } from "node:test";
import assert from "node:assert/strict";
import type { WireRef } from "@gitstudio/host-bridge/graphProtocol";
import {
  foldRefs,
  fitRefs,
  fitRefsWidth,
  wantedRefsWidth,
  chipCap,
  estimateChipWidth,
  CHIP_BASE_CAP,
} from "../src/graph/refLayout";

// What is being pinned here is the Branch/Tag column's two promises: it never
// silently loses a ref, and dragging it wider always shows you more. Both were
// broken in ways that looked like styling and were actually data loss.

const head = (name: string): WireRef => ({ name, kind: "head" });
const remote = (name: string): WireRef => ({ name, kind: "remoteHead" });
const tag = (name: string): WireRef => ({ name, kind: "tag" });

test("a remote twin folds into its local chip rather than doubling it", () => {
  const entries = foldRefs([head("main"), remote("origin/main")]);
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0].remotes, ["origin"]);
});

test("a remote with no local twin keeps its own chip", () => {
  const entries = foldRefs([remote("origin/solo")]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].ref.name, "origin/solo");
});

test("anything folded away is reported as overflow, never dropped", () => {
  // The regression: at 149px the "+N" pill failed a `used + 30 <= budget` test
  // by two pixels and was skipped, so a commit on origin/HEAD AND origin/main
  // rendered one chip and read as a commit with a single ref.
  const entries = foldRefs([remote("origin/HEAD"), remote("origin/main")]);
  const fit = fitRefs(entries, 149);
  assert.ok(fit.shown < entries.length, "the column is too narrow for both");
  assert.equal(
    fit.shown + fit.overflow.length,
    entries.length,
    "every entry is either shown or accounted for in the overflow",
  );
  assert.ok(fit.overflow.length > 0, "the caller has a '+N' to render");
});

test("no ref is ever unaccounted for, at any column width", () => {
  const entries = foldRefs([
    head("main"),
    remote("origin/main"),
    tag("v1.9.0"),
    remote("origin/feat/diff-tick-staging"),
    head("feat/really-quite-a-long-branch-name"),
  ]);
  for (let w = 60; w <= 640; w += 7) {
    const fit = fitRefs(entries, w);
    assert.equal(
      fit.shown + fit.overflow.length,
      entries.length,
      `width ${w} lost a ref`,
    );
    assert.ok(fit.shown >= 1, `width ${w} drew nothing at all`);
  }
});

test("widening the column never shows FEWER chips", () => {
  const entries = foldRefs([
    head("main"), tag("v1"), tag("v2"), remote("origin/feature/x"), tag("v3"),
  ]);
  let prev = 0;
  for (let w = 60; w <= 640; w += 5) {
    const { shown } = fitRefs(entries, w);
    assert.ok(shown >= prev, `widening to ${w} dropped a chip (${prev} -> ${shown})`);
    prev = shown;
  }
});

test("the chip cap grows with the column, so a long ref is reachable", () => {
  // Issue #11's shape: a FIXED cap meant dragging wider silently did nothing.
  const long = foldRefs([remote("origin/feat/diff-tick-staging")])[0];
  const narrow = estimateChipWidth(long, chipCap(200));
  const wide = estimateChipWidth(long, chipCap(420));
  assert.ok(wide > narrow, "a wider column must allow a wider chip");
  assert.equal(chipCap(60), CHIP_BASE_CAP, "never caps below the base");
});

test("a ref-less history asks for the minimum, not a reserved empty column", () => {
  const rows = [{ refs: [] }, { refs: undefined }];
  assert.equal(wantedRefsWidth(rows, 640, 60), 60);
});

test("the width wanted is driven by the busiest row", () => {
  const rows = [
    { refs: [head("a")] },
    { refs: [head("main"), tag("v1.9.0"), remote("origin/other")] },
  ];
  const one = wantedRefsWidth([rows[0]], 640, 60);
  const busy = wantedRefsWidth(rows, 640, 60);
  assert.ok(busy > one, "the widest row sets the track width");
});

test("a wide window grants the full content fit", () => {
  const w = fitRefsWidth({
    wanted: 260, host: 1400, nonRefs: 411, comfort: 420, min: 60, max: 640,
  });
  assert.equal(w, 260);
});

test("a narrow window makes the track yield to the commit message", () => {
  // The "resizing makes it a hell lot worse" case: the track used to keep its
  // full content fit while every message ellipsized around it.
  const wide = fitRefsWidth({
    wanted: 260, host: 1400, nonRefs: 411, comfort: 420, min: 60, max: 640,
  });
  const narrow = fitRefsWidth({
    wanted: 260, host: 980, nonRefs: 411, comfort: 420, min: 60, max: 640,
  });
  assert.ok(narrow < wide, "narrowing must reclaim width from the track");
  assert.ok(narrow >= 60, "but never below the column's own minimum");
});

test("the track never exceeds the column max, however long the refs", () => {
  const w = fitRefsWidth({
    wanted: 5000, host: 4000, nonRefs: 411, comfort: 420, min: 60, max: 640,
  });
  assert.equal(w, 640);
});

test("before layout, the content fit stands", () => {
  // host = 0 means the element has not been measured yet; clamping against a
  // zero budget would collapse the track to its minimum on first paint.
  const w = fitRefsWidth({
    wanted: 260, host: 0, nonRefs: 411, comfort: 420, min: 60, max: 640,
  });
  assert.equal(w, 260);
});
