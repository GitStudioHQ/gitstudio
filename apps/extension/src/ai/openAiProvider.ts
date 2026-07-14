import {
  OpenAiSseParser,
  extractOpenAiText,
  type OpenAiChatResponse,
} from "@gitstudio/engine/ai/gitBrainCore";
import type {
  GitBrainProvider,
  CompleteRequest,
  ModelTier,
} from "./gitBrain";

// The OpenAI-compatible bring-your-own-endpoint provider. A SINGLE provider that
// covers OpenAI, Codex, OpenRouter, Ollama, LM Studio, and any other server that
// speaks the `/chat/completions` API — because they all share one request and
// response shape. Runs entirely on the extension host (Node 22 → global fetch),
// so a key (when present) never reaches a webview and there's no CORS to fight.
//
// The key getter and the config getter are INJECTED so this class stays portable
// (the desktop app can hand it a different store/settings source) and free of
// any vscode import. We hand-roll the HTTP rather than pull in the openai SDK:
// it keeps the bundle light and the request shape is small and stable.
//
// Local servers (Ollama, LM Studio) need NO key — so the Authorization header is
// only added when a key actually exists, and `isAvailable()` is true whenever a
// model is configured (the base URL always has a default).

export interface OpenAiConfig {
  /** Base URL, e.g. https://api.openai.com/v1 or http://localhost:11434/v1. */
  baseUrl: string;
  /** Per-tier model IDs (empty string ⇒ that tier is unconfigured). */
  models: Record<ModelTier, string>;
}

export interface OpenAiProviderOptions {
  /**
   * Injected secret getter — returns the stored key, or undefined when unset.
   * Accepts a Thenable so vscode's SecretStorage.get can be passed directly.
   * A key is OPTIONAL: local servers (Ollama / LM Studio) need none.
   */
  getKey: () => PromiseLike<string | undefined>;
  /** Reads the current base URL + per-tier models from settings. */
  config: () => OpenAiConfig;
  /** Friendly-message sink for surfaced errors (toast / log). Never throws. */
  onError?: (message: string) => void;
  /** Injected fetch (defaults to global). Lets tests stub the network. */
  fetchImpl?: typeof fetch;
}

interface OpenAiRequestBody {
  model: string;
  max_tokens: number;
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  stream?: boolean;
}

export class OpenAiProvider implements GitBrainProvider {
  readonly id = "openai";

  constructor(private readonly opts: OpenAiProviderOptions) {}

  /** Available iff a model is configured (the base URL always has a default). */
  isAvailable(): boolean {
    const cfg = this.opts.config();
    if (!cfg.baseUrl || cfg.baseUrl.trim().length === 0) {
      return false;
    }
    return (
      this.hasModel(cfg, "fast") ||
      this.hasModel(cfg, "mid") ||
      this.hasModel(cfg, "deep")
    );
  }

  private hasModel(cfg: OpenAiConfig, tier: ModelTier): boolean {
    const id = cfg.models[tier];
    return typeof id === "string" && id.trim().length > 0;
  }

  /** Resolve a tier to a concrete model id, falling back across tiers. */
  private modelFor(cfg: OpenAiConfig, tier: ModelTier): string | undefined {
    const order: ModelTier[] =
      tier === "fast"
        ? ["fast", "mid", "deep"]
        : tier === "mid"
          ? ["mid", "deep", "fast"]
          : ["deep", "mid", "fast"];
    for (const t of order) {
      const id = cfg.models[t];
      if (typeof id === "string" && id.trim().length > 0) {
        return id.trim();
      }
    }
    return undefined;
  }

  private maxTokensFor(req: CompleteRequest): number {
    if (req.maxTokens !== undefined) {
      return req.maxTokens;
    }
    return req.model === "fast" ? 512 : 1024;
  }

  private buildBody(
    cfg: OpenAiConfig,
    model: string,
    req: CompleteRequest,
    stream: boolean,
  ): OpenAiRequestBody {
    const messages: OpenAiRequestBody["messages"] = [];
    if (req.system && req.system.trim().length > 0) {
      messages.push({ role: "system", content: req.system });
    }
    messages.push({ role: "user", content: req.prompt });
    const body: OpenAiRequestBody = {
      model,
      max_tokens: this.maxTokensFor(req),
      messages,
    };
    if (stream) {
      body.stream = true;
    }
    return body;
  }

  /** Headers: JSON always; Authorization only when a key exists (local: none). */
  private async headers(): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const key = await this.opts.getKey();
    if (typeof key === "string" && key.trim().length > 0) {
      headers["Authorization"] = `Bearer ${key.trim()}`;
    }
    return headers;
  }

  private endpoint(cfg: OpenAiConfig): string {
    // Tolerate a trailing slash on the configured base URL.
    return cfg.baseUrl.replace(/\/+$/, "") + "/chat/completions";
  }

  /** Map an HTTP status to a friendly message. */
  private friendlyFor(status: number): string {
    switch (status) {
      case 401:
        return "GitBrain: the OpenAI-compatible endpoint rejected the API key (401). Run “GitStudio: Set OpenAI API Key”, or clear it for a local server.";
      case 404:
        return "GitBrain: the OpenAI-compatible endpoint returned 404 — check the base URL and model ID in settings.";
      case 429:
        return "GitBrain: OpenAI rate limit hit — try again in a moment.";
      default:
        return `GitBrain: OpenAI-compatible request failed (HTTP ${status}).`;
    }
  }

  private report(message: string): void {
    this.opts.onError?.(message);
  }

  /** A friendly note for a connection-level failure (local server down, etc.). */
  private reportNetwork(cfg: OpenAiConfig): void {
    this.report(
      `GitBrain: couldn't reach ${cfg.baseUrl} — is the model server running?`,
    );
  }

  async complete(req: CompleteRequest): Promise<string | null> {
    const cfg = this.opts.config();
    const model = this.modelFor(cfg, req.model ?? "fast");
    if (!model) {
      return null;
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(this.endpoint(cfg), {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(this.buildBody(cfg, model, req, false)),
        signal: req.signal,
      });
      if (!res.ok) {
        this.report(this.friendlyFor(res.status));
        return null;
      }
      const json = (await res.json()) as OpenAiChatResponse;
      return extractOpenAiText(json);
    } catch (err) {
      if (isAbort(err)) {
        return null;
      }
      this.reportNetwork(cfg);
      return null;
    }
  }

  async stream(
    req: CompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<string | null> {
    const cfg = this.opts.config();
    const model = this.modelFor(cfg, req.model ?? "fast");
    if (!model) {
      return null;
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(this.endpoint(cfg), {
        method: "POST",
        headers: await this.headers(),
        body: JSON.stringify(this.buildBody(cfg, model, req, true)),
        signal: req.signal,
      });
      if (!res.ok) {
        this.report(this.friendlyFor(res.status));
        return null;
      }
      const body = res.body;
      if (!body) {
        // No stream body — fall back to non-streaming.
        return this.complete(req);
      }

      const parser = new OpenAiSseParser();
      const decoder = new TextDecoder("utf8");
      let assembled = "";
      const reader = body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          const chunk = decoder.decode(value, { stream: true });
          for (const delta of parser.push(chunk)) {
            assembled += delta;
            onDelta(delta);
          }
          if (parser.done) {
            break;
          }
        }
      } finally {
        reader.releaseLock();
      }
      const trimmed = assembled.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch (err) {
      if (isAbort(err)) {
        return null;
      }
      this.reportNetwork(cfg);
      return null;
    }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
