import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";
import { CommitGraphPanel } from "./graphPanel";

/**
 * The Commits sidebar view: hosts `<gitstudio-commit-rail>`, the sidebar-NATIVE
 * commit log (compact two-line rows, a capped topology rail, ref micro-chips,
 * search) — not the editor-area table. It shares the CommitGraphPanel host and
 * wire protocol, so the same data streams into both surfaces; activating a
 * commit here (double-click / Enter / hover action) promotes it to the full
 * Commit Graph panel, and right-click gives the full commit action menu.
 */
export class CommitsGraphViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "gitstudio.commits";

  private host: CommitGraphPanel | undefined;
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
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    this.host = CommitGraphPanel.forView(
      view.webview,
      this.repos,
      this.extensionUri,
      { sidebar: true },
    );
    view.onDidDispose(() => {
      this.host?.dispose();
      this.host = undefined;
    });
    if (this.pendingReveal) {
      this.host.reveal(this.pendingReveal);
      this.pendingReveal = undefined;
    }
  }

  /** Focus the Commits view and reveal (select + scroll to) a commit. */
  async reveal(sha: string): Promise<void> {
    if (this.host) {
      await vscode.commands.executeCommand(
        `${CommitsGraphViewProvider.viewId}.focus`,
      );
      // reveal() queues internally if the graph hasn't booted its first page.
      this.host.reveal(sha);
      return;
    }
    // The view hasn't been resolved yet — queue the reveal, then focusing it
    // resolves the webview and applies the pending reveal.
    this.pendingReveal = sha;
    await vscode.commands.executeCommand(
      `${CommitsGraphViewProvider.viewId}.focus`,
    );
  }

  dispose(): void {
    this.host?.dispose();
    this.host = undefined;
  }
}
