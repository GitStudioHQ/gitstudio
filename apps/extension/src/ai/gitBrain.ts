import * as vscode from "vscode";
import {
  buildCommitStyleSystem,
  buildCommitPrompt,
  buildExplainPrompt,
  buildSummarizePrompt,
  buildPrDescriptionPrompt,
  truncateDiff,
  type CommitStyle,
} from "@gitstudio/engine/ai/gitBrainCore";
import { AnthropicProvider } from "./anthropicProvider";
import { VsCodeLmProvider, type LmModelInfo } from "./vscodeLmProvider";
import { CliProvider, CLI_SPECS } from "./cliProvider";
import { OpenAiProvider, type OpenAiConfig } from "./openAiProvider";

// GitBrain — the optional, bring-your-own-key AI layer (M10).
//
// It is OFF until configured: with no usable provider, every feature returns
// null, the `gitstudio.ai.enabled` context key stays false, and the AI
// affordances (palette commands, the commit-box ✨) stay hidden. AI never gates
// or breaks a git operation — a missing key or a failed request just means "no
// AI here", silently.

export type ModelTier = "fast" | "mid" | "deep";

/** What every GitBrain provider must implement. */
export interface GitBrainProvider {
  readonly id: string;
  isAvailable(): Promise<boolean> | boolean;
  complete(req: CompleteRequest): Promise<string | null>;
  /** Optional streaming variant (explain/summaries prefer it). */
  stream?(
    req: CompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<string | null>;
}

export interface CompleteRequest {
  /** Stable, cacheable repo-context prefix (goes in `system`). */
  system?: string;
  /** Whether to mark `system` with cache_control: ephemeral. */
  systemCacheable?: boolean;
  /** The volatile prompt (the staged diff lives here). */
  prompt: string;
  /** Maps to a concrete model ID inside the provider. */
  model?: ModelTier;
  maxTokens?: number;
  signal?: AbortSignal;
}

/**
 * The user's provider choice (gitstudio.ai.provider).
 * `copilot` selects the VS Code Language Model API (Copilot / Cursor models).
 * `openai` selects any OpenAI-compatible endpoint (incl. local Ollama/LM Studio).
 */
export type ProviderChoice = "auto" | "copilot" | "anthropic" | "openai" | "cli" | "off";

/** Snapshot of the AI connection state for the settings webview panel. */
export interface AiConnectionStatus {
  provider: ProviderChoice;
  /** A provider is actually usable right now. */
  ready: boolean;
  /** Which provider is active (anthropic/openai/vscode-lm), when ready. */
  activeId?: string;
  hasAnthropicKey: boolean;
  hasOpenaiKey: boolean;
  copilotAvailable: boolean;
  openaiBaseUrl: string;
  openaiModel: string;
  /** The selected local-agent CLI (claude-code/codex/gemini-cli), or "". */
  cliAgent: string;
  commitStyle: CommitStyle;
}

/** Storage key for the Anthropic API key in SecretStorage. */
export const ANTHROPIC_KEY_SECRET = "gitstudio.ai.anthropicApiKey";

/** Storage key for the OpenAI-compatible API key in SecretStorage (optional). */
export const OPENAI_KEY_SECRET = "gitstudio.ai.openaiApiKey";

/** globalState key remembering the user's chosen vscode.lm model id. */
export const LM_MODEL_STATE_KEY = "gitstudio.ai.lmModelId";

/**
 * Built-in AI code-review prompt (used unless the user overrides it via the
 * `gitstudio.ai.reviewPrompt` setting). Tuned to be useful like an editor's
 * inline reviewer: substantive findings, severity-ranked, with fixes — not a
 * restatement of the diff and not style nitpicking.
 */
export const DEFAULT_REVIEW_PROMPT = [
  "You are an expert code reviewer performing a focused review of a git diff,",
  "like a senior engineer reviewing a pull request. Report ONLY substantive",
  "findings: real bugs, correctness errors, security issues, resource leaks,",
  "race conditions, missing error handling, and clear design/maintainability",
  "problems the change introduces.",
  "",
  "Guidelines:",
  "- Prioritize correctness and security. Skip pure style/formatting nitpicks",
  "  unless they cause a real bug.",
  "- Order findings most-severe first. Do NOT invent issues; if the change is",
  "  clean, say so.",
  "- Be specific and cite the exact code. Do NOT restate what the diff does.",
  "- Only review the changes shown; note if you need more context.",
  "",
  "Respond in GitHub-flavored Markdown, structured EXACTLY like this:",
  "",
  "1. One sentence summarizing the overall risk of the change.",
  "2. A line `## Findings`, then one bullet per finding, formatted as:",
  "   - **<Severity>** `path/to/file.ext:line` — Short title. One sentence on the",
  "     concrete failure it causes. **Fix:** the specific change to make.",
  "   where <Severity> is exactly High, Medium, or Low (bold, first in the bullet).",
  "",
  "If there are no substantive issues, respond with exactly this single line and",
  "nothing else: `✅ No substantive issues found — the change looks clean.`",
].join("\n");

export interface CommitMessageOptions {
  style?: CommitStyle;
  /** Recent commit subjects for the cacheable style prefix. */
  recentSubjects?: readonly string[];
  signal?: AbortSignal;
}

export class GitBrain implements vscode.Disposable {
  private readonly anthropic: AnthropicProvider;
  private readonly vscodeLm: VsCodeLmProvider;
  private readonly openai: OpenAiProvider;
  private readonly disposables: vscode.Disposable[] = [];
  /** Last error a provider reported — surfaced by testConnection() with detail. */
  private lastProviderError: string | undefined;
  /** While a test is running, route provider errors to the note (no toast). */
  private suppressErrorToast = false;
  /** Fires when AI becomes enabled/disabled, so views can refresh live. */
  private readonly enabledChanged = new vscode.EventEmitter<boolean>();
  readonly onDidChangeEnabled = this.enabledChanged.event;
  private lastEnabled: boolean | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    const onError = (message: string) => {
      this.lastProviderError = message;
      if (!this.suppressErrorToast) {
        void vscode.window.showWarningMessage(message);
      }
    };
    this.anthropic = new AnthropicProvider({
      getKey: () => this.context.secrets.get(ANTHROPIC_KEY_SECRET),
      onError,
      models: this.readModelOverrides(),
    });
    this.vscodeLm = new VsCodeLmProvider({
      getPreferredModelId: () => this.preferredLmModelId(),
    });
    this.openai = new OpenAiProvider({
      getKey: () => this.context.secrets.get(OPENAI_KEY_SECRET),
      config: () => this.openAiConfig(),
      onError,
    });

