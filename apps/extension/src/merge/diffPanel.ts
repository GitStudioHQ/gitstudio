import * as vscode from "vscode";
import { relative } from "node:path";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { DiffInitPayload, WebviewMessage } from "@gitstudio/host-bridge/protocol";
import { getWebviewHtml } from "../webview/html";

/**
 * Describes one side of a diff. Left/right can be a file URI, a file's HEAD
 * version, or inline text. URI-backed sides are kept live so the diff re-runs
 * when the underlying document changes.
 */
interface DiffPanelState {
  fileName: string;
  leftLabel: string;
  rightLabel: string;
  rightEditable: boolean;
  /** Right side: a real file URI (string) or inline text. */
  rightUri?: string;
  rightText?: string;
  /** Left side: a file URI, the HEAD version of a URI, or inline text. */
  leftSource: "uri" | "head" | "text";
  leftUri?: string;
  leftText?: string;
}

/**
 * Hosts the GitStudio 2-way diff inside a webview panel (reusing the same
 * bundle/HTML as the merge editor). The right pane can be editable and synced
 * back to its backing file; the panel survives reload via the serializer below.
 */
export class DiffPanel {
  public static readonly viewType = "gitstudio.diffView";

  /** Open panels by content key, so re-running a diff reveals the existing tab. */
  private static readonly open = new Map<string, DiffPanel>();

  public static register(
    context: vscode.ExtensionContext,
    repos: RepoManager,
  ): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(DiffPanel.viewType, {
      async deserializeWebviewPanel(
        panel: vscode.WebviewPanel,
        state: unknown,
      ): Promise<void> {
        const restored = state as DiffPanelState | undefined;
        if (!restored) {
          panel.dispose();
          return;
        }
        const instance = new DiffPanel(context, repos, panel, restored);
        await instance.init();
      },
    });
  }

  /** Opens a diff panel for the given state, reusing an existing one. */
  public static async create(
    context: vscode.ExtensionContext,
    repos: RepoManager,
    state: DiffPanelState,
  ): Promise<void> {
    const key = panelKey(state);
    const existing = key ? DiffPanel.open.get(key) : undefined;
    if (existing && !existing.disposed) {
      existing.panel.reveal();
      await existing.sendInit();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      DiffPanel.viewType,
      diffTitle(state),
      vscode.ViewColumn.Active,
      { retainContextWhenHidden: true },
    );
    const instance = new DiffPanel(context, repos, panel, state);
    await instance.init();
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly key?: string;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private applyingEdit = false;
  private disposed = false;

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    private readonly panel: vscode.WebviewPanel,
    private readonly state: DiffPanelState,
  ) {
    this.key = panelKey(state);
  }

  private async init(): Promise<void> {
    if (this.key) {
      DiffPanel.open.set(this.key, this);
    }
    const webview = this.panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };
    webview.html = getWebviewHtml(webview, this.context.extensionUri);
    this.panel.title = diffTitle(this.state);

    this.disposables.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const message = raw as WebviewMessage | undefined;
        switch (message?.type) {
          case "ready":
            void this.sendInit();
            break;
          case "diffChanged":
            void this.syncRight(message.text);
            break;
          default:
            break;
        }
      }),
    );

    this.watchDocuments();

    this.panel.onDidDispose(() => {
      this.disposed = true;
      if (this.key && DiffPanel.open.get(this.key) === this) {
        DiffPanel.open.delete(this.key);
      }
      if (this.refreshTimer) {
        clearTimeout(this.refreshTimer);
        this.refreshTimer = undefined;
      }
      for (const d of this.disposables) {
        d.dispose();
      }
      this.disposables.length = 0;
    });
  }

  /**
   * Keeps the diff live: when a watched backing document changes, a fresh
   * payload is pushed and the webview re-diffs in place.
   */
  private watchDocuments(): void {
    const watched = new Set<string>();
    if (this.state.rightUri) {
      watched.add(vscode.Uri.parse(this.state.rightUri).toString());
    }
    if (this.state.leftSource === "uri" && this.state.leftUri) {
      watched.add(vscode.Uri.parse(this.state.leftUri).toString());
    }
    if (watched.size === 0) {
      return;
    }
    this.disposables.push(
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (
          this.applyingEdit ||
          event.contentChanges.length === 0 ||
          !watched.has(event.document.uri.toString())
        ) {
          return;
        }
        if (this.refreshTimer) {
          clearTimeout(this.refreshTimer);
        }
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.sendInit();
        }, 250);
      }),
    );
  }

  /** Resolves both sides' text and posts the diffInit payload. */
  private async sendInit(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const payload = await this.buildPayload();
      if (this.disposed) {
        return; // panel closed while the payload was being resolved
      }
      void this.panel.webview.postMessage({ type: "diffInit", ...payload });
      void this.panel.webview.postMessage({
        type: "persistState",
        state: this.state,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(`GitStudio: failed to load — ${reason}`);
    }
  }

  private async buildPayload(): Promise<DiffInitPayload> {
    const leftText = await this.resolveLeftText();
    const rightText = await this.resolveRightText();
    return {
      fileName: this.state.fileName,
      leftLabel: this.state.leftLabel,
      rightLabel: this.state.rightLabel,
      leftText,
      rightText,
      rightEditable:
        this.state.rightEditable && this.state.rightUri !== undefined,
    };
  }

  private async resolveLeftText(): Promise<string> {
    switch (this.state.leftSource) {
      case "text":
        return this.state.leftText ?? "";
      case "uri":
        return this.state.leftUri
          ? readUriText(vscode.Uri.parse(this.state.leftUri))
          : "";
      case "head": {
        if (!this.state.leftUri) {
          return "";
        }
        return this.headText(vscode.Uri.parse(this.state.leftUri));
      }
      default:
        return "";
    }
  }

  private async resolveRightText(): Promise<string> {
    if (this.state.rightUri) {
      return readUriText(vscode.Uri.parse(this.state.rightUri));
    }
    return this.state.rightText ?? "";
  }

  /** Reads a file's content at HEAD via the git-service ConflictProvider. */
  private async headText(uri: vscode.Uri): Promise<string> {
    const target = this.resolveTarget(uri);
    if (!target) {
      return "";
    }
    return target.entry.ctx.conflict.getHeadVersion(target.rel);
  }

  private resolveTarget(
    uri: vscode.Uri,
  ): { entry: RepoEntry; rel: string } | undefined {
    let best: RepoEntry | undefined;
    for (const entry of this.repos.getAll()) {
      if (isInside(uri.fsPath, entry.root)) {
        if (best === undefined || entry.root.length > best.root.length) {
          best = entry;
        }
      }
    }
    if (!best) {
      return undefined;
    }
    return {
      entry: best,
      rel: relative(best.root, uri.fsPath).replace(/\\/g, "/"),
    };
  }

  /** Writes the edited right text back to its backing file. */
  private async syncRight(text: string): Promise<void> {
    if (!this.state.rightEditable || !this.state.rightUri) {
      return;
    }
    const uri = vscode.Uri.parse(this.state.rightUri);
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.getText() === text) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(document.lineCount, 0),
    );
    edit.replace(uri, fullRange, text);
    this.applyingEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.applyingEdit = false;
    }
  }
}

