import { strict as assert } from "node:assert";
import { test } from "node:test";
import { relativeTime } from "../src/util/relativeTime";

// All cases pin an explicit `now` so the test is hermetic (no wall-clock
// dependency) — and never imports `vscode`, keeping it runnable under plain tsx.
const NOW = 1_700_000_000;
const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

test("sub-minute and future timestamps read as 'now'", () => {
  assert.equal(relativeTime(NOW, NOW), "now");
  assert.equal(relativeTime(NOW - 30, NOW), "now");
  // Future timestamps clamp to "now" rather than going negative.
  assert.equal(relativeTime(NOW + 5000, NOW), "now");
});

test("minutes", () => {
  assert.equal(relativeTime(NOW - 5 * MINUTE, NOW), "5m");
  assert.equal(relativeTime(NOW - 59 * MINUTE, NOW), "59m");
});

test("hours", () => {
  assert.equal(relativeTime(NOW - HOUR, NOW), "1h");
  assert.equal(relativeTime(NOW - 3 * HOUR, NOW), "3h");
  assert.equal(relativeTime(NOW - 23 * HOUR, NOW), "23h");
});

test("days", () => {
  assert.equal(relativeTime(NOW - DAY, NOW), "1d");
  assert.equal(relativeTime(NOW - 2 * DAY, NOW), "2d");
  assert.equal(relativeTime(NOW - 29 * DAY, NOW), "29d");
});

test("months", () => {
  assert.equal(relativeTime(NOW - MONTH, NOW), "1mo");
  assert.equal(relativeTime(NOW - 4 * MONTH, NOW), "4mo");
});

test("years", () => {
  assert.equal(relativeTime(NOW - YEAR, NOW), "1y");
  assert.equal(relativeTime(NOW - 3 * YEAR, NOW), "3y");
});

test("boundary transitions are exact", () => {
  assert.equal(relativeTime(NOW - (MINUTE - 1), NOW), "now");
  assert.equal(relativeTime(NOW - MINUTE, NOW), "1m");
  assert.equal(relativeTime(NOW - (HOUR - 1), NOW), "59m");
  assert.equal(relativeTime(NOW - HOUR, NOW), "1h");
  assert.equal(relativeTime(NOW - (DAY - 1), NOW), "23h");
  assert.equal(relativeTime(NOW - DAY, NOW), "1d");
});
