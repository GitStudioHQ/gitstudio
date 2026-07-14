import {
  AnthropicSseParser,
  extractAnthropicText,
  type AnthropicMessageResponse,
} from "@gitstudio/engine/ai/gitBrainCore";
import type {
  GitBrainProvider,
  CompleteRequest,
  ModelTier,
} from "./gitBrain";

// The Anthropic bring-your-own-key provider. Runs entirely on the extension
// host (Node 22 → global fetch), so the API key never reaches a webview and
// there's no CORS to fight. The key storage is INJECTED via `getKey` so this
// class stays portable (the future desktop app can hand it a different store)
// and free of any vscode import beyond what the logger callback chooses to do.
//
// We hand-roll the HTTP rather than pull in @anthropic-ai/sdk: it keeps the
// extension bundle light and the request shape is small and stable.

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

/** Exact model IDs (no date suffixes) per the M10 authoritative facts. */
const DEFAULT_MODELS: Record<ModelTier, string> = {
  fast: "claude-haiku-4-5",
  mid: "claude-sonnet-4-6",
  deep: "claude-opus-4-8",
};

export interface AnthropicProviderOptions {
  /**
   * Injected secret getter — returns the stored key, or undefined when unset.
   * Accepts a Thenable so vscode's SecretStorage.get can be passed directly.
   */
  getKey: () => PromiseLike<string | undefined>;
  /** Friendly-message sink for surfaced errors (toast / log). Never throws. */
  onError?: (message: string) => void;
  /** Optional per-tier model overrides (from gitstudio.ai.anthropicModel*). */
  models?: Partial<Record<ModelTier, string>>;
  /** Injected fetch (defaults to global). Lets tests stub the network. */
  fetchImpl?: typeof fetch;
}

interface AnthropicSystemBlock {
  type: "text";
  text: string;
  cache_control?: { type: "ephemeral" };
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  system?: AnthropicSystemBlock[];
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  stream?: boolean;
}

export class AnthropicProvider implements GitBrainProvider {
  readonly id = "anthropic";

  constructor(private readonly opts: AnthropicProviderOptions) {}

  /** Available iff a key is present. */
  async isAvailable(): Promise<boolean> {
    const key = await this.opts.getKey();
    return typeof key === "string" && key.trim().length > 0;
  }

  private modelFor(tier: ModelTier): string {
    return this.opts.models?.[tier] ?? DEFAULT_MODELS[tier];
  }

  private maxTokensFor(req: CompleteRequest): number {
    if (req.maxTokens !== undefined) {
      return req.maxTokens;
    }
    // Commit messages stay tight; explain/summaries get more room.
    return req.model === "fast" ? 512 : 1024;
  }

  private buildBody(req: CompleteRequest, stream: boolean): AnthropicRequestBody {
    const tier: ModelTier = req.model ?? "fast";
    const body: AnthropicRequestBody = {
      model: this.modelFor(tier),
      max_tokens: this.maxTokensFor(req),
      messages: [{ role: "user", content: req.prompt }],
    };
    if (stream) {
      body.stream = true;
    }
    if (req.system && req.system.trim().length > 0) {
      // Put the stable repo-context prefix in `system` as a cacheable block;
      // the volatile diff sits in the user message after it.
      const block: AnthropicSystemBlock = { type: "text", text: req.system };
      if (req.systemCacheable) {
        block.cache_control = { type: "ephemeral" };
      }
      body.system = [block];
    }
    return body;
  }

  /** Common header set; resolves the key or returns undefined when missing. */
  private async headers(): Promise<Record<string, string> | undefined> {
    const key = await this.opts.getKey();
    if (!key || key.trim().length === 0) {
      return undefined;
    }
    return {
      "x-api-key": key.trim(),
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    };
  }

  /** Map an HTTP status to a friendly message; null for "no friendly note". */
  private friendlyFor(status: number): string {
    switch (status) {
      case 401:
        return "GitBrain: the Anthropic API key is missing or invalid. Run “GitStudio: Set AI API Key”.";
      case 429:
        return "GitBrain: Anthropic rate limit hit — try again in a moment.";
      case 529:
        return "GitBrain: Anthropic is temporarily overloaded — try again shortly.";
      default:
        return `GitBrain: Anthropic request failed (HTTP ${status}).`;
    }
  }

  private report(message: string): void {
    this.opts.onError?.(message);
  }

  async complete(req: CompleteRequest): Promise<string | null> {
    const headers = await this.headers();
    if (!headers) {
      return null;
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(this.buildBody(req, false)),
        signal: req.signal,
      });
      if (!res.ok) {
        this.report(this.friendlyFor(res.status));
        return null;
      }
      const json = (await res.json()) as AnthropicMessageResponse;
      const text = extractAnthropicText(json);
      if (text === null && json.stop_reason === "refusal") {
        this.report("GitBrain: the model declined this request.");
      }
      return text;
    } catch (err) {
      if (isAbort(err)) {
        return null;
      }
      this.report("GitBrain: couldn't reach Anthropic (network error).");
      return null;
    }
  }

  async stream(
    req: CompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<string | null> {
    const headers = await this.headers();
    if (!headers) {
      return null;
    }
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(ENDPOINT, {
        method: "POST",
        headers,
        body: JSON.stringify(this.buildBody(req, true)),
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

      const parser = new AnthropicSseParser();
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
      this.report("GitBrain: couldn't reach Anthropic (network error).");
      return null;
    }
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}
