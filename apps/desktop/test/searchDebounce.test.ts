import { test } from "node:test";
import assert from "node:assert/strict";
import { createSearchScheduler } from "../src/renderer/searchDebounce";

// A fake clock: timers only fire when the test says so, so debounce and
// out-of-order answers are deterministic instead of racy.
function fakeTimers() {
  let next = 1;
  const pending = new Map<number, () => void>();
  return {
    setTimer: (fn: () => void, _ms: number) => {
      const id = next++;
      pending.set(id, fn);
      return id;
    },
    clearTimer: (id: number) => {
      pending.delete(id);
    },
    /** Fire everything currently scheduled. */
    flush: () => {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    count: () => pending.size,
  };
}

test("typing repeatedly issues ONE search, not one per keystroke", () => {
  const t = fakeTimers();
  const ran: string[] = [];
  const s = createSearchScheduler((q) => ran.push(q), { ...t });
  s.queue("gi");
  s.queue("git");
  s.queue("gitst");
  s.queue("gitstudio");
  assert.equal(t.count(), 1, "only the last keystroke has a live timer");
  t.flush();
  assert.deepEqual(ran, ["gitstudio"]);
});

test("queries under the minimum never search", () => {
  const t = fakeTimers();
  const ran: string[] = [];
  const s = createSearchScheduler((q) => ran.push(q), { ...t, minChars: 3 });
  assert.equal(s.queue("g"), undefined);
  assert.equal(s.queue("gi"), undefined);
  t.flush();
  assert.deepEqual(ran, []);
  assert.notEqual(s.queue("git"), undefined);
  t.flush();
  assert.deepEqual(ran, ["git"]);
});

test("a stale answer is not current — the whole point of generations", () => {
  const t = fakeTimers();
  const gens: number[] = [];
  const s = createSearchScheduler((_q, gen) => gens.push(gen), { ...t });
  const first = s.queue("react");
  t.flush();
  const second = s.queue("reactive");
  t.flush();
  assert.equal(s.isCurrent(second!), true);
  assert.equal(s.isCurrent(first!), false, "the older query's results must be dropped");
  assert.deepEqual(gens.length, 2);
});

test("typing back below the minimum invalidates a search already in flight", () => {
  const t = fakeTimers();
  const s = createSearchScheduler(() => {}, { ...t, minChars: 3 });
  const gen = s.queue("gitstudio")!;
  t.flush();
  assert.equal(s.isCurrent(gen), true);
  s.queue("gi"); // too short to run, but it MUST invalidate
  assert.equal(s.isCurrent(gen), false);
});

test("re-typing the same query doesn't spend another request", () => {
  const t = fakeTimers();
  const ran: string[] = [];
  const s = createSearchScheduler((q) => ran.push(q), { ...t });
  s.queue("git");
  t.flush();
  assert.equal(s.queue("git"), undefined);
  t.flush();
  assert.deepEqual(ran, ["git"]);
});

test("cancel() drops a pending search", () => {
  const t = fakeTimers();
  const ran: string[] = [];
  const s = createSearchScheduler((q) => ran.push(q), { ...t });
  s.queue("gitstudio");
  s.cancel();
  t.flush();
  assert.deepEqual(ran, []);
});

test("whitespace is trimmed before both the length test and the dedupe", () => {
  const t = fakeTimers();
  const ran: string[] = [];
  const s = createSearchScheduler((q) => ran.push(q), { ...t, minChars: 3 });
  assert.equal(s.queue("  g  "), undefined);
  s.queue("  git  ");
  t.flush();
  assert.deepEqual(ran, ["git"]);
  assert.equal(s.queue("git"), undefined, "same query after trimming");
});

test("lastQuery reports what actually ran, not what was typed", () => {
  const t = fakeTimers();
  const s = createSearchScheduler(() => {}, { ...t });
  s.queue("react");
  assert.equal(s.lastQuery(), "", "nothing has run yet");
  t.flush();
  assert.equal(s.lastQuery(), "react");
});
