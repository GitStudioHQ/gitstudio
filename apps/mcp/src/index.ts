// gitstudio-mcp — the GitStudio MCP server entry point.
//
// Speaks the Model Context Protocol over stdio (newline-delimited JSON-RPC), so
// any MCP client — Claude Desktop, Cursor, VS Code/Copilot, Windsurf — can point
// at it and get grounded, repo-aware Git tools. It operates on ONE repository
// (––repo <path>, or the current working directory) and reuses GitStudio's
// shared git tool host, so the capabilities exactly match the app.
//
// Permissions (least-privilege by default):
//   read-only          (default)
//   + writes           --write           or env GITSTUDIO_MCP_WRITE=1
//   + destructive ops  --allow-destructive (implies --write)
//
// Diagnostics go to stderr; stdout carries ONLY protocol messages.

import { createInterface } from "node:readline";
import { NodeGitAdapter, GitContext, createGitToolHost } from "@gitstudio/git-service/index";
import { McpServer, type McpPermissions } from "./server";
import { ErrorCode, failure, type JsonRpcMessage } from "./protocol";

const VERSION = "0.1.0";

interface Cli {
  repo: string;
  permissions: McpPermissions;
}

function parseArgs(argv: string[]): Cli | "help" | "version" {
  let repo = process.cwd();
  let write = envFlag("GITSTUDIO_MCP_WRITE");
  let destructive = envFlag("GITSTUDIO_MCP_ALLOW_DESTRUCTIVE");
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return "help";
    if (a === "--version" || a === "-v") return "version";
    if (a === "--repo" || a === "-C") repo = argv[++i] ?? repo;
    else if (a === "--write") write = true;
    else if (a === "--allow-destructive") destructive = true;
    else if (!a.startsWith("-")) repo = a; // positional path
  }
  if (destructive) write = true;
  return { repo, permissions: { write, destructive } };
}

function envFlag(name: string): boolean {
  const v = process.env[name];
  return v === "1" || v === "true" || v === "yes";
}

function log(line: string): void {
  process.stderr.write(`[gitstudio-mcp] ${line}\n`);
}

const HELP = `gitstudio-mcp ${VERSION} — GitStudio's Git tools over the Model Context Protocol.

Usage:
  gitstudio-mcp [--repo <path>] [--write] [--allow-destructive]

Options:
  --repo, -C <path>      Repository to operate on (default: current directory).
  --write                Enable write tools (stage, commit, branch, stash).
  --allow-destructive    Also enable destructive tools (discard, reset --hard,
                         delete-branch). Implies --write.
  --version, -v          Print the version.
  --help, -h             Print this help.

Environment:
  GITSTUDIO_MCP_WRITE=1               Same as --write.
  GITSTUDIO_MCP_ALLOW_DESTRUCTIVE=1   Same as --allow-destructive.

Example (Claude Desktop / Cursor mcp config):
  { "command": "gitstudio-mcp", "args": ["--repo", "/path/to/repo"] }
`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (parsed === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }

  const root = await new NodeGitAdapter().discoverRepoRoot(parsed.repo).catch(() => undefined);
  if (!root) {
    log(`Not a Git repository: ${parsed.repo}`);
    process.exitCode = 1;
    return;
  }

  const ctx = new GitContext({ root });
  const server = new McpServer({
    host: createGitToolHost(ctx),
    version: VERSION,
    permissions: parsed.permissions,
  });

  const mode = parsed.permissions.destructive
    ? "read + write + destructive"
    : parsed.permissions.write
      ? "read + write"
      : "read-only";
  log(`serving ${root} (${mode})`);

  const out = (obj: unknown) => process.stdout.write(JSON.stringify(obj) + "\n");

  // Track in-flight handlers so a stdin EOF drains pending replies before we
  // exit — otherwise an async tool call mid-flight when the pipe closes would be
  // silently dropped.
  const inflight = new Set<Promise<unknown>>();

  const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsedMsg: unknown;
    try {
      parsedMsg = JSON.parse(trimmed);
    } catch {
      out(failure(null, ErrorCode.ParseError, "Parse error: invalid JSON."));
      return;
    }
    const messages = Array.isArray(parsedMsg) ? parsedMsg : [parsedMsg];
    for (const m of messages) {
      const p = server
        .handle(m as JsonRpcMessage)
        .then((res) => {
          if (res) out(res);
        })
        .catch((err) => log(`handler error: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => inflight.delete(p));
      inflight.add(p);
    }
  });

  rl.on("close", () => {
    void Promise.allSettled([...inflight]).then(() => {
      ctx.dispose();
      process.exit(0);
    });
  });
}

main().catch((err) => {
  log(`fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
