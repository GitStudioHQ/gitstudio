// The catalog of model platforms GitStudio knows how to connect to. The settings
// UI turns this into a "pick your provider" gallery so connecting is one click +
// (usually) one API key, instead of hand-typing base URLs and model ids. Every
// preset is editable after the fact — the catalog only seeds good defaults.
//
// Two wire protocols cover the field: Anthropic's Messages API and the
// OpenAI-compatible `/chat/completions` API. Everything except Anthropic itself
// speaks openai-compat (Gemini exposes a compat endpoint; local servers too).

import type { ModelTier } from "./types";

/** Which wire protocol a connection talks. */
export type Wire = "anthropic" | "openai-compat";

export interface ProviderPreset {
  /** Stable catalog key, also the default connection `preset`. */
  id: string;
  /** Display name, e.g. "Anthropic (Claude)". */
  label: string;
  /** Short tagline for the gallery card. */
  blurb: string;
  wire: Wire;
  /** Default API base URL (OpenAI-compat: the `/v1` root; Anthropic: host). */
  baseUrl: string;
  /** Seed model ids per tier. All editable. */
  models: Record<ModelTier, string>;
  /** Whether an API key is required. Local servers (Ollama/LM Studio) need none. */
  needsKey: boolean;
  /** True for a localhost server — surfaced as "Local" + a privacy note. */
  local?: boolean;
  /** Where to get a key (opened in the browser from settings). */
  keyUrl?: string;
  /** A codicon name for the gallery card. */
  icon: string;
  /** Optional extra guidance shown under the form (e.g. Azure deployment note). */
  note?: string;
}

/**
 * The known platforms, roughly ordered by how commonly developers already have a
 * subscription/key. `custom` is the escape hatch for any other OpenAI-compatible
 * server. Model ids are sensible-as-of-build defaults; the UI lets users change
 * them and (for live endpoints) fetch the real model list.
 */
export const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    blurb: "Claude Opus, Sonnet & Haiku — strongest for code & agentic work.",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com",
    models: { fast: "claude-haiku-4-5", mid: "claude-sonnet-4-6", deep: "claude-opus-4-8" },
    needsKey: true,
    keyUrl: "https://console.anthropic.com/settings/keys",
    icon: "sparkle",
  },
  {
    id: "openai",
    label: "OpenAI",
    blurb: "GPT-4o / o-series via the OpenAI API.",
    wire: "openai-compat",
    baseUrl: "https://api.openai.com/v1",
    models: { fast: "gpt-4o-mini", mid: "gpt-4o", deep: "gpt-4o" },
    needsKey: true,
    keyUrl: "https://platform.openai.com/api-keys",
    icon: "sparkle",
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    blurb: "One key, hundreds of models (Claude, GPT, Llama, Gemini, …).",
    wire: "openai-compat",
    baseUrl: "https://openrouter.ai/api/v1",
    models: {
      fast: "anthropic/claude-haiku-4-5",
      mid: "anthropic/claude-sonnet-4-6",
      deep: "anthropic/claude-opus-4-8",
    },
    needsKey: true,
    keyUrl: "https://openrouter.ai/keys",
    icon: "globe",
  },
  {
    id: "google",
    label: "Google Gemini",
    blurb: "Gemini 2.5 Pro & Flash via the OpenAI-compatible endpoint.",
    wire: "openai-compat",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    models: { fast: "gemini-2.5-flash", mid: "gemini-2.5-flash", deep: "gemini-2.5-pro" },
    needsKey: true,
    keyUrl: "https://aistudio.google.com/apikey",
    icon: "sparkle",
  },
  {
    id: "groq",
    label: "Groq",
    blurb: "Open models at very low latency.",
    wire: "openai-compat",
    baseUrl: "https://api.groq.com/openai/v1",
    models: {
      fast: "llama-3.1-8b-instant",
      mid: "llama-3.3-70b-versatile",
      deep: "llama-3.3-70b-versatile",
    },
    needsKey: true,
    keyUrl: "https://console.groq.com/keys",
    icon: "zap",
  },
  {
    id: "mistral",
    label: "Mistral",
    blurb: "Mistral & Codestral models.",
    wire: "openai-compat",
    baseUrl: "https://api.mistral.ai/v1",
    models: { fast: "mistral-small-latest", mid: "mistral-large-latest", deep: "mistral-large-latest" },
    needsKey: true,
    keyUrl: "https://console.mistral.ai/api-keys",
    icon: "sparkle",
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    blurb: "Grok models from xAI.",
    wire: "openai-compat",
    baseUrl: "https://api.x.ai/v1",
    models: { fast: "grok-3-mini", mid: "grok-3", deep: "grok-4" },
    needsKey: true,
    keyUrl: "https://console.x.ai",
    icon: "sparkle",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    blurb: "DeepSeek-V3 chat & R1 reasoning.",
    wire: "openai-compat",
    baseUrl: "https://api.deepseek.com",
    models: { fast: "deepseek-chat", mid: "deepseek-chat", deep: "deepseek-reasoner" },
    needsKey: true,
    keyUrl: "https://platform.deepseek.com/api_keys",
    icon: "sparkle",
  },
  {
    id: "together",
    label: "Together AI",
    blurb: "A broad catalog of open models.",
    wire: "openai-compat",
    baseUrl: "https://api.together.xyz/v1",
    models: {
      fast: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      mid: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      deep: "deepseek-ai/DeepSeek-V3",
    },
    needsKey: true,
    keyUrl: "https://api.together.xyz/settings/api-keys",
    icon: "globe",
  },
  {
    id: "ollama",
    label: "Ollama (local)",
    blurb: "Run models on your own machine — fully private, no key.",
    wire: "openai-compat",
    baseUrl: "http://localhost:11434/v1",
    models: { fast: "llama3.2", mid: "qwen2.5-coder", deep: "qwen2.5-coder:32b" },
    needsKey: false,
    local: true,
    keyUrl: "https://ollama.com/download",
    icon: "vm",
    note: "Start Ollama, then `ollama pull qwen2.5-coder`. Nothing leaves your machine.",
  },
  {
    id: "lmstudio",
    label: "LM Studio (local)",
    blurb: "Local models via LM Studio's server — private, no key.",
    wire: "openai-compat",
    baseUrl: "http://localhost:1234/v1",
    models: { fast: "local-model", mid: "local-model", deep: "local-model" },
    needsKey: false,
    local: true,
    keyUrl: "https://lmstudio.ai",
    icon: "vm",
    note: "Enable LM Studio's local server (Developer ▸ Start Server), then load a model.",
  },
  {
    id: "azure",
    label: "Azure OpenAI",
    blurb: "OpenAI models hosted in your Azure tenant.",
    wire: "openai-compat",
    baseUrl: "https://YOUR-RESOURCE.openai.azure.com/openai/deployments/YOUR-DEPLOYMENT",
    models: { fast: "gpt-4o-mini", mid: "gpt-4o", deep: "gpt-4o" },
    needsKey: true,
    keyUrl: "https://portal.azure.com",
    icon: "azure",
    note: "Set the base URL to your deployment and append `?api-version=…` if required.",
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    blurb: "Any server that speaks /chat/completions.",
    wire: "openai-compat",
    baseUrl: "",
    models: { fast: "", mid: "", deep: "" },
    needsKey: false,
    icon: "server",
  },
];

/** Look a preset up by id, falling back to the `custom` escape hatch. */
export function presetById(id: string): ProviderPreset {
  return (
    PROVIDER_PRESETS.find((p) => p.id === id) ??
    PROVIDER_PRESETS.find((p) => p.id === "custom")!
  );
}
