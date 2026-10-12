// Crash reports 35 and 36: console output to a terminal that has gone away.
//
// A real hung-up terminal cannot be made portably in a test, so the streams
// here behave the way one was measured to (Electron 41's Node, a pty whose
// other end was closed): every write fails with EIO, raised as an 'error'
// event a tick later — or, for a stdout that is a file, thrown by the write
// itself. Unlistened, each of those events is an uncaught exception.

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Console } from "node:console";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { quietOnFailure } from "../src/main/quietOutput";

const eio = (): Error => Object.assign(new Error("write EIO"), { code: "EIO", errno: -5, syscall: "write" });
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

/** A terminal that hung up: each write reaches it, then fails a tick later. */
class HungUpTerminal extends EventEmitter {
  writes = 0;
  write(_chunk: unknown, ..._rest: unknown[]): boolean {
    this.writes++;
    process.nextTick(() => this.emit("error", eio()));
    return true;
  }
}

/** A stdout that is a file on a failing device: the write itself throws. */
class FailingFile extends EventEmitter {
  writes = 0;
  write(_chunk: unknown, ..._rest: unknown[]): boolean {
    this.writes++;
    throw eio();
  }
}

test("a failed write to a hung-up terminal is listened for, and the terminal is not written to again", async () => {
  const tty = new HungUpTerminal();
  quietOnFailure(tty);
  const console = new Console({ stdout: tty as never, stderr: tty as never });
  for (let i = 0; i < 5; i++) {
    console.info("Checking for update");
    console.error("GitStudio main: uncaught exception:", eio());
    // Each EIO arrives on its own tick, as the terminal's did. Unlistened, this
    // is where the test process would get its uncaught "write EIO".
    await tick();
  }
  assert.equal(tty.writes, 2, "the two writes of the first tick; nothing after the failure");
  // The 'error' event itself, emitted again, has a listener: no throw.
  assert.doesNotThrow(() => tty.emit("error", eio()));
});

test("a write that THROWS the failure is dropped too, and so is every one after it", () => {
  const file = new FailingFile();
  quietOnFailure(file);
  assert.equal(file.write("one\n"), true);
  assert.equal(file.write("two\n"), true);
  assert.equal(file.writes, 1);
});

test("the uncaught-exception handler logging what it caught can no longer feed itself", async () => {
  // main.ts's handler logs with console.error. On the hung-up terminal that
  // log raised another EIO, which reached the same handler: a loop.
  const tty = new HungUpTerminal();
  quietOnFailure(tty);
  const console = new Console({ stdout: tty as never, stderr: tty as never });
  let handled = 0;
  const handler = (err: unknown): void => {
    handled++;
    // Bounded, so a regression fails here instead of spinning forever.
    if (handled > 50) return;
    console.error("GitStudio main: uncaught exception:", err);
  };
  tty.on("error", handler);
  handler(new Error("some other bug"));
  for (let i = 0; i < 20; i++) await tick();
  // The one EIO the first log produced reached the handler once; its own log
  // went nowhere, so there was no second.
  assert.equal(handled, 2);
  assert.equal(tty.writes, 1);
});

test("a dropped write still acknowledges its callback, and guarding twice changes nothing", async () => {
  const file = new FailingFile();
  quietOnFailure(file);
  quietOnFailure(file);
  assert.equal(file.listenerCount("error"), 1);
  let acked = 0;
  file.write("x", () => acked++);
  file.write("y", "utf8", () => acked++);
  await tick();
  assert.equal(acked, 2);
});

test("main.ts guards its output before anything else runs", async () => {
  const main = await readFile(fileURLToPath(new URL("../src/main/main.ts", import.meta.url)), "utf8");
  const call = main.indexOf("\nquietProcessOutput();");
  assert.ok(call > 0, "main.ts calls quietProcessOutput()");
  for (const later of ["app.setName(", 'process.on("uncaughtException"', "initAutoUpdate("]) {
    const at = main.indexOf(later);
    assert.ok(at > call, `${later} comes after the guard`);
  }
});
