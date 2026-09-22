import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { GitProcess } from "../src/GitProcess";
import { removeTempRepo } from "./tmpRepo";

// GitProcess.stream() learned stdin (for `git log --stdin`, the branch
// filter's way round Windows' 32k command line). Three rules come with it,
// and each is pinned against a real git child here:
//
//   1. the input arrives, and stdin is then ENDED;
//   2. with no input stdin is ended EMPTY — before, stream() never touched
//      it, so any command that reads stdin waited forever on a pipe nobody
//      would write to;
//   3. however the consumer stops — breaking out of its for-await, or its
//      signal aborting — while megabytes of stdin are still unwritten, the
//      child is killed, the concurrency slot comes back, and the pending
//      write's EPIPE is swallowed rather than crashing the host.

let repo: string;
const EMPTY_BLOB = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
const HELLO_BLOB = "ce013625030ba8dba906f756967f9e9ca394464a"; // "hello\n"

before(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-stdin-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", "-q", repo]);
  execFileSync("git", ["-c", "user.email=d@e", "-c", "user.name=D", "commit", "-q", "--allow-empty", "-m", "one"], {
    cwd: repo,
  });
});

after(() => removeTempRepo(repo));

async function collect(it: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of it) out += chunk;
  return out;
}

test("stream hands its input to the child, then ends stdin", async () => {
  const proc = new GitProcess({ cwd: repo });
  try {
    const out = await collect(
      proc.stream(["hash-object", "--stdin"], { input: "hello\n", signal: AbortSignal.timeout(10_000) }),
    );
    assert.equal(out.trim(), HELLO_BLOB);
  } finally {
    proc.dispose();
  }
});

test("stream with NO input still ends stdin: a command that reads it gets EOF, not a hang", async () => {
  // The timeout turns the old hang into a failure: hash-object --stdin blocks
  // reading a stdin that stream() used to leave open.
  const proc = new GitProcess({ cwd: repo });
  try {
    const out = await collect(proc.stream(["hash-object", "--stdin"], { signal: AbortSignal.timeout(10_000) }));
    assert.equal(out.trim(), EMPTY_BLOB, "the empty blob: git read EOF straight away");
  } finally {
    proc.dispose();
  }
});

test("a large input reaches the child whole — nothing is dropped at the pipe's capacity", async () => {
  // A pipe holds ~64KB; node has to keep feeding it as git drains it.
  const proc = new GitProcess({ cwd: repo });
  try {
    const input = "x".repeat(8 * 1024 * 1024);
    const out = await collect(proc.stream(["hash-object", "--stdin"], { input, signal: AbortSignal.timeout(30_000) }));
    const truth = execFileSync("git", ["hash-object", "--stdin"], { cwd: repo, input, encoding: "utf8" }).trim();
    assert.equal(out.trim(), truth);
  } finally {
    proc.dispose();
  }
});

/**
 * Is any process still running whose command line carries `marker`? A `-c`
 * config pair the child ignores is the marker, so a match can only be the
 * child this test spawned. `ps` is POSIX; on Windows the question is not asked.
 */
function running(marker: string): boolean {
  const out = execFileSync("ps", ["-Ao", "command"], { encoding: "utf8" });
  return out.split("\n").some((l) => l.includes(marker) && !l.includes("ps -Ao"));
}

async function gone(marker: string, ms: number): Promise<boolean> {
  const t0 = Date.now();
  while (running(marker)) {
    if (Date.now() - t0 > ms) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

// `cat-file --batch-check` answers one line per line of stdin, as it reads.
// 100,000 lookups take it several SECONDS (measured: ~4.7s), so a child that
// is gone within a fraction of that was killed, not finished. And the input
// is 500KB — far past what a pipe buffers — so node is still writing it when
// the consumer walks away.
const LINES = 100_000;
const INPUT = "HEAD\n".repeat(LINES);
const CAN_ASK_PS = process.platform !== "win32";

for (const how of ["breaks out of its loop", "aborts its signal"] as const) {
  test(`a consumer that ${how} mid-stream leaves no child, no slot and no crash behind`, async () => {
    const marker = `gitstudio.stdintest=${randomUUID()}`;
    // ONE slot: if the stream kept it, the run() below would wait forever.
    const proc = new GitProcess({ cwd: repo, maxConcurrent: 1 });
    const uncaught: unknown[] = [];
    const onUncaught = (e: unknown) => void uncaught.push(e);
    process.on("uncaughtException", onUncaught);
    try {
      const ac = new AbortController();
      // A backstop, so a stream that never yields fails this test rather than
      // hanging the suite: without its input the child waits on stdin forever.
      const backstop = AbortSignal.timeout(20_000);
      let chunks = 0;
      let threw: unknown;
      try {
        for await (const chunk of proc.stream(["-c", marker, "cat-file", "--batch-check"], {
          input: INPUT,
          signal: AbortSignal.any([ac.signal, backstop]),
        })) {
          assert.ok(chunk.length > 0);
          chunks++;
          if (how === "breaks out of its loop") break;
          ac.abort();
        }
      } catch (e) {
        threw = e;
      }
      const stoppedAt = Date.now();
      assert.ok(!backstop.aborted, "the child answered — its input arrived");
      assert.equal(chunks, 1, "the consumer stopped after its first chunk");
      if (how === "aborts its signal") {
        assert.equal((threw as Error | undefined)?.name, "AbortError", "an abort surfaces as an AbortError");
      } else {
        assert.equal(threw, undefined, "a break is not an error");
      }
      // The slot is back: this would queue behind the stream otherwise.
      const r = await proc.run(["rev-parse", "HEAD"], { signal: AbortSignal.timeout(5_000) });
      assert.equal(r.code, 0);
      if (CAN_ASK_PS) {
        assert.ok(await gone(marker, 1_500), "the child is gone — killed, since finishing takes it seconds");
        assert.ok(Date.now() - stoppedAt < 2_000);
      }
      // Give a pending EPIPE on the dropped stdin every chance to surface.
      await new Promise((r) => setTimeout(r, 200));
      assert.deepEqual(uncaught, [], "a write to a killed child's stdin is not the host's crash");
    } finally {
      process.off("uncaughtException", onUncaught);
      proc.dispose();
    }
  });
}

test("a child that exits without reading its input does not crash the host", async () => {
  // git rev-parse never reads stdin: it exits at once, and node is left
  // writing a few MB into a pipe with no reader — EPIPE, on a stream nobody
  // is waiting on. Unlistened, that 'error' event is an uncaught exception.
  const proc = new GitProcess({ cwd: repo });
  const uncaught: unknown[] = [];
  const onUncaught = (e: unknown) => void uncaught.push(e);
  process.on("uncaughtException", onUncaught);
  try {
    const out = await collect(
      proc.stream(["rev-parse", "HEAD"], { input: "x".repeat(4 * 1024 * 1024), signal: AbortSignal.timeout(10_000) }),
    );
    assert.match(out.trim(), /^[0-9a-f]{40}$/);
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(uncaught, []);
  } finally {
    process.off("uncaughtException", onUncaught);
    proc.dispose();
  }
});
