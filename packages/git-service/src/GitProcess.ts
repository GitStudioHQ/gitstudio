import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export interface GitProcessOptions {
  cwd: string;
  /** Path to the git binary; defaults to "git". */
  gitPath?: string;
  /** Maximum number of concurrent git processes; defaults to 5. */
  maxConcurrent?: number;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface GitRunOptions {
  signal?: AbortSignal;
}

export interface GitRunWithInputOptions extends GitRunOptions {
  /**
   * Optional utf8 payload to write to the child's stdin (then end it). Used by
   * the BlameProvider to feed a dirty editor buffer via `git blame --contents -`.
   */
  input?: string;
}

/** Hardened config flags prepended to every invocation. */
const HARDENED_ARGS: readonly string[] = [
  "-c",
  "log.showSignature=false",
  "-c",
  "core.commitGraph=true",
];

function makeAbortError(): Error {
  // Node's own AbortError shape: name === "AbortError".
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}

/**
 * A bounded pool of spawned `git` CLI processes. Args are always passed as an
 * array (never a shell string), git runs in `cwd` with hardened config flags
 * and GIT_OPTIONAL_LOCKS=0, and at most `maxConcurrent` processes run at once.
 * This package must never import `vscode`.
 */
export class GitProcess {
  private readonly cwd: string;
  private readonly gitPath: string;
  private readonly maxConcurrent: number;

  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly children = new Set<ChildProcessWithoutNullStreams>();
  private disposed = false;

  constructor(opts: GitProcessOptions) {
    this.cwd = opts.cwd;
    this.gitPath = opts.gitPath ?? "git";
    this.maxConcurrent = opts.maxConcurrent ?? 5;
  }

  /** Acquire a concurrency slot, awaiting a free one when at the limit. */
  private acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(() => {
        this.active++;
        resolve();
      });
    });
  }

  private release(): void {
    this.active--;
    const next = this.waiters.shift();
    if (next) {
      next();
    }
  }

  private spawnChild(args: string[]): ChildProcessWithoutNullStreams {
    const child = spawn(this.gitPath, [...HARDENED_ARGS, ...args], {
      cwd: this.cwd,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    });
    this.children.add(child);
    return child;
  }

  /**
   * Run git to completion, buffering stdout/stderr as utf8. Resolves with the
   * exit code even when non-zero (the caller decides). Rejects if the process
   * fails to spawn, or — when `opts.signal` aborts — kills the child (SIGTERM)
   * and rejects with an AbortError (`err.name === "AbortError"`).
   *
   * When `opts.input` is set, that utf8 payload is written to the child's
   * stdin which is then ended — used to feed dirty buffers to
   * `git blame --contents -`.
   */
  async run(
    args: string[],
    opts?: GitRunWithInputOptions,
  ): Promise<GitRunResult> {
    const signal = opts?.signal;
    if (signal?.aborted) {
      throw makeAbortError();
    }

    await this.acquire();

    let child: ChildProcessWithoutNullStreams | undefined;
    try {
      return await new Promise<GitRunResult>((resolve, reject) => {
        const spawned = this.spawnChild(args);
        child = spawned;

        // Feed a dirty buffer via stdin when requested, then close it so git
        // sees EOF. A broken pipe (git exits before draining) is harmless here.
        if (opts?.input !== undefined) {
          spawned.stdin.on("error", () => {});
          spawned.stdin.end(opts.input);
        }

        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        let settled = false;

        const cleanup = () => {
          if (signal) {
            signal.removeEventListener("abort", onAbort);
          }
          this.children.delete(spawned);
        };

        const onAbort = () => {
          if (settled) {
            return;
          }
          settled = true;
          spawned.kill("SIGTERM");
          cleanup();
          reject(makeAbortError());
        };

        if (signal) {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        spawned.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
        spawned.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

        spawned.on("error", (err) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          reject(err);
        });

        spawned.on("close", (code) => {
          if (settled) {
            return;
          }
          settled = true;
          cleanup();
          resolve({
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
            code: code ?? 0,
          });
        });
      });
    } finally {
      this.release();
    }
  }

  /**
   * Stream git stdout as utf8 chunks as they arrive, using a pull/queue pattern
   * so stdout is never accumulated unbounded. Kills the child and ends the
   * stream on abort (throwing an AbortError). A non-zero exit throws with the
   * collected stderr so callers notice failures.
   */
  async *stream(
    args: string[],
    opts?: GitRunOptions,
  ): AsyncGenerator<string> {
    const signal = opts?.signal;
    if (signal?.aborted) {
      throw makeAbortError();
    }

    await this.acquire();

    const spawned = this.spawnChild(args);
    const decoder = new TextDecoder("utf8");

    // Pull/push queue: producers push chunks (or a terminal marker), the
    // generator pulls one at a time.
    const queue: string[] = [];
    let resolveNext: (() => void) | undefined;
    let ended = false;
    let failure: Error | undefined;
    let exitCode: number | null = null;
    const stderr: Buffer[] = [];

    const wake = () => {
      const r = resolveNext;
      resolveNext = undefined;
      if (r) {
        r();
      }
    };

    const onAbort = () => {
      if (ended) {
        return;
      }
      failure = makeAbortError();
      spawned.kill("SIGTERM");
      ended = true;
      wake();
    };

    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }

    spawned.stdout.on("data", (chunk: Buffer) => {
      queue.push(decoder.decode(chunk, { stream: true }));
      wake();
    });
    spawned.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));

    spawned.on("error", (err) => {
      if (ended) {
        return;
      }
      failure = err;
      ended = true;
      wake();
    });

    spawned.on("close", (code) => {
      if (ended) {
        return;
      }
      exitCode = code;
      const tail = decoder.decode();
      if (tail) {
        queue.push(tail);
      }
      ended = true;
      wake();
    });

    try {
      while (true) {
        if (queue.length > 0) {
          yield queue.shift()!;
          continue;
        }
        if (failure) {
          throw failure;
        }
        if (ended) {
          break;
        }
        await new Promise<void>((resolve) => {
          resolveNext = resolve;
        });
      }

      if (failure) {
        throw failure;
      }
      if (exitCode !== null && exitCode !== 0) {
        const message = Buffer.concat(stderr).toString("utf8").trim();
        throw new Error(
          `git ${args.join(" ")} exited with code ${exitCode}` +
            (message ? `: ${message}` : ""),
        );
      }
    } finally {
      if (signal) {
        signal.removeEventListener("abort", onAbort);
      }
      if (spawned.exitCode === null && spawned.signalCode === null) {
        spawned.kill("SIGTERM");
      }
      this.children.delete(spawned);
      this.release();
    }
  }

  /** Kill any in-flight children. */
  dispose(): void {
    this.disposed = true;
    for (const child of this.children) {
      child.kill("SIGTERM");
    }
    this.children.clear();
  }

  /** Whether dispose() has been called. */
  get isDisposed(): boolean {
    return this.disposed;
  }
}
