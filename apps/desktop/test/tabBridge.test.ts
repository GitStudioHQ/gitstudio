// The bridge's half of repositories as tabs (issue #32): every call is stamped
// with the tab that made it, and its answer is delivered only while that tab
// is in front — held while it is in the back, dropped once it is closed. This
// is what stops an answer that started in tab A from painting into tab B
// (rows 1–2 and 10 of docs/desktop-repo-tabs.md).
//
// bridge.ts reads `window.gitstudio` at import time, so the stub goes first.

import { test, before } from "node:test";
import assert from "node:assert/strict";

interface Call {
  channel: string;
  payload: unknown;
  scope: { root: string | undefined } | undefined;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}
const calls: Call[] = [];

(globalThis as unknown as { window: unknown }).window = {
  gitstudio: {
    invoke(channel: string, payload: unknown, scope?: { root: string | undefined }) {
      return new Promise((resolve, reject) => calls.push({ channel, payload, scope, resolve, reject }));
    },
    on() {
      return () => {};
    },
  },
};

type Bridge = typeof import("../src/renderer/bridge");
let b!: Bridge;
before(async () => {
  b = (await import("../src/renderer/bridge")) as Bridge;
});

/** Let settled promises run their `.then`s. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Watch a promise without awaiting it. */
function watch<T>(p: Promise<T>): { settled: () => boolean; value: () => T | undefined; error: () => unknown } {
  let done = false;
  let v: T | undefined;
  let err: unknown;
  p.then(
    (x) => {
      done = true;
      v = x;
    },
    (e) => {
      done = true;
      err = e;
    },
  );
  return { settled: () => done, value: () => v, error: () => err };
}

const A = { id: 101, root: "/repos/a" };
const B = { id: 102, root: "/repos/b" };

test("every call says which tab made it", async () => {
  b.setActiveSession(A);
  void b.host.invoke("head:get", undefined);
  assert.deepEqual(calls.at(-1)!.scope, { root: "/repos/a" });
  b.setActiveSession(undefined);
  void b.host.invoke("head:get", undefined);
  assert.deepEqual(calls.at(-1)!.scope, { root: undefined }, "with no tab open, it says so");
});

test("row 1: an answer for tab A that lands while B is in front waits for A", async () => {
  b.setActiveSession(A);
  const w = watch(b.host.invoke("head:get", undefined));
  b.setActiveSession(B); // switched before the answer
  calls.at(-1)!.resolve({ branch: "main-of-a" });
  await flush();
  assert.equal(w.settled(), false, "nothing of A's runs while B is in front");
  assert.equal(b.heldFor(A.id), 1);
  b.setActiveSession(A);
  await flush();
  assert.equal(w.settled(), true, "delivered when A is back in front");
  assert.deepEqual(w.value(), { branch: "main-of-a" });
  assert.equal(b.heldFor(A.id), 0);
});

test("row 1: a REJECTION is held the same way — an error toast of A's never shows over B", async () => {
  b.setActiveSession(A);
  const w = watch(b.host.invoke("sync:push", undefined));
  b.setActiveSession(B);
  calls.at(-1)!.reject(new Error("rejected: non-fast-forward"));
  await flush();
  assert.equal(w.settled(), false);
  b.setActiveSession(A);
  await flush();
  assert.match(String((w.error() as Error)?.message), /non-fast-forward/);
});

test("held answers are delivered in the order they arrived", async () => {
  b.setActiveSession(A);
  const order: string[] = [];
  const p1 = b.host.invoke("status", undefined).then(() => order.push("status"));
  const i1 = calls.length - 1;
  const p2 = b.host.invoke("head:get", undefined).then(() => order.push("head"));
  const i2 = calls.length - 1;
  b.setActiveSession(B);
  calls[i2].resolve({});
  calls[i1].resolve([]);
  await flush();
  b.setActiveSession(A);
  await Promise.all([p1, p2]);
  assert.deepEqual(order, ["head", "status"], "head's answer arrived first, so it runs first");
});

test("an answer for tab B while B is in front is delivered at once", async () => {
  b.setActiveSession(B);
  const w = watch(b.host.invoke("head:get", undefined));
  calls.at(-1)!.resolve({ branch: "develop" });
  await flush();
  assert.equal(w.settled(), true);
});

test("row 7/10: a closed tab's answers are dropped — now and later", async () => {
  const C = { id: 103, root: "/repos/c" };
  b.setActiveSession(C);
  const early = watch(b.host.invoke("status", undefined));
  const iEarly = calls.length - 1;
  const late = watch(b.host.invoke("sync:push", undefined));
  const iLate = calls.length - 1;
  b.setActiveSession(B);
  calls[iEarly].resolve([]);
  await flush();
  assert.equal(b.heldFor(C.id), 1);
  b.endSession(C.id);
  assert.equal(b.heldFor(C.id), 0, "what was waiting is gone");
  calls[iLate].resolve({ ok: true });
  await flush();
  b.setActiveSession(C); // even if the id came back somehow
  await flush();
  assert.equal(early.settled(), false);
  assert.equal(late.settled(), false, "and what lands after the close is never delivered");
});