async function readUriText(uri: vscode.Uri): Promise<string> {
  // Prefer an open document (picks up unsaved edits); fall back to disk.
  const open = vscode.workspace.textDocuments.find(
    (d) => d.uri.toString() === uri.toString(),
  );
  if (open) {
    return open.getText();
  }
  const document = await vscode.workspace.openTextDocument(uri);
  return document.getText();
}

function diffTitle(state: DiffPanelState): string {
  const base = state.fileName.split(/[\\/]/).pop() ?? state.fileName;
  return `Diff: ${base}`;
}

/**
 * Stable identity for panel reuse. URI-backed diffs reuse one panel per
 * (left source, right file) pair; inline-text diffs have no stable identity and
 * always open fresh.
 */
function panelKey(state: DiffPanelState): string | undefined {
  if (state.leftSource === "text" || !state.rightUri) {
    return undefined;
  }
  return [
    state.fileName,
    state.leftSource,
    state.leftUri ?? "",
    state.rightUri,
    state.leftLabel,
    state.rightLabel,
    String(state.rightEditable),
  ].join(" ");
}

function isInside(filePath: string, dir: string): boolean {
  if (filePath === dir) {
    return true;
  }
  const withSep = dir.endsWith("/") ? dir : `${dir}/`;
  return filePath.startsWith(withSep);
}

export type { DiffPanelState };

/**
 * Opens a diff of two file URIs (right pane read-only). Convenience entry point
 * for the compare command and other features that already have two URIs.
 */
export async function openDiffPanel(
  context: vscode.ExtensionContext,
  repos: RepoManager,
  fileName: string,
  left: { uri: vscode.Uri; label: string },
  right: { uri: vscode.Uri; label: string; editable?: boolean },
): Promise<void> {
  await DiffPanel.create(context, repos, {
    fileName,
    leftLabel: left.label,
    rightLabel: right.label,
    leftSource: "uri",
    leftUri: left.uri.toString(),
    rightUri: right.uri.toString(),
    rightEditable: right.editable ?? false,
  });
}

/**
 * `gitstudio.compare`: compare the given (or active) file against another
 * picked file, or against its own HEAD version.
 */
export async function compareCommand(
  context: vscode.ExtensionContext,
  repos: RepoManager,
  resource?: vscode.Uri,
): Promise<void> {
  const left =
    resource ??
    (vscode.window.activeTextEditor?.document.uri.scheme === "file"
      ? vscode.window.activeTextEditor.document.uri
      : undefined);
  if (!left) {
    void vscode.window.showInformationMessage(
      "GitStudio: open or select a file to compare.",
    );
    return;
  }

  const pickHead = "Compare with HEAD (last committed version)";
  const pickFile = "Compare with another file…";
  const choice = await vscode.window.showQuickPick([pickHead, pickFile], {
    placeHolder: `Compare ${baseName(left)} with…`,
  });
  if (!choice) {
    return;
  }

  const fileName = left.fsPath;
  if (choice === pickHead) {
    await DiffPanel.create(context, repos, {
      fileName,
      leftLabel: `${baseName(left)} (HEAD)`,
      rightLabel: `${baseName(left)} (Working Tree)`,
      leftSource: "head",
      leftUri: left.toString(),
      rightUri: left.toString(),
      rightEditable: false,
    });
    return;
  }

  const picked = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: "Compare",
    title: `Compare ${baseName(left)} with…`,
  });
  const right = picked?.[0];
  if (!right) {
    return;
  }
  await openDiffPanel(
    context,
    repos,
    fileName,
    { uri: left, label: baseName(left) },
    { uri: right, label: baseName(right) },
  );
}

function baseName(uri: vscode.Uri): string {
  return uri.fsPath.split(/[\\/]/).pop() ?? uri.fsPath;
}
