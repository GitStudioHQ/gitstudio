# GitStudio MCP server (`gitstudio-mcp`)

Expose a Git repository's capabilities to any agent that speaks the
[Model Context Protocol](https://modelcontextprotocol.io) — Claude Desktop,
Cursor, VS Code / Copilot, Windsurf, and anything else with MCP support. The
agent gets **grounded, repo-aware Git tools** instead of guessing from a stale
copy of your code.

It runs over **stdio** (newline-delimited JSON-RPC), operates on **one
repository**, and is **least-privilege by default**: read-only until you
explicitly opt into writes.

> The same tool catalog backs GitStudio's own in-app Assistant, so an external
> agent and GitStudio itself see exactly the same capabilities.

## Quick start

Build it once:

```bash
npm run build --workspace gitstudio-mcp
```

Then add it to your MCP client. The desktop app's **Settings ▸ Agent Access**
card writes this config for you (one click per client), or paste it yourself:

```json
{
  "mcpServers": {
    "gitstudio": {
      "command": "node",
      "args": ["/abs/path/to/apps/mcp/dist/index.js", "--repo", "/path/to/your/repo"]
    }
  }
}
```

VS Code uses `"servers"` instead of `"mcpServers"` (in `.vscode/mcp.json`).

## Permissions

| Flag | Adds | Tools |
| --- | --- | --- |
| *(default)* | read-only | status, log, show, diff, branches, stashes, search, read file, compare |
| `--write` | safe writes | stage, unstage, commit, create-branch, checkout, stash |
| `--allow-destructive` | history/data loss | discard, delete-branch, reset (implies `--write`) |

Environment equivalents: `GITSTUDIO_MCP_WRITE=1`,
`GITSTUDIO_MCP_ALLOW_DESTRUCTIVE=1`.

Every tool is annotated (`readOnlyHint` / `destructiveHint`) so a well-behaved
client can warn before a mutation. Per the MCP spec, **keep a human in the
loop** for writes.

## What it exposes

- **Tools** — the Git capability surface above. Destructive tools are omitted
  entirely unless enabled, and an attempt to call a gated tool returns a clear
  "ask the user to enable it" message rather than failing opaquely.
- **Resources** — `gitstudio://status`, `gitstudio://branches`,
  `gitstudio://log`, plus templates `gitstudio://commit/{sha}` and
  `gitstudio://file/{path}`.
- **Prompts** — ready-made workflows: `commit_staged`, `review_changes`,
  `release_notes`, `explain_branch`.

## CLI

```
gitstudio-mcp [--repo <path>] [--write] [--allow-destructive]
  --repo, -C <path>     Repository (default: cwd)
  --write               Enable safe write tools
  --allow-destructive   Enable destructive tools (implies --write)
  --version  --help
```

Diagnostics go to stderr; stdout carries only protocol messages.

## Design

Hand-rolled JSON-RPC (no SDK dependency — matches GitStudio's house style of
keeping network/protocol code explicit and dependency-light). The protocol core
(`src/server.ts`) is transport-agnostic and unit-tested by feeding it messages
directly; `src/index.ts` only wires it to stdio. All Git work goes through the
shared `@gitstudio/git-service` providers via `createGitToolHost`, so behavior
matches the app and the extension exactly.
