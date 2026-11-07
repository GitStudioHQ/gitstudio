// The renderer's half of a merge commit's cherry-pick or revert: main answers
// a request without a side with the merge's parents (`mergeSides`), and the
// bridge asks which side — once, for every door — then sends the SAME request
// again with `mainline`. Cancel runs nothing and says nothing (`cancelled`).
//
// bridge.ts reads `window.gitstudio` at import time, so the stub goes first.

import { test, before } from "node:test";
import assert from "node:assert/strict";

interface Call {
  channel: string;
  payload: unknown;
  resolve: (v: unknown) => void;
}
const calls: Call[] = [];

(globalThis as unknown as { window: unknown }).window = {
  gitstudio: {
    invoke(channel: string, payload: unknown) {
      return new Promise((resolve) => calls.push({ channel, payload, resolve }));
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

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

const SIDES = {
  parents: [
    { sha: "a".repeat(40), subject: "main work" },
    { sha: "b".repeat(40), subject: "side work" },
  ],
};
const MERGE = "c".repeat(40);

test("a merge's cherry-pick is asked its side, then sent again with it", async () => {
  const asked: unknown[] = [];
  b.answerMergeSidesWith(async (action, sha, sides) => {
    asked.push({ action, sha, n: sides.parents.length });
    return 2;
  });
  const done = b.host.invoke("commit:action", { action: "cherry-pick", sha: MERGE });
  await flush();
  assert.equal(calls.length, 1);
  calls[0]!.resolve({ ok: false, changed: false, expected: true, mergeSides: SIDES, message: "needs a side" });
  await flush();
  assert.deepEqual(asked, [{ action: "cherry-pick", sha: MERGE, n: 2 }]);
  assert.equal(calls.length, 2, "the request went again");
  assert.deepEqual(calls[1]!.payload, { action: "cherry-pick", sha: MERGE, mainline: 2 });
  calls[1]!.resolve({ ok: true, changed: true });
  assert.deepEqual(await done, { ok: true, changed: true }, "the door gets the second answer");
  calls.length = 0;
});

test("Cancel runs nothing and hands the door `cancelled`", async () => {
  b.answerMergeSidesWith(async () => undefined);
  const done = b.host.invoke("commit:action", { action: "revert", sha: MERGE });
  await flush();
  calls[0]!.resolve({ ok: false, changed: false, expected: true, mergeSides: SIDES });
  const answer = await done;
  assert.equal(calls.length, 1, "nothing was sent again");
  assert.equal((answer as { cancelled?: boolean }).cancelled, true);
  calls.length = 0;
});

test("only commit:action's answer is asked about", async () => {
  let asked = 0;
  b.answerMergeSidesWith(async () => {
    asked++;
    return 1;
  });
  const done = b.host.invoke("head:get", undefined);
  await flush();
  calls[0]!.resolve({ mergeSides: SIDES });
  await done;
  assert.equal(asked, 0);
  assert.equal(calls.length, 1);
  calls.length = 0;
});