    // Re-evaluate availability when a key changes or a relevant setting flips.
    this.disposables.push(
      this.context.secrets.onDidChange((e) => {
        if (e.key === ANTHROPIC_KEY_SECRET || e.key === OPENAI_KEY_SECRET) {
          void this.refreshEnabled();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("gitstudio.ai.provider") ||
          e.affectsConfiguration("gitstudio.ai.anthropicModelFast") ||
          e.affectsConfiguration("gitstudio.ai.anthropicModelMid") ||
          e.affectsConfiguration("gitstudio.ai.anthropicModelDeep") ||
          e.affectsConfiguration("gitstudio.ai.openai.baseUrl") ||
          e.affectsConfiguration("gitstudio.ai.openai.modelFast") ||
          e.affectsConfiguration("gitstudio.ai.openai.modelMid") ||
          e.affectsConfiguration("gitstudio.ai.openai.modelDeep")
        ) {
          void this.refreshEnabled();
        }
      }),
      this.enabledChanged,
    );
  }

  /** Compute and publish `gitstudio.ai.enabled` so menus/buttons show/hide. */
  async refreshEnabled(): Promise<void> {
    const enabled = await this.isEnabled();
    await vscode.commands.executeCommand(
      "setContext",
      "gitstudio.ai.enabled",
      enabled,
    );
    // Notify listeners (the commit composer) so the ✨/plug buttons update the
    // instant a model is connected or disconnected — not on the next git event.
    if (enabled !== this.lastEnabled) {
      this.lastEnabled = enabled;
      this.enabledChanged.fire(enabled);
    }
  }

  private config() {
    return vscode.workspace.getConfiguration("gitstudio.ai");
  }

  private readModelOverrides(): Partial<Record<ModelTier, string>> {
    const cfg = this.config();
    const overrides: Partial<Record<ModelTier, string>> = {};
    const fast = cfg.get<string>("anthropicModelFast");
    const mid = cfg.get<string>("anthropicModelMid");
    const deep = cfg.get<string>("anthropicModelDeep");
    if (fast) overrides.fast = fast;
    if (mid) overrides.mid = mid;
    if (deep) overrides.deep = deep;
    return overrides;
  }

