// The embedded 2-pane diff, shared by both extensions (PLAN matrix rows 56–60).
// It is GitStudio's diff panel — live sides, write-back of an editable right
// side, restore after reload, and a staging tick per change when the left side
// is HEAD and the right is the working file — plus Merge Studio's entry
// points: two files selected in the Explorer diff each other, "Open Changes"
// is the file vs HEAD, and the routed Compare honours the diffTool setting
// (the installed JetBrains IDE, or this panel).
//
// One of the two places in this package that write a document the user has
// open (the other is mergeEditorProvider.ts): an editable right side writes
// back to its own file.

import * as vscode from "vscode";
import { setBlockStaged } from "@gitstudio/git-service/blockStaging";
import type { DiffInitPayload, StageBlockRef, WebviewMessage } from "@gitstudio/host-bridge/protocol";
import { baseName, collectUris, locate, resolveUriArg } from "./args";
import { DEMO_DIFF } from "./demoContent";
import type { MergeHostCore } from "./host";
import type { JetBrainsUi } from "./jetbrainsUi";
import { mergeWebviewHtml } from "./webviewHtml";

/**
 * One side of a diff, persisted across reloads (the panel's serialized state).
 * Left/right can be a file URI, a file's HEAD version, or inline text.
 */
export interface DiffPanelState {
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
 * A wire span (1-based, end-exclusive) as the engine's 0-based inclusive
 * LineRange, mirroring the engine's spanToRange (including the zero-width case).
 */
function toRange(span: { start: number; end: number }): { start: number; end: number } {
  return { start: span.start - 1, end: span.end - 2 };
}

export class DiffPanel {
  /** Open panels by content key, so re-running a diff reveals the existing tab. */
  private static readonly open = new Map<string, DiffPanel>();

  static register(host: MergeHostCore): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(host.product.viewTypes.diffView, {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
        const restored = state as DiffPanelState | undefined;
        if (!restored) {
          panel.dispose();
          return;
        }
        await new DiffPanel(host, panel, restored).init();
      },
    });
  }

  /** Open a diff panel for `state`, revealing an existing one with the same identity. */
  static async create(host: MergeHostCore, state: DiffPanelState): Promise<void> {
    const key = panelKey(host.product.viewTypes.diffView, state);
    const existing = key ? DiffPanel.open.get(key) : undefined;
    if (existing && !existing.disposed) {
      existing.panel.reveal();
      await existing.sendInit();
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      host.product.viewTypes.diffView,
      diffTitle(state),
      vscode.ViewColumn.Active,
      { retainContextWhenHidden: true },
    );
    await new DiffPanel(host, panel, state).init();
  }

  private readonly disposables: vscode.Disposable[] = [];
  private readonly key?: string;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private applyingEdit = false;
  private disposed = false;

  private constructor(
    private readonly host: MergeHostCore,
    private readonly panel: vscode.WebviewPanel,
    private readonly state: DiffPanelState,
  ) {
    this.key = panelKey(host.product.viewTypes.diffView, state);
  }

  private async init(): Promise<void> {
    if (this.key) {
      DiffPanel.open.set(this.key, this);
    }
    const webview = this.panel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.host.context.extensionUri, "dist")],
    };
    webview.html = mergeWebviewHtml(webview, this.host.context.extensionUri);
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
          case "toggleTick":
            void this.toggleTick(message.block, message.staged);
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

  /** Keep the diff live: a watched backing document changed → re-diff in place. */
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

  private async sendInit(): Promise<void> {
    if (this.disposed) {
      return;
    }
    try {
      const payload = await this.buildPayload();
      if (this.disposed) {
        return; // closed while the payload was being read
      }
      void this.panel.webview.postMessage({ type: "diffInit", ...payload });
      void this.panel.webview.postMessage({
        type: "stagingState",
        indexText: await this.indexTextForStaging(),
      });
      void this.panel.webview.postMessage({ type: "persistState", state: this.state });
    } catch (error) {
      void this.host.notify("error", `couldn't load the diff — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async buildPayload(): Promise<DiffInitPayload> {
    const leftText = await this.resolveLeftText();
    const rightText = this.state.rightUri
      ? await readUriText(vscode.Uri.parse(this.state.rightUri))
      : (this.state.rightText ?? "");
    return {
      fileName: this.state.fileName,
      leftLabel: this.state.leftLabel,
      rightLabel: this.state.rightLabel,
      leftText,
      rightText,
      rightEditable: this.state.rightEditable && this.state.rightUri !== undefined,
    };
  }

  private async resolveLeftText(): Promise<string> {
    switch (this.state.leftSource) {
      case "text":
        return this.state.leftText ?? "";
      case "uri":
        return this.state.leftUri ? readUriText(vscode.Uri.parse(this.state.leftUri)) : "";
      case "head": {
        if (!this.state.leftUri) {
          return "";
        }
        const target = locate(this.host.product.locator, vscode.Uri.parse(this.state.leftUri));
        return target ? target.repo.ctx.conflict.getHeadVersion(target.rel) : "";
      }
      default:
        return "";
    }
  }

  /**
   * The index text the ticks derive from, or undefined when this panel is not
   * stageable. Only HEAD-vs-working-file is: a diff of two files or of inline
   * text has nothing to stage. A conflicted file has no stage-0 entry, so its
   * ticks would confidently lie — conflicts are resolved in the merge editor.
   */
  private async indexTextForStaging(): Promise<string | undefined> {
    if (this.state.leftSource !== "head" || !this.state.rightUri) {
      return undefined;
    }
    const target = locate(this.host.product.locator, vscode.Uri.parse(this.state.rightUri));
    if (!target) {
      return undefined;
    }
    try {
      if (await target.repo.ctx.conflict.isConflicted(target.rel)) {
        return undefined;
      }
      return await target.repo.ctx.staging.indexContent(target.rel);
    } catch {
      return undefined;
    }
  }

  /**
   * Stage or unstage one change, then re-read the index and push it back — the
   * webview is told what git now holds, never what it asked for.
   */
  private async toggleTick(block: StageBlockRef, staged: boolean): Promise<void> {
    if (this.disposed || !this.state.rightUri) {
      return;
    }
    const uri = vscode.Uri.parse(this.state.rightUri);
    const target = locate(this.host.product.locator, uri);
    if (!target) {
      return;
    }
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      const result = await setBlockStaged(
        target.repo.ctx,
        target.rel,
        doc.getText(),
        { head: toRange(block.head), working: toRange(block.working), state: block.state },
        staged,
      );
      if (!result.ok) {
        vscode.window.setStatusBarMessage(`$(info) ${this.host.product.displayName}: ${result.stderr}`, 4000);
      }
    } catch (error) {
      void this.host.notify(
        "error",
        `couldn't stage that change — ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.host.changed(target.repo);
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage({
      type: "stagingState",
      indexText: await this.indexTextForStaging(),
    });
  }

  /** Write an edited right side back to its file. */
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
    edit.replace(
      uri,
      new vscode.Range(new vscode.Position(0, 0), new vscode.Position(document.lineCount, 0)),
      text,
    );
    // The webview already shows this text; do not bounce it back as a refresh.
    this.applyingEdit = true;
    try {
      await vscode.workspace.applyEdit(edit);
    } finally {
      this.applyingEdit = false;
    }
  }
}

