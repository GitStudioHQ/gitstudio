import * as vscode from "vscode";
import type { GitBrain } from "./gitBrain";
import { getNonce } from "../webview/html";
// Shared design tokens (inlined as text by esbuild). We ALSO inline the desktop
// app's own tokens below so this panel is a pixel-for-pixel match of the app's
// "AI Models" settings — the same violet, cards, pills, gallery and fields.
import tokensCss from "../../../../packages/webview-ui/src/styles/tokens.css";

/** Real brand marks (from the app's Lobehub icon set, MIT) — monochrome inline
 * SVG using currentColor. Keyed by our provider ids; injected into the webview.
 * Providers without a mark fall back to a codicon. */
const LOGO_PATHS: Record<string, string> = {
  anthropic: "<path d=\"M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z\"></path>",
  openai: "<path d=\"M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z\"></path>",
  openrouter: "<path d=\"M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z\"></path>",
  groq: "<path d=\"M12.036 2c-3.853-.035-7 3-7.036 6.781-.035 3.782 3.055 6.872 6.908 6.907h2.42v-2.566h-2.292c-2.407.028-4.38-1.866-4.408-4.23-.029-2.362 1.901-4.298 4.308-4.326h.1c2.407 0 4.358 1.915 4.365 4.278v6.305c0 2.342-1.944 4.25-4.323 4.279a4.375 4.375 0 01-3.033-1.252l-1.851 1.818A7 7 0 0012.029 22h.092c3.803-.056 6.858-3.083 6.879-6.816v-6.5C18.907 4.963 15.817 2 12.036 2z\"></path>",
  ollama: "<path d=\"M7.905 1.09c.216.085.411.225.588.41.295.306.544.744.734 1.263.191.522.315 1.1.362 1.68a5.054 5.054 0 012.049-.636l.051-.004c.87-.07 1.73.087 2.48.474.101.053.2.11.297.17.05-.569.172-1.134.36-1.644.19-.52.439-.957.733-1.264a1.67 1.67 0 01.589-.41c.257-.1.53-.118.796-.042.401.114.745.368 1.016.737.248.337.434.769.561 1.287.23.934.27 2.163.115 3.645l.053.04.026.019c.757.576 1.284 1.397 1.563 2.35.435 1.487.216 3.155-.534 4.088l-.018.021.002.003c.417.762.67 1.567.724 2.4l.002.03c.064 1.065-.2 2.137-.814 3.19l-.007.01.01.024c.472 1.157.62 2.322.438 3.486l-.006.039a.651.651 0 01-.747.536.648.648 0 01-.54-.742c.167-1.033.01-2.069-.48-3.123a.643.643 0 01.04-.617l.004-.006c.604-.924.854-1.83.8-2.72-.046-.779-.325-1.544-.8-2.273a.644.644 0 01.18-.886l.009-.006c.243-.159.467-.565.58-1.12a4.229 4.229 0 00-.095-1.974c-.205-.7-.58-1.284-1.105-1.683-.595-.454-1.383-.673-2.38-.61a.653.653 0 01-.632-.371c-.314-.665-.772-1.141-1.343-1.436a3.288 3.288 0 00-1.772-.332c-1.245.099-2.343.801-2.67 1.686a.652.652 0 01-.61.425c-1.067.002-1.893.252-2.497.703-.522.39-.878.935-1.066 1.588a4.07 4.07 0 00-.068 1.886c.112.558.331 1.02.582 1.269l.008.007c.212.207.257.53.109.785-.36.622-.629 1.549-.673 2.44-.05 1.018.186 1.902.719 2.536l.016.019a.643.643 0 01.095.69c-.576 1.236-.753 2.252-.562 3.052a.652.652 0 01-1.269.298c-.243-1.018-.078-2.184.473-3.498l.014-.035-.008-.012a4.339 4.339 0 01-.598-1.309l-.005-.019a5.764 5.764 0 01-.177-1.785c.044-.91.278-1.842.622-2.59l.012-.026-.002-.002c-.293-.418-.51-.953-.63-1.545l-.005-.024a5.352 5.352 0 01.093-2.49c.262-.915.777-1.701 1.536-2.269.06-.045.123-.09.186-.132-.159-1.493-.119-2.73.112-3.67.127-.518.314-.95.562-1.287.27-.368.614-.622 1.015-.737.266-.076.54-.059.797.042zm4.116 9.09c.936 0 1.8.313 2.446.855.63.527 1.005 1.235 1.005 1.94 0 .888-.406 1.58-1.133 2.022-.62.375-1.451.557-2.403.557-1.009 0-1.871-.259-2.493-.734-.617-.47-.963-1.13-.963-1.845 0-.707.398-1.417 1.056-1.946.668-.537 1.55-.849 2.485-.849zm0 .896a3.07 3.07 0 00-1.916.65c-.461.37-.722.835-.722 1.25 0 .428.21.829.61 1.134.455.347 1.124.548 1.943.548.799 0 1.473-.147 1.932-.426.463-.28.7-.686.7-1.257 0-.423-.246-.89-.683-1.256-.484-.405-1.14-.643-1.864-.643zm.662 1.21l.004.004c.12.151.095.37-.056.49l-.292.23v.446a.375.375 0 01-.376.373.375.375 0 01-.376-.373v-.46l-.271-.218a.347.347 0 01-.052-.49.353.353 0 01.494-.051l.215.172.22-.174a.353.353 0 01.49.051zm-5.04-1.919c.478 0 .867.39.867.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872zm8.706 0c.48 0 .868.39.868.871a.87.87 0 01-.868.871.87.87 0 01-.867-.87.87.87 0 01.867-.872z\"></path>",
  lmstudio: "<path d=\"M2.84 2a1.273 1.273 0 100 2.547h14.107a1.273 1.273 0 100-2.547H2.84zM7.935 5.33a1.273 1.273 0 000 2.548H22.04a1.274 1.274 0 000-2.547H7.935zM3.624 9.935c0-.704.57-1.274 1.274-1.274h14.106a1.274 1.274 0 010 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM1.273 12.188a1.273 1.273 0 100 2.547H15.38a1.274 1.274 0 000-2.547H1.273zM3.624 16.792c0-.704.57-1.274 1.274-1.274h14.106a1.273 1.273 0 110 2.547H4.898c-.703 0-1.274-.57-1.274-1.273zM13.029 18.849a1.273 1.273 0 100 2.547h9.698a1.273 1.273 0 100-2.547h-9.698z\"></path>",
  google: "<path d=\"M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z\"></path>",
  // Local-agent CLIs reuse the underlying vendor's mark.
  "claude-code": "@anthropic",
  codex: "@openai",
  "gemini-cli": "@google",
};