  /** Read the OpenAI-compatible base URL + per-tier model IDs from settings. */
  private openAiConfig(): OpenAiConfig {
    const cfg = this.config();
    return {
      baseUrl: cfg.get<string>("openai.baseUrl", "https://api.openai.com/v1"),
      models: {
        fast: cfg.get<string>("openai.modelFast", ""),
        mid: cfg.get<string>("openai.modelMid", ""),
        deep: cfg.get<string>("openai.modelDeep", ""),
      },
    };
  }

  /** The remembered vscode.lm model id (from the model picker), if any. */
  private preferredLmModelId(): string | undefined {
    const id = this.context.globalState.get<string>(LM_MODEL_STATE_KEY);
    return id && id.length > 0 ? id : undefined;
  }

  /** Remember the user's vscode.lm model pick (used by the model picker). */
  async setPreferredLmModelId(id: string | undefined): Promise<void> {
    await this.context.globalState.update(LM_MODEL_STATE_KEY, id);
  }

  /** List available vscode.lm chat models (Copilot + Cursor), for the picker. */
  listLmModels(): Promise<LmModelInfo[]> {
    return this.vscodeLm.listModels();
  }

  private providerChoice(): ProviderChoice {
    return this.config().get<ProviderChoice>("provider", "auto");
  }

  private commitStyle(): CommitStyle {
    return this.config().get<CommitStyle>("commitStyle", "conventional");
  }

  private cliAgent(): string {
    return this.config().get<string>("cliAgent", "");
  }

  /** Build the local-agent CLI provider for the current settings (or undefined). */
  private cliProviderFor(agent: string): CliProvider | undefined {
    if (!CLI_SPECS[agent]) {
      return undefined;
    }
    return new CliProvider({
      agent,
      cwd: () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      model: () => this.config().get<string>("cliModel", "") || undefined,
    });
  }

  /**
   * Resolve the active provider per the `provider` setting:
   *   auto       → vscode.lm (zero-key Copilot/Cursor) → Anthropic (if keyed) →
   *                OpenAI-compatible (if a model is configured) → none.
   *   copilot    → vscode.lm iff available.
   *   anthropic  → Anthropic iff a key is set.
   *   openai     → OpenAI-compatible iff a model is configured.
   *   off        → none.
   * Returns undefined when nothing is usable (features hidden).
   */
  async getProvider(): Promise<GitBrainProvider | undefined> {
    const choice = this.providerChoice();
    if (choice === "off") {
      return undefined;
    }
    if (choice === "copilot") {
      return (await this.vscodeLm.isAvailable()) ? this.vscodeLm : undefined;
    }
    if (choice === "anthropic") {
      return (await this.anthropic.isAvailable()) ? this.anthropic : undefined;
    }
    if (choice === "openai") {
      return this.openai.isAvailable() ? this.openai : undefined;
    }
    if (choice === "cli") {
      const cli = this.cliProviderFor(this.cliAgent());
      return cli && (await cli.isAvailable()) ? cli : undefined;
    }
    // auto: prefer the zero-key vscode.lm path, then a keyed Anthropic, then a
    // configured OpenAI-compatible endpoint (incl. a local model server).
    if (await this.vscodeLm.isAvailable()) {
      return this.vscodeLm;
    }
    if (await this.anthropic.isAvailable()) {
      return this.anthropic;
    }
    if (this.openai.isAvailable()) {
      return this.openai;
    }
    return undefined;
  }

  /** True when some provider is usable. */
  async isEnabled(): Promise<boolean> {
    return (await this.getProvider()) !== undefined;
  }

  // ── High-level features ────────────────────────────────────────────────────

  /** Draft a commit message from the staged diff. Null when AI is unavailable. */
  async generateCommitMessage(
    diff: string,
    opts?: CommitMessageOptions,
  ): Promise<string | null> {
    const provider = await this.getProvider();
    if (!provider) {
      return null;
    }
    const style = opts?.style ?? this.commitStyle();
    const system = buildCommitStyleSystem(opts?.recentSubjects ?? [], style);
    const prompt = buildCommitPrompt(truncateDiff(diff));
    return provider.complete({
      system,
      systemCacheable: true,
      prompt,
      model: "fast",
      maxTokens: 512,
      signal: opts?.signal,
    });
  }

