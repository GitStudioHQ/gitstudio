// A Provider that drives a locally-installed agent CLI — Claude Code (`claude`),
// Codex (`codex`), or the Gemini CLI (`gemini`) — in non-interactive mode, using
// the CLI's OWN login/subscription instead of an API key. This is how GitStudio
// "works with local claude code / codex" alongside BYO-key HTTP providers.
//
// It implements the same @gitstudio/ai `Provider` interface the HTTP providers
// do, so the tasks and the Assistant use it transparently. It can't live in the
// host-agnostic core (it spawns a process), so it lives here in the main process.
// Tool-calling isn't exposed over the CLI boundary (`supportsTools = false`); the
// CLI is its own agent, so for the Assistant it answers the goal directly,
// grounded in the repo it's run inside.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as l10n from "@vscode/l10n";
import { AiError, type ChatMessage, type ChatOptions, type ChatResult, type ModelTier, type Provider } from "@gitstudio/ai/index";
import { launchOptions, prepareLaunch, stopProcess, type Launch } from "./launcher";
import { missingFolderMessage } from "./repoNotice";

/**
 * The CLI cannot be run on this machine as it is set up — not installed, or
 * installed through a launcher whose runtime is missing. That is the user's
 * setup, not a defect: `expected` keeps it out of the crash reporter (see
 * main/expectedError.ts), and the message says what to install.
 */
export class CliUnavailableError extends AiError {
  readonly expected = true as const;
  constructor(message: string) {
    // `configuration`: the cause is the user's machine, not the request built.
    super(message, undefined, false, true);
  }
}

/** The sentence for a CLI that is not on this machine. */
export function cliMissingMessage(command: string, install: string): string {
  return l10n.t("The `{0}` CLI isn't installed or not on PATH. {1}", command, install);
}

/**
 * Find `command` and say how to start it with `args`, or throw what stops it.
 * Shared by the one-shot provider, `detectCli` and the warm Claude Code session
 * (warmCliSession.ts), so all three find a CLI the same way.
 */
export async function launchCli(command: string, args: readonly string[], install: string): Promise<Launch> {
  const r = await prepareLaunch(command, args);
  if (r.ok) return r.launch;
  if (r.reason === "missing") throw new CliUnavailableError(cliMissingMessage(command, install));
  if (r.reason === "needs-node") {
    throw new CliUnavailableError(
      l10n.t("Found `{0}` at {1}, but it runs on Node.js, which isn't installed or not on PATH. Install Node.js, or install {0} with its own installer.", command, r.found),
    );
  }
  // A launcher we found and cannot hand these arguments to safely (only flags
  // and a model id ever travel as arguments — the prompt goes on stdin): ours
  // to learn about, so it reports.
  throw new AiError(l10n.t("Found `{0}` at {1}, but GitStudio can't start it from that launcher.", command, r.found));
}

/**
 * What a CLI that failed to START is, in words. ENOENT after the program was
 * found means its folder (the repository it runs in) or the program itself
 * went away under us. Node's own "spawn <path> EACCES" is never passed on as
 * is: the desktop's IPC wrapper reads that shape as Git failing to start
 * (repoNotice.ts) and would say so instead.
 */
export function cliStartError(err: NodeJS.ErrnoException, command: string, install: string, cwd: string | undefined): Error {
  if (err.code === "ENOENT") {
    if (cwd && !existsSync(cwd)) return new CliUnavailableError(missingFolderMessage(cwd));
    return new CliUnavailableError(cliMissingMessage(command, install));
  }
  const reason = /^spawn\b/.test(err.message) && err.code ? err.code : err.message;
  return new AiError(l10n.t("`{0}` failed to start: {1}", command, reason));
}

/**
 * How to invoke one CLI in non-interactive "print" mode.
 *
 * The prompt is never an argument: it goes on the CLI's stdin. As an argument
 * it met the operating systems' limits — Windows caps a whole command line at
 * 32,767 characters and Linux one argument at 128 KiB, while an explained diff
 * or a chat's history runs past both — and the failure arrived as "isn't
 * installed". Each CLI reads a piped prompt: `claude -p` with no prompt
 * argument, `codex exec -`, and `gemini` with no prompt and stdin not a TTY.
 */
