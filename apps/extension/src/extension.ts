import * as vscode from "vscode";
import { RepoManager } from "./git/repoManager";
import { BlameController } from "./blame/blameController";
import {
  CommitsTreeProvider,
  copyCommitSha,
  type CommitNode,
} from "./views/commitsView";
import { RefsTreeProvider } from "./views/branchesView";
import { CommitGraphPanel } from "./graph/graphPanel";
import {
  RevisionContentProvider,
  REVISION_SCHEME,
} from "./history/revisionContentProvider";
import { FileTimelineProvider } from "./history/fileTimelineProvider";
import { registerTimelineProvider } from "./history/timelineApi";
import { showLineHistory } from "./history/lineHistory";
import { RevisionNavigator } from "./history/revisionNavigation";
import { showReflog } from "./history/reflog";
import { MergeEditorProvider } from "./merge/mergeEditorProvider";
import { DiffPanel, compareCommand } from "./merge/diffPanel";
import {
  AutoOpenConflicts,
  resolveInMergeEditor,
} from "./merge/autoOpenConflicts";
import {
  ChangesTreeProvider,
  openChangeDiff,
  type ChangeFileNode,
  type ChangeGroupNode,
  relativePath,
} from "./changes/changesView";
import { CommitViewProvider } from "./changes/commitView";
import {
  stageSelectedLines,
  unstageSelectedLines,
  stageHunk,
  unstageHunk,
  type StagingRefresh,
} from "./changes/lineStaging";

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

    // File & line history + revision navigation (M5).
    const revisionContent = new RevisionContentProvider(repos);
    const timelineProvider = new FileTimelineProvider(repos);
    const navigator = new RevisionNavigator(repos);
    context.subscriptions.push(timelineProvider, navigator);

    context.subscriptions.push(
      commitsView,
      branchesView,
      vscode.workspace.registerTextDocumentContentProvider(
        REVISION_SCHEME,
        revisionContent,
      ),
      registerTimelineProvider("file", timelineProvider),
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
      vscode.commands.registerCommand("gitstudio.showCommitGraph", () => {
        CommitGraphPanel.show(repos, context.extensionUri);
      }),
      vscode.commands.registerCommand("gitstudio.showLineHistory", () => {
        void showLineHistory(repos);
      }),
      vscode.commands.registerCommand(
        "gitstudio.openChanges",
        (resource?: vscode.Uri) => void navigator.openChanges(resource),
      ),
      vscode.commands.registerCommand(
        "gitstudio.openFileAtRevision",
        (resource?: vscode.Uri) =>
          void navigator.openFileAtRevision(resource),
      ),
      vscode.commands.registerCommand(
        "gitstudio.revisionNavigateBack",
        (resource?: vscode.Uri) => void navigator.navigateBack(resource),
      ),
      vscode.commands.registerCommand(
        "gitstudio.revisionNavigateForward",
        (resource?: vscode.Uri) => void navigator.navigateForward(resource),
      ),
      vscode.commands.registerCommand("gitstudio.showReflog", () => {
        void showReflog(repos);
      }),
    );

    // Rich 3-pane merge + side-by-side diff (M6). The custom editor and the
    // diff-panel serializer must be registered for the webview tabs to resolve;
    // auto-open routes new conflicts into the merge editor (respecting the
    // gitstudio.merge.autoOpen setting).
    const autoOpen = new AutoOpenConflicts(context, repos);
    context.subscriptions.push(
      MergeEditorProvider.register(context, repos),
      DiffPanel.register(context, repos),
      autoOpen,
      vscode.commands.registerCommand(
        "gitstudio.resolveInMergeEditor",
        (arg?: vscode.Uri | { resourceUri?: vscode.Uri }) =>
          void resolveInMergeEditor(repos, arg),
      ),
      vscode.commands.registerCommand(
        "gitstudio.compare",
        (resource?: vscode.Uri) =>
          void compareCommand(context, repos, resource),
      ),
    );

    // Hunk/line staging + Changes view + commit box (M7). The Changes tree and
    // the commit webview both refresh on RepoManager.onDidChange; a shared
    // `refresh` also invalidates open index/HEAD diffs after a staging op.
    const changesProvider = new ChangesTreeProvider(repos);
    const commitProvider = new CommitViewProvider(repos, () => {
      changesProvider.refresh();
      revisionContent.notifyChanged();
    });
    context.subscriptions.push(changesProvider, commitProvider, revisionContent);

    const changesView = vscode.window.createTreeView("gitstudio.changes", {
      treeDataProvider: changesProvider,
      showCollapseAll: false,
    });

    // After any staging op: refresh the tree, the commit count, and open diffs.
    const stagingRefresh: StagingRefresh = {
      refresh() {
        changesProvider.refresh();
        revisionContent.notifyChanged();
        void vscode.commands.executeCommand("gitstudio.commit.requestState");
        // Nudge vscode.git to re-scan so the groups update promptly.
        const active = repos.getActive();
        void active?.repo.status?.();
      },
    };

    /** Resolve a repo + relative path from a Changes tree node or its uri. */
    const relOf = (node: ChangeFileNode): string =>
      relativePath(node.root, node.change.uri.fsPath);

    context.subscriptions.push(
      changesView,
      vscode.window.registerWebviewViewProvider(
        CommitViewProvider.viewId,
        commitProvider,
      ),
      vscode.commands.registerCommand("gitstudio.changes.refresh", () => {
        changesProvider.refresh();
      }),
      vscode.commands.registerCommand(
        "gitstudio.changes.openDiff",
        (node: ChangeFileNode) => void openChangeDiff(node),
      ),
      // Per-file actions (inline + context menu).
      vscode.commands.registerCommand(
        "gitstudio.changes.stageFile",
        async (node: ChangeFileNode) => {
          const active = repos.getActive();
          if (!active) return;
          await active.ctx.staging.stageFile(relOf(node));
          stagingRefresh.refresh();
        },
      ),
      vscode.commands.registerCommand(
        "gitstudio.changes.unstageFile",
        async (node: ChangeFileNode) => {
          const active = repos.getActive();
          if (!active) return;
          await active.ctx.staging.unstageFile(relOf(node));
          stagingRefresh.refresh();
        },
      ),
      vscode.commands.registerCommand(
        "gitstudio.changes.discardFile",
        async (node: ChangeFileNode) => {
          const active = repos.getActive();
          if (!active) return;
          const choice = await vscode.window.showWarningMessage(
            `Discard changes in ${relOf(node)}? This cannot be undone.`,
            { modal: true },
            "Discard",
          );
          if (choice !== "Discard") return;
          await active.ctx.staging.discardChanges(relOf(node));
          stagingRefresh.refresh();
        },
      ),
      // Group-level bulk actions.
      vscode.commands.registerCommand(
        "gitstudio.changes.stageAll",
        async (group?: ChangeGroupNode) => {
          const active = repos.getActive();
          if (!active) return;
          const changes = group?.changes ?? active.repo.state.workingTreeChanges;
          for (const c of changes) {
            await active.ctx.staging.stageFile(
              relativePath(active.root, c.uri.fsPath),
            );
          }
          stagingRefresh.refresh();
        },
      ),
      vscode.commands.registerCommand(
        "gitstudio.changes.unstageAll",
        async (group?: ChangeGroupNode) => {
          const active = repos.getActive();
          if (!active) return;
          const changes = group?.changes ?? active.repo.state.indexChanges;
          for (const c of changes) {
            await active.ctx.staging.unstageFile(
              relativePath(active.root, c.uri.fsPath),
            );
          }
          stagingRefresh.refresh();
        },
      ),
      vscode.commands.registerCommand(
        "gitstudio.changes.discardAll",
        async (group?: ChangeGroupNode) => {
          const active = repos.getActive();
          if (!active) return;
          const changes = group?.changes ?? active.repo.state.workingTreeChanges;
          if (changes.length === 0) return;
          const choice = await vscode.window.showWarningMessage(
            `Discard all ${changes.length} working-tree changes? This cannot be undone.`,
            { modal: true },
            "Discard All",
          );
          if (choice !== "Discard All") return;
          for (const c of changes) {
            await active.ctx.staging.discardChanges(
              relativePath(active.root, c.uri.fsPath),
            );
          }
          stagingRefresh.refresh();
        },
      ),
      // Line / hunk staging in any file or diff editor.
      vscode.commands.registerCommand("gitstudio.stageSelectedLines", () =>
        stageSelectedLines(repos, stagingRefresh),
      ),
      vscode.commands.registerCommand("gitstudio.unstageSelectedLines", () =>
        unstageSelectedLines(repos, stagingRefresh),
      ),
      vscode.commands.registerCommand("gitstudio.stageHunk", () =>
        stageHunk(repos, stagingRefresh),
      ),
      vscode.commands.registerCommand("gitstudio.unstageHunk", () =>
        unstageHunk(repos, stagingRefresh),
      ),
      // Lets the commit webview pull fresh state (staged count) after a stage op.
      vscode.commands.registerCommand("gitstudio.commit.requestState", () => {
        commitProvider.requestState();
      }),
    );
  });
}

export function deactivate(): void {
  // no-op; disposables are tracked on context.subscriptions
}
