// A GitBrain provider that drives a locally-installed agent CLI — Claude Code
// (`claude`), Codex (`codex`), or the Gemini CLI (`gemini`) — in non-interactive
// "print" mode, using the CLI's OWN login/subscription instead of an API key.
// This is how the extension "connects to a local agent" alongside the BYO-key
// HTTP providers. It spawns a process, so it lives here (not in the shared core).

import { spawn } from "node:child_process";
import type { GitBrainProvider, CompleteRequest } from "./gitBrain";

interface CliSpec {
  command: string;
  /** argv (excluding the binary) for a one-shot prompt + optional model. */
  args(prompt: string, model?: string): string[];
  /** Install hint surfaced when the binary is missing. */
  install: string;
}

/** agent id → how to invoke its CLI. Model flags kept conservative + optional. */
export const CLI_SPECS: Record<string, CliSpec> = {
  "claude-code": {
    command: "claude",
    args: (prompt, model) => [
      "-p",
      "--strict-mcp-config",
      ...(model ? ["--model", model] : []),
      prompt,
    ],
    install: "Install Claude Code and run `claude login` (docs.anthropic.com/claude-code).",
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

// Strip ANSI escapes a CLI may emit even in print mode.
// eslint-disable-next-line no-control-regex
const ANSI = /\x1b\[[0-9;]*[A-Za-z]/g;

export interface CliProviderOptions {
  agent: string;
  /** Working dir — the open repo, so the CLI grounds itself in real state. */
  cwd: () => string | undefined;
  /** Optional model override (empty ⇒ the CLI's default). */
  model: () => string | undefined;
}

export class CliProvider implements GitBrainProvider {
  readonly id: string;

  constructor(private readonly opts: CliProviderOptions) {
    this.id = "cli:" + opts.agent;
  }

  /** True when the CLI binary is on PATH. */
  async isAvailable(): Promise<boolean> {
    const spec = CLI_SPECS[this.opts.agent];
    return spec ? binaryExists(spec.command) : false;
  }

  async complete(req: CompleteRequest): Promise<string | null> {
    const spec = CLI_SPECS[this.opts.agent];
    if (!spec) {
      return null;
    }
    const prompt = (req.system ? req.system + "\n\n" : "") + req.prompt;
    const model = this.opts.model();
    return this.run(spec, prompt, model, req.signal);
  }

  private run(
    spec: CliSpec,
    prompt: string,
    model: string | undefined,
    signal?: AbortSignal,
  ): Promise<string | null> {
    return new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(spec.command, spec.args(prompt, model), {
          cwd: this.opts.cwd(),
          env: process.env,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch {
        resolve(null);
        return;
      }
      let out = "";
      if (signal) {
        if (signal.aborted) {
          child.kill("SIGTERM");
        } else {
          signal.addEventListener("abort", () => child.kill("SIGTERM"), { once: true });
        }
      }
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (d: string) => (out += d));
      child.on("error", () => resolve(null));
      child.on("close", (code) => {
        const text = out.replace(ANSI, "").trim();
        resolve(code === 0 && text ? text : null);
      });
    });
  }
}

/** Whether `cmd` resolves on PATH (`which` / `where`), best-effort. */
function binaryExists(cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const finder = process.platform === "win32" ? "where" : "which";
      const c = spawn(finder, [cmd], { stdio: "ignore" });
      c.on("error", () => resolve(false));
      c.on("close", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
}