interface CliSpec {
  command: string;
  /** argv (excluding the binary) for a one-shot run; the prompt is stdin. */
  args(model?: string): string[];
  /** A friendly install hint surfaced when the binary is missing. */
  install: string;
  /**
   * Optional streaming mode: argv that makes the CLI emit newline-delimited JSON
   * events, plus a parser that turns ONE such line into an incremental text
   * delta (`text`) and/or the complete answer (`final`, used as a fallback when
   * the CLI doesn't emit token deltas). When present, the provider streams the
   * response live instead of waiting for the whole thing.
   */
  streamArgs?(model?: string): string[];
  parseStream?(line: string): { text?: string; final?: string };
}

/** preset id → CLI spec. Keep model flags conservative + widely supported. */
export const CLI_SPECS: Record<string, CliSpec> = {
  "claude-code": {
    command: "claude",
    // `--strict-mcp-config` (with no --mcp-config) skips loading the user's global
    // MCP servers — the Assistant only needs Claude Code's built-in tools, and
    // connecting to a dozen remote MCP servers on every call is a big, variable
    // chunk of the cold-start latency. Claude Code's own Bash/Read/etc. stay.
    args: (model) => ["-p", "--strict-mcp-config", ...(model ? ["--model", model] : [])],
    // A getter, not a plain string: this whole table is a module-level constant,
    // read before boot() configures the l10n bundle (main/language.ts) — a
    // plain `l10n.t()` call here would freeze to English. A getter defers the
    // call to the moment something actually reads `.install`.
    get install() {
      return l10n.t("Install Claude Code and run `claude login` (docs.anthropic.com/claude-code).");
    },
    // Claude Code's stream-json + partial messages emits token-level text deltas.
    streamArgs: (model) => [
      "-p",
      "--strict-mcp-config",
      ...(model ? ["--model", model] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
    ],
    parseStream: (line) => {
      let o: ClaudeStreamLine;
      try {
        o = JSON.parse(line) as ClaudeStreamLine;
      } catch {
        return {};
      }
      // Token-level deltas (the responsive path).
      if (o.type === "stream_event" && o.event?.type === "content_block_delta") {
        const d = o.event.delta;
        if (d?.type === "text_delta" && typeof d.text === "string") {
          return { text: d.text };
        }
        return {};
      }
      // Fallbacks (used only if no token deltas arrive): the final result, or a
      // completed assistant message's text.
      if (o.type === "result" && typeof o.result === "string") {
        return { final: o.result };
      }
      if (o.type === "assistant" && Array.isArray(o.message?.content)) {
        const t = o.message!.content
          .filter((b) => b.type === "text" && typeof b.text === "string")
          .map((b) => b.text as string)
          .join("");
        if (t) return { final: t };
      }
      return {};
    },
  },
  codex: {
    command: "codex",
    // `-`: the instructions are read from stdin.
    args: (model) => ["exec", ...(model ? ["--model", model] : []), "-"],
    get install() {
      return l10n.t("Install the Codex CLI and sign in (github.com/openai/codex).");
    },
  },
  "gemini-cli": {
    command: "gemini",
    // No prompt argument and a piped stdin: one non-interactive run of stdin.
    args: (model) => [...(model ? ["--model", model] : [])],
    get install() {
      return l10n.t("Install the Gemini CLI and sign in (github.com/google-gemini/gemini-cli).");
    },
  },
};

interface ClaudeStreamLine {
  type?: string;
  result?: string;
  event?: { type?: string; delta?: { type?: string; text?: string } };
  message?: { content?: Array<{ type?: string; text?: string }> };
}

export function cliSpecFor(preset: string): CliSpec | undefined {
  return CLI_SPECS[preset];
}

/** Strip ANSI color/escape sequences a CLI might emit even in print mode. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*[A-Za-z]/g;

export interface CliProviderOptions {
  preset: string;
  /** Working directory — the open repo, so the CLI grounds itself correctly. */
  cwd: string | undefined;
  /** Resolve a tier to a concrete model name (or undefined to use the CLI default). */
  resolveModel: (tier: ModelTier | undefined) => string | undefined;
  label: string;
}

export class CliProvider implements Provider {
  readonly id = "cli";
  readonly supportsTools = false;

  constructor(private readonly opts: CliProviderOptions) {}

