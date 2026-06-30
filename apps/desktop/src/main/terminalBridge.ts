// Integrated-terminal backend — a thin manager over node-pty PTY sessions.
//
// CONTRACT (do not change these signatures — main.ts + the renderer depend on
// them): construct with a `send` that forwards events to the renderer's
// webContents; `create` spawns an OS-appropriate login shell in `cwd` and
// streams its output back via the `terminal:data` event, emitting `terminal:exit`
// when it ends. node-pty is required LAZILY (it's a native module marked external
// in esbuild) so a missing/unbuilt binary degrades to `create` returning
// undefined rather than crashing the main process at import time.

import type { IPty } from "node-pty";
import type { TerminalSession } from "../shared/ipc";

/** Forwards a host→renderer IPC event (bound to the window's webContents). */
export type SendEvent = (channel: string, payload: unknown) => void;

/** The slice of node-pty we use — kept minimal so the lazy require stays typed. */
interface PtyModule {
  spawn(
    file: string,
    args: string[] | string,
    options: {
      name?: string;
      cols?: number;
      rows?: number;
      cwd?: string;
      env?: NodeJS.ProcessEnv;
    },
  ): IPty;
}

// Lazy native require: node-pty ships N-API prebuilds, but if the binary is
// missing/unbuilt we want graceful degradation (no terminal) rather than a crash
// at import time. `require` is used directly so esbuild keeps it external.
let pty: PtyModule | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  pty = require("node-pty") as PtyModule;
} catch {
  pty = undefined;
}

let counter = 0;

export class TerminalBridge {
  private readonly sessions = new Map<string, IPty>();

  constructor(private readonly send: SendEvent) {}

  /** Spawn a PTY login shell in `cwd`; returns the session, or undefined when
   *  node-pty is unavailable. Streams output via `terminal:data`. */
  create(opts: { cols: number; rows: number }, cwd: string | undefined): TerminalSession | undefined {
    if (!pty) return undefined;

    const shell =
      process.platform === "win32"
        ? process.env.COMSPEC || "powershell.exe"
        : process.env.SHELL || "/bin/bash";

    const id = `t${++counter}`;

    let p: IPty;
    try {
      p = pty.spawn(shell, [], {
        name: "xterm-color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: cwd || process.env.HOME || process.cwd(),
        env: process.env,
      });
    } catch {
      return undefined;
    }

    p.onData((data) => this.send("terminal:data", { id, data }));
    p.onExit(({ exitCode }) => {
      this.send("terminal:exit", { id, exitCode });
      this.sessions.delete(id);
    });

    this.sessions.set(id, p);
    return { id, shell };
  }

  /** Write user input to a session's PTY. */
  write(id: string, data: string): void {
    this.sessions.get(id)?.write(data);
  }

  /** Resize a session's PTY to the renderer's measured grid. */
  resize(id: string, cols: number, rows: number): void {
    if (cols < 1 || rows < 1) return;
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.resize(cols, rows);
    } catch {
      // The PTY may have exited between measure and resize — ignore.
    }
  }

  /** Kill one session. */
  kill(id: string): void {
    const session = this.sessions.get(id);
    if (!session) return;
    try {
      session.kill();
    } catch {
      // Already gone.
    }
    this.sessions.delete(id);
  }

  /** Kill every live session (on window close / repo switch). */
  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
  }
}
