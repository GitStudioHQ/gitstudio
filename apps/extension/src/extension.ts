import * as vscode from "vscode";
import { RepoManager } from "./git/repoManager";
import { BlameController } from "./blame/blameController";
import {
  CommitsTreeProvider,
  copyCommitSha,
  type CommitNode,
} from "./views/commitsView";
import { RefsTreeProvider } from "./views/branchesView";

// GitStudio extension entry point.
//
// The suite grows pillar-by-pillar (M1+): git-service wiring, the Commits /
// Branches / Remotes / Stashes / Worktrees / Tags tree views, inline blame, the
// commit graph, file & line history, hunk/line staging, diff + 3-pane merge,
// interactive rebase + the universal Undo envelope, and optional GitBrain AI.
//
// Activation stays cheap (`onStartupFinished`): heavy git work is lazy and
// off the activation path — the first commit/ref load happens when a view is
// first resolved (TreeDataProvider.getChildren). Stable VS Code APIs only, so
// the same build ships identically to the Marketplace and Open VSX (Cursor).
export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstudio.showWelcome", () => {
      void vscode.window.showInformationMessage(
        "GitStudio is installed. The full Git suite is coming online.",
      );
    }),
  );

  // RepoManager.create activates vscode.git; do it off the activation path so a
  // slow git extension never blocks startup. The views attach as soon as it
  // resolves and render empty (or the no-repo welcome) until repos arrive.
  void RepoManager.create().then((repos) => {
    context.subscriptions.push(repos);

    // Inline blame, status bar, rich hover, and full-file annotations.
    const blame = new BlameController(repos, context);
    context.subscriptions.push(blame);

    const commitsProvider = new CommitsTreeProvider(repos);
    const refsProvider = new RefsTreeProvider(repos);
    context.subscriptions.push(commitsProvider, refsProvider);

    const commitsView = vscode.window.createTreeView("gitstudio.commits", {
      treeDataProvider: commitsProvider,
      showCollapseAll: false,
    });
    const branchesView = vscode.window.createTreeView("gitstudio.branches", {
      treeDataProvider: refsProvider,
      showCollapseAll: true,
    });

    context.subscriptions.push(
      commitsView,
      branchesView,
      vscode.commands.registerCommand("gitstudio.refreshCommits", () => {
        commitsProvider.refresh();
      }),
      vscode.commands.registerCommand("gitstudio.refreshBranches", () => {
        refsProvider.refresh();
      }),
      vscode.commands.registerCommand(
        "gitstudio.copyCommitSha",
        (arg?: CommitNode | string) => void copyCommitSha(arg),
      ),
    );
  });
}

export function deactivate(): void {
  // no-op; disposables are tracked on context.subscriptions
}
