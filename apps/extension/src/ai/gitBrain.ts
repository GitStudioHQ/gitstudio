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
type ProviderChoice = "auto" | "copilot" | "anthropic" | "openai" | "off";

/** Storage key for the Anthropic API key in SecretStorage. */
export const ANTHROPIC_KEY_SECRET = "gitstudio.ai.anthropicApiKey";

/** Storage key for the OpenAI-compatible API key in SecretStorage (optional). */
export const OPENAI_KEY_SECRET = "gitstudio.ai.openaiApiKey";

/** globalState key remembering the user's chosen vscode.lm model id. */
export const LM_MODEL_STATE_KEY = "gitstudio.ai.lmModelId";

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

  constructor(private readonly context: vscode.ExtensionContext) {
    const onError = (message: string) => {
      void vscode.window.showWarningMessage(message);
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

  dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
