import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitProcess, type GitRunEvent } from "../src/GitProcess";
import { makeRepo, type Repo } from "./opRepo";
import { removeTempRepo } from "./tmpRepo";

// GitProcess's contract with every provider: run() resolves with the exit code
// (never throws on a refusal) and rejects only when git could not run or the
// caller aborted; stream() throws on a failed exit so a partial answer never
// passes for a whole one; the pool never runs more than its cap at once; and
// the run observer can neither break a run nor miss a failure.

function repoWithCommit(name: string): Repo {
  const r = makeRepo(name);
  r.write("a.txt", "a\n");
  r.commitAll("base");
  return r;
}

async function drain(it: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of it) out += chunk;
  return out;
}

const missingGit = (): string => join(tmpdir(), `gs-no-such-git-${process.pid}-${Date.now()}`);

test("an observer that throws cannot break the run it observes", async () => {
  const r = repoWithCommit("gp-observer");
  try {
    let calls = 0;
    const proc = new GitProcess({
      cwd: r.root,
      onRun: () => {
        calls++;
        throw new Error("observer blew up");
      },
    });
    const res = await proc.run(["rev-parse", "HEAD"]);
    assert.equal(res.code, 0);
    assert.equal(res.stdout.trim(), r.sha("HEAD"));
    assert.equal(calls, 1, "the observer was called, and its throw swallowed");
    // A stream too: its report runs in the generator's finally.
    const streamed = await drain(proc.stream(["rev-parse", "HEAD"]));
    assert.equal(streamed.trim(), r.sha("HEAD"));
    assert.equal(calls, 2);
  } finally {
    r.cleanup();
  }
});

test("the observer sees the meaningful args, the exit code, and stderr only on failure", async () => {
  const r = repoWithCommit("gp-events");
  try {
    const events: GitRunEvent[] = [];
    const proc = new GitProcess({ cwd: r.root, onRun: (e) => events.push(e) });
    await proc.run(["rev-parse", "HEAD"]);
    const bad = await proc.run(["rev-parse", "--verify", "no-such-ref"]);
    assert.notEqual(bad.code, 0, "a refusal resolves with its code");
    assert.deepEqual(events[0].args, ["rev-parse", "HEAD"], "the hardened -c flags are not reported");
    assert.equal(events[0].failed, false);
    assert.equal(events[0].stderr, undefined);
    assert.equal(events[1].failed, true);
    assert.equal(events[1].exitCode, bad.code);
    assert.match(events[1].stderr ?? "", /no-such-ref|fatal/);
  } finally {
    r.cleanup();
  }
});

test("a git that cannot be spawned REJECTS run(), and the observer records it as a failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-gp-spawn-"));
  try {
    const events: GitRunEvent[] = [];
    const proc = new GitProcess({ cwd: dir, gitPath: missingGit(), onRun: (e) => events.push(e) });
    await assert.rejects(proc.run(["status"]), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
    assert.equal(events.length, 1);
    assert.equal(events[0].exitCode, null, "no exit code — it never ran");
    assert.equal(events[0].failed, true);
    assert.match(events[0].stderr ?? "", /ENOENT/, "the spawn error explains why");
    // The failed spawn gave its slot back: a later run is not stuck behind it.
    const again = new GitProcess({ cwd: dir, gitPath: missingGit(), maxConcurrent: 1 });
    await assert.rejects(again.run(["status"]));
    await assert.rejects(again.run(["status"]), "a second run still gets a slot");
  } finally {
    removeTempRepo(dir);
  }
});

test("a git that cannot be spawned makes stream() throw, and is reported as failed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gs-gp-spawn-s-"));
  try {
    const events: GitRunEvent[] = [];
    const proc = new GitProcess({ cwd: dir, gitPath: missingGit(), onRun: (e) => events.push(e) });
    await assert.rejects(drain(proc.stream(["log"])), (err: NodeJS.ErrnoException) => err.code === "ENOENT");
    assert.equal(events.length, 1);
    assert.equal(events[0].failed, true);
    assert.equal(events[0].exitCode, null);
  } finally {
    removeTempRepo(dir);
  }
});

test("stream() with an already-aborted signal throws AbortError without starting git", async () => {
  const r = repoWithCommit("gp-preabort");
  try {
    const events: GitRunEvent[] = [];
    const proc = new GitProcess({ cwd: r.root, onRun: (e) => events.push(e) });
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(drain(proc.stream(["log"], { signal: ac.signal })), { name: "AbortError" });
    await assert.rejects(proc.run(["log"], { signal: ac.signal }), { name: "AbortError" });
    assert.equal(events.length, 0, "nothing ran, so nothing is reported");
  } finally {
    r.cleanup();
  }
});

