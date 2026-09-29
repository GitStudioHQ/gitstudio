// Test doubles for the desktop's AI layer: Electron's `app`, and the agent CLIs
// (`claude`, `codex`, `gemini`) the main process spawns.
//
// Import this FIRST in a test file. From then on:
//
//   · `import { app } from "electron"` resolves to a stub whose
//     `app.getPath("userData")` is a temp folder the test chooses
//     (setUserData) — the real Electron never loads, and nothing is written
//     under the developer's own profile;
//   · `child_process.spawn` of one of the agent CLIs returns a FakeChild the
//     test scripts, instead of a real process. Every other command (git, above
//     all) still runs for real, so a bridge under test reads a real repository.
//
// Never a real `claude`/`codex`/`gemini`, never the network: the HTTP providers
// are faked per test through globalThis.fetch.

import Module from "node:module";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// ── electron ──────────────────────────────────────────────────────────────────

let userData = mkdtempSync(join(tmpdir(), "gs-ai-userdata-"));

/** Point `app.getPath("userData")` at `dir` (for the next reads). */
export function setUserData(dir: string): void {
  userData = dir;
}

export const fakeApp = {
  getPath: (name: string): string => {
    if (name === "userData") return userData;
    return join(userData, name);
  },
  isPackaged: false,
  getAppPath: (): string => userData,
};

const FAKE_ELECTRON = join(__dirname, "__fake_electron__.js");
type Resolve = (request: string, ...rest: unknown[]) => string;
const mod = Module as unknown as {
  _resolveFilename: Resolve;
  _cache: Record<string, unknown>;
};
const originalResolve = mod._resolveFilename;
mod._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
  return request === "electron" ? FAKE_ELECTRON : originalResolve.call(this, request, ...rest);
};
{
  const m = new Module(FAKE_ELECTRON) as Module & { loaded: boolean; filename: string };
  m.filename = FAKE_ELECTRON;
  m.loaded = true;
  m.exports = { app: fakeApp };
  mod._cache[FAKE_ELECTRON] = m;
}

// ── child processes ──────────────────────────────────────────────────────────

/** A scripted stand-in for a spawned CLI process. */
export class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  killed = false;
  killSignal: string | undefined;
  exited = false;
  /** Every line the parent wrote to stdin. */
  readonly stdinLines: string[] = [];
  private stdinBuf = "";
  private readonly stdinListeners: ((line: string) => void)[] = [];

  constructor(
    readonly command: string,
    readonly args: string[],
    readonly options: { cwd?: string; stdio?: unknown } | undefined,
  ) {
    super();
    this.stdin.setEncoding("utf8");
    this.stdin.on("data", (d: string) => {
      this.stdinBuf += d;
      let nl: number;
      while ((nl = this.stdinBuf.indexOf("\n")) !== -1) {
        const line = this.stdinBuf.slice(0, nl);
        this.stdinBuf = this.stdinBuf.slice(nl + 1);
        this.stdinLines.push(line);
        for (const fn of this.stdinListeners) fn(line);
      }
    });
  }

  /** Run `fn` for every line written to stdin — those already written first. */
  onStdinLine(fn: (line: string) => void): void {
    this.stdinListeners.push(fn);
    for (const line of this.stdinLines) fn(line);
  }

  /** Write to stdout. */
  out(text: string): void {
    this.stdout.write(text);
  }

  /** Write one JSON event line to stdout. */
  json(obj: unknown): void {
    this.stdout.write(JSON.stringify(obj) + "\n");
  }

  err(text: string): void {
    this.stderr.write(text);
  }

  /**
   * Exit with `code`: close stdio, and only once every byte has been read,
   * emit `exit` and `close` — the order a real ChildProcess keeps.
   */
  async exit(code: number | null, signal: string | null = null): Promise<void> {
    if (this.exited) return;
    this.exited = true;
    const ends: Promise<unknown>[] = [];
    for (const s of [this.stdout, this.stderr]) {
      if (!s.readableEnded) {
        ends.push(once(s, "end"));
        s.end();
        s.resume();
      }
    }
    await Promise.all(ends);
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  /** Fail to start (e.g. ENOENT) — the `error` event a real spawn emits. */
  fail(code: string, message = `spawn ${this.command} ${code}`): void {
    const e = Object.assign(new Error(message), { code });
    this.exited = true;
    this.emit("error", e);
  }

  kill(signal = "SIGTERM"): boolean {
    if (this.killed) return false;
    this.killed = true;
    this.killSignal = signal;
    setImmediate(() => void this.exit(null, signal));
    return true;
  }
}

/** What a test says happens when a CLI is spawned. */
export type SpawnScript = (child: FakeChild) => void;

/** The CLIs that are never really run. */
export const FAKE_COMMANDS = new Set(["claude", "codex", "gemini"]);

const cp = require("node:child_process") as typeof import("node:child_process");
const realSpawn = cp.spawn;

export const spawned: FakeChild[] = [];
const scripts: SpawnScript[] = [];
let fallbackScript: SpawnScript | undefined;
let throwOnSpawn: Error | undefined;
const configurers: ((child: FakeChild) => void)[] = [];

/** Script the NEXT spawned CLI (queued in order). */
export function onNextSpawn(script: SpawnScript): void {
  scripts.push(script);
}
/** Script every CLI spawn that has no queued script. */
export function onEverySpawn(script: SpawnScript | undefined): void {
  fallbackScript = script;
}
/** Adjust the NEXT spawned child before spawn() returns it (e.g. break its stdin). */
export function configureNextChild(fn: (child: FakeChild) => void): void {
  configurers.push(fn);
}
/** Make the next CLI spawn throw synchronously. */
export function throwOnNextSpawn(err: Error): void {
  throwOnSpawn = err;
}
/** Forget every scripted behaviour and recorded child. */
export function resetSpawns(): void {
  spawned.length = 0;
  scripts.length = 0;
  fallbackScript = undefined;
  throwOnSpawn = undefined;
  configurers.length = 0;
}

(cp as { spawn: unknown }).spawn = function fakeSpawn(command: string, args?: unknown, options?: unknown) {
  if (!FAKE_COMMANDS.has(command)) {
    return (realSpawn as (...a: unknown[]) => unknown)(command, args, options);
  }
  if (throwOnSpawn) {
    const e = throwOnSpawn;
    throwOnSpawn = undefined;
    throw e;
  }
  const child = new FakeChild(command, [...((args as string[]) ?? [])], options as FakeChild["options"]);
  spawned.push(child);
  configurers.shift()?.(child);
  const script = scripts.shift() ?? fallbackScript;
  if (script) setImmediate(() => script(child));
  return child;
};

/** Wait until `pred` holds, polling on the event loop (never a fixed sleep). */
export async function until(pred: () => boolean, what = "condition", capMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > capMs) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setImmediate(r));
  }
}
