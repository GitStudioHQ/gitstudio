// An AI provider that drives a locally-installed agent CLI — Claude Code
// (`claude`), Codex (`codex`), or the Gemini CLI (`gemini`) — in non-interactive
// "print" mode, using the CLI's OWN login/subscription instead of an API key.
// This is how the extension "connects to a local agent" alongside the BYO-key
// HTTP providers. It spawns a process, so it lives here (not in the shared core).

import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { win32 } from "node:path";
import { auditSpawn } from "@gitstudio/git-service/spawnAudit";
import { prepareOn, spawnOptionsFor, type LaunchMachine, type PreparedLaunch } from "@gitstudio/git-service/commandLaunch";
import type { AiProvider, CompleteRequest } from "./aiFeatures";
import * as l10n from "@vscode/l10n";

interface CliSpec {
  command: string;
  /** argv (excluding the binary) for a one-shot run + optional model. The
   *  prompt goes on stdin, never in argv: Windows caps a command line at
   *  32,767 characters and Linux one argument at 128 KiB, and a diff runs past
   *  both. `claude -p` reads a piped prompt, `codex exec -` reads stdin, and
   *  `gemini` with no prompt runs stdin once when it is not a TTY. */
  args(model?: string): string[];
  /** Install hint surfaced when the binary is missing. */
  install: string;
}

/** agent id → how to invoke its CLI. Model flags kept conservative + optional. */
export const CLI_SPECS: Record<string, CliSpec> = {
  "claude-code": {
    command: "claude",
    args: (model) => ["-p", "--strict-mcp-config", ...(model ? ["--model", model] : [])],
    install: l10n.t("Install Claude Code and run `claude login` (docs.anthropic.com/claude-code)."),
  },
  codex: {
    command: "codex",
    args: (model) => ["exec", ...(model ? ["--model", model] : []), "-"],
    install: l10n.t("Install the Codex CLI and sign in (github.com/openai/codex)."),
  },
  "gemini-cli": {
    command: "gemini",
    args: (model) => [...(model ? ["--model", model] : [])],
    install: l10n.t("Install the Gemini CLI and sign in (github.com/google-gemini/gemini-cli)."),
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

export class CliProvider implements AiProvider {
  readonly id: string;

  constructor(private readonly opts: CliProviderOptions) {
    this.id = "cli:" + opts.agent;
  }

  /** True when the CLI can be started (found, and its launcher runnable). */
  async isAvailable(): Promise<boolean> {
    const spec = CLI_SPECS[this.opts.agent];
    return spec ? findCli(spec.command, []) !== undefined : false;
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
        // Found the way the desktop app finds it (git-service/commandLaunch):
        // on Windows a bare `spawn("claude")` cannot run npm's `claude.cmd`,
        // so an installed CLI answered nothing while `where` said it was there.
        const launch = findCli(spec.command, spec.args(model));
        if (!launch) {
          resolve(null);
          return;
        }
        const options = spawnOptionsFor(launch);
        auditSpawn({ bin: launch.file, args: launch.args, cwd: this.opts.cwd(), env: options.env });
        child = spawn(launch.file, launch.args, {
          cwd: this.opts.cwd(),
          ...options,
          // stderr is not read here, so it is not piped: a CLI that writes
          // more than a pipe holds to it (codex exec puts its progress there)
          // blocked on the full pipe and the request never ended.
          stdio: ["pipe", "pipe", "ignore"],
        });
      } catch {
        resolve(null);
        return;
      }
      // The prompt, on stdin. A CLI that exits without reading it all closes
      // the pipe: that EPIPE is its exit's to report, not an uncaught error.
      child.stdin?.on("error", () => {});
      child.stdin?.end(prompt);
      let out = "";
      if (signal) {
        if (signal.aborted) {
          stopTree(child);
        } else {
          signal.addEventListener("abort", () => stopTree(child), { once: true });
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

/** This extension host as a machine to find programs on. VS Code hands its
 *  extension host the login shell's environment on macOS, so PATH plus the
 *  folders installers use is enough here — no shell is asked. */
function hostMachine(): LaunchMachine {
  return {
    platform: process.platform,
    env: process.env,
    home: homedir(),
    isFile: (p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    },
    readText: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/**
 * End the CLI and what it started. On Windows it is often node.exe under an
 * npm launcher, running the native program that holds the pipes; killing
 * node.exe alone left that running and the request never ended.
 */
function stopTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid !== undefined) {
    // By its full path: a bare name is looked up in the working folder
    // first, which is the user's repository. A taskkill that ran and failed
    // (access denied, the root already gone) still gets the plain kill.
    const taskkill = win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    const args = ["/pid", String(child.pid), "/T", "/F"];
    try {
      auditSpawn({ bin: taskkill, args });
      spawn(taskkill, args, { stdio: "ignore", windowsHide: true })
        .on("error", () => child.kill())
        .on("exit", (code) => {
          if (code !== 0) child.kill();
        });
      return;
    } catch {
      /* fall through to a plain kill */
    }
  }
  child.kill("SIGTERM");
}

/** How to start `command` with `args`, or undefined when it cannot be. */
function findCli(command: string, args: string[]): PreparedLaunch | undefined {
  const r = prepareOn(command, args, hostMachine());
  return r.ok ? r.launch : undefined;
}