test("stream() of a failing command throws with git's exit code and stderr", async () => {
  const r = repoWithCommit("gp-stream-fail");
  try {
    const events: GitRunEvent[] = [];
    const proc = new GitProcess({ cwd: r.root, onRun: (e) => events.push(e) });
    await assert.rejects(
      drain(proc.stream(["log", "no-such-branch"])),
      (err: Error) => /^git log no-such-branch exited with code 128: /.test(err.message) && /no-such-branch/.test(err.message),
    );
    assert.equal(events.at(-1)?.failed, true);
    assert.equal(events.at(-1)?.exitCode, 128);
  } finally {
    r.cleanup();
  }
});

test("stream() of a non-zero exit with NO stderr still throws — after yielding what git wrote", async () => {
  const r = repoWithCommit("gp-stream-quiet");
  try {
    r.write("a.txt", "changed\n");
    const proc = new GitProcess({ cwd: r.root });
    const got: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const c of proc.stream(["diff", "--exit-code", "--no-color"])) got.push(c);
      })(),
      (err: Error) => err.message === "git diff --exit-code --no-color exited with code 1",
    );
    assert.match(got.join(""), /\+changed/, "the diff itself arrived before the failure");
  } finally {
    r.cleanup();
  }
});

test("stream() keeps a truncated UTF-8 sequence at the very end instead of dropping it", async () => {
  const r = repoWithCommit("gp-stream-tail");
  try {
    // "ok " then the first two bytes of "€" (E2 82 AC) — the output ends mid-character.
    r.write("tail.bin", Buffer.from([0x6f, 0x6b, 0x20, 0xe2, 0x82]));
    const blob = r.git("hash-object", "-w", "tail.bin").trim();
    const proc = new GitProcess({ cwd: r.root });
    const out = await drain(proc.stream(["cat-file", "blob", blob]));
    assert.equal(out, "ok �", "the dangling bytes surface as one replacement character");
  } finally {
    r.cleanup();
  }
});

test("with a pool of one, a run waits for the slot a live stream holds", async () => {
  const r = repoWithCommit("gp-pool");
  try {
    const order: string[] = [];
    const proc = new GitProcess({ cwd: r.root, maxConcurrent: 1, onRun: (e) => order.push(e.args[0]) });
    const stream = proc.stream(["log", "--format=%H"]);
    const first = await stream.next(); // the stream now holds the only slot
    assert.equal(first.done, false);
    const queued = proc.run(["rev-parse", "HEAD"]);
    // Give the queued run every chance to jump the queue: a separate process
    // runs several gits to completion meanwhile.
    const other = new GitProcess({ cwd: r.root });
    for (let i = 0; i < 3; i++) await other.run(["rev-parse", "HEAD"]);
    assert.deepEqual(order, [], "the queued run has not run while the stream holds the slot");
    for (let n = await stream.next(); !n.done; n = await stream.next()) {
      /* drain */
    }
    const res = await queued;
    assert.equal(res.stdout.trim(), r.sha("HEAD"));
    assert.deepEqual(order, ["log", "rev-parse"], "the stream finished first, then the queued run took its slot");
    // And the slot is free again afterwards.
    assert.equal((await proc.run(["rev-parse", "HEAD"])).code, 0);
  } finally {
    r.cleanup();
  }
});

test("isDisposed is false until dispose(), and at() is a separate pool in another folder", async () => {
  const r = repoWithCommit("gp-dispose");
  const elsewhere = makeRepo("gp-dispose-other");
  try {
    elsewhere.write("b.txt", "b\n");
    const otherHead = elsewhere.commitAll("other");
    const events: GitRunEvent[] = [];
    const proc = new GitProcess({ cwd: r.root, onRun: (e) => events.push(e) });
    const there = proc.at(elsewhere.root);
    assert.equal(there.cwd, elsewhere.root);
    assert.equal(proc.isDisposed, false);
    proc.dispose();
    assert.equal(proc.isDisposed, true);
    assert.equal(there.isDisposed, false, "disposing one pool does not dispose the other");
    const res = await there.run(["rev-parse", "HEAD"]);
    assert.equal(res.stdout.trim(), otherHead, "runs in its own folder");
    assert.equal(events.length, 1, "with the same observer");
  } finally {
    r.cleanup();
    elsewhere.cleanup();
  }
});

test(
  "a git killed by a signal after writing to stderr keeps that text and adds why it stopped",
  { skip: process.platform === "win32" ? "the stand-in git is a shell script" : false },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "gs-gp-sig-"));
    try {
      const bin = join(dir, "git");
      writeFileSync(bin, '#!/bin/sh\necho "warning: half done" >&2\nkill -TERM $$\n');
      chmodSync(bin, 0o755);
      const proc = new GitProcess({ cwd: dir, gitPath: bin });
      const res = await proc.run(["status"]);
      assert.equal(res.code, 128 + 15);
      assert.equal(res.stderr, "warning: half done\ngit was stopped by SIGTERM before it finished.");
    } finally {
      removeTempRepo(dir);
    }
  },
);
