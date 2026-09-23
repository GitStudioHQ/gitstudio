import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRebasePlan, type RebasePlanRow } from "../src/rebasePlan";

// The rebase list shows newest first, matching the Commits list (issue #18).
// git's todo file is oldest first. This is the single seam between the two, and
// every failure mode here is SILENT — the rebase succeeds and the history is
// wrong — so each one gets a named test.

const row = (sha: string, subject: string, action = "pick", message?: string): RebasePlanRow =>
  ({ sha, subject, action, ...(message ? { message } : {}) });

/** Display order: newest at the top, exactly as the user sees it. */
const NEWEST_FIRST = [
  row("cccccc", "third"),
  row("bbbbbb", "second"),
  row("aaaaaa", "first"),
];

test("the todo is written oldest-first, the reverse of what is on screen", () => {
  const r = buildRebasePlan(NEWEST_FIRST);
  assert.ok(r.ok);
  assert.deepEqual(r.todo.trim().split("\n"), [
    "pick aaaaaa first",
    "pick bbbbbb second",
    "pick cccccc third",
  ]);
});

test("reword messages follow TODO order, not screen order", () => {
  // The trap. RebaseRunner pops these by a counter as git opens the editor once
  // per reword, walking the todo top-down — so a display-ordered queue puts each
  // message on the wrong commit and reports success.
  const r = buildRebasePlan([
    row("cccccc", "third", "reword", "THIRD edited"),
    row("bbbbbb", "second"),
    row("aaaaaa", "first", "reword", "FIRST edited"),
  ]);
  assert.ok(r.ok);
  // Keyed by commit, in todo order. The order still matters for reading, but
  // it is no longer what SELECTS the message — see `rewords` in rebasePlan.ts.
  assert.deepEqual(
    r.rewords,
    [
      { sha: "aaaaaa", message: "FIRST edited" },
      { sha: "cccccc", message: "THIRD edited" },
    ],
    "each message is bound to the commit it belongs to, oldest first",
  );
});

test("a reword with an empty message falls back to its subject", () => {
  const r = buildRebasePlan([row("aaaaaa", "first", "reword", "   ")]);
  assert.ok(r.ok);
  assert.deepEqual(r.rewords, [{ sha: "aaaaaa", message: "first" }]);
});

test("the squash guard applies to the OLDEST commit — the bottom row on screen", () => {
  // Nothing precedes the first commit git replays, so it cannot fold into
  // anything. On screen that is the LAST row, not the first.
  const r = buildRebasePlan([
    row("cccccc", "third"),
    row("bbbbbb", "second"),
    row("aaaaaa", "first", "squash"),
  ]);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /oldest commit can't be "squash"/);
});

test("…and a squash on the TOP row is perfectly legal", () => {
  // It folds into the commit below it, which is older. This is the case a
  // naive port of the old guard would wrongly reject.
  const r = buildRebasePlan([
    row("cccccc", "third", "squash"),
    row("bbbbbb", "second"),
    row("aaaaaa", "first"),
  ]);
  assert.ok(r.ok, "a squash at the top must be allowed");
  assert.deepEqual(r.todo.trim().split("\n").at(-1), "squash cccccc third");
});

test("drops are skipped when finding the oldest kept commit", () => {
  const r = buildRebasePlan([
    row("cccccc", "third"),
    row("bbbbbb", "second", "squash"),
    row("aaaaaa", "first", "drop"),
  ]);
  assert.equal(r.ok, false, "the oldest KEPT row is the squash, so this is refused");
});

test("dropping everything is refused", () => {
  const r = buildRebasePlan([row("bbbbbb", "b", "drop"), row("aaaaaa", "a", "drop")]);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /erase the whole range/);
});

test("an empty plan is refused rather than producing an empty todo", () => {
  assert.equal(buildRebasePlan([]).ok, false);
});

test("a subject containing a newline cannot smuggle in a second command", () => {
  // The todo is a script git RUNS: a raw newline would make "exec rm -rf" a line
  // of its own.
  const r = buildRebasePlan([row("aaaaaa", "fix thing\nexec echo pwned")]);
  assert.ok(r.ok);
  assert.equal(r.todo.trim().split("\n").length, 1, "still one command");
  assert.match(r.todo, /^pick aaaaaa fix thing exec echo pwned/);
});

test("an unrecognised action is refused, not written", () => {
  const r = buildRebasePlan([row("aaaaaa", "x", "exec")]);
  assert.equal(r.ok, false);
  assert.match((r as { message: string }).message, /unrecognised plan entry/);
});

test("a sha that is not a sha is refused", () => {
  const r = buildRebasePlan([row("../../etc/passwd", "x")]);
  assert.equal(r.ok, false);
});

test("the input array is not mutated — the caller still owns display order", () => {
  const rows = [...NEWEST_FIRST];
  buildRebasePlan(rows);
  assert.deepEqual(rows.map((r) => r.sha), ["cccccc", "bbbbbb", "aaaaaa"]);
});

// A refusal is either the plan the USER composed — a fold with nothing below
// it, or every commit dropped; the extension's rebase panel lets you press
// Start on the second — or a request a host BUILT wrong: no rows at all, an
// action or a sha no UI offers. The first is shown, not crash-reported; the
// second is exactly what the report is for. Both hosts read `expected` off the
// refusal, so the line is drawn once, here.
test("a plan the user composed and git cannot run is the user's state; a request built wrong is not", () => {
  const composed = [
    buildRebasePlan([row("bbbbbb", "second"), row("aaaaaa", "first", "squash")]),
    buildRebasePlan([row("bbbbbb", "second", "drop"), row("aaaaaa", "first", "drop")]),
  ];
  for (const r of composed) {
    assert.equal(r.ok, false);
    assert.equal(!r.ok && r.expected, true, !r.ok ? r.message : "");
  }
  const builtWrong = [
    buildRebasePlan([]),
    buildRebasePlan([row("aaaaaa", "x", "exec")]),
    buildRebasePlan([row("../../etc/passwd", "x")]),
  ];
  for (const r of builtWrong) {
    assert.equal(r.ok, false);
    assert.notEqual(!r.ok && r.expected, true, !r.ok ? r.message : "");
  }
});
