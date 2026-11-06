import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import { computeChangeBlocks } from "@gitstudio/engine/staging/blockStaging";
import { applySelectedChanges, computeHunks } from "@gitstudio/engine/staging/applyLineChanges";
import { Superseded } from "@gitstudio/git-service/stagingMath";
import { WorkerStagingMath } from "../src/changes/workerStagingMath";

// #145: a 3,000-line file whose every line changed, staged, then Enter — the
// window froze for 5 s. The staging gutter re-diffs after every edit, and a
// file-sized changed block costs vscode-diff its whole 5 s budget. The diffs
// now run on a worker thread: these pin that they answer the same, that the
// extension host's thread stays free meanwhile, that a newer edit stops a
// stale diff, and that a worker that cannot run falls back to in-process.

// The worker from its TypeScript source, through tsx's require hook (a
// worker does not inherit `--import tsx`) — the shipped one is the same file
// bundled as dist/stagingWorker.js.
const ENTRY = fileURLToPath(new URL("../src/changes/stagingWorker.ts", import.meta.url));
const spawn = () =>
  new Worker(`require("tsx/cjs/api").register(); require(${JSON.stringify(ENTRY)});`, { eval: true });

const live: WorkerStagingMath[] = [];
after(() => {
  for (const m of live) m.dispose();
});
const math = (s: () => Worker = spawn) => {
  const m = new WorkerStagingMath(s);
  live.push(m);
  return m;
};

const N = 3000;
const head = "awesome\n".repeat(N);
const index = "terrifying\n".repeat(N);
const working = "terrifying\n".repeat(N / 2) + "\n" + "terrifying\n".repeat(N / 2);

test("the worker answers what the engine answers", async () => {
  const m = math();
  const a = "a\nb\nc\nd\n";
  const b = "a\nB\nc\nd\ne\n";
  assert.deepEqual(await m.changeBlocks(a, a, b), computeChangeBlocks(a, a, b));
  assert.deepEqual(await m.hunks(a, b), computeHunks(a, b));
  const ranges = computeHunks(a, b).slice(0, 1).map((h) => h.modified);
  assert.equal(await m.apply(a, b, ranges), applySelectedChanges(a, b, ranges));
});

test("a file-sized diff does not block the thread that asked for it", async () => {
  const m = math();
  await m.hunks("x\n", "y\n"); // the worker is up
  let lag = 0;
  let ticks = 0;
  let last = performance.now();
  const tick = setInterval(() => {
    const now = performance.now();
    lag = Math.max(lag, now - last - 10);
    last = now;
    ticks++;
  }, 10);
  const started = performance.now();
  const answer = m.changeBlocks(head, index, working);
  // An in-process diff would already have run, inside that call.
  const handedOff = performance.now() - started;
  const blocks = await answer;
  clearInterval(tick);
  const took = performance.now() - started;
  assert.equal(blocks.length, 1, "the whole file is one change");
  assert.ok(took > 500, `precondition: the diff itself is slow (${took.toFixed(0)} ms)`);
  assert.ok(handedOff < 50, `the call itself took ${handedOff.toFixed(0)} ms — the diff ran on the asking thread`);
  assert.ok(ticks > took / 40, `the asking thread ran ${ticks} timer ticks in ${took.toFixed(0)} ms`);
  assert.ok(lag < 250, `the asking thread was blocked for ${lag.toFixed(0)} ms while it ran`);
});

test("a newer job for the same document stops the stale one", async () => {
  const m = math();
  await m.hunks("x\n", "y\n");
  const stale = m.changeBlocks(head, index, working, "doc");
  const started = performance.now();
  const fresh = m.changeBlocks("a\n", "a\n", "b\n", "doc");
  await assert.rejects(stale, Superseded);
  assert.equal((await fresh).length, 1);
  assert.ok(performance.now() - started < 3000, "the fresh answer did not wait out the stale diff");
});

test("cancel drops a document's job; another document's is untouched", async () => {
  const m = math();
  const mine = m.changeBlocks(head, index, working, "mine");
  const theirs = m.changeBlocks("a\n", "a\n", "b\n", "theirs");
  m.cancel("mine");
  await assert.rejects(mine, Superseded);
  assert.equal((await theirs).length, 1);
});

test("a worker that cannot start or dies leaves the answers to the in-process diff", async () => {
  const cannot = math(() => {
    throw new Error("no workers here");
  });
  assert.deepEqual(await cannot.hunks("a\n", "b\n"), computeHunks("a\n", "b\n"));
  const dies = math(() => new Worker("process.exit(3)", { eval: true }));
  assert.deepEqual(await dies.hunks("a\n", "b\n"), computeHunks("a\n", "b\n"));
  assert.deepEqual(await dies.hunks("a\n", "c\n"), computeHunks("a\n", "c\n"));
});
