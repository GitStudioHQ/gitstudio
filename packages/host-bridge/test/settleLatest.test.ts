import { test } from "node:test";
import assert from "node:assert/strict";
import { SELECTION_SETTLE_MS, SettleLatest } from "../src/settleLatest";

// The "N commits selected" summary asks git only once the selection settles
// (issue #32). Both hosts ask through SettleLatest; this is its state table —
// every way a request can be overtaken, and when the question is asked.

const PAUSE = 15;
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A question that counts how often it was asked, and with what. */
function question<T>(answer: (label: string) => T) {
  const asked: string[] = [];
  return {
    asked,
    for: (label: string) => async () => {
      asked.push(label);
      return answer(label);
    },
  };
}

/** A question that stays out until released. */
function held() {
  let release!: (v: string) => void;
  let askedFlag = false;
  const out = new Promise<string>((r) => (release = r));
  return {
    ask: async () => {
      askedFlag = true;
      return out;
    },
    release: (v: string) => release(v),
    asked: () => askedFlag,
  };
}

test("one request: asked once, after the pause, and its answer comes back", async () => {
  const s = new SettleLatest(PAUSE);
  const q = question((l) => `answer ${l}`);
  const p = s.run(q.for("A"));
  assert.deepEqual(q.asked, [], "nothing is asked the moment the selection changes");
  assert.equal(await p, "answer A");
  assert.deepEqual(q.asked, ["A"]);
});

test("Shift+Down held: of several requests in a row only the last is asked; the others answer nothing", async () => {
  const s = new SettleLatest(PAUSE);
  const q = question((l) => `answer ${l}`);
  const all = await Promise.all(["2 rows", "3 rows", "4 rows", "5 rows"].map((l) => s.run(q.for(l))));
  assert.deepEqual(q.asked, ["5 rows"], "git is asked once, for the selection that stayed");
  assert.deepEqual(all, [undefined, undefined, undefined, "answer 5 rows"]);
});

test("overtaken while the question is out: that answer is dropped, the newer one lands", async () => {
  const s = new SettleLatest(PAUSE);
  const first = held();
  const p1 = s.run(first.ask);
  while (!first.asked()) await later(2);
  const q = question(() => "newer");
  const p2 = s.run(q.for("B"));
  first.release("stale");
  assert.equal(await p1, undefined, "an answer for a selection that is gone is never shown");
  assert.equal(await p2, "newer");
});

test("cancel before the pause ends: never asked", async () => {
  const s = new SettleLatest(PAUSE);
  const q = question(() => "x");
  const p = s.run(q.for("A"));
  s.cancel();
  assert.equal(await p, undefined);
  await later(PAUSE * 2);
  assert.deepEqual(q.asked, [], "one commit was selected instead: nothing to ask");
});

test("cancel while the question is out: its answer is dropped", async () => {
  const s = new SettleLatest(PAUSE);
  const h = held();
  const p = s.run(h.ask);
  while (!h.asked()) await later(2);
  s.cancel();
  h.release("stale");
  assert.equal(await p, undefined);
});

test("requests further apart than the pause are each asked — a settled selection is never swallowed", async () => {
  const s = new SettleLatest(PAUSE);
  const q = question((l) => l);
  assert.equal(await s.run(q.for("A")), "A");
  assert.equal(await s.run(q.for("B")), "B");
  assert.deepEqual(q.asked, ["A", "B"]);
});

test("a question that fails fails its own request — the caller decides what to show", async () => {
  const s = new SettleLatest(PAUSE);
  await assert.rejects(s.run(async () => { throw new Error("git went away"); }), /git went away/);
});

test("the pause both hosts use", () => {
  assert.equal(SELECTION_SETTLE_MS, 120);
  assert.equal(typeof new SettleLatest().run, "function", "defaults to it");
});