  /** Explain a diff (Markdown). Streams when the provider and `onDelta` allow. */
  async explainDiff(
    diff: string,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = await this.getProvider();
    if (!provider) {
      return null;
    }
    const req: CompleteRequest = {
      prompt: buildExplainPrompt(truncateDiff(diff, 8000)),
      model: "mid",
      maxTokens: 1024,
      signal,
    };
    if (onDelta && provider.stream) {
      return provider.stream(req, onDelta);
    }
    return provider.complete(req);
  }

  /** Summarize a set of changes (Markdown). */
  async summarizeChanges(
    diff: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = await this.getProvider();
    if (!provider) {
      return null;
    }
    return provider.complete({
      prompt: buildSummarizePrompt(truncateDiff(diff, 8000)),
      model: "mid",
      maxTokens: 1024,
      signal,
    });
  }

  /**
   * Review a diff and return Markdown findings — an AI code review, Cursor-style.
   * Uses the user's custom prompt (`gitstudio.ai.reviewPrompt`) when set, else a
   * strong built-in one. Runs on the `deep` model tier and streams when possible.
   */
  async reviewChanges(
    diff: string,
    onDelta?: (text: string) => void,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = await this.getProvider();
    if (!provider) {
      return null;
    }
    const req: CompleteRequest = {
      system: this.reviewPrompt(),
      systemCacheable: true,
      prompt: `Review the following git diff.\n\n${truncateDiff(diff, 12000)}`,
      model: "deep",
      maxTokens: 2048,
      signal,
    };
    if (onDelta && provider.stream) {
      return provider.stream(req, onDelta);
    }
    return provider.complete(req);
  }

  /** The code-review system prompt: the user's custom one, or the built-in. */
  private reviewPrompt(): string {
    const custom = this.config().get<string>("reviewPrompt", "").trim();
    return custom.length > 0 ? custom : DEFAULT_REVIEW_PROMPT;
  }

  /** Draft a PR description (used by M11). Null when AI is unavailable. */
  async generatePrDescription(
    commits: readonly string[],
    diff: string,
    signal?: AbortSignal,
  ): Promise<string | null> {
    const provider = await this.getProvider();
    if (!provider) {
      return null;
    }
    return provider.complete({
      prompt: buildPrDescriptionPrompt(commits, truncateDiff(diff, 8000)),
      model: "mid",
      maxTokens: 1024,
      signal,
    });
  }

  // ── Connection panel API (backs the AI settings webview) ───────────────────

  /** A snapshot of the current AI connection, for the settings panel. */
  async connectionStatus(): Promise<AiConnectionStatus> {
    const [hasAnthropicKey, hasOpenaiKey, copilotAvailable, active] =
      await Promise.all([
        this.context.secrets.get(ANTHROPIC_KEY_SECRET).then((v) => !!v),
        this.context.secrets.get(OPENAI_KEY_SECRET).then((v) => !!v),
        this.vscodeLm.isAvailable(),
        this.getProvider(),
      ]);
    const oa = this.openAiConfig();
    return {
      provider: this.providerChoice(),
      ready: active !== undefined,
      activeId: active?.id,
      hasAnthropicKey,
      hasOpenaiKey,
      copilotAvailable,
      openaiBaseUrl: oa.baseUrl,
      openaiModel: oa.models.mid || oa.models.fast || "",
      cliAgent: this.cliAgent(),
      commitStyle: this.commitStyle(),
    };
  }

  /** Select a local-agent CLI + switch the provider to it. */
  async setCliAgent(agent: string): Promise<void> {
    await this.config().update(
      "cliAgent",
      agent,
      vscode.ConfigurationTarget.Global,
    );
    await this.setProviderChoice("cli");
  }

  async setProviderChoice(choice: ProviderChoice): Promise<void> {
    await this.config().update(
      "provider",
      choice,
      vscode.ConfigurationTarget.Global,
    );
    await this.refreshEnabled();
  }

  async setCommitStyle(style: CommitStyle): Promise<void> {
    await this.config().update(
      "commitStyle",
      style,
      vscode.ConfigurationTarget.Global,
    );
  }

  async setAnthropicKey(key: string): Promise<void> {
    await this.context.secrets.store(ANTHROPIC_KEY_SECRET, key);
    await this.refreshEnabled();
  }

  async setOpenAiKey(key: string): Promise<void> {
    await this.context.secrets.store(OPENAI_KEY_SECRET, key);
    await this.refreshEnabled();
  }

