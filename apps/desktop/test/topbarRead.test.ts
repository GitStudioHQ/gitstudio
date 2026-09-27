// The top bar's reads (issue #32): which answer paints, and when a tab owes
// its bar another ask. The rule the branch pill and the sync control share —
// see src/renderer/topbarRead.ts — cell by cell, plus the renderer's use of it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TopbarRead } from "../src/renderer/topbarRead";

test("one read: its answer paints, and nothing is owed afterwards", () => {
  const r = new TopbarRead();
  assert.equal(r.owed(), false, "never asked: nothing owed");
  const t = r.ask();
  assert.equal(r.owed(), false, "in flight: the answer is coming");
  assert.equal(r.land(t), true, "the answer paints");
  assert.equal(r.owed(), false);
});

test("any number of routes between the ask and the answer change nothing — there is no route in it", () => {
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
  assert.equal(r.owed(), false);
});

test("two reads in flight, answered out of order: the older never paints over the newer", () => {
  // Asked before a checkout, landing after the read that followed it.
  const r = new TopbarRead();
  const before = r.ask();
  const after = r.ask();
  assert.equal(r.land(after), true);
  assert.equal(r.land(before), false, "the stale branch does not come back");
  assert.equal(r.owed(), false, "the newest answer is on screen");
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

test("a read that failed is owed — asked again when the tab is next in front", () => {
  const r = new TopbarRead();
  const t = r.ask();
  r.fail(t);
  assert.equal(r.owed(), true);
  const again = r.ask();
  assert.equal(r.owed(), false, "asked again: in flight");
  assert.equal(r.land(again), true);
  assert.equal(r.owed(), false, "filled: owes nothing");
});

test("the newest read failed while an older one painted: still owed (the newer state is unknown)", () => {
  const r = new TopbarRead();
  const old = r.ask();
  const newest = r.ask();
  r.fail(newest);
  assert.equal(r.owed(), false, "the older one is still coming");
  assert.equal(r.land(old), true, "it paints what it knows");
  assert.equal(r.owed(), true, "…and the bar still owes the newest");
});

test("an older read failed and the newest painted: nothing owed", () => {
  const r = new TopbarRead();
  const old = r.ask();
  const newest = r.ask();
  assert.equal(r.land(newest), true);
  r.fail(old);
  assert.equal(r.owed(), false);
});

test("a failure followed by a newer success: nothing owed", () => {
  const r = new TopbarRead();
  r.fail(r.ask());
  const t = r.ask();
  assert.equal(r.land(t), true);
  assert.equal(r.owed(), false);
});

test("the renderer reads its top bar through the tickets, and asks again what it owes when a tab comes to the front", () => {
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
  assert.match(refs, /this\.refsRead\.fail\(ticket\)/);
  assert.doesNotMatch(refs, /routeGen/, "the pill's answer is not the route's to drop");
  const sync = body("updateSync");
  assert.match(sync, /this\.syncRead\.ask\(\)/);
  assert.match(sync, /this\.syncRead\.land\(ticket\)/);
  assert.match(sync, /this\.syncRead\.fail\(ticket\)/);
  const activate = src.slice(src.indexOf("  activate(firstTime: boolean): void {"), src.indexOf("  deactivate(): void {"));
  assert.match(activate, /this\.refsRead\.owed\(\)\) void this\.refreshRefs\(\)/);
  assert.match(activate, /this\.syncRead\.owed\(\)\) void this\.updateSync\(\)/);
});
