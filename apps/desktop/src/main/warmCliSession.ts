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
import * as l10n from "@vscode/l10n";
import { CLI_SPECS, cliStartError, launchCli } from "./cliProvider";
import { ExpectedError } from "./expectedError";
import { launchOptions, stopProcess } from "./launcher";

/** A turn ended because the session was cancelled or disposed (Stop, a chat
 *  deleted, the app quitting): the user's doing, never a crash to report. */
function cancelled(): ExpectedError {
  return new ExpectedError(l10n.t("Session cancelled."));
}

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
  /** Bumped by dispose(), so a start still looking for `claude` when the
   *  session is disposed does not go on to leave a process behind. */
  private epoch = 0;
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
  async send(text: string, handlers: SendHandlers): Promise<string> {
    if (this.busy) {
      throw new Error(l10n.t("The session is still answering the previous message."));
    }
    this.clearIdle();
    // Claimed before the first await: a second message while `claude` is still
    // being found is refused like one sent while it answers.
    this.busy = true;
    let proc: ChildProcessWithoutNullStreams | undefined;
    try {
      if (!this.warm) {
        // Cancelled before anything started: start nothing.
        if (handlers.signal?.aborted) throw cancelled();
        await this.spawn();
        if (handlers.signal?.aborted) {
          this.dispose();
          throw cancelled();
        }
      }
      proc = this.proc;
      if (!proc) throw new Error(l10n.t("Couldn't start the Claude Code session."));
    } catch (err) {
      this.busy = false;
      throw err;
    }
    return new Promise<string>((resolve, reject) => {
      this.active = { onDelta: handlers.onDelta, resolve, reject, text: "", streamed: false, final: "" };
      const onAbort = () => {
        // Cancelling a turn means killing the process (Claude Code has no
        // mid-turn cancel over stdin); the next message respawns + resumes.
        this.dispose();
      };
      if (handlers.signal) {
        if (handlers.signal.aborted) {
          // Cancelled before the message went out (ai:cancel can land while the
          // caller is still saving the turn). dispose() has ended stdin and
          // failed the turn; a write now would be an 'error' event nobody
          // listens for — an uncaught exception in the main process.
          onAbort();
          return;
        }
        handlers.signal.addEventListener("abort", onAbort, { once: true });
      }
      try {
        proc.stdin.write(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n");
      } catch (err) {
        this.settle(reject, err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  dispose(): void {
    this.epoch++;
    this.clearIdle();
    const p = this.proc;
    this.proc = undefined;
    if (p && !p.killed) {
      try {
        p.stdin.end();
      } catch {
        /* ignore */
      }
      // The whole tree on Windows (launcher.ts): node.exe under a launcher
      // runs the program that holds the pipes.
      stopProcess(p, "SIGTERM");
    }
    // Fail any in-flight turn.
    if (this.active && this.busy) {
      const { reject } = this.active;
      this.active = undefined;
      this.busy = false;
      reject(cancelled());
    }
  }

  // ── internals ──

  private async spawn(): Promise<void> {
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
    // Found the way the one-shot provider finds it (cliProvider.launchCli).
    // The bare name on this GUI process's PATH is how a Claude Code that IS
    // installed came back "isn't installed": a Dock-launched app's PATH has
    // none of ~/.local/bin, Homebrew or npm's bin, and on Windows npm's
    // `claude.cmd` cannot be run by a spawn without a shell.
    const install = CLI_SPECS["claude-code"].install;
    const epoch = this.epoch;
    const launch = await launchCli("claude", args, install);
    if (epoch !== this.epoch) throw cancelled();
    const proc = spawn(launch.file, launch.args, {
      cwd: this.opts.cwd,
      ...launchOptions(launch),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc = proc;
    this.buffer = "";
    // A `claude` that exits while a message is on its way closes the pipe
    // under the write; that EPIPE is an event, and an unheard one is an
    // uncaught exception in the main process. The exit itself is reported
    // (below, on close).
    proc.stdin.on("error", () => {});
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (d: string) => this.onStdout(d));
    proc.stderr.on("data", () => {
      /* swallow logs; failures surface via close code */
    });
    proc.on("error", (err: NodeJS.ErrnoException) => {
      const e = cliStartError(err, "claude", install, this.opts.cwd);
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
        else a.reject(new Error(l10n.t("The Claude Code session ended unexpectedly.")));
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