  get label(): string {
    return this.opts.label;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    let text = "";
    await this.run(messages, opts, (chunk) => {
      text += chunk;
    });
    return { text: text.trim(), toolCalls: [], stopReason: "stop" };
  }

  async streamText(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts: ChatOptions = {},
  ): Promise<string | null> {
    let text = "";
    await this.run(messages, opts, (chunk) => {
      text += chunk;
      onDelta(chunk);
    });
    const trimmed = text.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  /** Spawn the CLI, stream stdout through `onChunk`, resolve on clean exit. */
  private async run(
    messages: ChatMessage[],
    opts: ChatOptions,
    onChunk: (text: string) => void,
  ): Promise<void> {
    const spec = CLI_SPECS[this.opts.preset];
    if (!spec) {
      throw new AiError(l10n.t("Unknown local CLI: {0}.", this.opts.preset));
    }
    const prompt = withThinking(flatten(messages), opts.thinking);
    const model = (opts.modelId ?? this.opts.resolveModel(opts.model));
    // Stream token-by-token when the CLI supports a JSON event stream; otherwise
    // fall back to forwarding raw stdout (which most CLIs buffer to the end).
    const streaming = !!(spec.streamArgs && spec.parseStream);
    const argv = streaming ? spec.streamArgs!(model) : spec.args(model);
    // Found the way a terminal would find it — not by this GUI process's PATH,
    // which on macOS has none of the places a CLI is installed, and on Windows
    // cannot run npm's `.cmd` launchers (launcher.ts).
    const launch = await launchCli(spec.command, argv, spec.install);
    // Cancelled while it was being looked for: nothing to start, nothing failed.
    if (opts.signal?.aborted) return;

    return new Promise<void>((resolve, reject) => {
      let child;
      try {
        child = spawn(launch.file, launch.args, {
          cwd: this.opts.cwd,
          ...launchOptions(launch),
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (err) {
        // Thrown before any process existed (an argument the OS refused): said
        // as what it is, not as "install it".
        reject(cliStartError(err as NodeJS.ErrnoException, spec.command, spec.install, this.opts.cwd));
        return;
      }
      // The prompt, on stdin (see CliSpec). A CLI that exits without reading
      // all of it closes the pipe under us: that EPIPE is its exit's to report.
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);

      let stderr = "";
      // On Windows the CLI is often node.exe under a launcher, and the native
      // program it starts holds the pipes: the whole tree has to go.
      const onAbort = () => stopProcess(child, "SIGTERM");
      if (opts.signal) {
        if (opts.signal.aborted) {
          stopProcess(child, "SIGTERM");
        } else {
          opts.signal.addEventListener("abort", onAbort, { once: true });
        }
      }

      child.stdout.setEncoding("utf8");
      if (streaming) {
        // Parse newline-delimited JSON events: emit text deltas live; remember a
        // `final` answer as a fallback for when no token deltas were emitted.
        let buffer = "";
        let streamedAny = false;
        let final = "";
        child.stdout.on("data", (d: string) => {
          buffer += d;
          let nl: number;
          while ((nl = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (!line) continue;
            const { text, final: f } = spec.parseStream!(line);
            if (text) {
              streamedAny = true;
              onChunk(text);
            }
            if (f) final = f;
          }
        });
        child.on("close", (code: number | null) => {
          opts.signal?.removeEventListener("abort", onAbort);
          if (opts.signal?.aborted) return resolve();
          if (!streamedAny && final) onChunk(final.replace(ANSI, ""));
          if (code === 0 || streamedAny || final) return resolve();
          const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
          reject(new AiError(detail
            ? l10n.t("`{0}` exited with code {1}: {2}", spec.command, String(code), detail)
            : l10n.t("`{0}` exited with code {1}.", spec.command, String(code))));
        });
      } else {
        child.stdout.on("data", (d: string) => onChunk(d.replace(ANSI, "")));
        child.on("close", (code: number | null) => {
          opts.signal?.removeEventListener("abort", onAbort);
          if (opts.signal?.aborted) return resolve();
          if (code === 0) return resolve();
          const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
          reject(new AiError(detail
            ? l10n.t("`{0}` exited with code {1}: {2}", spec.command, String(code), detail)
            : l10n.t("`{0}` exited with code {1}.", spec.command, String(code))));
        });
      }
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => (stderr += d));

      child.on("error", (err: NodeJS.ErrnoException) => {
        opts.signal?.removeEventListener("abort", onAbort);
        reject(cliStartError(err, spec.command, spec.install, this.opts.cwd));
      });
    });
  }
}

/**
 * Nudge the CLI's reasoning depth via the prompt. Claude Code (and most agent
 * CLIs) take their thinking budget from the request, so a short directive is the
 * portable lever: "extended" asks it to think hard; "off" asks for a direct,
 * concise reply; "auto" leaves its default behavior alone.
 */
export function withThinking(prompt: string, thinking?: "off" | "auto" | "extended"): string {
  if (thinking === "extended") {
    return `${prompt}\n\nThink hard and reason carefully before you answer.`;
  }
  if (thinking === "off") {
    return `${prompt}\n\nAnswer directly and concisely, without extended reasoning.`;
  }
  return prompt;
}

/** How much of a chat's past a one-shot CLI turn carries (Codex, Gemini). */
export const CLI_CHAT_HISTORY_CHARS = 24_000;

/**
 * The most recent turns of a chat that fit in `budget` characters, oldest
 * first — what a CLI with no session of its own is handed each turn. Without
 * a bound the history grew by every answer (12k, 24k, …) until a turn could
 * not be sent at all. A newest turn too long by itself keeps its end; older
 * turns that no longer fit are dropped, and the model is told so.
 */
export function recentTurns(turns: readonly ChatMessage[], budget = CLI_CHAT_HISTORY_CHARS): ChatMessage[] {
  const kept: ChatMessage[] = [];
  let used = 0;
  let cut = false;
  for (let i = turns.length - 1; i >= 0; i--) {
    const t = turns[i];
    const room = budget - used;
    if (t.content.length <= room) {
      kept.unshift(t);
      used += t.content.length;
      continue;
    }
    cut = true;
    if (kept.length === 0 && room > 1) {
      // Cut on a character, not inside one: a tail starting on the low half
      // of an emoji arrives as U+FFFD.
      const tail = t.content.slice(-(room - 1)).replace(/^[\uDC00-\uDFFF]/, "");
      kept.unshift({ ...t, content: `…${tail}` });
    }
    break;
  }
  // Sent to the MODEL, never shown to a person: literal English like every prompt.
  return cut ? [{ role: "system", content: "(Earlier parts of this conversation are left out.)" }, ...kept] : kept;
}

/** Flatten the chat messages into a single prompt for a non-interactive CLI.
 *  A conversation labels every turn, whoever's it is; a lone request (every
 *  task) is just itself. */
function flatten(messages: ChatMessage[]): string {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  const turns = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const convo = turns
    .map((m) => (m.role === "assistant" ? `Assistant: ${m.content}` : turns.length > 1 ? `User: ${m.content}` : m.content))
    .join("\n\n")
    .trim();
  return system ? `${system}\n\n${convo}` : convo;
}

/**
 * Detect whether a CLI is installed (and grab its version), by running
 * `<command> --version` with a short timeout. Cached availability lets the
 * settings UI show "Ready" vs "Not installed" without a network call.
 */
export async function detectCli(
  command: string,
  install = "",
): Promise<{ ok: boolean; version?: string; reason?: Error }> {
  let launch: Launch;
  try {
    // The same search, and the same launcher reading, a chat or a task will
    // make — so "Ready" means it runs, and a refusal says why.
    launch = await launchCli(command, ["--version"], install);
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err : new Error(String(err)) };
  }
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (r: { ok: boolean; version?: string }) => {
      if (!done) {
        done = true;
        resolve(r);
      }
    };
    let child;
    try {
      child = spawn(launch.file, launch.args, { ...launchOptions(launch), stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish({ ok: false });
      return;
    }
    const timer = setTimeout(() => {
      stopProcess(child, "SIGKILL");
      finish({ ok: false });
    }, 4000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => (out += d));
    child.on("error", () => {
      clearTimeout(timer);
      finish({ ok: false });
    });
    child.on("close", (code: number | null) => {
      clearTimeout(timer);
      finish({ ok: code === 0, version: out.trim().split("\n")[0] || undefined });
    });
  });
}
