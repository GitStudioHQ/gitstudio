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
import { AiError, type ChatMessage, type ChatOptions, type ChatResult, type ModelTier, type Provider } from "@gitstudio/ai/index";

/** How to invoke one CLI in non-interactive "print" mode. */
interface CliSpec {
  command: string;
  /** Build argv (excluding the binary) for a one-shot prompt + optional model. */
  args(prompt: string, model?: string): string[];
  /** A friendly install hint surfaced when the binary is missing. */
  install: string;
  /**
   * Optional streaming mode: argv that makes the CLI emit newline-delimited JSON
   * events, plus a parser that turns ONE such line into an incremental text
   * delta (`text`) and/or the complete answer (`final`, used as a fallback when
   * the CLI doesn't emit token deltas). When present, the provider streams the
   * response live instead of waiting for the whole thing.
   */
  streamArgs?(prompt: string, model?: string): string[];
  parseStream?(line: string): { text?: string; final?: string };
}

/** preset id → CLI spec. Keep model flags conservative + widely supported. */
export const CLI_SPECS: Record<string, CliSpec> = {
  "claude-code": {
    command: "claude",
    args: (prompt, model) => ["-p", ...(model ? ["--model", model] : []), prompt],
    install: "Install Claude Code and run `claude login` (docs.anthropic.com/claude-code).",
    // Claude Code's stream-json + partial messages emits token-level text deltas.
    streamArgs: (prompt, model) => [
      "-p",
      ...(model ? ["--model", model] : []),
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      prompt,
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
    args: (prompt, model) => ["exec", ...(model ? ["--model", model] : []), prompt],
    install: "Install the Codex CLI and sign in (github.com/openai/codex).",
  },
  "gemini-cli": {
    command: "gemini",
    args: (prompt, model) => ["-p", ...(model ? ["--model", model] : []), prompt],
    install: "Install the Gemini CLI and sign in (github.com/google-gemini/gemini-cli).",
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
  private run(
    messages: ChatMessage[],
    opts: ChatOptions,
    onChunk: (text: string) => void,
  ): Promise<void> {
    const spec = CLI_SPECS[this.opts.preset];
    if (!spec) {
      return Promise.reject(new AiError(`Unknown local CLI: ${this.opts.preset}.`));
    }
    const prompt = withThinking(flatten(messages), opts.thinking);
    const model = (opts.modelId ?? this.opts.resolveModel(opts.model));
    // Stream token-by-token when the CLI supports a JSON event stream; otherwise
    // fall back to forwarding raw stdout (which most CLIs buffer to the end).
    const streaming = !!(spec.streamArgs && spec.parseStream);
    const argv = streaming ? spec.streamArgs!(prompt, model) : spec.args(prompt, model);

    return new Promise<void>((resolve, reject) => {
      let child;
      try {
        child = spawn(spec.command, argv, {
          cwd: this.opts.cwd,
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        reject(new AiError(`Couldn't launch \`${spec.command}\`. ${spec.install}`));
        return;
      }

      let stderr = "";
      const onAbort = () => child.kill("SIGTERM");
      if (opts.signal) {
        if (opts.signal.aborted) {
          child.kill("SIGTERM");
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
          reject(new AiError(`\`${spec.command}\` exited with code ${code}${detail ? `: ${detail}` : "."}`));
        });
      } else {
        child.stdout.on("data", (d: string) => onChunk(d.replace(ANSI, "")));
        child.on("close", (code: number | null) => {
          opts.signal?.removeEventListener("abort", onAbort);
          if (opts.signal?.aborted) return resolve();
          if (code === 0) return resolve();
          const detail = stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300);
          reject(new AiError(`\`${spec.command}\` exited with code ${code}${detail ? `: ${detail}` : "."}`));
        });
      }
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (d: string) => (stderr += d));

      child.on("error", (err: NodeJS.ErrnoException) => {
        opts.signal?.removeEventListener("abort", onAbort);
        if (err.code === "ENOENT") {
          reject(new AiError(`The \`${spec.command}\` CLI isn't installed or not on PATH. ${spec.install}`));
        } else {
          reject(new AiError(`\`${spec.command}\` failed to start: ${err.message}`));
        }
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
function withThinking(prompt: string, thinking?: "off" | "auto" | "extended"): string {
  if (thinking === "extended") {
    return `${prompt}\n\nThink hard and reason carefully before you answer.`;
  }
  if (thinking === "off") {
    return `${prompt}\n\nAnswer directly and concisely, without extended reasoning.`;
  }
  return prompt;
}

/** Flatten the chat messages into a single prompt for a non-interactive CLI. */
function flatten(messages: ChatMessage[]): string {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n")
    .trim();
  const convo = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => (m.role === "assistant" ? `Assistant: ${m.content}` : m.content))
    .join("\n\n")
    .trim();
  return system ? `${system}\n\n${convo}` : convo;
}

/**
 * Detect whether a CLI is installed (and grab its version), by running
 * `<command> --version` with a short timeout. Cached availability lets the
 * settings UI show "Ready" vs "Not installed" without a network call.
 */
export function detectCli(command: string): Promise<{ ok: boolean; version?: string }> {
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
      child = spawn(command, ["--version"], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      finish({ ok: false });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
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
