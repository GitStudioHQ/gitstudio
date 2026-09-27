// The top bar's reads (issue #32): which answer paints. The rule the branch
// pill and the sync control share — see src/renderer/topbarRead.ts — cell by
// cell, plus the renderer's use of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TopbarRead } from "../src/renderer/topbarRead";

test("one read: its answer paints — no route between the ask and the answer can drop it", () => {
  // The pill used to be guarded by the route generation; an open's landing
  // or the first click while git was answering threw the answer away.
  const r = new TopbarRead();
  const t = r.ask();
  assert.equal(r.land(t), true);
});

test("two reads in flight, answered in order: both paint (the second over the first)", () => {
  const r = new TopbarRead();
  const a = r.ask();
  const b = r.ask();
  assert.equal(r.land(a), true, "the older answer paints while nothing newer is on screen");
  assert.equal(r.land(b), true);
});

test("two reads in flight, answered out of order: the older never paints over the newer", () => {
  // Asked before a checkout, landing after the read that followed it.
  const r = new TopbarRead();
  const before = r.ask();
  const after = r.ask();
  assert.equal(r.land(after), true);
  assert.equal(r.land(before), false, "the stale branch does not come back");
});

test("the same answer shared by two asks (the cache's in-flight dedupe) paints for both", () => {
  // showRepoScreen and the Branches view ask together; the Branches view then
  // reads `this.refs`, so the first of the two must not be refused.
  const r = new TopbarRead();
  const view = r.ask();
  const bar = r.ask();
  assert.equal(r.land(view), true);
  assert.equal(r.land(bar), true);
});

test("the renderer reads its top bar through the tickets, never the route generation", () => {
  const src = readFileSync(resolve(__dirname, "../src/renderer/renderer.ts"), "utf8");
  const body = (name: string): string => {
    const at = src.indexOf(`  private async ${name}(): Promise<void> {`);
    assert.ok(at >= 0, `${name} is where it was`);
    const end = src.indexOf("\n  }\n", at);
    return src.slice(at, end);
  };
  const refs = body("refreshRefs");
  assert.match(refs, /this\.refsRead\.ask\(\)/);
  assert.match(refs, /this\.refsRead\.land\(ticket\)/);
  assert.doesNotMatch(refs, /routeGen/, "the pill's answer is not the route's to drop");
  const sync = body("updateSync");
  assert.match(sync, /this\.syncRead\.ask\(\)/);
  assert.match(sync, /this\.syncRead\.land\(ticket\)/);
});
