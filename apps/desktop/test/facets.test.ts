import { test } from "node:test";
import assert from "node:assert/strict";
import {
  facetActiveCount,
  facetPasses,
  facetServerValues,
  harvestValues,
  type FacetSpec,
} from "../src/renderer/facetModel";

// facetBar itself is DOM-bound (verified in the headless harness); the pure
// pieces it stands on are pinned here — harvesting is what decides which
// options a menu can even offer.

interface Row {
  label?: string;
  labels?: string[];
  author?: string | null;
}

test("harvests distinct scalar values, sorted", () => {
  const rows: Row[] = [{ author: "zoe" }, { author: "amy" }, { author: "zoe" }];
  assert.deepEqual(
    harvestValues<Row>((r) => r.author)(rows).map((o) => o.value),
    ["amy", "zoe"],
  );
});

test("harvests from array-valued fields (labels)", () => {
  const rows: Row[] = [{ labels: ["bug", "ux"] }, { labels: ["ux"] }, {}];
  assert.deepEqual(
    harvestValues<Row>((r) => r.labels)(rows).map((o) => o.value),
    ["bug", "ux"],
  );
});

test("null, undefined and empty strings are skipped, never offered as options", () => {
  const rows: Row[] = [{ author: null }, { author: "" }, { author: undefined }, { author: "amy" }];
  assert.deepEqual(
    harvestValues<Row>((r) => r.author)(rows).map((o) => o.value),
    ["amy"],
  );
});

test("an empty list harvests nothing (no phantom options)", () => {
  assert.deepEqual(harvestValues<Row>((r) => r.author)([]), []);
});

test("an array containing empty entries drops only those entries", () => {
  const rows: Row[] = [{ labels: ["", "bug"] }];
  assert.deepEqual(
    harvestValues<Row>((r) => r.labels)(rows).map((o) => o.value),
    ["bug"],
  );
});

// ── the client/server split ──────────────────────────────────────────────────
//
// The rule that matters: a facet WITHOUT a predicate is the server's job, and
// must never also filter locally — doing both would hide rows the server
// already excluded and quietly under-report.

const SPECS: FacetSpec<Row>[] = [
  {
    key: "author",
    label: "Author",
    icon: "account",
    predicate: (r, v) => r.author === v,
  },
  // No predicate ⇒ server-side.
  { key: "branch", label: "Branch", icon: "git-branch" },
];

test("a client facet filters locally", () => {
  assert.equal(facetPasses(SPECS, { author: "amy" }, { author: "amy" }), true);
  assert.equal(facetPasses(SPECS, { author: "amy" }, { author: "zoe" }), false);
});

test("a SERVER facet never filters locally, whatever its value", () => {
  assert.equal(facetPasses(SPECS, { branch: "main" }, { author: "zoe" }), true);
});

test("client and server facets combine without the server one hiding rows", () => {
  const state = { author: "amy", branch: "main" };
  assert.equal(facetPasses(SPECS, state, { author: "amy" }), true);
  assert.equal(facetPasses(SPECS, state, { author: "zoe" }), false);
});

test("serverValues returns ONLY predicate-less facets", () => {
  assert.deepEqual(facetServerValues(SPECS, { author: "amy", branch: "main" }), { branch: "main" });
});

test("serverValues is empty when only client facets are set", () => {
  assert.deepEqual(facetServerValues(SPECS, { author: "amy" }), {});
});

test("activeCount counts both kinds — it drives the Clear button", () => {
  assert.equal(facetActiveCount(SPECS, {}), 0);
  assert.equal(facetActiveCount(SPECS, { author: "amy" }), 1);
  assert.equal(facetActiveCount(SPECS, { author: "amy", branch: "main" }), 2);
});

test("an unset facet passes everything", () => {
  assert.equal(facetPasses(SPECS, {}, { author: "anyone" }), true);
});

// ── humanized option labels ──────────────────────────────────────────────────
//
// A facet menu that lists raw API values ("subscribed", "PullRequest") beside
// rows that render humanized ones ("watching", "PR") never matches what the
// reader is looking at. The label mapper is what keeps the two in step.

test("without a mapper the option label is the raw value", () => {
  const rows: Row[] = [{ author: "review_requested" }];
  const opts = harvestValues<Row>((r) => r.author)(rows);
  assert.deepEqual(opts, [{ value: "review_requested", label: undefined }]);
});

test("a mapper labels the option while the VALUE stays the API value", () => {
  const rows: Row[] = [{ author: "review_requested" }];
  const [opt] = harvestValues<Row>((r) => r.author, (v) => v.replace(/_/g, " "))(rows);
  assert.equal(opt.value, "review_requested", "the predicate still matches on the raw value");
  assert.equal(opt.label, "review requested");
});

test("options sort by the LABEL, which is the order the reader sees", () => {
  const rows: Row[] = [{ author: "zeta" }, { author: "alpha" }];
  const labels = { zeta: "Aardvark", alpha: "Zebra" } as Record<string, string>;
  const opts = harvestValues<Row>((r) => r.author, (v) => labels[v])(rows);
  assert.deepEqual(opts.map((o) => o.label), ["Aardvark", "Zebra"]);
});
