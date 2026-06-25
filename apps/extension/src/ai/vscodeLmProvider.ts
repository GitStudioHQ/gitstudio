import * as vscode from "vscode";
import type {
  GitBrainProvider,
  CompleteRequest,
} from "./gitBrain";

// The zero-key path: route GitBrain through vscode.lm (the VS Code Language Model
// API) when the host exposes it. This covers GitHub Copilot's models AND any
// other LM provider the editor surfaces — Cursor exposes its own models through
// the same API — so we select with NO vendor filter and let every available
// chat model show up. This API does NOT exist on the extension's `^1.74.0`
// baseline (@types/vscode@1.74.0 has no `lm` namespace), so everything here is
// FEATURE-DETECTED at runtime and accessed through a locally-declared structural
// shim — never `vscode.LanguageModelChatMessage`, which wouldn't compile against
// the pinned types.
//
// If the user hasn't granted LM access, sendRequest may throw (or the consent
// prompt appears on first use); we catch and return null gracefully so AI
// features simply stay hidden rather than erroring into a git flow.

/** The slice of the vscode.lm surface we use, declared locally to compile on 1.74. */
interface LmShim {
  selectChatModels?: (selector?: {
    vendor?: string;
  }) => Thenable<LmChatModel[]>;
}

interface LmChatModel {
  /** Stable identifier for the model (used to remember the user's pick). */
  readonly id?: string;
  readonly vendor?: string;
  readonly family?: string;
  readonly name?: string;
  sendRequest: (
    messages: unknown[],
    options: Record<string, unknown>,
    token?: vscode.CancellationToken,
  ) => Thenable<{ text: AsyncIterable<string> }>;
}

interface LmMessageCtor {
  User: (content: string) => unknown;
}

/** Read `vscode.lm` if present (it isn't on the baseline). */
function getLm(): LmShim | undefined {
  const lm = (vscode as unknown as { lm?: LmShim }).lm;
  return lm && typeof lm.selectChatModels === "function" ? lm : undefined;
}

/** Read the `LanguageModelChatMessage` constructor if present. */
function getMessageCtor(): LmMessageCtor | undefined {
  const ctor = (vscode as unknown as { LanguageModelChatMessage?: LmMessageCtor })
    .LanguageModelChatMessage;
  return ctor && typeof ctor.User === "function" ? ctor : undefined;
}

/** Public shape of an available chat model, for the model picker. */
export interface LmModelInfo {
  id: string;
  vendor: string;
  family: string;
  name: string;
}

export interface VsCodeLmProviderOptions {
  /**
   * Returns the model id the user picked via the model picker (or undefined to
   * use the first available). Injected so the provider stays decoupled from the
   * globalState store.
   */
  getPreferredModelId?: () => string | undefined;
}

export class VsCodeLmProvider implements GitBrainProvider {
  readonly id = "vscode-lm";

  constructor(private readonly opts: VsCodeLmProviderOptions = {}) {}

  /** Available iff the host exposes vscode.lm AND a chat model is selectable. */
  async isAvailable(): Promise<boolean> {
    const lm = getLm();
    if (!lm || !getMessageCtor()) {
      return false;
    }
    try {
      // No vendor filter: Copilot's and Cursor's models both qualify.
      const models = await lm.selectChatModels!();
      return Array.isArray(models) && models.length > 0;
    } catch {
      return false;
    }
  }

  /** List every available chat model (no vendor filter), for the picker. */
  async listModels(): Promise<LmModelInfo[]> {
    const lm = getLm();
    if (!lm || !getMessageCtor()) {
      return [];
    }
    try {
      const models = await lm.selectChatModels!();
      if (!Array.isArray(models)) {
        return [];
      }
      return models
        .filter((m) => typeof m.id === "string" && m.id.length > 0)
        .map((m) => ({
          id: m.id as string,
          vendor: m.vendor ?? "",
          family: m.family ?? "",
          name: m.name ?? m.family ?? m.id ?? "",
        }));
    } catch {
      return [];
    }
  }

  /**
   * Pick the model to use: the remembered id when it's still available, else the
   * first available model (so a stale/removed pick degrades gracefully).
   */
  private async selectModel(): Promise<LmChatModel | undefined> {
    const lm = getLm();
    if (!lm) {
      return undefined;
    }
    try {
      const models = await lm.selectChatModels!();
      if (!Array.isArray(models) || models.length === 0) {
        return undefined;
      }
      const preferred = this.opts.getPreferredModelId?.();
      if (preferred) {
        const match = models.find((m) => m.id === preferred);
        if (match) {
          return match;
        }
      }
      return models[0];
    } catch {
      return undefined;
    }
  }

  async complete(req: CompleteRequest): Promise<string | null> {
    let assembled = "";
    const out = await this.stream(req, (t) => {
      assembled += t;
    });
    if (out !== null) {
      return out;
    }
    const trimmed = assembled.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  async stream(
    req: CompleteRequest,
    onDelta: (text: string) => void,
  ): Promise<string | null> {
    const model = await this.selectModel();
    const ctor = getMessageCtor();
    if (!model || !ctor) {
      return null;
    }

    // vscode.lm has no separate system field; fold the cacheable prefix into a
    // leading user message so the model still gets the style context.
    const messages: unknown[] = [];
    if (req.system && req.system.trim().length > 0) {
      messages.push(ctor.User(req.system));
    }
    messages.push(ctor.User(req.prompt));

    const token = abortToCancellation(req.signal);
    try {
      const response = await model.sendRequest(messages, {}, token?.token);
      let assembled = "";
      for await (const fragment of response.text) {
        assembled += fragment;
        onDelta(fragment);
      }
      const trimmed = assembled.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      // Consent denied, model error, or cancellation — stay silent.
      return null;
    } finally {
      token?.dispose();
    }
  }
}

/** Bridge an AbortSignal to a vscode CancellationTokenSource (best-effort). */
function abortToCancellation(
  signal?: AbortSignal,
): vscode.CancellationTokenSource | undefined {
  if (!signal) {
    return undefined;
  }
  const source = new vscode.CancellationTokenSource();
  if (signal.aborted) {
    source.cancel();
  } else {
    signal.addEventListener("abort", () => source.cancel(), { once: true });
  }
  return source;
}
