// A warm, long-lived Claude Code session: one `claude` process kept alive for a
// chat, fed messages over stdin (stream-json input) and streaming responses back
// over stdout. The first message pays the cold start; every later message in the
// same chat is fast because the process — and Claude Code's session — is still
// resident. It lives in the MAIN process, so a renderer refresh reconnects to it
// rather than killing it.
//
// On idle it disposes itself; the next message respawns and resumes the prior
// conversation via `--resume <sessionId>`, so context survives even a full app
// restart (the session id is persisted by the caller).

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

/** Idle a warm session for this long before disposing the process. */
const IDLE_MS = 5 * 60 * 1000;

export interface WarmSessionOptions {
  cwd: string | undefined;
  model?: string;
  /** Resume an existing Claude Code session (after an app restart). */
  resumeId?: string;
  /** Fired when the process exits (so the owner can drop its reference). */
  onExit?: () => void;
}

export interface SendHandlers {
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

interface ClaudeLine {
  type?: string;
  session_id?: string;
  result?: string;
  is_error?: boolean;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: Array<{ type?: string; text?: string }> };
}

const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export class WarmCliSession {
  private proc?: ChildProcessWithoutNullStreams;
  private sessionId?: string;
  private buffer = "";
  private busy = false;
  private idleTimer?: NodeJS.Timeout;
  /** Resolver for the in-flight turn (resolved on the `result` event). */
  private active?: {
    onDelta: (t: string) => void;
    resolve: (text: string) => void;
    reject: (e: Error) => void;
    text: string;
    streamed: boolean;
    final: string;
  };

  constructor(private readonly opts: WarmSessionOptions) {}

  /** Claude Code's session id for this chat (persist it to resume later). */
  get id(): string | undefined {
    return this.sessionId;
  }

  /** Whether the process is alive (a message will be warm rather than cold). */
  get warm(): boolean {
    return !!this.proc && !this.proc.killed;
  }

  /** Send one user message; streams assistant text via onDelta; resolves on completion. */
  send(text: string, handlers: SendHandlers): Promise<string> {
    if (this.busy) {
      return Promise.reject(new Error("The session is still answering the previous message."));
    }
    this.clearIdle();
    if (!this.warm) {
      this.spawn();
    }
    const proc = this.proc;
    if (!proc) {
      return Promise.reject(new Error("Couldn't start the Claude Code session."));
    }
    this.busy = true;
    return new Promise<string>((resolve, reject) => {
      this.active = { onDelta: handlers.onDelta, resolve, reject, text: "", streamed: false, final: "" };
      const onAbort = () => {
        // Cancelling a turn means killing the process (Claude Code has no
        // mid-turn cancel over stdin); the next message respawns + resumes.
        this.dispose();
      };
      if (handlers.signal) {
        if (handlers.signal.aborted) onAbort();
        else handlers.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
      } catch (err) {
        this.settle(reject, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.clearIdle();
    const p = this.proc;
    this.proc = undefined;
    if (p && !p.killed) {
      try {
        p.stdin.end();
      } catch {
        /* ignore */
      }
      p.kill("SIGTERM");
    }
    // Fail any in-flight turn.
    if (this.active && this.busy) {
      const { reject } = this.active;
      this.active = undefined;
      this.busy = false;
      reject(new Error("Session cancelled."));
    }
  }

  // ── internals ──

  private spawn(): void {
    const args = [
      "-p",
      "--strict-mcp-config",
      ...(this.opts.model ? ["--model", this.opts.model] : []),
      ...(this.sessionId || this.opts.resumeId ? ["--resume", (this.sessionId ?? this.opts.resumeId) as string] : []),
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ];
    const proc = spawn("claude", args, {
      cwd: this.opts.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => this.onStdout(d));
    proc.stderr.on("data", () => {
      /* swallow logs; failures surface via close code */
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      const e = err.code === "ENOENT" ? new Error("The `claude` CLI isn't installed or not on PATH.") : err;
      if (this.active && this.busy) this.settle(this.active.reject, e);
    });
    proc.on("close", () => {
      this.proc = undefined;
      if (this.active && this.busy) {
        // Process died mid-turn: resolve with whatever streamed (or fail).
        const a = this.active;
        this.active = undefined;
        this.busy = false;
        if (a.streamed || a.final) a.resolve((a.text || a.final).trim());
        else a.reject(new Error("The Claude Code session ended unexpectedly."));
      }
      this.opts.onExit?.();
    });
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let nl: number;
    while ((nl = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (line) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let o: ClaudeLine;
    try {
      o = JSON.parse(line) as ClaudeLine;
    } catch {
      return;
    }
    if (o.session_id && !this.sessionId) {
      this.sessionId = o.session_id;
    }
    const a = this.active;
    if (!a) return;

    if (o.type === "stream_event" && o.event?.type === "content_block_delta") {
      const d = o.event.delta;
      if (d?.type === "text_delta" && typeof d.text === "string") {
        const t = d.text.replace(ANSI, "");
        a.text += t;
        a.streamed = true;
        a.onDelta(t);
      }
      return;
    }
    if (o.type === "assistant" && Array.isArray(o.message?.content)) {
      const t = o.message!.content
        .filter((b) => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text as string)
        .join("");
      if (t) a.final = t;
      return;
    }
    if (o.type === "result") {
      if (!a.streamed && a.final) a.onDelta(a.final.replace(ANSI, ""));
      const out = (a.streamed ? a.text : a.final).trim();
      this.settle(a.resolve, out);
    }
  }

  private settle(fn: (v: never) => void, value: unknown): void {
    this.active = undefined;
    this.busy = false;
    this.scheduleIdle();
    (fn as (v: unknown) => void)(value);
  }

  private scheduleIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => this.dispose(), IDLE_MS);
  }
  private clearIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }
}
