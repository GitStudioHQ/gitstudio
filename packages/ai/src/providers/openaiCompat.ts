// The OpenAI-compatible provider: one implementation that covers OpenAI, Azure,
// OpenRouter, Google Gemini's compat endpoint, Groq, Mistral, xAI, DeepSeek,
// Together, Ollama and LM Studio — they all speak `/chat/completions` with the
// same request/response envelope (messages[], tools[], choices[].message with
// optional tool_calls). Runs on a Node `fetch` (main process / MCP server), so
// the key never reaches a renderer and there's no CORS to fight.
//
// The streaming-text path reuses the engine's dependency-free `OpenAiSseParser`;
// the tool-calling path is non-streaming (simpler and reliable for the agent
// loop, where we need the fully-assembled tool_calls before executing them).

import { OpenAiSseParser } from "@gitstudio/engine/ai/gitBrainCore";
import {
  AiError,
  type ChatMessage,
  type ChatOptions,
  type ChatResult,
  type Provider,
  type StopReason,
  type ToolCall,
} from "../types";

export interface OpenAiCompatOptions {
  baseUrl: string;
  /** Resolves a tier or explicit id to a concrete model id. */
  resolveModel: (tier: ChatOptions["model"]) => string | undefined;
  /** Returns the API key, or undefined for a keyless local server. */
  getKey: () => PromiseLike<string | undefined> | string | undefined;
  label: string;
  fetchImpl?: typeof fetch;
}

interface WireMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
  name?: string;
}

export class OpenAiCompatProvider implements Provider {
  readonly id = "openai-compat";
  readonly supportsTools = true;

  constructor(private readonly opts: OpenAiCompatOptions) {}

  get label(): string {
    return this.opts.label;
  }

