import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";
import { CommitGraphPanel } from "./graphPanel";

/**
 * The Commit Graph in the BOTTOM panel — GitStudio's Git log tool window.
 *
 * It hosts the same full graph surface as the editor-area panel, but in "side"
 * layout: the commit graph on the left, the selected commit's details (message,
 * author, changed files, click-to-diff) on the right, with a draggable divider.
 * A wide, short panel can't afford the editor tab's stacked dock, and a
 * left/right split is what JetBrains shows in the same position.
 *
 * Living in the panel means your code stays open above it — click a blame
 * annotation and the commit lands down here without covering the file.
 */
export class CommitPanelViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gitstudio.commitPanel";

  private host: CommitGraphPanel | undefined;
  private view: vscode.WebviewView | undefined;
  private pendingReveal: string | undefined;

  constructor(
    private readonly repos: RepoManager,
    private readonly extensionUri: vscode.Uri,
  ) {}

  resolveWebviewView(
    view: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    // VS Code can dispose and re-resolve a hidden view. Drop any previous host
    // defensively so a re-resolve can never leave two attached to the repo's
    // change events (each would refetch the whole graph on every git write).
    this.host?.dispose();
    this.host = undefined;

    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    this.host = CommitGraphPanel.forView(view.webview, this.repos, this.extensionUri, {
      layout: "side",
    });
    view.onDidDispose(() => {
      this.host?.dispose();
      this.host = undefined;
      this.view = undefined;
    });
    if (this.pendingReveal) {
      // reveal() queues internally until the first page of rows lands.
      this.host.reveal(this.pendingReveal);
      this.pendingReveal = undefined;
    }
  }

  /** What the panel is currently showing (used to skip redundant reveals). */
  get selectedSha(): string | undefined {
    return this.host?.selectedSha;
  }

  /**
   * Bring the panel forward and select a commit in it. Focus is NOT taken from
   * the editor: the point is to keep reading code while the commit appears
   * below. If the view has never been resolved, focusing it resolves the
   * webview and the queued reveal is applied on the way in.
   */
  async reveal(sha: string): Promise<void> {
    if (!this.host) {
      this.pendingReveal = sha;
      // Nothing to show it with yet — opening the container resolves the
      // webview, and the queued reveal is applied on the way in.
      await this.bringForward();
      return;
    }
    // Already showing it, on screen, with the details pane open — nothing to
    // do. `detailsOpen` matters: the user can dismiss the details inside the
    // webview, and re-clicking the same line must be able to bring it back
    // (only a fresh revealCommit post re-opens a dismissed dock).
    if (this.host.selectedSha === sha && this.view?.visible && this.host.detailsOpen) {
      return;
    }
    if (!this.view?.visible) {
      await this.bringForward();
    }
    this.host.reveal(sha);
  }

  /**
   * Make the panel visible WITHOUT taking keyboard focus — you should still be
   * typing in the file you clicked from. `view.show(true)` preserves focus;
   * the `.focus` command only accepts that hint via its options argument.
   */
  private async bringForward(): Promise<void> {
    if (this.view) {
      this.view.show(true);
      return;
    }
    await vscode.commands.executeCommand(`${CommitPanelViewProvider.viewId}.focus`, {
      preserveFocus: true,
    });
  }

  /** Reveal the panel (explicit user command — taking focus is correct here). */
  async show(): Promise<void> {
    await vscode.commands.executeCommand(`${CommitPanelViewProvider.viewId}.focus`);
  }

  dispose(): void {
    this.host?.dispose();
    this.host = undefined;
    this.view = undefined;
  }
}
