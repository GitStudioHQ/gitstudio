// Turn a configured Connection into a live Provider. The key getter is injected
// by the host (Electron safeStorage / VS Code SecretStorage), so this stays free
// of any secret-store dependency and the providers never see where the key came
// from.

import { resolveModelId, type Connection } from "../connections";
import type { ChatOptions, Provider } from "../types";
import { AnthropicProvider } from "./anthropic";
import { OpenAiCompatProvider } from "./openaiCompat";

export { AnthropicProvider } from "./anthropic";
export { OpenAiCompatProvider } from "./openaiCompat";

/** Resolve a tier OR an explicit model id against a connection's tier mapping. */
function modelResolver(conn: Connection) {
  return (model: ChatOptions["model"]): string | undefined => {
    // `model` is a ModelTier here; explicit ids aren't part of ChatOptions yet.
    return resolveModelId(conn, model ?? "mid");
  };
}

/** A short label like "My Claude · sonnet" for surfacing the active model. */
function providerLabel(conn: Connection): string {
  const mid = conn.models.mid || conn.models.fast || conn.models.deep || "model";
  return `${conn.label} · ${mid}`;
}

export function makeProvider(
  conn: Connection,
  getKey: () => PromiseLike<string | undefined> | string | undefined,
  fetchImpl?: typeof fetch,
): Provider {
  const common = {
    baseUrl: conn.baseUrl,
    resolveModel: modelResolver(conn),
    getKey,
    label: providerLabel(conn),
    fetchImpl,
  };
  if (conn.wire === "cli") {
    // CLI providers spawn a local process, so they're constructed by the host
    // (the desktop main process), not here in the fetch-only core.
    throw new Error("CLI connections must be built by the host, not makeProvider().");
  }
  if (conn.wire === "anthropic") {
    return new AnthropicProvider(common);
  }
  return new OpenAiCompatProvider(common);
}