interface FromPanel {
  type: "ready" | "connect" | "disconnect" | "test" | "setStyle" | "openExternal" | "detectModels";
  kind?: string;
  baseUrl?: string;
  model?: string;
  key?: string;
  style?: string;
  url?: string;
}

/**
 * The AI connection surface — an in-editor webview that faithfully reproduces the
 * desktop app's "AI Models" settings: a card, the connected model as a row, and a
 * "Connect a model" gallery (bring a key, run a model locally, or use your
 * editor's AI) with an inline editor. Configures the extension's provider layer,
 * so the ✨ commit message and AI code review just work once connected.
 */
export class AiSettingsPanel {
  private static current: AiSettingsPanel | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  static show(brain: GitBrain, extensionUri: vscode.Uri): void {
    if (AiSettingsPanel.current) {
      AiSettingsPanel.current.panel.reveal(vscode.ViewColumn.Active);
      void AiSettingsPanel.current.pushStatus();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitstudio.aiSettings",
      "GitStudio · AI",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    AiSettingsPanel.current = new AiSettingsPanel(panel, brain, extensionUri);
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly brain: GitBrain,
    extensionUri: vscode.Uri,
  ) {
    this.panel.webview.html = this.html(this.panel.webview, extensionUri);
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: FromPanel) => this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  private async pushStatus(): Promise<void> {
    try {
      const status = await this.brain.connectionStatus();
      void this.panel.webview.postMessage({ type: "status", status });
    } catch {
      /* panel may be closing */
    }
  }

  /** One atomic connect/test outcome + fresh status. */
  private async postResult(ok: boolean, message: string): Promise<void> {
    try {
      const status = await this.brain.connectionStatus();
      void this.panel.webview.postMessage({ type: "result", ok, message, status });
    } catch {
      /* panel may be closing */
    }
  }

  private async onMessage(m: FromPanel): Promise<void> {
    switch (m.type) {
      case "ready":
        await this.pushStatus();
        return;
      case "connect":
        await this.connect(m);
        return;
      case "test": {
        const r = await this.brain.testConnection();
        await this.postResult(r.ok, r.message);
        return;
      }
      case "disconnect":
        await this.brain.disconnectAll();
        await this.pushStatus();
        return;
      case "setStyle":
        if (m.style) {
          await this.brain.setCommitStyle(m.style as "conventional" | "concise" | "descriptive");
        }
        await this.pushStatus();
        return;
      case "openExternal":
        if (m.url) {
          void vscode.env.openExternal(vscode.Uri.parse(m.url));
        }
        return;
      case "detectModels": {
        const list = await this.brain.detectModels(
          m.kind ?? "",
          (m.baseUrl ?? "").trim(),
          (m.key ?? "").trim(),
        );
        void this.panel.webview.postMessage({
          type: "models",
          kind: m.kind ?? "",
          list,
        });
        return;
      }
    }
  }

  private async connect(m: FromPanel): Promise<void> {
    const kind = m.kind ?? "";
    const model = (m.model ?? "").trim();
    const key = (m.key ?? "").trim();
    const baseUrl = (m.baseUrl ?? "").trim();
    try {
      switch (kind) {
        case "copilot":
          await this.brain.setProviderChoice("copilot");
          break;
        case "anthropic":
          if (key) {
            await this.brain.setAnthropicKey(key);
          }
          if (model) {
            await this.brain.setAnthropicModel(model);
          }
          await this.brain.setProviderChoice("anthropic");
          break;
        case "openai":
        case "openrouter":
        case "groq":
        case "custom":
          await this.brain.setOpenAiEndpoint(baseUrl, model);
          if (key) {
            await this.brain.setOpenAiKey(key);
          }
          await this.brain.setProviderChoice("openai");
          break;
        case "ollama":
        case "lmstudio":
          await this.brain.setOpenAiEndpoint(baseUrl, model);
          await this.brain.setProviderChoice("openai");
          break;
        case "claude-code":
        case "codex":
        case "gemini-cli":
          await this.brain.setCliAgent(kind);
          break;
        default:
          break;
      }
      const r = await this.brain.testConnection();
      await this.postResult(r.ok, r.message);
    } catch (e) {
      await this.postResult(false, e instanceof Error ? e.message : "Couldn't connect.");
    }
  }

  private html(webview: vscode.Webview, extensionUri: vscode.Uri): string {
    const nonce = getNonce();
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(extensionUri, "dist", "codicons", "codicon.css"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}' ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${codiconUri}" rel="stylesheet" />
<style nonce="${nonce}">${tokensCss}</style>
<style nonce="${nonce}">
  /* ── The desktop app's own tokens, so this panel matches it exactly ──────── */
  body {
    --gs-accent: #7c5cf0; --gs-accent-2: #4aa5ff; --gs-accent-ink: #a78bff;
    --status-add: #2ecf83; --status-warn: #e0a44e;
    --app-panel: #12151c; --app-elevated: #171b24; --app-border: #232936;
    --app-hover: #1d2330; --app-muted: #8b93a1;
    --app-bg: #0d1016;
    --sheen: inset 0 1px 0 rgba(255,255,255,0.055);
    --shadow-sm: 0 1px 2px rgba(0,0,0,0.32), 0 1px 1px rgba(0,0,0,0.22);
    --shadow-lg: 0 18px 44px rgba(0,0,0,0.50), 0 4px 12px rgba(0,0,0,0.32);
    --accent-line: color-mix(in srgb, var(--gs-accent) 40%, var(--app-border));
    --dur-1: 120ms; --ease: cubic-bezier(0.2, 0, 0, 1);
    --text-2xs: 10.5px; --text-sm: 12.5px;
  }
  body.vscode-light {
    --gs-accent-2: #1f6fd6; --gs-accent-ink: #6a45e8;
    --status-add: #0f7a44; --status-warn: #92610f;
    --app-panel: #f7f9fb; --app-elevated: #ffffff; --app-border: #dde2ea;
    --app-hover: #e9edf3; --app-muted: #5b636f; --app-bg: #eef1f5;
    --sheen: inset 0 1px 0 rgba(255,255,255,0.75);
    --shadow-sm: 0 1px 2px rgba(16,24,40,0.06), 0 1px 1px rgba(16,24,40,0.04);
    --shadow-lg: 0 18px 44px rgba(16,24,40,0.16), 0 5px 12px rgba(16,24,40,0.08);
    --accent-line: color-mix(in srgb, var(--gs-accent) 34%, var(--app-border));
  }

  * { box-sizing: border-box; }
  body { margin: 0; padding: 26px 22px 48px; background: var(--app-bg); color: var(--vscode-foreground); font-family: var(--gs-font-ui); font-size: 13px; }
  .wrap { max-width: 640px; margin: 0 auto; }
  .codicon { line-height: 1; }
  .glyph { display: inline-flex; align-items: center; justify-content: center; }
  h1 { font-size: 18px; font-weight: 680; margin: 0 0 4px; display: flex; align-items: center; gap: 9px; }
  h1 .codicon { color: var(--gs-accent-ink); font-size: 20px; }
  .lead { color: var(--app-muted); line-height: 1.55; margin: 0 0 20px; font-size: 12.5px; }

  /* ── Card ─────────────────────────────────────────────────────────────── */
  .settings-card { border: 1px solid var(--app-border); border-radius: 14px; background: var(--app-panel); box-shadow: var(--sheen), var(--shadow-sm); overflow: hidden; }
  .settings-card-head { display: flex; align-items: center; gap: 9px; padding: 13px 16px; border-bottom: 1px solid var(--app-border); }
  .settings-card-head .glyph { color: var(--gs-accent-ink); }
  .settings-card-head .codicon { font-size: 16px; }
  .settings-card-title { font-size: 13.5px; font-weight: 650; }
  .settings-card-body { display: flex; flex-direction: column; gap: 12px; padding: 16px; align-items: stretch; }
  .settings-card-body > .btn, .settings-card-body > .btn-primary { align-self: flex-start; }
  .settings-sub { font-size: 12.5px; line-height: 1.5; color: var(--app-muted); }
  .settings-empty { font-size: 12.5px; color: var(--app-muted); padding: 4px 0; }

  /* ── Pills ────────────────────────────────────────────────────────────── */
  .pill { align-self: flex-start; font-size: var(--text-2xs); font-weight: 600; padding: 1px 7px; border-radius: 999px; color: var(--app-muted); background: color-mix(in srgb, var(--app-muted) 18%, transparent); }
  .pill.is-default { background: color-mix(in srgb, var(--gs-accent) 18%, var(--app-elevated)); color: color-mix(in srgb, var(--gs-accent-ink) 88%, var(--vscode-foreground)); }
  .pill.is-local { background: color-mix(in srgb, var(--gs-accent-2) 16%, var(--app-elevated)); color: color-mix(in srgb, var(--gs-accent-ink) 88%, var(--vscode-foreground)); }
  .pill.is-ready { background: color-mix(in srgb, var(--status-add) 18%, var(--app-elevated)); color: color-mix(in srgb, var(--status-add) 90%, var(--vscode-foreground)); }
  .pill.is-warn { background: color-mix(in srgb, var(--status-warn) 20%, var(--app-elevated)); color: color-mix(in srgb, var(--status-warn) 90%, var(--vscode-foreground)); }

  /* ── Connection row ───────────────────────────────────────────────────── */
  .ai-conn { border: 1px solid var(--app-border); border-radius: 11px; background: var(--app-elevated); overflow: hidden; }
  .ai-conn-head { display: flex; align-items: center; gap: 10px; padding: 10px 12px; }
  .ai-conn-head > .glyph .codicon, .ai-conn-head > .glyph { color: var(--gs-accent-ink); font-size: 16px; }
  .ai-conn-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; flex: 1 1 auto; }
  .ai-conn-name { display: flex; align-items: center; gap: 7px; font-size: 13px; font-weight: 650; }
  .ai-conn-sub { font-size: 11.5px; color: var(--app-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .ai-conn-actions { display: flex; align-items: center; gap: 3px; }
  .ai-conn-editor { display: flex; flex-direction: column; gap: 10px; padding: 12px; border-top: 1px solid var(--app-border); background: var(--app-panel); }

  /* ── Fields ───────────────────────────────────────────────────────────── */
  .settings-field { display: flex; flex-direction: column; gap: 5px; }
  .settings-field-label { font-size: 11.5px; font-weight: 600; color: var(--app-muted); }
  .settings-input { height: 32px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--app-border); background: var(--app-elevated); color: var(--vscode-foreground); font-family: inherit; font-size: 13px; outline: none; }
  .settings-input:focus { border-color: color-mix(in srgb, var(--gs-accent) 55%, var(--app-border)); box-shadow: 0 0 0 3px color-mix(in srgb, var(--gs-accent) 22%, transparent); }
  .field-hint { font-size: 11px; color: var(--app-muted); }
  .field-hint a { color: var(--gs-accent-ink); cursor: pointer; text-decoration: none; }
  .field-hint a:hover { text-decoration: underline; }
  .settings-actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }

  /* ── Buttons ──────────────────────────────────────────────────────────── */
  .btn, .btn-primary, .mini-btn, .icon-btn { white-space: nowrap; font-family: inherit; cursor: pointer; }
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 16px; font-size: 13px; font-weight: 600; color: var(--vscode-foreground); border: 1px solid var(--app-border); border-radius: 9px; background: var(--app-elevated); box-shadow: var(--sheen), var(--shadow-sm); transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
  .btn:hover { background: var(--app-hover); border-color: var(--accent-line); }
  .btn .glyph { color: var(--gs-accent-ink); }
  .btn-primary { display: inline-flex; align-items: center; gap: 8px; height: 36px; padding: 0 18px; font-size: 13px; font-weight: 600; color: #fff; border: none; border-radius: 9px; background: linear-gradient(180deg, color-mix(in srgb, var(--gs-accent) 92%, white 8%), color-mix(in srgb, var(--gs-accent) 100%, black 6%)); box-shadow: inset 0 1px 0 rgba(255,255,255,0.22), 0 1px 2px rgba(0,0,0,0.20), 0 6px 18px color-mix(in srgb, var(--gs-accent) 40%, transparent); transition: filter var(--dur-1) var(--ease); }
  .btn-primary:hover { filter: brightness(1.06); }
  .btn-primary .glyph { color: #fff; }
  .mini-btn { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 11px; border-radius: 8px; border: 1px solid var(--app-border); background: var(--app-elevated); box-shadow: var(--sheen); color: var(--vscode-foreground); font-size: var(--text-sm); font-weight: 600; transition: background var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
  .mini-btn:hover { background: var(--app-hover); border-color: var(--accent-line); }
  .mini-btn .glyph { color: var(--gs-accent-ink); }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; padding: 0; border: 1px solid var(--app-border); border-radius: 8px; background: var(--app-elevated); box-shadow: var(--sheen); color: var(--app-muted); transition: background var(--dur-1) var(--ease), color var(--dur-1) var(--ease), border-color var(--dur-1) var(--ease); }
  .icon-btn:hover { background: var(--app-hover); color: var(--vscode-foreground); border-color: var(--accent-line); }
  .icon-btn .codicon { font-size: 15px; }
  button:disabled { opacity: 0.55; cursor: default; }
  .note { font-size: 12px; }
  .note.ok { color: var(--status-add); }
  .note.err { color: var(--vscode-errorForeground, #e15a5a); }
  .style-row { display: flex; align-items: center; gap: 10px; }
  .style-row label { font-size: 12px; color: var(--app-muted); font-weight: 600; }
  select { height: 30px; padding: 0 8px; border-radius: 8px; border: 1px solid var(--app-border); background: var(--app-elevated); color: var(--vscode-foreground); font-family: inherit; font-size: 12.5px; }

  /* ── Gallery modal ────────────────────────────────────────────────────── */
  .ai-gallery-pop { position: fixed; inset: 0; z-index: 60; background: color-mix(in srgb, #000 42%, transparent); display: flex; align-items: center; justify-content: center; animation: ai-fade .12s ease; }
  @keyframes ai-fade { from { opacity: 0; } to { opacity: 1; } }
  .ai-gallery-panel { width: min(560px, 92vw); max-height: 80vh; overflow: auto; background: var(--app-panel); border: 1px solid var(--app-border); border-radius: 14px; box-shadow: var(--shadow-lg); }
  .ai-gallery-head { display: flex; align-items: center; justify-content: space-between; padding: 14px 16px; border-bottom: 1px solid var(--app-border); font-weight: 650; font-size: 14px; }
  .ai-gallery-section + .ai-gallery-section { border-top: 1px solid var(--app-border); }
  .ai-gallery-section-head { padding: 14px 16px 2px; }
  .ai-gallery-section-title { font-size: 12px; font-weight: 680; text-transform: uppercase; letter-spacing: .04em; }
  .ai-gallery-section-sub { font-size: 11.5px; color: var(--app-muted); margin-top: 2px; line-height: 1.4; }
  .ai-gallery { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; padding: 12px 16px 16px; }
  .ai-prov-card { display: flex; align-items: flex-start; gap: 10px; text-align: left; padding: 12px; border: 1px solid var(--app-border); border-radius: 11px; background: var(--app-elevated); cursor: pointer; font-family: inherit; transition: border-color .12s ease, transform .12s ease, background .12s ease; }
  .ai-prov-card:hover { border-color: color-mix(in srgb, var(--gs-accent) 55%, var(--app-border)); background: var(--app-hover); transform: translateY(-1px); }
  .ai-prov-card > .glyph .codicon, .ai-prov-card > .glyph { font-size: 18px; color: var(--gs-accent-ink); }
  .ai-prov-meta { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .ai-prov-name { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 650; }
  .ai-prov-blurb { font-size: 11.5px; color: var(--app-muted); line-height: 1.4; }
  /* Real brand marks render neutral (like the actual logos), not accent-tinted. */
  .ai-logo { flex: 0 0 auto; color: var(--vscode-foreground); }
  .ai-conn-head > .ai-logo { width: 17px; height: 17px; }
  .ai-prov-card > .ai-logo { width: 20px; height: 20px; margin-top: 1px; }

  /* ── Inline page layout (no modal) ────────────────────────────────────── */
  .page-heading { font-size: 15px; font-weight: 680; margin: 22px 2px 2px; }
  .ai-page .ai-gallery-section-title { margin: 20px 2px 2px; }
  .ai-page .ai-gallery-section-sub { margin: 0 2px 12px; }
  .ai-gallery-page { padding: 0; }
  /* The picked provider's connect form spans the full grid width, right under it. */
  .ai-editor-inline { grid-column: 1 / -1; }
  .ai-editor-inline .ai-conn { border-color: var(--accent-line); box-shadow: 0 0 0 1px color-mix(in srgb, var(--gs-accent) 22%, transparent); }

  /* Connected card: the connection reads as the hero; actions are quiet icon buttons. */
  .ai-conn-actions { display: flex; align-items: center; gap: 2px; margin-left: 8px; }
  .note:empty { display: none; }
  .note { margin: 12px 0 2px; }
  @keyframes gs-spin { to { transform: rotate(360deg); } }
  .gs-spin { display: inline-block; animation: gs-spin 0.9s linear infinite; }
</style>
</head>
<body>
  <div class="wrap">
    <h1><i class="codicon codicon-sparkle"></i> GitStudio AI</h1>
    <p class="lead">Connect a model to power the ✨ commit messages and AI code review. Bring your own API key, run a model locally (fully private), or use your editor's built-in AI. It's optional and never blocks Git.</p>
    <div id="card"></div>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const LOGO_PATHS = ${JSON.stringify(LOGO_PATHS)};
    const cardEl = document.getElementById("card");
    let status = null;
    let editing = null;    // a provider being configured (from the gallery / Configure)
    let note = null;       // {ok,message}
    let editorInputs = null; // the open editor's field refs (for model detection)

    const PROVIDERS = [
      { id:"claude-code", icon:"terminal", name:"Claude Code", badge:"Your login", badgeCls:"is-local", group:"agent", fields:[],
        blurb:"Drive your local Claude Code CLI — its own login, no API key." },
      { id:"codex", icon:"terminal", name:"Codex", badge:"Your login", badgeCls:"is-local", group:"agent", fields:[],
        blurb:"Drive the OpenAI Codex CLI you're signed into." },
      { id:"gemini-cli", icon:"terminal", name:"Gemini CLI", badge:"Your login", badgeCls:"is-local", group:"agent", fields:[],
        blurb:"Drive the Gemini CLI you're signed into." },
      { id:"copilot", icon:"github", name:"Editor AI", badge:"No key", badgeCls:"is-ready", group:"nokey", fields:[], needsCopilot:true,
        blurb:"Use Copilot / Cursor's built-in models. Nothing to configure." },
      { id:"ollama", icon:"vm", name:"Ollama", badge:"Local", badgeCls:"is-local", group:"nokey", fields:["model"], baseUrl:"http://localhost:11434/v1", model:"llama3.1",
        blurb:"Run open models on your machine — fully private." },
      { id:"lmstudio", icon:"vm", name:"LM Studio", badge:"Local", badgeCls:"is-local", group:"nokey", fields:["model"], baseUrl:"http://localhost:1234/v1", model:"",
        blurb:"Local model server. Private, no API key." },
      { id:"anthropic", icon:"sparkle", name:"Anthropic", group:"key", fields:["key","model"], model:"claude-sonnet-4-6", keyUrl:"https://console.anthropic.com/settings/keys",
        blurb:"Claude models. Bring your own API key." },
      { id:"openai", icon:"sparkle", name:"OpenAI", group:"key", fields:["key","model"], baseUrl:"https://api.openai.com/v1", model:"gpt-4o", keyUrl:"https://platform.openai.com/api-keys",
        blurb:"GPT models. Bring your own API key." },
      { id:"openrouter", icon:"globe", name:"OpenRouter", group:"key", fields:["key","model"], baseUrl:"https://openrouter.ai/api/v1", model:"anthropic/claude-3.5-sonnet", keyUrl:"https://openrouter.ai/keys",
        blurb:"One key, hundreds of models from every provider." },
      { id:"groq", icon:"zap", name:"Groq", group:"key", fields:["key","model"], baseUrl:"https://api.groq.com/openai/v1", model:"llama-3.3-70b-versatile", keyUrl:"https://console.groq.com/keys",
        blurb:"Extremely fast inference. Bring your own key." },
      { id:"custom", icon:"settings-gear", name:"Custom", group:"key", fields:["baseUrl","key","model"], baseUrl:"", model:"",
        blurb:"Any OpenAI-compatible endpoint." },
    ];
    const byId = (id) => PROVIDERS.find((p) => p.id === id);

    function el(t, c, txt) { const n = document.createElement(t); if (c) n.className = c; if (txt != null) n.textContent = txt; return n; }
    function glyph(name) { const s = el("span", "glyph codicon codicon-" + name); s.setAttribute("aria-hidden","true"); return s; }
    // Real brand logo (inline SVG via DOMParser, CSP-safe) or a codicon fallback.
    function providerMark(p) {
      let inner = LOGO_PATHS[p.id];
      if (inner && inner[0] === "@") inner = LOGO_PATHS[inner.slice(1)]; // alias → vendor mark
      if (inner) {
        const doc = new DOMParser().parseFromString('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor">' + inner + '</svg>', "image/svg+xml");
        const svg = doc.documentElement;
        svg.setAttribute("aria-hidden","true"); svg.classList.add("ai-logo");
        return document.importNode(svg, true);
      }
      return glyph(p.icon);
    }
    function pill(text, cls) { return el("span", "pill " + (cls || ""), text); }
    function iconBtn(icon, title, onClick) { const b = el("button", "icon-btn"); b.title = title; b.setAttribute("aria-label", title); b.append(glyph(icon)); b.addEventListener("click", onClick); return b; }

    function keyPresent(p) {
      if (!status) return false;
      if (p.id === "anthropic") return status.hasAnthropicKey;
      if (["openai","openrouter","groq","custom"].includes(p.id)) return status.hasOpenaiKey;
      return false;
    }
    function activeProvider() {
      if (!status || !status.ready) return null;
      if (status.activeId === "vscode-lm") return byId("copilot");
      if (status.activeId === "anthropic") return byId("anthropic");
      if (status.activeId && status.activeId.indexOf("cli:") === 0) return byId(status.activeId.slice(4));
      if (status.provider === "cli" && status.cliAgent) return byId(status.cliAgent);
      if (status.activeId === "openai") {
        const u = status.openaiBaseUrl || "";
        return byId(u.includes("openrouter")?"openrouter":u.includes("groq")?"groq":u.includes("openai.com")?"openai":u.includes("11434")?"ollama":u.includes("1234")?"lmstudio":"custom");
      }
      return byId("custom");
    }
    function hostOf(url) { try { return new URL(url).host; } catch { return url || ""; } }

    // ── Editor (inline, inside a .ai-conn) ───────────────────────────────────
    function editorRow(p) {
      const conn = el("div", "ai-conn");
      const editor = el("div", "ai-conn-editor");
      const inputs = {};
      if (p.fields.includes("baseUrl")) inputs.baseUrl = fieldRow(editor, "API base URL", (editing && editing.baseUrl) || p.baseUrl || "", "https://api.example.com/v1");
      if (p.fields.includes("key")) inputs.key = fieldRow(editor, "API key", "", keyPresent(p) ? "•••••••• (stored — leave blank to keep)" : "Paste your API key", "password", p.keyUrl);
      if (p.fields.includes("model")) modelField(editor, p, inputs);
      if (p.fields.length === 0) {
        const msg = p.group === "agent"
          ? ("Runs your local " + p.name + " CLI with its own login — no API key. Make sure it's installed and signed in, then Connect.")
          : "Uses your editor's built-in AI — nothing to configure. Click Connect.";
        editor.append(el("div","settings-sub", msg));
      }
      editorInputs = inputs;
      // Auto-detect: local servers on open; cloud once a key is entered (blur).
      if (p.fields.includes("model") && (p.id === "ollama" || p.id === "lmstudio")) requestDetect(p, inputs);
      if (inputs.key && p.fields.includes("model")) {
        inputs.key.addEventListener("blur", () => { if (inputs.key.value.trim()) requestDetect(p, inputs); });
      }
      const actions = el("div", "settings-actions");
      const connect = el("button", "btn-primary"); connect.append(glyph("plug"), el("span", null, "Connect"));
      connect.addEventListener("click", () => {
        connect.disabled = true; note = { ok:true, message:"Connecting…" };
        vscode.postMessage({ type:"connect", kind:p.id,
          baseUrl: inputs.baseUrl ? inputs.baseUrl.value.trim() : (p.baseUrl||""),
          model: inputs.model ? inputs.model.value.trim() : (p.model||""),
          key: inputs.key ? inputs.key.value.trim() : "" });
        renderNote();
      });
      const cancel = el("button", "mini-btn"); cancel.append(el("span", null, "Cancel"));
      cancel.addEventListener("click", () => { editing = null; note = null; render(); });
      const noteEl = el("div", "note"); noteEl.id = "note";
      actions.append(connect, cancel, noteEl);
      editor.append(actions);
      const head = el("div", "ai-conn-head");
      head.append(providerMark(p));
      const meta = el("div", "ai-conn-meta");
      const nm = el("div", "ai-conn-name"); nm.append(el("span", null, "Connect " + p.name));
      meta.append(nm, el("div","ai-conn-sub", p.blurb));
      head.append(meta);
      conn.append(head, editor);
      return conn;
    }
    // Model field: an input with a datalist of DISCOVERED models. Detection is
    // automatic (local servers on open, cloud on key-blur); a plain text link
    // re-runs it. No icon button — just a suggestion list you can also type into.
    function modelField(editor, p, inputs) {
      const row = el("div", "settings-field");
      row.append(el("label", "settings-field-label", "Model"));
      const input = document.createElement("input");
      input.className = "settings-input";
      input.value = (editing && editing.model) || p.model || "";
      input.placeholder = "model name (auto-detected below)"; input.setAttribute("list", "gs-models");
      const list = document.createElement("datalist"); list.id = "gs-models";
      row.append(input, list);
      const hint = el("div", "field-hint"); hint.id = "model-hint";
      const statusEl = el("span"); statusEl.id = "model-status";
      const link = el("a", null, "Detect models");
      link.addEventListener("click", () => { setDetectStatus("Detecting…"); requestDetect(p, inputs); });
      hint.append(statusEl, document.createTextNode("  "), link);
      row.append(hint);
      editor.append(row);
      inputs.model = input; inputs._list = list;
    }
    function setDetectStatus(text) { const s = document.getElementById("model-status"); if (s) s.textContent = text; }
    function requestDetect(p, inputs) {
      setDetectStatus("Detecting…");
      vscode.postMessage({ type: "detectModels", kind: p.id,
        baseUrl: inputs.baseUrl ? inputs.baseUrl.value.trim() : (p.baseUrl || ""),
        key: inputs.key ? inputs.key.value.trim() : "" });
    }
    function fieldRow(parent, label, value, placeholder, type, keyUrl) {
      const row = el("div", "settings-field");
      row.append(el("label", "settings-field-label", label));
      const input = document.createElement("input");
      input.className = "settings-input"; input.type = type || "text"; input.value = value || ""; input.placeholder = placeholder || "";
      row.append(input);
      if (keyUrl) { const h = el("div","field-hint"); const a = el("a", null, "Get an API key ↗"); a.addEventListener("click", () => vscode.postMessage({ type:"openExternal", url:keyUrl })); h.append(a); row.append(h); }
      parent.append(row);
      return input;
    }

    // ── Connected row ─────────────────────────────────────────────────────────
    function connectionRow(p) {
      const conn = el("div", "ai-conn");
      const head = el("div", "ai-conn-head");
      head.append(providerMark(p));
      const meta = el("div", "ai-conn-meta");
      const nm = el("div", "ai-conn-name"); nm.append(el("span", null, p.name));
      if (p.group === "nokey" && p.id !== "copilot") nm.append(pill("Local","is-local"));
      if (p.group === "agent") nm.append(pill("Your login","is-local"));
      meta.append(nm);
      const sub = p.id === "copilot" ? "Copilot / Cursor models"
        : p.group === "agent" ? "Local agent · runs its own CLI login"
        : ((status.openaiModel || (p.id==="anthropic"?"Claude":"") || "model") + " · " + (status.provider==="anthropic"?"api.anthropic.com":hostOf(status.openaiBaseUrl)));
      meta.append(el("div", "ai-conn-sub", sub));
      head.append(meta);
      head.append(pill("Ready","is-ready"));
      const actions = el("div", "ai-conn-actions");
      const test = iconBtn("debug-start","Test connection", null);
      test.addEventListener("click", () => {
        test.disabled = true; test.classList.add("busy");
        const g = test.querySelector(".codicon"); if (g) g.className = "codicon codicon-loading gs-spin";
        const sn = document.getElementById("status-note"); if (sn) { sn.className = "note"; sn.textContent = "Testing the connection…"; }
        vscode.postMessage({ type:"test" });
      });
      actions.append(test);
      actions.append(iconBtn("gear","Configure", () => { editing = { id:p.id, baseUrl:status.openaiBaseUrl, model:status.openaiModel }; note = null; render(); }));
      actions.append(iconBtn("debug-disconnect","Disconnect", () => vscode.postMessage({ type:"disconnect" })));
      head.append(actions);
      conn.append(head);
      return conn;
    }

    // ── Render — EVERYTHING inline on the page (no modal) ─────────────────────
    function render() {
      cardEl.replaceChildren();

      // Active model — one clean card: connection row (with inline Test / Configure /
      // Disconnect), the last test result, then commit-message style.
      if (status && status.ready) {
        const card = el("div", "settings-card");
        const chead = el("div", "settings-card-head"); chead.append(glyph("sparkle"), el("span","settings-card-title","AI Models"));
        const body = el("div", "settings-card-body");
        card.append(chead, body);
        const p = activeProvider();
        if (p) body.append(connectionRow(p));
        const noteEl = el("div","note"); noteEl.id = "status-note"; body.append(noteEl);
        const sr = el("div","style-row"); sr.append(el("label",null,"Commit message style"));
        const sel = document.createElement("select");
        for (const [v,l] of [["conventional","Conventional Commits"],["concise","Concise subject only"],["descriptive","Subject + body"]]) { const o=document.createElement("option"); o.value=v; o.textContent=l; if(status.commitStyle===v)o.selected=true; sel.append(o); }
        sel.addEventListener("change", () => vscode.postMessage({type:"setStyle", style:sel.value}));
        sr.append(sel); body.append(sr);
        cardEl.append(card);
      }

      // The gallery — ALWAYS on the page; picking a provider expands its form inline.
      const page = el("div","ai-page");
      page.append(el("div","page-heading", status && status.ready ? "Connect a different model" : "Connect a model"));
      const avail = PROVIDERS.filter((p) => !p.needsCopilot || (status && status.copilotAvailable));
      section(page,"Use a local agent","Drive a CLI you've already signed in to — no API key, your own subscription.", avail.filter((p)=>p.group==="agent"));
      section(page,"No key needed","Use your editor's AI, or run a model on your own machine.", avail.filter((p)=>p.group==="nokey"));
      section(page,"Connect with an API key","Bring your own key from any provider.", avail.filter((p)=>p.group==="key"));
      cardEl.append(page);

      renderNote();
    }

    function section(parent, title, sub, items) {
      if (!items.length) return;
      parent.append(el("div","ai-gallery-section-title", title));
      parent.append(el("div","ai-gallery-section-sub", sub));
      const grid = el("div","ai-gallery ai-gallery-page");
      for (const p of items) {
        grid.append(tile(p));
        // The chosen provider's connect form expands INLINE, full width, right here.
        if (editing && editing.id === p.id) {
          const slot = el("div","ai-editor-inline");
          slot.append(editorRow(p));
          grid.append(slot);
        }
      }
      parent.append(grid);
    }

    function tile(p) {
      const active = editing && editing.id === p.id;
      const c = el("button","ai-prov-card" + (active ? " active" : ""));
      c.append(providerMark(p));
      const meta = el("div","ai-prov-meta");
      const nm = el("div","ai-prov-name"); nm.append(el("span", null, p.name));
      if (p.badge) nm.append(pill(p.badge, p.badgeCls || "is-local"));
      meta.append(nm, el("div","ai-prov-blurb", p.blurb));
      c.append(meta);
      c.addEventListener("click", () => { editing = active ? null : { id:p.id, baseUrl:p.baseUrl, model:p.model }; note = null; render(); });
      return c;
    }

    function renderNote() {
      if (!note) return;
      const formNote = document.getElementById("note");
      if (editing && formNote) { formNote.className = "note " + (note.ok ? "ok" : "err"); formNote.textContent = note.message; return; }
      let sn = document.getElementById("status-note");
      if (!sn) { sn = el("div","note"); sn.id = "status-note"; sn.style.margin = "0 0 14px"; cardEl.insertBefore(sn, cardEl.firstChild); }
      sn.className = "note " + (note.ok ? "ok" : "err"); sn.textContent = note.message;
    }

    window.addEventListener("message", (e) => {
      const m = e.data;
      if (m.type === "status") { status = m.status; note = null; render(); }
      else if (m.type === "result") {
        status = m.status;
        if (m.ok) editing = null;         // success closes the editor
        note = { ok:m.ok, message:m.message };
        render();
      }
      else if (m.type === "models") {
        if (editorInputs && editorInputs._list) {
          editorInputs._list.replaceChildren();
          for (const id of m.list) { const o = document.createElement("option"); o.value = id; editorInputs._list.append(o); }
          if (!editorInputs.model.value && m.list.length) editorInputs.model.value = m.list[0];
          setDetectStatus(m.list.length
            ? (m.list.length + " model" + (m.list.length === 1 ? "" : "s") + " found — pick one or type.")
            : "No models found — is the server running / key valid?");
        }
      }
    });
    vscode.postMessage({ type: "ready" });
  </script>
</body></html>`;
  }

  dispose(): void {
    AiSettingsPanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}
