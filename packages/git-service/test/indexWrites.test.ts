import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeIndexWrite } from "../src/indexWrites";
import { stoppedIn } from "../src/stoppedOperation";
import { checkedOutElsewhere } from "../src/branchElsewhere";
import { GitProcess } from "../src/GitProcess";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// Edges of the small shared helpers every door leans on: the index-write
// queue, "what is git stopped in", "where else is this branch checked out",
// and blame's refusal.

const cleanup: Array<() => void> = [];
after(() => {
  for (const c of cleanup.splice(0)) c();
});

test("the index-write queue still serializes writes for a folder that does not exist (yet)", async () => {
  const root = join(tmpdir(), `gs-no-such-folder-${process.pid}-${Date.now()}`, "repo");
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((done) => (releaseFirst = done));
  const first = serializeIndexWrite(root, async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    return 1;
  });
  // The same folder spelled differently (a trailing segment resolved away)
  // shares the queue: it is keyed by the resolved path.
  const second = serializeIndexWrite(join(root, "sub", ".."), async () => {
    order.push("second:start");
    return 2;
  });
  // Let the microtask queue drain: the second must not have started.
  await new Promise((done) => setImmediate(done));
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ["first:start", "first:end", "second:start"]);
});

test("a failed write does not jam the queue: the next one still runs", async () => {
  const root = mkdtempSync(join(tmpdir(), "gs-index-fail-"));
  cleanup.push(() => removeTempRepo(root));
  const failed = serializeIndexWrite(root, async () => {
    throw new Error("boom");
  });
  const next = serializeIndexWrite(root, async () => "ran");
  await assert.rejects(failed, /boom/);
  assert.equal(await next, "ran");
});

test("stoppedIn claims nothing when git cannot be asked (an aborted signal)", async () => {
  const repo: Repo = makeRepo("stopped-abort");
  cleanup.push(() => repo.cleanup());
  repo.write("f.txt", "base\n");
  repo.commitAll("base");
  repo.git("checkout", "-q", "-b", "side");
  repo.write("f.txt", "side\n");
  repo.commitAll("side");
  repo.git("checkout", "-q", "master");
  repo.write("f.txt", "master\n");
  repo.commitAll("master");
  assert.notEqual(repo.tryGit("merge", "side"), 0, "the merge stops on a conflict");
  const proc = new GitProcess({ cwd: repo.root });
  cleanup.push(() => proc.dispose());
  const stop = await stoppedIn(proc);
  assert.deepEqual(stop, { operation: "merge", unmerged: 1 }, "a real stop is seen");
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(await stoppedIn(proc, aborted.signal), null, "an unanswerable question claims no stop");
});

test("checkedOutElsewhere answers undefined when git cannot list the branch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-elsewhere-norepo-"));
  cleanup.push(() => removeTempRepo(dir));
  const proc = new GitProcess({ cwd: dir });
  cleanup.push(() => proc.dispose());
  assert.equal(await checkedOutElsewhere(proc, "refs/heads/main"), undefined);
});

test("blame refuses loudly — naming the file and git's exit — for a path git does not know", async () => {
  const repo = makeRepo("blame-missing");
  cleanup.push(() => repo.cleanup());
  repo.write("f.txt", "x\n");
  repo.commitAll("base");
  const ctx = repo.ctx();
  await assert.rejects(ctx.blame.blameFile("nope.txt"), (err: Error) => {
    assert.match(err.message, /^git blame failed for nope\.txt \(exit \d+\): /);
    assert.match(err.message, /nope\.txt/);
    return true;
  });
  // A rev that does not exist is refused the same way.
  await assert.rejects(ctx.blame.blameFile("f.txt", { rev: "no-such-rev" }), /git blame failed for f\.txt/);
});

test("stoppedIn reports conflicted files with no operation (a stash pop that conflicted)", async () => {
  const repo: Repo = makeRepo("stopped-pop");
  cleanup.push(() => repo.cleanup());
  repo.write("f.txt", "base\n");
  repo.commitAll("base");
  repo.write("f.txt", "stashed\n");
  repo.git("stash", "push", "-q");
  repo.write("f.txt", "committed\n");
  repo.commitAll("moves on");
  assert.notEqual(repo.tryGit("stash", "pop"), 0, "the pop conflicts");
  const proc = new GitProcess({ cwd: repo.root });
  cleanup.push(() => proc.dispose());
  assert.deepEqual(await stoppedIn(proc), { unmerged: 1 });
});
