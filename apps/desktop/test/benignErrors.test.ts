// What the crash reporter is allowed to swallow.
//
// The diff is computed in Monaco's editor web worker. `isBenignError` used to
// suppress EVERYTHING sourced from that file, which is why a worker that was
// cold, crashed, or answering for a disposed model presented to the user as
// "the two diff views sometimes don't show the diffs" with no error anywhere —
// not a toast, not a report, nothing. The worker's ordinary chatter (inlay
// hints, link detection) is still noise; a failure to compute a diff is a
// failure of a feature and must not be filtered out with it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { isBenignError } from "../src/renderer/benignErrors";

test("the worker's ordinary noise stays suppressed", () => {
  assert.equal(isBenignError("Script error."), true);
  assert.equal(isBenignError("Missing requestHandler or method: inlayHints"), true);
  assert.equal(isBenignError("ResizeObserver loop completed with undelivered notifications."), true);
  assert.equal(isBenignError("Canceled"), true);
  assert.equal(isBenignError("something odd", "file:///app/editor.worker.js"), true);
  assert.equal(isBenignError("something odd", "file:///app/editor.worker.a1b2c3.js"), true);
});

test("a failure to compute a DIFF is never benign, whatever produced it", () => {
  assert.equal(isBenignError("computeDiff failed"), false);
  assert.equal(isBenignError("Error in diff computation"), false);
  assert.equal(isBenignError("DiffComputer threw"), false);
  // Even when it arrives wearing the worker's return address — which is
  // precisely the case the blanket filter was hiding.
  assert.equal(isBenignError("computeDiff failed", "file:///app/editor.worker.js"), false);
});

test("real application errors are still reported", () => {
  assert.equal(isBenignError("Cannot read properties of undefined (reading '0')"), false);
  assert.equal(isBenignError("TypeError: x is not a function", "file:///app/renderer.js"), false);
});
