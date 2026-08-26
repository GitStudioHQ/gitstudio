import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendLog,
  emptyLogDoc,
  finishLog,
  parseAnsi,
  parseLog,
  stripAnsi,
} from "../src/renderer/logModel";

const TS = "2026-08-25T10:00:42.1234567Z ";

test("parseLog strips timestamps and classifies workflow commands", () => {
  const doc = parseLog(
    `${TS}##[group]Run npm ci\n${TS}npm output line\n${TS}##[endgroup]\n${TS}##[error]exit code 1\n`,
  );
  assert.equal(doc.lines.length, 4);
  assert.equal(doc.lines[0].kind, "group");
  assert.equal(doc.lines[0].text, "Run npm ci");
  assert.equal(doc.lines[0].ts, TS.trim());
  assert.equal(doc.lines[1].kind, "plain");
  assert.equal(doc.lines[1].text, "npm output line");
  assert.equal(doc.lines[2].kind, "endgroup");
  assert.equal(doc.lines[3].kind, "error");
  assert.deepEqual(doc.groups, [{ start: 0, end: 2 }]);
});

test("unbalanced groups: an unclosed group stays open; stray endgroup is tolerated", () => {
  const doc = parseLog(`##[group]outer\nline\n##[endgroup]\n##[endgroup]\n##[group]tail\nmore\n`);
  assert.deepEqual(doc.groups, [
    { start: 0, end: 2 },
    { start: 4, end: -1 },
  ]);
});

test("appendLog re-parses a line split across two deltas", () => {
  const doc = emptyLogDoc();
  appendLog(doc, `${TS}##[warn`);
  assert.equal(doc.lines.length, 0);
  assert.equal(doc.danglingTail.length > 0, true);
  appendLog(doc, "ing]slow step\nnext\n");
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].kind, "warning");
  assert.equal(doc.lines[0].text, "slow step");
  assert.equal(doc.lines[1].text, "next");
});

test("finishLog flushes a trailing partial line", () => {
  const doc = appendLog(emptyLogDoc(), "no newline at end");
  assert.equal(doc.lines.length, 0);
  finishLog(doc);
  assert.equal(doc.lines.length, 1);
  assert.equal(doc.lines[0].text, "no newline at end");
  assert.equal(doc.danglingTail, "");
});

test("parseAnsi: basic colors, bold, reset, adjacent-span merging", () => {
  const spans = parseAnsi("[31mred[1m boldred[0m plain");
  assert.deepEqual(
    spans.map((s) => [s.text, s.cls]),
    [
      ["red", "log-fg-1"],
      [" boldred", "log-fg-1 log-b"],
      [" plain", ""],
    ],
  );
});

test("parseAnsi: bright colors and 256-color mapping to the 16 palette", () => {
  const bright = parseAnsi("[92mgreen[0m");
  assert.equal(bright[0].cls, "log-fg-10");
  const gray = parseAnsi("[38;5;250mlight-gray[0m");
  assert.equal(gray[0].cls, "log-fg-15");
  const red256 = parseAnsi("[38;5;196mred[0m");
  assert.match(red256[0].cls, /log-fg-(1|9)/);
});

test("parseAnsi strips non-SGR escapes (cursor moves, OSC)", () => {
  const spans = parseAnsi("a[2Kb]0;titlec");
  assert.equal(spans.map((s) => s.text).join(""), "abc");
});

test("stripAnsi yields plain searchable text", () => {
  assert.equal(stripAnsi("[31mfail[0m: done"), "fail: done");
});

test("truecolor maps to a nearby palette slot", () => {
  const spans = parseAnsi("[38;2;255;40;40mred[0m");
  assert.match(spans[0].cls, /log-fg-9/);
});
