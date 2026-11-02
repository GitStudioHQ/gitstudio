import { test } from "node:test";
import assert from "node:assert/strict";
import { latestOnly } from "../src/renderer/latestOnly";

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
}

test("every save is sent, in order, but only the newest answer is reported", async () => {
  const sent: number[] = [];
  const pending: Array<ReturnType<typeof deferred<number>>> = [];
  const save = latestOnly((n: number) => {
    sent.push(n);
    const d = deferred<number>();
    pending.push(d);
    return d.promise;
  });
  const a = save(13);
  const b = save(13.5);
  assert.deepEqual(sent, [13, 13.5]);
  pending[0].resolve(13);
  pending[1].resolve(13.5);
  assert.equal(await a, undefined);
  assert.deepEqual(await b, { value: 13.5 });
});

test("a stale answer arriving last still cannot win", async () => {
  const pending: Array<ReturnType<typeof deferred<string>>> = [];
  const save = latestOnly((_: string) => {
    const d = deferred<string>();
    pending.push(d);
    return d.promise;
  });
  const old = save("old");
  const latest = save("new");
  pending[1].resolve("new");
  pending[0].resolve("old");
  assert.deepEqual(await latest, { value: "new" });
  assert.equal(await old, undefined);
});

test("a failure is reported only when nothing newer overtook it", async () => {
  const boom = new Error("disk full");
  const save = latestOnly(async (fail: boolean) => {
    if (fail) throw boom;
    return "ok";
  });
  assert.deepEqual(await save(true), { error: boom });
  const stale = save(true);
  const fresh = save(false);
  assert.equal(await stale, undefined);
  assert.deepEqual(await fresh, { value: "ok" });
});
