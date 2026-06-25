import * as vscode from "vscode";
import type {
  GitBrainProvider,
  CompleteRequest,
} from "./gitBrain";

// The zero-key path: route GitBrain through vscode.lm (GitHub Copilot's
// Language Model API) when the host exposes it. This API does NOT exist on the
// extension's `^1.74.0` baseline (@types/vscode@1.74.0 has no `lm` namespace),
// so everything here is FEATURE-DETECTED at runtime and accessed through a
// locally-declared structural shim — never `vscode.LanguageModelChatMessage`,
// which wouldn't compile against the pinned types.
//
// If the user hasn't granted Copilot LM access, sendRequest may throw (or the
// consent prompt appears on first use); we catch and return null gracefully so
// AI features simply stay hidden rather than erroring into a git flow.

/** The slice of the vscode.lm surface we use, declared locally to compile on 1.74. */
interface LmShim {
  selectChatModels?: (selector?: {
    vendor?: string;
  }) => Thenable<LmChatModel[]>;
}

interface LmChatModel {
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

export class VsCodeLmProvider implements GitBrainProvider {
  readonly id = "vscode-lm";

  /** Available iff the host exposes vscode.lm AND a Copilot model is selectable. */
  async isAvailable(): Promise<boolean> {
    const lm = getLm();
    if (!lm || !getMessageCtor()) {
      return false;
    }
    try {
      const models = await lm.selectChatModels!({ vendor: "copilot" });
      return Array.isArray(models) && models.length > 0;
    } catch {
      return false;
    }
  }

  private async selectModel(): Promise<LmChatModel | undefined> {
    const lm = getLm();
    if (!lm) {
      return undefined;
    }
    try {
      const models = await lm.selectChatModels!({ vendor: "copilot" });
      return Array.isArray(models) && models.length > 0 ? models[0] : undefined;
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
