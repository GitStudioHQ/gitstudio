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
  // `##[endgroup]` carries no payload, so giving it a line of its own rendered
  // a blank NUMBERED row for every group — output the raw log does not
  // contain. It closes its group without occupying a line.
  assert.equal(doc.lines.length, 3);
  assert.equal(doc.lines[0].kind, "group");
  assert.equal(doc.lines[0].text, "Run npm ci");
  assert.equal(doc.lines[0].ts, TS.trim());
  assert.equal(doc.lines[1].kind, "plain");
  assert.equal(doc.lines[1].text, "npm output line");
  assert.equal(doc.lines[2].kind, "error");
  assert.equal(
    doc.lines.some((l) => l.kind === "endgroup"),
    false,
    "no endgroup line is emitted",
  );
  // The group ends at its last REAL line, so collapsing it hides exactly the
  // lines that belong to it.
  assert.deepEqual(doc.groups, [{ start: 0, end: 1 }]);
});

test("unbalanced groups: an unclosed group stays open; stray endgroup is tolerated", () => {
  const doc = parseLog(`##[group]outer\nline\n##[endgroup]\n##[endgroup]\n##[group]tail\nmore\n`);
  assert.deepEqual(doc.lines.map((l) => l.text), ["outer", "line", "tail", "more"]);
  assert.deepEqual(doc.groups, [
    { start: 0, end: 1 },
    { start: 2, end: -1 },
  ]);
});

test("an empty group closes on its own header rather than before it", () => {
  const doc = parseLog(`##[group]nothing inside\n##[endgroup]\nafter\n`);
  assert.deepEqual(doc.groups, [{ start: 0, end: 0 }]);
  assert.deepEqual(doc.lines.map((l) => l.text), ["nothing inside", "after"]);
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

// ── carriage returns ─────────────────────────────────────────────────────────
//
// Every CI tool that draws a progress bar rewrites one logical line in place
// with `\r` and terminates it with a single `\n`. Keeping the raw text meant
// the pane rendered every intermediate state at once, run together, because a
// `\r` paints as nothing in HTML.

const CR = String.fromCharCode(13);

test("a progress line shows its final state, not all of them at once", () => {
  const doc = parseLog(
    `Downloading  0%${CR}Downloading 25%${CR}Downloading 60%${CR}Downloading 100%\nDone\n`,
  );
  assert.equal(doc.lines.length, 2);
  assert.equal(doc.lines[0].text, "Downloading 100%");
  assert.equal(doc.lines[1].text, "Done");
});

test("a carriage return overwrites rather than truncating", () => {
  // A terminal returns the cursor to column 0 and paints over; a short redraw
  // leaves the tail of the longer line behind.
  const doc = parseLog(`abcdef${CR}xy\n`);
  assert.equal(doc.lines[0].text, "xycdef");
});

test("a CRLF log does not leave a stray return on every line", () => {
  const doc = parseLog("alpha\r\nbeta\r\n");
  assert.deepEqual(
    doc.lines.map((l) => l.text),
    ["alpha", "beta"],
  );
});

test("the timestamp survives a redraw on the same line", () => {
  // GitHub stamps once per newline, so the stamp sits before the first segment.
  // Applying the overwrite to the whole raw line would let a later segment
  // paint over the timestamp.
  const doc = parseLog(`2026-08-25T10:00:42.1234567Z step  0%${CR}step 99%\n`);
  assert.equal(doc.lines[0].ts, "2026-08-25T10:00:42.1234567Z");
  assert.equal(doc.lines[0].text, "step 99%");
});

test("a workflow command still classifies after a redraw", () => {
  const doc = parseLog(`junk${CR}##[error]Process completed with exit code 1.\n`);
  assert.equal(doc.lines[0].kind, "error");
  assert.equal(doc.lines[0].text, "Process completed with exit code 1.");
});

test("text with no carriage return is returned untouched", () => {
  const doc = parseLog("plain line\n");
  assert.equal(doc.lines[0].text, "plain line");
});