  /** Point the OpenAI-compatible provider at an endpoint + model (covers OpenAI,
   *  OpenRouter, Groq, and local servers like Ollama / LM Studio). */
  async setOpenAiEndpoint(baseUrl: string, model: string): Promise<void> {
    const cfg = this.config();
    await cfg.update("openai.baseUrl", baseUrl, vscode.ConfigurationTarget.Global);
    await cfg.update("openai.modelFast", model, vscode.ConfigurationTarget.Global);
    await cfg.update("openai.modelMid", model, vscode.ConfigurationTarget.Global);
    await cfg.update("openai.modelDeep", model, vscode.ConfigurationTarget.Global);
    await this.refreshEnabled();
  }

  async setAnthropicModel(model: string): Promise<void> {
    const cfg = this.config();
    await cfg.update("anthropicModelFast", model, vscode.ConfigurationTarget.Global);
    await cfg.update("anthropicModelMid", model, vscode.ConfigurationTarget.Global);
    await cfg.update("anthropicModelDeep", model, vscode.ConfigurationTarget.Global);
  }

  /** Disconnect: forget keys and turn AI off. */
  async disconnectAll(): Promise<void> {
    await this.context.secrets.delete(ANTHROPIC_KEY_SECRET);
    await this.context.secrets.delete(OPENAI_KEY_SECRET);
    await this.setProviderChoice("off");
  }

  /** Live-probe the active provider with a tiny prompt. */
  /** Read-and-clear the last provider error (via a method so TS keeps the type). */
  private takeLastError(): string | undefined {
    const e = this.lastProviderError;
    this.lastProviderError = undefined;
    return e;
  }

  async testConnection(): Promise<{ ok: boolean; message: string }> {
    const provider = await this.getProvider();
    if (!provider) {
      return { ok: false, message: "No model is connected yet — pick one below." };
    }
    this.lastProviderError = undefined;
    this.suppressErrorToast = true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await provider.complete({
        prompt: "Reply with the single word: ok",
        model: "fast",
        maxTokens: 8,
        signal: controller.signal,
      });
      if (r && r.trim().length > 0) {
        return { ok: true, message: "Success — the model replied. You're all set." };
      }
      if (controller.signal.aborted) {
        return { ok: false, message: "Timed out after 15s — is the server running and the model loaded?" };
      }
      // The provider swallows the real reason into onError; surface it here.
      const detail = this.takeLastError();
      return {
        ok: false,
        message: detail
          ? detail.replace(/^GitBrain:\s*/, "")
          : "No response from the model — check the server, base URL and model ID.",
      };
    } catch (e) {
      return {
        ok: false,
        message: e instanceof Error ? e.message : "Test failed.",
      };
    } finally {
      clearTimeout(timer);
      this.suppressErrorToast = false;
    }
  }

  /**
   * Best-effort: list the models a provider offers, for the connect panel's
   * auto-detect. OpenAI-compatible endpoints (incl. Ollama / LM Studio) answer
   * `GET {baseUrl}/models`; Anthropic answers `GET /v1/models`. Returns [] on any
   * failure so the UI can fall back to a free-text field.
   */
  async detectModels(
    kind: string,
    baseUrl: string,
    key: string,
  ): Promise<string[]> {
    try {
      if (kind === "anthropic") {
        const k =
          key || (await this.context.secrets.get(ANTHROPIC_KEY_SECRET)) || "";
        if (!k) {
          return [];
        }
        const r = await fetch("https://api.anthropic.com/v1/models?limit=100", {
          headers: { "x-api-key": k, "anthropic-version": "2023-06-01" },
        });
        if (!r.ok) {
          return [];
        }
        const j = (await r.json()) as { data?: { id?: string }[] };
        return (j.data ?? []).map((m) => m.id ?? "").filter(Boolean);
      }
      // OpenAI-compatible (openai/openrouter/groq/ollama/lmstudio/custom).
      const base = (baseUrl || this.openAiConfig().baseUrl).replace(/\/+$/, "");
      const k = key || (await this.context.secrets.get(OPENAI_KEY_SECRET)) || "";
      const headers: Record<string, string> = {};
      if (k) {
        headers["Authorization"] = `Bearer ${k}`;
      }
      const r = await fetch(`${base}/models`, { headers });
      if (!r.ok) {
        return [];
      }
      const j = (await r.json()) as { data?: { id?: string }[] };
      return (j.data ?? [])
        .map((m) => m.id ?? "")
        .filter(Boolean)
        .sort();
    } catch {
      return [];
    }
  }

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
