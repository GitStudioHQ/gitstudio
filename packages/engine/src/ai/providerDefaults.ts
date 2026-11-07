// Each provider's own default models, per tier — ONE table for both products.
//
// A connection starts on its provider's defaults and they are yours to change:
// the desktop's catalog (packages/ai/src/catalog.ts) seeds a new connection
// with them, and the extension's single OpenAI-compatible endpoint uses the
// defaults of whichever provider its base URL points at when you have set no
// model of your own. Until this table, the extension's model settings
// defaulted to gpt-4o for EVERY endpoint — Groq, OpenRouter, a local Ollama —
// so a user who picked another provider was still sent OpenAI's model.
//
// Pure data, no imports: the engine is shared by every host.

export type DefaultModels = Readonly<{ fast: string; mid: string; deep: string }>;

const OPENAI: DefaultModels = { fast: "gpt-6-luna", mid: "gpt-6.1-terra", deep: "gpt-6.1-sol" };

/** By catalog preset id. A provider with no fixed model (Custom) is absent. */
export const PROVIDER_DEFAULT_MODELS = {
  anthropic: { fast: "claude-haiku-4-5", mid: "claude-sonnet-4-6", deep: "claude-opus-4-8" },
  openai: OPENAI,
  // A deployment runs whatever was deployed to it; OpenAI's current models
  // are the likeliest, and the field is yours to change to your deployment's.
  azure: OPENAI,
  openrouter: {
    fast: "anthropic/claude-haiku-4-5",
    mid: "anthropic/claude-sonnet-4-6",
    deep: "anthropic/claude-opus-4-8",
  },
  google: { fast: "gemini-3.5-flash-lite", mid: "gemini-3.6-flash", deep: "gemini-3.8-flash" },
  groq: { fast: "openai/gpt-oss-20b", mid: "openai/gpt-oss-120b", deep: "openai/gpt-oss-120b" },
  mistral: { fast: "mistral-small-latest", mid: "mistral-large-latest", deep: "mistral-large-latest" },
  xai: { fast: "grok-3-mini", mid: "grok-3", deep: "grok-4" },
  deepseek: { fast: "deepseek-flash", mid: "deepseek-flash", deep: "deepseek-v4-pro" },
  together: {
    fast: "openai/gpt-oss-120b",
    mid: "openai/gpt-oss-120b",
    deep: "deepseek-ai/DeepSeek-V4-Pro-0813",
  },
  ollama: { fast: "llama3.2", mid: "qwen2.5-coder", deep: "qwen2.5-coder:32b" },
  // LM Studio answers with whichever model is loaded.
  lmstudio: { fast: "local-model", mid: "local-model", deep: "local-model" },
} as const satisfies Record<string, DefaultModels>;

export type DefaultModelsProvider = keyof typeof PROVIDER_DEFAULT_MODELS;

/** Hosted endpoints by host name (any subdomain of it counts). */
const HOSTS: ReadonlyArray<readonly [string, DefaultModelsProvider]> = [
  ["api.openai.com", "openai"],
  ["openai.azure.com", "azure"],
  ["openrouter.ai", "openrouter"],
  ["generativelanguage.googleapis.com", "google"],
  ["api.groq.com", "groq"],
  ["api.mistral.ai", "mistral"],
  ["api.x.ai", "xai"],
  ["api.deepseek.com", "deepseek"],
  ["api.together.xyz", "together"],
];

/** Local servers by their default port on this machine. */
const LOCAL_PORTS: Readonly<Record<string, DefaultModelsProvider>> = {
  "11434": "ollama",
  "1234": "lmstudio",
};

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1", "0.0.0.0"]);

/**
 * The provider an OpenAI-compatible base URL belongs to, when it is one we
 * know — or undefined (a custom server, an unknown host, not a URL).
 */
export function providerOfEndpoint(baseUrl: string): DefaultModelsProvider | undefined {
  let url: URL;
  try {
    url = new URL(baseUrl.trim());
  } catch {
    return undefined;
  }
  const host = url.hostname.toLowerCase();
  for (const [known, provider] of HOSTS) {
    if (host === known || host.endsWith(`.${known}`)) {
      return provider;
    }
  }
  if (LOCAL_HOSTS.has(host)) {
    return LOCAL_PORTS[url.port];
  }
  return undefined;
}

/** The default models of the provider a base URL points at, if it is known. */
export function defaultModelsForEndpoint(baseUrl: string): DefaultModels | undefined {
  const provider = providerOfEndpoint(baseUrl);
  return provider ? PROVIDER_DEFAULT_MODELS[provider] : undefined;
}
