# AI & Agents in GitStudio

GitStudio is a **two-way AI bridge**, and both directions are free, open, and
bring-your-own-model:

1. **GitStudio as an AI _client_** — connect any model you already pay for (or
   run locally) and get AI help + an autonomous agent _inside_ the app.
2. **GitStudio as an AI _server_** — expose this repo's Git capabilities to any
   outside agent over MCP, so Claude Desktop / Cursor / Copilot / Windsurf can
   work against real repository state.

The same **shared tool catalog** powers both, so the in-app agent and the
external one have identical, consistent capabilities.

## How this compares

GitKraken's AI is gated behind their account/cloud, and their MCP wraps their
CLI/cloud. GitStudio's is **free, local-first, BYO-key, and open-source** — and
unifies the in-app agent with the MCP surface instead of treating them as
separate products. AI is always optional and **never gates Git**: with nothing
connected, the AI affordances simply stay hidden and the app works exactly as
before.

## 1. Connect a model (Settings ▸ AI Models)

Pick from a catalog of platforms — **Anthropic (Claude), OpenAI, OpenRouter,
Google Gemini, Groq, Mistral, xAI (Grok), DeepSeek, Together, Azure** — or run a
**local model** with **Ollama** or **LM Studio** (no key, nothing leaves your
machine). Add your API key (encrypted at rest with the OS keychain via Electron
`safeStorage`; it never reaches the renderer or a web context). You can keep
several connections (e.g. "My Claude" + "Local Ollama") and choose a default.

Two wire protocols cover the whole field: Anthropic's Messages API and the
OpenAI-compatible `/chat/completions` API.

### What you get

- **The Assistant** (sidebar ▸ Assistant) — an agent that reads real status,
  diffs, and history before acting, and **asks before every write**. Ask it to
  *"draft a commit for my staged changes"*, *"what does this branch change vs
  main?"*, *"draft release notes since the last tag"*, *"tidy up merged
  branches"*. You set its permission level (read-only / commits / everything),
  and you see every tool call and result live.
- **One-shot ✨ tasks** (library) — commit messages, diff explanations, change
  summaries, PR descriptions, code review, conflict help, changelogs, branch
  names. (Surfaced inline incrementally.)

## 2. Expose this repo to your agents (Settings ▸ Agent Access)

One click adds GitStudio's MCP server to **Claude Desktop, Cursor, VS Code
(Copilot), or Windsurf**, scoped to the open repository, with the permission
level you choose (read-only by default). Or copy the config snippet for any
other MCP client. See [`apps/mcp/README.md`](../apps/mcp/README.md).

## Architecture

```
packages/ai (@gitstudio/ai)         host-agnostic, fetch-only
  ├─ providers/  anthropic + openai-compat (tool-calling + streaming)
  ├─ catalog     known platforms + defaults
  ├─ connections multi-connection registry
  ├─ tasks       the ✨ one-shot tasks
  ├─ gitTools    shared tool catalog + GitToolHost port  ◄── single source
  └─ agent       provider-agnostic tool-calling loop (human-in-the-loop)

packages/git-service
  └─ createGitToolHost(ctx)          implements the port over a real repo
                                     │
        ┌────────────────────────────┴───────────────────────────┐
   apps/desktop (main/aiBridge.ts)                       apps/mcp (gitstudio-mcp)
   in-app Assistant + ✨ + Agent Access                  stdio MCP server
```

Keys live only in the main process. Writes are gated by an explicit user
confirmation in the app, and by `--write` / `--allow-destructive` in the MCP
server. Read tools are always safe; destructive tools take a second opt-in.