  private endpoint(): string {
    const base = this.opts.baseUrl.replace(/\/+$/, "");
    // Azure deployments carry an `?api-version=` query; append the path before it.
    const q = base.indexOf("?");
    if (q !== -1) {
      return base.slice(0, q) + "/chat/completions" + base.slice(q);
    }
    return base + "/chat/completions";
  }

  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const key = await this.opts.getKey();
    if (typeof key === "string" && key.trim().length > 0) {
      headers.Authorization = `Bearer ${key.trim()}`;
    }
    return headers;
  }

  private toWire(messages: ChatMessage[]): WireMessage[] {
    return messages.map((m): WireMessage => {
      if (m.role === "tool") {
        return {
          role: "tool",
          content: m.content,
          tool_call_id: m.toolCallId,
          name: m.name,
        };
      }
      if (m.role === "assistant" && m.toolCalls && m.toolCalls.length > 0) {
        return {
          role: "assistant",
          content: m.content || null,
          tool_calls: m.toolCalls.map((c) => ({
            id: c.id,
            type: "function" as const,
            function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
          })),
        };
      }
      return { role: m.role as WireMessage["role"], content: m.content };
    });
  }

  private body(messages: ChatMessage[], opts: ChatOptions, model: string, stream: boolean) {
    const body: Record<string, unknown> = {
      model,
      messages: this.toWire(messages),
      max_tokens: opts.maxTokens ?? (opts.model === "fast" ? 512 : 1024),
    };
    if (typeof opts.temperature === "number") {
      body.temperature = opts.temperature;
    }
    if (opts.tools && opts.tools.length > 0) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      if (opts.toolChoice && opts.toolChoice !== "auto") {
        body.tool_choice = opts.toolChoice === "none" ? "none" : "required";
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
      if (isAbort(err)) {
        throw new AiError("Request cancelled.");
      }
      throw new AiError(`Couldn't reach ${hostOf(this.opts.baseUrl)} — is the endpoint reachable?`, undefined, true);
    }
    if (!res.ok) {
      throw httpError(res.status, hostOf(this.opts.baseUrl));
    }
    const json = (await res.json()) as OpenAiResponse;
    const choice = json.choices?.[0];
    const msg = choice?.message;
    const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((c) => ({
      id: c.id,
      name: c.function?.name ?? "",
      arguments: safeParse(c.function?.arguments),
    }));
    return {
      text: typeof msg?.content === "string" ? msg.content : "",
      toolCalls,
      stopReason: mapFinish(choice?.finish_reason, toolCalls.length > 0),
      usage: json.usage
        ? { inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens }
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
      if (isAbort(err)) {
        return null;
      }
      throw new AiError(`Couldn't reach ${hostOf(this.opts.baseUrl)} — is the endpoint reachable?`, undefined, true);
    }
    if (!res.ok) {
      throw httpError(res.status, hostOf(this.opts.baseUrl));
    }
    const reader = res.body?.getReader();
    if (!reader) {
      const result = await this.chat(messages, { ...opts });
      if (result.text) {
        onDelta(result.text);
      }
      return result.text || null;
    }
    const parser = new OpenAiSseParser();
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
        throw new AiError(`Stream from ${hostOf(this.opts.baseUrl)} failed.`, undefined, true);
      }
    } finally {
      reader.releaseLock();
    }
    const trimmed = assembled.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async streamChat(
    messages: ChatMessage[],
    onTextDelta: (text: string) => void,
    opts: ChatOptions = {},
  ): Promise<ChatResult> {
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
      if (isAbort(err)) {
        return { text: "", toolCalls: [], stopReason: "stop" };
      }
      throw new AiError(`Couldn't reach ${hostOf(this.opts.baseUrl)} — is the endpoint reachable?`, undefined, true);
    }
    if (!res.ok) {
      throw httpError(res.status, hostOf(this.opts.baseUrl));
    }
    const reader = res.body?.getReader();
    if (!reader) {
      // No stream — fall back to a single non-streaming turn.
      return this.chat(messages, opts);
    }

    const decoder = new TextDecoder("utf8");
    let buffer = "";
    let text = "";
    let finish: string | undefined;
    // tool_calls assemble incrementally, keyed by their array index.
    const partials = new Map<number, { id: string; name: string; args: string }>();

    const handleData = (payload: string): void => {
      if (payload === "[DONE]") {
        return;
      }
      let json: OpenAiStreamChunk;
      try {
        json = JSON.parse(payload) as OpenAiStreamChunk;
      } catch {
        return;
      }
      const choice = json.choices?.[0];
      const delta = choice?.delta;
      if (typeof delta?.content === "string" && delta.content.length > 0) {
        text += delta.content;
        onTextDelta(delta.content);
      }
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = partials.get(idx) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        partials.set(idx, cur);
      }
      if (choice?.finish_reason) {
        finish = choice.finish_reason;
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        // SSE: data lines are newline-delimited; a blank line ends an event.
        while ((nl = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nl).replace(/\r$/, "");
          buffer = buffer.slice(nl + 1);
          if (line.startsWith("data:")) {
            handleData(line.slice(5).replace(/^ /, ""));
          }
        }
      }
    } catch (err) {
      if (!isAbort(err)) {
        throw new AiError(`Stream from ${hostOf(this.opts.baseUrl)} failed.`, undefined, true);
      }
    } finally {
      reader.releaseLock();
    }

    const toolCalls: ToolCall[] = [...partials.values()]
      .filter((p) => p.name)
      .map((p) => ({ id: p.id, name: p.name, arguments: safeParse(p.args) }));
    return {
      text,
      toolCalls,
      stopReason: mapFinish(finish, toolCalls.length > 0),
    };
  }
}

interface OpenAiStreamChunk {
  choices?: Array<{
    delta?: {
      content?: string;
      tool_calls?: Array<{ index?: number; id?: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
}

interface OpenAiResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>;
    };
    finish_reason?: string;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function safeParse(raw: string | undefined): Record<string, unknown> {
  if (!raw || !raw.trim()) {
    return {};
  }
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function mapFinish(reason: string | undefined, hadTools: boolean): StopReason {
  if (hadTools || reason === "tool_calls") {
    return "tool_calls";
  }
  switch (reason) {
    case "stop":
      return "stop";
    case "length":
      return "length";
    case "content_filter":
      return "refusal";
    default:
      return reason ? "unknown" : "stop";
  }
}

function httpError(status: number, host: string): AiError {
  switch (status) {
    case 401:
    case 403:
      return new AiError(`${host} rejected the API key (HTTP ${status}). Check the key in Settings ▸ AI.`, status);
    case 404:
      return new AiError(`${host} returned 404 — check the base URL and model id.`, status);
    case 429:
      return new AiError(`${host} rate limit hit — try again in a moment.`, status, true);
    default:
      return new AiError(`${host} request failed (HTTP ${status}).`, status, status >= 500);
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