async function readUriText(uri: vscode.Uri): Promise<string> {
  // Prefer an open document (it carries unsaved edits); fall back to disk.
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (open) {
    return open.getText();
  }
  return (await vscode.workspace.openTextDocument(uri)).getText();
}

function diffTitle(state: DiffPanelState): string {
  const base = state.fileName.split(/[\\/]/).pop() ?? state.fileName;
  return `Diff: ${base}`;
}

/**
 * Stable identity for panel reuse. URI-backed diffs reuse one panel per state;
 * inline-text diffs have no stable identity and always open fresh. NUL
 * separator (written as an escape, never a literal byte — noLiteralNulBytes).
 */
function panelKey(viewType: string, state: DiffPanelState): string | undefined {
  if (state.leftSource === "text" || !state.rightUri) {
    return undefined;
  }
  return [
    viewType,
    state.fileName,
    state.leftSource,
    state.leftUri ?? "",
    state.rightUri,
    state.leftLabel,
    state.rightLabel,
    String(state.rightEditable),
  ].join("\u0000");
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** Two files: left read-only, right editable (Merge Studio's two-file compare). */
export function twoFileState(left: vscode.Uri, right: vscode.Uri): DiffPanelState {
  return {
    fileName: right.fsPath,
    leftLabel: baseName(left),
    rightLabel: baseName(right),
    leftSource: "uri",
    leftUri: left.toString(),
    rightUri: right.toString(),
    rightEditable: true,
  };
}

/** The file vs HEAD: HEAD read-only on the left, the editable working file on the right. */
export function headState(uri: vscode.Uri, opts: { editable: boolean }): DiffPanelState {
  const name = baseName(uri);
  return {
    fileName: uri.fsPath,
    leftLabel: `${name} (HEAD)`,
    rightLabel: `${name} (Working Tree)`,
    // "head" is also what makes the panel stageable (ticks).
    leftSource: "head",
    leftUri: uri.toString(),
    rightUri: uri.toString(),
    rightEditable: opts.editable,
  };
}

/** The walkthrough's sample diff (two inline texts; no git needed). */
export function demoDiffState(): DiffPanelState {
  return {
    fileName: DEMO_DIFF.fileName,
    leftLabel: DEMO_DIFF.leftLabel,
    rightLabel: DEMO_DIFF.rightLabel,
    rightEditable: false,
    leftSource: "text",
    leftText: DEMO_DIFF.leftText,
    rightText: DEMO_DIFF.rightText,
  };
}

/** The diff entry points every product registers (see register.ts). */
export class DiffCommands {
  constructor(
    private readonly host: MergeHostCore,
    private readonly jetbrains: JetBrainsUi,
  ) {}

  /**
   * "Open in Embedded Diff": two selected files diff each other; otherwise
   * the clicked / active file vs HEAD.
   */
  async openDiff(clicked?: unknown, selected?: unknown): Promise<void> {
    const two = collectUris(selected);
    if (two.length === 2) {
      await DiffPanel.create(this.host, twoFileState(two[0], two[1]));
      return;
    }
    const uri = resolveUriArg(clicked) ?? two[0] ?? vscode.window.activeTextEditor?.document.uri;
    await this.embeddedHead(uri);
  }

  /** The routed Compare: diffTool=jetbrains (and an IDE installed) goes to the IDE. */
  async compare(clicked?: unknown, selected?: unknown): Promise<void> {
    const two = collectUris(selected);
    if (this.host.settings().diffTool === "jetbrains" && (await this.jetbrains.detect())) {
      await this.diffWithJetBrains(clicked, selected);
      return;
    }
    if (two.length === 2) {
      await DiffPanel.create(this.host, twoFileState(two[0], two[1]));
      return;
    }
    const uri = resolveUriArg(clicked) ?? two[0] ?? vscode.window.activeTextEditor?.document.uri;
    if (uri && this.host.product.compareSingle) {
      await this.host.product.compareSingle(uri);
      return;
    }
    await this.embeddedHead(uri);
  }

  /** "Open Changes": the file vs HEAD, in the IDE when diffTool says so. */
  async openChanges(arg?: unknown): Promise<void> {
    const uri = resolveUriArg(arg) ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void this.host.notify("warn", "open a file to compare it against HEAD.");
      return;
    }
    if (this.host.settings().diffTool === "jetbrains" && (await this.jetbrains.detect())) {
      await this.jetbrains.diffAgainstHead(uri);
      return;
    }
    if (this.host.product.openChangesEmbedded) {
      await this.host.product.openChangesEmbedded(uri);
      return;
    }
    await this.embeddedHead(uri);
  }

  /** HEAD vs the working file on the embedded page, a tick per change. */
  async stageWithTicks(arg?: unknown): Promise<void> {
    const uri = resolveUriArg(arg) ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri || uri.scheme !== "file" || !locate(this.host.product.locator, uri)) {
      void this.host.notify("info", "open a file in a Git repository to stage its changes.");
      return;
    }
    await DiffPanel.create(this.host, headState(uri, { editable: false }));
  }

  /** The IDE's diff: two selected files, else the file vs HEAD. */
  async diffWithJetBrains(clicked?: unknown, selected?: unknown): Promise<void> {
    const two = collectUris(selected);
    if (two.length === 2) {
      await this.jetbrains.diffFiles(two[0], two[1]);
      return;
    }
    const uri = resolveUriArg(clicked) ?? two[0] ?? vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void this.host.notify("warn", "open a file or select two files to compare.");
      return;
    }
    await this.jetbrains.diffAgainstHead(uri);
  }

  async openDemoDiff(): Promise<void> {
    await DiffPanel.create(this.host, demoDiffState());
  }

  /** The embedded fallback for two files or one file vs HEAD (the IDE's "Use Embedded Diff"). */
  async embedded(left: vscode.Uri, right?: vscode.Uri): Promise<void> {
    if (right) {
      await DiffPanel.create(this.host, twoFileState(left, right));
      return;
    }
    await this.embeddedHead(left);
  }

  private async embeddedHead(uri: vscode.Uri | undefined): Promise<void> {
    if (!uri) {
      void this.host.notify("warn", "open a file or select two files to compare.");
      return;
    }
    if (!locate(this.host.product.locator, uri)) {
      void this.host.notify("warn", `${baseName(uri)} is not in an open Git repository, so it has no HEAD version.`);
      return;
    }
    await DiffPanel.create(this.host, headState(uri, { editable: true }));
  }
}
