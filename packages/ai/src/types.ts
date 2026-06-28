// The host-agnostic AI vocabulary shared across providers, tasks, and the agent.
//
// Two wire protocols cover every model worth connecting: Anthropic's Messages
// API and the OpenAI-compatible `/chat/completions` API (which OpenAI, Azure,
// OpenRouter, Google Gemini's compat endpoint, Groq, Mistral, xAI, DeepSeek,
// Together, Ollama and LM Studio all speak). Both are normalized onto the
// `Provider` interface below so the tasks/agent layers never branch on vendor.
//
// Nothing here imports node/vscode/electron — only the global `fetch` is used by
// the concrete providers — so the same layer powers the VS Code extension, the
// desktop app, and the standalone MCP server.

/**
 * A capability/cost tier the caller asks for; each connection maps the three
 * tiers to concrete model ids. `fast` for tight, cheap calls (commit messages),
 * `mid` for explanations/summaries, `deep` for review/agentic reasoning.
 */
export type ModelTier = "fast" | "mid" | "deep";

export type ChatRole = "system" | "user" | "assistant" | "tool";

/** A single tool the model may call, described with a JSON-Schema parameter set. */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema (draft 2020-12 subset) for the tool arguments object. */
  parameters: JsonSchema;
}

/** A model's request to invoke a tool, normalized across both wire protocols. */
export interface ToolCall {
  /** Provider-assigned id used to correlate the matching tool result. */
  id: string;
  name: string;
  /** Parsed arguments object (providers parse the JSON before handing it up). */
  arguments: Record<string, unknown>;
}

/**
 * One message in a chat exchange. Assistant turns may carry `toolCalls`; a
 * `tool` turn carries the result of a single call (correlated by `toolCallId`).
 */
export interface ChatMessage {
  role: ChatRole;
  /** Free text. Empty string is allowed for an assistant turn that only calls tools. */
  content: string;
  /** Present on assistant turns that requested tool calls. */
  toolCalls?: ToolCall[];
  /** Present on `tool` turns: which call this result answers. */
  toolCallId?: string;
  /** Present on `tool` turns: the tool name (some providers want it echoed). */
  name?: string;
}

export type StopReason =
  | "stop"
  | "length"
  | "tool_calls"
  | "refusal"
  | "error"
  | "unknown";

export interface TokenUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

/** The normalized result of one non-streaming chat turn. */
export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  stopReason: StopReason;
  usage?: TokenUsage;
}

export interface ChatOptions {
  /** Tier (mapped to a model id by the connection) OR an explicit model id. */
  model?: ModelTier;
  /** Hard cap on response tokens. */
  maxTokens?: number;
  temperature?: number;
  /** Tools the model may call this turn. Omit/empty disables tool use. */
  tools?: ToolSpec[];
  /** Force the model to call a tool ("required"), pick freely ("auto"), or none. */
  toolChoice?: "auto" | "required" | "none";
  /** Mark the leading system text as cacheable (Anthropic prompt caching). */
  systemCacheable?: boolean;
  signal?: AbortSignal;
}

/**
 * A normalized chat model. Concrete providers (Anthropic, OpenAI-compatible)
 * implement this; the tasks and agent layers depend only on it.
 */
export interface Provider {
  /** Stable provider id, e.g. "anthropic" or "openai-compat". */
  readonly id: string;
  /** True when the provider/endpoint supports function/tool calling. */
  readonly supportsTools: boolean;
  /** A short human label for the active connection, e.g. "My Claude (Sonnet)". */
  readonly label: string;
  /** One non-streaming chat turn (the agent's workhorse). */
  chat(messages: ChatMessage[], opts?: ChatOptions): Promise<ChatResult>;
  /**
   * Stream assistant text deltas for a single-shot text task (no tools). Returns
   * the assembled text, or null when nothing usable came back. Providers without
   * a native stream may fall back to `chat`.
   */
  streamText(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts?: ChatOptions,
  ): Promise<string | null>;
  /**
   * A streaming chat turn WITH tool support (the agent's responsive path): the
   * assistant's text is delivered incrementally via `onTextDelta` as it's
   * generated, and the fully-assembled result (text + any tool calls) is
   * returned. Optional — the agent falls back to `chat` (or `streamText`) when a
   * provider doesn't implement it.
   */
  streamChat?(
    messages: ChatMessage[],
    onTextDelta: (text: string) => void,
    opts?: ChatOptions,
  ): Promise<ChatResult>;
}

/** Raised by providers for surfaced, user-meaningful failures (never secrets). */
export class AiError extends Error {
  constructor(
    message: string,
    /** HTTP status when the failure was an HTTP response, else undefined. */
    readonly status?: number,
    /** True when retrying later might succeed (429 / 5xx / network). */
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AiError";
  }
}

// ── A minimal JSON-Schema type (enough for tool parameter objects) ───────────

export interface JsonSchema {
  type?:
    | "object"
    | "array"
    | "string"
    | "number"
    | "integer"
    | "boolean"
    | "null";
  description?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: Array<string | number | boolean>;
  default?: unknown;
  /** Allow extra keys (e.g. additionalProperties) without fighting the type. */
  [k: string]: unknown;
}
