import * as vscode from "vscode";
import { RepoManager } from "./git/repoManager";
import { BlameController } from "./blame/blameController";
import {
  CommitsTreeProvider,
  copyCommitSha,
  type CommitNode,
} from "./views/commitsView";
import { RefsTreeProvider } from "./views/branchesView";
import {
  StashesTreeProvider,
  StashDiffContentProvider,
  showStash,
  saveStash,
  applyStash,
  popStash,
  dropStash,
  branchFromStash,
  type StashNode,
} from "./views/stashesView";
import {
  WorktreesTreeProvider,
  openWorktree,
  addWorktree,
  removeWorktree,
  lockWorktree,
  pruneWorktrees,
  type WorktreeNode,
} from "./views/worktreesView";
import {
  SearchCompareTreeProvider,
  runSearch,
  compareRefs,
  openSearchCommit,
  openCompareFileDiff,
} from "./search/searchCompareView";
import { SyncStatusItem } from "./statusBar/syncStatus";
import * as branchActions from "./views/branchActions";
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
import { CommitViewProvider } from "./changes/commitView";
import {
  stageSelectedLines,
  unstageSelectedLines,
  stageHunk,
  unstageHunk,
  type StagingRefresh,
} from "./changes/lineStaging";
import { runCommitAction } from "./graph/commitActions";
import { UndoLedger } from "./undo/undoLedger";
import { RebaseTodoEditorProvider } from "./rebase/rebaseTodoEditor";
import {
  startInteractiveRebase,
  abortRebase,
} from "./rebase/rebaseCommands";
import { GitBrain } from "./ai/gitBrain";
import {
  setApiKey,
  clearApiKey,
  setOpenAIKey,
  clearOpenAIKey,
  selectModelCommand,
  draftCommitMessage,
  generateCommitMessageCommand,
  explainDiffCommand,
  summarizeChangesCommand,
} from "./ai/aiCommands";
import { registerPrFeature } from "./pr/prFeature";

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
  const out = vscode.window.createOutputChannel("GitStudio");
  context.subscriptions.push(out);
  const log = (m: string): void =>
    out.appendLine(`[${new Date().toISOString().slice(11, 23)}] ${m}`);
  log("activate() called");

  const WALKTHROUGH_ID = "gitstudio.gitstudio#gitstudio.gettingStarted";
  context.subscriptions.push(
    vscode.commands.registerCommand("gitstudio.showWelcome", () => {
      void vscode.window.showInformationMessage(
        "GitStudio is installed. The full Git suite is coming online.",
      );
    }),
    vscode.commands.registerCommand("gitstudio.openWalkthrough", () => {
      void vscode.commands.executeCommand(
        "workbench.action.openWalkthrough",
        WALKTHROUGH_ID,
        false,
      );
    }),
  );

  // First-run nudge: auto-open the Getting Started walkthrough once, guarded by
  // globalState so it never reappears. Never blocks activation or git work.
  const SEEN_KEY = "gitstudio.walkthroughShown";
  if (!context.globalState.get<boolean>(SEEN_KEY)) {
    void context.globalState.update(SEEN_KEY, true);
    void vscode.commands.executeCommand(
      "workbench.action.openWalkthrough",
      WALKTHROUGH_ID,
      false,
    );
  }

  // RepoManager.create activates vscode.git; do it off the activation path so a
  // slow git extension never blocks startup. The views attach as soon as it
  // resolves and render empty (or the no-repo welcome) until repos arrive.
  void RepoManager.create().then((repos) => {
    try {
    context.subscriptions.push(repos);
    log(
      `RepoManager ready — repos=${repos.getAll().length}, active=${
        repos.getActive()?.root ?? "none"
      }`,
    );

    // Inline blame, status bar, rich hover, and full-file annotations.
    const blame = new BlameController(repos, context, log);
    context.subscriptions.push(blame);

    // The Commits and Branches views were retired: the commit graph supersedes
    // the flat Commits list, and all branch actions now live in the Changes
    // view's branch menu. The providers stay (the branch-action commands +
    // copyCommitSha's CommitNode type still use them), they're just no longer
    // mounted as sidebar tree views.
    const commitsProvider = new CommitsTreeProvider(repos);
    const refsProvider = new RefsTreeProvider(repos);
    context.subscriptions.push(commitsProvider, refsProvider);

    // File & line history + revision navigation (M5).
    const revisionContent = new RevisionContentProvider(repos);
    const timelineProvider = new FileTimelineProvider(repos);
    const navigator = new RevisionNavigator(repos);
    context.subscriptions.push(timelineProvider, navigator);

    context.subscriptions.push(
      vscode.workspace.registerTextDocumentContentProvider(
        REVISION_SCHEME,
        revisionContent,
      ),
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
      vscode.commands.registerCommand(
        "gitstudio.openCommitInGraph",
        (sha?: string) => {
          if (typeof sha === "string" && sha) {
            CommitGraphPanel.revealCommit(repos, context.extensionUri, sha);
          }
        },
      ),
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

    // File history in the native Timeline relies on the `timeline` PROPOSED API,
    // which published extensions cannot use in stable VS Code / Cursor — calling
    // it throws. Guard it so it lights up the Timeline where available (Insiders
    // / dev host) and is silently skipped otherwise. File & line history remain
    // available via the GitStudio commands regardless.
    try {
      context.subscriptions.push(
        registerTimelineProvider("file", timelineProvider),
      );
    } catch {
      log("native Timeline integration skipped (proposed API unavailable)");
    }

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

    // GitBrain — the optional bring-your-own-key AI layer (M10). It is OFF until
    // configured: with no provider, `gitstudio.ai.enabled` stays false, the ✨
    // affordance and palette commands stay hidden, and every call returns null.
    // AI never gates or breaks a git op. The API key lives in SecretStorage and
    // never leaves the host (the commit box only receives the result text).
    const brain = new GitBrain(context);
    context.subscriptions.push(brain);
    void brain.refreshEnabled();
    context.subscriptions.push(
      vscode.commands.registerCommand("gitstudio.ai.setApiKey", () =>
        setApiKey(context, brain),
      ),
      vscode.commands.registerCommand("gitstudio.ai.clearApiKey", () =>
        clearApiKey(context, brain),
      ),
      vscode.commands.registerCommand("gitstudio.ai.setOpenAIKey", () =>
        setOpenAIKey(context, brain),
      ),
      vscode.commands.registerCommand("gitstudio.ai.clearOpenAIKey", () =>
        clearOpenAIKey(context, brain),
      ),
      vscode.commands.registerCommand("gitstudio.ai.selectModel", () =>
        selectModelCommand(context, brain),
      ),
      vscode.commands.registerCommand(
        "gitstudio.ai.generateCommitMessage",
        (arg?: unknown) => generateCommitMessageCommand(brain, repos, arg),
      ),
      vscode.commands.registerCommand("gitstudio.ai.explainDiff", () =>
        explainDiffCommand(brain, repos),
      ),
      vscode.commands.registerCommand("gitstudio.ai.summarizeChanges", () =>
        summarizeChangesCommand(brain, repos),
      ),
    );

    // In-editor Pull Request review — GitHub first (M11). Connect once via VS
    // Code's built-in GitHub auth, then list / check out / review / merge /
    // create PRs without leaving the editor. Everything degrades gracefully:
    // not a GitHub repo or not signed in → the view is empty + a connect-prompt
    // shows, and no command throws. Reuses GitBrain for the optional AI-drafted
    // PR body.
    registerPrFeature(context, repos, brain);

    // Hunk/line staging + the unified Commit window (M7). The Commit webview now
    // renders BOTH the message box AND the working-tree changes inline (SCM-style
    // groups with a tree/list toggle), so it owns the changes surface; the old
    // standalone "Changes" tree view is gone. It refreshes on
    // RepoManager.onDidChange; a shared `refresh` also invalidates open
    // index/HEAD diffs after a staging op.
    const commitProvider = new CommitViewProvider(
      context.extensionUri,
      repos,
      () => {
        revisionContent.notifyChanged();
      },
      context.globalState,
      {
        isEnabled: () => brain.isEnabled(),
        draft: (entry) => draftCommitMessage(brain, entry),
      },
    );
    context.subscriptions.push(commitProvider, revisionContent);

    // After any staging op (line/hunk staging): re-push the commit webview's
    // state and invalidate open diffs. The webview owns the change lists now.
    const stagingRefresh: StagingRefresh = {
      refresh() {
        revisionContent.notifyChanged();
        commitProvider.requestState();
        // Nudge vscode.git to re-scan so the groups update promptly.
        const active = repos.getActive();
        void active?.repo.status?.();
      },
    };

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        CommitViewProvider.viewId,
        commitProvider,
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

    // Interactive rebase + the universal Undo envelope (M8). The UndoLedger
    // snapshots before every destructive op and offers one-keystroke reversal
    // (with a pushed-history → Revert safeguard); the rebase editor renders any
    // `git-rebase-todo` as the reorderable webview.
    const undo = new UndoLedger(repos, context);
    repos.setUndoLedger(undo);

    context.subscriptions.push(
      RebaseTodoEditorProvider.register(context),
      vscode.commands.registerCommand(
        "gitstudio.startInteractiveRebase",
        (arg?: string | { commit?: { sha?: string } }) => {
          const sha =
            typeof arg === "string" ? arg : arg?.commit?.sha;
          void startInteractiveRebase(repos, undo, sha);
        },
      ),
      vscode.commands.registerCommand("gitstudio.abortRebase", () =>
        abortRebase(repos),
      ),
      vscode.commands.registerCommand("gitstudio.undo", () =>
        undo.undoLast(),
      ),
      vscode.commands.registerCommand("gitstudio.showUndoHistory", () =>
        undo.showHistory(),
      ),
      vscode.commands.registerCommand(
        "gitstudio.resetToCommit",
        async (arg?: string | { commit?: { sha?: string; subject?: string } }) => {
          const active = repos.getActive();
          if (!active) {
            return;
          }
          const sha = typeof arg === "string" ? arg : arg?.commit?.sha;
          if (!sha) {
            return;
          }
          const subject =
            typeof arg === "string" ? "" : arg?.commit?.subject ?? "";
          const changed = await runCommitAction(
            "reset",
            active.ctx,
            { sha, subject },
            (label, fn) => undo.runWithUndo(active, label, fn),
          );
          if (changed) {
            commitsProvider.refresh();
          }
        },
      ),
    );

    // M9 — the remaining sidebar pillars + operations: Stashes, Worktrees,
    // Search & Compare views; branch / remote / tag context actions; and the
    // status-bar sync segment. Destructive ops (pop/drop, merge/rebase, branch
    // delete) route through the universal Undo envelope via the RepoManager's
    // wired-in ledger.
    const stashesProvider = new StashesTreeProvider(repos);
    const worktreesProvider = new WorktreesTreeProvider(repos);
    const searchCompareProvider = new SearchCompareTreeProvider(repos);
    const stashDiffContent = new StashDiffContentProvider(repos);
    context.subscriptions.push(
      stashesProvider,
      worktreesProvider,
      searchCompareProvider,
    );

    const stashesView = vscode.window.createTreeView("gitstudio.stashes", {
      treeDataProvider: stashesProvider,
      showCollapseAll: false,
    });
    const worktreesView = vscode.window.createTreeView("gitstudio.worktrees", {
      treeDataProvider: worktreesProvider,
      showCollapseAll: false,
    });
    const searchCompareView = vscode.window.createTreeView(
      "gitstudio.searchCompare",
      { treeDataProvider: searchCompareProvider, showCollapseAll: true },
    );

    const refreshStashes = () => stashesProvider.refresh();
    const refreshWorktrees = () => worktreesProvider.refresh();
    const refreshBranches = () => refsProvider.refresh();
    const revealSearchCompare = () => {
      void vscode.commands.executeCommand("gitstudio.searchCompare.focus");
    };

    // The status-bar sync segment.
    const syncStatus = new SyncStatusItem(repos);
    context.subscriptions.push(syncStatus);

    context.subscriptions.push(
      stashesView,
      worktreesView,
      searchCompareView,
      vscode.workspace.registerTextDocumentContentProvider(
        StashDiffContentProvider.scheme,
        stashDiffContent,
      ),

      // ── Stashes ────────────────────────────────────────────────────────────
      vscode.commands.registerCommand("gitstudio.stashes.refresh", () =>
        stashesProvider.refresh(),
      ),
      vscode.commands.registerCommand(
        "gitstudio.stash.show",
        (node: StashNode) => void showStash(repos, node),
      ),
      vscode.commands.registerCommand("gitstudio.stash.save", () =>
        saveStash(repos, refreshStashes),
      ),
      vscode.commands.registerCommand(
        "gitstudio.stash.apply",
        (node: StashNode) => applyStash(repos, node, refreshStashes),
      ),
      vscode.commands.registerCommand(
        "gitstudio.stash.pop",
        (node: StashNode) => popStash(repos, node, refreshStashes),
      ),
      vscode.commands.registerCommand(
        "gitstudio.stash.drop",
        (node: StashNode) => dropStash(repos, node, refreshStashes),
      ),
      vscode.commands.registerCommand(
        "gitstudio.stash.branch",
        (node: StashNode) => branchFromStash(repos, node, refreshStashes),
      ),

      // ── Worktrees ──────────────────────────────────────────────────────────
      vscode.commands.registerCommand("gitstudio.worktrees.refresh", () =>
        worktreesProvider.refresh(),
      ),
      vscode.commands.registerCommand(
        "gitstudio.worktree.open",
        (node: WorktreeNode) => void openWorktree(node),
      ),
      vscode.commands.registerCommand("gitstudio.worktree.add", () =>
        addWorktree(repos, refreshWorktrees),
      ),
      vscode.commands.registerCommand(
        "gitstudio.worktree.remove",
        (node: WorktreeNode) => removeWorktree(repos, node, refreshWorktrees),
      ),
      vscode.commands.registerCommand(
        "gitstudio.worktree.lock",
        (node: WorktreeNode) =>
          lockWorktree(repos, node, true, refreshWorktrees),
      ),
      vscode.commands.registerCommand(
        "gitstudio.worktree.unlock",
        (node: WorktreeNode) =>
          lockWorktree(repos, node, false, refreshWorktrees),
      ),
      vscode.commands.registerCommand("gitstudio.worktree.prune", () =>
        pruneWorktrees(repos, refreshWorktrees),
      ),

      // ── Search & Compare ───────────────────────────────────────────────────
      vscode.commands.registerCommand("gitstudio.search", () =>
        runSearch(repos, searchCompareProvider, revealSearchCompare),
      ),
      vscode.commands.registerCommand("gitstudio.compareRefs", () =>
        compareRefs(repos, searchCompareProvider, revealSearchCompare),
      ),
      vscode.commands.registerCommand(
        "gitstudio.searchCompare.openCommit",
        (node) => void openSearchCommit(node),
      ),
      vscode.commands.registerCommand(
        "gitstudio.searchCompare.openFileDiff",
        (arg) => void openCompareFileDiff(arg),
      ),

      // ── Branch / remote / tag context actions ──────────────────────────────
      vscode.commands.registerCommand(
        "gitstudio.branch.checkout",
        (arg) => branchActions.checkoutBranch(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.merge",
        (arg) =>
          branchActions.mergeBranchIntoCurrent(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.rebase",
        (arg) => branchActions.rebaseCurrentOnto(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.rename",
        (arg) => branchActions.renameBranch(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.delete",
        (arg) => branchActions.deleteBranch(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.push",
        (arg) => branchActions.pushBranch(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.setUpstream",
        (arg) => branchActions.setUpstream(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.new",
        (arg) => branchActions.newBranchFrom(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.createWorktree",
        (arg) =>
          branchActions.createWorktreeForBranch(repos, arg, refreshWorktrees),
      ),
      vscode.commands.registerCommand(
        "gitstudio.branch.compare",
        (arg) =>
          branchActions.compareRefWithCurrent(
            repos,
            searchCompareProvider,
            revealSearchCompare,
            arg,
          ),
      ),
      vscode.commands.registerCommand(
        "gitstudio.remoteBranch.checkout",
        (arg) =>
          branchActions.checkoutRemoteBranch(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.remoteBranch.delete",
        (arg) => branchActions.deleteRemoteBranch(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.tag.checkout",
        (arg) => branchActions.checkoutTag(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.tag.delete",
        (arg) => branchActions.deleteTag(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand(
        "gitstudio.tag.push",
        (arg) => branchActions.pushTag(repos, arg, refreshBranches),
      ),
      vscode.commands.registerCommand("gitstudio.fetch", () =>
        branchActions.fetchAll(repos, refreshBranches),
      ),
      vscode.commands.registerCommand("gitstudio.addRemote", () =>
        branchActions.addRemote(repos, refreshBranches),
      ),
      vscode.commands.registerCommand("gitstudio.manageRemotes", () =>
        branchActions.manageRemotes(repos, refreshBranches),
      ),
    );
    log("registration complete — every section wired with no errors");
    } catch (e) {
      const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
      log("ACTIVATION ERROR (everything after this line failed to register):");
      log(detail);
      console.error("[GitStudio] activation error:", e);
      out.show(true);
      void vscode.window.showErrorMessage(
        "GitStudio failed to finish loading — see the GitStudio Output channel for the error.",
      );
    }
  }).catch((e) => {
    const detail = e instanceof Error ? (e.stack ?? e.message) : String(e);
    log("RepoManager.create() rejected — nothing registered: " + detail);
    out.show(true);
  });
}

export function deactivate(): void {
  // no-op; disposables are tracked on context.subscriptions
}
