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
  assert.deepEqual(
    r.rewordMessages,
    ["FIRST edited", "THIRD edited"],
    "oldest commit's message must be consumed first",
  );
});

test("a reword with an empty message falls back to its subject", () => {
  const r = buildRebasePlan([row("aaaaaa", "first", "reword", "   ")]);
  assert.ok(r.ok);
  assert.deepEqual(r.rewordMessages, ["first"]);
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
