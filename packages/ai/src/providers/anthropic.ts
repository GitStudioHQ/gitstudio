// The Anthropic provider: Claude via the `/v1/messages` API, with full tool use
// (tool_use / tool_result content blocks) and a streaming-text path that reuses
// the engine's `AnthropicSseParser`. Runs on a Node `fetch`, so the key never
// reaches a renderer and there's no CORS. We hand-roll the HTTP (no SDK) to keep
// the dependency surface tiny and the request shape explicit — matching the
// house style of the rest of GitStudio's network code.

import { AnthropicSseParser } from "@gitstudio/engine/ai/gitBrainCore";
import {
  AiError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type Provider,
  type StopReason,
  type ToolCall,
} from "../types";

const ANTHROPIC_VERSION = "2023-06-01";

export interface AnthropicOptions {
  baseUrl: string;
  resolveModel: (tier: ChatOptions["model"]) => string | undefined;
  getKey: () => PromiseLike<string | undefined> | string | undefined;
  label: string;
  fetchImpl?: typeof fetch;
}

interface AnthropicContentBlock {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicWireMessage {
  role: "user" | "assistant";
  content: AnthropicContentBlock[] | string;
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";
  readonly supportsTools = true;

  constructor(private readonly opts: AnthropicOptions) {}

  get label(): string {
    return this.opts.label;
  }

  private endpoint(): string {
    return this.opts.baseUrl.replace(/\/+$/, "") + "/v1/messages";
  }

  private async headers(): Promise<Record<string, string>> {
    const key = await this.opts.getKey();
    if (typeof key !== "string" || key.trim().length === 0) {
      throw new AiError("No Anthropic API key set. Add it in Settings ▸ AI.", 401);
    }
    return {
      "x-api-key": key.trim(),
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
  }

  /**
   * Split GitStudio's flat ChatMessage[] into Anthropic's shape: system text is
   * lifted into the top-level `system` field; user/assistant/tool turns become
   * content-block messages (tool results ride on a synthetic `user` turn).
   */
  private split(messages: ChatMessage[], systemCacheable: boolean) {
    const systemParts: string[] = [];
    const wire: AnthropicWireMessage[] = [];
    for (const m of messages) {
      if (m.role === "system") {
        if (m.content.trim()) {
          systemParts.push(m.content);
        }
        continue;
      }
      if (m.role === "tool") {
        wire.push({
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: m.toolCallId, content: m.content },
          ],
        });
        continue;
      }
      if (m.role === "assistant") {
        const blocks: AnthropicContentBlock[] = [];
        if (m.content.trim()) {
          blocks.push({ type: "text", text: m.content });
        }
        for (const c of m.toolCalls ?? []) {
          blocks.push({ type: "tool_use", id: c.id, name: c.name, input: c.arguments ?? {} });
        }
        wire.push({ role: "assistant", content: blocks.length ? blocks : "" });
        continue;
      }
      wire.push({ role: "user", content: m.content });
    }
    const system =
      systemParts.length > 0
        ? [
            {
              type: "text" as const,
              text: systemParts.join("\n\n"),
              ...(systemCacheable ? { cache_control: { type: "ephemeral" as const } } : {}),
            },
          ]
        : undefined;
    return { system, wire };
  }

  private body(messages: ChatMessage[], opts: ChatOptions, model: string, stream: boolean) {
    const { system, wire } = this.split(messages, opts.systemCacheable === true);
    const body: Record<string, unknown> = {
      model,
      max_tokens: opts.maxTokens ?? (opts.model === "fast" ? 512 : 1024),
      messages: wire,
    };
    if (system) {
      body.system = system;
    }
    if (typeof opts.temperature === "number") {
      body.temperature = opts.temperature;
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }));
      if (opts.toolChoice === "required") {
        body.tool_choice = { type: "any" };
      } else if (opts.toolChoice === "none") {
        body.tool_choice = { type: "none" };
      }
    }
    if (stream) {
      body.stream = true;
    }
    return body;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const model = this.opts.resolveModel(opts.model);
    if (!model) {
      throw new AiError("No model configured for this connection.");
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(this.endpoint(), {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(this.body(messages, opts, model, false)),
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof AiError) {
        throw err;
      }
      if (isAbort(err)) {
        throw new AiError("Request cancelled.");
      }
      throw new AiError("Couldn't reach Anthropic (network error).", undefined, true);
    }
    if (!res.ok) {
      throw httpError(res.status);
    }
    const json = (await res.json()) as AnthropicResponse;
    const text = (json.content ?? [])
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    const toolCalls: ToolCall[] = (json.content ?? [])
      .filter((b) => b.type === "tool_use")
      .map((b) => ({ id: b.id ?? "", name: b.name ?? "", arguments: (b.input as Record<string, unknown>) ?? {} }));
    return {
      text,
      toolCalls,
      stopReason: mapStop(json.stop_reason),
      usage: json.usage
        ? {
            inputTokens: json.usage.input_tokens,
            outputTokens: json.usage.output_tokens,
            cacheReadTokens: json.usage.cache_read_input_tokens,
            cacheWriteTokens: json.usage.cache_creation_input_tokens,
          }
        : undefined,
    };
  }

  async streamText(
    messages: ChatMessage[],
    onDelta: (text: string) => void,
    opts: ChatOptions = {},
  ): Promise<string | null> {
    const model = this.opts.resolveModel(opts.model);
    if (!model) {
      throw new AiError("No model configured for this connection.");
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    let res: Response;
    try {
      res = await fetchImpl(this.endpoint(), {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(this.body(messages, opts, model, true)),
        signal: opts.signal,
      });
    } catch (err) {
      if (err instanceof AiError) {
        throw err;
      }
      if (isAbort(err)) {
        return null;
      }
      throw new AiError("Couldn't reach Anthropic (network error).", undefined, true);
    }
    if (!res.ok) {
      throw httpError(res.status);
    }
    const reader = res.body?.getReader();
    if (!reader) {
      const result = await this.chat(messages, opts);
      if (result.text) {
        onDelta(result.text);
      }
      return result.text || null;
    }
    const parser = new AnthropicSseParser();
    const decoder = new TextDecoder("utf8");
    let assembled = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        for (const delta of parser.push(decoder.decode(value, { stream: true }))) {
          assembled += delta;
          onDelta(delta);
        }
        if (parser.done) {
          break;
        }
      }
    } catch (err) {
      if (!isAbort(err)) {
        throw new AiError("Stream from Anthropic failed.", undefined, true);
      }
    } finally {
      reader.releaseLock();
    }
    const trimmed = assembled.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
}

interface AnthropicResponse {
  content?: AnthropicContentBlock[];
  stop_reason?: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  };
}

function mapStop(reason: string | undefined): StopReason {
  switch (reason) {
    case "end_turn":
      return "stop";
    case "tool_use":
      return "tool_calls";
    case "max_tokens":
      return "length";
    case "refusal":
      return "refusal";
    default:
      return reason ? "unknown" : "stop";
  }
}

function httpError(status: number): AiError {
  switch (status) {
    case 401:
      return new AiError("Anthropic rejected the API key. Check it in Settings ▸ AI.", 401);
    case 429:
      return new AiError("Anthropic rate limit hit — try again in a moment.", 429, true);
    case 529:
      return new AiError("Anthropic is temporarily overloaded — try again shortly.", 529, true);
    default:
      return new AiError(`Anthropic request failed (HTTP ${status}).`, status, status >= 500);
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
