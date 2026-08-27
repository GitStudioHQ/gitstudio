// The stale-while-revalidate cache that sits under every list in the app.
//
// It is the one module where a subtle mistake is invisible in the UI until it
// isn't: nothing looks wrong, the list just quietly stops updating, or shows an
// error it will never recover from. The interesting cases all involve something
// happening to the cache WHILE a request is in flight — a mutation busting a
// prefix, a repo switch, a second reader arriving, a rejection.
//
// `cache.ts` reads `window.gitstudio` at import time, so the stub has to be
// installed before the dynamic import below.

import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";

/** One pending host call we can settle by hand. */
interface Call {
  channel: string;
  payload: unknown;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
  promise: Promise<unknown>;
}

let calls: Call[] = [];

(globalThis as unknown as { window: unknown }).window = {
  gitstudio: {
    invoke(channel: string, payload: unknown) {
      let resolve!: (v: unknown) => void;
      let reject!: (e: unknown) => void;
      const promise = new Promise<unknown>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      calls.push({ channel, payload, resolve, reject, promise });
      return promise;
    },
    on() {
      return () => {};
    },
  },
};

// Loaded in `before` rather than at the top level: the file compiles to CJS
// under tsx, where top-level await is unavailable — and the stub above has to
// be installed first either way.
interface CacheModule {
  peek: (c: string, p?: unknown, maxAge?: number) => unknown;
  gget: (c: string, p?: unknown, ttl?: number) => Promise<unknown>;
  bust: (prefix?: string) => void;
  prime: (c: string, p: unknown, v: unknown) => void;
  setCacheScope: (root: string | undefined) => void;
}
let peek!: CacheModule["peek"];
let gget!: CacheModule["gget"];
let bust!: CacheModule["bust"];
let prime!: CacheModule["prime"];
let setCacheScope!: CacheModule["setCacheScope"];

before(async () => {
  const m = (await import("../src/renderer/cache")) as unknown as CacheModule;
  ({ peek, gget, bust, prime, setCacheScope } = m);
});

/** Let the microtask queue drain so `.then` handlers on settled calls run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Swallow a rejection we deliberately caused, without failing the test. */
const quiet = <T>(p: Promise<T>): Promise<T | undefined> => p.catch(() => undefined);

beforeEach(() => {
  calls = [];
  bust();
  setCacheScope(undefined);
});

test("a warm value inside the TTL is served without touching the host", async () => {
  const first = gget("issue:list", { state: "open" });
  calls[0].resolve(["a"]);
  assert.deepEqual(await first, ["a"]);
  assert.equal(calls.length, 1);

  assert.deepEqual(await gget("issue:list", { state: "open" }), ["a"]);
  assert.equal(calls.length, 1, "second read inside the TTL must not re-invoke");
});

test("two concurrent readers share one request", async () => {
  const a = gget("issue:list", undefined);
  const b = gget("issue:list", undefined);
  assert.equal(calls.length, 1, "the second caller joins the in-flight request");
  calls[0].resolve(["x"]);
  assert.deepEqual(await a, ["x"]);
  assert.deepEqual(await b, ["x"]);
});

test("the payload is part of the key", async () => {
  void gget("issue:list", { state: "open" });
  void gget("issue:list", { state: "closed" });
  assert.equal(calls.length, 2, "different payloads are different entries");
});

test("a repo switch drops everything, in-flight answers included", async () => {
  setCacheScope("/repos/a");
  const p = gget("branches:list", undefined);
  setCacheScope("/repos/b");
  calls[0].resolve(["main-of-a"]);
  await p;
  assert.equal(peek("branches:list", undefined), undefined, "repo A's answer must not land in repo B");
});

// ── the in-flight/bust interaction — where the real bug lived ────────────────

test("a prefix bust for a DIFFERENT channel must not pin an in-flight channel forever", async () => {
  // Staging a file calls bust("status") + bust("diff"). If a GitHub list was
  // loading at that moment, its entry kept an in-flight marker that nothing
  // ever cleared — and `gget` short-circuits on that marker BEFORE it checks
  // the TTL, so the list was pinned to that one answer for the rest of the
  // session. Refresh did nothing.
  const first = gget("issue:list", undefined);
  bust("status");
  calls[0].resolve(["stale"]);
  assert.deepEqual(await first, ["stale"]);
  await flush();

  const second = gget("issue:list", undefined);
  assert.equal(calls.length, 2, "the next read must actually re-invoke the host");
  calls[1].resolve(["fresh"]);
  assert.deepEqual(await second, ["fresh"]);
});

test("a superseded answer is not published as if it were fresh", async () => {
  const first = gget("issue:list", undefined);
  bust("status");
  calls[0].resolve(["stale"]);
  await first;
  await flush();
  // It was fetched before the invalidation, so it must not be readable as a
  // fresh cached value.
  assert.equal(peek("issue:list", undefined, 1000), undefined);
});

test("a rejection that lands while superseded does not become permanent", async () => {
  const first = quiet(gget("issue:list", undefined));
  bust("status");
  calls[0].reject(new Error("network"));
  await first;
  await flush();

  const second = gget("issue:list", undefined);
  assert.equal(calls.length, 2, "a failed read must be retryable");
  calls[1].resolve(["recovered"]);
  assert.deepEqual(await second, ["recovered"]);
});

test("a rejection keeps the last good value readable, but stale", async () => {
  const warm = gget("issue:list", undefined);
  calls[0].resolve(["good"]);
  await warm;

  // A NEGATIVE ttl is the unambiguous "refetch regardless": with ttl 0 and no
  // time elapsed, `now - at <= 0` still counts as fresh.
  const retry = quiet(gget("issue:list", undefined, -1));
  assert.equal(calls.length, 2);
  calls[1].reject(new Error("offline"));
  await retry;
  await flush();

  assert.deepEqual(peek("issue:list", undefined), ["good"], "the last-known-good survives a failure");
  const third = gget("issue:list", undefined, -1);
  assert.equal(calls.length, 3, "and the next read still retries");
  calls[2].resolve(["back"]);
  assert.deepEqual(await third, ["back"]);
});

test("a value primed while a read is in flight is not clobbered by that read", async () => {
  // prime() seeds from a push event, which is newer than a read that started
  // earlier. The late answer must not overwrite it.
  const p = gget("branches:list", undefined);
  prime("branches:list", undefined, ["from-event"]);
  calls[0].resolve(["from-older-read"]);
  await p;
  await flush();
  assert.deepEqual(peek("branches:list", undefined), ["from-event"]);
});

// ── bust() semantics ─────────────────────────────────────────────────────────

test("bust with a prefix clears only channels that start with it", async () => {
  const a = gget("status:get", undefined);
  calls[0].resolve("dirty");
  await a;
  const b = gget("issue:list", undefined);
  calls[1].resolve(["i"]);
  await b;

  bust("status");
  assert.equal(peek("status:get", undefined), undefined, "status was busted");
  assert.deepEqual(peek("issue:list", undefined), ["i"], "issues was not");
});

test("bust with no prefix clears everything", async () => {
  const a = gget("status:get", undefined);
  calls[0].resolve("dirty");
  await a;
  bust();
  assert.equal(peek("status:get", undefined), undefined);
});

test("peek respects a max age", async () => {
  const a = gget("status:get", undefined);
  calls[0].resolve("dirty");
  await a;
  assert.equal(peek("status:get", undefined, 10_000), "dirty");
  assert.equal(peek("status:get", undefined, -1), undefined, "nothing is younger than a negative age");
});
