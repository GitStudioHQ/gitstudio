import { test } from "node:test";
import assert from "node:assert/strict";
import { SearchGuard, SEARCH_LIMITS } from "../src/main/github/searchGuard";

// The budget that keeps Explore from earning a surprise 403. The guard must
// refuse BEFORE spending, and must say how long to wait — a plain "no" would
// leave the UI with nothing honest to show.

test("core and code have separate budgets", () => {
  let now = 0;
  const g = new SearchGuard(() => now);
  // Spend the entire code budget…
  for (let i = 0; i < SEARCH_LIMITS.code; i++) g.take("code");
  assert.equal(g.take("code").ok, false);
  // …core is untouched.
  assert.equal(g.take("core").ok, true);
});

test("a spent budget reports how long to wait, not just failure", () => {
  let now = 1_000_000;
  const g = new SearchGuard(() => now);
  for (let i = 0; i < SEARCH_LIMITS.core; i++) g.take("core");
  const r = g.take("core");
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.ok(r.retryInMs > 0, "must carry a wait");
    assert.ok(r.retryInMs <= 61_000, `wait should be within a window, got ${r.retryInMs}`);
  }
});

test("the budget refills as the window slides", () => {
  let now = 0;
  const g = new SearchGuard(() => now);
  while (g.take("code").ok) {
    /* drain */
  }
  assert.equal(g.take("code").ok, false);
  now += 60_001; // every spend has aged out
  assert.equal(g.take("code").ok, true);
});

test("remaining() reports what's actually left and never goes negative", () => {
  let now = 0;
  const g = new SearchGuard(() => now);
  const start = g.remaining("core");
  assert.ok(start > 0 && start < SEARCH_LIMITS.core, "reserve keeps headroom");
  g.take("core");
  assert.equal(g.remaining("core"), start - 1);
  while (g.take("core").ok) {
    /* drain */
  }
  assert.equal(g.remaining("core"), 0);
});

test("a partial window refills partially, not all at once", () => {
  let now = 0;
  const g = new SearchGuard(() => now);
  g.take("code"); // spent at t=0
  now = 30_000;
  while (g.take("code").ok) {
    /* drain the rest at t=30s */
  }
  now = 60_001; // only the t=0 spend has aged out
  assert.equal(g.take("code").ok, true);
  assert.equal(g.take("code").ok, false);
});
