import * as vscode from "vscode";
import { relative } from "node:path";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { ConflictVersions } from "@gitstudio/git-service/index";
import type {
  ConflictType,
  MergeInitPayload,
  WebviewMessage,
} from "@gitstudio/host-bridge/protocol";
import { getWebviewHtml } from "../webview/html";

// IntelliJ's merge-dialog wording for the side panes.
const OURS_LABEL = "Current change";
const THEIRS_LABEL = "Incoming change";

/**
 * Hosts the GitStudio 3-pane (ours / base / theirs) merge UI inside a webview,
 * backed by the conflicted file's TextDocument (so save / dirty / undo come
 * from VS Code). The three sides are read portably via the git-service
 * ConflictProvider (git index stages, with a working-tree marker fallback) and
 * streamed to the shared webview front-end, which renders them as three Monaco
 * panes.
 */
export class MergeEditorProvider implements vscode.CustomTextEditorProvider {
  public static readonly viewType = "gitstudio.mergeEditor";

  public static register(
    context: vscode.ExtensionContext,
    repos: RepoManager,
  ): vscode.Disposable {
    const provider = new MergeEditorProvider(context, repos);
    return vscode.window.registerCustomEditorProvider(
      MergeEditorProvider.viewType,
      provider,
      {
        supportsMultipleEditorsPerDocument: false,
        webviewOptions: { retainContextWhenHidden: true },
      },
    );
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
  ) {}

  public async resolveCustomTextEditor(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const webview = webviewPanel.webview;
    webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };
    webview.html = getWebviewHtml(webview, this.context.extensionUri);

    const messageSub = webview.onDidReceiveMessage((raw: unknown) => {
      const message = raw as WebviewMessage | undefined;
      switch (message?.type) {
        case "ready":
          void this.sendInit(document, webview);
          break;
        case "resultChanged":
          void this.syncDocument(document, message.text);
          break;
        case "apply":
          void this.applyMerge(document, webview, message.text);
          break;
        case "cancel":
          void this.cancelMerge(document, webviewPanel);
          break;
        // openInJetBrains et al: GitStudio is the resolver — no-op, tolerantly.
        default:
          break;
      }
    });

    webviewPanel.onDidDispose(() => {
      messageSub.dispose();
    });
  }

  /** Resolves the repo + repo-relative path for the conflicted document. */
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
    return { entry: best, rel: relative(best.root, uri.fsPath).replace(/\\/g, "/") };
  }

  private async sendInit(
    document: vscode.TextDocument,
    webview: vscode.Webview,
  ): Promise<void> {
    const target = this.resolveTarget(document.uri);
    if (!target) {
      void vscode.window.showWarningMessage(
        "GitStudio: this file isn't inside an open Git repository.",
      );
      return;
    }

    try {
      const versions = await target.entry.ctx.conflict.getConflictVersions(
        target.rel,
        { workingText: document.getText() },
      );
      const payload = buildMergePayload(
        document.uri.fsPath,
        document.getText(),
        versions,
      );
      void webview.postMessage({ type: "init", ...payload });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `GitStudio: failed to load conflict versions — ${reason}`,
      );
    }
  }

  /** Mirrors the webview's resolved result into the backing TextDocument. */
  private async syncDocument(
    document: vscode.TextDocument,
    text: string,
  ): Promise<void> {
    if (document.getText() === text) {
      return;
    }
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(
      new vscode.Position(0, 0),
      new vscode.Position(document.lineCount, 0),
    );
    edit.replace(document.uri, fullRange, text);
    await vscode.workspace.applyEdit(edit);
  }

  /** Writes the result, saves it, and stages the file (canonical "resolved"). */
  private async applyMerge(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    text: string,
  ): Promise<void> {
    // Snapshot before we overwrite the conflicted file + stage it, so the
    // resolution can be undone in one keystroke (the snapshot captures the
    // pre-resolution working tree). The actual apply runs inside the envelope.
    const ledger = this.repos.getUndoLedger();
    const target0 = this.resolveTarget(document.uri);
    if (ledger && target0) {
      await ledger.runWithUndo(target0.entry, "Apply merge resolution", () =>
        this.applyMergeInner(document, webview, text),
      );
      return;
    }
    await this.applyMergeInner(document, webview, text);
  }

  private async applyMergeInner(
    document: vscode.TextDocument,
    webview: vscode.Webview,
    text: string,
  ): Promise<void> {
    try {
      await this.syncDocument(document, text);
      await document.save();
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      void vscode.window.showErrorMessage(
        `GitStudio: failed to save the resolved file — ${reason}`,
      );
      return;
    }

    // Staging is best-effort: the resolution is already saved on disk, so a git
    // hiccup must not read as a failed merge.
    let staged = false;
    const target = this.resolveTarget(document.uri);
    if (target) {
      try {
        await target.entry.ctx.process.run(["add", "--", target.rel]);
        staged = true;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        void vscode.window.showWarningMessage(
          `GitStudio: file saved, but staging failed (${reason}). ` +
            "Stage it manually with git add.",
        );
      }
    }

    void webview.postMessage({ type: "applied", staged });
    void vscode.window.showInformationMessage(
      staged
        ? "GitStudio: resolved file saved and staged."
        : "GitStudio: resolved file saved.",
    );
  }

  /**
   * The dialog's Cancel: close the merge editor and reopen the file in the
   * default text editor, keeping the conflict in the file for later.
   */
  private async cancelMerge(
    document: vscode.TextDocument,
    webviewPanel: vscode.WebviewPanel,
  ): Promise<void> {
    try {
      await vscode.commands.executeCommand(
        "vscode.openWith",
        document.uri,
        "default",
        webviewPanel.viewColumn ?? vscode.ViewColumn.Active,
      );
    } finally {
      webviewPanel.dispose();
    }
  }
}

/** Builds the MergeInitPayload from the resolved versions. */
export function buildMergePayload(
  fileName: string,
  workingText: string,
  versions: ConflictVersions,
): MergeInitPayload {
  const conflictType = classifyConflict(versions);
  return {
    fileName,
    conflictType,
    source: versions.source,
    hasBase: versions.hasBase,
    oursLabel: OURS_LABEL,
    theirsLabel: THEIRS_LABEL,
    base: versions.base,
    ours: versions.ours,
    theirs: versions.theirs,
    // The result starts from the working text (still carrying markers until
    // resolved); fall back to base when the working text is empty.
    result: workingText !== "" ? workingText : versions.base,
  };
}

/**
 * Derives the conflict kind from which sides are present:
 * - both sides present + a base  -> content (the common case)
 * - both sides present, no base  -> add/add
 * - only ours present            -> deleted by them
 * - only theirs present          -> deleted by us
 * - nothing usable               -> unknown
 */
export function classifyConflict(versions: ConflictVersions): ConflictType {
  if (versions.source === "none") {
    return "unknown";
  }
  const hasOurs = versions.ours !== "";
  const hasTheirs = versions.theirs !== "";
  if (hasOurs && hasTheirs) {
    return versions.hasBase ? "content" : "add-add";
  }
  if (hasOurs && !hasTheirs) {
    return "deleted-by-them";
  }
  if (!hasOurs && hasTheirs) {
    return "deleted-by-us";
  }
  return "unknown";
}

function isInside(filePath: string, dir: string): boolean {
  if (filePath === dir) {
    return true;
  }
  const withSep = dir.endsWith("/") ? dir : `${dir}/`;
  return filePath.startsWith(withSep);
}
