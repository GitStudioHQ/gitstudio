import { test } from "node:test";
import assert from "node:assert/strict";
import { middleTruncate } from "../src/renderer/textFit";

// CSS ellipsis cuts from the right, which on a filesystem path removes the only
// part that identifies it: two clones of the same repo under different parents
// both render as ".../Developer/GitStu…". Paths are shortened from the middle.

test("a short path is returned untouched", () => {
  assert.equal(middleTruncate("/Users/anton/code", 44), "/Users/anton/code");
});

test("a long path keeps BOTH ends", () => {
  const p = "/Users/anton/Developer/GitStudioHQ/gitstudio/apps/desktop";
  const out = middleTruncate(p, 30);
  assert.ok(out.length <= 30, `got ${out.length}: ${out}`);
  assert.ok(out.startsWith("/Users"), out);
  assert.ok(out.endsWith("desktop"), out);
  assert.ok(out.includes("…"), out);
});

test("two clones that differ only at the end stay distinguishable", () => {
  const a = middleTruncate("/Users/anton/Developer/GitStudioHQ/gitstudio", 32);
  const b = middleTruncate("/Users/anton/Developer/GitStudioHQ/gistudio.dev", 32);
  assert.notEqual(a, b, "right-truncation collapsed these into the same string");
});

test("the result never exceeds the limit", () => {
  for (const n of [12, 20, 33, 64]) {
    const out = middleTruncate("/a/very/long/path/that/keeps/going/and/going/forever", n);
    assert.ok(out.length <= n, `max ${n}, got ${out.length}`);
  }
});
