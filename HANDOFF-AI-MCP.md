# Handoff — AI + Agents + MCP (overnight build)

## What shipped

Two features the user asked for, built and verified overnight:

1. **Connect any AI model in the app** + AI/agent capabilities that leverage
   your own subscriptions/keys (or a local model).
2. **A first-class MCP server** exposing this repo's Git capabilities to any
   outside agent, used wisely (least-privilege).

Both reuse **one shared tool catalog** (`@gitstudio/ai/gitTools`), so the in-app
agent and the MCP server stay in lockstep.

See [`docs/ai-and-agents.md`](docs/ai-and-agents.md) and
[`apps/mcp/README.md`](apps/mcp/README.md).

## ⚠️ Two branches — why, and how to merge

While I was working, **a second Claude session was concurrently editing the
desktop app** (a security/theme hardening pass: `cloneUrl.ts`, `security.test.ts`,
`theme-boot.js`, and edits to `renderer.ts` / `main.ts` / `gitBridge.ts` /
`app.css`). To avoid silently clobbering its work, I split the build:

- **`claude/redesign-masterpiece`** (the shared branch) got the **collision-free
  foundation** — commit `7e31e36`:
  - `packages/ai` (`@gitstudio/ai`) — providers, catalog, connections, tasks,
    agent loop, shared git-tool catalog.
  - `packages/git-service/GitToolHost.ts` — the tool host over a real repo.
  - `apps/mcp` (`gitstudio-mcp`) — the standalone MCP server.
- **`claude/ai-mcp-desktop`** (this branch, from `7e31e36`) got the **desktop
  integration** — commit `0fd04c5` — built in an isolated git worktree so it
  never raced the other session: `main/aiBridge.ts`, `main/mcpConfig.ts`,
  `renderer/{assistant,aiSettings}.ts`, plus minimal edits to `renderer.ts`,
  `main.ts`, `shared/ipc.ts`, `styles/app.css`, `package.json`.

### To land everything

```bash
# 1. Let the other session commit its desktop changes on claude/redesign-masterpiece.
# 2. Merge this branch in:
git checkout claude/redesign-masterpiece
git merge claude/ai-mcp-desktop
# 3. Expect conflicts in the files BOTH sessions touched:
#      renderer.ts (nav tab + settings cards + route — small, localized),
#      main.ts (AiBridge construct + ai:* handlers — one contiguous block),
#      app.css (AI styles appended at the very end),
#      shared/ipc.ts (AI channels/events/types — contiguous blocks).
#    My additions are deliberately localized + contiguous to keep these easy.
# 4. npm install   (reconciles the lockfile: new @gitstudio/ai dep edges)
# 5. npm run check-types && npm test && (cd apps/mcp && npm run build)
```

The worktree lives at `/tmp/gitstudio-ai-wt` (throwaway; remove with
`git worktree remove /tmp/gitstudio-ai-wt` after merging).

## Status

- **Tests:** 232 pass in the main repo (16 ai + 73 git-service incl. 5 new
  tool-host + 13 mcp + the rest). Desktop typechecks (main + renderer) and
  bundles cleanly. (Running git-service tests *inside the /tmp worktree* falsely
  fails on a `tsx`+symlink path quirk — they pass in the real checkout.)
- **Verified end-to-end:** the MCP server over real stdio (initialize →
  tools/list → tools/call → resources/read), read-only vs `--write` gating.
- **Not done (deliberate, to limit merge pain):** deep inline ✨ buttons in the
  commit composer / diff views — the Assistant already covers those flows
  ("draft a commit", "summarize my changes") in one surface. The task functions
  exist in `@gitstudio/ai/tasks` and `ai:task` IPC is wired, so adding inline
  buttons later is small.
- Nothing here gates Git: with no model connected, the AI affordances stay
  hidden and the app behaves exactly as before.