test("the calls that change the tabs are never held", async () => {
  b.setActiveSession(A);
  const opened = watch(b.host.invoke("repo:openPath", "/repos/new"));
  b.setActiveSession(B); // main switched to the tab it opened
  calls.at(-1)!.resolve({ root: "/repos/new", name: "new" });
  await flush();
  assert.equal(opened.settled(), true, "'you opened X' is about the row, not about tab A");
});

test("the landing after an open is marked, and only for that turn", async () => {
  b.setActiveSession(A);
  let during = false;
  const p = b.host.invoke("repo:openPath", "/repos/new").then(() => {
    during = b.inOpenLanding();
  });
  calls.at(-1)!.resolve({ root: "/repos/new", name: "new" });
  await p;
  assert.equal(during, true, "the open's own continuation may land the new tab");
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(b.inOpenLanding(), false, "…and nothing after it");
  // A read's answer is never a landing.
  let readLanding = true;
  const q = b.host.invoke("head:get", undefined).then(() => {
    readLanding = b.inOpenLanding();
  });
  calls.at(-1)!.resolve({});
  await q;
  assert.equal(readLanding, false);
});

test("row 2/10: a tab knows what is running in it until git answers — held or not", async () => {
  const D = { id: 104, root: "/repos/d" };
  let changes = 0;
  const off = b.onRunningChange(() => changes++);
  b.setActiveSession(D);
  void b.host.invoke("sync:push", undefined);
  const i = calls.length - 1;
  assert.equal(b.runningOperation(D.id), "a push");
  void b.host.invoke("head:get", undefined);
  assert.equal(b.runningOperation(D.id), "a push", "a read is not an operation");
  b.setActiveSession(B);
  calls[i].resolve({ ok: true });
  await flush();
  assert.equal(b.runningOperation(D.id), undefined, "the spinner stops when git is done, even with the answer held");
  assert.ok(changes >= 2, "start and end were both announced");
  off();
  b.endSession(D.id);
});

test("the operations the other #32 work added are operations too: a tab spins, and a close asks", async () => {
  // Its own session id: an ended session stays ended for the whole file.
  const F = { id: 199, root: "/repos/f" };
  b.setActiveSession(F);
  for (const [channel, words] of [
    ["commits:rewrite", "a rewrite of several commits"],
    ["worktree:remove", "a worktree removal"],
  ] as const) {
    void b.host.invoke(channel as never, {} as never);
    const i = calls.length - 1;
    assert.equal(b.runningOperation(F.id), words, channel);
    calls[i].resolve({ ok: true });
    await flush();
    assert.equal(b.runningOperation(F.id), undefined, `${channel}: done when git answers`);
  }
  b.endSession(F.id);
});

test("Stash & Retry sends its second call for the SAME tab", async () => {
  const E = { id: 105, root: "/repos/e" };
  b.setActiveSession(E);
  b.answerInTheWayWith(async () => true, () => {});
  const w = watch(b.host.invoke("branch:rebase", { onto: "main" } as never));
  calls.at(-1)!.resolve({ ok: false, message: "in the way", inTheWay: { kind: "rebase", files: ["x"], root: "/repos/e" } });
  await flush();
  await flush();
  const retry = calls.at(-1)!;
  assert.equal(retry.channel, "branch:rebase");
  assert.deepEqual(retry.scope, { root: "/repos/e" }, "the retry goes to the repository that refused");
  assert.deepEqual((retry.payload as { stashFirst?: string }).stashFirst, "/repos/e");
  retry.resolve({ ok: true });
  await flush();
  assert.equal(w.settled(), true);
});

test("…even if another tab came to the front while the question was up", async () => {
  // No switch happens under a modal (the shell refuses it) — this is the
  // belt to that brace: the retry is stamped with the tab that ASKED, not
  // with whichever tab is in front when the answer comes.
  const G = { id: 106, root: "/repos/g" };
  const H = { id: 107, root: "/repos/h" };
  b.setActiveSession(G);
  b.answerInTheWayWith(async () => {
    b.setActiveSession(H);
    return true;
  }, () => {});
  const w = watch(b.host.invoke("sync:pull", undefined as never));
  calls.at(-1)!.resolve({ ok: false, message: "in the way", inTheWay: { kind: "pull", files: ["x"], root: "/repos/g" } });
  await flush();
  await flush();
  const retry = calls.at(-1)!;
  assert.equal(retry.channel, "sync:pull");
  assert.deepEqual(retry.scope, { root: "/repos/g" }, "the retry goes to G, the tab that asked — not H");
  retry.resolve({ ok: true });
  await flush();
  assert.equal(w.settled(), false, "G's answer waits while H is in front");
  b.setActiveSession(G);
  await flush();
  assert.equal(w.settled(), true, "and is G's when G is back");
  b.endSession(G.id);
  b.endSession(H.id);
});
