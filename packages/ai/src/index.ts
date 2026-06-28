// @gitstudio/ai — the host-agnostic AI layer.
//
// A multi-provider model registry (Anthropic + any OpenAI-compatible endpoint,
// including local Ollama/LM Studio), the high-level git AI tasks behind the ✨
// affordances, a tool-calling agent loop, and the shared Git tool catalog that
// also backs the MCP server. fetch-only: no vscode/electron/fs imports, so the
// extension, the desktop app, and the standalone MCP server all reuse it.

export * from "./types";
export * from "./catalog";
export * from "./connections";
export * from "./providers/index";
export * from "./tasks";
export * from "./gitTools";
export * from "./agent";
