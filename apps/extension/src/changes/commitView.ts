import * as vscode from "vscode";
import { failed, NO_REPOSITORY, notifyCopied } from "../ui/notify";
import { relativeTime } from "../util/relativeTime";
import { markWalkthrough } from "../ui/walkthroughProgress";
import type { GitRef } from "@gitstudio/git-service/index";
import { pushUnseenMessage, type PullResult } from "@gitstudio/git-service/SyncOps";
import { askPullMode, settlePullDetached, settlePullStop, settlePushUnseen } from "../git/pullMode";
import { applyOrAsk, checkoutOp, pullOrAsk } from "../git/inTheWay";
import { newBranchAtHead } from "@gitstudio/git-service/changesInTheWay";
import { commitBlockerMessage } from "@gitstudio/git-service/StagingProvider";
import { headBranchName } from "@gitstudio/git-service/RefProvider";
import { listChangeBlocks, setBlockStaged } from "@gitstudio/git-service/blockStaging";
import { isWorkingTreeFileOf } from "../util/repoScope";
import { slowStateChanged, type SlowState } from "./slowState";
import { branchActionWords, branchesPayload, pickedRefName, withFavorites, type BranchesPayload } from "./branchMenuData";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { repoName as repoNameOf, switchRepository, workspacePathOf } from "../git/repoPicker";
import { pruneOnFetch } from "../git/fetchOptions";
import { Arrival } from "../ui/arrival";

/**
 * One change of a file, as the Changes list shows it.
 *
 * Every change since HEAD, not only the unstaged ones — `state` is what lets a
 * ticked change stay in the list instead of vanishing the moment it is staged.
 */
interface HunkRow {
  index: number;
  /** 0-based line range in the working-tree text. */
  start: number;
  end: number;
  state: "staged" | "unstaged" | "partial";
  preview: string;
  lineCount: number;
}
import type { Change } from "../git/git";
import { getNonce } from "../webview/html";
import {
  promptConfirm,
  promptPick,
  type DialogHost,
  type DialogResult,
  type DialogSpec,
} from "../ui/dialogs";
// The shared design tokens, inlined as text by esbuild (the extension ctx uses
// the ".css": "text" loader). Injected into the webview <style> so this surface
// consumes the SAME token system as every bundled webview — one source, no drift.
import tokensCss from "../../../../packages/webview-ui/src/styles/tokens.css";
// The push review's commit and file rows — the same ones the Worktrees view
// draws (webview-ui/changeRows): their stylesheet inlined here, their script
// loaded as dist/webview/change-rows.js (window.GsChangeRows).
import changeRowsCss from "../../../../packages/webview-ui/src/changeRows/changeRows.css";
import {
  openChangeDiff,
  relativePath,
  ChangeFileNode,
  statusLetter,
  type GroupKind,
} from "./changesView";
import {
  collectCommits,
  collectCompareFiles,
  type CompareFile,
} from "../compare/refCompare";
import { commitChangeSides, openSidesDiff, toRevisionUri } from "../history/revisionContentProvider";
import { operationBanner, type OperationBannerData } from "./operationBanner";
import { stoppedByThisCommand, type DetectedOperation } from "../git/pausedForUser";
import { detectOperation, notifyPaused } from "../git/pauseNotice";
import { isStashSha, stashTitle } from "@gitstudio/git-service/StashProvider";
import { stashRows, type StashRow } from "./stashRows";
import {
  applyStash,
  branchFromStash,
  copyStashFiles,
  dropStash,
  moveStashFiles,
  openStashFile,
  popStash,
  showStash,
  stashFileSides,
  type StashOutcome,
} from "../views/stashesView";

// The unified Commit window: ONE WebviewView ("Commit", viewId gitstudio.commit)
// that renders BOTH the commit message box AND the working-tree changes —
// styled like VS Code's native Source Control view, but it's GitStudio's own and
// theme-native via --vscode-* tokens (correct in dark / light / HC). A
// tree ⇄ list (flat) layout toggle for the changed files is computed client-side
// and persisted in globalState. Strict CSP + nonce; vanilla JS inlined (no
// separate esbuild entry for this small surface). AI is an injected host hook so
// the key stays 100% host-side (the webview only ever receives the result text).

/** A single changed file pushed to the webview: repo-relative path + 1-letter status. */
interface FileEntry {
  path: string;
  status: string;
}

interface StatePayload {
  type: "state";
  /** Whether a repository is open — drives the no-repo onboarding state. */
  hasRepo: boolean;
  /**
   * No repository yet, and discovery has not settled (RepoManager
   * .isDiscovering): the page says it is looking, not that there is none.
   */
  discovering?: boolean;
  merge: FileEntry[];
  staged: FileEntry[];
  unstaged: FileEntry[];
  stagedCount: number;
  /**
   * How the file list is presented: "split" keeps the staged/unstaged groups,
   * "checkboxes" shows one list with a tick per file (issue #16). The tick maps
   * onto the index, so the two models are two views of the same git state.
   */
  stagingModel: "split" | "checkboxes";
  /** Branch name, or the short revision when HEAD is detached. */
  branch?: string;
  /** True when `branch` is a revision (detached HEAD), not a branch name. */
  detached?: boolean;
  /** Branch + remote lists driving the in-header branch/actions menu. */
  branches?: BranchesPayload;
  /** Upstream tracking ref (e.g. "origin/main"), when the branch tracks one. */
  upstream?: string;
  /** Commits the local branch is ahead of its upstream. */
  ahead?: number;
  /** Commits the local branch is behind its upstream. */
  behind?: number;
  /** Commits a push would SEND: `ahead` when tracking an upstream, else the
   *  count of commits not yet on ANY remote (the never-pushed publish case). */
  unpushed?: number;
  /** True when those commits have somewhere to go (an upstream, or a remote to
   *  publish a never-pushed branch to) — gates the primary Push/Publish button. */
  canPublish?: boolean;
  /** Short repo/workspace name shown in the header. */
  repoName?: string;
  /** How many repositories are open; from 2 the header offers Switch Repository. */
  repoCount: number;
  /** Where the active repository is ("code/api"), for the control's tooltip —
   *  a long name is clipped in the header, and two repos can share a name. */
  repoPath?: string;
  lastMessage?: string;
  signoffDefault: boolean;
  aiEnabled: boolean;
  /**
   * The user turned AI off (gitstudio.ai.provider = "off", which "Disable AI
   * Features" sets): the composer offers no Connect-AI plug then.
   */
  aiOff?: boolean;
  layout: "tree" | "list";
  busy: boolean;
  /**
   * A stopped merge / rebase / cherry-pick / revert / am / stash, or unmerged
   * files: the banner above the lists (Resolve Conflicts…, Continue, Skip,
   * Abort). Absent when nothing is in progress.
   */
  operation?: OperationBannerData;
  /**
   * With `detached`: why a push cannot start from here, in the words the push
   * review and a refused push use (detachedPushReason). The Push button's tip.
   */
  detachedReason?: string;
  /**
   * The stash list, newest first — the Stashes group. Absent when not read
   * yet for this repository (the page keeps what it shows); empty when there
   * are none (no group).
   */
  stashes?: StashRow[];
}

interface FromWebview {
  type:
    | "ready"
    | "commit"
    | "generateMessage"
    | "stage"
    | "unstage"
    | "discard"
    | "stagePaths"
    | "unstagePaths"
    | "discardPaths"
    | "openDiff"
    | "stageAll"
    | "stageAllForCommit"
    | "requestHunks"
    | "stageHunk"
    | "unstageAll"
    | "discardAll"
    | "stageFolder"
    | "unstageFolder"
    | "discardFolder"
    | "openFile"
    | "reviewChanges"
    | "connectAI"
    | "stash"
    | "setStagingModel"
    | "stashPaths"
    | "stashStaged"
    | "setLayout"
    | "amendToggled"
    | "branchAction"
    | "branchRefCommand"
    | "requestPushPreview"
    | "confirmPush"
    | "discardLocalCommits"
    | "newBranchFromPush"
    | "openPushFileDiff"
    | "pushCommitFiles"
    | "openPushCommitFile"
    | "openFolder"
    | "openGraph"
    | "resolveConflicts"
    | "operation"
    | "switchRepo"
    | "stashAct"
    | "stashFiles"
    | "stashOpenFile"
    | "stashOpenAll"
    | "stashReadFiles"
    | "dialogResult";
  /**
   * A full sha: the stash (stashAct, stashFiles, stashOpenFile, stashOpenAll,
   * stashReadFiles), or the push review's commit (pushCommitFiles,
   * openPushCommitFile).
   */
  sha?: string;
  /** operation: which verb the banner's button asked for. */
  verb?: "continue" | "skip" | "abort";
  /** Correlation id for a `dialogResult` reply (see DialogHost below). */
  dialogId?: string;
  /** The dialog's answer: text, a choice id, checked ids, or "ok". */
  dialogValue?: string | string[];
  /** A pick's or a confirm's checked options ("Also delete the branch"). */
  dialogOptions?: string[];
  path?: string;
  /** Original path for a renamed file (push-modal file diff). */
  oldPath?: string;
  staged?: boolean;
  group?: GroupKind;
  /** File paths targeted by a folder-level or multi-selection stage/unstage/discard. */
  paths?: string[];
  /** Which hunk of `path` a stageHunk targets (index from the last requestHunks). */
  hunkIndex?: number;
  layout?: "tree" | "list";
  /** 0-based line to reveal when opening a diff at a particular change. */
  line?: number;
  /** Which staging model the Changes view should present. */
  stagingModel?: "split" | "checkboxes";
  message?: string;
  amend?: boolean;
  /** confirmPush: push with --force-with-lease (see confirmPush). */
  force?: boolean;
  signoff?: boolean;
  author?: string;
  push?: boolean;
  /** Branch-menu sub-action: new | checkoutRef | pull | pullRebase | push |
   *  fetch | pullFf | copyName | favorite. (Checkouts go via branchRefCommand.)
   *  stashAct: apply | pop | drop | branch. stashFiles: copy | move. */
  action?: string;
  /** The ref a branch action targets (branch name or "remote/branch"). */
  ref?: string;
  /** A `gitstudio.*` command id to run with a synthetic `{ ref }` arg (branch action submenu). */
  command?: string;
  /** The kind of ref the submenu command targets: "head" (local) | "remote" | "tag". */
  refType?: "head" | "remote" | "tag";
  /** openPushCommitFile: the commit's first parent (absent for a root commit). */
  parent?: string;
  /** openPushCommitFile: git's letter for what the commit did to the file. */
  status?: string;
}

/**
 * The host-side hook the commit box uses to draft a message from the staged
 * diff. Injected (not imported) so this view stays decoupled from the AI layer and
 * the key stays 100% host-side — the webview only ever receives the result text.
 * Returns null when AI is unavailable or nothing is staged.
 */
export interface CommitMessageGenerator {
  isEnabled(): Promise<boolean>;
  draft(entry: RepoEntry): Promise<string | null>;
}

/**
 * The Changes view's doors into the shared merge experience
 * (@gitstudio/merge-vscode): a conflicted row opens in the resolver instead of
 * a two-way diff, and the operation banner's buttons run the same Continue /
 * Skip / Abort as the palette and the dashboard (one confirm, one set of words).
 */
export interface ChangesMergeHooks {
  /** Open one conflicted file in the configured resolver. */
  openConflict(uri: vscode.Uri): Promise<void>;
  /** Open the Conflicts dashboard for this repository. */
  showConflicts(root: string): Promise<void>;
  /** Continue / Skip / Abort the operation stopped in this repository. */
  operationVerb(verb: "continue" | "skip" | "abort", root: string): Promise<void>;
}

/**
 * Which staging model the Changes view presents. Read per push rather than
 * cached, so flipping the setting takes effect on the next repaint without a
 * reload — the same idiom the other settings here use.
 */
function readStagingModel(): "split" | "checkboxes" {
  return vscode.workspace
    .getConfiguration("gitstudio")
    .get<"split" | "checkboxes">("changes.stagingModel", "split");
}

const LAYOUT_KEY = "gitstudio.commit.layout";

/**
 * How long to wait after a file save (or the window regaining focus) before
 * re-reading the working tree. Shorter than repoManager's 400ms firehose
 * debounce because this one is a direct response to something the user just
 * did — long enough to fold a Save All into one refresh, short enough that the
 * list still reads as live rather than manually refreshed.
 */
const EXTERNAL_REFRESH_DEBOUNCE_MS = 300;

/** Why a push cannot start on a detached HEAD — host and page say the same. */
const DETACHED_PUSH_REASON =
  "HEAD is detached, so these commits are on no branch and there is nothing to push them to. Create a branch here to push them.";
/** Why a push cannot start in a repository with no remote. */
const NO_REMOTE_PUSH_REASON = "No remote is configured for this repository.";

/** An operation stopped on a detached HEAD, as the subject of a sentence. */
const STOPPED_OPERATION: Record<string, string> = {
  merge: "A merge",
  rebase: "A rebase",
  "rebase-merge-step": "A rebase",
  "cherry-pick": "A cherry-pick",
  revert: "A revert",
  am: "A git am session",
};

/**
 * Why a push cannot start on a detached HEAD, given what is stopped there.
 *
 * Every stopped rebase is a detached HEAD, and "create a branch here" is the
 * wrong advice in one: a branch made mid-rebase points at a half-rebased
 * commit. The commits reach the branch being rebased when the rebase
 * finishes, so that is what it says. Any other operation stopped on a
 * detached HEAD (a rebase begun on one, a cherry-pick) leaves its commits on
 * no branch even when it finishes, and a branch cannot be made over the stop
 * (New branch… is refused there: `git checkout -b` would end or move out
 * from under it) — so it is finish, then branch. Only a plain detached HEAD
 * gets the plain advice. The page shows the host's words
 * (StatePayload.detachedReason), so the tip, the review and a refused push
 * give the same reason.
 */
function detachedPushReason(op: OperationBannerData | undefined): string {
  const stopped = op ? STOPPED_OPERATION[op.kind] : undefined;
  if (!op || !stopped) {
    return DETACHED_PUSH_REASON;
  }
  const finish = `Finish it with ${op.continueLabel || "Continue"}`;
  return op.rebaseBranch
    ? `A rebase of ${op.rebaseBranch} is in progress, so there is no branch to push until it finishes. ` +
        `${finish} and these commits land on ${op.rebaseBranch}.`
    : `${stopped} is in progress on a detached HEAD, so these commits are on no branch. ` +
        `${finish}, then create a branch to push them.`;
}

/** Git's canonical empty-tree object — the "before" side when previewing the
 *  push of a branch whose oldest unpushed commit is a root commit. */
const COMMIT_EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** A short, friendly label for a diff ref: 7-char sha, "(new file)" for the
 *  empty tree, or the ref name verbatim (e.g. "origin/main"). */
function pushRefLabel(ref: string): string {
  if (ref === COMMIT_EMPTY_TREE) return "(new file)";
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

export class CommitViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable, DialogHost
{
  static readonly viewId = "gitstudio.commit";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Pending debounce for a working-tree change (see scheduleExternalRefresh). */
  private externalRefresh: ReturnType<typeof setTimeout> | undefined;
  /** Does the pending refresh need vscode.git to re-scan, or just a re-push? */
  private externalRescan = false;
  private busy = false;

  /**
   * Coalesces overlapping non-amend state pushes. `onDidChange` is a debounced
   * firehose but still fires repeatedly during a rebase/fetch, and each push
   * used to run to completion concurrently. We now run one at a time and fold
   * any pushes that arrive mid-flight into a single trailing re-push.
   */
  private pushing = false;
  private pushQueued = false;
  // Last-known slow values, so the instant first push carries them (no flicker)
  // and re-posts refresh them once the git/LM probes resolve.
  private lastAiEnabled = false;
  private lastBranches: BranchesPayload | undefined;
  /**
   * Which repo `lastBranches` came from. The instant first post reuses the last
   * known branch list so the menu is not empty while the slow for-each-ref probe
   * runs — but branches are repo-scoped, so without this the view showed the
   * PREVIOUS repo's branches for a moment after switching repos, and the active
   * repo follows the active editor, so switching is routine rather than rare.
   *
   * `lastAiEnabled` deliberately has no equivalent: provider availability is a
   * property of the machine, not of the repo, so carrying it across is correct.
   */
  private lastBranchesRoot: string | undefined;
  /** `JSON.stringify(lastBranches)`, so a re-post can tell whether it changed. */
  private lastBranchesSig: string | undefined;
  /** The operation banner last read for `lastBranchesRoot` (carried by the instant first post). */
  private lastOperation: OperationBannerData | undefined;
  /** The conflicted paths last pushed, and for which repository — a row click routes on them. */
  private lastMergePaths: { root: string; paths: Set<string> } | undefined;
  /**
   * The stash list last read, for which repository, carried by the instant
   * first post as the branch list is. Cleared by a stash action, so the post
   * right after it never shows the list from before it.
   */
  private lastStashes: { root: string; rows: StashRow[]; sig: string; stale?: true } | undefined;
  /** Bumped by invalidateRefs so an in-flight listRefs cannot re-cache stale refs. */
  private refsEpoch = 0;

  /**
   * Short-TTL cache of the raw ref list — the priciest part of a state push (a
   * `for-each-ref` + `stash list`). Staging a file, or any unrelated ref write,
   * shouldn't re-list every branch on every push. Favorites/recents are still
   * recomputed fresh from the memento on each push, so the cache never freezes
   * the star toggles; branch operations call {@link invalidateRefs} so a
   * checkout / new / delete still reflects immediately.
   */
  private refsCache: { root: string; at: number; refs: GitRef[]; remotes: string[] } | undefined;
  private static readonly REFS_TTL_MS = 1500;

  constructor(
    /** For opening the branded Monaco diff panel from the push modal. */
    private readonly context: vscode.ExtensionContext,
    /** The extension root URI, for loading bundled assets (the codicon font). */
    private readonly extensionUri: vscode.Uri,
    private readonly repos: RepoManager,
    private readonly onCommitted: () => void,
    /** Persists the tree/list layout choice across reloads. */
    private readonly memento: vscode.Memento,
    /** Optional AI hook for the "Generate message" sparkle button. */
    private readonly generator?: CommitMessageGenerator,
    /** The merge experience's doors (conflicted rows, the operation banner). */
    private readonly merge?: ChangesMergeHooks,
  ) {
    this.disposables.push(this.repos.onDidChange(() => void this.pushState()));
    // The staging model is a setting, and the toolbar toggle is a shortcut to
    // it. Without this, changing it in the Settings UI leaves the view showing
    // the other model until something unrelated happens to refresh it.
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("gitstudio.changes.stagingModel") ||
          // Turned off (or back on) with nothing else changing: the plug follows.
          event.affectsConfiguration("gitstudio.ai.provider")
        ) {
          void this.pushState();
        }
      }),
    );

    // Nothing in GitStudio watched the WORKING TREE (issue #17). The extension's
    // only two file watchers are scoped to .git metadata, and there was no save
    // or focus handler anywhere — so editing a file produced no signal at all,
    // and the list kept showing whatever it last read. "Leave the view and come
    // back" worked because visibility is the one thing that re-pushed
    // (see resolveWebviewView), which is exactly the workaround the report
    // describes.
    //
    // Two triggers, because they cover different worlds:
    //   · a save in THIS window — the reported case, and the common one.
    //   · the window regaining focus — an edit made by another tool entirely
    //     (a CLI, a formatter, another editor), which no editor event can see.
    // The two differ in ONE respect, and it matters more than it looks:
    // whether they ask vscode.git to re-scan.
    //
    // A save does not. If vscode.git is attached it watches the working tree and
    // will notice the save on its own; if it is not attached, resolveState reads
    // the working tree itself, so a plain push already produces fresh data. And
    // asking it to re-scan is expensive in a way that has nothing to do with
    // this view: its status event feeds RepoManager's firehose, which thirteen
    // subscribers listen to — including the Pull Requests view, which answers by
    // reloading from the GitHub API. A file save cannot change a pull request,
    // and paying a network round-trip per keystroke-save would be indefensible.
    //
    // Regaining focus does re-scan, because that is the case where something
    // outside the editor may have changed the repo behind everyone's back — and
    // it happens a few times an hour, not a few times a minute.
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((doc) => {
        if (this.isInActiveRepo(doc.uri)) {
          this.scheduleExternalRefresh(false);
        }
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) {
          this.scheduleExternalRefresh(true);
        }
      }),
      new vscode.Disposable(() => this.cancelExternalRefresh()),
    );
  }

  /**
   * Is `uri` a file inside the active repository — and not git's own metadata?
   *
   * The `.git` exclusion matters because a save is not the only thing that lands
   * there; the point of this hook is working-tree edits, and repoManager already
   * watches the metadata that matters (HEAD, MERGE_HEAD, the index) with its own
   * dedicated watchers.
   */
  private isInActiveRepo(uri: vscode.Uri): boolean {
    if (uri.scheme !== "file") {
      return false;
    }
    const root = this.repos.getActive()?.ctx.root;
    return !!root && isWorkingTreeFileOf(uri.fsPath, root);
  }

  /**
   * Coalesce a burst into one refresh: Save All over fifty files, or a
   * format-on-save that writes the file a second time, are each one edit as far
   * as the user is concerned.
   */
  private scheduleExternalRefresh(rescan: boolean): void {
    const enabled = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("changes.autoRefresh", true);
    if (!enabled) {
      return;
    }
    // A pending re-scan is never downgraded by a later save: if anything in the
    // burst asked for the expensive read, the burst gets it.
    this.externalRescan = this.externalRescan || rescan;
    this.cancelExternalRefresh();
    this.externalRefresh = setTimeout(() => {
      this.externalRefresh = undefined;
      const rescanNow = this.externalRescan;
      this.externalRescan = false;
      void this.refreshFromDisk(rescanNow);
    }, EXTERNAL_REFRESH_DEBOUNCE_MS);
  }

  private cancelExternalRefresh(): void {
    if (this.externalRefresh) {
      clearTimeout(this.externalRefresh);
      this.externalRefresh = undefined;
    }
  }

  /**
   * Re-scan, THEN push. The order is the whole fix, and it is the same lesson
   * mutate() already carries: pushState reads vscode.git's IN-MEMORY state, so
   * pushing without asking for a re-scan first just re-renders the stale list.
   *
   * Deliberately NOT gated on `view.visible`. The activity-bar badge is built
   * from this same state, and a hidden panel is exactly when that badge is the
   * only thing you can see — gating here would trade one stale surface for
   * another. It is cheap enough: with vscode.git attached the state read costs no
   * git processes, only the re-scan does.
   */
  private async refreshFromDisk(rescan = true): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      return;
    }
    if (rescan) {
      try {
        await entry.repo?.status?.();
      } catch {
        // Best-effort — push anyway so we repaint from whatever we can read.
      }
    }
    await this.pushState();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.viewArrival.set(view);
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);

    this.disposables.push(
      view.webview.onDidReceiveMessage((msg: FromWebview) =>
        this.onMessage(msg),
      ),
    );
    view.onDidChangeVisibility(() => {
      if (view.visible) {
        // Re-scan, not just re-push: "leave the view and come back" was the
        // workaround people found for the stale list (issue #17), so of all the
        // paths this is the one that must actually be true when it returns.
        void this.refreshFromDisk();
      }
    });
    view.onDidDispose(() => {
      // The webview holding a dialog is gone; nobody will ever answer. Settle
      // every waiter as "dismissed" so the awaiting command finishes instead of
      // hanging forever on a promise that can't resolve.
      this.settleAllDialogs();
      this.viewArrival.clear(view);
      if (this.view === view) {
        this.view = undefined;
      }
    });
    // A reload replaces the DOM, taking any open dialog with it.
    this.settleAllDialogs();
    // Fresh document ⇒ fresh script; nothing is listening until it says "ready".
    this.webviewReady = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
    void this.pushState();
  }

  // ── DialogHost — GitStudio's own dialogs, rendered in this view ─────────────

  /** Pending dialogs by correlation id → the resolver awaiting an answer. */
  private readonly dialogWaiters = new Map<
    string,
    (r: DialogResult | undefined) => void
  >();
  private dialogSeq = 0;
  /**
   * The view, as VS Code resolves it — which, for a view never opened in this
   * window, happens AFTER its `.focus` command has returned (see Arrival).
   */
  private readonly viewArrival = new Arrival<vscode.WebviewView>();
  /** Resolves once the current webview document's script is listening. */
  private webviewReady: Promise<void> | undefined;
  private markReady: (() => void) | undefined;

  /**
   * Render a dialog in this view and await the answer.
   *
   * Reveals the Changes view first: a command can be run from the palette, the
   * commit graph, or an editor context menu while the sidebar is collapsed, and
   * a dialog nobody can see is worse than the quick input we replaced.
   */
  async show(spec: DialogSpec): Promise<DialogResult | undefined> {
    if (!this.view?.visible) {
      try {
        // Resolves the view if it has never been opened, and expands it if the
        // user had it collapsed. Focus lands in the dialog either way.
        await vscode.commands.executeCommand(`${CommitViewProvider.viewId}.focus`);
      } catch {
        // Fall through — if the view did resolve, the post below still works.
      }
    }
    // A view never opened in this window is resolved by VS Code only after
    // `.focus` returns: wait for it. Without this, the Commit Graph's Revert
    // over an uncommitted edit (the Changes view never opened) got "dismissed"
    // back at once — no Stash & Retry question, nothing ran, nothing said.
    const view = this.view ?? (await this.viewArrival.wait(5000));
    if (!view) {
      void vscode.window.showWarningMessage(
        "GitStudio: the Changes view didn't open, so this action can't ask its question. Open the GitStudio sidebar and try again.",
      );
      return undefined;
    }
    // A just-revealed webview has a document but not yet a running script, and a
    // message posted into that gap is dropped — the dialog would simply never
    // appear. Wait for its "ready", but never longer than a moment: if the
    // script is wedged, showing the dialog late still beats hanging the command.
    await Promise.race([
      this.webviewReady ?? Promise.resolve(),
      new Promise<void>((r) => setTimeout(r, 3000)),
    ]);
    const dialogId = `d${++this.dialogSeq}`;
    const answered = new Promise<DialogResult | undefined>((resolve) => {
      this.dialogWaiters.set(dialogId, resolve);
    });
    const posted = await view.webview.postMessage({
      type: "dialog",
      dialogId,
      spec,
    });
    if (!posted) {
      // The webview never received it (disposed mid-flight) — don't await an
      // answer that cannot come.
      this.dialogWaiters.delete(dialogId);
      return undefined;
    }
    return answered;
  }

  private resolveDialog(
    id: string | undefined,
    value: string | string[] | undefined,
    options?: unknown,
  ): void {
    if (!id) {
      return;
    }
    const resolve = this.dialogWaiters.get(id);
    if (!resolve) {
      return; // already settled (a dismissal that raced a reload)
    }
    this.dialogWaiters.delete(id);
    const checked = Array.isArray(options) ? options.filter((o): o is string => typeof o === "string") : undefined;
    resolve(value === undefined ? undefined : checked ? { value, options: checked } : { value });
  }

  /** Settle every pending dialog as dismissed (view reloaded or disposed). */
  private settleAllDialogs(): void {
    for (const resolve of this.dialogWaiters.values()) {
      resolve(undefined);
    }
    this.dialogWaiters.clear();
  }

  /**
   * Scroll the diff that is about to open to `line` (0-based).
   *
   * The editor does not exist yet when the open is requested, and there is no
   * "diff opened" event to await, so this waits for the active editor to become
   * one whose document is a file and then reveals. It gives up quietly: landing
   * on the right line is a nicety, and failing to must never stop the diff
   * itself from opening.
   */
  private async revealAfterOpen(line: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const editor = vscode.window.activeTextEditor;
      if (!editor) continue;
      const target = Math.min(Math.max(0, line), Math.max(0, editor.document.lineCount - 1));
      const range = new vscode.Range(target, 0, target, 0);
      editor.revealRange(range, vscode.TextEditorRevealType.InCenter);
      editor.selection = new vscode.Selection(range.start, range.start);
      return;
    }
  }

  /** Re-push state (staged count + change lists) after an external op. */
  requestState(): void {
    void this.pushState();
  }

  /** A stash was made, applied or dropped elsewhere (the palette): re-read the Stashes group. */
  stashesChanged(): void {
    void this.refreshStashes();
  }

  /**
   * Reveal the Changes view and open its branch menu — the branch surface this
   * extension already has, reached from the status bar.
   *
   * The view has to be revealed and given a moment first: a webview that has
   * never been resolved has no document to post into, and the message would be
   * dropped silently.
   */
  async openBranchMenu(): Promise<void> {
    await vscode.commands.executeCommand("gitstudio.commit.focus");
    for (let i = 0; i < 20 && !this.view; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    void this.view?.webview.postMessage({ type: "openBranchMenu" });
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case "ready":
        this.markReady?.();
        // The in-view Refresh button posts "ready" too, so this is also the
        // user's manual escape hatch — and it was the WEAKEST path of all: it
        // re-pushed vscode.git's cache without ever asking for a re-scan, so
        // pressing Refresh on a stale list could repaint the same stale list.
        // If anything earns the cost of a real re-scan, it is someone explicitly
        // asking to be brought up to date.
        await this.refreshFromDisk();
        return;
      case "amendToggled":
        await this.pushState(!!msg.amend);
        return;
      case "dialogResult":
        this.resolveDialog(msg.dialogId, msg.dialogValue, msg.dialogOptions);
        return;
      case "branchAction":
        await this.handleBranchAction(msg);
        return;
      case "branchRefCommand":
        await this.handleBranchRefCommand(msg);
        return;
      case "requestPushPreview":
        // The view's own Push: this window's repository.
        this.setPushTarget(undefined);
        await this.sendPushPreview();
        return;
      case "pushCommitFiles":
        await this.sendPushCommitFiles(msg.sha ?? "");
        return;
      case "openPushCommitFile":
        await this.openPushCommitFile(msg);
        return;
      case "confirmPush":
        await this.confirmPush(!!msg.force);
        return;
      case "discardLocalCommits":
        await this.discardLocalCommits();
        return;
      case "newBranchFromPush":
        await this.newBranchFromPush(msg.ref);
        return;
      case "openPushFileDiff":
        await this.openPushFileDiff(msg.path ?? "", msg.oldPath);
        return;
      case "openFolder":
        await vscode.commands.executeCommand("vscode.openFolder");
        return;
      case "openGraph":
        await vscode.commands.executeCommand("gitstudio.showCommitGraph");
        return;
      case "switchRepo":
        // The header's repository control — the same picker as the palette's
        // Switch Repository…, answered in this view's own dialog.
        await switchRepository(this.repos);
        return;
      case "stashAct":
        await this.doStashAct(msg.sha ?? "", msg.action ?? "");
        return;
      case "stashFiles":
        await this.doStashFiles(msg.sha ?? "", msg.action ?? "", msg.paths ?? []);
        return;
      case "stashOpenFile":
        if (!(await openStashFile(this.repos, msg.sha ?? "", msg.path ?? "", !!msg.staged))) {
          await this.refreshStashes();
        }
        return;
      case "stashOpenAll":
        await this.openWholeStash(msg.sha ?? "");
        return;
      case "stashReadFiles":
        await this.readStashFiles(msg.sha ?? "");
        return;
      case "resolveConflicts": {
        const entry = this.repos.getActive();
        if (entry) {
          await this.merge?.showConflicts(entry.root);
        }
        return;
      }
      case "operation": {
        const entry = this.repos.getActive();
        try {
          if (entry && msg.verb && this.merge) {
            await this.merge.operationVerb(msg.verb, entry.root);
          }
        } finally {
          // Whatever happened (done, stopped again, refused, or the user backed
          // out of the confirm): release the banner's buttons, which lock on
          // click, and repaint from git.
          void this.view?.webview.postMessage({ type: "operationDone" });
          await this.refreshFromDisk();
        }
        return;
      }
      case "generateMessage":
        await this.doGenerate();
        return;
      case "commit":
        await this.doCommit(msg);
        return;
      case "setLayout":
        if (msg.layout === "tree" || msg.layout === "list") {
          await this.memento.update(LAYOUT_KEY, msg.layout);
        }
        return;
      case "stage":
        await this.stageHoldingConflicts([msg.path ?? ""]);
        return;
      case "unstage":
        await this.mutate(
          (entry) => entry.ctx.staging.unstageFile(msg.path ?? ""),
          { verb: "unstage", paths: [msg.path ?? ""] },
        );
        return;
      case "discard":
        await this.doDiscardPaths([msg.path ?? ""]);
        return;
      // A multi-selection is ONE message and one git call. It used to be one
      // "stage" per file, all at once: every git after the first found the
      // index locked and failed, and a multi-selection Discard opened one
      // confirm per file, each dismissing the last, so only the final file was
      // discarded.
      case "stagePaths":
        await this.stageHoldingConflicts(msg.paths ?? []);
        return;
      case "unstagePaths": {
        const paths = (msg.paths ?? []).filter((p) => p);
        await this.mutate((entry) => entry.ctx.staging.unstageFiles(paths), {
          verb: "unstage",
          paths,
        });
        return;
      }
      case "discardPaths":
        await this.doDiscardPaths(msg.paths ?? []);
        return;
      case "openDiff":
        await this.doOpenDiff(msg.path ?? "", !!msg.staged, msg.line);
        return;
      case "stageAll":
        await this.doBulkStage(msg.group);
        return;
      case "stageAllForCommit":
        await this.doStageAllForCommit();
        return;
      case "requestHunks":
        await this.sendHunks(msg.path ?? "");
        return;
      case "stageHunk":
        await this.doStageHunk(msg.path ?? "", msg.hunkIndex ?? -1);
        return;
      case "unstageAll":
        await this.doBulkUnstage();
        return;
      case "discardAll":
        await this.doDiscardAll();
        return;
      case "stageFolder":
        await this.stageHoldingConflicts(msg.paths ?? []);
        return;
      case "unstageFolder":
        await this.mutate(
          (entry) => entry.ctx.staging.unstageFiles(msg.paths ?? []),
          { verb: "unstage", paths: msg.paths ?? [] },
        );
        return;
      case "discardFolder":
        await this.doDiscardFolder(msg.paths ?? []);
        return;
      case "openFile":
        await this.doOpenFile(msg.path ?? "");
        return;
      case "reviewChanges":
        await vscode.commands.executeCommand("gitstudio.ai.reviewChanges");
        return;
      case "connectAI":
        await vscode.commands.executeCommand("gitstudio.ai.connect");
        return;
      case "stashPaths": {
        // A drag onto the stash target, or the selection bar's Stash button.
        // Same flow as the whole-tree stash, scoped — and the prompt names the
        // scope, so it is clear what is about to move before it moves.
        const paths = msg.paths ?? [];
        if (paths.length === 0) {
          break;
        }
        await vscode.commands.executeCommand("gitstudio.stash.paths", { paths });
        try {
          await this.repos.getActive()?.repo?.status?.();
        } catch {
          // best-effort; the firehose reconciles the list either way
        }
        break;
      }
      case "setStagingModel": {
        // Persisted as a real setting, so the choice survives a reload and stays
        // editable from Settings — the toggle is a shortcut to it, not a
        // second, competing source of truth.
        const model = msg.stagingModel === "checkboxes" ? "checkboxes" : "split";
        await vscode.workspace
          .getConfiguration("gitstudio")
          .update(
            "changes.stagingModel",
            model,
            vscode.ConfigurationTarget.Global,
          );
        break;
      }
      case "stashStaged":
        await vscode.commands.executeCommand("gitstudio.stash.staged");
        try {
          await this.repos.getActive()?.repo?.status?.();
        } catch {
          // best-effort; the firehose reconciles the list either way
        }
        break;
      case "stash":
        // Runs the shared stash flow (message + options quick-pick), then
        // re-scans so the working tree list clears immediately.
        await vscode.commands.executeCommand("gitstudio.stash.save");
        try {
          await this.repos.getActive()?.repo?.status?.();
        } catch {
          // best-effort; the firehose reconciles the list either way
        }
        await this.pushState();
        return;
    }
  }

  // ── The Stashes group ──────────────────────────────────────────────────────

  /**
   * Every stash, file by file (StashProvider.files, read once per stash),
   * newest first. Empty on a read git refuses: the group then says nothing
   * rather than something wrong.
   */
  private async collectStashes(entry: RepoEntry): Promise<StashRow[]> {
    let list;
    try {
      list = await entry.ctx.stashes.list();
    } catch {
      return [];
    }
    const files = await Promise.all(list.map((e) => entry.ctx.stashes.files(e.sha).catch(() => undefined)));
    return stashRows(list, files);
  }

  /**
   * A stash's files, for the page that opened one the list carried as a
   * count (stashRows). StashProvider keeps what it read, so this is the read
   * the list already made. `files: null` when there is nothing to read — not
   * a stash's sha, or git could not read it — and the page says so.
   */
  private async readStashFiles(sha: string): Promise<void> {
    const entry = this.repos.getActive();
    const files =
      entry && isStashSha(sha) ? await entry.ctx.stashes.files(sha).catch(() => undefined) : undefined;
    void this.view?.webview.postMessage({ type: "stashFilesRead", sha, files: files ?? null });
  }

  /**
   * The list carried by the next instant post may be from before a stash
   * action: it carries none then (the page keeps what it shows, with its own
   * patches), and the read after it answers.
   */
  private markStashesStale(): void {
    if (this.lastStashes) {
      this.lastStashes.stale = true;
    }
  }

  /** Re-read the list and repaint, after a stash action or a stash that left. */
  private async refreshStashes(): Promise<void> {
    this.markStashesStale();
    await this.refreshFromDisk();
  }

  /**
   * A stash row's Apply / Pop / Drop… / Create Branch…. The page moved the
   * row at the click; "stashPending" says the question was answered (Drop,
   * Create Branch), and "stashDone" what became of it, so the page keeps the
   * row gone or puts it back.
   */
  private async doStashAct(sha: string, action: string): Promise<void> {
    const refresh = (): void => void this.refreshStashes();
    const hooks = {
      onConfirmed: () => void this.view?.webview.postMessage({ type: "stashPending", sha, action }),
    };
    let outcome: StashOutcome = { kind: "kept" };
    try {
      switch (action) {
        case "apply":
          outcome = await applyStash(this.repos, sha, refresh);
          break;
        case "pop":
          outcome = await popStash(this.repos, sha, refresh);
          break;
        case "drop":
          outcome = await dropStash(this.repos, sha, refresh, hooks);
          break;
        case "branch":
          outcome = await branchFromStash(this.repos, sha, refresh, hooks);
          if (outcome.kind === "done") this.invalidateRefs();
          break;
      }
    } finally {
      this.markStashesStale();
      void this.view?.webview.postMessage({ type: "stashDone", sha, action, outcome });
    }
  }

  /** Copy to Changes / Move to Changes for some of a stash's files. */
  private async doStashFiles(sha: string, action: string, paths: string[]): Promise<void> {
    const refresh = (): void => void this.refreshStashes();
    const wanted = paths.filter((p) => p.length > 0);
    let outcome: StashOutcome = { kind: "kept" };
    try {
      if (wanted.length > 0 && (action === "copy" || action === "move")) {
        outcome =
          action === "move"
            ? await moveStashFiles(this.repos, sha, wanted, refresh)
            : await copyStashFiles(this.repos, sha, wanted, refresh);
      }
    } finally {
      this.markStashesStale();
      void this.view?.webview.postMessage({ type: "stashDone", sha, action, paths: wanted, outcome });
    }
  }

  /**
   * Open All Changes: every file of the stash in one multi-file diff where
   * VS Code has one (`vscode.changes`), else the stash as one patch. Binary
   * files have no text to compare, so they are left out of the multi-diff.
   */
  private async openWholeStash(sha: string): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry || !sha) {
      return;
    }
    const stash = (await entry.ctx.stashes.list()).find((e) => e.sha === sha);
    const files = stash ? await entry.ctx.stashes.files(sha) : undefined;
    if (!stash || !files) {
      void vscode.window.showInformationMessage("GitStudio: That stash is no longer in the list.");
      await this.refreshStashes();
      return;
    }
    const commands = await vscode.commands.getCommands(true);
    if (!commands.includes("vscode.changes")) {
      await showStash(this.repos, sha);
      return;
    }
    const resources = files
      .filter((f) => !f.binary)
      .map((f) => {
        const { left, right } = stashFileSides(stash, f, f.onlyStaged === true);
        return [
          vscode.Uri.joinPath(vscode.Uri.file(entry.root), f.path),
          toRevisionUri(entry.root, left.rev, f.path, left.path),
          toRevisionUri(entry.root, right.rev, f.path, right.path),
        ] as const;
      });
    await vscode.commands.executeCommand("vscode.changes", `Stash “${stashTitle(stash.message).text}”`, resources);
  }

  /**
   * Stage `paths`, holding back the unmerged files that still carry conflict
   * markers.
   *
   * `git add` on an unmerged file is how git is told the conflict is resolved,
   * and it does not look inside: staging one with `<<<<<<<` still in it marked
   * it resolved, and the next commit carried the markers into the tree. Every
   * Stage in this view (a row's +, a tick, a folder, a selection, Stage All,
   * the checklist's check-all) comes through here. The held-back rows go back
   * on the page at once; the user is told which files and why, in the words
   * the desktop app's Stage uses for the same refusal, once the rest has been
   * staged — "Staged everything else" was said before the stage ran, and a
   * stage git then refused was reported twice, the second toast contradicting
   * the first.
   */
  private async stageHoldingConflicts(paths: string[]): Promise<void> {
    const wanted = paths.filter((p) => p);
    const entry = this.repos.getActive();
    if (!entry || wanted.length === 0) {
      return;
    }
    let held: string[] = [];
    try {
      held = await entry.ctx.staging.markedConflicts(wanted);
    } catch {
      held = [];
    }
    const keep = wanted.filter((p) => !held.includes(p));
    if (held.length > 0) {
      void this.view?.webview.postMessage({ type: "opFailed", paths: held });
    }
    let staged = false;
    if (keep.length > 0) {
      staged = await this.mutate(
        (e) => (keep.length === 1 ? e.ctx.staging.stageFile(keep[0]) : e.ctx.staging.stageFiles(keep)),
        { verb: "stage", paths: keep },
      );
    }
    if (held.length > 0) {
      void vscode.window.showWarningMessage(
        `GitStudio: ${markedConflictsMessage(held, staged)}`,
      );
    }
  }

  /**
   * Run a per-file staging op against the active repo, then reconcile.
   *
   * The webview has ALREADY moved the row optimistically (see the client's
   * `applyOptimistic`), so this path no longer gates what the user sees. We run
   * the git op, force a fresh vscode.git status scan, and push the authoritative
   * state to reconcile. `await`ing `status()` — instead of the old
   * fire-and-forget + read-STALE-state — is the fix that made staging feel slow:
   * the real lists now land the moment git finishes, not a debounce cycle later,
   * and (crucially) we never repaint the pre-stage state over the optimistic row.
   *
   * Resolves whether the op went through: false when git refused it (already
   * said) or no repository is active.
   */
  private async mutate(
    op: (entry: RepoEntry) => Promise<unknown>,
    what?: { verb: "stage" | "unstage" | "discard"; paths: string[] },
  ): Promise<boolean> {
    const entry = this.repos.getActive();
    if (!entry) {
      return false;
    }
    // A failure is SAID, and the rows it moved go back at once. This used to
    // ignore the op's result entirely: a refused `git add` left its row sitting
    // in Staged until the optimistic move timed out four seconds later, then
    // snapped back without a word.
    let failure: string | undefined;
    try {
      const result = await op(entry);
      if (isRefusal(result)) {
        failure = result.stderr.trim() || "git gave no reason.";
      }
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    if (failure !== undefined && what) {
      const paths = what.paths.filter((p) => p);
      void this.view?.webview.postMessage({ type: "opFailed", paths, error: failure });
      void vscode.window.showErrorMessage(
        `GitStudio: couldn't ${what.verb} ${describePaths(paths)} — ${failure}`,
      );
    }
    // Re-scan NOW so pushState reads fresh index/worktree state. (The old code
    // fired this and forgot, then immediately read STALE state — so the row only
    // really moved a debounce cycle later, which read as "seconds of lag".)
    try {
      await entry.repo?.status?.();
    } catch {
      // status() is best-effort; the firehose still reconciles eventually.
    }
    if (failure === undefined && what?.verb === "stage") {
      markWalkthrough("staged");
    }
    this.onCommitted();
    await this.pushState();
    return failure === undefined;
  }

  /**
   * Discard a set of working-tree files, routing UNTRACKED files (status "U")
   * to `git clean -f` and tracked files to `git checkout --`, in SEPARATE git
   * invocations. A single `git checkout -- <paths>` aborts atomically the moment
   * any pathspec is untracked, which would silently discard NOTHING — so the two
   * classes must never share one command. Runs inside one mutate() so the view
   * reconciles once.
   */
  private async discardEntries(files: FileEntry[]): Promise<void> {
    const untracked = files
      .filter((f) => f.status === "U")
      .map((f) => f.path);
    const tracked = files.filter((f) => f.status !== "U").map((f) => f.path);
    if (untracked.length === 0 && tracked.length === 0) {
      return;
    }
    await this.mutate(
      async (e) => {
        const checkedOut = tracked.length > 0 ? await e.ctx.staging.discardFiles(tracked) : undefined;
        const cleaned = untracked.length > 0 ? await e.ctx.staging.cleanFiles(untracked) : undefined;
        return [checkedOut, cleaned].find(isRefusal);
      },
      { verb: "discard", paths: files.map((f) => f.path) },
    );
  }

  /**
   * Resolve each path to its working-tree status letter (for discard routing).
   * Paths not currently in the unstaged/merge groups default to tracked ("M"),
   * so they still go through `git checkout --`.
   */
  /**
   * The files a discard would touch, with their status letters, and how many
   * of them ALSO have staged changes. `git checkout --` restores from the
   * index, so for those the staged part survives: the confirm has to say so
   * rather than promise a return to the committed version.
   */
  private async discardTargets(
    active: RepoEntry,
    paths: string[],
  ): Promise<{ files: FileEntry[]; partlyStaged: number }> {
    const wanted = [...new Set(paths.filter((p) => p))];
    if (wanted.length === 0) {
      return { files: [], partlyStaged: 0 };
    }
    const { unstaged, merge, staged } = await this.resolveState(active);
    const byPath = new Map<string, string>();
    for (const f of [...unstaged, ...merge]) {
      byPath.set(f.path, f.status);
    }
    const stagedPaths = new Set(staged.map((f) => f.path));
    const files = wanted.map((path) => ({ path, status: byPath.get(path) ?? "M" }));
    const partlyStaged = files.filter((f) => f.status !== "U" && stagedPaths.has(f.path)).length;
    return { files, partlyStaged };
  }

  /**
   * Discard one file or a multi-selection: ONE question naming what goes, then
   * one git call per kind of file (see discardEntries).
   */
  private async doDiscardPaths(paths: string[]): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const { files, partlyStaged } = await this.discardTargets(active, paths);
    if (files.length === 0) {
      return;
    }
    const n = files.length;
    const ok = await promptConfirm({
      title: n === 1 ? `Discard changes in ${files[0].path}?` : `Discard changes in ${n} files?`,
      message: discardConsequence(files, partlyStaged),
      confirmLabel: n === 1 ? "Discard" : `Discard ${n} Files`,
      danger: true,
    });
    if (!ok) {
      return;
    }
    await this.discardEntries(files);
  }

  private async doOpenDiff(path: string, staged: boolean, line?: number): Promise<void> {
    const conflicted = this.repos.getActive();
    if (!staged && conflicted && path && this.merge && this.isConflictRow(conflicted, path)) {
      // A conflicted file opens where it can be RESOLVED — the merge editor —
      // not a working-tree-vs-HEAD diff full of conflict markers.
      void this.merge.openConflict(
        vscode.Uri.joinPath(vscode.Uri.file(conflicted.root), ...path.split("/")),
      );
      return;
    }
    if (typeof line === "number" && line >= 0) {
      // Opening at a specific change: reveal it once the diff editor exists.
      // Fire-and-forget so the diff still opens if the reveal cannot land.
      void this.revealAfterOpen(line);
    }
    const active = this.repos.getActive();
    if (!active || !path) {
      return;
    }
    const kind: GroupKind = staged ? "staged" : "unstaged";
    // When vscode.git is attached, use its live Change (carries the rename
    // originalUri) and detect a merge/conflict pool.
    if (active.repo) {
      const state = active.repo.state;
      const pool = staged
        ? state.indexChanges
        : findIn(state.mergeChanges, active.root, path)
          ? state.mergeChanges
          : state.workingTreeChanges;
      const change = findIn(pool, active.root, path);
      if (change) {
        const isMerge = pool === state.mergeChanges;
        void openChangeDiff(
          new ChangeFileNode(isMerge ? "merge" : kind, active.root, change),
        );
        return;
      }
    }
    // Eager window (or a not-yet-known file): openChangeDiff only needs the
    // working-tree URI, which we synthesize from the path — so the diff opens
    // without waiting for vscode.git. A staged rename also needs its old name,
    // which vscode.git's Change would have carried; git says what it is.
    const at = (rel: string) => vscode.Uri.joinPath(vscode.Uri.file(active.root), ...rel.split("/"));
    const renamedFrom = staged
      ? await active.ctx.staging.renamedFrom(path).catch(() => undefined)
      : undefined;
    void openChangeDiff(
      new ChangeFileNode(kind, active.root, {
        uri: at(path),
        ...(renamedFrom ? { originalUri: at(renamedFrom) } : {}),
      } as unknown as Change),
    );
  }

  /** Is `path` one of the repository's unmerged files (vscode.git's merge group, or our last read)? */
  private isConflictRow(entry: RepoEntry, path: string): boolean {
    if (entry.repo) {
      return findIn(entry.repo.state.mergeChanges, entry.root, path) !== undefined;
    }
    return this.lastMergePaths?.root === entry.root && this.lastMergePaths.paths.has(path);
  }

  /** The banner for the repository's stopped operation, or undefined (never throws). */
  private async readOperation(entry: RepoEntry): Promise<OperationBannerData | undefined> {
    try {
      const detected = await entry.ctx.operation.detect();
      if (detected.kind === "none" && detected.unmerged === 0) {
        return undefined;
      }
      const view = await entry.ctx.operation.view();
      const banner = operationBanner(view, detected);
      if (banner && (view.kind === "rebase" || view.kind === "rebase-merge-step") && view.yours.name) {
        // `yours` is the branch being rebased — or, for a rebase begun on a
        // detached HEAD, the commit it began from. Only a branch is one the
        // commits land on.
        const r = await entry.ctx.process.run([
          "show-ref",
          "--verify",
          "--quiet",
          `refs/heads/${view.yours.name}`,
        ]);
        if (r.code === 0) {
          banner.rebaseBranch = view.yours.name;
        }
      }
      return banner;
    } catch {
      return undefined;
    }
  }

  /** Open the working-tree file (from the in-sidebar file actions menu). */
  private async doOpenFile(path: string): Promise<void> {
    const active = this.repos.getActive();
    if (!active || !path) {
      return;
    }
    const uri = vscode.Uri.joinPath(
      vscode.Uri.file(active.root),
      ...path.split("/"),
    );
    try {
      await vscode.window.showTextDocument(uri, { preview: true });
    } catch {
      // File may be gone (e.g. deleted) — best-effort.
    }
  }

  /**
   * When nothing is staged, ask whether to commit everything — and stage it if
   * so (issue #16).
   *
   * Returns "cancelled" when the user declined, otherwise "ok" (which includes
   * the ordinary case where something WAS already staged and nothing was asked).
   *
   * Deliberately stages for real rather than committing with `-a`: `-a` skips
   * untracked files and bypasses the index, so what got committed would not match
   * what the list showed. Staging first means the thing you confirmed is exactly
   * the thing that lands.
   */
  private async confirmCommitAll(entry: RepoEntry): Promise<"ok" | "cancelled"> {
    const { merge, staged, unstaged } = await this.resolveState(entry);
    if (staged.length > 0) {
      return "ok"; // normal path — commit what is staged, as always
    }
    // Conflicted files are never swept into "everything". This used to stage
    // them with the rest, and `git add` on a conflicted file marks it resolved
    // whatever is in it, so a stopped rebase could be committed with the
    // conflict markers inside. git will not commit while files are unmerged
    // anyway; say so before touching the index rather than after.
    if (merge.length > 0) {
      const n = merge.length;
      void vscode.window.showWarningMessage(
        `GitStudio: ${n === 1 ? `${merge[0].path} still has` : `${n} files still have`} conflicts. ` +
          "Resolve and stage them first — git can't commit while files are unmerged.",
      );
      return "cancelled";
    }
    const candidates = unstaged;
    if (candidates.length === 0) {
      return "ok"; // nothing anywhere; the commit will explain itself
    }
    const n = candidates.length;
    const ok = await promptConfirm({
      title: `Commit all ${n} changed file${n === 1 ? "" : "s"}?`,
      message:
        "Nothing is staged, so everything currently changed will be included — new files too. " +
        "Stage individually first if you only want some of it.",
      confirmLabel: `Commit all ${n}`,
    });
    if (!ok) {
      return "cancelled";
    }
    const result = await entry.ctx.staging.stageFiles(candidates.map((e) => e.path));
    if (!result.ok) {
      void vscode.window.showErrorMessage(
        `GitStudio: couldn't stage the changes — ${result.stderr.trim() || "unknown error"}`,
      );
      return "cancelled";
    }
    return "ok";
  }

  /**
   * The still-unstaged hunks of one file, for the checkbox model's per-hunk ticks
   * (#20). Read from DISK rather than from an open editor buffer: git stages what
   * is on disk, so an unsaved buffer would show hunks that ticking them would not
   * actually stage.
   */
  /**
   * Every change in `rel` since HEAD, each with its own tick state.
   *
   * It used to list only the UNSTAGED hunks, which made ticking one look like a
   * bug: the change you just picked vanished from the list, because it was no
   * longer unstaged. Listing every change against HEAD and labelling each one
   * staged / unstaged / partial means a tick changes a checkbox and nothing
   * else moves — which is what a checkbox is supposed to do.
   */
  private async sendHunks(rel: string): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry || !rel) {
      return;
    }
    let hunks: HunkRow[] = [];
    try {
      const text = await this.workingTreeText(entry, rel);
      const lines = text.split("\n");
      const blocks = await listChangeBlocks(entry.ctx, rel, text);
      hunks = blocks.map((b, index) => {
        // A pure deletion has a zero-width span on the working side; report it
        // as its anchor line rather than as an empty range.
        const start = b.working.start;
        const end = b.working.end < b.working.start ? b.working.start : b.working.end;
        const firstChanged = lines
          .slice(start, end + 1)
          .find((l) => l.trim().length > 0);
        return {
          index,
          start,
          end,
          state: b.state,
          preview: (firstChanged ?? "").trim().slice(0, 120),
          lineCount: Math.max(1, end - start + 1),
        };
      });
    } catch {
      hunks = []; // binary, deleted, unreadable — the row just shows nothing
    }
    void this.view?.webview.postMessage({ type: "hunks", path: rel, hunks });
  }

  /**
   * Toggle one change: stage it, or unstage it if it is already staged.
   *
   * It only ever staged before, because the list only ever held unstaged
   * changes — so a tick was a one-way door and unticking was impossible. Now
   * that every change is listed with its state, the tick has to work both ways
   * or it is not a checkbox.
   */
  private async doStageHunk(rel: string, index: number): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry || !rel || index < 0) {
      return;
    }
    try {
      const text = await this.workingTreeText(entry, rel);
      const blocks = await listChangeBlocks(entry.ctx, rel, text);
      const block = blocks[index];
      if (!block) {
        // The file moved under the list between render and click.
        await this.sendHunks(rel);
        return;
      }
      // A partial change completes rather than reverting: the visible state is
      // "not finished", so forward is the obvious direction, and unstaging
      // would throw away work already staged.
      const r = await setBlockStaged(
        entry.ctx,
        rel,
        text,
        block,
        block.state !== "staged",
      );
      if (!r.ok) {
        void vscode.window.showInformationMessage(`GitStudio: ${r.stderr}`);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `GitStudio: couldn't stage that change — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    await this.mutate(async () => {});
    await this.sendHunks(rel);
  }

  /** The file as git would stage it: what is on disk, not what is in a buffer. */
  private async workingTreeText(entry: RepoEntry, rel: string): Promise<string> {
    const uri = vscode.Uri.joinPath(vscode.Uri.file(entry.ctx.root), ...rel.split("/"));
    const bytes = await vscode.workspace.fs.readFile(uri);
    return new TextDecoder().decode(bytes);
  }

  /** Stage everything currently changed — the checklist's "check all". */
  private async doStageAllForCommit(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const { merge, unstaged } = await this.resolveState(active);
    await this.stageHoldingConflicts([...merge, ...unstaged].map((e) => e.path));
  }

  /**
   * A group header's Stage All, or (no group) the toolbar's, which is the
   * Changes group's: it never marks a conflict resolved, and the page keeps it
   * disabled while only conflicted files are left.
   */
  private async doBulkStage(group?: GroupKind): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const { merge, unstaged } = await this.resolveState(active);
    await this.stageHoldingConflicts((group === "merge" ? merge : unstaged).map((e) => e.path));
  }

  private async doBulkUnstage(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const { staged } = await this.resolveState(active);
    const rels = staged.map((e) => e.path);
    await this.mutate((e) => e.ctx.staging.unstageFiles(rels), { verb: "unstage", paths: rels });
  }

  private async doDiscardAll(): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const { unstaged } = await this.resolveState(active);
    const rels = unstaged.map((e) => e.path);
    if (rels.length === 0) {
      return;
    }
    const { partlyStaged } = await this.discardTargets(active, rels);
    const ok = await promptConfirm({
      title: `Discard all ${rels.length} working-tree change${rels.length === 1 ? "" : "s"}?`,
      message: discardConsequence(unstaged, partlyStaged),
      confirmLabel: "Discard All",
      danger: true,
    });
    if (!ok) {
      return;
    }
    await this.discardEntries(unstaged);
  }

  private async doDiscardFolder(paths: string[]): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const { files, partlyStaged } = await this.discardTargets(active, paths);
    if (files.length === 0) {
      return;
    }
    const ok = await promptConfirm({
      title: `Discard changes in ${files.length} file${files.length === 1 ? "" : "s"}?`,
      message: discardConsequence(files, partlyStaged),
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) {
      return;
    }
    await this.discardEntries(files);
  }

  /**
   * Draft a commit message from the staged diff via the AI features and fill the box.
   * AI is optional: when there's no provider (or nothing staged), we toast a
   * friendly note and clear the button's loading state — never an error, and
   * never anything that touches the commit flow itself.
   */
  private async doGenerate(): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry || !this.generator) {
      this.view?.webview.postMessage({ type: "generateDone" });
      return;
    }
    try {
      const text = await this.generator.draft(entry);
      if (text && text.trim().length > 0) {
        this.view?.webview.postMessage({ type: "setMessage", text });
      } else {
        void vscode.window.setStatusBarMessage(
          "$(sparkle) Nothing to draft (stage changes first)",
          3000,
        );
      }
    } catch {
      // Stay silent — AI must never break the commit box.
    } finally {
      this.view?.webview.postMessage({ type: "generateDone" });
    }
  }

  /** Runs the commit (+ optional push), surfacing errors and clearing on success. */
  private async doCommit(msg: FromWebview): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      void vscode.window.showInformationMessage(NO_REPOSITORY);
      return;
    }
    const message = (msg.message ?? "").trim();
    if (message === "" && !msg.amend) {
      void vscode.window.showWarningMessage(
        "GitStudio: enter a commit message.",
      );
      void this.view?.webview.postMessage({ type: "commitDone", ok: false });
      return;
    }

    // Nothing staged, but there IS work? Offer to commit all of it rather than
    // refusing (issue #16). VS Code and JetBrains both do this, and requiring a
    // separate staging step for "commit what I just did" is friction with no
    // payoff. The confirmation is the point — you see what is about to go in
    // before it does, so nothing is committed that you did not look at.
    if (!msg.amend) {
      const included = await this.confirmCommitAll(entry);
      if (included === "cancelled") {
        void this.view?.webview.postMessage({ type: "commitDone", ok: false });
        return;
      }
    }

    this.busy = true;
    void this.pushState();
    try {
      // An amend rewrites HEAD — wrap it in the Undo envelope so the prior
      // commit is one keystroke from restorable. A plain commit only adds a new
      // commit (already reachable via the normal Undo / reflog), so it runs
      // directly.
      const doCommit = () =>
        entry.ctx.staging.commit(message, {
          amend: msg.amend,
          signoff: msg.signoff,
          author: msg.author?.trim() || undefined,
        });
      const ledger = this.repos.getUndoLedger();
      const result =
        msg.amend && ledger
          ? await ledger.runWithUndo(entry, "Amend commit", doCommit)
          : await doCommit();
      if (!result.ok) {
        const stderr = result.stderr.trim();
        // Nothing staged is not a failure, and it used to read as one with no
        // text at all: git refuses with exit 1, says why on STDOUT, and leaves
        // stderr empty — so "commit failed — unknown error" was the whole
        // message (issue #16). An empty stderr is the signal to ask git what the
        // situation actually is, rather than to shrug.
        const blocker = stderr
          ? undefined
          : await entry.ctx.staging.whyNothingToCommit();
        if (blocker) {
          const text = commitBlockerMessage(blocker);
          // Information, not error: the user did nothing wrong.
          void vscode.window.showInformationMessage(`GitStudio: ${text}`);
          void this.view?.webview.postMessage({
            type: "commitDone",
            ok: false,
            error: text,
          });
          // And repaint. Reaching this at all means the list was lying: the
          // Commit button is disabled unless the pushed state says something is
          // staged, so a stale list is what let the click through. Telling the
          // user "nothing is staged" while the rows that contradict it are still
          // on screen would be the same bug wearing a better message.
          await this.refreshFromDisk();
          return;
        }
        // A real failure. git explains most of them on stderr; stdout is next
        // because `git commit` is the one command that puts a refusal there. A
        // silent hook leaves BOTH empty — say so plainly rather than shrugging
        // with "unknown error", since a rejecting hook is by far the likeliest
        // way to get here with nothing to show.
        const detail =
          stderr ||
          result.stdout.trim() ||
          "git refused the commit without saying why. If this repository has a pre-commit hook, check its output.";
        void vscode.window.showErrorMessage(failed("Commit", detail));
        void this.view?.webview.postMessage({
          type: "commitDone",
          ok: false,
          error: detail,
        });
        return;
      }

      void vscode.window.setStatusBarMessage("$(check) Committed", 3000);
      markWalkthrough("committed");

      // Clear the box and refresh the views. The commit spinner clears on
      // commitDone; for a Commit & Push the modal then opens for the push step.
      this.view?.webview.postMessage({ type: "clear" });
      this.view?.webview.postMessage({ type: "commitDone", ok: true });
      void entry.repo?.status?.();
      this.onCommitted();

      // Commit & Push never pushes blindly: it opens the same review modal every
      // other push route uses, so the user confirms exactly what's about to be
      // pushed (and can still undo the commit) before it leaves their machine.
      if (msg.push) {
        this.setPushTarget(undefined);
        await this.sendPushPreview();
      }
    } finally {
      this.busy = false;
      void this.pushState();
    }
  }

  // ── Branch menu (folds the old Branches view into the Changes header) ──────

  private favKey(entry: RepoEntry): string {
    return `gitstudio.commit.favorites:${entry.root}`;
  }
  private recentKey(entry: RepoEntry): string {
    return `gitstudio.commit.recentBranches:${entry.root}`;
  }
  private favorites(entry: RepoEntry): string[] {
    return this.memento.get<string[]>(this.favKey(entry), []);
  }
  private async toggleFavorite(entry: RepoEntry, name: string): Promise<void> {
    const cur = new Set(this.favorites(entry));
    if (cur.has(name)) {
      cur.delete(name);
    } else {
      cur.add(name);
    }
    await this.memento.update(this.favKey(entry), [...cur]);
  }
  /**
   * Mirror the built-in SCM view's count badge on the GitStudio activity-bar
   * icon, so pending work is visible without opening the view. The number is
   * changed FILES (a path staged *and* modified counts once, like the native
   * badge); incoming commits ride along in the tooltip rather than inflating
   * the count into something ambiguous.
   */
  private updateBadge(
    staged: readonly FileEntry[],
    unstaged: readonly FileEntry[],
    behind: number | undefined,
  ): void {
    if (!this.view) {
      return;
    }
    const on = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("changesBadge", true);
    const paths = new Set<string>();
    if (on) {
      for (const f of staged) paths.add(f.path);
      for (const f of unstaged) paths.add(f.path);
    }
    const count = paths.size;
    const incoming = on ? (behind ?? 0) : 0;
    const bits: string[] = [];
    if (count) bits.push(`${count} changed file${count === 1 ? "" : "s"}`);
    if (incoming) bits.push(`${incoming} incoming commit${incoming === 1 ? "" : "s"} to pull`);

    // A zero badge, NEVER `undefined`. Clearing a *webview* view's badge does not
    // work: WebviewViewPane.updateBadge only calls showViewActivity when the new
    // badge is truthy and has no else-branch to clear the old one — unlike the
    // TreeView setter beside it, which does. So `badge = undefined` updates the
    // field and leaves the last number stranded on the activity-bar icon forever.
    // That is issue #7: commit everything, and the icon still reads "1".
    //
    // The activity bar sums its container's number badges and only renders when
    // the total is > 0, so a 0 is invisible — and we already relied on that, since
    // a repo that is only behind has always published { value: 0 }.
    this.view.badge = {
      value: count,
      tooltip: bits.length ? `GitStudio — ${bits.join(" · ")}` : "",
    };
  }

  private async noteRecentBranch(entry: RepoEntry, name: string): Promise<void> {
    const prev = this.memento.get<string[]>(this.recentKey(entry), []);
    const next = [name, ...prev.filter((n) => n !== name)].slice(0, 8);
    await this.memento.update(this.recentKey(entry), next);
  }

  /** Local branches (with favorites), remotes, recents, and tags for the branch menu. */
  private async collectBranches(entry: RepoEntry): Promise<BranchesPayload> {
    const { refs, remotes } = await this.listRefsCached(entry);
    return branchesPayload(refs, this.favorites(entry), this.memento.get<string[]>(this.recentKey(entry), []), remotes);
  }

  /**
   * `listRefs()` behind a short-TTL cache — the single priciest git call in a
   * state push. Serves cached refs within REFS_TTL_MS so a staging burst (or the
   * onDidChange firehose) doesn't re-list every branch each tick; branch
   * operations call {@link invalidateRefs} so real ref changes still show at
   * once. On error, falls back to the last-known refs for this repo. The
   * remotes' names ride along (the menu groups remote branches by remote),
   * read in parallel and cached the same.
   */
  private async listRefsCached(entry: RepoEntry): Promise<{ refs: GitRef[]; remotes: string[] }> {
    const now = Date.now();
    const cached = this.refsCache;
    if (
      cached &&
      cached.root === entry.root &&
      now - cached.at < CommitViewProvider.REFS_TTL_MS
    ) {
      return cached;
    }
    // Which invalidation era this read belongs to. A branch op calls
    // invalidateRefs() and then pushes state — but a listRefs() that was ALREADY
    // in flight when that happened resolves afterwards holding pre-mutation refs,
    // and writing those back re-caches them for most of the TTL. The invalidation
    // is then defeated and the branch you just created or deleted keeps showing
    // its old state for over a second. The firehose makes a push routinely
    // in-flight across a branch action, so this is not a narrow window.
    const era = this.refsEpoch;
    const known = cached && cached.root === entry.root ? cached : undefined;
    const [refs, remotes] = await Promise.all([
      entry.ctx.refs.listRefs().catch(() => known?.refs ?? []),
      entry.ctx.remotes.names().catch(() => known?.remotes ?? []),
    ]);
    const read = { root: entry.root, at: now, refs, remotes };
    if (era === this.refsEpoch) {
      this.refsCache = read;
    }
    return read;
  }

  /** Drop the cached ref list so the next push re-lists (post branch op). */
  private invalidateRefs(): void {
    this.refsCache = undefined;
    // Also disowns any listRefs() already in flight, so it cannot write its
    // pre-mutation answer back over this invalidation.
    this.refsEpoch++;
  }

  /** Run a branch-menu action against the active repo, then refresh state. */
  private async handleBranchAction(msg: FromWebview): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      return;
    }
    const ref = msg.ref ?? "";
    // Favorite is a pure UI toggle — no git op, just re-push so the star updates.
    if (msg.action === "favorite") {
      await this.toggleFavorite(entry, ref);
      await this.pushState();
      return;
    }
    // Copy is clipboard-only — no git op, no state refresh.
    if (msg.action === "copyName") {
      await vscode.env.clipboard.writeText(ref);
      notifyCopied(`“${ref}”`);
      return;
    }
    // `diverged` is how SyncOps.pull answers "both sides moved and nobody said
    // how to reconcile them" — a question to ask, not a failure to report —
    // and `stopped` how it answers "the merge or rebase stopped on conflicts",
    // an outcome that runPull has already told the user about.
    let result: { ok: boolean; stderr?: string } = { ok: true };
    // A pull can stop on conflicts. What git was doing BEFORE it ran, so a
    // failed pull that left git stopped — one the engine did not name as a
    // `stopped` (settled in runPull) — still reads as "paused for you" (with
    // the dashboard one click away), not as an error. The status bar's Pull
    // twin (statusBar/syncStatus.ts) decides it the same way.
    let before: DetectedOperation | undefined;
    /** The divergence question was asked and dismissed: nothing merged. */
    let cancelled = false;
    /** A pull stop or block that runPull has already told the user about. */
    let settled = false;
    try {
      // Checking out a branch is not an action here: the menu routes every
      // checkout through branchRefCommand (gitstudio.branch.checkout /
      // gitstudio.remoteBranch.checkout), which carries the confirm dialogs
      // and the Undo envelope. See handleBranchRefCommand.
      switch (msg.action) {
        // The name/revision comes from the view's own dialog (openRefPrompt),
        // not from vscode.window.showInputBox — the quick-input is a search bar
        // that dies on focus loss and cannot complete over our refs.
        case "new": {
          const name = (msg.ref ?? "").trim();
          if (!name) return;
          // A new branch AT HEAD: the working tree does not change, so no
          // uncommitted work can be in its way (its target is HEAD itself) —
          // but it is a switch, and `git checkout -b` over a stopped merge,
          // cherry-pick or revert ENDS it. Through the door, which refuses it
          // there as `git switch -c` does, and says so.
          const applied = await applyOrAsk(entry.ctx, newBranchAtHead(name));
          if (applied.settled) {
            settled = true;
          }
          result = { ok: applied.result.code === 0, stderr: applied.result.stderr };
          if (result.ok) await this.noteRecentBranch(entry, name);
          break;
        }
        case "checkoutRef": {
          const r = (msg.ref ?? "").trim();
          if (!r) return;
          // git would read it as one of its own options: "-f" after
          // --detach discards every uncommitted change.
          if (r.startsWith("-")) {
            result = { ok: false, stderr: `'${r}' is not a revision: it starts with '-'.` };
            break;
          }
          // Picked from the dialog's list — a branch, a remote branch, a tag —
          // it is checked out as that ref, by its full name: the short name
          // can be another ref's too by now (a tag made with a branch's name),
          // and git would take the branch. Typed, it goes as typed: a
          // revision git reads for itself (a sha, origin/main~3).
          let target = r;
          const picked = msg.refType;
          if (picked === "head" || picked === "remote" || picked === "tag") {
            const full = pickedRefName(await entry.ctx.refs.listRefs(), r, picked);
            if (!full) {
              const word = picked === "head" ? "branch" : picked === "remote" ? "remote branch" : "tag";
              result = { ok: false, stderr: `there is no ${word} '${r}' any more.` };
              break;
            }
            target = full;
          }
          // Through the shared door: uncommitted work in the checkout's way is
          // said, with Stash & Retry, rather than as git's refusal in red.
          const applied = await applyOrAsk(entry.ctx, checkoutOp(["checkout", "--detach", target]));
          if (applied.cancelled) {
            cancelled = true;
            break;
          }
          if (applied.settled) {
            settled = true;
          }
          result = { ok: applied.result.code === 0, stderr: applied.result.stderr };
          break;
        }
        case "pull":
        case "pullMerge":
        case "pullRebase": {
          before = await detectOperation(entry.ctx);
          const pulled = await this.runPull(entry, msg.action);
          if (pulled === undefined) {
            // Asked and dismissed. Nothing merged — but the first pull already
            // FETCHED, so fall through to the refresh below rather than
            // returning bare: the ↓ pill would otherwise keep spinning, and
            // then show the count from before the fetch.
            cancelled = true;
            break;
          }
          result = pulled.result;
          settled = pulled.settled;
          break;
        }
        case "push": {
          // Same rule as the push modal: a branch whose pushed commits WE
          // rewrote can only be pushed with the lease, so ask rather than fail.
          // Only then — a branch that diverged because somebody else pushed is
          // not a rewrite, and once their commits have been fetched the lease
          // no longer protects them (see SyncOps.rewroteUpstream). That push is
          // left to be refused, which loses nothing.
          //
          // And not when the tip it would replace was never on this branch —
          // the same commit amended on another machine, fetched in the
          // background, passes the rewrite test (same author, same author
          // date). The engine refuses that force before it runs; not offering
          // it leaves the plain push to be refused, as for any divergence.
          const ab = await entry.ctx.sync.aheadBehind();
          const force =
            ab.ahead > 0 &&
            ab.behind > 0 &&
            (await entry.ctx.sync.rewroteUpstream()) &&
            !(await entry.ctx.sync.upstreamUnseen())
              ? await this.askRewritePush()
              : false;
          if (force === undefined) {
            // Backing out must still tell the webview the op is over. A bare
            // return would skip the branchActionDone below and leave the ahead
            // pill disabled, spinning on a push that is never coming.
            void this.view?.webview.postMessage({
              type: "branchActionDone",
              action: msg.action,
            });
            return;
          }
          const pushed = await entry.ctx.sync.push(force ? { force: true } : undefined);
          // Refused before it ran: said, with Pull offered, and not as a
          // failure (the engine's check can still fire if a fetch landed
          // between the question above and the push).
          if (settlePushUnseen(pushed)) {
            settled = true;
          }
          result = pushed;
          break;
        }
        case "fetch":
          result = await entry.ctx.sync.fetch({ prune: pruneOnFetch() });
          break;
        case "pullFf":
          // Fast-forward a NON-checked-out local straight from its upstream;
          // the worktree is never touched (see SyncOps.pullFastForward).
          result = await entry.ctx.sync.pullFastForward(ref);
          break;
        default:
          return;
      }
    } catch (err) {
      result = { ok: false, stderr: err instanceof Error ? err.message : String(err) };
    }
    if (cancelled || settled) {
      // Nothing to report: a dismissed question ran nothing, and a stop (or a
      // pull blocked by the operation a stop left paused) was already said,
      // plainly and with its count, by settlePullStop.
    } else if (!result.ok && before && stoppedByThisCommand(before, await detectOperation(entry.ctx))) {
      notifyPaused("Pull hit conflicts. Resolve them, then continue or abort.");
    } else if (!result.ok) {
      // Named by what the user chose ("Pull into 'feature'"), not by the id.
      void vscode.window.showErrorMessage(
        `GitStudio: ${branchActionWords(msg.action, msg.ref)} failed${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
      );
    } else if (msg.action === "pullFf") {
      vscode.window.setStatusBarMessage(`Fast-forwarded ${ref}`, 2500);
    }
    // A branch action moved/created/deleted refs — refetch them on the next push.
    this.invalidateRefs();
    void entry.repo?.status?.();
    this.onCommitted();
    await this.pushState();
    // Tell the webview the op is over — it clears the pill/menu spinners (the
    // fresh counts arrived with the pushState above).
    void this.view?.webview.postMessage({
      type: "branchActionDone",
      action: msg.action,
    });
  }

  /**
   * The branch view's three pull items, as one operation. `undefined` means
   * a question was asked and dismissed — how to combine a divergence, or
   * Stash & Retry over uncommitted work in the way — and nothing merged.
   *
   * A stop on conflicts — or a pull blocked by the operation a stop left
   * paused — is settled HERE, by the shared settler; `settled` tells the caller
   * not to call it a failure as well.
   */
  private async runPull(
    entry: RepoEntry,
    action: string,
  ): Promise<{ result: PullResult; settled: boolean } | undefined> {
    // Every pull through the shared door (git/inTheWay.ts): refused over the
    // user's uncommitted work it asks Stash & Retry or Cancel, and `undefined`
    // is a Cancel there — nothing ran, as for the divergence question.
    let r: PullResult | undefined;
    if (action === "pullMerge") {
      // The menu item says "using Merge", so say it to git too. Leaving the
      // flag off walked this item into the divergent-branches wall — in the one
      // state where the user had already answered the question.
      r = await pullOrAsk(entry.ctx, "merge");
    } else if (action === "pullRebase") {
      r = await pullOrAsk(entry.ctx, "rebase");
    } else {
      // "Update (pull)" names no reconciliation, so SyncOps decides. It hands
      // back `diverged` rather than git's "you have divergent branches" advice
      // when both sides have moved and nothing in the user's config settles it
      // — and that is a question, so ask it.
      r = await pullOrAsk(entry.ctx);
      if (r?.diverged) {
        const mode = await askPullMode(r.diverged);
        if (mode === undefined) {
          return undefined;
        }
        r = await pullOrAsk(entry.ctx, mode);
      }
    }
    // A stop, a block, or a detached HEAD (no branch to pull into) — each said
    // plainly by its settler, so the caller must not call it a failure too.
    // (`undefined`: cancelled at the Stash & Retry question — nothing ran.)
    const settled = !!r && (settlePullStop(r) || settlePullDetached(r, () => this.openBranchMenu()));
    return r === undefined ? undefined : { result: r, settled };
  }

  /**
   * Run a JetBrains-style branch action from the branch menu's per-branch
   * submenu. These reuse the tested `gitstudio.branch.*` / `gitstudio.remoteBranch.*`
   * commands (which carry their own confirm dialogs + Undo envelope) by handing
   * them a synthetic `{ ref }` node, then refresh the commit view.
   */
  private async handleBranchRefCommand(msg: FromWebview): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry || !msg.command) {
      return;
    }
    const arg = {
      ref: { name: msg.ref ?? "", type: msg.refType ?? "head", sha: "" },
    };
    try {
      await vscode.commands.executeCommand(msg.command, arg);
      // Checkouts through the submenu feed the Recent group — previously only
      // the (rarely-hit) plain checkout action recorded recents, so the
      // Recent section starved even though the user switched branches daily.
      if (msg.command === "gitstudio.branch.checkout" && msg.ref) {
        await this.noteRecentBranch(entry, msg.ref);
      } else if (msg.command === "gitstudio.remoteBranch.checkout" && msg.ref) {
        const local = msg.ref.split("/").slice(1).join("/") || msg.ref;
        await this.noteRecentBranch(entry, local);
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `GitStudio: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // The submenu command may have moved refs (checkout/rename/delete/merge).
    this.invalidateRefs();
    void entry.repo?.status?.();
    this.onCommitted();
    await this.pushState();
  }

  // ── Push preview + confirm (every push goes through a review modal) ────────

  /**
   * Gather what a push would send: the unpushed commits and their aggregate
   * file changes, plus the target ref and ahead/behind. Returns `null` when
   * there's nothing to push. Works with OR without a configured upstream (an
   * unpublished branch previews everything not yet on any remote).
   */
  private async gatherPushData(entry: RepoEntry): Promise<{
    hasUpstream: boolean;
    target: string;
    branch: string;
    /** The ref the unpushed commits diverge FROM — the left side of file diffs. */
    base: string;
    canPush: boolean;
    reason?: string;
    ahead: number;
    behind: number;
    /**
     * The upstream is NOT an ancestor of HEAD, so a plain push cannot succeed —
     * the local tip rewrote history the remote already has. Amending a pushed
     * commit is the everyday way to get here.
     */
    needsForce: boolean;
    additions: number;
    deletions: number;
    commits: Array<{ sha: string; parents: string[]; subject: string; author: string; date: number; rel: string }>;
    files: CompareFile[];
  } | null> {
    const head = await entry.ctx.refs.getHead();
    // Named by the part under refs/heads/ — never git's "heads/release".
    const branch = head.detached ? head.sha.slice(0, 12) : (headBranchName(head) ?? "HEAD");
    const upstream = head.detached ? null : await entry.ctx.sync.currentUpstream();
    let remotes: Array<{ name: string }> = [];
    try {
      remotes = await entry.ctx.remotes.list();
    } catch {
      remotes = [];
    }

    // Resolve the FORK POINT the push diverges from — used as the left side of
    // both the aggregate file list AND each per-file diff, so they always agree
    // (even on a diverged branch). The commit list is gathered ONCE (the
    // no-upstream base can be the empty tree, invalid in a `base..HEAD` range).
    let base: string;
    let target: string;
    let commitRecords: Awaited<ReturnType<typeof collectCommits>>;
    if (upstream) {
      target = upstream;
      commitRecords = await collectCommits(entry, [`${upstream}..HEAD`]);
      // The merge-base is the true fork point (right for a diverged branch); a
      // plain 2-dot diff from it equals the 3-dot `upstream...HEAD`.
      const mb = await entry.ctx.process.run(["merge-base", upstream, "HEAD"]);
      base = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : upstream;
    } else {
      // No upstream — everything reachable from HEAD but not on any remote.
      commitRecords = await collectCommits(entry, ["HEAD", "--not", "--remotes"]);
      // No commits of our own is still a valid publish: the branch itself is
      // what gets created. Diff HEAD against itself so the file list is simply
      // empty rather than bailing out of the whole preview.
      const oldest = commitRecords[commitRecords.length - 1];
      base = commitRecords.length === 0
        ? "HEAD"
        : oldest.parents[0] ?? COMMIT_EMPTY_TREE;
      const pushRemote =
        remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
      target = head.detached
        ? "no branch (detached HEAD)"
        : pushRemote ? `${pushRemote}/${branch}` : branch;
    }
    // A tracked branch with nothing ahead really has nothing to preview.
    if (upstream && commitRecords.length === 0) {
      return null;
    }

    const [files, ab] = await Promise.all([
      // 2-dot from the fork point = exactly what the unpushed commits introduce.
      collectCompareFiles(entry, base, "HEAD", false),
      upstream ? entry.ctx.sync.aheadBehind() : Promise.resolve({ ahead: 0, behind: 0 }),
    ]);
    let additions = 0;
    let deletions = 0;
    for (const f of files) {
      if (f.additions > 0) additions += f.additions;
      if (f.deletions > 0) deletions += f.deletions;
    }
    // A detached HEAD (every stopped rebase is one) has no branch to push:
    // there is nothing on the remote side to update. It used to count as a
    // publish to "origin/<sha>" and fail only once Push was pressed, blaming a
    // missing remote.
    const canPush = head.detached ? false : upstream ? true : remotes.length > 0;
    // Diverged in BOTH directions means our tip is not a descendant of the
    // upstream, which is exactly when git refuses a fast-forward. Derived from
    // the ahead/behind we already have — no fetch, no network.
    //
    // But only a divergence WE caused (an amend, a rebase of pushed commits)
    // is settled by forcing. If somebody else pushed and we have fetched it,
    // the lease matches and a force push deletes their commits — so that case
    // stays a plain Push with "N behind — pull first". So does the same
    // commit amended on another machine and fetched in the background: it
    // passes the rewrite test, but the tip it would replace was never on this
    // branch, and the engine refuses that force (`upstreamUnseen`).
    const needsForce =
      !!upstream &&
      ab.ahead > 0 &&
      ab.behind > 0 &&
      (await entry.ctx.sync.rewroteUpstream()) &&
      !(await entry.ctx.sync.upstreamUnseen());
    return {
      hasUpstream: !!upstream,
      target,
      branch,
      base,
      canPush,
      reason: canPush
        ? undefined
        : head.detached
          ? detachedPushReason(await this.readOperation(entry))
          : NO_REMOTE_PUSH_REASON,
      ahead: upstream ? ab.ahead : commitRecords.length,
      behind: upstream ? ab.behind : 0,
      needsForce,
      additions,
      deletions,
      commits: commitRecords.map((c) => ({
        sha: c.sha,
        // The first is what the commit's own files are diffed against when
        // its row opens (the shared change rows).
        parents: c.parents,
        subject: c.subject || "(no message)",
        author: c.author,
        date: c.authorDate,
        // The age as every other GitStudio list says it ("3h", "2d"): the
        // review had its own formatter and said "3h ago" beside a rail
        // saying "3h" for the same commit.
        rel: relativeTime(c.authorDate),
      })),
      files,
    };
  }

  /**
   * The worktree the open push review is for, when it is not this window's
   * repository (the Worktrees view's Push…): every action the review takes —
   * Push, Undo commits…, New branch…, a file's diff — runs in THAT folder.
   * Undefined: the active repository.
   */
  private pushTarget: { entry: RepoEntry; name: string; shownPath: string; release(): void } | undefined;

  /**
   * The review now acts on `t`. The one it acted on before is NOT disposed
   * here: disposing a context kills its running git, and a push from the
   * previous review may still be running when another review opens. An idle
   * context holds nothing but itself; the last one is disposed with the view.
   */
  private setPushTarget(t: CommitViewProvider["pushTarget"]): void {
    this.pushTarget = t;
  }

  /** The repository the push review acts on. */
  private reviewEntry(): RepoEntry | undefined {
    return this.pushTarget?.entry ?? this.repos.getActive();
  }

  /**
   * Open the push review for a worktree — the Worktrees view's Push… — in
   * this view, where every push is reviewed. Its commits and files are that
   * worktree's, and the review says whose they are. Without a target: this
   * window's repository, as the view's own Push.
   */
  async openPushReview(target?: { entry: RepoEntry; name: string; shownPath: string; release(): void }): Promise<void> {
    await vscode.commands.executeCommand("gitstudio.commit.focus");
    for (let i = 0; i < 20 && !this.view; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await Promise.race([this.webviewReady ?? Promise.resolve(), new Promise<void>((r) => setTimeout(r, 3000))]);
    this.setPushTarget(target);
    await this.sendPushPreview();
  }

  /** Gather the preview and open the confirm-push modal in the webview. */
  private async sendPushPreview(): Promise<void> {
    const entry = this.reviewEntry();
    if (!entry) {
      return;
    }
    let data;
    try {
      data = await this.gatherPushData(entry);
    } catch (err) {
      void vscode.window.showErrorMessage(
        `GitStudio: couldn't prepare the push — ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return;
    }
    if (!data) {
      vscode.window.setStatusBarMessage(
        this.pushTarget
          ? `$(check) Nothing to push from ${this.pushTarget.name} — up to date`
          : "$(check) Nothing to push — up to date",
        2500,
      );
      // Clear any spinner the trigger may have started.
      void this.view?.webview.postMessage({ type: "pushDone", ok: true, nothing: true });
      return;
    }
    // Remember the diff base so a click on a file row can open its committed diff.
    this.lastPushBase = data.base;
    void this.view?.webview.postMessage({
      type: "pushPreview",
      ...data,
      ...(this.pushTarget ? { worktree: { name: this.pushTarget.name, shownPath: this.pushTarget.shownPath } } : {}),
    });
  }

  /** A commit in the push review opened: the files it changed, against its first parent. */
  private async sendPushCommitFiles(sha: string): Promise<void> {
    const entry = this.reviewEntry();
    if (!entry || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      return;
    }
    // null when git can't read the commit: getCommitFiles reads an unknown
    // sha as no files at all, and the review would say "No file changes".
    let files: CompareFile[] | null;
    try {
      const parents = await entry.ctx.process.run(["rev-list", "--parents", "-n", "1", sha]);
      files = parents.code === 0 ? await entry.ctx.commitDetails.getCommitFiles(sha, parents.stdout.trim().split(" ")[1]) : null;
    } catch {
      files = null;
    }
    void this.view?.webview.postMessage({ type: "pushCommitFiles", sha, files });
  }

  /** A file under a commit in the push review: what THAT commit did to it. */
  private async openPushCommitFile(msg: FromWebview): Promise<void> {
    const entry = this.reviewEntry();
    const sha = msg.sha ?? "";
    if (!entry || !msg.path || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) {
      return;
    }
    const parent = msg.parent && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(msg.parent) ? msg.parent : COMMIT_EMPTY_TREE;
    const sides = commitChangeSides({ sha, parent, path: msg.path, oldPath: msg.oldPath, status: msg.status });
    const name = msg.path.split("/").pop() ?? msg.path;
    await openSidesDiff(entry.root, msg.path, sides, `${name} (${sha.slice(0, 7)})`);
  }

  /** The base ref of the last push preview (left side of committed file diffs). */
  private lastPushBase = "";

  /**
   * Open the diff of one committed-but-unpushed file from the push modal — in
   * GitStudio's own Monaco diff panel (syntax-highlighted, branded), diffing the
   * fork-point version (lastPushBase) against HEAD, i.e. exactly what the commits
   * about to be pushed introduce.
   */
  private async openPushFileDiff(path: string, oldPath?: string): Promise<void> {
    // The review's worktree: its HEAD is the right side (revision URIs read
    // the root they name — see RevisionContentProvider).
    const entry = this.reviewEntry();
    if (!entry || !path) {
      return;
    }
    // Open the STANDARD VS Code diff — the familiar, readable one with a built-in
    // inline ⇄ side-by-side toggle and clear red/green add-delete. LEFT is the
    // fork-point ("before"), RIGHT is HEAD ("after"), so the title says which is
    // which; `preview` reuses a single tab instead of piling up editors.
    const base = this.lastPushBase || "HEAD~1";
    const left = toRevisionUri(entry.root, base, oldPath || path);
    const right = toRevisionUri(entry.root, "HEAD", path);
    const name = path.split("/").pop() ?? path;
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${name}  (before ${pushRefLabel(base)} ↔ after HEAD)`,
      { preview: true } satisfies vscode.TextDocumentShowOptions,
    );
  }

  /** Run the actual push (after the user confirms in the modal). */
  /**
   * `force` comes from the modal, which only offers it when the branch diverged
   * in both directions (see needsForce). It becomes `--force-with-lease`, never
   * a bare `--force`: the lease still refuses when the remote moved since our
   * last fetch, so a colleague's commits cannot be overwritten by this button.
   */
  /**
   * Ask before force-pushing a branch whose tip we rewrote. Returns undefined
   * when the user backs out, so the caller pushes nothing at all rather than
   * falling through to a push that cannot succeed.
   */
  private async askRewritePush(): Promise<boolean | undefined> {
    const choice = await promptPick({
      title: "This branch was rewritten",
      hint:
        "The remote still has the commits you replaced — amending a pushed " +
        "commit does this. A normal push will be refused.",
      choices: [
        {
          id: "force",
          label: "Force push",
          icon: "repo-force-push",
          danger: true,
          description:
            "Replaces only the versions you rewrote — nobody else's commits are on the remote branch.",
        },
        {
          id: "cancel",
          label: "Cancel",
          icon: "close",
          description: "Nothing is pushed.",
        },
      ],
    });
    return choice === "force" ? true : undefined;
  }

  private async confirmPush(force = false): Promise<void> {
    const entry = this.reviewEntry();
    if (!entry) {
      return;
    }
    let result: { ok: boolean; stderr: string; unseen?: true };
    try {
      const head = await entry.ctx.refs.getHead();
      const upstream = head.detached ? null : await entry.ctx.sync.currentUpstream();
      if (upstream) {
        result = await entry.ctx.sync.push(force ? { force: true } : undefined);
      } else {
        const remotes = await entry.ctx.remotes.list();
        const remote =
          remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name;
        // Published as refs/heads/<branch> (SyncOps) — the name under
        // refs/heads/, not "heads/release", which named nothing there.
        const branch = headBranchName(head);
        if (head.detached || !branch) {
          result = {
            ok: false,
            stderr: head.detached ? detachedPushReason(await this.readOperation(entry)) : DETACHED_PUSH_REASON,
          };
        } else if (!remote) {
          result = { ok: false, stderr: NO_REMOTE_PUSH_REASON };
        } else {
          // push-force-reviewed: publishes a branch the remote does not have
          // yet, so there is nothing to fast-forward over and nothing to force.
          result = await entry.ctx.sync.push({ setUpstream: true, remote, branch });
        }
      }
    } catch (err) {
      result = { ok: false, stderr: err instanceof Error ? err.message : String(err) };
    }
    if (result.ok) {
      vscode.window.setStatusBarMessage("$(check) Pushed", 3000);
    } else if (!settlePushUnseen(result)) {
      void vscode.window.showErrorMessage(failed("Push", result.stderr));
    }
    this.invalidateRefs();
    void entry.repo?.status?.();
    this.onCommitted();
    await this.pushState();
    void this.view?.webview.postMessage({
      type: "pushDone",
      ok: result.ok,
      // A refused force has no stderr — nothing ran — so the modal gets the
      // engine's sentence rather than an empty error line.
      error: result.ok ? undefined : result.unseen ? pushUnseenMessage() : result.stderr.trim(),
    });
  }

  /**
   * Discard the local (unpushed) commits, returning their contents to the
   * working tree as staged (`--soft`) or unstaged (`--mixed`) changes — so
   * nothing is lost, the commits are just "un-made".
   */
  private async discardLocalCommits(): Promise<void> {
    const entry = this.reviewEntry();
    if (!entry) {
      return;
    }
    // Resolve the ref to reset back to (the point just before the local commits).
    let base: string | undefined;
    let count = 0;
    try {
      const head = await entry.ctx.refs.getHead();
      const upstream = head.detached ? null : await entry.ctx.sync.currentUpstream();
      if (upstream) {
        count = (await entry.ctx.sync.aheadBehind()).ahead;
        // Reset to the FORK POINT (merge-base), not the upstream tip. On a
        // diverged branch the tip has commits we never pulled — resetting there
        // would silently adopt them and stage a bogus reversal diff. The
        // merge-base is exactly "the commit before my local commits", so a
        // soft/mixed reset drops only the ahead commits and keeps their content.
        const mb = await entry.ctx.process.run(["merge-base", upstream, "HEAD"]);
        base = mb.code === 0 && mb.stdout.trim() ? mb.stdout.trim() : undefined;
      } else {
        const unpushed = await collectCommits(entry, ["HEAD", "--not", "--remotes"]);
        count = unpushed.length;
        const oldest = unpushed[unpushed.length - 1];
        if (oldest && oldest.parents.length === 0) {
          void vscode.window.showWarningMessage(
            "GitStudio: can't undo the repository's initial commit this way.",
          );
          return;
        }
        base = oldest?.parents[0];
      }
    } catch (err) {
      void vscode.window.showErrorMessage(
        `GitStudio: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (!base || count === 0) {
      vscode.window.setStatusBarMessage("$(info) No local commits to undo", 2500);
      return;
    }

    const plural = count === 1 ? "commit" : "commits";
    const chosen = await promptPick({
      title: `Undo ${count} local ${plural}`,
      hint: "Where should the committed changes go? Your work is kept either way.",
      choices: [
        {
          id: "keep",
          label: "Keep Staged",
          icon: "check",
          description: "Their changes return to the Staged group, ready to re-commit.",
        },
        {
          id: "unstage",
          label: "Unstage",
          icon: "list-flat",
          description: "Their changes return as unstaged edits.",
        },
      ],
    });
    if (!chosen) {
      return;
    }
    const mode = { value: chosen === "keep" ? "--soft" : "--mixed" };
    const r = await entry.ctx.process.run(["reset", mode.value, base]);
    if (r.code !== 0) {
      void vscode.window.showErrorMessage(
        `GitStudio: undo failed${r.stderr ? ` — ${r.stderr.trim()}` : ""}`,
      );
    } else {
      vscode.window.setStatusBarMessage(
        `$(check) Undid ${count} local ${plural}`,
        3000,
      );
    }
    this.invalidateRefs();
    void entry.repo?.status?.();
    this.onCommitted();
    await this.pushState();
    void this.view?.webview.postMessage({
      type: "pushDone",
      ok: r.code === 0,
      discarded: r.code === 0,
      error: r.code === 0 ? undefined : r.stderr.trim(),
    });
  }

  /**
   * "New branch…" from the push modal: create a branch at the current commit
   * (carrying the unpushed commits) and switch to it — the "I want these on a
   * new branch instead of pushing here" escape hatch. Cancelling the name prompt
   * leaves the modal open; success closes it (the push target changed).
   */
  private async newBranchFromPush(nameFromView?: string): Promise<void> {
    const entry = this.reviewEntry();
    if (!entry) {
      return;
    }
    // Named by the modal's own dialog, not the quick-input.
    const name = (nameFromView ?? "").trim();
    if (!name) {
      return; // cancelled — keep the modal open
    }
    let result: { ok: boolean; stderr: string };
    try {
      // A new branch AT HEAD, through the door — nothing of the user's can
      // be in its way, but a stopped operation can, and `git checkout -b`
      // over it would end it (see the branch menu's "new" above).
      const applied = await applyOrAsk(entry.ctx, newBranchAtHead(name));
      if (applied.settled) {
        return; // said by the door; keep the modal open
      }
      result = { ok: applied.result.code === 0, stderr: applied.result.stderr };
    } catch (err) {
      result = { ok: false, stderr: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      void vscode.window.showErrorMessage(
        `GitStudio: couldn't create branch${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
      );
      return; // keep the modal open so the user can retry / cancel
    }
    vscode.window.setStatusBarMessage(`$(check) Created & switched to ${name.trim()}`, 3000);
    await this.noteRecentBranch(entry, name.trim());
    this.invalidateRefs();
    void entry.repo?.status?.();
    this.onCommitted();
    await this.pushState();
    // The branch (and thus the push target) changed — close the stale modal.
    void this.view?.webview.postMessage({ type: "pushDone", ok: true, nothing: true });
  }

  /**
   * Pushes the full state to the webview: branch, staged count, the merge /
   * staged / unstaged change lists, AI availability, and — when `amend` is
   * requested — the last commit's subject+body to prefill the message.
   *
   * Non-amend pushes are coalesced: while one is running, further pushes fold
   * into a single trailing re-push rather than piling up concurrently (the
   * onDidChange firehose can request many per second). Amend pushes are
   * user-initiated and always run immediately so the prefill isn't dropped.
   */
  private async pushState(amend = false): Promise<void> {
    if (amend) {
      await this.doPushState(true);
      return;
    }
    if (this.pushing) {
      this.pushQueued = true;
      return;
    }
    this.pushing = true;
    try {
      await this.doPushState(false);
      while (this.pushQueued) {
        this.pushQueued = false;
        await this.doPushState(false);
      }
    } finally {
      this.pushing = false;
    }
  }

  /**
   * The change lists + branch info from vscode.git's live cached state when
   * it's attached (instant, no spawn), else from our own git-service `git
   * status` (the eager window, before vscode.git activates). Shared by
   * doPushState AND the bulk stage/unstage/discard ops so they all work in
   * either state — the paths + status letters match across both sources.
   */
  private async resolveState(active: RepoEntry): Promise<{
    /** True when HEAD points at a revision rather than a branch. */
    detached?: boolean;
    merge: FileEntry[];
    staged: FileEntry[];
    unstaged: FileEntry[];
    branch?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
  }> {
    if (active.repo) {
      const state = active.repo.state;
      const toEntries = (changes: Change[] | undefined): FileEntry[] =>
        (changes ?? []).map((c) => ({
          path: relativePath(active.root, c.uri.fsPath),
          status: statusLetter(c.status),
        }));
      const head = state.HEAD;
      // `git.untrackedChanges: separate` moves untracked files out of
      // workingTreeChanges into a separate list (not in the pinned API type but
      // present at runtime). Fold it back in so untracked files show the same
      // as under the default 'mixed' (and as our eager parser shows them).
      const untracked =
        (state as { untrackedChanges?: Change[] }).untrackedChanges ?? [];
      return {
        merge: toEntries(state.mergeChanges),
        staged: toEntries(state.indexChanges),
        unstaged: [
          ...toEntries(state.workingTreeChanges),
          ...toEntries(untracked),
        ],
        // On a detached HEAD the built-in API gives no `name`, only a commit.
        // Show the revision rather than nothing — this fast path is the one
        // actually taken when vscode.git is available, so a fix applied only to
        // the git-CLI path below would never be seen.
        branch: head?.name ?? head?.commit?.slice(0, 7),
        detached: !head?.name,
        upstream: head?.upstream
          ? `${head.upstream.remote}/${head.upstream.name}`
          : undefined,
        ahead: head?.ahead,
        behind: head?.behind,
      };
    }
    const st = await active.ctx.status.read();
    // On a detached HEAD there is no branch name, but "(no branch)" tells the
    // user nothing about WHERE they are. Show the revision instead — after
    // checking out a tag or a sha that is the only identity the head has.
    let detachedSha: string | undefined;
    if (st.detached) {
      try {
        const head = await active.ctx.refs.getHead();
        detachedSha = head.sha.slice(0, 7);
      } catch {
        detachedSha = undefined;
      }
    }
    return {
      merge: st.merge,
      staged: st.staged,
      unstaged: st.unstaged,
      branch: st.detached ? detachedSha : st.branch,
      detached: st.detached,
      upstream: st.upstream,
      ahead: st.ahead,
      behind: st.behind,
    };
  }

  private async doPushState(amend: boolean): Promise<void> {
    if (!this.view) {
      return;
    }
    // Resolve the change lists + branch info from vscode.git's live cached state
    // when it's attached (instant), else from OUR OWN git-service `git status`
    // so the Changes view renders during the eager window (~30ms, not the
    // seconds vscode.git activation costs).
    const active = this.repos.getActive();
    let hasRepo = false;
    let merge: FileEntry[] = [];
    let staged: FileEntry[] = [];
    let unstaged: FileEntry[] = [];
    let branch: string | undefined;
    let upstream: string | undefined;
    let ahead: number | undefined;
    let behind: number | undefined;
    let detached: boolean | undefined;
    if (active) {
      try {
        ({ merge, staged, unstaged, branch, detached, upstream, ahead, behind } =
          await this.resolveState(active));
        hasRepo = true;
      } catch {
        hasRepo = false;
      }
    }

    this.lastMergePaths = active
      ? { root: active.root, paths: new Set(merge.map((e) => e.path)) }
      : undefined;
    const stagedCount = staged.length;
    const repoName = active ? repoNameOf(active.root) : undefined;
    const repoCount = this.repos.getAll().length;
    const repoPath = active && repoCount > 1 ? workspacePathOf(active.root) : undefined;
    const lastMessage =
      amend && active ? await this.lastMessage(active) : undefined;
    const signoffDefault = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("commit.signoffByDefault", false);
    const layout =
      this.memento.get<"tree" | "list">(LAYOUT_KEY) === "tree" ? "tree" : "list";

    // Everything above comes from vscode.git's IN-MEMORY cached state (the same
    // source the built-in SCM view reads) — no git spawn, no LM/keychain probe.
    // Post it FIRST so the file list paints instantly, carrying the last-known
    // AI/branch-menu values so nothing flickers.
    //
    // With an upstream the push count IS `ahead` — known now, the same answer
    // countUnpushed gives below; only a never-pushed branch waits for the
    // rev-list. Carried here so the common case has nothing left to correct.
    const sameRepo = this.lastBranchesRoot === active?.root;
    // The last list built, with each star as it is NOW: a star set since
    // (handleBranchAction's "favorite" re-pushes at once) would otherwise go
    // out unset, and move back the row the menu had already moved.
    let lastBranches = sameRepo ? this.lastBranches : undefined;
    if (active && lastBranches) {
      const starred = withFavorites(lastBranches, this.favorites(active));
      if (starred !== lastBranches) {
        this.lastBranches = lastBranches = starred;
        this.lastBranchesSig = JSON.stringify(starred);
      }
    }
    // The stash list as last read for this repository. Right after a stash
    // action it may be from before it: none is carried, and the page keeps
    // what it shows until the read below answers. Another repository's list
    // is never shown here — an empty one is, until this one's is read.
    const lastForHere = active && this.lastStashes?.root === active.root ? this.lastStashes : undefined;
    const knownStashes = lastForHere && !lastForHere.stale ? lastForHere : undefined;
    const firstStashes: StashRow[] | undefined = !hasRepo ? [] : lastForHere ? knownStashes?.rows : [];
    const sent: SlowState = {
      aiEnabled: this.lastAiEnabled,
      branchesSig: sameRepo ? this.lastBranchesSig : undefined,
      unpushed: upstream ? (ahead ?? 0) : undefined,
      canPublish: upstream ? true : undefined,
      stashesSig: knownStashes?.sig,
    };
    const base: StatePayload = {
      type: "state",
      hasRepo,
      discovering: !active && this.repos.isDiscovering(),
      merge,
      staged,
      unstaged,
      stagedCount,
      stagingModel: readStagingModel(),
      branch,
      detached,
      // Only when it belongs to the repo now on screen.
      branches: lastBranches,
      operation: sameRepo ? this.lastOperation : undefined,
      detachedReason: detached ? detachedPushReason(sameRepo ? this.lastOperation : undefined) : undefined,
      upstream,
      ahead,
      behind,
      unpushed: sent.unpushed,
      canPublish: sent.canPublish,
      repoName,
      repoCount,
      repoPath,
      lastMessage,
      signoffDefault,
      aiEnabled: sent.aiEnabled,
      aiOff: vscode.workspace.getConfiguration("gitstudio").get<string>("ai.provider") === "off",
      layout,
      busy: this.busy,
      stashes: firstStashes,
    };
    void this.view.webview.postMessage(base);
    this.updateBadge(staged, unstaged, behind);

    // THEN resolve the slower bits — the AI availability (cached; see
    // AiFeatures.isEnabledCached) and the branch-menu data (for-each-ref + stash
    // list) — in parallel, and re-post ONLY what they corrected. The client
    // dedups the (unchanged) file list, so a re-post only refreshes the ✨
    // button + branch menu without a re-render; but it is still the whole
    // payload crossing the webview boundary, and during a staging burst or the
    // onDidChange firehose the answer is the one already on screen.
    const [aiEnabled, listed, pushInfo, operation, stashRows] = await Promise.all([
      this.generator
        ? this.generator.isEnabled().catch(() => false)
        : Promise.resolve(false),
      active ? this.collectBranches(active) : Promise.resolve(undefined),
      active
        ? this.countUnpushed(active, upstream, ahead, !!detached)
        : Promise.resolve({ unpushed: 0, canPublish: false }),
      active ? this.readOperation(active) : Promise.resolve(undefined),
      active && hasRepo ? this.collectStashes(active) : Promise.resolve([] as StashRow[]),
    ]);
    // A star set while the rest was being read is on it too.
    const branches = listed && active ? withFavorites(listed, this.favorites(active)) : listed;
    const stashesSig = JSON.stringify(stashRows);
    const resolved: SlowState = {
      aiEnabled,
      branchesSig: branches ? JSON.stringify(branches) : undefined,
      unpushed: pushInfo.unpushed,
      canPublish: pushInfo.canPublish,
      stashesSig,
    };
    this.lastStashes = active ? { root: active.root, rows: stashRows, sig: stashesSig } : undefined;
    this.lastAiEnabled = aiEnabled;
    this.lastBranches = branches;
    this.lastBranchesSig = resolved.branchesSig;
    this.lastBranchesRoot = active?.root;
    this.lastOperation = operation;
    const operationChanged = JSON.stringify(operation) !== JSON.stringify(base.operation);
    if (!this.view || (!slowStateChanged(sent, resolved) && !operationChanged)) {
      return;
    }
    void this.view.webview.postMessage({
      ...base,
      aiEnabled,
      branches,
      unpushed: pushInfo.unpushed,
      canPublish: pushInfo.canPublish,
      operation,
      detachedReason: base.detached ? detachedPushReason(operation) : undefined,
      stashes: stashRows,
    });
  }

  /**
   * Commits a push would send, correct even for a branch that has never been
   * pushed. With an upstream, `ahead` already carries it. Without one, count the
   * commits reachable from HEAD but not on ANY remote (the exact set
   * gatherPushData/confirmPush publish) and report whether a remote exists.
   */
  private async countUnpushed(
    entry: RepoEntry,
    upstream: string | undefined,
    ahead: number | undefined,
    detached = false,
  ): Promise<{ unpushed: number; canPublish: boolean }> {
    if (upstream) {
      return { unpushed: ahead ?? 0, canPublish: true };
    }
    if (detached) {
      // Commits on a detached HEAD belong to no branch: there is nothing to
      // publish them AS until a branch is made.
      return { unpushed: 0, canPublish: false };
    }
    try {
      const commits = await collectCommits(entry, ["HEAD", "--not", "--remotes"]);
      let hasRemote = false;
      try {
        hasRemote = (await entry.ctx.remotes.list()).length > 0;
      } catch {
        hasRemote = false;
      }
      // An unpublished branch is publishable whenever a remote exists — having
      // commits of its own is NOT a precondition. Creating an empty branch on
      // the remote is a normal thing to want (open a PR, share the name, park
      // work), and conflating the two disabled the button entirely for a branch
      // with nothing ahead, so pushing appeared to do nothing at all.
      return { unpushed: commits.length, canPublish: hasRemote };
    } catch {
      return { unpushed: ahead ?? 0, canPublish: false };
    }
  }

  /** The HEAD commit's full message (subject + body) for amend prefill. */
  private async lastMessage(entry: RepoEntry): Promise<string | undefined> {
    try {
      for await (const commit of entry.ctx.log.streamCommits({ maxCount: 1 })) {
        const body = commit.body.trim();
        return body ? `${commit.subject}\n\n${body}` : commit.subject;
      }
    } catch {
      // No commits yet.
    }
    return undefined;
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const codiconUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css"),
    );
    const changeRowsUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "change-rows.js"),
    );
    const csp = [
      `default-src 'none'`,
      // cspSource: the codicon stylesheet; nonce: our own inline <style>.
      `style-src 'nonce-${nonce}' ${webview.cspSource}`,
      // cspSource: the codicon.ttf the stylesheet @font-face references.
      `font-src ${webview.cspSource}`,
      // nonce: our inline script and change-rows.js (the push review's rows).
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join("; ");

    // String.raw so the inline script's regex backslashes (\s, \[, \{, \\) survive
    // verbatim instead of being processed as template-literal escapes. ${...}
    // interpolation still works.
    //
    // Without it \s cooked to a bare s, so the ref-name validator rejected every
    // name containing the letter "s" as "cannot contain spaces" — you could not
    // create or rename a branch called "styles" — while the ref-character check
    // next to it silently degraded into a regex that let genuinely illegal names
    // through. Same reason aiCommands.ts and comparePanel.ts are raw.
    //
    // The tag is what makes the single-backslash regexes below correct. Doubling
    // them instead (\\s) fixes the five \s sites but not the \[ and \\ on the
    // very next lines, and would mean backslash-then-s under this tag.
    return String.raw`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconUri}" rel="stylesheet" />
  <style nonce="${nonce}">${tokensCss}</style>
  <style nonce="${nonce}">${changeRowsCss}</style>
  <style nonce="${nonce}">
    /* Surface-specific styling only. The --gs-* token scale and the .gs-*
       utility classes come from the shared tokens.css injected above — this
       view no longer forks its own token block. */
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 8px 10px 12px;
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.4;
      background: var(--gs-bg);
      /* The sidebar never scrolls sideways — clip any incidental overflow so a
         long branch name or path can't widen the whole view. */
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }

    /* ---- Codicons (the real VS Code icon font) ------------------------- */
    .codicon { font-size: 16px; line-height: 1; color: inherit; display: inline-block; }
    .branch .codicon,
    .sync-pill .codicon,
    .sync-clean .codicon { font-size: 13px; }
    .sparkle .codicon { font-size: 15px; }
    .gs-commit .codicon { font-size: 14px; }
    .twisty .codicon { font-size: 14px; }
    .file-icon .codicon { font-size: 15px; }
    .empty-state .badge .codicon { font-size: 20px; }
    .codicon-modifier-spin { animation: codicon-spin 1s steps(12) infinite; }
    @keyframes codicon-spin { 100% { transform: rotate(360deg); } }

    /* ---- Branch / repo context header --------------------------------- */
    .repo-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 0 2px 8px;
      min-height: 22px;
    }
    /* The branch is a button: click opens the branch + actions menu (JetBrains-
       style). It folds in everything the old Branches view did. */
    /* A detached HEAD is a revision, not a branch: monospace it so it reads as
       a sha, and tint it amber so the difference is visible at a glance rather
       than only in the tooltip. Previously this said "(no branch)", which named
       the one thing it is not. */
    .branch.is-detached #branch-name {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--gs-amber, var(--vscode-gitDecoration-modifiedResourceForeground));
    }
    .branch {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 0;
      max-width: 100%;
      flex: 0 1 auto;
      height: 22px;
      padding: 0 6px 0 8px;
      border-radius: var(--gs-radius-pill);
      background: color-mix(in srgb, var(--gs-brand) 15%, transparent);
      border: 1px solid color-mix(in srgb, var(--gs-brand) 40%, transparent);
      color: var(--gs-brand);
      font-family: var(--gs-font-ui);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background var(--gs-motion-fast) var(--gs-ease),
                  border-color var(--gs-motion-fast) var(--gs-ease);
    }
    .branch:hover {
      background: color-mix(in srgb, var(--gs-brand) 24%, transparent);
      border-color: color-mix(in srgb, var(--gs-brand) 58%, transparent);
    }
    .branch:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .branch svg { width: 13px; height: 13px; flex: 0 0 auto; opacity: 0.95; }
    .branch .branch-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: 0.005em;
    }
    .branch .branch-caret { font-size: 12px; opacity: 0.8; margin-left: -1px; }
    /* Open: lit, the pill's own edge unchanged. Recolouring that edge in the
       accent drew a ring around the open state, a line by the owner's rule;
       it glows softly instead. */
    .branch[aria-expanded="true"] {
      background: color-mix(in srgb, var(--gs-accent) 22%, transparent);
      box-shadow: var(--gs-sel-glow-soft);
    }
    /* The repository, when the workspace holds more than one (issue #32): the
       branch pill's shape and type, in the neutral foreground so the branch
       stays the brand-coloured thing in the row. Click opens Switch
       Repository. On a narrow sidebar it gives way FIRST — the huge shrink
       factor folds its name away before the branch loses a letter (the
       tooltip still says which repository it is). Its min-width is what is
       left then — padding, icon, the two gaps, caret, border — so the control
       itself never folds. */
    .repo {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-width: 49px;
      max-width: 42%;
      flex: 0 1000 auto;
      height: 22px;
      padding: 0 6px 0 7px;
      border-radius: var(--gs-radius-pill);
      background: color-mix(in srgb, var(--gs-fg) 7%, transparent);
      border: 1px solid color-mix(in srgb, var(--gs-fg) 18%, transparent);
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background var(--gs-motion-fast) var(--gs-ease),
                  border-color var(--gs-motion-fast) var(--gs-ease);
    }
    .repo[hidden] { display: none; }
    .repo:hover {
      background: color-mix(in srgb, var(--gs-fg) 13%, transparent);
      border-color: color-mix(in srgb, var(--gs-fg) 30%, transparent);
    }
    .repo:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .repo .codicon { font-size: 13px; flex: 0 0 auto; }
    .repo .codicon-repo { color: var(--gs-fg-muted); }
    .repo .repo-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      letter-spacing: 0.005em;
    }
    .repo .repo-caret { font-size: 12px; opacity: 0.8; margin-left: -1px; }
    /* Folded by fitRepoPill(): the branch name was being clipped, so the
       repository's name goes completely — never a sliver of it. The pill keeps
       its icon and caret, at their own width. */
    .repo.folded { min-width: 0; flex-shrink: 0; }
    .repo.folded .repo-name { display: none; }
    .sync { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; flex: 0 0 auto; }
    .sync.hidden { display: none; }
    /* The sync pills are real buttons: ↓ Pull N runs the pull (↑ Push N the
       push) with a live spinner in place — not just indicators. */
    .sync-pill {
      display: none;
      align-items: center;
      gap: 3px;
      height: 19px;
      margin: 0;
      border: 0;
      padding: 0 7px 0 5px;
      border-radius: var(--gs-radius-pill);
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--gs-fg-muted);
      background: color-mix(in srgb, var(--gs-fg) 9%, transparent);
      white-space: nowrap;
      cursor: pointer;
      transition: background var(--gs-motion-fast) var(--gs-ease);
    }
    .sync-pill.visible { display: inline-flex; }
    .sync-pill svg { width: 11px; height: 11px; }
    .sync-pill.ahead.visible { color: var(--gs-status-added); background: color-mix(in srgb, var(--gs-status-added) 14%, transparent); }
    .sync-pill.behind.visible { color: var(--gs-status-modified); background: color-mix(in srgb, var(--gs-status-modified) 16%, transparent); }
    .sync-pill.ahead.visible:hover:not(:disabled) { background: color-mix(in srgb, var(--gs-status-added) 26%, transparent); }
    .sync-pill.behind.visible:hover:not(:disabled) { background: color-mix(in srgb, var(--gs-status-modified) 28%, transparent); }
    .sync-pill:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .sync-pill:disabled { cursor: default; opacity: 0.85; }
    .sync-clean {
      display: none;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--gs-fg-subtle);
    }
    .sync-clean.visible { display: inline-flex; }
    .sync-clean svg { width: 12px; height: 12px; }
    /* Short of room for the branch's name, the pills keep their arrow and
       count and let the verb go ("up to date" keeps its tick): the name and
       tip of each still say Push or Pull. */
    .sync.compact .sync-verb,
    .sync.compact .sync-clean span { display: none; }
    .sync.compact .sync-pill { padding: 0 6px 0 4px; }

    /* ---- Branch + actions menu (popover; folds in the Branches view) ---- */
    .branch-menu {
      position: fixed;
      z-index: 50;
      min-width: min(248px, calc(100vw - 12px));
      /* Grow with the sidebar so a wider panel reveals more of long ref names
         (bounded so it never sprawls). The tooltip covers whatever still clips. */
      max-width: min(460px, calc(100vw - 12px));
      /* placeBranchMenu sets the real limit: all the room below the pill. */
      max-height: calc(100vh - 12px);
      display: flex;
      flex-direction: column;
      background: var(--vscode-menu-background, var(--gs-surface));
      border: 1px solid var(--vscode-menu-border, var(--gs-border));
      border-radius: var(--gs-radius);
      box-shadow: var(--gs-shadow-2);
      overflow: hidden;
    }
    .bm-search { padding: 7px 7px 5px; }
    .bm-search input {
      width: 100%;
      height: 26px;
      padding: 0 8px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background, var(--gs-surface));
      border: 1px solid var(--gs-border);
      border-radius: var(--gs-radius-sm);
      font-family: var(--gs-font-ui);
      font-size: 12px;
      outline: none;
    }
    .bm-search input:focus { border-color: var(--gs-accent); box-shadow: var(--gs-glow); }
    /* A row brought into view from below stops under its group's heading,
       which stays pinned at the top while its rows scroll (below). */
    .bm-list { overflow-y: auto; padding: 0 3px 3px; scroll-padding-top: 26px; }
    .bm-list > .bm-action:first-child { margin-top: 3px; }
    .bm-action, .bm-branch {
      display: flex;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 5px 8px;
      border: none;
      background: transparent;
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: 12.5px;
      text-align: left;
      border-radius: var(--gs-radius-sm);
      cursor: pointer;
    }
    .bm-action .codicon, .bm-bicon { font-size: 14px; color: var(--gs-fg-muted); flex: 0 0 auto; }
    /* No hover colour of its own: the pointer MOVES the highlight (the
       list's mousemove), so a row under the pointer is the lit row, and
       there is never a second, differently lit one (see .is-active). */
    /* A collapsible category header: chevron + label + count, full-width
       button. It stays pinned at the top of the list while its group's rows
       scroll under it — the next group's heading pushes it off, because each
       heading sticks only inside its own group (.bm-group). Opaque, or the
       rows would show through it. */
    .bm-group { position: relative; }
    .bm-sep {
      position: sticky;
      top: 0;
      z-index: 1;
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      height: 26px;
      margin: 0;
      padding: 7px 8px 3px;
      border: none;
      background: var(--vscode-menu-background, var(--gs-surface));
      font-size: 10px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--gs-fg-muted);
      cursor: pointer;
      text-align: left;
    }
    .bm-sep:hover { color: var(--gs-fg); }
    .bm-sep .codicon { font-size: 13px; transition: transform 120ms var(--gs-ease); }
    .bm-sep.collapsed .codicon { transform: rotate(-90deg); }
    .bm-sep-label { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* A remote's own name, as git spells it, beside the word Remote. */
    .bm-sep-remote { margin-left: 5px; text-transform: none; letter-spacing: 0; font-size: 11px; color: var(--gs-fg); }
    .bm-sep-count {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
      color: var(--gs-fg-muted);
    }
    /* The letters a search matched, the way VS Code's lists mark them — in
       the list's match colour and bolder — on a faint band of that colour,
       so they still show on the current branch, whose whole name is bold. */
    .bm-hl {
      background: color-mix(in srgb, var(--vscode-list-highlightForeground, var(--gs-accent)) 16%, transparent);
      color: var(--vscode-list-highlightForeground, var(--gs-accent-text));
      font-weight: 600;
      border-radius: 2px;
    }
    .bm-branch { padding: 4px 8px 4px 4px; }
    .bm-branch.is-current .bm-bname { color: var(--gs-accent-text); font-weight: 600; }
    .bm-branch.is-current .bm-bicon { color: var(--gs-accent-text); }
    /* The name is the row. It takes no share of spare room (its auto right
       margin does, which keeps the counts and the upstream at the right
       edge), and it is the only thing on the row that shrinks when the row is
       too narrow: the upstream gives way before it (below), and the counts
       before it falls under 45% of the row (fitBranchRows). */
    .bm-bname { flex: 0 1 auto; min-width: 0; margin-right: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Per-branch unpushed/unpulled badges — refreshed live by the in-menu Fetch. */
    .bm-ab {
      flex: 0 0 auto;
      font-size: 10px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      padding: 0 5px;
      border-radius: 999px;
      line-height: 15px;
    }
    .bm-ab.up { color: var(--gs-status-added); background: color-mix(in srgb, var(--gs-status-added) 14%, transparent); }
    .bm-ab.down { color: var(--gs-status-modified); background: color-mix(in srgb, var(--gs-status-modified) 16%, transparent); }
    /* A row too narrow for its name and its counts: the counts go, whole. */
    .bm-branch.is-cramped .bm-ab { display: none; }
    /* On the highlighted row the counts take the selection's colour, as the
       rest of the row does: green or blue on the selection's blue is lost. */
    .bm-branch.is-active .bm-ab {
      color: inherit;
      background: color-mix(in srgb, currentColor 20%, transparent);
    }
    /* Light+'s ink on its own band over the tint read 3.87:1: deepened, as
       a search's letters are on the lit row. */
    body.vscode-light .bm-branch.is-active .bm-ab {
      color: color-mix(in srgb, var(--gs-fg) 60%, #000000);
    }
    /* In-flight items keep the normal cursor — the spinner lives IN the item. */
    .bm-action.is-busy, .bm-subaction.is-busy { opacity: 0.8; cursor: default; }
    /* The upstream starts from nothing and grows into the room the name left,
       up to its own width: it is cut, or gone, before the name loses a letter
       (the row's tooltip and its spoken label still carry it). */
    .bm-bup { flex: 1 1 0; min-width: 0; max-width: max-content; font-size: 10.5px; color: var(--gs-fg-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* An upstream deleted from its remote: struck through, and a word that
       stays when the row is too narrow for the name beside it. */
    .bm-bup.is-gone { text-decoration: line-through; }
    .bm-gone { flex: 0 0 auto; font-size: 10.5px; color: var(--gs-fg-muted); }
    /* Every branch row opens a list of its actions, and says so the way a
       menu does: a chevron at its end, always there, in the secondary
       colour — the room it takes is the hint. */
    .bm-bmore { flex: 0 0 auto; font-size: 13px; color: var(--gs-fg-muted); }

    /* The highlight: the one row the arrow keys or the pointer have reached
       (the pointer moves it), and in a row's own menu the item that has the
       keyboard (which the pointer moves too). ONE look for both: a tint of
       the accent, rounded, and the words and icon at the menu's full ink —
       no outline, and no second colour for a hover. It used to be VS Code's
       selection blue with the focus outline around it; under the pointer a
       submenu item took the hover's grey instead but kept the selection's
       white words, which read faded, inside a blue ring. Declared on body,
       where the theme's class is: --gs-danger is the light theme's deeper
       red there, and a custom property resolves where it is declared. */
    body {
      --bm-lit: color-mix(in srgb, var(--gs-accent) 26%, transparent);
      --bm-lit-soft: color-mix(in srgb, var(--gs-accent) 13%, transparent);
      --bm-lit-danger: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 14%, transparent);
      --bm-danger-ink: var(--gs-danger, var(--vscode-errorForeground, #e15a5a));
    }
    body.vscode-light {
      --bm-lit: color-mix(in srgb, var(--gs-accent) 18%, transparent);
      --bm-lit-soft: color-mix(in srgb, var(--gs-accent) 9%, transparent);
    }
    .bm-action.is-active,
    .bm-branch.is-active,
    .bm-more.is-active,
    .bm-subaction.is-active,
    .action-menu .bm-subaction:focus {
      background: var(--bm-lit);
      color: var(--gs-fg);
      outline: none;
    }
    .bm-action.is-active .codicon,
    .bm-branch.is-active .bm-bicon,
    .bm-branch.is-active.is-current .bm-bname,
    .bm-branch.is-active .bm-bup,
    .bm-branch.is-active .bm-gone,
    .bm-subaction.is-active .codicon,
    .action-menu .bm-subaction:focus .codicon { color: inherit; }
    .bm-branch.is-active .bm-bmore { color: inherit; }
    .bm-branch.is-active .bm-star:not(.on) { color: inherit; }
    /* A search's letters on the lit row: the row's own ink, bold, on a band
       of the match colour — the match colour itself read 3–4:1 on the tint. */
    .bm-action.is-active .bm-hl,
    .bm-branch.is-active .bm-hl {
      color: inherit;
      background: color-mix(in srgb, var(--vscode-list-highlightForeground, var(--gs-accent)) 26%, transparent);
    }
    /* Light+'s ink (#616161) is too pale for a band on a tint: deepened. */
    body.vscode-light .bm-action.is-active .bm-hl,
    body.vscode-light .bm-branch.is-active .bm-hl {
      color: color-mix(in srgb, var(--gs-fg) 60%, #000000);
      background: color-mix(in srgb, var(--vscode-list-highlightForeground, var(--gs-accent)) 20%, transparent);
    }
    /* The row whose submenu holds the highlight stays lit, more softly. */
    .bm-branch.is-open { background: var(--bm-lit-soft); }
    /* Its words read on that tint (AA): the quiet ones take full ink, and
       the coloured ones (the current branch, a search's letters, the
       counts) lean away from the ground. In their own colours they read
       2.7 to 4.4:1 on it. */
    .bm-branch.is-open .bm-bmore,
    .bm-branch.is-open .bm-bicon,
    .bm-branch.is-open .bm-bup,
    .bm-branch.is-open .bm-gone { color: var(--gs-fg); }
    .bm-branch.is-open.is-current .bm-bname,
    .bm-branch.is-open.is-current .bm-bicon { color: var(--gs-sel-ink); }
    .bm-branch.is-open .bm-hl {
      color: color-mix(in srgb, var(--vscode-list-highlightForeground, var(--gs-accent)) 58%, var(--gs-sel-lift));
    }
    .bm-branch.is-open .bm-ab.up { color: color-mix(in srgb, var(--gs-status-added) 55%, var(--gs-sel-lift)); }
    .bm-branch.is-open .bm-ab.down { color: color-mix(in srgb, var(--gs-status-modified) 55%, var(--gs-sel-lift)); }
    /* A destructive item keeps its colour when highlighted: red on a red tint. */
    .bm-subaction.danger.is-active,
    .action-menu .bm-subaction.danger:focus {
      background: var(--bm-lit-danger);
      color: var(--bm-danger-ink);
    }
    .bm-subaction.danger.is-active .codicon,
    .action-menu .bm-subaction.danger:focus .codicon { color: inherit; }
    /* The high-contrast themes paint a selection with no fill of its own but
       VS Code's contrast border, drawn whole: there, and only there, the
       highlight keeps that ring (dashed for the row whose submenu is open). */
    body.vscode-high-contrast .bm-action.is-active,
    body.vscode-high-contrast .bm-branch.is-active,
    body.vscode-high-contrast .bm-more.is-active,
    body.vscode-high-contrast .bm-subaction.is-active,
    body.vscode-high-contrast .action-menu .bm-subaction:focus {
      outline: 1px solid var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: -1px;
    }
    body.vscode-high-contrast .bm-branch.is-open {
      outline: 1px dashed var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: -1px;
    }

    /* Per-branch action submenu (flyout). */
    /* The scrim behind the branch dialog stack: dims the view so the open
       dialog is unmistakable (the layers otherwise read as one flat surface). */
    .bm-backdrop {
      position: fixed;
      inset: 0;
      z-index: 45;
      background: rgba(0, 0, 0, 0.32);
    }
    body.vscode-light .bm-backdrop,
    body.vscode-high-contrast-light .bm-backdrop { background: rgba(0, 0, 0, 0.16); }
    /* The per-branch submenu is a CHILD dialog — brand-tinted surface and a
       branded title band, so it never reads as "the same window again". */
    /* Never wider or taller than the view, however narrow or short the
       sidebar: past that its items scroll (the file rows' action menu is this
       same popup). */
    .branch-submenu {
      position: fixed;
      z-index: 60;
      min-width: min(210px, calc(100vw - 12px));
      max-width: min(320px, calc(100vw - 12px));
      max-height: calc(100vh - 12px);
      display: flex;
      flex-direction: column;
      padding: 4px;
      background: color-mix(in srgb, var(--gs-brand) 6%, var(--vscode-menu-background, var(--gs-surface)));
      border: 1px solid color-mix(in srgb, var(--gs-brand) 42%, var(--vscode-menu-border, var(--gs-border)));
      border-radius: var(--gs-radius);
      box-shadow: var(--gs-shadow-2);
    }
    .bm-subhead {
      display: flex; align-items: center; gap: 7px;
      margin: -4px -4px 3px;
      padding: 7px 10px 8px;
      border-radius: calc(var(--gs-radius) - 1px) calc(var(--gs-radius) - 1px) 0 0;
      background: color-mix(in srgb, var(--gs-brand) 15%, transparent);
      border-bottom: 1px solid color-mix(in srgb, var(--gs-brand) 32%, transparent);
      color: var(--gs-fg-muted);
    }
    .bm-subhead .codicon { font-size: 13px; }
    .bm-subhead-name { font-size: 12px; font-weight: 600; color: var(--gs-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-sublist { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; overflow-y: auto; }
    /* The list scrolls, so it clips: a focus ring drawn outside an item
       would lose three sides. Drawn just inside, it keeps all four. */
    .bm-subaction:focus-visible { outline-offset: -1px; }
    /* In a row's own menu the focused item IS the highlight (lit, above):
       no ring on top of it, but in high contrast. */
    body:not(.vscode-high-contrast) .action-menu .bm-subaction:focus-visible { outline: none; }
    .bm-subaction {
      display: flex; align-items: center; gap: 9px;
      width: 100%;
      padding: 6px 8px;
      border: none;
      background: transparent;
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: 12.5px;
      text-align: left;
      border-radius: var(--gs-radius-sm);
      cursor: pointer;
    }
    .bm-subaction .codicon { font-size: 14px; color: var(--gs-fg-muted); flex: 0 0 auto; }
    .bm-subaction span { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* No :hover colour: the pointer moves the highlight here too. */
    .bm-subaction.danger { color: var(--bm-danger-ink); }
    .bm-subaction.danger .codicon { color: var(--bm-danger-ink); }
    .bm-subsep { height: 1px; margin: 4px 6px; background: var(--gs-border); }
    /* Drilled in: a sidebar with no room beside the menu for a branch's
       actions shows them IN the menu, in place of the list, under a back row
       that names the branch ('‹ feature'). The search box stays; typing, the
       back row, Left and Escape all return to the list. */
    .branch-menu.is-drilled > .bm-list { display: none; }
    .branch-submenu.is-drilled {
      position: static;
      z-index: auto;
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      max-width: none;
      max-height: none;
      padding: 0 3px 3px;
      background: transparent;
      border: none;
      border-top: 1px solid var(--vscode-menu-separatorBackground, var(--gs-border));
      border-radius: 0;
      box-shadow: none;
    }
    /* The back row is a row of the menu: the pointer lights it as it
       lights any row — the same tint, and the item below goes dark — with
       no hover colour of its own and no rule under it. */
    .branch-submenu.is-drilled .bm-subhead {
      margin: 0 -3px 3px;
      padding: 6px 10px 6px 6px;
      border-radius: 0;
      border-bottom: none;
      cursor: pointer;
    }
    .branch-submenu.is-drilled .bm-subhead.is-active { background: var(--bm-lit); }
    body.vscode-high-contrast .branch-submenu.is-drilled .bm-subhead.is-active {
      outline: 1px solid var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: -1px;
    }
    .bm-subhead .bm-back { font-size: 14px; color: var(--gs-fg); }
    /* Words for a screen reader only: in the page, not on screen. */
    .bm-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
    /* A set star is always shown. An empty one is a control that only the
       row under the pointer or the highlight offers — a column of 200 hollow
       stars read as 200 things to do — drawn then at a control's contrast
       (3:1), in the muted text colour. Its room is kept either way, so the
       names stay in one column. */
    .bm-star, .bm-star-spacer {
      flex: 0 0 auto;
      width: 22px; height: 22px;
      display: inline-flex; align-items: center; justify-content: center;
      border: none; background: transparent; border-radius: var(--gs-radius-sm);
      color: var(--gs-fg-muted); cursor: pointer; padding: 0;
    }
    .bm-star:not(.on) { visibility: hidden; }
    .bm-branch:hover .bm-star, .bm-branch.is-active .bm-star { visibility: visible; }
    .bm-star:hover { background: color-mix(in srgb, var(--gs-fg) 10%, transparent); color: var(--gs-fg); }
    .bm-star.on { color: var(--vscode-charts-yellow, #d7ba00); }
    .bm-star .codicon { font-size: 13px; }
    .bm-empty { padding: 10px 8px; color: var(--gs-fg-muted); font-size: 12px; text-align: center; }
    /* A line that says why an action is missing (Pull and Push on a detached
       HEAD). Not a row the arrows visit: it is read out with the search box. */
    .bm-why {
      display: flex; align-items: flex-start; gap: 8px;
      padding: 5px 8px; font-size: 12px; line-height: 16px;
      color: var(--gs-fg-muted);
    }
    .bm-why .codicon { font-size: 14px; flex: 0 0 auto; line-height: 16px; }
    /* An action's label, which a long query can make longer than the row. */
    .bm-action > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-loading { display: flex; align-items: center; justify-content: center; gap: 6px; }
    .bm-loading .codicon { font-size: 13px; }
    .bm-note { padding: 4px 8px 6px 34px; color: var(--gs-fg-subtle); font-size: 11px; font-style: italic; }
    /* ── GitStudio dialogs (rp-*) ─────────────────────────────────────────
       Every question GitStudio asks renders here — naming a branch, choosing a
       reset mode, confirming a delete — whether it was raised by this webview
       or by host-side command code (see ui/dialogs.ts). Replaces the quick
       input, which is a floating search bar that vanishes on alt-tab taking
       whatever you typed with it and cannot complete over the refs we already
       hold, and the modal message box, which is OS chrome unrelated to the
       surface you clicked in. This lives in the view, so focus loss cannot
       destroy it, and it completes as you type. */
    /* Above the push modal (120/121). The prompt can be opened FROM that modal
       ("New branch from these commits"), and at z-index 60 it rendered behind
       the modal's backdrop — invisible, while still holding keyboard focus. */
    .rp-backdrop {
      position: fixed; inset: 0; z-index: 129;
      background: var(--gs-scrim, rgba(0, 0, 0, 0.45));
    }
    .rp-panel {
      position: fixed; z-index: 130; left: 50%; top: 12%;
      transform: translateX(-50%);
      width: min(460px, calc(100vw - 24px));
      display: flex; flex-direction: column;
      background: var(--gs-bg-elevated, var(--vscode-editorWidget-background));
      border: 1px solid var(--gs-border); border-radius: 8px;
      box-shadow: 0 12px 34px rgba(0,0,0,0.45); overflow: hidden;
    }
    .rp-title { padding: 9px 11px 3px; font-size: 12.5px; font-weight: 600; }
    .rp-hint { padding: 0 11px 8px; font-size: 11px; color: var(--gs-fg-muted); }
    .rp-inputwrap { padding: 0 9px 8px; }
    .rp-inputwrap input {
      width: 100%; box-sizing: border-box; padding: 6px 8px;
      font-family: inherit; font-size: 12.5px;
      color: var(--gs-fg); background: var(--vscode-input-background);
      border: 1px solid var(--gs-border); border-radius: 5px; outline: none;
    }
    .rp-inputwrap input:focus { border-color: var(--gs-accent); box-shadow: var(--gs-glow); }
    .rp-err { padding: 0 11px 7px; font-size: 11px; color: var(--gs-danger, #f14c4c); }
    /* The corrected ref name, offered under the error that prompted it. */
    .rp-sug {
      display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
      margin: 0 11px 9px; padding: 6px 8px;
      border: 1px solid var(--gs-border-soft); border-radius: 5px;
      background: color-mix(in srgb, var(--vscode-foreground) 5%, transparent);
      font-size: 11px;
    }
    .rp-sug-lead { color: var(--gs-fg-subtle); flex: 0 0 auto; }
    .rp-sug-name {
      flex: 1 1 auto; min-width: 0;
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 11px;
      overflow-wrap: anywhere;
      color: var(--vscode-foreground);
    }
    .rp-sug-btn {
      flex: 0 0 auto;
      padding: 2px 8px; border-radius: 4px;
      border: 1px solid var(--gs-border-soft);
      background: transparent; color: var(--vscode-foreground);
      font-size: 11px; cursor: pointer;
    }
    .rp-sug-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .rp-sug-btn:focus-visible {
      outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px;
    }
    .rp-list { max-height: 260px; overflow-y: auto; border-top: 1px solid var(--gs-border-soft); }
    .rp-row {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 11px; font-size: 12px; cursor: pointer;
    }
    .rp-row .codicon { font-size: 12px; opacity: 0.8; flex: 0 0 auto; }
    .rp-row .rp-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .rp-row .rp-kind { margin-left: auto; font-size: 10px; color: var(--gs-fg-subtle); }
    /* The keyboard's row is lit with the accent's tint, rounded inside the
       list, and plainly not a hovered row. It used to be the hover's grey
       with a 2px accent bar down its edge, and the bar was the only
       difference. High contrast has no tints: VS Code's whole ring there. */
    .rp-row { margin: 0 4px; border-radius: var(--gs-radius-sm); }
    .rp-row:hover { background: var(--gs-hover); }
    .rp-row.sel { background: var(--gs-sel-fill); }
    /* Words on the tint take full ink: the muted description read 3.3:1 in
       Light+. */
    .rp-row.sel .rp-kind, .rp-row.sel .rp-choice-desc, .rp-row.sel .rp-choice-detail { color: var(--gs-fg); }
    body.vscode-high-contrast .rp-row.sel {
      outline: 1px solid var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: -1px;
    }
    .rp-empty { padding: 8px 11px; font-size: 11px; color: var(--gs-fg-subtle); }
    .rp-foot {
      display: flex; justify-content: flex-end; gap: 6px;
      padding: 8px 9px; border-top: 1px solid var(--gs-border-soft);
    }
    .rp-foot button {
      padding: 4px 11px; font-size: 12px; border-radius: 5px; cursor: pointer;
      border: 1px solid var(--gs-border); background: transparent; color: var(--gs-fg);
    }
    /* GitStudio's own pair, as Push and Commit & Push: the theme's focusBorder
       is no fill (Cursor Dark's is 15% white) and its button label pairs
       only with its own button colour — together they read 1.4:1 in Cursor,
       and white on focusBorder blue was under 4.5:1 even in Dark+. */
    .rp-foot button.primary {
      background: var(--gs-brand); border-color: var(--gs-brand);
      color: var(--gs-brand-fg);
    }
    /* A FILL for a destructive button. --gs-danger is the theme's error TEXT
       colour (Dark+: #f48771), and a white label on it read 2.5:1; darkened
       toward black it carries one at 4.5:1 or more in every built-in theme. */
    :root { --gs-danger-fill: color-mix(in srgb, var(--vscode-errorForeground, #f14c4c) 62%, #000000); }
    .rp-foot button.primary.danger {
      background: var(--gs-danger-fill); border-color: var(--gs-danger-fill);
      color: #fff;
    }
    .rp-foot button:disabled { opacity: 0.5; cursor: default; }
    /* Under the pointer a filled button darkens: the global button.primary
       brightening took the violet to #8061ff, white on it 4.1:1. */
    .rp-foot button.primary:not(:disabled):hover { filter: none; }
    .rp-foot button.primary:not(.danger):not(:disabled):hover {
      background: color-mix(in srgb, var(--gs-brand) 82%, #000);
      border-color: color-mix(in srgb, var(--gs-brand) 82%, #000);
    }
    .rp-foot button.primary.danger:not(:disabled):hover {
      background: color-mix(in srgb, var(--gs-danger-fill) 88%, #000);
      border-color: color-mix(in srgb, var(--gs-danger-fill) 88%, #000);
    }
    /* A multi-line answer (a PR body, a review summary). Same frame as the
       single-line input so the dialog doesn't change shape between kinds. */
    .rp-inputwrap textarea {
      width: 100%; box-sizing: border-box; padding: 6px 8px; min-height: 116px;
      font-family: inherit; font-size: 12.5px; line-height: 1.45; resize: vertical;
      color: var(--gs-fg); background: var(--vscode-input-background);
      border: 1px solid var(--gs-border); border-radius: 5px; outline: none;
    }
    .rp-inputwrap textarea:focus { border-color: var(--gs-accent); box-shadow: var(--gs-glow); }
    /* Pick rows carry a second explanatory line, so they stack rather than
       sitting on one baseline like the ref-completion rows above. */
    .rp-choice { align-items: flex-start; padding: 7px 11px; }
    .rp-choice .codicon { margin-top: 1px; }
    .rp-choice-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .rp-choice-label { overflow: hidden; text-overflow: ellipsis; }
    .rp-choice-desc { font-size: 11px; color: var(--gs-fg-muted); line-height: 1.4; white-space: normal; }
    .rp-choice-detail { margin-left: auto; padding-left: 10px; font-size: 10px; color: var(--gs-fg-subtle); flex: 0 0 auto; }
    .rp-choice.danger .rp-choice-label, .rp-choice.danger .codicon { color: var(--gs-danger, #f14c4c); }
    .rp-check { flex: 0 0 auto; margin: 1px 0 0; accent-color: var(--gs-accent); }
    /* A question's checkboxes ("Also delete the branch"), between the choices
       and the footer. */
    .rp-options { padding: 6px 11px 8px; border-top: 1px solid var(--gs-border-soft); }
    .rp-option { display: flex; align-items: flex-start; gap: 8px; margin: 0 -6px; padding: 3px 6px; border-radius: var(--gs-radius-sm); font-size: 12px; cursor: pointer; }
    .rp-option .rp-check { margin-top: 2px; }
    /* The option the keyboard is on is lit, not underlined. */
    .rp-option:has(.rp-check:focus-visible) { background: var(--gs-sel-fill); }
    .rp-option:has(.rp-check:focus-visible) .rp-choice-desc { color: var(--gs-fg); }
    /* A confirm has no list and no input — just the question. */
    .rp-msg { padding: 2px 11px 11px; font-size: 12px; line-height: 1.5; white-space: pre-wrap; }
    /* Reads as an action, not a footnote — it is the only way to reach the
       remaining tags, so it must look clickable. */
    .bm-more {
      padding: 5px 8px 6px 34px; color: var(--gs-accent-text);
      font-size: 11px; cursor: pointer; user-select: none;
    }
    /* Under the pointer it is the highlighted row (lit, above) — never underlined. */
    .bm-more:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }

    /* ---- Message composer -------------------------------------------------
       ONE elevated card holds the message, the toggles, the author override and
       the Commit/Push footer, so the primary action reads as part of the box
       rather than a band floating below it. */
    .composer {
      margin: 0 2px 10px;
      background: var(--vscode-input-background, var(--gs-surface));
      border: 1px solid var(--gs-border);
      border-radius: var(--gs-radius);
      box-shadow: var(--gs-shadow-1);
      overflow: hidden;
      transition: border-color var(--gs-motion) var(--gs-ease),
                  box-shadow var(--gs-motion) var(--gs-ease);
    }
    .composer:focus-within {
      border-color: var(--gs-accent);
      box-shadow: var(--gs-glow);
    }
    /* The message area sits flush inside the card — the card owns the chrome. */
    .message-wrap {
      position: relative;
      margin: 0;
      background: transparent;
      border: none;
      border-radius: 0;
      box-shadow: none;
    }
    textarea {
      display: block;
      width: 100%;
      resize: none;
      min-height: 34px;
      max-height: 320px;
      padding: 7px 34px 6px 11px;
      color: var(--vscode-input-foreground);
      background: transparent;
      border: none;
      border-radius: var(--gs-radius);
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.5;
      outline: none;
    }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }
    /* Footer strip inside the card: live subject-length counter, right-aligned. */
    .composer-foot {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      height: 0;
      overflow: hidden;
      padding: 0 11px;
      opacity: 0;
      transition: height var(--gs-motion) var(--gs-ease),
                  opacity var(--gs-motion) var(--gs-ease);
    }
    .message-wrap.has-text .composer-foot { height: 22px; opacity: 1; }
    .counter {
      font-family: var(--gs-font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 10.5px;
      letter-spacing: 0.02em;
      color: var(--gs-fg-subtle);
      transition: color var(--gs-motion) var(--gs-ease);
    }
    /* A warning, in the theme's warning colour for text in lists — it was
       --gs-status-modified, the charts-blue this view uses for information. */
    .counter.warn { color: var(--vscode-list-warningForeground, var(--gs-amber)); }
    .counter.over { color: var(--gs-status-deleted); }

    /* ---- Sparkle / generate button (crisp SVG, never emoji) ----------- */
    .sparkle {
      position: absolute;
      top: 7px;
      right: 7px;
      display: none;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: 1px solid transparent;
      border-radius: var(--gs-radius-sm);
      background: transparent;
      color: var(--gs-fg-muted);
      cursor: pointer;
      transition: color var(--gs-motion-fast) var(--gs-ease),
                  background var(--gs-motion-fast) var(--gs-ease),
                  border-color var(--gs-motion-fast) var(--gs-ease);
    }
    .sparkle.visible { display: inline-flex; }
    /* The Review + Connect buttons sit just left of the ✨ Generate slot. Review
       shows when AI is on; Connect shows when it is off (mutually exclusive with
       Generate), so at most two buttons ever appear. */
    .sparkle.review { right: 35px; }
    .sparkle.connect { color: var(--gs-accent-text); }
    .sparkle svg { width: 15px; height: 15px; display: block; }
    .sparkle .spinner { display: none; }
    .sparkle.loading .glyph { display: none; }
    .sparkle.loading .spinner { display: block; }
    .sparkle:hover {
      color: var(--gs-accent-text);
      background: color-mix(in srgb, var(--gs-accent) 14%, transparent);
      border-color: color-mix(in srgb, var(--gs-accent) 30%, transparent);
    }
    .sparkle:disabled { cursor: default; }
    .sparkle:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .sparkle.loading .spinner { animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Toggles row --------------------------------------------------- */
    .toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 3px 4px;
      align-items: center;
      margin: 0;
      padding: 4px 8px 2px;
      font-size: 11.5px;
    }
    .toggles label {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 2px 8px 2px 6px;
      border-radius: var(--gs-radius-pill);
      cursor: pointer;
      color: var(--gs-fg-muted);
      transition: background var(--gs-motion-fast) var(--gs-ease),
                  color var(--gs-motion-fast) var(--gs-ease);
    }
    .toggles label:hover { background: var(--gs-hover); color: var(--gs-fg); }
    .toggles label:has(input:checked) {
      color: var(--gs-brand);
      background: color-mix(in srgb, var(--gs-brand) 14%, transparent);
    }
    .toggles input[type="checkbox"] {
      accent-color: var(--gs-brand);
      width: 13px; height: 13px;
      margin: 0;
    }

    /* ---- Author override row (expands inside the composer card) -------- */
    .author-row { margin: 0; padding: 2px 8px 8px; }
    .author-row.hidden { display: none; }
    .author-row input {
      width: 100%;
      padding: 6px 10px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background, var(--gs-surface));
      border: 1px solid var(--gs-border);
      border-radius: var(--gs-radius-sm);
      font-family: var(--gs-font-ui);
      font-size: 12px;
      outline: none;
      transition: border-color var(--gs-motion) var(--gs-ease),
                  box-shadow var(--gs-motion) var(--gs-ease);
    }
    .author-row input:focus { border-color: var(--gs-accent); box-shadow: var(--gs-glow); }

    /* ---- Inline link button (Author…) --------------------------------- */
    .link {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      background: none; border: none;
      padding: 3px 9px 3px 8px;
      border-radius: var(--gs-radius-pill);
      color: var(--gs-fg-muted);
      cursor: pointer; font-size: 12px;
      transition: background var(--gs-motion-fast) var(--gs-ease),
                  color var(--gs-motion-fast) var(--gs-ease);
    }
    .link:hover { background: var(--gs-hover); color: var(--gs-fg); }
    .link[aria-expanded="true"] {
      color: var(--gs-accent-text);
      background: color-mix(in srgb, var(--gs-accent) 12%, transparent);
    }
    .link svg { width: 12px; height: 12px; }
    .link[aria-expanded="true"] .chev { transform: rotate(180deg); }
    .link .chev { transition: transform var(--gs-motion) ease; }

    /* ---- Action buttons (docked footer of the composer card) ---------- */
    .actions {
      display: flex;
      gap: 6px;
      margin: 0;
      padding: 8px;
      border-top: 1px solid var(--gs-border-soft);
      background: color-mix(in srgb, var(--gs-fg) 3%, transparent);
    }
    button.gs-commit {
      position: relative;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      height: 26px;
      border: 1px solid transparent;
      border-radius: var(--gs-radius-sm);
      padding: 0 12px;
      cursor: pointer;
      font-family: var(--gs-font-ui);
      font-size: 12.5px;
      line-height: 1.2;
      overflow: hidden;
      /* Animate filter/shadow/transform — NOT background: a gradient fill can't
         be interpolated, so the hover brighten rides on filter instead. */
      transition: filter var(--gs-motion) var(--gs-ease),
                  background var(--gs-motion) var(--gs-ease),
                  box-shadow var(--gs-motion) var(--gs-ease),
                  border-color var(--gs-motion) var(--gs-ease),
                  transform var(--gs-motion-fast) var(--gs-ease),
                  opacity var(--gs-motion) var(--gs-ease);
    }
    button.gs-commit svg { width: 14px; height: 14px; flex: 0 0 auto; }
    button.primary {
      flex: 1;
      color: var(--gs-brand-fg);
      /* GitStudio violet with a subtle vertical sheen — a real, tactile,
         on-brand primary action, not the theme's default (blue) accent. */
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--gs-brand) 86%, white 14%),
          var(--gs-brand));
      border-color: var(--gs-brand);
      font-weight: 600;
      letter-spacing: 0.01em;
      box-shadow: var(--gs-shadow-1),
        inset 0 1px 0 color-mix(in srgb, white 18%, transparent);
    }
    button.primary:hover {
      /* Keep the gradient; brighten it smoothly + lift the shadow. */
      filter: brightness(1.1);
      border-color: var(--gs-brand-hover);
      box-shadow: var(--gs-shadow-2),
        inset 0 1px 0 color-mix(in srgb, white 24%, transparent);
    }
    button.gs-commit:active { transform: translateY(1px); }
    button.primary:active {
      filter: brightness(0.95);
      box-shadow: var(--gs-shadow-1),
        inset 0 1px 0 color-mix(in srgb, white 12%, transparent);
    }
    button.split {
      color: var(--vscode-button-secondaryForeground, var(--gs-fg));
      background: var(--vscode-button-secondaryBackground, var(--gs-surface-2));
      border-color: var(--gs-border);
    }
    button.split:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--gs-hover));
      border-color: var(--gs-border-soft);
    }
    button.gs-commit:disabled {
      opacity: 0.4;
      cursor: default;
      box-shadow: none;
      transform: none;
      /* A button disabled WHILE hovered keeps :hover in Chromium; reset the
         hover filter too so a busy Commit button isn't dimmed AND brightened. */
      filter: none;
    }
    button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 2px; }
    .link:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }

    /* The compact Commit button sits beside the prominent primary action. */
    .commit-btn { flex: 0 0 auto; padding: 0 10px; }
    /* In-button loading: swap the glyph for a spinner while the op runs. */
    button.gs-commit .spin { display: none; }
    button.gs-commit .spin.codicon { animation: codicon-spin 1s steps(12) infinite; }
    button.gs-commit.is-busy .glyph { display: none; }
    button.gs-commit.is-busy .spin { display: inline-flex; }
    button.gs-commit.is-busy { cursor: default; }
    /* Flash the composer when a commit is attempted with an empty message. */
    .composer.needs-msg {
      border-color: var(--gs-status-deleted);
      box-shadow: 0 0 0 3px color-mix(in srgb, var(--gs-status-deleted) 22%, transparent);
    }

    /* ---- (keyboard hint removed — the composer is self-evident) -------- */

    /* ---- Changes section header --------------------------------------- */
    .changes-toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin: 16px 2px 4px;
      padding: 9px 2px 5px;
      border-top: 1px solid var(--gs-border-soft);
    }
    .changes-title {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      color: var(--gs-fg-muted);
      /* One line, cut short when the toolbar is full (the tree layout adds
         Collapse All) — it wrapped to two and pushed the list down. */
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .changes-total {
      display: none;
      min-width: 18px;
      height: 17px;
      padding: 0 6px;
      align-items: center;
      justify-content: center;
      border-radius: var(--gs-radius-pill);
      font-family: var(--gs-font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 10.5px;
      font-weight: 600;
      color: var(--gs-fg-muted);
      background: color-mix(in srgb, var(--gs-fg) 11%, transparent);
    }
    .changes-total.visible { display: inline-flex; }
    .changes-toolbar .toolbar-spacer { flex: 1 1 auto; }
    .changes-toolbar .toolbar-actions { display: inline-flex; align-items: center; gap: 1px; flex: 0 0 auto; }
    .changes-toolbar .changes-total { flex: 0 0 auto; }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: var(--gs-radius-sm);
      background: transparent;
      color: var(--gs-fg-muted);
      cursor: pointer;
      transition: color var(--gs-motion-fast) var(--gs-ease),
                  background var(--gs-motion-fast) var(--gs-ease);
    }
    .icon-btn svg { width: 16px; height: 16px; display: block; }
    .icon-btn:hover {
      color: var(--gs-fg);
      background: var(--vscode-toolbar-hoverBackground, var(--gs-hover));
    }
    .icon-btn:active { background: color-mix(in srgb, var(--gs-fg) 12%, transparent); }
    .icon-btn:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .icon-btn:disabled { opacity: 0.4; cursor: default; }
    .icon-btn:disabled:hover { color: var(--gs-fg-muted); background: transparent; }
    .icon-btn.collapse-all { display: none; }
    body.layout-tree .icon-btn.collapse-all { display: inline-flex; }

    /* The layout toggle shows the OTHER mode's glyph (click to switch to it). */
    .icon-btn.layout .to-tree { display: inline-flex; }
    .icon-btn.layout .to-list { display: none; }
    body.layout-tree .icon-btn.layout .to-tree { display: none; }
    body.layout-tree .icon-btn.layout .to-list { display: inline-flex; }

    /* ---- Groups -------------------------------------------------------- */
    /* The staging-model toggle, built exactly like the tree/list one above: two
       glyphs, and the one showing is the mode you would switch TO. Same idiom,
       same weight in the toolbar — it is the same kind of choice. */
    .icon-btn.model .to-checks { display: inline-flex; }
    .icon-btn.model .to-split { display: none; }
    body.model-checkboxes .icon-btn.model .to-checks { display: none; }
    body.model-checkboxes .icon-btn.model .to-split { display: inline-flex; }

    /* Hunk rows are clickable now — they open the diff at that change — so they
       need to look it, and a staged one needs to look different from a pending
       one while both stay in the list. */
    .hunk-row { cursor: pointer; border-radius: 3px; }
    .hunk-row:hover { background: var(--vscode-list-hoverBackground); }
    .hunk-row:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    /* A staged change stays listed, dimmed — present, accounted for, done. */
    .hunk-row.hunk-staged .hunk-lines,
    .hunk-row.hunk-staged .hunk-preview { opacity: 0.55; }
    /* Held only between the click and the host's answer, so a slow git call
       cannot be mistaken for a click that did not register. */
    .hunk-row.is-busy { opacity: 0.7; }

    .groups { margin: 0 0 2px; }

    /* ---- Multi-selection, drag-to-stash ---------------------------------- */
    /* A selected row is lit, never barred: a tint of the accent that stands
       apart from the view in every theme (the list's own inactive-selection
       grey did not in Light+, and high contrast paints none), stronger under
       the pointer; high contrast rings it, dashed, as its lists do. A 2px
       bar down the left edge used to mark it. Declared on body, where the
       theme's class is. */
    body {
      --sel-fill: color-mix(in srgb, var(--gs-accent) 22%, transparent);
      --sel-fill-hover: color-mix(in srgb, var(--gs-accent) 28%, transparent);
    }
    body.vscode-light {
      --sel-fill: color-mix(in srgb, var(--gs-accent) 15%, transparent);
      --sel-fill-hover: color-mix(in srgb, var(--gs-accent) 18%, transparent);
    }
    .row.is-file.is-selected { background: var(--sel-fill); }
    .row.is-file.is-selected:hover { background: var(--sel-fill-hover); }
    /* Its words read on the tint (AA), at rest and under the pointer: the
       name and the folder lean a little further from the ground (Light+'s
       folder read 3.7:1), and the status letter keeps its hue, lifted toward
       white in dark and black in light (Light+'s blue M read 2.75:1). */
    .row.is-file.is-selected .name,
    .row.is-file.is-selected .dir { color: color-mix(in srgb, var(--gs-fg) 72%, var(--gs-sel-lift)); }
    .row.is-file.is-selected.is-deleted .name { opacity: 1; }
    .row.is-file.is-selected .status { color: color-mix(in srgb, var(--gs-row-accent, var(--gs-fg-muted)) 62%, var(--gs-sel-lift)); }
    body.vscode-high-contrast .row.is-file.is-selected {
      outline: 1px dashed var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: -1px;
    }
    body.vscode-high-contrast .row.is-file.is-selected:focus-visible { outline-style: solid; }

    .selbar {
      display: flex; align-items: center; gap: 8px;
      margin: 2px 0 4px; padding: 4px 10px;
      background: var(--vscode-list-inactiveSelectionBackground);
      border-radius: 4px; font-size: 11.5px;
    }
    .selbar[hidden] { display: none; }
    .selbar-count { color: var(--vscode-foreground); font-weight: 600; }
    .selbar-actions { margin-left: auto; display: flex; gap: 4px; }
    .selbar-btn {
      font: inherit; color: var(--vscode-foreground);
      background: transparent; border: 1px solid var(--vscode-contrastBorder, transparent);
      border-radius: 3px; padding: 1px 8px; cursor: pointer;
    }
    .selbar-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
    .selbar-btn:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 1px; }

    /* ---- Drag and drop: the working tree and the Stashes group ---------
       One mechanism, both ways. A stash, some of its files or one of its
       folders dragged onto the working tree (or the clean tree's note) comes
       back, as it was stashed; working-tree files dragged onto the Stashes
       header are stashed. While a drag is on, each place it can go is
       faintly tinted; the one under the pointer is lit and says what a drop
       does, and Alt/Option picks the other verb. No outline, no dashed box:
       a tinted fill. */
    body {
      --drop-ready: color-mix(in srgb, var(--gs-accent) 7%, transparent);
      --drop-over: color-mix(in srgb, var(--gs-accent) 20%, transparent);
      --drop-over-solid: color-mix(in srgb, var(--gs-accent) 20%, var(--vscode-sideBar-background, var(--gs-bg)));
    }
    body.vscode-light {
      --drop-ready: color-mix(in srgb, var(--gs-accent) 5%, transparent);
      --drop-over: color-mix(in srgb, var(--gs-accent) 14%, transparent);
      --drop-over-solid: color-mix(in srgb, var(--gs-accent) 14%, var(--vscode-sideBar-background, var(--gs-bg)));
    }
    body.is-dragging { cursor: grabbing; }
    .row.is-dragged { opacity: 0.55; }
    .is-drop-ready { background: var(--drop-ready); border-radius: var(--gs-radius); }
    .is-drop-over { background: var(--drop-over); border-radius: var(--gs-radius); }
    /* Its words: what a drop does, and — where Alt/Option picks the other
       verb — how. Each is whole or, where it cannot fit even on a line of
       its own, cut at its end. */
    .drop-hint { display: none; }
    .drop-verb, .drop-alt {
      flex: 0 1 auto; min-width: 0;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      color: var(--gs-fg);
    }
    .drop-verb { font-size: 12px; font-weight: 600; }
    .drop-alt { font-size: 11px; font-weight: 400; }
    /* The Stashes header: the words in place of its name, count and buttons. */
    .group-header.is-drop-over > .drop-hint {
      display: flex; align-items: baseline; gap: 10px;
      flex: 1 1 auto; min-width: 0; overflow: hidden;
    }
    .group-header.is-drop-over .glabel,
    .group-header.is-drop-over .gcount,
    .group-header.is-drop-over .group-actions { display: none; }
    /* The group is the lit place; its header only speaks — one ring, and its
       tint made solid, held in sight at the top while the group is: let go
       over a stash far down a long list, the words are still there. */
    .group--stashes.is-drop-over > .group-header.is-drop-over {
      position: sticky; top: 0; z-index: 3;
      background: var(--drop-over-solid); outline: none;
    }
    /* The working tree, every group of it one place: the words in a band
       held at its top — in sight however far the list is scrolled — laid
       over its first group's header on the lit tint made solid. The band
       takes no room (nothing moves under the pointer). Too narrow for both
       side by side, "Hold Option to pop" goes on a line of its own under
       the verb rather than lose its end. */
    #groups.is-drop-over > .drop-hint {
      display: block;
      position: sticky; top: 0; z-index: 3;
      height: 0;
    }
    #groups.is-drop-over > .drop-hint > .drop-words {
      position: absolute; left: 0; right: 0; top: 0;
      box-sizing: border-box; min-height: 26px;
      display: flex; flex-wrap: wrap; align-items: baseline; align-content: center;
      justify-content: space-between; column-gap: 10px; row-gap: 1px;
      padding: 5px 8px 5px 10px;
      line-height: 16px;
      background: var(--drop-over-solid);
      border-radius: var(--gs-radius);
    }
    /* The clean tree's note: the words take the place of "No changes to
       commit.", one under the other. */
    #empty-state.is-drop-over .es { display: none; }
    #empty-state.is-drop-over > .drop-hint {
      display: flex; flex-direction: column; align-items: center; gap: 2px;
      max-width: 100%;
    }
    #empty-state.is-drop-over > .drop-hint > .drop-alt { white-space: normal; text-align: center; }
    /* High contrast paints no tints: there the target is ringed, as VS Code
       rings a drop target — just outside it, where the band of words held
       in sight cannot paint over it. */
    body.vscode-high-contrast .is-drop-over {
      outline: 1px dashed var(--vscode-contrastActiveBorder, var(--gs-accent));
      outline-offset: 1px;
    }
    .group { margin-top: 4px; }
    /* An empty group is not drawn; the tree's keyboard skips it too (see
       shownItem in the script). Hide a treeitem another way, and teach
       shownItem the same rule. */
    .group.empty { display: none; }
    /* Checkbox model (gitstudio.changes.stagingModel = "checkboxes"). The tick
       is the only staging affordance in this mode, so it gets a real hit area
       rather than the browser default. */
    /* Drawn, not native. A bare <input type=checkbox> renders as the platform
       control — rounded and blue on macOS, a different shape on Windows — which
       is conspicuously not what every other checkbox in the editor looks like.
       These use VS Code's own checkbox tokens and its mark, so they belong. */
    .ck {
      flex: 0 0 auto;
      appearance: none;
      -webkit-appearance: none;
      position: relative;
      width: 16px;
      height: 16px;
      margin: 0 7px 0 0;
      border-radius: 3px;
      border: 1px solid var(--vscode-checkbox-border, var(--gs-border, #6f6f6f));
      background: var(--vscode-checkbox-background, var(--vscode-editor-background));
      cursor: pointer;
      transition: background 90ms ease, border-color 90ms ease;
    }
    .ck:hover { border-color: var(--vscode-focusBorder); }
    .ck:focus-visible {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: 1px;
    }
    .ck:checked,
    .ck:indeterminate {
      background: var(--vscode-inputOption-activeBackground, var(--gs-accent));
      border-color: var(--vscode-inputOption-activeBorder, var(--gs-accent));
    }
    /* The tick: two borders rotated into a check, so it needs no font or asset
       and stays crisp at any zoom. */
    .ck:checked::after {
      content: "";
      position: absolute;
      left: 5px;
      top: 1.5px;
      width: 4px;
      height: 8px;
      border: solid var(--vscode-inputOption-activeForeground, #ffffff);
      border-width: 0 1.6px 1.6px 0;
      transform: rotate(43deg);
    }
    /* Indeterminate is a bar, the standard "some of this" mark — never an empty
       box, which would read as "nothing here" over work already staged. */
    .ck:indeterminate::after {
      content: "";
      position: absolute;
      left: 3px;
      top: 6.2px;
      width: 8px;
      height: 2px;
      border-radius: 1px;
      background: var(--vscode-inputOption-activeForeground, #ffffff);
    }
    .ck:disabled { opacity: 0.5; cursor: default; }
    .ck-master { margin-left: 2px; }
    /* Per-hunk ticks (#20): a file with unstaged work opens up to reveal its
       individual changes, so partial staging survives the checkbox model. */
    .hunk-twisty {
      flex: 0 0 auto;
      width: 14px;
      height: 14px;
      margin-right: 2px;
      padding: 0;
      border: 0;
      background: transparent;
      color: var(--gs-fg-muted);
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      transition: transform var(--gs-motion-fast) var(--gs-ease);
    }
    /* The glyph is chevron-right (ICON_CHEVRON): right while closed, turned
       to point down while open, as every tree in the editor does. */
    .hunk-twisty.open { transform: rotate(90deg); }
    .hunk-twisty .codicon { font-size: 11px; line-height: 1; }
    .hunks {
      display: flex;
      flex-direction: column;
      margin: 0 0 2px 44px;
      border-left: 1px solid var(--gs-border-soft);
    }
    .hunk-row {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 1px 6px;
      min-height: 20px;
      font-size: 11.5px;
      color: var(--gs-fg-muted);
    }
    .hunk-row:hover { background: var(--gs-hover); }
    .hunk-lines {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      opacity: 0.75;
    }
    .hunk-preview {
      flex: 1 1 auto;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--gs-fg);
    }
    .hunk-empty {
      padding: 2px 8px;
      font-size: 11.5px;
      color: var(--gs-fg-subtle);
    }
    .group--all .row.is-file { padding-left: 20px; }

    .group-header {
      display: flex;
      align-items: center;
      gap: 5px;
      height: 26px;
      padding: 0 6px 0 4px;
      cursor: pointer;
      border-radius: var(--gs-radius-sm);
      user-select: none;
    }
    .group-header:hover { background: var(--gs-hover); }
    .group-header .twisty {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--gs-fg-subtle);
      flex: 0 0 auto;
      transform: rotate(90deg);
      transition: transform var(--gs-motion) var(--gs-ease);
    }
    /* chevron-right: down (turned) while open, right when collapsed. */
    .group.collapsed .group-header .twisty { transform: none; }
    .group-header .twisty svg { width: 12px; height: 12px; }
    /* Per-group identity dot (staged = green, unstaged = amber, merge = red). */
    .group-header .gdot {
      width: 7px; height: 7px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--gs-fg-subtle);
    }
    .group--staged .gdot { background: var(--gs-status-added); }
    .group--unstaged .gdot { background: var(--gs-status-modified); }
    .group--merge .gdot { background: var(--gs-status-conflict); }
    .group-header .glabel {
      flex: 1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.055em;
      font-weight: 600;
      color: var(--gs-fg-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .group--staged .glabel { color: var(--gs-fg); }
    .group-header .gcount {
      font-family: var(--gs-font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 10.5px;
      font-weight: 600;
      min-width: 18px;
      text-align: center;
      padding: 0 6px;
      height: 16px;
      line-height: 16px;
      border-radius: var(--gs-radius-pill);
      background: color-mix(in srgb, var(--gs-fg) 11%, transparent);
      color: var(--gs-fg-muted);
      flex: 0 0 auto;
    }
    /* The count stays neutral for every group. The colored .gdot already signals
       the group's status; a status-tinted count would just repeat it, so the
       header ends up saying the same thing three times (dot + label + count). */
    .group-actions {
      display: inline-flex;
      gap: 1px;
      opacity: 0;
      transition: opacity var(--gs-motion) ease;
    }
    .group-header:hover .group-actions,
    .group-header:focus-within .group-actions { opacity: 1; }
    .group.collapsed .group-body { display: none; }

    /* ---- File / folder rows ------------------------------------------- */
    .row {
      position: relative;
      display: flex;
      align-items: center;
      gap: 7px;
      height: 24px;
      padding: 0 4px 0 2px;
      border-radius: var(--gs-radius-sm);
      cursor: pointer;
      user-select: none;
    }
    /* The row under the pointer: its fill, and no rail down its edge. */
    .row:hover { background: var(--gs-hover); }
    .row:focus-visible,
    .group-header:focus-visible { outline: 1px solid var(--vscode-list-focusOutline, var(--gs-accent)); outline-offset: -1px; }
    .row .indent { flex: 0 0 auto; }
    .row .twisty {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--gs-fg-muted);
      flex: 0 0 auto;
      transform: rotate(90deg);
      transition: transform var(--gs-motion) ease;
    }
    .row .twisty svg { width: 12px; height: 12px; }
    /* chevron-right: down (turned) while open, right when collapsed. */
    .row.collapsed .twisty { transform: none; }
    .row .file-icon {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      flex: 0 0 auto;
      color: var(--gs-fg-subtle);
    }
    .row .file-icon svg { width: 15px; height: 15px; }
    /* Tint the file glyph by status for an instant visual cue. */
    .row.is-file .file-icon { color: var(--gs-row-accent, var(--gs-fg-subtle)); opacity: 0.9; }
    .row .folder-icon { color: var(--vscode-symbolIcon-folderForeground, var(--gs-fg-muted)); opacity: 0.85; }
    .row .name {
      flex: 0 1 auto;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .row.is-deleted .name { text-decoration: line-through; opacity: 0.85; }
    /* The directory takes only the width left over (basis 0, then grows), so
       the file name is cut only once there is none. A larger shrink factor
       was not enough: shrinking is shared out by weight, so the name still
       lost a fraction of a pixel, and any overflow at all draws an ellipsis.
       It clips from the START (direction: rtl) so its tail — the folder the
       file is in — stays; the path inside is a <bdi>, an isolated
       left-to-right run, so its characters keep their order (a leading "."
       stays at the start). */
    .row .dir {
      flex: 1 1 0;
      min-width: 0;
      font-size: 11.5px;
      color: var(--gs-fg-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      direction: rtl;
      text-align: left;
    }
    .row .spacer { flex: 1 1 auto; }
    .row .row-actions {
      display: inline-flex;
      gap: 1px;
      /* Resting-visible (not opacity:0) so the stage/unstage affordance is
         discoverable at a glance, crisp on hover. The old hover-only reveal +
         muted colour + thin dash made the "-" nearly invisible. */
      opacity: 0.55;
      flex: 0 0 auto;
      transition: opacity var(--gs-motion) ease;
    }
    .row:hover .row-actions,
    .row:focus-within .row-actions { opacity: 1; }
    /* The +/-/discard glyphs are the primary per-row action — render them at
       full strength and a touch larger than the muted toolbar default so they
       read clearly (esp. the single-stroke unstage dash). */
    .row .row-actions .icon-btn { color: var(--gs-fg); }
    .row .row-actions .icon-btn:hover { color: var(--gs-brand); }
    .row .row-actions .codicon,
    .group-actions .icon-btn .codicon { font-size: 17px; }
    /* Status letter: plain colored monospace, not a filled pill. Each row
       already carries its status via the tinted icon — a second, filled
       badge per row was the busiest signal in the list. The fixed
       width keeps the letters column-aligned. */
    .row .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: var(--gs-font-mono);
      font-size: 10.5px;
      font-weight: 700;
      width: 14px;
      flex: 0 0 auto;
      color: var(--gs-row-accent, var(--gs-fg-muted));
    }
    .st-M { --gs-row-accent: var(--gs-status-modified); }
    .st-A { --gs-row-accent: var(--gs-status-added); }
    .st-U { --gs-row-accent: var(--gs-status-untracked); }
    .st-D { --gs-row-accent: var(--gs-status-deleted); }
    .st-R { --gs-row-accent: var(--gs-status-renamed); }
    .st-C { --gs-row-accent: var(--gs-status-renamed); }
    .st-T { --gs-row-accent: var(--gs-status-modified); }
    .st-I { --gs-row-accent: var(--gs-status-ignored); }
    .row.is-conflict { --gs-row-accent: var(--gs-status-conflict); }

    /* ---- Stashes group (after the file groups) ------------------------- */
    /* The header is the Staged / Changes header; the dot is the brand's. */
    .group--stashes .gdot { background: var(--gs-brand); }
    /* A stash row is two lines — its words, then where and when it was made
       and how many files it holds — so neither is cut to make room for the
       other at sidebar width. Its twisty, icon and buttons are centred on
       the two lines. */
    .row.stash-row { height: 38px; align-items: center; }
    .row.stash-row .stash-icon { color: var(--gs-fg-muted); }
    .stash-text {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: center;
    }
    .stash-msg,
    .stash-meta {
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .stash-msg { line-height: 17px; }
    .stash-meta {
      font-size: 11.5px;
      line-height: 15px;
      color: var(--gs-fg-muted);
    }
    /* In flight (Apply, a Copy): the row stays, dimmed, until git answers. */
    .row.stash-row.is-busy,
    .row.stash-file.is-busy { opacity: 0.6; }
    .row.stash-row.is-busy .row-actions { visibility: hidden; }
    /* Where an open stash's files would be, while they are read or when they
       could not be: a note in a file row's place, not something to press. */
    .row.stash-note { color: var(--gs-fg-muted); cursor: default; }
    .row.stash-note:hover { background: none; }
    .row.stash-note .file-icon { color: var(--gs-fg-muted); }
    /* "Show 200 more of N": it reads as an action, as the branch menu's
       "Show more" does — its words in the link colour (the row's hover fill
       under the pointer; never an underline). */
    .row.stash-more { color: var(--gs-accent-text); }
    /* A stash's verbs, and its files' and folders', are WORDS — Apply and
       Pop, Move and Copy: their two glyphs read alike ("apply and pop have
       the same icon, it's confusing"). Small, calm and filled, shown on the
       row the pointer or the keyboard is on; the tip says what each does. */
    .row .row-actions .word-btn {
      flex: 0 0 auto;
      height: 20px;
      margin-left: 3px;
      padding: 0 7px;
      font-family: inherit;
      font-size: 11px;
      font-weight: 600;
      line-height: 20px;
      color: var(--word-ink);
      background: var(--word-fill);
      border: none;
      border-radius: var(--gs-radius-sm);
      cursor: pointer;
      white-space: nowrap;
    }
    .row .row-actions .word-btn:hover { background: var(--word-fill-hover); }
    /* A fill of the ink darkens the ground in a light theme and lightens it
       in a dark one — towards the ink either way — so the words are inked
       past the view's own text colour, never faded by their button: 4.5:1
       or more on the button at rest and under the pointer, and the button
       stands apart from the row it is on. */
    body {
      --word-ink: color-mix(in srgb, var(--gs-fg) 55%, #ffffff);
      --word-fill: color-mix(in srgb, var(--gs-fg) 11%, transparent);
      --word-fill-hover: color-mix(in srgb, var(--gs-fg) 18%, transparent);
    }
    body.vscode-light {
      --word-ink: color-mix(in srgb, var(--gs-fg) 55%, #000000);
      --word-fill: color-mix(in srgb, var(--gs-fg) 13%, transparent);
      --word-fill-hover: color-mix(in srgb, var(--gs-fg) 21%, transparent);
    }
    body.vscode-high-contrast { --word-ink: var(--gs-fg); }
    body.vscode-high-contrast .row .row-actions .word-btn {
      outline: 1px solid var(--vscode-contrastBorder, transparent);
      outline-offset: -1px;
    }
    .row .row-actions .word-btn { display: none; }
    .row:hover .row-actions .word-btn,
    .row:focus-within .row-actions .word-btn { display: inline-block; }
    /* "staged" / "partly staged": the stash had it staged, in words. */
    .stash-staged {
      flex: 0 0 auto;
      font-size: 11px;
      color: var(--gs-fg-muted);
      white-space: nowrap;
    }
    /* At the narrowest widths the words that name things keep their room: a
       stash row keeps only More Actions (its menu has Apply and Pop), a file
       or folder row its name (its menu has Move and Copy, and it can be
       dragged), and a file row drops the staged word (its status letter's
       tip says it). The row is the container, so a deep row in the tree
       gives way sooner. */
    .row.stash-row,
    .row.stash-file,
    .row.stash-folder { container-type: inline-size; }
    @container (max-width: 249px) {
      .row.stash-row .row-actions .word-btn.stash-quick { display: none; }
    }
    @container (max-width: 229px) {
      .row.stash-file .row-actions .word-btn.word-btn,
      .row.stash-folder .row-actions .word-btn.word-btn { display: none; }
    }
    @container (max-width: 199px) {
      .stash-file .stash-staged { display: none; }
    }
    .selbar-count {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .selbar-btn { white-space: nowrap; }
    /* A stash's files: which stash, and Clear, on the first line; Move to
       Changes and Copy to Changes share the second — at sidebar width the
       four did not fit on one. */
    .selbar.is-stash { flex-wrap: wrap; row-gap: 2px; padding-top: 5px; padding-bottom: 6px; }
    .selbar.is-stash .selbar-actions { display: contents; }
    .selbar.is-stash .selbar-count { flex: 1 1 0; order: 0; }
    .selbar.is-stash #selbar-clear { order: 1; }
    .selbar.is-stash::after { content: ""; order: 2; flex-basis: 100%; height: 0; }
    .selbar.is-stash #selbar-move,
    .selbar.is-stash #selbar-copy { order: 3; flex: 1 1 0; min-width: 0; overflow: hidden; text-overflow: ellipsis; }

    /* ---- Empty state --------------------------------------------------- */
    .empty-state {
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 3px;
      margin: 10px 6px 4px;
      padding: 22px 10px 18px;
      color: var(--gs-fg-muted);
      text-align: center;
    }
    .empty-state.visible { display: flex; }
    .empty-state .badge {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 38px;
      height: 38px;
      margin-bottom: 7px;
      border-radius: 50%;
      color: var(--gs-status-added);
      background: color-mix(in srgb, var(--gs-status-added) 14%, transparent);
    }
    .empty-state .badge svg { width: 20px; height: 20px; }
    .empty-state .et { font-size: 12.5px; font-weight: 600; color: var(--gs-fg); }
    .empty-state .es { font-size: 11px; color: var(--gs-fg-subtle); }

    /* ---- No-repository onboarding (re-homed from the old Commits view) --
       Scoped by #id, not .class: the BODY also carries a no-repo state class,
       so a bare .no-repo display:none would hide the whole view. */
    #no-repo {
      display: none;
      flex-direction: column;
      align-items: center;
      gap: 4px;
      margin: 26px 14px 4px;
      text-align: center;
    }
    #no-repo .badge {
      display: flex; align-items: center; justify-content: center;
      width: 44px; height: 44px; margin-bottom: 9px;
      border-radius: var(--gs-radius);
      color: var(--gs-accent-text);
      background: color-mix(in srgb, var(--gs-accent) 13%, transparent);
      border: 1px solid color-mix(in srgb, var(--gs-accent) 28%, transparent);
    }
    #no-repo .badge .codicon { font-size: 22px; }
    #no-repo .et { font-size: 14px; font-weight: 600; color: var(--gs-fg); }
    #no-repo .es { font-size: 12px; line-height: 1.5; color: var(--gs-fg-muted); max-width: 260px; }
    #no-repo .no-repo-actions { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; margin-top: 12px; }
    /* When no repo is open, the composer + change list are irrelevant — show
       only the onboarding. */
    body.no-repo .repo-bar,
    body.no-repo .composer,
    body.no-repo .changes-toolbar,
    body.no-repo .groups,
    body.no-repo #empty-state { display: none !important; }
    body.no-repo #no-repo { display: flex; }
    /* Before the first state arrives, and while repositories are still being
       discovered: a neutral "reading" state, never "Working tree clean" or
       "No repository open" said before anything was read. */
    #loading-state .badge {
      color: var(--gs-fg-muted);
      background: color-mix(in srgb, var(--gs-fg-muted) 12%, transparent);
    }
    body.no-repo #loading-state { display: none !important; }
    body.discovering .repo-bar,
    body.discovering .composer,
    body.discovering .changes-toolbar,
    body.discovering .groups,
    body.discovering #empty-state { display: none !important; }

    @media (prefers-reduced-motion: reduce) {
      textarea, .author-row input, .sparkle, button.gs-commit, .link .chev,
      .icon-btn, .group-actions, .row-actions, .twisty {
        transition: none;
      }
      .sparkle.loading .spinner { animation: none; }
    }

    /* Shared custom tooltip (viewport-fixed so nothing clips it). */
    .gs-tip {
      position: fixed; z-index: 99999; pointer-events: none;
      transform: translate(-50%, -100%);
      padding: 3px 7px;
      border-radius: var(--gs-radius-sm);
      border: 1px solid var(--gs-border);
      /* MUST be opaque — --gs-surface* are color-mix-with-transparent tints
         for cards on known backgrounds; a floating tip over arbitrary rows
         turns see-through with them and reads as a rendering glitch. */
      background: var(--vscode-editorHoverWidget-background, var(--vscode-editor-background, #2b2b2b));
      color: var(--gs-fg);
      font-family: var(--gs-font-ui); font-size: 11.5px; line-height: 1.35;
      /* Default to ONE line; showTip() measures the natural width and only
         switches to white-space:normal (wrapping) when it exceeds the viewport.
         overflow-wrap:break-word then breaks a no-space ref name if it must. */
      white-space: nowrap; overflow-wrap: break-word;
      box-shadow: var(--gs-shadow-2);
      opacity: 0; transition: opacity var(--gs-motion-fast) var(--gs-ease);
    }
    .gs-tip.below { transform: translate(-50%, 0); }
    .gs-tip.show { opacity: 1; }

    /* ---- Push review modal (confirm before every push) ------------------- */
    /* The backdrop is the centering layer: a fixed full-viewport flex box that
       centers the modal. Robust at ANY width (no fragile left:50%/translate that
       could push content off the sidebar's left edge), and the padding keeps the
       modal off the edges. */
    .push-backdrop {
      position: fixed; inset: 0; z-index: 120;
      display: flex; align-items: center; justify-content: center;
      padding: 12px; box-sizing: border-box;
      background: rgba(0, 0, 0, 0.42);
      animation: pm-fade var(--gs-motion) var(--gs-ease);
    }
    body.vscode-light .push-backdrop,
    body.vscode-high-contrast-light .push-backdrop { background: rgba(0, 0, 0, 0.22); }
    @keyframes pm-fade { from { opacity: 0; } to { opacity: 1; } }
    .push-modal {
      position: relative; z-index: 121;
      width: 100%; max-width: 560px;
      max-height: 100%;
      display: flex; flex-direction: column;
      background: var(--vscode-editorWidget-background, var(--gs-surface));
      border: 1px solid var(--vscode-editorWidget-border, var(--gs-border));
      border-radius: var(--gs-radius);
      box-shadow: var(--gs-shadow-2);
      animation: pm-pop var(--gs-motion) var(--gs-ease);
      overflow: hidden;
    }
    @keyframes pm-pop {
      from { opacity: 0; transform: scale(0.97); }
      to { opacity: 1; transform: scale(1); }
    }
    .pm-head {
      display: flex; align-items: center; gap: 8px;
      padding: 12px 14px;
      border-bottom: 1px solid var(--gs-border-soft);
    }
    .pm-head .codicon { font-size: 15px; color: var(--gs-brand); }
    .pm-title { flex: 1 1 auto; font-size: 13px; font-weight: 600; min-width: 0;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pm-title b { color: var(--gs-accent-text); }
    .pm-close {
      flex: 0 0 auto; width: 24px; height: 24px; border: none; background: transparent;
      color: var(--gs-fg-muted); border-radius: var(--gs-radius-sm); cursor: pointer;
      display: inline-flex; align-items: center; justify-content: center; font-size: 16px;
    }
    .pm-close:hover { background: var(--gs-hover-strong); color: var(--gs-fg); }
    .pm-stats {
      display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
      padding: 9px 14px; font-size: 12px; color: var(--gs-fg-muted);
      border-bottom: 1px solid var(--gs-border-soft);
      background: color-mix(in srgb, var(--gs-fg) 3%, transparent);
    }
    .pm-stat b { color: var(--gs-fg); font-variant-numeric: tabular-nums; }
    .pm-add { color: var(--gs-status-added); font-variant-numeric: tabular-nums; font-weight: 600; }
    .pm-del { color: var(--gs-status-deleted); font-variant-numeric: tabular-nums; font-weight: 600; }
    /* A rewrite is a warning, not a "you're behind" nudge — different colour,
       different icon, different remedy. */
    .pm-rewrite {
      display: inline-flex; align-items: center; gap: 4px;
      color: var(--gs-amber, var(--vscode-gitDecoration-modifiedResourceForeground));
      font-weight: 600;
    }
    .pm-btn.primary.danger {
      background: var(--gs-danger-fill);
      border-color: transparent;
      color: #fff;
    }
    .pm-behind {
      margin-left: auto; color: var(--gs-amber); font-weight: 600;
      display: inline-flex; align-items: center; gap: 4px;
    }
    .pm-behind .codicon { color: var(--gs-amber); font-size: 12px; }
    /* The commit and file rows are the shared ones (changeRows.css, inlined
       above): .cr-section-label, .cr-commit, .cr-file. */
    .pm-body { overflow-y: auto; padding: 4px 6px 8px; }
    .pm-where {
      display: flex; align-items: center; gap: 6px;
      padding: 7px 14px; font-size: 11.5px; color: var(--gs-fg-muted);
      border-bottom: 1px solid var(--gs-border-soft);
    }
    .pm-where span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .pm-where .codicon { flex: 0 0 auto; font-size: 13px; }
    .pm-error {
      margin: 4px 8px 0; padding: 7px 9px; font-size: 11.5px;
      color: var(--vscode-errorForeground, #e15a5a);
      background: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 12%, transparent);
      border-radius: var(--gs-radius-sm); white-space: pre-wrap;
    }
    .pm-foot {
      display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
      padding: 12px 14px;
      border-top: 1px solid var(--gs-border-soft);
      background: color-mix(in srgb, var(--gs-fg) 2.5%, transparent);
    }
    /* The two "instead of pushing" alternatives group on the left; Cancel + Push
       stay on the right. When the modal is too narrow (the Changes sidebar), the
       whole footer WRAPS so nothing clips — the alt group drops to its own row. */
    .pm-foot-alt { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-right: auto; }
    .pm-foot .spacer { flex: 1 1 auto; }
    .pm-btn {
      flex: 0 0 auto; /* never grow/shrink — natural content width in any modal size */
      height: 32px; padding: 0 16px; border-radius: var(--gs-radius);
      border: 1px solid transparent;
      font-family: var(--gs-font-ui); font-size: 12.5px; font-weight: 500;
      cursor: pointer; white-space: nowrap;
      display: inline-flex; align-items: center; justify-content: center; gap: 6px;
      transition: background var(--gs-motion-fast) var(--gs-ease),
                  border-color var(--gs-motion-fast) var(--gs-ease),
                  color var(--gs-motion-fast) var(--gs-ease),
                  filter var(--gs-motion-fast) var(--gs-ease),
                  box-shadow var(--gs-motion-fast) var(--gs-ease),
                  transform var(--gs-motion-fast) var(--gs-ease);
    }
    .pm-btn .codicon { font-size: 14px; }
    .pm-btn:active { transform: translateY(1px); }
    .pm-btn:focus-visible { outline: 2px solid var(--gs-accent); outline-offset: 2px; }
    .pm-btn:disabled { opacity: 0.45; cursor: default; filter: none; box-shadow: none; transform: none; }

    /* Cancel — a clean neutral secondary. */
    .pm-btn.secondary {
      color: var(--gs-fg);
      background: color-mix(in srgb, var(--gs-fg) 7%, transparent);
      border-color: var(--gs-border);
    }
    .pm-btn.secondary:hover {
      background: color-mix(in srgb, var(--gs-fg) 13%, transparent);
      border-color: var(--gs-fg-subtle);
    }

    /* Undo local commits — a subtle destructive ghost that asserts its danger
       only on hover, so it never competes with the primary Push action. */
    .pm-btn.danger {
      color: var(--gs-fg-muted); background: transparent; border-color: transparent; font-weight: 400;
    }
    .pm-btn.danger:hover {
      color: var(--vscode-errorForeground, #e15a5a);
      background: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 13%, transparent);
      border-color: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 30%, transparent);
    }

    /* New branch — a neutral ghost alternative that firms up on hover. */
    .pm-btn.ghost {
      color: var(--gs-fg-muted); background: transparent; border-color: transparent; font-weight: 400;
    }
    .pm-btn.ghost:hover {
      color: var(--gs-fg);
      background: color-mix(in srgb, var(--gs-fg) 10%, transparent);
      border-color: var(--gs-border);
    }

    /* Push — the hero action: brand gradient, a gentle lift + glow on hover. */
    .pm-btn.primary {
      color: var(--gs-brand-fg); font-weight: 600; padding: 0 18px;
      border-color: var(--gs-brand);
      background: linear-gradient(180deg, color-mix(in srgb, var(--gs-brand) 88%, white 12%), var(--gs-brand));
      box-shadow: var(--gs-shadow-1), inset 0 1px 0 color-mix(in srgb, white 22%, transparent);
    }
    .pm-btn.primary:hover {
      filter: brightness(1.08);
      transform: translateY(-1px);
      box-shadow: var(--gs-shadow-2), inset 0 1px 0 color-mix(in srgb, white 28%, transparent);
    }
    .pm-btn.primary:active { transform: translateY(0); filter: brightness(0.95); }
    /* While pushing: keep the button vivid (not greyed like :disabled) with a
       gentle breathing glow, and spin the arrow — same footprint as "Push", no
       width jump. Mirrors the header pull/push pills. */
    .pm-btn.primary.loading {
      opacity: 1; cursor: default; transform: none;
      animation: pm-breathe 1.5s ease-in-out infinite;
    }
    .pm-btn.primary.loading:hover { transform: none; }
    @keyframes pm-breathe {
      0%, 100% { filter: brightness(1); box-shadow: var(--gs-shadow-1), inset 0 1px 0 color-mix(in srgb, white 22%, transparent); }
      50% { filter: brightness(1.13); box-shadow: var(--gs-shadow-2), 0 0 0 3px color-mix(in srgb, var(--gs-brand) 22%, transparent), inset 0 1px 0 color-mix(in srgb, white 28%, transparent); }
    }
    .pm-btn .codicon { font-size: 13px; }
    .pm-btn .codicon-modifier-spin { animation: codicon-spin 1s steps(12) infinite; }

    /* ---- Operation banner: a stopped merge / rebase / cherry-pick ------- */
    /* Toned by what the stop needs: amber while something is in the way
       (conflicts, or a stop git cannot continue from), the accent once
       nothing is. It was conflict-red in every state — "Every conflict is
       resolved." sat in an error box. */
    .op-banner {
      --op-tone: var(--gs-amber);
      display: flex;
      flex-direction: column;
      gap: 4px;
      margin: 0 2px 10px;
      padding: 8px 10px 10px;
      border-radius: var(--gs-radius-sm);
      border: 1px solid color-mix(in srgb, var(--op-tone) 50%, transparent);
      background: color-mix(in srgb, var(--op-tone) 9%, transparent);
    }
    .op-banner.tone-ready { --op-tone: var(--gs-accent); }
    body.vscode-high-contrast .op-banner {
      background: transparent;
      border-color: var(--vscode-contrastBorder, var(--op-tone));
    }
    .op-banner[hidden] { display: none; }
    .op-title {
      display: flex;
      align-items: flex-start;
      gap: 6px;
      font-size: 12px;
      font-weight: 600;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .op-title .codicon { flex: 0 0 auto; margin-top: 1px; color: var(--op-tone); }
    .op-banner.tone-ready .op-title .codicon { color: var(--gs-accent-text); }
    /* The step, the direction and the note sit under the title's text, not
       under its icon. */
    .op-step,
    .op-direction,
    .op-note {
      padding-left: 22px;
      font-size: 11.5px;
      line-height: 1.35;
      overflow-wrap: anywhere;
    }
    .op-step { color: var(--gs-fg-muted); }
    .op-direction,
    .op-note { color: var(--gs-fg); }
    .op-actions {
      display: flex;
      flex-wrap: nowrap;
      gap: 6px;
      margin-top: 4px;
    }
    .op-actions button.gs-commit {
      flex: 0 0 auto;
      min-width: 0;
      height: 24px;
      padding: 0 10px;
      font-size: 12px;
      white-space: nowrap;
    }
    .op-actions .lbl-short { display: none; }
    .op-actions .lbl-long,
    .op-actions .lbl-short { overflow: hidden; text-overflow: ellipsis; }
    /* Too narrow for them all: the lead on its own row, the rest sharing the
       next one equally, by their first word. */
    .op-actions.stacked { flex-wrap: wrap; }
    .op-actions.stacked .op-lead { flex: 1 0 100%; }
    /* Equal shares while there is room; never less than a word needs. */
    .op-actions.stacked button.gs-commit:not(.op-lead) { flex: 1 1 0; min-width: max-content; }
    .op-actions.stacked button.gs-commit:not(.op-lead) .lbl-long { display: none; }
    .op-actions.stacked button.gs-commit:not(.op-lead) .lbl-short { display: inline; }
  </style>
</head>
<body class="layout-list">
  <header class="repo-bar">
    <button class="repo" id="repo-pill" type="button" aria-haspopup="dialog" hidden>
      <i class="codicon codicon-repo" aria-hidden="true"></i>
      <span class="repo-name" id="repo-name"></span>
      <i class="codicon codicon-chevron-down repo-caret" aria-hidden="true"></i>
    </button>
    <button class="branch" id="branch-pill" type="button" title="Branch &amp; actions"
      aria-haspopup="true" aria-expanded="false">
      <i class="codicon codicon-git-branch" aria-hidden="true"></i>
      <span class="branch-name" id="branch-name">—</span>
      <i class="codicon codicon-chevron-down branch-caret" aria-hidden="true"></i>
    </button>
    <span class="sync hidden" id="sync">
      <button class="sync-pill ahead" id="ahead" type="button"
        title="Push these commits to the upstream" aria-label="Push commits">
        <i class="codicon codicon-arrow-up" aria-hidden="true"></i>
        <span class="sync-verb">Push</span>
        <span id="ahead-n">0</span>
      </button>
      <button class="sync-pill behind" id="behind" type="button"
        title="Pull these commits from the upstream" aria-label="Pull commits">
        <i class="codicon codicon-arrow-down" aria-hidden="true"></i>
        <span class="sync-verb">Pull</span>
        <span id="behind-n">0</span>
      </button>
      <span class="sync-clean" id="sync-clean" title="Up to date with upstream" role="img" aria-label="Up to date with upstream">
        <i class="codicon codicon-check" aria-hidden="true"></i>
        <span>up to date</span>
      </span>
    </span>
  </header>

  <div class="op-banner" id="op-banner" role="status" hidden></div>

  <div class="composer">
  <div class="message-wrap">
    <textarea id="message" rows="1"
      placeholder="Message (what & why)…"
      aria-label="Commit message"></textarea>
    <button class="sparkle" id="generate" type="button"
      title="Generate commit message with AI"
      aria-label="Generate commit message">
      <i class="codicon codicon-sparkle glyph" aria-hidden="true"></i>
      <i class="codicon codicon-loading spinner" aria-hidden="true"></i>
    </button>
    <button class="sparkle review" id="review" type="button"
      title="Review changes with AI"
      aria-label="Review changes with AI">
      <i class="codicon codicon-code-review glyph" aria-hidden="true"></i>
    </button>
    <button class="sparkle connect" id="connect-ai" type="button"
      title="Connect an AI provider — powers commit messages &amp; code review"
      aria-label="Connect AI">
      <i class="codicon codicon-plug glyph" aria-hidden="true"></i>
    </button>
    <div class="composer-foot">
      <span class="counter" id="counter" aria-hidden="true"></span>
    </div>
  </div>

  <div class="toggles">
    <label><input type="checkbox" id="amend" /> Amend</label>
    <label><input type="checkbox" id="signoff" /> Sign-off</label>
    <button class="link" id="author-toggle" type="button" aria-expanded="false"
      aria-controls="author-row">
      Author
      <i class="codicon codicon-chevron-down chev" aria-hidden="true"></i>
    </button>
  </div>

  <div class="author-row hidden" id="author-row">
    <input id="author" type="text"
      placeholder="Author override — Name &lt;email@example.com&gt;"
      aria-label="Author override" />
  </div>

  <div class="actions">
    <button class="gs-commit split commit-btn" id="commit" type="button" aria-label="Commit">
      <i class="codicon codicon-git-commit glyph" aria-hidden="true"></i>
      <i class="codicon codicon-loading spin" aria-hidden="true"></i>
      <span id="commit-label">Commit</span>
    </button>
    <button class="gs-commit primary main-btn" id="commit-push" type="button" aria-label="Commit and Push">
      <i class="codicon codicon-arrow-up glyph" aria-hidden="true"></i>
      <i class="codicon codicon-loading spin" aria-hidden="true"></i>
      <span id="main-label">Commit &amp; Push</span>
    </button>
  </div>
  </div>

  <div class="changes-toolbar">
    <span class="changes-title">Changed Files</span>
    <span class="changes-total" id="changes-total">0</span>
    <span class="toolbar-spacer"></span>
    <span class="toolbar-actions">
      <button class="icon-btn layout" id="layout-toggle" type="button"
        title="View as Tree" aria-label="View as Tree">
        <i class="codicon codicon-list-tree to-tree" aria-hidden="true"></i>
        <i class="codicon codicon-list-flat to-list" aria-hidden="true"></i>
      </button>
      <button class="icon-btn model" id="model-toggle" type="button"
        title="Switch to checkboxes" aria-label="Switch to checkboxes">
        <i class="codicon codicon-checklist to-checks" aria-hidden="true"></i>
        <i class="codicon codicon-list-selection to-split" aria-hidden="true"></i>
      </button>
      <button class="icon-btn stage-all-top" id="stage-all-top" type="button"
        title="Stage All Changes" aria-label="Stage All Changes">
        <i class="codicon codicon-add" aria-hidden="true"></i>
      </button>
      <button class="icon-btn stash-btn" id="stash-changes" type="button"
        title="Stash all changes…" aria-label="Stash all changes…">
        <i class="codicon codicon-git-stash" aria-hidden="true"></i>
      </button>
      <button class="icon-btn collapse-all" id="collapse-all" type="button"
        title="Collapse All Folders" aria-label="Collapse All Folders">
        <i class="codicon codicon-collapse-all" aria-hidden="true"></i>
      </button>
      <button class="icon-btn refresh" id="refresh" type="button"
        title="Refresh" aria-label="Refresh">
        <i class="codicon codicon-refresh" aria-hidden="true"></i>
      </button>
    </span>
  </div>

  <!-- One tree: group headers, folders, files and a file's changes are its
       treeitems, with ONE tab stop that the arrow keys move (a roving
       tabindex). The row buttons stay for the pointer; the keyboard reaches
       the same actions through the row's menu (Shift+F10). The Stashes
       group below the clean-tree note is part of it (aria-owns). -->
  <div class="groups" id="groups" role="tree" aria-label="Changed files" aria-multiselectable="true" aria-owns="stashes"></div>

  <!-- Selection bar: only present while a multi-selection exists, so the view
       is unchanged for anyone who never selects. -->
  <div class="selbar" id="selbar" hidden>
    <span class="selbar-count" id="selbar-count"></span>
    <span class="selbar-actions">
      <button type="button" class="selbar-btn" id="selbar-stash">Stash</button>
      <button type="button" class="selbar-btn" id="selbar-stage">Stage</button>
      <button type="button" class="selbar-btn" id="selbar-move" hidden>Move to Changes</button>
      <button type="button" class="selbar-btn" id="selbar-copy" hidden>Copy to Changes</button>
      <button type="button" class="selbar-btn" id="selbar-clear">Clear</button>
    </span>
  </div>

  <div class="empty-state" id="empty-state">
    <span class="badge">
      <i class="codicon codicon-check" aria-hidden="true"></i>
    </span>
    <span class="et">Working tree clean</span>
    <span class="es">No changes to commit.</span>
  </div>

  <div class="empty-state visible" id="loading-state" role="status">
    <span class="badge">
      <i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>
    </span>
    <span class="et" id="loading-text">Reading changes…</span>
  </div>

  <!-- The Stashes group: after the file groups and the clean-tree note, so a
       clean tree still reads "Working tree clean" first. No stashes, no group.
       Its rows are treeitems of the list's tree (#groups owns it), and share
       its one tab stop and its arrows. -->
  <div class="groups stash-groups" id="stashes" role="none" hidden></div>

  <div class="no-repo" id="no-repo">
    <span class="badge">
      <i class="codicon codicon-source-control" aria-hidden="true"></i>
    </span>
    <span class="et">No repository open</span>
    <span class="es">Open a folder that's under Git to see your changes, branches, and history.</span>
    <div class="no-repo-actions">
      <button class="gs-commit primary" id="open-folder" type="button">
        <i class="codicon codicon-folder-opened" aria-hidden="true"></i>
        <span>Open Folder…</span>
      </button>
      <button class="gs-commit split" id="open-graph" type="button">
        <i class="codicon codicon-git-commit" aria-hidden="true"></i>
        <span>Commit Graph</span>
      </button>
    </div>
  </div>

  <script nonce="${nonce}" src="${changeRowsUri}"></script>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const $ = (id) => document.getElementById(id);
    const message = $("message");
    const amend = $("amend");
    const signoff = $("signoff");
    const authorRow = $("author-row");
    const author = $("author");
    const commitBtn = $("commit");
    const pushBtn = $("commit-push");
    const mainLabel = $("main-label");
    const generateBtn = $("generate");
    const commitLabel = $("commit-label");
    const authorToggle = $("author-toggle");
    const groupsEl = $("groups");
    const stashesEl = $("stashes");
    const selbarEl = $("selbar");
    const selbarCount = $("selbar-count");
    const selbarStashBtn = $("selbar-stash");
    const selbarStageBtn = $("selbar-stage");
    const selbarMoveBtn = $("selbar-move");
    const selbarCopyBtn = $("selbar-copy");
    const emptyEl = $("empty-state");
    const loadingEl = $("loading-state");
    const loadingText = $("loading-text");
    // Nothing has been read until the host's first state: until then the
    // list is not "clean", it is unknown (the reading state shows instead).
    let stateSeen = false;
    const layoutToggle = $("layout-toggle");
    const modelToggle = $("model-toggle");
    const collapseAllBtn = $("collapse-all");
    const stageAllTopBtn = $("stage-all-top");
    const stashChangesBtn = $("stash-changes");
    const refreshBtn = $("refresh");
    const repoPill = $("repo-pill");
    const repoNameEl = $("repo-name");
    const branchPill = $("branch-pill");
    const branchName = $("branch-name");
    const syncEl = $("sync");
    const aheadEl = $("ahead");
    const behindEl = $("behind");
    const aheadN = $("ahead-n");
    const behindN = $("behind-n");
    const syncClean = $("sync-clean");
    const counterEl = $("counter");
    const messageWrap = message.closest(".message-wrap");
    const changesTotal = $("changes-total");

    // ---- Live sync (pull/push/fetch run with in-place spinners) ----------
    let syncBusy = "";      // "" | "pull" | "push" — an op is in flight
    let menuSyncBusy = "";  // quick action (fetch/pull/push) running IN the menu
    let subLive = null;     // { action, ref } — a submenu item running in place
    let subMenuFor = null;  // { name, kind, current } — which branch's submenu is open
    let branchBackdrop = null; // scrim behind the branch dialog stack
    let lastHeaderState = null; // last state renderHeader painted (for restore)
    function pillIcon(pill, name, spin) {
      const i = pill.querySelector(".codicon");
      if (i) i.className = "codicon codicon-" + name + (spin ? " codicon-modifier-spin" : "");
    }
    function applySyncBusy() {
      behindEl.disabled = !!syncBusy;
      aheadEl.disabled = !!syncBusy;
      if (syncBusy === "pull") { behindEl.classList.add("visible"); pillIcon(behindEl, "loading", true); }
      else pillIcon(behindEl, "arrow-down", false);
      if (syncBusy === "push") { aheadEl.classList.add("visible"); pillIcon(aheadEl, "loading", true); }
      else pillIcon(aheadEl, "arrow-up", false);
    }
    function startSync(action) {
      if (syncBusy) return;
      syncBusy = action;
      applySyncBusy();
      vscode.postMessage({ type: "branchAction", action: action });
    }
    behindEl.addEventListener("click", () => startSync("pull"));
    // Push always opens the review modal first (see openPushModal) — never a
    // silent one-click push. Pull stays instant.
    aheadEl.addEventListener("click", () => {
      if (syncBusy) return;
      vscode.postMessage({ type: "requestPushPreview" });
    });

    let stagedCount = 0;
    let stagingModel = "split";
    // Per-hunk ticks (#20). expandedHunks holds the paths whose changes are
    // showing; hunkCache holds what the host last said about each. Both are
    // keyed by path, and the host re-sends after every stage because hunk
    // indexes are positional — they mean nothing once the file's state moves.
    const expandedHunks = new Set();
    const hunkCache = new Map();
    // path -> a function that rebuilds JUST that file's open changes panel in
    // place. The host's "hunks" reply used to call render(), rebuilding the
    // entire Changes view to fill in one panel — which is why the first click
    // on a file lagged even though opening it is now local: the click was
    // instant, and then the reply repainted everything.
    const hunkPanels = new Map();
    // Multi-selection, for stashing / staging several files at once.
    //
    // Keyed by "kind:path", not by path. In the split model a partly staged file
    // appears TWICE — once under Staged, once under Unstaged — and those two rows
    // mean different things: staging one is a no-op, stashing the other is not.
    // A path-keyed set would select both from one click and act on the wrong half.
    //
    // Held here rather than in the DOM because render() clears groupsEl and
    // rebuilds from scratch on every host push, exactly like expandedHunks.
    const selectedRows = new Set();
    // The row a shift-range extends FROM. Null until something is clicked.
    let selectionAnchor = null;
    // Visual order of selectable rows, rebuilt by render(), so a shift-range
    // covers what the user actually sees — tree or flat, one group or three.
    let rowOrder = [];
    const rowKey = (kind, path) => kind + ":" + path;
    // A stash's files select the same way, keyed "stash:<sha>:<path>", in
    // their own order. A selection lives in ONE place — the working tree's
    // rows, or one stash's files — because what can be done with it differs:
    // clicking into the other place starts a new selection there.
    let stashRowOrder = [];
    const stashKey = (sha, path) => "stash:" + sha + ":" + path;
    function selScope(key) {
      return key.indexOf("stash:") === 0 ? key.slice(0, key.indexOf(":", 6)) : "tree";
    }
    function orderOf(key) {
      return key.indexOf("stash:") === 0 ? stashRowOrder : rowOrder;
    }

    // ---- Keyed rows: the list is PATCHED, never rebuilt -----------------
    //
    // Every click that moves a file (Stage, Unstage, a tick) used to clear the
    // whole list and build every row again — 55,000 elements at 5,000 files,
    // and the focused row, its hover and its tooltip timer thrown away each
    // time. Now each row is kept by a key and a signature of everything its
    // DOM and its handlers were built from: a render reuses the row whose
    // signature still matches, builds only the rows that changed, and moves
    // nodes into place — so one Stage builds one row, not the list.
    //
    // What changes without rebuilding (selection, a group's count, whether a
    // group or folder is open) is painted onto the kept row on every render.
    let rowCache = new Map();
    let nextRowCache = new Map();
    function keep(key, sig, build) {
      const hit = rowCache.get(key);
      const node = hit && hit.sig === sig ? hit.node : build();
      nextRowCache.set(key, { sig: sig, node: node });
      return node;
    }
    /** Make parent's children exactly nodes, in order, moving only what is out of place. */
    function patchChildren(parent, nodes) {
      let cur = parent.firstChild;
      for (let i = 0; i < nodes.length; i++) {
        const n = nodes[i];
        if (n === cur) { cur = cur.nextSibling; continue; }
        parent.insertBefore(n, cur);
      }
      while (cur) {
        const next = cur.nextSibling;
        parent.removeChild(cur);
        cur = next;
      }
    }
    function setAttr(node, name, value) {
      if (node.getAttribute(name) !== value) node.setAttribute(name, value);
    }
    function countWords(n, one, many) {
      return n === 1 ? "1 " + (one || "file") : n + " " + (many || "files");
    }

    // ---- The tree from the keyboard: one tab stop, arrows move it ---------
    //
    // Every row, tick and row button was its own tab stop — 46 of them for six
    // files — and no arrow key did anything. The list is a tree now: Tab
    // reaches it once, Up/Down/Home/End move through what is showing,
    // Right/Left open and close a group, a folder or a file's changes (or step
    // in and out of one), Enter opens, Space ticks in the checkbox model,
    // Shift+Up/Down extends the selection and Shift+F10 opens a row's menu.
    let activeTKey = null;  // the treeitem that holds the one tab stop
    let rovingEl = null;
    function itemOf(node) {
      return node && node.closest ? node.closest('[role="treeitem"]') : null;
    }
    /**
     * Whether a person can see this treeitem: not inside a closed group, and
     * not in an empty one — an empty group is not drawn (.group.empty), but
     * its header is still in the DOM. Counting that header put the list's
     * only tab stop on something nobody could see whenever nothing was staged,
     * so Tab never reached the list at all.
     */
    function shownItem(it) {
      return !!it && !it.closest(".group.empty, .group.collapsed .group-body");
    }
    // The Stashes group is part of the same tree (the list's aria-owns): it
    // sits after the "Working tree clean" note, so it has a box of its own,
    // but the arrows walk from the last changed file into it and back.
    const TREE_ITEMS = '#groups [role="treeitem"], #stashes [role="treeitem"]';
    const treeEls = [groupsEl, stashesEl];
    /** The treeitems a person can see, top to bottom. */
    function treeItems() {
      const all = document.querySelectorAll(TREE_ITEMS);
      const out = [];
      for (let i = 0; i < all.length; i++) {
        if (shownItem(all[i])) out.push(all[i]);
      }
      return out;
    }
    function itemByTKey(tkey) {
      if (!tkey) return null;
      const sel = '[data-tkey="' + CSS.escape(tkey) + '"]';
      return groupsEl.querySelector(sel) || stashesEl.querySelector(sel);
    }
    function levelOf(it) { return Number(it.getAttribute("aria-level") || "1"); }
    /**
     * Put the one tab stop on the active item — or its closed group's
     * header, or, when neither can be seen, the first item that can. With
     * nothing to see, the list has no tab stop.
     */
    function applyRoving() {
      let target = itemByTKey(activeTKey);
      if (target && target.closest(".group.collapsed .group-body")) {
        target = target.closest(".group").querySelector(".group-header");
      }
      if (!shownItem(target)) target = treeItems()[0] || null;
      if (rovingEl && rovingEl !== target) rovingEl.tabIndex = -1;
      rovingEl = target;
      if (target && target.tabIndex !== 0) target.tabIndex = 0;
    }
    function focusItem(it) {
      if (!it) return;
      activeTKey = it.dataset.tkey || null;
      applyRoving();
      it.focus({ preventScroll: true });
      it.scrollIntoView({ block: "nearest" });
    }
    treeEls.forEach((t) => t.addEventListener("focusin", (ev) => {
      const it = itemOf(ev.target);
      if (!it || it.dataset.tkey === activeTKey) return;
      activeTKey = it.dataset.tkey || null;
      applyRoving();
    }));
    // A click on a row's own button or tick acts, and leaves the keyboard on
    // the row — never on a control that is not in the tab order.
    treeEls.forEach((t) => t.addEventListener("mousedown", (ev) => {
      const it = itemOf(ev.target);
      if (!it || ev.target === it) return;
      const ctl = ev.target.closest ? ev.target.closest("button, input") : null;
      if (!ctl || !it.contains(ctl)) return;
      ev.preventDefault();
      activeTKey = it.dataset.tkey || null;
      applyRoving();
      it.focus({ preventScroll: true });
    }));
    /**
     * Shift+Up/Down: the selection runs from its anchor to the file row the
     * keyboard lands on — inside one place only (the working tree's rows, or
     * one stash's files), as a Shift-click's range does.
     */
    function selectThrough(from, to) {
      if (!to || !to.dataset.key) return;
      const scope = selScope(to.dataset.key);
      if (selectionAnchor && selScope(selectionAnchor) !== scope) selectionAnchor = null;
      if (!selectionAnchor && from && from.dataset.key && selScope(from.dataset.key) === scope) {
        selectionAnchor = from.dataset.key;
      }
      if (!selectionAnchor) selectionAnchor = to.dataset.key;
      const order = orderOf(to.dataset.key);
      const a = order.indexOf(selectionAnchor);
      const b = order.indexOf(to.dataset.key);
      if (a === -1 || b === -1) return;
      selectedRows.clear();
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selectedRows.add(order[i]);
      paintSelection();
    }
    function onTreeKey(ev) {
      const it = itemOf(ev.target);
      if (!it || ev.altKey) return;
      const k = ev.key;
      const mod = ev.ctrlKey || ev.metaKey;
      if (k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End" ||
          k === "PageDown" || k === "PageUp") {
        const items = treeItems();
        const i = items.indexOf(it);
        // A page is what the view shows (the page scrolls, not the list).
        const page = Math.max(1, Math.floor(window.innerHeight / 24) - 1);
        const to = k === "ArrowDown" ? i + 1 : k === "ArrowUp" ? i - 1
          : k === "Home" ? 0 : k === "End" ? items.length - 1
          : k === "PageDown" ? i + page : i - page;
        const next = items[Math.max(0, Math.min(items.length - 1, to))];
        ev.preventDefault();
        if (!next) return;
        if (ev.shiftKey && (k === "ArrowDown" || k === "ArrowUp")) selectThrough(it, next);
        focusItem(next);
        return;
      }
      if (mod && (k === "a" || k === "A") && ev.target === it) {
        ev.preventDefault();
        // In the Stashes group: the files of the stash the keyboard is in.
        if (stashesEl.contains(it)) {
          if (it.dataset.sha) selectStashFiles(it.dataset.sha);
          return;
        }
        selectedRows.clear();
        for (let i = 0; i < rowOrder.length; i++) selectedRows.add(rowOrder[i]);
        selectionAnchor = rowOrder.length ? rowOrder[0] : null;
        paintSelection();
        return;
      }
      // Enter, Space and the arrows sideways on a row's own button or tick
      // belong to that control.
      if (ev.target !== it || mod) return;
      // Shift+F10 or the menu key: the row's menu — a file's, a folder's or
      // a group's — which is the keyboard's way to the row's buttons.
      if (k === "ContextMenu" || (ev.shiftKey && k === "F10")) {
        if (it.__menu) it.__menu(ev);
        else ev.preventDefault();
        return;
      }
      const expanded = it.getAttribute("aria-expanded");
      if (k === "ArrowRight") {
        ev.preventDefault();
        if (expanded === "false" && it.__expand) { it.__expand(true); return; }
        if (expanded === "true") {
          const items = treeItems();
          const child = items[items.indexOf(it) + 1];
          if (child && levelOf(child) > levelOf(it)) focusItem(child);
        }
        return;
      }
      if (k === "ArrowLeft") {
        ev.preventDefault();
        if (expanded === "true" && it.__expand) { it.__expand(false); return; }
        const items = treeItems();
        const lvl = levelOf(it);
        for (let j = items.indexOf(it) - 1; j >= 0; j--) {
          if (levelOf(items[j]) < lvl) { focusItem(items[j]); return; }
        }
        return;
      }
      if ((k === "Enter" || k === " ") && it.__activate) {
        ev.preventDefault();
        it.__activate(k === " " ? "space" : "enter");
      }
    }
    treeEls.forEach((t) => t.addEventListener("keydown", onTreeKey));

    /** Paint selection onto the DOM without a full render(), so clicks feel instant. */
    function paintSelection() {
      const rows = document.querySelectorAll("#groups .row.is-file, #stashes .row.is-file");
      for (let i = 0; i < rows.length; i++) paintRowSelected(rows[i]);
      updateSelectionBar();
      updateSelectionChrome();
    }
    /** One file row's selected state: its class, and what a screen reader hears. */
    function paintRowSelected(r) {
      const on = selectedRows.has(r.dataset.key);
      if (r.classList.contains("is-selected") !== on) r.classList.toggle("is-selected", on);
      // In a multi-select tree every selectable item says whether it is
      // selected, not only the selected ones.
      const want = on ? "true" : "false";
      if (r.getAttribute("aria-selected") !== want) r.setAttribute("aria-selected", want);
    }

    function clearSelection() {
      selectedRows.clear();
      selectionAnchor = null;
      paintSelection();
    }

    /** The selected rows as {path, kind}, in the order they appear on screen. */
    function selectionEntries() {
      const out = [];
      for (let i = 0; i < rowOrder.length; i++) {
        const k = rowOrder[i];
        if (!selectedRows.has(k)) continue;
        const cut = k.indexOf(":");
        out.push({ kind: k.slice(0, cut), path: k.slice(cut + 1) });
      }
      return out;
    }

    /** Distinct paths in the selection — what git actually needs. */
    function selectionPaths() {
      const seen = [];
      const entries = selectionEntries();
      for (let i = 0; i < entries.length; i++) {
        if (seen.indexOf(entries[i].path) === -1) seen.push(entries[i].path);
      }
      return seen;
    }

    /**
     * Selection on click, with the modifiers everyone already expects.
     *
     * Returns true when the click was a SELECTION gesture and the row's normal
     * action (opening the diff) should not also happen. A plain click is not a
     * selection gesture: it clears any selection and opens, exactly as before,
     * so nothing about the view changes for anyone who never shift-clicks.
     */
    function handleSelectionClick(ev, key) {
      // A selection gesture in the other place (the working tree's rows, or
      // another stash's files) starts over there. The row a Shift-range runs
      // from goes too, even with nothing selected: a plain click leaves it
      // behind, and a range from it would run through two stashes — whose
      // files the bar would then credit to one of them.
      const scope = selScope(key);
      if (selectionAnchor && selScope(selectionAnchor) !== scope) selectionAnchor = null;
      if (selectedRows.size > 0 && (ev.shiftKey || ev.ctrlKey || ev.metaKey)) {
        const first = selectedRows.values().next().value;
        if (selScope(first) !== scope) selectedRows.clear();
      }
      if (ev.shiftKey && selectionAnchor) {
        const order = orderOf(key);
        const a = order.indexOf(selectionAnchor);
        const b = order.indexOf(key);
        if (a !== -1 && b !== -1) {
          selectedRows.clear();
          const lo = Math.min(a, b), hi = Math.max(a, b);
          for (let i = lo; i <= hi; i++) selectedRows.add(order[i]);
          paintSelection();
          return true;
        }
      }
      if (ev.ctrlKey || ev.metaKey) {
        if (selectedRows.has(key)) selectedRows.delete(key);
        else selectedRows.add(key);
        selectionAnchor = key;
        paintSelection();
        return true;
      }
      // Plain click: the selection is over.
      if (selectedRows.size > 0) {
        selectedRows.clear();
        paintSelection();
      }
      selectionAnchor = key;
      return false;
    }

    /** The context menu for a multi-row selection. Counts are files, not rows. */
    function multiItems() {
      const entries = selectionEntries();
      const paths = selectionPaths();
      const n = paths.length;
      const label = n === 1 ? "1 File" : String(n) + " Files";
      const stageable = entries.filter((en) => en.kind !== "staged");
      const unstageable = entries.filter((en) => en.kind === "staged");
      const items = [];
      items.push({ icon: "git-stash", label: "Stash " + label,
        fn: () => { vscode.postMessage({ type: "stashPaths", paths: paths }); clearSelection(); } });
      items.push({ sep: true });
      // ONE message per action, never one per file. Per-file messages ran
      // their git commands together, so all but one found the index locked and
      // failed; and each Discard opened its own confirm, which dismissed the
      // one before it, so only the last file was ever discarded.
      if (stageable.length > 0) {
        items.push({ icon: "add", label: "Stage " + (stageable.length === 1 ? "1 File" : String(stageable.length) + " Files"),
          fn: () => {
            const paths = stageable.map((en) => en.path);
            queueFiles(paths, "stage");
            vscode.postMessage({ type: "stagePaths", paths: paths });
            clearSelection();
          } });
      }
      if (unstageable.length > 0) {
        items.push({ icon: "remove", label: "Unstage " + (unstageable.length === 1 ? "1 File" : String(unstageable.length) + " Files"),
          fn: () => {
            const paths = unstageable.map((en) => en.path);
            queueFiles(paths, "unstage");
            vscode.postMessage({ type: "unstagePaths", paths: paths });
            clearSelection();
          } });
      }
      const discardable = entries.filter((en) => en.kind === "unstaged");
      if (discardable.length > 0) {
        items.push({ sep: true });
        // The host confirms before discarding; this only asks for it.
        items.push({ icon: "discard", label: "Discard " + (discardable.length === 1 ? "1 File" : String(discardable.length) + " Files"), danger: true,
          fn: () => {
            vscode.postMessage({ type: "discardPaths", paths: discardable.map((en) => en.path) });
            clearSelection();
          } });
      }
      items.push({ sep: true });
      items.push({ icon: "close", label: "Clear Selection", fn: clearSelection });
      return items;
    }

    function updateSelectionBar() {
      const n = selectedRows.size;
      selbarEl.hidden = n === 0;
      if (n === 0) return;
      // A stash's files: the bar sits under the stash group and offers what
      // can be done with them. The working tree's: under the file groups.
      const st = stashSelection();
      selbarEl.classList.toggle("is-stash", !!st);
      selbarStashBtn.hidden = !!st;
      selbarStageBtn.hidden = !!st;
      selbarMoveBtn.hidden = !st;
      selbarCopyBtn.hidden = !st;
      if (st) {
        const s = authStashes.find((x) => x.sha === st.sha);
        selbarCount.textContent = (st.paths.length === 1 ? "1 file" : String(st.paths.length) + " files") +
          (s ? " from “" + s.text + "”" : "");
        // Their tips say where these files come back, as the rows' do.
        const files = stashFilesOf({ sha: st.sha }, st.paths);
        for (const [b, tip] of [[selbarMoveBtn, tipMove(files)], [selbarCopyBtn, tipCopy(files)]]) {
          b.dataset.tip = tip;
          b.setAttribute("aria-description", tip);
        }
        if (selbarEl.previousElementSibling !== stashesEl) stashesEl.after(selbarEl);
        return;
      }
      if (selbarEl.previousElementSibling !== groupsEl) groupsEl.after(selbarEl);
      const files = selectionPaths().length;
      selbarCount.textContent = files === 1 ? "1 file selected" : String(files) + " files selected";
    }

    function updateSelectionChrome() { syncStashButtonLabel(); }

    // ---- Drag and drop: the working tree and the Stashes group ------------
    // Stashes and changes share this view, so a drag goes straight from one
    // to the other — the menus' Apply, Pop, Move, Copy and Stash, by hand:
    //   a stash               → the working tree (or its clean note): Apply (Alt: Pop)
    //   its files, a folder   → the same place: Move (Alt: Copy)
    //   working-tree files    → the Stashes group: stash exactly those
    // The working tree is ONE place, however many groups it shows: what
    // comes back comes back as it was stashed (staged changes staged), so no
    // one group — Staged, say — may look like it decides where.
    // It posts what the menus post, so the same doors answer (Stash & Retry,
    // the staging question, conflicts, Undo). A single stash takes nothing:
    // git cannot add to a stash, so files go to the GROUP — lit whole, its
    // words in its header — wherever in it they are let go, never to a row
    // lit as if it were the one they joined. (The header alone was a 26px
    // strip; let go over the stashes under it, a drop did nothing.)
    // drag is what is being dragged (null: nothing of ours); dropKey the
    // place under the pointer, by name — the renders rebuild the elements.
    let drag = null;
    let dropKey = null;
    let dropAlt = false;
    const ALT_NAME = /Mac|iPhone|iPad/.test(navigator.platform || "") ? "Option" : "Alt";

    /** The working tree's rows being dragged: the selection when the row is in it, else that row. Never a conflicted file — it cannot be stashed. */
    function treeDragPaths(key, own) {
      const conflicted = new Set((lastState.merge || []).map((e) => e.path));
      let paths;
      if (key && selectedRows.has(key)) {
        paths = [];
        const entries = selectionEntries();
        for (let i = 0; i < entries.length; i++) {
          if (entries[i].kind !== "merge" && paths.indexOf(entries[i].path) === -1) paths.push(entries[i].path);
        }
      } else {
        paths = own.slice();
      }
      return paths.filter((p) => !conflicted.has(p));
    }

    /** The places the drag in hand can go, by name. */
    function dropKeys() {
      if (!drag) return [];
      if (drag.kind === "tree") return drag.paths.length ? ["stashes"] : [];
      return ["tree", "empty"];
    }
    /** Where a place shows its words. */
    function dropEl(key) {
      if (key === "stashes") return stashesEl.hidden ? null : stashesEl.querySelector(".group--stashes > .group-header");
      if (key === "empty") return emptyEl.classList.contains("visible") ? emptyEl : null;
      // The working tree: every group it shows, as one place.
      return groupsEl.querySelector(":scope > .group:not(.empty)") ? groupsEl : null;
    }
    /** A place, whole: what takes the drop and is lit — the Stashes group with its rows. */
    function dropArea(key) {
      const t = dropEl(key);
      return t && key === "stashes" ? t.parentElement : t;
    }
    /** The place a node is in, when the drag in hand can go there. */
    function dropKeyAt(node) {
      const keys = dropKeys();
      for (let i = 0; i < keys.length; i++) {
        const t = dropArea(keys[i]);
        if (t && node && t.contains(node)) return keys[i];
      }
      return null;
    }
    /** What a drop does, in words: [the verb, how Alt/Option picks the other]. */
    function dropWords() {
      if (drag.kind === "tree") return ["Drop to stash " + countWords(drag.paths.length), ""];
      if (drag.kind === "stash") {
        return dropAlt
          ? ["Drop to pop", "Release " + ALT_NAME + " to apply"]
          : ["Drop to apply", "Hold " + ALT_NAME + " to pop"];
      }
      const n = countWords(drag.paths.length);
      return dropAlt
        ? ["Drop to copy " + n, "Release " + ALT_NAME + " to move"]
        : ["Drop to move " + n, "Hold " + ALT_NAME + " to copy"];
    }
    /**
     * Where a place shows its words: the Stashes header and the clean note in
     * themselves; the working tree in a band held at the top of it, in sight
     * however far the list is scrolled, laid over its first group's header.
     */
    function hintOf(t) {
      const band = t === groupsEl;
      let h = t.querySelector(":scope > .drop-hint");
      if (!h) {
        h = el(band ? "div" : "span", "drop-hint");
        h.setAttribute("aria-hidden", "true");
        const words = band ? el("span", "drop-words") : h;
        words.append(el("span", "drop-verb"), el("span", "drop-alt"));
        if (band) h.appendChild(words);
      }
      if (band) {
        if (groupsEl.firstChild !== h) groupsEl.insertBefore(h, groupsEl.firstChild);
      } else if (!h.parentNode) {
        t.appendChild(h);
      }
      return h;
    }
    /** Paint the drag onto the view: every place it can go faintly, the one under the pointer lit, with its words. */
    function paintDrop() {
      const keys = dropKeys();
      document.querySelectorAll(".is-drop-ready, .is-drop-over").forEach((n) => {
        n.classList.remove("is-drop-ready", "is-drop-over");
      });
      document.body.classList.toggle("is-dragging", !!drag);
      // The working tree's band is not one of its groups: out, unless lit.
      const band = groupsEl.querySelector(":scope > .drop-hint");
      if (band && !(drag && dropKey === "tree")) band.remove();
      if (!drag) return;
      for (let i = 0; i < keys.length; i++) {
        const t = dropEl(keys[i]);
        if (!t) continue;
        const area = dropArea(keys[i]);
        if (keys[i] !== dropKey) { area.classList.add("is-drop-ready"); continue; }
        area.classList.add("is-drop-over");
        // The Stashes group is lit whole; its header carries the words.
        if (area !== t) t.classList.add("is-drop-over");
        const h = hintOf(t);
        const words = dropWords();
        const verb = h.querySelector(".drop-verb");
        const alt = h.querySelector(".drop-alt");
        verb.textContent = words[0];
        alt.textContent = words[1];
        alt.hidden = !words[1];
        if (t === groupsEl) fitBand(h.firstChild);
      }
    }
    /**
     * The working tree's band covers its first group's header; where its
     * words take two lines (a narrow sidebar) it reaches down to the next
     * row's edge, never leaving half a row showing under it.
     */
    function fitBand(words) {
      words.style.minHeight = "";
      const need = words.offsetHeight;
      const top = groupsEl.getBoundingClientRect().top;
      const edges = groupsEl.querySelectorAll(":scope > .group > .group-header, :scope > .group .row");
      for (let i = 0; i < edges.length; i++) {
        const r = edges[i].getBoundingClientRect();
        if (!r.height || r.bottom - top < need - 0.5) continue;
        words.style.minHeight = Math.ceil(r.bottom - top) + "px";
        return;
      }
    }
    function setDrop(key, alt) {
      if (key === dropKey && !!alt === dropAlt) return;
      dropKey = key;
      dropAlt = !!alt;
      paintDrop();
    }
    /**
     * A drag of ours starts: what it carries, and the rows that go with it
     * (dimmed). Files carry their paths as plain text too, so a drop in a
     * terminal or an editor pastes something sensible; a stash carries only
     * its sha, in a type of its own — let go over an editor by mistake, it
     * must not type its message into a file.
     */
    function beginDrag(ev, what, rows, text) {
      drag = what;
      dropKey = null;
      dropAlt = false;
      if (ev.dataTransfer) {
        ev.dataTransfer.effectAllowed = "copyMove";
        if (what.kind === "stash") ev.dataTransfer.setData("application/x-gitstudio-stash", what.sha);
        else ev.dataTransfer.setData("text/plain", text);
      }
      rows.forEach((r) => r.classList.add("is-dragged"));
      // A drag of the working tree's files needs the Stashes header, even
      // with no stash yet: it is where they go.
      if (what.kind === "tree" && stashesEl.hidden) renderStashes();
      paintDrop();
    }
    function endDrag() {
      if (!drag) return;
      const wasTree = drag.kind === "tree";
      drag = null;
      dropKey = null;
      dropAlt = false;
      document.querySelectorAll(".row.is-dragged").forEach((r) => r.classList.remove("is-dragged"));
      paintDrop();
      if (wasTree && shownStashes().length === 0) renderStashes();
    }
    /** The drag landed on key: do what the menus do. */
    function dropOn(d, alt) {
      if (d.kind === "tree") {
        if (!d.paths.length) return;
        vscode.postMessage({ type: "stashPaths", paths: d.paths });
        if (d.selection) clearSelection();
        return;
      }
      const s = authStashes.find((x) => x.sha === d.sha);
      if (!s) return;
      if (d.kind === "stash") stashAct(s, alt ? "pop" : "apply");
      else stashFilesAct(s, d.paths, alt ? "copy" : "move");
    }
    /**
     * The pointer's badge: copy where the source stays (Apply, Copy), move
     * where it goes (Pop, Move, Stash) — but only an effect the drag still
     * allows. A Mac narrows a drag to copy alone while Option is held, and
     * the browser then refuses a drop that asks for move: an Option-drop to
     * Pop did nothing at all. What a drop does is read from Alt at the drop,
     * never from this.
     */
    function dropEffectFor(dt, want) {
      const a = String(dt.effectAllowed || "all").toLowerCase();
      const allows = (e) => a === "all" || a === "uninitialized" || a.indexOf(e) !== -1;
      if (allows(want)) return want;
      return ["copy", "move", "link"].find(allows) || want;
    }
    // dragover must be cancelled for a drop to be allowed at all: over a
    // place the drag can go it is, and the pointer says copy or move; over
    // anything else it is not, and the browser shows that nothing drops.
    document.addEventListener("dragenter", (ev) => {
      if (drag && dropKeyAt(ev.target)) ev.preventDefault();
    });
    document.addEventListener("dragover", (ev) => {
      if (!drag) return;
      const key = dropKeyAt(ev.target);
      setDrop(key, ev.altKey);
      if (!key) return;
      ev.preventDefault();
      if (ev.dataTransfer) {
        const keeps = drag.kind === "stash" ? !ev.altKey : drag.kind === "stashFiles" ? ev.altKey : false;
        ev.dataTransfer.dropEffect = dropEffectFor(ev.dataTransfer, keeps ? "copy" : "move");
      }
    });
    document.addEventListener("dragleave", (ev) => {
      // Out of the view altogether: nothing under the pointer is ours.
      if (drag && !ev.relatedTarget && (ev.clientX <= 0 || ev.clientY <= 0 ||
          ev.clientX >= window.innerWidth || ev.clientY >= window.innerHeight)) setDrop(null, false);
    });
    document.addEventListener("drop", (ev) => {
      if (!drag) return;
      ev.preventDefault();
      const d = drag;
      const key = dropKeyAt(ev.target);
      endDrag();
      if (key) dropOn(d, ev.altKey);
    });
    // Its source's end: dropped (above), cancelled with Escape, or let go
    // outside the view.
    document.addEventListener("dragend", () => endDrag());

    // The selection bar's actions operate on the whole selection.
    $("selbar-stash").addEventListener("click", () => {
      const paths = selectionPaths();
      if (paths.length === 0) return;
      vscode.postMessage({ type: "stashPaths", paths: paths });
      clearSelection();
    });
    $("selbar-stage").addEventListener("click", () => {
      // Staged rows are already where this would put them.
      const paths = selectionEntries()
        .filter((en) => en.kind !== "staged")
        .map((en) => en.path);
      if (paths.length > 0) {
        queueFiles(paths, "stage");
        vscode.postMessage({ type: "stagePaths", paths: paths });
      }
      clearSelection();
    });
    $("selbar-clear").addEventListener("click", clearSelection);

    /**
     * Escape = one step back, and the selection is the OUTERMOST step.
     *
     * Every nested surface already closes itself on Escape and consumes the
     * event — dialogs with stopImmediatePropagation on a capture-phase window
     * listener, the action menu the same way, and the branch menu closing its
     * submenu before itself. This listener is deliberately last in that chain:
     * bubble phase, so anything open wins, and it additionally checks the DOM so
     * a surface that forgets to stop propagation still cannot have its Escape
     * stolen to clear a selection the user cannot even see behind it.
     */
    function anyOverlayOpen() {
      return !!document.querySelector(
        ".action-menu, .branch-submenu, .rp-panel, .rp-backdrop, .push-modal",
      );
    }
    window.addEventListener("keydown", (ev) => {
      if (ev.key !== "Escape") return;
      if (anyOverlayOpen()) return;
      if (selectedRows.size === 0) return;
      ev.preventDefault();
      clearSelection();
    });

    // Clicking empty space in the list clears the selection, the way a file
    // manager does. Rows stop the event, so this only fires on the background.
    groupsEl.addEventListener("click", (ev) => {
      if (ev.target === groupsEl && selectedRows.size > 0) clearSelection();
    });
    // The host's DETACHED_PUSH_REASON / NO_REMOTE_PUSH_REASON, word for word:
    // the button's tip and the push dialog must give the same reason. On a
    // detached HEAD the state carries the host's reason (detachedReason),
    // which knows whether a rebase is what detached it; this is the fallback.
    const DETACHED_PUSH_REASON = "HEAD is detached, so these commits are on no branch and there is nothing to push them to. Create a branch here to push them.";
    const NO_REMOTE_PUSH_REASON = "No remote is configured for this repository.";
    let aheadCount = 0;     // commits a push would send (drives the button label)
    let canPublish = false; // there IS somewhere to push/publish those commits
    let onUpstream = false; // branch tracks an upstream (Push) vs not (Publish)
    let committing = false; // a commit op is in flight (button spinner)
    let hostBusy = false;   // the host reported a busy state
    let generating = false;
    let layout = "list";
    // Persisted-in-DOM collapse memory, keyed by group + folder path.
    const collapsed = Object.create(null);
    // authState = last authoritative lists from the host (real git state).
    // lastState = what we actually render = authState with the pending optimistic
    // moves applied on top. Splitting the two lets a stage/unstage move the row
    // INSTANTLY (no round-trip to git), then reconcile silently when git catches
    // up — the row never snaps back mid-flight, even across rapid clicks.
    let authState = { merge: [], staged: [], unstaged: [] };
    let lastState = { merge: [], staged: [], unstaged: [] };
    let branchData = { local: [], remote: [], recent: [], tags: [] };
    // True until the host has listed this repository's branches: a state push
    // carries none on its first post for a repository (see pushState).
    let branchesLoading = true;
    let lastBranchSig = "";
    /** What an open branch menu shows, as one string: when it changes the menu repaints. */
    function bmSig() {
      const hs = lastHeaderState;
      return JSON.stringify([branchesLoading, branchData, !!(hs && hs.detached), hs && hs.detached ? hs.branch : ""]);
    }

    // path -> { action: "stage" | "unstage", at: ms }. An optimistic move that
    // git hasn't confirmed yet. Cleared once the authoritative state agrees, or
    // after PENDING_TTL (so a failed op self-heals instead of sticking forever).
    const pending = new Map();
    const PENDING_TTL = 4000;
    const has = (list, path) => list.some((e) => e.path === path);

    // name -> { favorite, at: ms }: a star the host has not answered yet.
    // Dropped once a post agrees, or after PENDING_TTL, so a star the host
    // never took does not stick.
    const pendingFavorites = new Map();
    /** The host's branch list with every still-pending star laid over it. */
    function applyPendingFavorites(data) {
      if (!pendingFavorites.size || !data || !data.local) return data;
      const now = Date.now();
      let local = data.local;
      for (const [name, p] of pendingFavorites) {
        const i = local.findIndex((b) => b.name === name);
        if (i < 0 || local[i].favorite === p.favorite || now - p.at > PENDING_TTL) {
          pendingFavorites.delete(name);
          continue;
        }
        if (local === data.local) local = local.slice();
        local[i] = Object.assign({}, local[i], { favorite: p.favorite });
      }
      return local === data.local ? data : Object.assign({}, data, { local: local });
    }

    // Drop pending ops the authoritative state already reflects (or that have
    // aged out), so they stop being re-applied.
    function reconcilePending(auth) {
      const now = Date.now();
      for (const [path, op] of pending) {
        const inStaged = has(auth.staged, path);
        const present = inStaged || has(auth.unstaged, path) || has(auth.merge, path);
        const satisfied = op.action === "stage"
          ? inStaged || !present
          : !inStaged;
        if (satisfied || now - op.at > PENDING_TTL) pending.delete(path);
      }
    }

    // Derive the displayed lists: authoritative state + every still-pending move.
    // Idempotent — a move whose source row is already gone is simply a no-op.
    function applyPending(auth) {
      const merge = auth.merge.slice();
      const staged = auth.staged.slice();
      const unstaged = auth.unstaged.slice();
      const take = (list, path) => {
        const i = list.findIndex((e) => e.path === path);
        return i === -1 ? null : list.splice(i, 1)[0];
      };
      for (const [path, op] of pending) {
        if (op.action === "stage") {
          const e = take(unstaged, path) || take(merge, path);
          if (e && !has(staged, path)) {
            staged.push({ path, status: e.status === "U" ? "A" : e.status });
          }
        } else {
          const e = take(staged, path);
          if (e && !has(unstaged, path)) {
            unstaged.push({ path, status: e.status === "A" ? "U" : e.status });
          }
        }
      }
      return { merge, staged, unstaged };
    }

    // Re-derive lastState from authState + pending, refresh the count, repaint.
    function applyOptimistic() {
      lastState = applyPending(authState);
      stagedCount = lastState.staged.length;
      renderCount();
      render();
    }
    function queueOp(path, action) {
      if (!path) return;
      pending.set(path, { action, at: Date.now() });
      applyOptimistic();
    }
    // Stage/unstage every file currently shown in a group, optimistically.
    // Sets all pending ops first, then repaints once (not per file).
    function queueGroup(kind, action) {
      const list = (lastState[kind] || []).slice();
      if (!list.length) return;
      const at = Date.now();
      for (const e of list) pending.set(e.path, { action, at });
      applyOptimistic();
    }
    // Stage/unstage an explicit set of paths (a folder's files) optimistically.
    function queueFiles(paths, action) {
      if (!paths || !paths.length) return;
      const at = Date.now();
      for (const p of paths) pending.set(p, { action, at });
      applyOptimistic();
    }

    // ---- Icon glyphs: the real VS Code codicon font ----------------------
    const ICON_FILE = '<i class="codicon codicon-file" aria-hidden="true"></i>';
    const ICON_FOLDER = '<i class="codicon codicon-folder" aria-hidden="true"></i>';
    // RIGHT, because every twisty that wears it (group headers, folder rows,
    // a file's changes toggle) leaves it alone when closed and turns it 90deg
    // to point down when open (.twisty / .hunk-twisty.open). The two fixes
    // for the old ˄/› twisties — turn the glyph, or swap it for
    // chevron-down — each work alone; both at once point an open one LEFT.
    const ICON_CHEVRON = '<i class="codicon codicon-chevron-right" aria-hidden="true"></i>';
    const ICON_STAGE = '<i class="codicon codicon-add" aria-hidden="true"></i>';
    // codicon-remove (a full-width minus) not codicon-dash (a short thin
    // stroke) so Unstage visually balances the Stage "+".
    const ICON_UNSTAGE = '<i class="codicon codicon-remove" aria-hidden="true"></i>';
    const ICON_DISCARD = '<i class="codicon codicon-discard" aria-hidden="true"></i>';

    // Only "!" is a conflict. "U" is UNTRACKED (statusLetter maps unmerged
    // states to "!", untracked to "U") — including it here painted every
    // untracked row with the conflict/red accent.
    const CONFLICT_LETTERS = new Set(["!"]);
    function statusClass(letter) {
      return "st-" + (/^[A-Z!]$/.test(letter) ? letter.replace("!", "C") : "M");
    }
    // Spell out the one-letter status on hover so the A / U / M / D … column
    // isn't a mystery.
    const STATUS_NAMES = {
      A: "Added", U: "Untracked", D: "Deleted", R: "Renamed",
      "!": "Conflict", I: "Ignored", T: "Type changed", M: "Modified",
    };
    function statusTitle(letter) {
      return STATUS_NAMES[letter] || "Modified";
    }

    /**
     * The row that shows the next page of a long list — the branch menu's
     * tags, a stash's files: "Show 40 more of 95" while more stay hidden
     * after it, "Show 15 more" for the last page ("Show 15 more of 15" said
     * the same number twice).
     */
    function showMoreLabel(hidden, page) {
      return hidden > page ? "Show " + page + " more of " + hidden : "Show " + hidden + " more";
    }

    function el(tag, cls, html) {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (html != null) node.innerHTML = html;
      return node;
    }

    // ---- Auto-grow message + live subject counter -----------------------
    function autoGrow() {
      message.style.height = "auto";
      message.style.height = Math.min(message.scrollHeight, 320) + "px";
    }
    // Show a subject-length counter; nudge toward the 50/72 convention without
    // ever enforcing it. The counter only appears once there's text.
    function updateComposer() {
      const text = message.value;
      const hasText = text.trim().length > 0;
      messageWrap.classList.toggle("has-text", hasText);
      const subject = text.split("\n", 1)[0].length;
      counterEl.textContent = String(subject);
      counterEl.classList.toggle("warn", subject > 50 && subject <= 72);
      counterEl.classList.toggle("over", subject > 72);
      // What the number is, and what the 50/72 convention asks of it.
      counterEl.dataset.tip = subject > 72
        ? "Subject line: " + subject + " characters, over 72. GitHub cuts a longer subject short."
        : subject > 50
          ? "Subject line: " + subject + " characters, over 50. Aim for 50; 72 at most."
          : "Subject line: " + subject + (subject === 1 ? " character" : " characters") + ". Keep it to 50.";
    }
    message.addEventListener("input", () => { autoGrow(); updateComposer(); });

    function setBusy(busy) {
      hostBusy = busy;
      branchPill.style.opacity = busy ? "0.6" : "";
      renderCommitButtons();
    }

    // The primary action + compact Commit button are STATE-DRIVEN:
    //  • staged work present → primary = "Commit & Push" (needs a message)
    //  • nothing staged, unpushed commits present → primary = "Push N" (no message)
    //  • nothing to do → primary disabled.
    // The Commit button only commits staged work; it shrinks beside the primary.
    function renderCommitButtons() {
      const verb = amend.checked ? "Amend" : "Commit";
      const hasStaged = stagedCount > 0 || amend.checked;
      // Anything at all to commit? With nothing staged the host offers to commit
      // everything after confirming (issue #16), so the button must be reachable —
      // it used to be disabled, which is how a stale list could make it look like
      // there was nothing to do.
      // Conflicted files are not part of "all": the host never sweeps them in
      // (staging one marks it resolved, markers and all), so counting them
      // offered "Commit all 1" for a commit that could not include it.
      const totalChanges =
        (lastState ? lastState.staged.length + lastState.unstaged.length : 0);
      const canCommit = hasStaged || totalChanges > 0;
      // Commit button label + state.
      if (!committing) {
        commitLabel.textContent =
          stagedCount > 0 ? verb + " " + stagedCount
          : !amend.checked && totalChanges > 0 ? verb + " all " + totalChanges
          : verb;
      }
      commitBtn.disabled = committing || hostBusy || !canCommit;
      // Primary action mode + label. "Push" is available whenever there are
      // unpushed commits — OR the branch has no upstream yet (publish), where the
      // ahead count reads 0 but there IS local work to send. Only a tracked
      // branch that's fully up to date leaves nothing to push.
      //
      // A push that cannot work is never offered: on a detached HEAD (every
      // stopped rebase is one) there is no branch to push, and with no remote
      // there is nowhere to push it. Those used to show "Commit & Push" or
      // "Publish N", enabled, and fail only after the commit — blaming a
      // missing remote even when the HEAD was the problem.
      const blocked = pushBlockedReason();
      let mode, label;
      if (hasStaged && !blocked) {
        mode = "commitpush"; label = (amend.checked ? "Amend" : "Commit") + " & Push";
      } else if (!blocked && canPublish && (aheadCount > 0 || !onUpstream)) {
        // An unpublished branch is always actionable: "Publish" even with a
        // zero ahead-count. Only a TRACKED branch that is up to date has
        // genuinely nothing to do.
        mode = "push";
        label = onUpstream
          ? "Push " + aheadCount
          : (aheadCount > 0 ? "Publish " + aheadCount : "Publish");
      } else {
        mode = "none"; label = "Push";
      }
      pushBtn.dataset.mode = mode;
      if (!pushBtn.classList.contains("is-busy")) mainLabel.textContent = label;
      pushBtn.disabled = committing || hostBusy || mode === "none";
      if (blocked) pushBtn.dataset.tip = blocked;
      else delete pushBtn.dataset.tip;
      pushBtn.setAttribute("aria-label", blocked ? label + " — " + blocked : label);
    }

    /** Why a push from here cannot work right now, or "" when it can. */
    function pushBlockedReason() {
      const st = lastHeaderState;
      if (st && st.detached) return st.detachedReason || DETACHED_PUSH_REASON;
      // Only once the host has LOOKED for a remote: the first post of an
      // unpublished branch does not know yet, and a disabled button that then
      // re-enables is a flicker, not information.
      if (st && !st.upstream && st.canPublish === false) return NO_REMOTE_PUSH_REASON;
      return "";
    }
    // Back-compat alias — older call sites still call renderCount().
    function renderCount() { renderCommitButtons(); }

    // ---- Branch / sync header -------------------------------------------
    function renderHeader(state) {
      lastHeaderState = state;
      // The repository control: only when there is another repository to
      // switch to. With one, the name would be a label that opens a list of one.
      const repoCount = state.hasRepo ? (state.repoCount || 0) : 0;
      repoPill.hidden = repoCount < 2;
      if (repoCount >= 2) {
        repoNameEl.textContent = state.repoName || "";
        // Where it is first: the name is clipped on a narrow sidebar, and two
        // repositories in one workspace can share a folder name.
        const what = "Switch repository (" + repoCount + " in this workspace)";
        repoPill.dataset.tip = (state.repoPath ? state.repoPath + " — " : "") + what;
        repoPill.setAttribute("aria-label", "Repository " + (state.repoName || "") + ". " + what);
      }
      branchName.textContent = state.branch || "(no branch)";
      // A detached head is a revision, not a branch — mark it so the pill can
      // look different from an ordinary branch instead of silently lying.
      branchPill.classList.toggle("is-detached", !!state.detached);
      branchPill.title = (state.repoName ? state.repoName + " · " : "") +
        (state.detached
          ? "Detached HEAD at " + (state.branch || "an unknown revision") +
            " — commits here belong to no branch"
          : (state.branch || "detached HEAD")) +
        (state.upstream ? "  ↔ " + state.upstream : "");
      const ahead = state.ahead || 0;
      const behind = state.behind || 0;
      const hasUpstream = !!state.upstream;
      aheadN.textContent = String(ahead);
      behindN.textContent = String(behind);
      // The count in the name too: a folded pill shows only an arrow and it.
      aheadEl.setAttribute("aria-label", "Push " + ahead + (ahead === 1 ? " commit" : " commits"));
      behindEl.setAttribute("aria-label", "Pull " + behind + (behind === 1 ? " commit" : " commits"));
      aheadEl.classList.toggle("visible", ahead > 0);
      behindEl.classList.toggle("visible", behind > 0);
      syncClean.classList.toggle("visible", hasUpstream && ahead === 0 && behind === 0);
      syncEl.classList.toggle("hidden", !state.branch);
      // Commits a push would send: the header ahead count when tracking an
      // upstream, else the host-computed count of commits not on any remote (the
      // never-pushed branch). Falls back to ahead before the 2nd post lands.
      aheadCount = typeof state.unpushed === "number" ? state.unpushed : ahead;
      onUpstream = hasUpstream;
      // With an upstream we can always push; without one we can only PUBLISH
      // when the host found a remote to publish to.
      canPublish = hasUpstream || !!state.canPublish;
      renderCommitButtons();
      // A status push can land mid-pull — keep the in-flight face on top.
      applySyncBusy();
      fitRepoPill();
    }

    // The repository's name gives way FIRST on a narrow sidebar. The shrink
    // factor alone left a few px of name under a floor sized on macOS glyphs
    // (Windows' are narrower), with the branch already losing letters. So,
    // measured with the name shown each time: if the branch name is clipped,
    // the name folds away completely; with room again, it comes back.
    //
    // Then the sync pills' verbs: at a sidebar's width, "Push 2" and "Pull 3"
    // kept their full width while the branch was down to "fea…". Folded,
    // they are an arrow and a count (the pill's name and tip keep the word).
    // Each pass starts from everything shown, so a wider sidebar gives it all
    // back and the decision is the same whichever state it starts from.
    function fitRepoPill() {
      const clipped = () => branchName.scrollWidth > branchName.clientWidth + 0.5;
      repoPill.classList.remove("folded");
      syncEl.classList.remove("compact");
      if (!clipped()) return;
      if (!repoPill.hidden) {
        repoPill.classList.add("folded");
        if (!clipped()) return;
      }
      syncEl.classList.add("compact");
    }
    new ResizeObserver(() => fitRepoPill()).observe(repoPill.parentElement);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitRepoPill);

    function doCommit(push) {
      vscode.postMessage({
        type: "commit",
        message: message.value,
        amend: amend.checked,
        signoff: signoff.checked,
        author: author.value,
        push: !!push,
      });
    }
    // Start a commit with an in-button spinner. Guards the empty-message case up
    // front (nudging the composer) so we never spin for a commit that can't run.
    function startCommit(push, btn, labelEl) {
      if (committing || hostBusy) return;
      if (message.value.trim() === "" && !amend.checked) {
        const composer = message.closest(".composer");
        if (composer) {
          composer.classList.add("needs-msg");
          setTimeout(() => composer.classList.remove("needs-msg"), 650);
        }
        message.focus();
        return;
      }
      committing = true;
      btn.classList.add("is-busy");
      labelEl.textContent = "Committing…";
      renderCommitButtons();
      doCommit(push);
    }
    function clearCommitBusy() {
      committing = false;
      commitBtn.classList.remove("is-busy");
      pushBtn.classList.remove("is-busy");
      renderCommitButtons();
    }
    // Compact Commit button: commit staged work only.
    commitBtn.addEventListener("click", () => startCommit(false, commitBtn, commitLabel));
    // Primary action: Commit & Push (needs a message) OR straight Push of the
    // existing unpushed commits (no message required) — depending on state.
    pushBtn.addEventListener("click", () => {
      const mode = pushBtn.dataset.mode;
      if (mode === "push") {
        // Already-committed work: skip the commit, open the review modal directly.
        vscode.postMessage({ type: "requestPushPreview" });
      } else if (mode === "commitpush") {
        startCommit(true, pushBtn, mainLabel);
      }
    });

    function setGenerating(on) {
      generating = on;
      generateBtn.disabled = on;
      generateBtn.classList.toggle("loading", on);
      generateBtn.setAttribute("aria-label",
        on ? "Generating commit message…" : "Generate commit message");
    }
    generateBtn.addEventListener("click", () => {
      if (generating) return;
      setGenerating(true);
      vscode.postMessage({ type: "generateMessage" });
    });
    const reviewBtn = $("review");
    const connectAiBtn = $("connect-ai");
    reviewBtn.addEventListener("click", () =>
      vscode.postMessage({ type: "reviewChanges" }),
    );
    connectAiBtn.addEventListener("click", () =>
      vscode.postMessage({ type: "connectAI" }),
    );

    amend.addEventListener("change", () => {
      renderCount();
      vscode.postMessage({ type: "amendToggled", amend: amend.checked });
    });

    authorToggle.addEventListener("click", () => {
      authorRow.classList.toggle("hidden");
      const open = !authorRow.classList.contains("hidden");
      authorToggle.setAttribute("aria-expanded", open ? "true" : "false");
      if (open) author.focus();
    });

    // Enter is just a newline — committing is button-only, by design.
    signoff.addEventListener("change", () => { signoff.dataset.touched = "1"; });

    // ---- Layout / toolbar -----------------------------------------------
    function applyLayoutClass() {
      document.body.classList.toggle("layout-tree", layout === "tree");
      document.body.classList.toggle("layout-list", layout !== "tree");
      // Where the toggle takes you (its icon is that layout's), as the model
      // toggle beside it says — "Toggle tree / list view" said neither.
      const label = layout === "tree" ? "View as List" : "View as Tree";
      layoutToggle.dataset.tip = label;
      layoutToggle.setAttribute("aria-label", label);
    }
    layoutToggle.addEventListener("click", () => {
      layout = layout === "tree" ? "list" : "tree";
      applyLayoutClass();
      vscode.postMessage({ type: "setLayout", layout });
      render();
      renderStashes();
    });

    // Staging model, beside the tree/list toggle because it is the same KIND of
    // choice: how this list is arranged, not what it does. It existed only as a
    // setting, which meant the checkbox model was effectively undiscoverable —
    // you had to know the setting's name to find out it was there at all.
    function applyModelToggleLabel() {
      const inChecks = stagingModel === "checkboxes";
      document.body.classList.toggle("model-checkboxes", inChecks);
      const label = inChecks ? "Switch to staged / unstaged" : "Switch to checkboxes";
      modelToggle.dataset.tip = label;
      modelToggle.setAttribute("aria-label", label);
    }
    applyModelToggleLabel();
    modelToggle.addEventListener("click", () => {
      stagingModel = stagingModel === "checkboxes" ? "split" : "checkboxes";
      applyModelToggleLabel();
      // Selection keys are kind:path and the two models group differently, so a
      // selection carried across the switch would point at rows that no longer
      // exist in that arrangement.
      clearSelection();
      render();
      vscode.postMessage({ type: "setStagingModel", stagingModel });
    });
    collapseAllBtn.addEventListener("click", () => {
      // Collapse every folder row in the current tree render.
      for (const key of Object.keys(collapsed)) collapsed[key] = false;
      const folders = collectFolderKeys();
      for (const k of folders) collapsed[k] = true;
      // And the folders of every open stash.
      const stashFolders = stashesEl.querySelectorAll("[data-tkey^='stashfolder:']");
      for (let i = 0; i < stashFolders.length; i++) collapsed[stashFolders[i].dataset.tkey] = true;
      render();
      renderStashes();
    });
    stageAllTopBtn.addEventListener("click", () => {
      queueGroup("unstaged", "stage");
      vscode.postMessage({ type: "stageAll" });
    });
    stashChangesBtn.addEventListener("click", () => {
      // With a selection live, the toolbar button follows it. Ignoring the
      // selection here would mean the same icon does two different things
      // depending on nothing the user can see.
      const paths = selectionPaths();
      if (paths.length > 0) {
        vscode.postMessage({ type: "stashPaths", paths: paths });
        clearSelection();
        return;
      }
      vscode.postMessage({ type: "stash" });
    });

    /** Keeps the toolbar button honest about what it is about to take. */
    function syncStashButtonLabel() {
      const n = selectionPaths().length;
      const label = n === 0
        ? "Stash all changes\u2026"
        : (n === 1 ? "Stash 1 selected file\u2026" : "Stash " + n + " selected files\u2026");
      stashChangesBtn.dataset.tip = label;
      stashChangesBtn.setAttribute("aria-label", label);
      stashChangesBtn.classList.toggle("is-scoped", n > 0);
    }
    refreshBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "ready" });
    });

    // ---- Branch + actions menu (folds in the old Branches view) ----------
    let branchMenu = null;
    let branchFilter = "";
    // The query as typed (branchFilter is it lower-cased): what "New Branch
    // '<query>'…" fills its name with.
    let branchQuery = "";
    // How many rows a long group (Tags, and each remote) renders at once, and
    // each group's current window, by its key. Paged rather than capped, so
    // every ref is reachable via "Show more"; a new query starts over.
    const PAGE = 40;
    let pageLimits = Object.create(null);
    let branchSubmenu = null;
    // The width the open menu holds while the query changes (see holdBranchMenuWidth).
    let bmHeldWidth = 0;
    // The best match of the last render: the row a query's highlight goes to.
    let bmBest = null;
    // Whether the arrows or the pointer have moved the highlight since the
    // query last changed. Until they have, a repaint from the host puts it
    // back on the best match (branches that arrived, counts that changed);
    // after, it stays where they put it.
    let bmUserMoved = false;
    // The list's scroll position while a branch's actions are drilled in.
    let bmDrillScroll = 0;
    // Per-category collapse memory (Favorites / Recents / Local / Remote / Tags).
    const collapsedCats = Object.create(null);

    // ── Keyboard navigation (IntelliJ's branch popup, #32) ──────────────────
    // Focus never leaves the search box: the arrows move a highlight through
    // the visible rows (top actions, branches, "Show more" — never a group
    // header), Right or Enter on a branch opens its submenu with the highlight
    // on its first item, Up/Down move there, Enter runs it, Left or Escape
    // goes back to the branch. PageUp/PageDown move a page, Ctrl/Cmd+Home/End
    // go to either end, and Tab does nothing. The box is a combobox whose
    // aria-activedescendant follows the highlight, so a screen reader reads
    // each row as it is reached.
    //
    // bmActiveKey names the highlighted main row by its data-bmkey — rows are
    // rebuilt on every repaint, so an element reference would go stale; the
    // key finds its new row. bmSubActive is the highlighted submenu item, or
    // -1 when the highlight is in the main list.
    let bmActiveKey = "";
    let bmSubActive = -1;
    // Drilled in, the pointer on the back row ('‹ feature') lights it: the
    // one row lit, the actions' highlight dark until the arrows move on.
    let bmBackLit = false;
    let bmOptSeq = 0;
    // Where the pointer last was: a mousemove at the same spot is the list
    // scrolling under a still mouse, not the mouse moving, and must not take
    // the highlight from the keyboard.
    let bmPointer = "";

    function bmOption(node) {
      node.id = "bm-opt-" + (++bmOptSeq);
      node.setAttribute("role", "option");
      node.setAttribute("aria-selected", "false");
    }
    function bmList() { return branchMenu ? branchMenu.querySelector(".bm-list") : null; }
    /** The rows the arrows visit: every keyed row that is on screen (not in a collapsed group). */
    function bmRows() {
      const list = bmList();
      if (!list) return [];
      return Array.prototype.filter.call(list.querySelectorAll("[data-bmkey]"),
        (n) => n.getClientRects().length > 0);
    }
    function bmRowByKey(key) {
      const list = bmList();
      if (!list || !key) return null;
      const all = list.querySelectorAll("[data-bmkey]");
      for (let i = 0; i < all.length; i++) if (all[i].dataset.bmkey === key) return all[i];
      return null;
    }
    function bmSubItems() {
      return branchSubmenu ? Array.prototype.slice.call(branchSubmenu.querySelectorAll(".bm-subaction")) : [];
    }
    /** Drilled in, the back row above the actions; otherwise none. */
    function bmBackRow() {
      return branchSubmenu && branchSubmenu.classList.contains("is-drilled")
        ? branchSubmenu.querySelector(".bm-subhead") : null;
    }
    /** Paint the highlight where the state says it is, and point the box at it. */
    function paintBm(scroll) {
      if (!branchMenu) return;
      const input = branchMenu.querySelector(".bm-search input");
      document.querySelectorAll(".branch-menu .is-active, .branch-menu .is-open, .branch-submenu .is-active")
        .forEach((n) => {
          n.classList.remove("is-active", "is-open");
          if (n.getAttribute("role") === "option") n.setAttribute("aria-selected", "false");
        });
      const main = bmRowByKey(bmActiveKey);
      let target = main;
      if (branchSubmenu && bmSubActive >= 0) {
        const items = bmSubItems();
        target = items[Math.min(bmSubActive, items.length - 1)] || null;
        if (main) main.classList.add("is-open");
      }
      if (input) {
        input.setAttribute("aria-controls", branchSubmenu ? "bm-list bm-sub" : "bm-list");
      }
      const back = bmBackLit ? bmBackRow() : null;
      if (back) {
        // Lit as any row is; not an option of the list, so the box points at none.
        back.classList.add("is-active");
        if (main) main.classList.add("is-open");
        if (input) input.removeAttribute("aria-activedescendant");
        return;
      }
      if (target) {
        target.classList.add("is-active");
        target.setAttribute("aria-selected", "true");
        if (input) input.setAttribute("aria-activedescendant", target.id);
        if (scroll && target.scrollIntoView) {
          target.scrollIntoView({ block: "nearest" });
          fitBranchNames(); // rows it scrolled into sight
        }
      } else if (input) {
        input.removeAttribute("aria-activedescendant");
      }
    }
    /** Move the main-list highlight, clamped at both ends. With none yet, it
     *  starts just above the first row: one step either way lands there. */
    function moveBm(delta) {
      const rows = bmRows();
      if (!rows.length) return;
      let i = -1;
      for (let k = 0; k < rows.length; k++) if (rows[k].dataset.bmkey === bmActiveKey) i = k;
      i = Math.max(0, Math.min(rows.length - 1, i + delta));
      // An open submenu belongs to the row it was opened on.
      if (branchSubmenu) { closeBranchSubmenu(); subMenuFor = null; }
      bmActiveKey = rows[i].dataset.bmkey;
      bmUserMoved = true;
      paintBm(true);
    }
    function moveBmSub(delta) {
      const items = bmSubItems();
      if (!items.length) return;
      if (bmBackLit) {
        // From the back row, down goes into the actions from their top;
        // up has nowhere to go.
        if (delta < 0) return;
        bmBackLit = false;
        bmSubActive = -1;
      }
      bmSubActive = Math.max(0, Math.min(items.length - 1, bmSubActive + delta));
      paintBm(true);
    }
    /** One page for PageUp/PageDown: as many rows as the scrolling box shows. */
    function bmPageRows(box, row) {
      const h = row ? row.getBoundingClientRect().height : 0;
      return box && h > 0 ? Math.max(1, Math.floor(box.clientHeight / h)) : 1;
    }
    /** Open a branch row's submenu, the highlight on its first item. */
    function openBmSub(row) {
      row.click(); // exactly what a click does — openBranchActions
      if (!branchSubmenu) return;
      bmSubActive = 0;
      paintBm(true);
    }
    /** Close the submenu; the highlight goes back to its branch. */
    function closeBmSub() {
      closeBranchSubmenu();
      subMenuFor = null;
      bmUserMoved = true; // the branch it was opened on keeps the highlight
      paintBm(true);
    }
    /** The search box's keys. Only the box's own events: a dialog raised
     *  over the menu keeps its arrows and its Enter. */
    function onBmInputKey(e) {
      if (e.isComposing) return;
      const k = e.key;
      // Focus stays here: nothing else in the menu takes a Tab stop, and a
      // Tab that left would strand the arrows until a click brought it back.
      if (k === "Tab") {
        e.preventDefault();
        return;
      }
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        const d = k === "ArrowDown" ? 1 : -1;
        if (branchSubmenu) moveBmSub(d); else moveBm(d);
        return;
      }
      // A page of rows at a time, and Ctrl/Cmd+Home/End to either end. Plain
      // Home/End are the caret's, as in any text box.
      const toEnd = (k === "Home" || k === "End") && (e.ctrlKey || e.metaKey);
      if (k === "PageDown" || k === "PageUp" || toEnd) {
        e.preventDefault();
        const d = k === "PageDown" || k === "End" ? 1 : -1;
        if (branchSubmenu) {
          const n = toEnd ? Infinity : bmPageRows(branchSubmenu.querySelector(".bm-sublist"), bmSubItems()[0]);
          moveBmSub(d * n);
        } else {
          const n = toEnd ? Infinity : bmPageRows(bmList(), bmRowByKey(bmActiveKey) || bmRows()[0]);
          moveBm(d * n);
        }
        return;
      }
      if (k === "ArrowRight") {
        // Only on a branch; anywhere else the caret moves as usual.
        const row = bmRowByKey(bmActiveKey);
        if (branchSubmenu || !row || !row.classList.contains("bm-branch")) return;
        e.preventDefault();
        openBmSub(row);
        return;
      }
      if (k === "ArrowLeft") {
        if (!branchSubmenu) return;
        e.preventDefault();
        closeBmSub();
        return;
      }
      if (k === "Enter") {
        e.preventDefault();
        // A held Enter repeats: the first opens a submenu, the second would
        // run its first item. Only a fresh press acts.
        if (e.repeat) return;
        if (branchSubmenu) {
          if (bmBackLit) { closeBmSub(); return; }
          if (bmSubActive < 0) { moveBmSub(1); return; }
          const item = bmSubItems()[bmSubActive];
          if (item) item.click();
          return;
        }
        const row = bmRowByKey(bmActiveKey);
        if (!row) return;
        if (row.classList.contains("bm-branch")) openBmSub(row);
        else row.click();
      }
    }
    /** Whether the pointer really moved (see bmPointer). */
    function bmPointerMoved(e) {
      const at = e.clientX + "," + e.clientY;
      if (at === bmPointer) return false;
      bmPointer = at;
      return true;
    }

    function closeBranchMenu() {
      closeBranchSubmenu();
      subMenuFor = null;
      bmActiveKey = "";
      bmSubActive = -1;
      if (branchBackdrop) { branchBackdrop.remove(); branchBackdrop = null; }
      if (!branchMenu) return;
      branchMenu.remove();
      branchMenu = null;
      branchPill.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onBranchDocDown, true);
      document.removeEventListener("keydown", onBranchKey, true);
      window.removeEventListener("blur", onBranchBlur, true);
      window.removeEventListener("resize", onBranchResize);
    }
    function closeBranchSubmenu() {
      if (branchSubmenu) { branchSubmenu.remove(); branchSubmenu = null; }
      bmSubActive = -1;
      bmBackLit = false;
      // Drilled in: the list comes back, scrolled where it was.
      if (branchMenu && branchMenu.classList.contains("is-drilled")) {
        branchMenu.classList.remove("is-drilled");
        const list = bmList();
        if (list) list.scrollTop = bmDrillScroll;
      }
      hideTip(); // a tip anchored to a removed submenu item must not linger
    }
    function onBranchDocDown(e) {
      const inMenu = branchMenu && branchMenu.contains(e.target);
      const inSub = branchSubmenu && branchSubmenu.contains(e.target);
      const onPill = branchPill.contains(e.target);
      if (inSub || inMenu || onPill) return;
      closeBranchMenu();
    }
    // Clicks in the editor/main area never reach this webview; blur is the only
    // signal that focus left it, so close the popover (JetBrains dismisses
    // popovers on any click anywhere in the IDE).
    // blur does NOT bubble, but capture starts at window — so clicking inside
    // the menu (moving focus off the focused row) fires this too. Only close
    // when focus has genuinely left the webview: the setTimeout lets the focus
    // move settle first, and the branchMenu-null guard keeps a stale callback
    // from closing a menu that was already dismissed.
    function onBranchBlur() {
      setTimeout(() => {
        if (branchMenu && !document.hasFocus()) closeBranchMenu();
      }, 0);
    }
    function onBranchKey(e) {
      if (e.key === "Escape") {
        if (branchSubmenu) { closeBmSub(); return; }
        closeBranchMenu(); branchPill.focus();
      }
    }
    // A branch action that closes the menu. The in-place sync actions
    // (fetch/pull/push) post directly from their own handlers, and starring
    // goes through toggleFavorite; neither comes through here.
    function branchAct(action, ref) {
      vscode.postMessage({ type: "branchAction", action: action, ref: ref });
      closeBranchMenu();
    }
    // Star or unstar a local branch — the row's star and its submenu's item.
    // The row moves between Favorites and its group at once, with the menu,
    // the open submenu and the highlight left where they are. Until a host
    // post agrees, the star is laid over whatever the host sends
    // (applyPendingFavorites): a post it sent before it saw the star still
    // carries the old list, and must not move the row back.
    function toggleFavorite(name) {
      const b = (branchData.local || []).find((x) => x.name === name);
      if (b) {
        b.favorite = !b.favorite;
        pendingFavorites.set(name, { favorite: b.favorite, at: Date.now() });
      }
      vscode.postMessage({ type: "branchAction", action: "favorite", ref: name });
      // The list below is the one this change makes: the host's agreeing
      // post then has nothing to repaint.
      lastBranchSig = bmSig();
      refreshOpenBranchUi();
    }
    // ── Search: one scorer for the actions and every ref ─────────────────
    // A query matches a name in one of these ways, best first. A better way
    // always outranks a worse one, so an exact or a prefix match is never
    // beaten by a scattered one:
    //   exact · a prefix of the name · a prefix of its last path segment
    //   ("login" in feature/login) · a run that starts a word ("cache" in
    //   spike/the-cache) · a run anywhere · scattered letters, each one
    //   either right after the one before it or starting a word: "rel21"
    //   finds release/2.1 and "fl" feature/login, but "fe" does not find
    //   fix/some-page.
    // The actions are scored the same way, on their labels, so with a query
    // the highlight goes to the best match of all; on a tie a branch wins —
    // "fe" is feature, not Fetch — and only an action whose name the query
    // matches better (typing "fetch") takes it.
    const BM_TIER = { exact: 1000, prefix: 800, segment: 700, word: 600, run: 400, scattered: 200 };
    /** Does a word start at text[i]: the start, after a separator, a
     *  lower-to-upper case step, or a step between letters and digits. */
    function bmWordStart(text, i) {
      if (i <= 0) return true;
      const p = text.charAt(i - 1), c = text.charAt(i);
      if (/[\/\-_.\s()'"@#:,+]/.test(p)) return true;
      if (/[a-z]/.test(p) && /[A-Z]/.test(c)) return true;
      const pd = /[0-9]/.test(p), cd = /[0-9]/.test(c);
      return pd !== cd && /[A-Za-z0-9]/.test(p) && /[A-Za-z0-9]/.test(c);
    }
    function bmRun(at, n) {
      const out = [];
      for (let i = 0; i < n; i++) out.push(at + i);
      return out;
    }
    /**
     * How well q (lower case, trimmed) matches text: { s, pos } — s the
     * score, pos the index of each matched letter — or null for no match.
     */
    function bmScore(q, text) {
      if (!q) return { s: 0, pos: [] };
      const t = text.toLowerCase();
      const n = q.length;
      if (t === q) return { s: BM_TIER.exact, pos: bmRun(0, n) };
      if (t.startsWith(q)) return { s: BM_TIER.prefix, pos: bmRun(0, n) };
      const seg = t.lastIndexOf("/") + 1;
      if (seg > 0 && t.startsWith(q, seg)) return { s: BM_TIER.segment, pos: bmRun(seg, n) };
      const first = t.indexOf(q);
      if (first >= 0) {
        for (let w = first; w >= 0; w = t.indexOf(q, w + 1)) {
          // Within a way of matching, an earlier match ranks a little higher.
          if (bmWordStart(text, w)) return { s: BM_TIER.word + (99 - Math.min(w, 99)) / 100, pos: bmRun(w, n) };
        }
        return { s: BM_TIER.run + (99 - Math.min(first, 99)) / 100, pos: bmRun(first, n) };
      }
      return bmScattered(q, text, t);
    }
    /** The scattered match with the fewest separate runs (then the earliest). */
    function bmScattered(q, text, t) {
      const n = t.length, m = q.length;
      // The letters in order at all? Most names are out here, cheaply.
      let k = 0;
      for (let j = 0; j < n && k < m; j++) if (t.charCodeAt(j) === q.charCodeAt(k)) k++;
      if (k < m) return null;
      // runs[j]: the fewest runs matching q up to letter i with letter i at
      // j (Infinity: cannot); back[i][j]: where letter i - 1 was then.
      let runs = new Array(n).fill(Infinity);
      for (let j = 0; j < n; j++) if (t.charAt(j) === q.charAt(0) && bmWordStart(text, j)) runs[j] = 1;
      const back = [null];
      for (let i = 1; i < m; i++) {
        const cur = new Array(n).fill(Infinity);
        const from = new Array(n).fill(-1);
        let bestBefore = Infinity, bestAt = -1; // the best of runs[0 .. j - 2]
        for (let j = 0; j < n; j++) {
          if (j >= 2 && runs[j - 2] < bestBefore) { bestBefore = runs[j - 2]; bestAt = j - 2; }
          if (t.charAt(j) !== q.charAt(i)) continue;
          // Right after the letter before: the same run.
          if (j >= 1 && runs[j - 1] < cur[j]) { cur[j] = runs[j - 1]; from[j] = j - 1; }
          // Or a new run, which must start a word.
          if (bestAt >= 0 && bestBefore + 1 < cur[j] && bmWordStart(text, j)) { cur[j] = bestBefore + 1; from[j] = bestAt; }
        }
        back.push(from);
        runs = cur;
      }
      let end = -1, fewest = Infinity;
      for (let j = 0; j < n; j++) if (runs[j] < fewest) { fewest = runs[j]; end = j; }
      if (end < 0) return null;
      const pos = [end];
      for (let i = m - 1; i > 0; i--) pos.unshift(back[i][pos[0]]);
      return { s: BM_TIER.scattered + Math.max(1, 90 - 10 * (fewest - 1) - Math.min(pos[0], 40) / 2), pos: pos };
    }
    /** A remote branch scored on what its row shows (the name without the
     *  remote) and on its whole name ("origin/fe" finds it too); the marks
     *  land on the part shown. */
    function bmScoreRemote(q, full, shown) {
      const part = bmScore(q, shown);
      const whole = bmScore(q, full);
      if (!whole || (part && part.s >= whole.s)) return part;
      const cut = full.length - shown.length;
      return { s: whole.s, pos: whole.pos.filter((p) => p >= cut).map((p) => p - cut) };
    }

    function bIcon(name) {
      return '<i class="codicon codicon-' + name + '" aria-hidden="true"></i>';
    }
    function esc(s) {
      return s.replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    }
    /** HTML-escape text, marking the letters at pos (each run in one mark). */
    function hl(text, pos) {
      if (!pos || !pos.length) return esc(text);
      const on = new Set(pos);
      let out = "";
      for (let i = 0; i < text.length; ) {
        let j = i;
        const inMark = on.has(i);
        while (j < text.length && on.has(j) === inMark) j++;
        const part = esc(text.slice(i, j));
        out += inMark ? '<mark class="bm-hl">' + part + "</mark>" : part;
        i = j;
      }
      return out;
    }
    /** A count as a badge shows it: a number past 999 would crowd the name out. */
    function bmCount(n) { return n > 999 ? "999+" : String(n); }
    /**
     * The remote a remote-tracking name belongs to — the longest remote the
     * host listed whose namespace holds it, since a remote's own name may
     * hold a slash ("team/eu"). When strict, "" for a name under none of
     * them (an upstream that is a local branch); otherwise its first path
     * segment then, as it is when the host listed no remotes.
     */
    function bmRemoteOf(name, strict) {
      const names = branchData.remoteNames || [];
      let best = "";
      for (const r of names) if (r.length > best.length && name.startsWith(r + "/")) best = r;
      if (best || (strict && names.length)) return best;
      const i = name.indexOf("/");
      return i > 0 ? name.slice(0, i) : "";
    }
    /** What a row shows for a live upstream: only the remote ("origin") when
     *  it tracks the branch of the same name there, else the whole name. */
    function bmUpstreamShown(name, up) {
      const r = bmRemoteOf(up, true);
      return r && up === r + "/" + name ? r : up;
    }
    /** What Compare / Merge / Rebase act on, as a submenu names it: the
     *  current branch, quoted — the header's name when git lists no ref for it
     *  yet (an unborn branch) — or, HEAD detached, the commit HEAD is at. */
    function headTarget() {
      const s = lastHeaderState;
      if (s && s.detached) return "HEAD" + (s.branch ? " (" + s.branch + ")" : "");
      const cur = (branchData.local || []).find((b) => b.current);
      const name = cur ? cur.name : (s && s.branch) || "";
      return name ? "'" + name + "'" : "HEAD";
    }

    /**
     * One ref's row. r: { name, kind ("local" | "remote" | "tag"), shown (the
     * text the row shows: a remote branch without its remote), up, fav,
     * current, ahead, behind, gone, pos (matched letters of shown), s }.
     */
    function branchRow(r) {
      const name = r.name, kind = r.kind, up = r.up, current = r.current;
      const ahead = r.ahead, behind = r.behind, gone = r.gone;
      const shown = r.shown || name;
      const row = el("div", "bm-branch" + (current ? " is-current" : ""));
      if (kind === "local") {
        const fav = !!r.fav;
        const star = el("button", "bm-star" + (fav ? " on" : ""),
          bIcon(fav ? "star-full" : "star-empty"));
        star.title = fav ? "Remove from favorites" : "Add to favorites";
        // No Tab stop: focus stays in the search box. The keyboard's way to
        // a star is the branch's submenu (Add to Favorites).
        star.tabIndex = -1;
        star.addEventListener("click", (e) => { e.stopPropagation(); toggleFavorite(name); });
        row.appendChild(star);
      } else {
        row.appendChild(el("span", "bm-star-spacer"));
      }
      const icon = kind === "remote" ? "cloud"
        : kind === "tag" ? "tag"
        : current ? "check" : "git-branch";
      row.appendChild(el("i", "codicon codicon-" + icon + " bm-bicon"));
      row.dataset.bname = name; // refreshOpenBranchUi re-finds the row by name
      const nm = el("span", "bm-bname", hl(shown, r.pos));
      // What fitBranchNames needs to cut the middle out of a long name
      // around what matched.
      if (r.pos && r.pos.length) { nm.dataset.text = shown; nm.dataset.pos = r.pos.join(","); }
      row.appendChild(nm);
      // Unpushed/unpulled counts per branch — the payoff of the in-menu Fetch.
      if (ahead) row.appendChild(el("span", "bm-ab up", "↑" + bmCount(ahead)));
      if (behind) row.appendChild(el("span", "bm-ab down", "↓" + bmCount(behind)));
      if (up) {
        const u = el("span", "bm-bup" + (gone ? " is-gone" : ""));
        // Gone, it is named in full: 'origin' struck through would say the
        // remote is gone, not its branch.
        u.textContent = gone ? up : bmUpstreamShown(name, up);
        row.appendChild(u);
        // A deleted upstream says so, and keeps saying it where a narrow
        // row has no room left for the upstream's name.
        if (gone) row.appendChild(el("span", "bm-gone", "gone"));
      }
      row.appendChild(el("i", "codicon codicon-chevron-right bm-bmore"));
      // Full ref name on hover — a narrow sidebar ellipsis-clips the row, so the
      // tooltip is how the whole name (esp. long remote refs) is always readable,
      // and the counts, which a row too narrow for them drops (fitBranchRows).
      const counts = [ahead ? ahead + " to push" : "", behind ? behind + " to pull" : ""].filter(Boolean).join(", ");
      row.title = name + (up ? "  ↔ " + up + (gone ? ", which no longer exists on the remote" : "") : "") +
        (counts ? " — " + counts : "");
      row.dataset.bmkey = "b:" + kind + ":" + name;
      if (branchFilter) row.dataset.score = String(r.s);
      bmOption(row);
      // What a screen reader says when the highlight lands here — the badges
      // are arrows and numbers, so they are spelled out.
      row.setAttribute("aria-label", name +
        (current ? ", current branch" : kind === "remote" ? ", remote branch" : kind === "tag" ? ", tag" : "") +
        (ahead ? ", " + ahead + " to push" : "") +
        (behind ? ", " + behind + " to pull" : "") +
        (up ? ", tracks " + up + (gone ? ", which no longer exists on the remote" : "") : ""));
      row.addEventListener("click", () => openBranchActions(name, kind, current, row));
      return row;
    }

    // ── Per-branch action submenu (JetBrains-style) ──────────────────────────
    function subAct(command, refName, refType) {
      vscode.postMessage({ type: "branchRefCommand", command: command, ref: refName, refType: refType });
      closeBranchMenu();
    }
    /**
     * An item's tip: a title that says more than its label (it becomes the
     * item's description too), else the label itself — which the page's
     * tooltip shows only while the label is cut short (tipAdds), never over
     * a label that is there in full.
     */
    function itemTip(b, label, title) {
      if (title) b.title = title;
      else b.dataset.tip = label;
    }
    function subItem(list, icon, label, fn, danger, title) {
      const b = el("button", "bm-subaction" + (danger ? " danger" : ""), bIcon(icon) + "<span></span>");
      b.querySelector("span").textContent = label;
      itemTip(b, label, title);
      b.addEventListener("click", fn);
      list.appendChild(b);
    }
    // A submenu action that runs IN PLACE: the dialog stays open, THIS item
    // spins until the host confirms the real op finished (branchActionDone),
    // then the whole dialog stack repaints with fresh counts.
    function subItemLive(list, icon, label, busyLabel, action, ref, title) {
      const running = subLive && subLive.action === action && subLive.ref === ref;
      const b = el("button", "bm-subaction" + (running ? " is-busy" : ""),
        bIcon(running ? "loading codicon-modifier-spin" : icon) + "<span></span>");
      b.querySelector("span").textContent = running ? busyLabel : label;
      itemTip(b, label, title);
      b.addEventListener("click", () => {
        if (subLive || syncBusy || menuSyncBusy) return;
        subLive = { action: action, ref: ref };
        b.classList.add("is-busy");
        const i = b.querySelector(".codicon");
        if (i) i.className = "codicon codicon-loading codicon-modifier-spin";
        b.querySelector("span").textContent = busyLabel;
        if (action === "pull" || action === "pullMerge" || action === "pullRebase") { syncBusy = "pull"; applySyncBusy(); }
        else if (action === "push") { syncBusy = "push"; applySyncBusy(); }
        vscode.postMessage({ type: "branchAction", action: action, ref: ref });
      });
      list.appendChild(b);
    }
    function subSep(list) { list.appendChild(el("div", "bm-subsep")); }
    /** What the highlighted submenu item is (its data-sub), or null when the
     *  highlight is not in a submenu. */
    function bmSubActiveKey() {
      const item = bmSubActive >= 0 ? bmSubItems()[bmSubActive] : null;
      return item ? item.dataset.sub || "" : null;
    }
    /**
     * Repaint the open menu (badges/labels) and re-open the same branch's
     * submenu on its NEW row — an in-place live refresh of the dialog stack.
     * A keyboard highlight in the submenu stays on the same item, found by
     * what it is: the repaint can add or drop items above it (an upstream
     * that appeared, or went), and Enter must still run what was chosen. An
     * item that is gone gives the highlight to the first. subKey: the item
     * to keep, when the caller has already closed the submenu.
     */
    function refreshOpenBranchUi(subKey) {
      if (!branchMenu) return;
      const sub = subMenuFor;
      const keep = subKey !== undefined ? subKey : bmSubActiveKey();
      const backLit = bmBackLit;
      // Drilled in, the list is hidden: it comes back where it was, under
      // the actions drilled in again below.
      const drillScroll = branchMenu.classList.contains("is-drilled") ? bmDrillScroll : -1;
      renderBranchMenu(); // closes the submenu; rows rebuilt with fresh data
      if (drillScroll >= 0) { const l = bmList(); if (l) l.scrollTop = drillScroll; }
      // A query whose highlight nobody has moved stays on its best match —
      // which may be a branch that has only now arrived.
      if (!sub && branchFilter && !bmUserMoved) {
        bmActiveKey = bmBest ? bmBest.key : "";
        paintBm(true);
      }
      if (sub) {
        // By kind and name: a branch and a tag can share a short name, and
        // the name alone finds the branch's row first.
        const row = bmRowByKey("b:" + sub.kind + ":" + sub.name);
        if (row) {
          openBranchActions(sub.name, sub.kind, sub.current, row);
          if (keep !== null) {
            const i = bmSubItems().findIndex((n) => n.dataset.sub === keep);
            bmSubActive = i >= 0 ? i : 0;
          }
          // The back row the pointer rests on stays lit, drilled in again.
          if (backLit && bmBackRow()) { bmBackLit = true; bmSubActive = -1; }
          // The rebuilt submenu starts scrolled to its top; a highlight
          // further down a short view's submenu is brought back into sight.
          paintBm(bmSubActive >= 0);
        } else {
          subMenuFor = null; // the branch vanished (e.g. deleted)
        }
      }
    }

    // ---- Reusable in-sidebar action popover (files, folders, group headers:
    // right-click or Shift+F10; files also double-click) ----
    // Opens right at the row inside the sidebar — NOT the VS Code quick-pick.
    let actionMenuEl = null;
    // The row (or header) the open menu belongs to. The menu is the
    // keyboard's only way to a row's Stage, Unstage and Discard, and closing
    // it dropped the focus on the page: the next arrow key did nothing, and
    // the row that had just been staged could not hand the keyboard on.
    let actionMenuAnchor = null;
    /** Close the menu; with refocus, the keyboard goes back to the row it came from. */
    function closeActionMenu(refocus) {
      const anchor = actionMenuAnchor;
      const hadFocus = !!actionMenuEl && actionMenuEl.contains(document.activeElement);
      if (actionMenuEl) { actionMenuEl.remove(); actionMenuEl = null; }
      actionMenuAnchor = null;
      document.removeEventListener("mousedown", onActionDocDown, true);
      document.removeEventListener("keydown", onActionKey, true);
      window.removeEventListener("blur", onActionBlur, true);
      if (refocus && anchor && anchor.isConnected && (hadFocus || isPageFocus())) {
        anchor.focus({ preventScroll: true });
      }
    }
    /** Nothing in particular has the keyboard: the page itself. */
    function isPageFocus() {
      const a = document.activeElement;
      return !a || a === document.body || a === document.documentElement;
    }
    function onActionDocDown(e) {
      if (!actionMenuEl || actionMenuEl.contains(e.target)) return;
      const anchor = actionMenuAnchor;
      closeActionMenu(false);
      // A click elsewhere goes where it was aimed; only a click on nothing
      // that takes the keyboard gives it back to the menu's row.
      setTimeout(() => {
        if (anchor && anchor.isConnected && isPageFocus()) anchor.focus({ preventScroll: true });
      }, 0);
    }
    // The webview cannot see clicks in the editor/main area — those never reach
    // this document. Blur is the only signal that focus left the webview, so
    // treat it like a click-outside (JetBrains dismisses popovers on any click).
    function onActionBlur() {
      setTimeout(() => {
        if (actionMenuEl && !document.hasFocus()) closeActionMenu();
      }, 0);
    }
    function onActionKey(e) {
      if (!actionMenuEl) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        closeActionMenu(true);
        return;
      }
      // A menu's keys: Up and Down move through its items (round the ends),
      // Home and End go to the first and last, and Tab stays in the menu.
      const items = Array.prototype.slice.call(actionMenuEl.querySelectorAll(".bm-subaction"));
      if (!items.length) return;
      const i = items.indexOf(document.activeElement);
      let to = -1;
      if (e.key === "ArrowDown" || (e.key === "Tab" && !e.shiftKey)) to = i < 0 ? 0 : (i + 1) % items.length;
      else if (e.key === "ArrowUp" || (e.key === "Tab" && e.shiftKey)) to = i <= 0 ? items.length - 1 : i - 1;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = items.length - 1;
      if (to < 0) return;
      e.preventDefault();
      e.stopPropagation();
      items[to].focus();
    }
    /**
     * The in-sidebar menu for a row, a folder or a group's header, opened
     * under anchor. icon is the codicon beside its title (none for a group).
     * Choosing an item gives the keyboard back to anchor BEFORE it acts, so a
     * row the action takes out of the list hands the keyboard to the next.
     */
    function openActionMenu(title, items, anchor, icon) {
      closeActionMenu(false);
      closeBranchSubmenu();
      actionMenuAnchor = anchor || null;
      const menu = el("div", "branch-submenu action-menu");
      menu.setAttribute("role", "menu");
      if (title) menu.setAttribute("aria-label", title);
      if (title) {
        const head = el("div", "bm-subhead");
        head.setAttribute("aria-hidden", "true");
        if (icon !== null) head.appendChild(el("i", "codicon codicon-" + (icon || "file")));
        const nm = el("span", "bm-subhead-name");
        nm.textContent = title;
        head.appendChild(nm);
        menu.appendChild(head);
      }
      const list = el("div", "bm-sublist");
      list.setAttribute("role", "none");
      menu.appendChild(list);
      for (const it of items) {
        if (it.sep) { subSep(list); continue; }
        subItem(list, it.icon, it.label, () => { closeActionMenu(true); it.fn(); }, it.danger, it.tip);
      }
      list.querySelectorAll(".bm-subaction").forEach((b) => {
        b.setAttribute("role", "menuitem");
        b.tabIndex = -1;
      });
      // The pointer moves the keyboard's item, as it moves the branch
      // window's highlight: the focused item is the one lit item, under the
      // pointer or the arrows alike. Only a pointer that really moved: the
      // list scrolling under a still one (the arrows in a short view) must
      // not take the item from the keys.
      menu.addEventListener("mousemove", (e) => {
        if (!bmPointerMoved(e)) return;
        const item = e.target.closest ? e.target.closest(".bm-subaction") : null;
        if (item && document.activeElement !== item) item.focus({ preventScroll: true });
      });
      list.querySelectorAll(".bm-subsep").forEach((s) => s.setAttribute("role", "separator"));
      document.body.appendChild(menu);
      actionMenuEl = menu;
      actionMenuAnchor = anchor || null;
      // Anchor under the row's left edge; flip up / clamp so it never leaves view.
      const PAD = 6;
      const r = menu.getBoundingClientRect();
      const a = anchor.getBoundingClientRect();
      let left = Math.max(PAD, Math.min(a.left, window.innerWidth - r.width - PAD));
      let top = a.bottom + 2;
      if (top + r.height > window.innerHeight - PAD) {
        top = Math.max(PAD, a.top - r.height - 2);
      }
      menu.style.left = Math.round(left) + "px";
      menu.style.top = Math.round(top) + "px";
      document.addEventListener("mousedown", onActionDocDown, true);
      document.addEventListener("keydown", onActionKey, true);
      window.addEventListener("blur", onActionBlur, true);
      const first = list.querySelector(".bm-subaction");
      if (first) first.focus();
    }

    /**
     * "Reset to 'origin/feature'…" (#32) — on a local branch whose upstream is
     * a remote branch this repo has (upstreamOnRemote, decided by the host).
     * The host fetches first, then asks, saying what would be lost.
     */
    function resetToUpstreamItem(list, name, bd) {
      if (!bd || !bd.upstream || !bd.upstreamOnRemote) return;
      subItem(list, "discard", "Reset to '" + bd.upstream + "'…",
        () => subAct("gitstudio.branch.resetToUpstream", name, "head"), true,
        "Fetches, then makes '" + name + "' match '" + bd.upstream +
        "' exactly. Asks first, and says what would be lost.");
    }

    /** "Add to Favorites" / "Remove from Favorites" — the star, from the keyboard. */
    function favoriteItem(list, name, bd) {
      const on = !!(bd && bd.favorite);
      subItem(list, on ? "star-full" : "star-empty", on ? "Remove from Favorites" : "Add to Favorites",
        () => toggleFavorite(name));
    }

    /**
     * A ref's actions, in ONE order for every kind — a current branch, any
     * other local branch, a remote branch, a tag — with what does not apply
     * left out, and a separator only between groups that have items:
     *   switch and start from it · against HEAD · publish · its name · danger
     *   Checkout, Pull…, New Branch from…, New Worktree from…
     *   Compare with…, Merge… into…, Rebase… onto…
     *   Push…, Tracked Branch…
     *   Rename…, Copy Name, Add to Favorites
     *   Reset to '<upstream>'…, Delete
     * A branch whose upstream is gone from its remote starts with Set Tracked
     * Branch…: the one thing it needs, and the first thing its row's "gone"
     * sends you looking for.
     */
    function openBranchActions(name, kind, current, anchor) {
      closeBranchSubmenu();
      const cur = headTarget();
      const refType = kind === "remote" ? "remote" : kind === "tag" ? "tag" : "head";
      const headIcon = kind === "remote" ? "cloud" : kind === "tag" ? "tag" : "git-branch";
      const local = kind === "local";
      const menu = el("div", "branch-submenu");
      const head = el("div", "bm-subhead");
      head.setAttribute("aria-hidden", "true");
      head.appendChild(el("i", "codicon codicon-" + headIcon));
      head.appendChild(el("span", "bm-subhead-name", esc(name)));
      menu.appendChild(head);
      const list = el("div", "bm-sublist");
      list.id = "bm-sub";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Actions for " + name);
      menu.appendChild(list);

      // Live branch data for this row (counts may have just changed via Fetch).
      const bd = local ? (branchData.local || []).find((x) => x.name === name) : null;
      const gone = !!(bd && bd.gone);
      subMenuFor = { name: name, kind: kind, current: current };
      // The row this submenu belongs to holds the main list's highlight.
      if (anchor && anchor.dataset && anchor.dataset.bmkey) bmActiveKey = anchor.dataset.bmkey;

      // Each item carries what it is (data-sub), so a repaint that adds or
      // drops items above it finds it again by that, not by its place.
      const groups = [[], [], [], [], []];
      const add = (g, key, fn) => groups[g].push((l) => {
        const before = l.querySelectorAll(".bm-subaction").length;
        fn(l);
        const items = l.querySelectorAll(".bm-subaction");
        for (let i = before; i < items.length; i++) items[i].dataset.sub = key;
      });
      const trackedItem = (l) => subItem(l, "cloud",
        bd && bd.upstream && !gone ? "Tracked Branch: " + bd.upstream + "…" : "Set Tracked Branch…",
        () => subAct("gitstudio.branch.setUpstream", name, refType), false,
        gone ? "'" + bd.upstream + "', which '" + name + "' tracked, no longer exists on the remote. Choose the branch it tracks now."
          : bd && bd.upstream ? "'" + name + "' tracks " + bd.upstream + ". Choose another branch to track."
          : "Choose the remote branch '" + name + "' pulls from and pushes to.");

      // Switch to it, or start something from it.
      if (local && gone) add(0, "tracked", trackedItem);
      if (kind === "tag") {
        add(0, "checkout", (l) => subItem(l, "arrow-swap", "Checkout Tag (detached)", () => subAct("gitstudio.tag.checkout", name, "tag")));
      } else if (!current) {
        // Not the check: in this menu that marks the branch that IS checked out.
        add(0, "checkout", (l) => subItem(l, kind === "remote" ? "cloud-download" : "arrow-swap", "Checkout", () =>
          subAct(kind === "remote" ? "gitstudio.remoteBranch.checkout" : "gitstudio.branch.checkout", name, refType)));
      }
      // Nothing to pull without an upstream, nor from one deleted from its
      // remote: the pull could only fail. Push… can still publish the branch.
      if (current && bd && bd.upstream && !gone) {
        add(0, "pullRebase", (l) => subItemLive(l, "arrow-down", "Pull using Rebase", "Pulling…", "pullRebase", name));
        add(0, "pullMerge", (l) => subItemLive(l, "arrow-down", "Pull using Merge", "Pulling…", "pullMerge", name));
      } else if (local && !current && bd && bd.upstream && !gone) {
        // Fast-forward this branch from its upstream WITHOUT checking it out.
        add(0, "pullFf", (l) => subItemLive(l, "arrow-down",
          "Pull " + (bd.behind ? bd.behind + (bd.behind === 1 ? " Commit " : " Commits ") : "") + "into '" + name + "'",
          "Pulling…", "pullFf", name,
          "Fast-forwards '" + name + "' from " + bd.upstream + " — no checkout"));
      }
      add(0, "newBranch", (l) => subItem(l, "add", "New Branch from '" + name + "'…", () => subAct("gitstudio.branch.new", name, refType)));
      add(0, "worktree", (l) => subItem(l, "worktree", "New Worktree from '" + name + "'…", () => subAct("gitstudio.branch.createWorktree", name, refType)));

      // Against what HEAD is on (nothing to compare the current branch with).
      if (!current) {
        add(1, "compare", (l) => subItem(l, "git-compare", "Compare with " + cur, () => subAct("gitstudio.branch.compare", name, refType)));
        add(1, "merge", (l) => subItem(l, "git-merge", "Merge '" + name + "' into " + cur, () => subAct("gitstudio.branch.merge", name, refType)));
        // Not the pull-request glyph: a rebase opens no pull request. The
        // replayed, reordered list is GitStudio's glyph for a rebase.
        if (kind !== "tag") {
          add(1, "rebase", (l) => subItem(l, "list-ordered", "Rebase " + cur + " onto '" + name + "'", () => subAct("gitstudio.branch.rebase", name, refType)));
        }
      }

      // Publish it.
      if (kind === "tag") {
        add(2, "push", (l) => subItem(l, "cloud-upload", "Push Tag to Remote…", () => subAct("gitstudio.tag.push", name, "tag")));
      } else if (current) {
        // Push opens the review modal (see openPushModal) rather than pushing in
        // place, so every push route funnels through the same confirmation.
        add(2, "push", (l) => subItem(l, "arrow-up", "Push…", () => {
          closeBranchMenu();
          vscode.postMessage({ type: "requestPushPreview" });
        }));
      } else if (local) {
        add(2, "push", (l) => subItem(l, "arrow-up", "Push…", () => subAct("gitstudio.branch.push", name, refType)));
      }
      if ((local || current) && !gone) add(2, "tracked", trackedItem);

      // Its name.
      if (local || current) add(3, "rename", (l) => subItem(l, "edit", "Rename…", () => subAct("gitstudio.branch.rename", name, refType)));
      add(3, "copy", (l) => subItem(l, "copy", kind === "tag" ? "Copy Tag Name" : "Copy Branch Name", () => branchAct("copyName", name)));
      if (local || current) add(3, "favorite", (l) => favoriteItem(l, name, bd));

      // What cannot be taken back without Undo.
      if (local || current) add(4, "reset", (l) => resetToUpstreamItem(l, name, bd));
      if (kind === "tag") {
        add(4, "delete", (l) => subItem(l, "trash", "Delete Tag", () => subAct("gitstudio.tag.delete", name, "tag"), true));
      } else if (!current) {
        add(4, "delete", (l) => subItem(l, "trash", "Delete", () =>
          subAct(kind === "remote" ? "gitstudio.remoteBranch.delete" : "gitstudio.branch.delete", name, refType), true));
      }

      // A group's builders can add nothing (Reset has no upstream to go to):
      // a separator goes only between groups that drew items.
      for (const g of groups) {
        const before = list.children.length;
        const hadItems = !!list.querySelector(".bm-subaction");
        const sep = hadItems ? el("div", "bm-subsep") : null;
        if (sep) list.appendChild(sep);
        g.forEach((fn) => fn(list));
        if (sep && list.children.length === before + 1) sep.remove();
      }

      // Options of the submenu's listbox, for aria-activedescendant. None
      // takes a Tab stop: focus stays in the search box.
      list.querySelectorAll(".bm-subaction").forEach((b, i) => {
        b.id = "bm-sub-" + i;
        b.tabIndex = -1;
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", "false");
      });
      list.querySelectorAll(".bm-subsep").forEach((s) => s.setAttribute("aria-hidden", "true"));
      // The highlight follows the pointer here too. A press never takes focus
      // from the search box, so the keys keep working after a click.
      menu.addEventListener("mousemove", (e) => {
        if (!bmPointerMoved(e)) return;
        const on = e.target.closest ? e.target : null;
        // Drilled in, the back row is one of the rows the pointer lights.
        if (on && on.closest(".bm-subhead") && menu.classList.contains("is-drilled")) {
          if (bmBackLit) return;
          bmBackLit = true;
          bmSubActive = -1;
          paintBm(false);
          return;
        }
        const item = on ? on.closest(".bm-subaction") : null;
        const i = item ? bmSubItems().indexOf(item) : -1;
        if (i < 0 || (i === bmSubActive && !bmBackLit)) return;
        bmBackLit = false;
        bmSubActive = i;
        paintBm(false);
      });
      // Nor does a press anywhere in the submenu: an item, its title band, a
      // separator, the padding.
      menu.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const box = branchMenu && branchMenu.querySelector(".bm-search input");
        if (box && document.activeElement !== box) box.focus();
      });

      // Beside the menu when the view has room for it there — off its right
      // edge, else its left — and otherwise IN it: a submenu laid over the
      // menu hid the list and the very row it belonged to, with no way back
      // but Escape. The room it asks for is a ref's actions at their widest
      // (the submenu's max-width), not this ref's: its labels quote its
      // name, and one row's actions must not open beside a menu whose next
      // row's open in it. Measured as it would cascade, before it is shown.
      const SEAM = 2;
      const PAD = 6;
      menu.style.visibility = "hidden";
      document.body.appendChild(menu);
      branchSubmenu = menu;
      const subW = menu.getBoundingClientRect().width;
      const widest = Math.max(subW, parseFloat(getComputedStyle(menu).maxWidth) || 0);
      const menuRect = branchMenu
        ? branchMenu.getBoundingClientRect()
        : anchor.getBoundingClientRect();
      const W = window.innerWidth;
      let left = -1;
      if (menuRect.right - SEAM + widest <= W - PAD) left = menuRect.right - SEAM;
      else if (menuRect.left + SEAM - widest >= PAD) left = menuRect.left + SEAM - subW;

      if (left < 0 && branchMenu) {
        // Drilled in: the actions take the list's place, under a back row.
        const l0 = bmList();
        bmDrillScroll = l0 ? l0.scrollTop : 0;
        menu.classList.add("is-drilled");
        head.removeAttribute("aria-hidden");
        head.insertBefore(el("i", "codicon codicon-chevron-left bm-back"), head.firstChild);
        head.title = "Back to the branches (Left or Escape)";
        // A way back, as a screen reader meets it: a button that says so —
        // no Tab stop, as nothing in the menu has one — and the actions'
        // list says the keys that go back.
        head.setAttribute("role", "button");
        head.setAttribute("aria-label", "Back to the branches");
        head.tabIndex = -1;
        head.addEventListener("click", () => closeBmSub());
        const hint = el("span", "bm-sr");
        hint.id = "bm-back-hint";
        hint.textContent = "Left or Escape goes back to the branches";
        menu.appendChild(hint);
        list.setAttribute("aria-describedby", "bm-back-hint");
        branchMenu.appendChild(menu);
        branchMenu.classList.add("is-drilled");
        menu.style.visibility = "";
        paintBm(false);
        return;
      }

      // Cascaded: vertically aligned to the clicked row, clamped to the view.
      const subH = menu.getBoundingClientRect().height;
      const rowRect = anchor.getBoundingClientRect();
      if (left < 0) left = Math.max(PAD, Math.min(menuRect.right - SEAM, W - subW - PAD));
      let top = rowRect.top;
      if (top + subH > window.innerHeight - PAD) {
        top = window.innerHeight - subH - PAD;
      }
      top = Math.max(PAD, top);

      menu.style.left = Math.round(left) + "px";
      menu.style.top = Math.round(top) + "px";
      menu.style.visibility = "";
      paintBm(false);
    }

    /**
     * The top actions. Pull and Push have no branch to act on at a detached
     * HEAD, and Pull nothing to pull from for a branch with no upstream (or
     * a gone one): one line says so in their place. "terms" are other words a
     * person may look for one by ("update" was Pull's old name): they find
     * it, but never outrank a name the query really matches.
     */
    const BM_ACTIONS = [
      // Fetch sits on TOP: it's the read-only "what's out there?" action the
      // rest of the menu builds on.
      { a: "fetch", icon: "sync", label: "Fetch" },
      { a: "pull", icon: "arrow-down", label: "Pull", terms: ["update"] },
      // It opens the push review first, so it asks for more, as "…" says.
      { a: "push", icon: "arrow-up", label: "Push…" },
      { a: "new", icon: "add", label: "New Branch…", terms: ["create branch"] },
      { a: "checkoutRef", icon: "tag", label: "Checkout Tag or Revision…", terms: ["detach"] },
    ];
    /** An action's match: on its label (without its "…"), or on one of its terms. */
    function bmScoreAction(q, it) {
      let best = bmScore(q, it.label.replace(/…$/, ""));
      for (const term of it.terms || []) {
        const m = bmScore(q, term);
        const s = m ? Math.min(m.s, BM_TIER.word) : 0;
        if (m && (!best || s > best.s)) best = { s: s, pos: [] };
      }
      return best;
    }
    /** "New Branch", its name typed or to type. Created at HEAD, switched to. */
    function promptNewBranch(value) {
      closeBranchMenu();
      openRefPrompt({
        title: "New Branch",
        hint: "Creates the branch at HEAD and switches to it.",
        placeholder: "feature/my-change",
        value: value || "",
        confirmLabel: "Create Branch",
        candidates: [],
        allowFreeText: true,
        validate: "refName",
        onConfirm: function (v) {
          vscode.postMessage({ type: "branchAction", action: "new", ref: v });
        },
      });
    }
    /** "Checkout Tag or Revision": any revision, checked out as a detached HEAD. */
    function promptCheckoutRef(value) {
      closeBranchMenu();
      openRefPrompt({
        title: "Checkout Tag or Revision",
        hint: "Pick a tag or branch, or type any revision (a sha, origin/main~3). Checks out as a detached HEAD.",
        placeholder: "v1.2.0   a1b2c3d   origin/main~3",
        value: value || "",
        confirmLabel: "Checkout",
        candidates: allRefCandidates(),
        allowFreeText: true,
        // git would read it as one of its options.
        validate: function (v) { return /^-/.test(v) ? "A revision can't start with '-'." : null; },
        // A ref picked from the list goes with its kind, and the host checks
        // out that ref by its full name: a tag and a branch can share the
        // short one, and git would take the branch. What was typed goes as
        // typed, a revision git reads for itself.
        onConfirm: function (v, pick) {
          const refType = pick ? { branch: "head", remote: "remote", tag: "tag" }[pick.kind] : undefined;
          vscode.postMessage({ type: "branchAction", action: "checkoutRef", ref: v, refType: refType });
        },
      });
    }

    function renderBranchMenu() {
      if (!branchMenu) return;
      closeBranchSubmenu();
      const list = branchMenu.querySelector(".bm-list");
      const input = branchMenu.querySelector(".bm-search input");
      list.replaceChildren();
      const q = branchFilter;
      // The best match so far: a higher score, or on a tie a ref over an action.
      bmBest = null;
      const consider = (key, s, isAction) => {
        if (!q) return;
        if (!bmBest || s > bmBest.s || (s === bmBest.s && bmBest.action && !isAction)) {
          bmBest = { key: key, s: s, action: isAction };
        }
      };
      const hs = lastHeaderState;
      const detached = !!(hs && hs.detached);

      // Fetch/pull/push all run IN PLACE — the dialog stays open, the item
      // itself spins until the real op finishes, and the branch rows' ↑/↓
      // badges refresh live.
      const busyLabels = { fetch: "Fetching…", pull: "Pulling…", push: "Pushing…" };
      // Nothing to pull into the branch HEAD is on when it tracks nothing, or
      // tracks a branch gone from its remote — the pull could only fail. Its
      // own actions offer no Pull then either (openBranchActions): one rule.
      const cur = detached ? null : (branchData.local || []).find((b) => b.current);
      const noPull = !!cur && (!cur.upstream || !!cur.gone);
      /** The query is looking for this action: its name or a term found by
       *  a start or a word's start, not by one letter somewhere inside. */
      const lookingFor = (it) => {
        const m = bmScoreAction(q, it);
        return !!m && m.s >= BM_TIER.word;
      };
      // Where Pull and Push are not offered, one line says why, in their
      // place: on a detached HEAD with the box empty too (both are gone);
      // otherwise only when the query is looking for the one that is gone.
      const why = detached ? !q || lookingFor(BM_ACTIONS[1]) || lookingFor(BM_ACTIONS[2])
        : noPull && !!q && lookingFor(BM_ACTIONS[1]);
      for (const it of BM_ACTIONS) {
        const live = it.a === "fetch" || it.a === "pull" || it.a === "push";
        if ((detached && (it.a === "pull" || it.a === "push")) || (noPull && it.a === "pull")) {
          if (it.a === "pull" && why) {
            const line = el("div", "bm-why", bIcon("info") + "<span></span>");
            line.id = "bm-why";
            line.querySelector("span").textContent = detached
              ? "Detached at " + (hs.branch || "HEAD") + " — check out a branch to pull or push"
              : cur.gone
                ? "'" + cur.name + "' tracks " + cur.upstream + ", which no longer exists on the remote"
                : "'" + cur.name + "' has no upstream to pull from";
            list.appendChild(line);
          }
          continue;
        }
        const m = bmScoreAction(q, it);
        if (!m) continue;
        const spinning = live && menuSyncBusy === it.a;
        const b = el("button", "bm-action" + (spinning ? " is-busy" : ""),
          bIcon(spinning ? "loading codicon-modifier-spin" : it.icon) + "<span></span>");
        b.querySelector("span").innerHTML = spinning ? busyLabels[it.a] : hl(it.label, m.pos);
        b.dataset.bmkey = "a:" + it.a;
        if (q) b.dataset.score = String(m.s);
        b.tabIndex = -1; // the arrows reach it; Tab never leaves the search box
        bmOption(b);
        consider(b.dataset.bmkey, m.s, true);
        b.addEventListener("click", () => {
          if (live) {
            if (menuSyncBusy || syncBusy) return;
            // Push routes through the review modal, not a silent in-place push.
            if (it.a === "push") {
              closeBranchMenu();
              vscode.postMessage({ type: "requestPushPreview" });
              return;
            }
            menuSyncBusy = it.a;
            if (it.a === "fetch") {
              vscode.postMessage({ type: "branchAction", action: "fetch" });
            } else {
              startSync(it.a); // the header pill mirrors the in-flight state
            }
            renderBranchMenu();
          } else if (it.a === "new") {
            promptNewBranch("");
          } else if (it.a === "checkoutRef") {
            promptCheckoutRef("");
          } else {
            branchAct(it.a);
          }
        });
        list.appendChild(b);
      }
      if (input) {
        if (why) input.setAttribute("aria-describedby", "bm-why");
        else input.removeAttribute("aria-describedby");
      }

      /** A group's rows: with a query, each scored, the rest out, the best
       *  first — ties keep the list's own order (the sort is stable). */
      function scored(rows) {
        if (!q) return rows;
        const out = [];
        for (const r of rows) {
          const m = r.kind === "remote" ? bmScoreRemote(q, r.name, r.shown) : bmScore(q, r.name);
          if (!m) continue;
          r.s = m.s;
          r.pos = m.pos;
          out.push(r);
        }
        return out.sort((a, b) => b.s - a.s);
      }
      const localRow = (b) => ({
        name: b.name, kind: "local", up: b.upstream, fav: b.favorite, current: b.current,
        ahead: b.ahead, behind: b.behind, gone: b.gone,
      });
      const locals = branchData.local || [];
      const recentNames = branchData.recent || [];
      const favs = scored(locals.filter((b) => b.favorite).map(localRow));
      const recents = scored(recentNames
        .map((n) => locals.find((b) => b.name === n))
        .filter((b) => b && !b.favorite)
        .map(localRow));
      const others = scored(locals
        .filter((b) => !b.favorite && recentNames.indexOf(b.name) === -1)
        .map(localRow));
      // Remote branches by remote — origin, upstream, a fork — each its own
      // group, its rows named without the remote the heading already says.
      const byRemote = new Map();
      for (const n of branchData.remote || []) {
        const r = bmRemoteOf(n);
        if (!byRemote.has(r)) byRemote.set(r, []);
        byRemote.get(r).push({ name: n, kind: "remote", shown: r ? n.slice(r.length + 1) : n });
      }
      const remotes = [];
      for (const [r, rows] of byRemote) remotes.push({ remote: r, rows: scored(rows) });
      const tags = scored((branchData.tags || []).map((n) => ({ name: n, kind: "tag" })));

      // A collapsible category: a heading (chevron, label, count) over its
      // rows. While searching it is open, so every match shows. A paged one
      // renders PAGE rows and a "Show more" row that renders PAGE more.
      function group(key, label, rows, opts) {
        if (!rows.length) return;
        const remote = opts && opts.remote;
        const collapsed = !q && !!collapsedCats[key];
        const wrap = el("div", "bm-group");
        const head = el("button", "bm-sep" + (collapsed ? " collapsed" : ""),
          bIcon("chevron-down") + '<span class="bm-sep-label"></span><span class="bm-sep-count"></span>');
        const lab = head.querySelector(".bm-sep-label");
        lab.textContent = label;
        if (remote) lab.appendChild(el("span", "bm-sep-remote", esc(remote)));
        head.querySelector(".bm-sep-count").textContent = String(rows.length);
        // Its name in words: read from the text it would be "REMOTEorigin 56"
        // (the remote's name is set off by a margin, not a space).
        const noun = key === "tags" ? (rows.length === 1 ? " tag" : " tags") : rows.length === 1 ? " branch" : " branches";
        head.setAttribute("aria-label", (remote ? label + " " + remote : label) + ", " + rows.length + noun);
        head.setAttribute("aria-expanded", collapsed ? "false" : "true");
        head.tabIndex = -1; // a click folds it; Tab never leaves the search box
        const body = el("div", "bm-group-body");
        body.setAttribute("role", "group");
        body.setAttribute("aria-label", remote ? label + " " + remote : label);
        if (collapsed) body.style.display = "none";
        const limit = opts && opts.paged ? (pageLimits[key] || PAGE) : rows.length;
        const shown = rows.slice(0, limit);
        shown.forEach((r) => {
          const row = branchRow(r);
          body.appendChild(row);
          consider(row.dataset.bmkey, r.s, false);
        });
        const more = rows.length - shown.length;
        if (more > 0) {
          const moreRow = el("div", "bm-more", showMoreLabel(more, PAGE));
          moreRow.dataset.bmkey = "more:" + key;
          bmOption(moreRow);
          // The arrows reach it and Enter runs it from the search box, which
          // keeps focus: no Tab stop of its own.
          moreRow.setAttribute("tabindex", "-1");
          moreRow.addEventListener("click", (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            // The highlight goes to the first of the rows it adds: where
            // "Show more" was.
            const at = bmRows().findIndex((n) => n.dataset.bmkey === "more:" + key);
            pageLimits[key] = limit + PAGE;
            renderBranchMenu();
            const rowsNow = bmRows();
            if (at >= 0 && rowsNow[at]) {
              bmActiveKey = rowsNow[at].dataset.bmkey;
              bmUserMoved = true;
              paintBm(true);
            }
          });
          body.appendChild(moreRow);
        }
        head.addEventListener("click", () => {
          collapsedCats[key] = !collapsedCats[key];
          const c = !!collapsedCats[key];
          head.classList.toggle("collapsed", c);
          head.setAttribute("aria-expanded", c ? "false" : "true");
          body.style.display = c ? "none" : "";
          // A highlighted row folded away has nowhere to be seen.
          if (c && bmActiveKey && body.contains(bmRowByKey(bmActiveKey))) {
            bmActiveKey = "";
            paintBm(false);
          }
          fitBranchNames();
        });
        wrap.appendChild(head);
        wrap.appendChild(body);
        list.appendChild(wrap);
      }

      group("favorites", "Favorites", favs);
      group("recents", "Recents", recents);
      group("local", "Local", others);
      for (const g of remotes) group("remote:" + g.remote, "Remote", g.rows, { remote: g.remote, paged: true });
      // Tags can number in the thousands: paged, never capped, so every tag
      // stays reachable.
      group("tags", "Tags", tags, { paged: true });

      const anyRef = favs.length || recents.length || others.length || tags.length ||
        remotes.some((g) => g.rows.length);
      if (branchesLoading) {
        // The host has not listed this repository's branches yet (its first
        // push carries none): say so, rather than show a repository with none.
        list.appendChild(el("div", "bm-empty bm-loading",
          bIcon("loading codicon-modifier-spin") + "<span>Loading branches…</span>"));
      } else if (q && !anyRef) {
        // No ref by that name: offer to make one, or to check out what was
        // typed as a revision (a sha, origin/main~3). The new branch is the
        // first, so Enter makes it — unless an action matched.
        const none = el("div", "bm-empty bm-none");
        none.textContent = "No branch or tag matches '" + branchQuery + "'";
        list.appendChild(none);
        const offer = (key, icon, label, run) => {
          const b = el("button", "bm-action", bIcon(icon) + "<span></span>");
          b.querySelector("span").textContent = label;
          b.title = label;
          b.dataset.bmkey = key;
          b.dataset.score = "1";
          b.tabIndex = -1;
          bmOption(b);
          consider(key, 1, true);
          b.addEventListener("click", run);
          list.appendChild(b);
        };
        const typed = branchQuery;
        offer("a:newNamed", "add", "New Branch '" + typed + "'…", () => promptNewBranch(typed));
        offer("a:checkoutNamed", "arrow-swap", "Checkout Revision '" + typed + "'…", () => promptCheckoutRef(typed));
      }
      // The whole list is showing: the width it needs is the width to keep
      // while a query narrows it (the branches may have just arrived).
      if (!q) holdBranchMenuWidth();
      // New rows can be wider (a longer name arrived, more tags shown): the
      // box is kept inside the view.
      placeBranchMenu();
      fitBranchRows();
      fitBranchNames();
      // The rows are new; the highlight finds its row again by key.
      paintBm(false);
    }
    /**
     * The width the menu keeps while you type, so fewer, shorter rows never
     * pull its edge in under the pointer — nor a long query push it out:
     * what its whole list needs, never less than it had. Taken with the box
     * empty (on open, when the branches arrive, when the box is cleared) and
     * when the view is resized, so branches that arrive after it opened, or
     * a view widened under it, widen it for good. It never outgrows the view.
     */
    function holdBranchMenuWidth() {
      if (!branchMenu) return;
      branchMenu.style.width = "";
      bmHeldWidth = Math.max(bmHeldWidth, Math.ceil(branchMenu.getBoundingClientRect().width));
      branchMenu.style.width = "min(" + bmHeldWidth + "px, calc(100vw - 12px))";
    }
    /** The same, from the whole list while a query shows only part of it:
     *  the branches arrived after something was typed. */
    function holdWholeListWidth() {
      const f = branchFilter;
      branchFilter = "";
      renderBranchMenu();
      branchFilter = f;
    }
    /**
     * A branch's name keeps at least 45% of its row, or all of itself when it
     * is shorter than that. The upstream label gives way first, by its own
     * CSS; the ↑/↓ counts are next, whole — never cut to a smaller number —
     * and stay in the row's tooltip and spoken label. Only rows with counts
     * are measured: one layout, then the reads, then the writes.
     */
    function fitBranchRows() {
      const list = bmList();
      if (!list) return;
      const rows = Array.prototype.filter.call(list.querySelectorAll(".bm-branch"),
        (r) => !!r.querySelector(".bm-ab") && !r.classList.contains("is-cramped"));
      const cramped = rows.filter((r) => {
        const n = r.querySelector(".bm-bname");
        return n.scrollWidth > n.clientWidth + 0.5 && n.clientWidth < 0.45 * r.clientWidth;
      });
      cramped.forEach((r) => r.classList.add("is-cramped"));
    }

    // Measures text for fitBranchNames without laying anything out.
    let bmMeasure = null;
    function bmTextWidth(font, s) {
      if (!bmMeasure) bmMeasure = document.createElement("canvas").getContext("2d");
      bmMeasure.font = font;
      return bmMeasure.measureText(s).width;
    }
    /**
     * A long name whose match lies past the end of its row is cut in the
     * middle instead of at the end — its first path segment, "…", then the
     * segment (or the word) the match is in — so what was typed is in sight:
     * "feature/…/billing-address-valid…" for "billing". Only rows on screen
     * with a match are measured, once each; the full name is in the row's
     * tooltip and spoken label.
     */
    function fitBranchNames() {
      const list = bmList();
      if (!list || !branchFilter || !branchMenu || branchMenu.classList.contains("is-drilled")) return;
      const box = list.getBoundingClientRect();
      const todo = [];
      list.querySelectorAll(".bm-bname[data-pos]:not([data-cut])").forEach((nm) => {
        const r = nm.getBoundingClientRect();
        if (r.height === 0 || r.bottom < box.top || r.top > box.bottom) return;
        if (nm.scrollWidth <= nm.clientWidth + 0.5) { nm.dataset.cut = "0"; return; }
        const cs = getComputedStyle(nm);
        // Measured as if every letter were as bold as a match: it errs
        // towards showing a letter less, never a match hidden.
        todo.push({ nm: nm, avail: nm.clientWidth, font: cs.fontStyle + " 600 " + cs.fontSize + " " + cs.fontFamily });
      });
      for (const t of todo) {
        const text = t.nm.dataset.text;
        const pos = t.nm.dataset.pos.split(",").map(Number);
        const cut = bmMiddleCut(text, pos, t.avail, (s) => bmTextWidth(t.font, s));
        t.nm.dataset.cut = cut ? "1" : "0";
        if (cut) t.nm.innerHTML = hl(cut.text, cut.pos);
      }
    }
    /**
     * Where to cut text so every letter at pos shows in avail pixels, or null
     * when an ellipsis at its end already leaves them in sight. A scattered
     * match ("fval": the f of feature, the val of validation) has several
     * runs of matched letters; each keeps some of what is around it, and
     * "…" stands for what lies between. What is kept, most first:
     *   · of the name's start: its first path segment, else its first word,
     *     else nothing — and all of it up to a run that starts the name;
     *   · before each run: its path segment (with the slash before it), else
     *     its word, else the run alone;
     *   · after a run: the rest of its word, or, for the run alone, nothing.
     *     The last run keeps everything after it, cut at the row's end.
     * The first way that fits is the one: "feature/…/billing-address-val…"
     * for "billing", "feature/…validation-for…" for "fval".
     */
    function bmMiddleCut(text, pos, avail, width) {
      const ELL = "…";
      const last = pos[pos.length - 1];
      if (width(text.slice(0, last + 1)) + width(ELL) <= avail) return null;
      // The matched letters as runs, each [from, to).
      const runs = [];
      for (const p of pos) {
        const r = runs[runs.length - 1];
        if (r && p === r[1]) r[1] = p + 1;
        else runs.push([p, p + 1]);
      }
      const SEP = /[\/\-_.\s()'"@#:,+]/;
      /** Where the word holding text[i - 1] ends. */
      const wordEnd = (i) => {
        let j = i;
        while (j < text.length && !SEP.test(text.charAt(j)) && !bmWordStart(text, j)) j++;
        return j;
      };
      /** Where a run's kept text starts, at each level: its path segment, its word, itself. */
      const before = (s, level) => {
        let from = s;
        if (level === 0) from = text.lastIndexOf("/", s - 1) + 1;
        else if (level === 1) while (from > 0 && !bmWordStart(text, from)) from--;
        // A kept path segment keeps the slash before it: "feature/…/billing".
        return from > 0 && text.charAt(from - 1) === "/" ? from - 1 : from;
      };
      let firstWord = 1;
      while (firstWord < text.length && !bmWordStart(text, firstWord)) firstWord++;
      const heads = [text.indexOf("/") + 1, firstWord, 0];
      /** The name with what lies between the kept parts as "…", and where each matched letter went. */
      const build = (level, h) => {
        const keep = [];
        if (h > 0) keep.push([0, h]);
        runs.forEach((r, k) => {
          // A run that starts the name keeps the name's start.
          const from = k === 0 && r[0] <= 1 ? 0 : before(r[0], level);
          const to = k === runs.length - 1 ? text.length : level === 2 ? r[1] : wordEnd(r[1]);
          keep.push([from, to]);
        });
        keep.sort((a, b) => a[0] - b[0]);
        // Merged where they touch, or where "…" would be no shorter than what it stands for.
        const merged = [];
        for (const [a, b] of keep) {
          const m = merged[merged.length - 1];
          if (m && (a <= m[1] || width(text.slice(m[1], a)) <= width(ELL))) m[1] = Math.max(m[1], b);
          else merged.push([a, b]);
        }
        if (merged[0][0] > 0 && width(text.slice(0, merged[0][0])) <= width(ELL)) merged[0][0] = 0;
        let out = "";
        const at = new Map();
        merged.forEach(([a, b]) => {
          if (a > 0) out += ELL;
          for (let i = a; i < b; i++) at.set(i, out.length + i - a);
          out += text.slice(a, b);
        });
        const mapped = pos.map((p) => at.get(p));
        return { text: out, pos: mapped, fits: width(out.slice(0, mapped[mapped.length - 1] + 1)) + width(ELL) <= avail };
      };
      // Most kept first: around each run, then of the name's start — but a
      // run that starts the name keeps its first path segment whole before
      // anything around the other runs ("feature/…validation", never
      // "feature…/billing-address-validation" beside it on the next row).
      const tries = [];
      if (runs[0][0] <= 1) {
        for (const h of [heads[0], 0]) for (let level = 0; level <= 2; level++) tries.push([level, h]);
      } else {
        for (let level = 0; level <= 2; level++) for (const h of heads) tries.push([level, h]);
      }
      let cut = null;
      for (const [level, h] of tries) {
        cut = build(level, h);
        if (cut.fits) break;
      }
      // Nothing fits the row: the closest cut still shows the most of what matched.
      return cut.text === text ? null : cut;
    }

    // ── GitStudio dialogs ─────────────────────────────────────────────────
    // Real dialogs inside the webview, instead of vscode.window.showInputBox /
    // showQuickPick / showXMessage({modal:true}). Four reasons the built-ins
    // were wrong here: the quick input IS the command palette (a search bar)
    // wearing a different hat; alt-tabbing away destroys it AND whatever you
    // had typed; it cannot complete over the branches and tags this webview is
    // already holding; and a modal message box is OS chrome unrelated to the
    // surface you clicked in. These complete as you type, keep free text for
    // revision expressions like origin/main~3 or a bare sha, and survive focus
    // loss because they are just DOM.
    //
    // Two entry points, one renderer:
    //   • openRefPrompt(opts)  — opened by this webview's own UI (branch menu).
    //   • a "dialog" message   — opened by host-side command code, which awaits
    //                            the "dialogResult" reply. See ui/dialogs.ts.
    var dlgEl = null;
    var dlgBackdrop = null;
    var dlgKeyHandler = null;
    var dlgReturnFocus = null;
    /** Correlation id of a host-requested dialog, so we can answer exactly once. */
    var dlgHostId = null;
    /** The open dialog's checkboxes ("Also delete the branch"), answered with it. */
    var dlgOptionBoxes = [];

    /**
     * A pick's or a confirm's checkboxes, above the footer: a real checkbox with
     * its label and a line saying what checking it does. Their checked ids go
     * back with the answer (closeDialog).
     */
    function renderDialogOptions(panel, spec) {
      dlgOptionBoxes = [];
      var opts = spec.options || [];
      if (!opts.length) return;
      var box = el("div", "rp-options");
      opts.forEach(function (o, i) {
        var row = document.createElement("label");
        row.className = "rp-option";
        var input = document.createElement("input");
        input.type = "checkbox";
        input.className = "rp-check";
        input.checked = !!o.checked;
        input.dataset.optionId = o.id;
        input.id = "rp-option-" + i;
        var text = el("span", "rp-choice-text");
        var label = el("span", "rp-choice-label");
        label.textContent = o.label;
        text.appendChild(label);
        if (o.description) {
          var desc = el("span", "rp-choice-desc");
          desc.textContent = o.description;
          text.appendChild(desc);
          input.setAttribute("aria-describedby", "rp-option-desc-" + i);
          desc.id = "rp-option-desc-" + i;
        }
        // Space toggles the box; Enter still answers the question.
        input.addEventListener("keydown", function (e) { if (e.key === " ") e.stopPropagation(); });
        row.appendChild(input);
        row.appendChild(text);
        box.appendChild(row);
        dlgOptionBoxes.push(input);
      });
      panel.appendChild(box);
    }

    /** The checked options' ids, when the open dialog has any. */
    function checkedDialogOptions() {
      return dlgOptionBoxes.filter(function (b) { return b.checked; })
        .map(function (b) { return b.dataset.optionId; });
    }

    /**
     * Remove the dialog's DOM and listeners WITHOUT answering anyone.
     *
     * Separate from closeDialog because opening a dialog has to dismantle the
     * previous one, and that teardown must not post a result under whatever id
     * is current — see startDialog.
     */
    function teardownDialog() {
      if (dlgKeyHandler) {
        window.removeEventListener("keydown", dlgKeyHandler, true);
        dlgKeyHandler = null;
      }
      if (dlgBackdrop) { dlgBackdrop.remove(); dlgBackdrop = null; }
      if (dlgEl) { dlgEl.remove(); dlgEl = null; }
      // Put focus back where it came from; otherwise it falls to <body> and the
      // next Tab restarts from the top of the view.
      if (dlgReturnFocus && dlgReturnFocus.focus) {
        try { dlgReturnFocus.focus(); } catch (e) { /* gone from the DOM */ }
      }
      dlgReturnFocus = null;
    }

    /**
     * Tear the dialog down and settle it. 'answer === undefined' means dismissed.
     * A host dialog MUST be answered or the awaiting command hangs, so the reply
     * is posted here — the single place every close path funnels through.
     */
    function closeDialog(answer) {
      // Read before the teardown takes the boxes with it.
      var options = answer !== undefined && dlgOptionBoxes.length ? checkedDialogOptions() : undefined;
      dlgOptionBoxes = [];
      teardownDialog();
      var hostId = dlgHostId;
      dlgHostId = null;
      if (hostId) {
        var reply = { type: "dialogResult", dialogId: hostId, dialogValue: answer };
        if (options) reply.dialogOptions = options;
        vscode.postMessage(reply);
      }
    }

    /**
     * Open a dialog, claiming (or clearing) the host correlation id.
     *
     * ORDER MATTERS. Any dialog already on screen must be settled under ITS OWN
     * id before we adopt the new one — assigning dlgHostId first and letting the
     * teardown post meant every host dialog answered "cancelled" the instant it
     * appeared, while the answer the user then gave went nowhere.
     */
    function startDialog(hostId, render) {
      closeDialog(undefined);
      dlgHostId = hostId || null;
      render();
    }

    /** Named validators, so a spec can cross postMessage without a function. */
    var DLG_VALIDATORS = {
      refName: function (v) {
        if (/\s/.test(v)) return "Cannot contain spaces.";
        if (/^[-.]|[.]{2}|[~^:?*\[\\]|[.]$|[/]$|@\{/.test(v)) return "Not a valid git ref name.";
        if (v === "@") return "Not a valid git ref name.";
        return null;
      },
      remoteName: function (v) {
        if (/\s/.test(v)) return "Cannot contain spaces.";
        if (!/^[A-Za-z0-9._-]+$/.test(v)) return "Use letters, digits, dot, dash or underscore.";
        return null;
      },
      url: function (v) {
        // Deliberately permissive: git remotes are legitimately https://, ssh://,
        // git@host:path, and plain local paths.
        if (/\s/.test(v)) return "A remote URL cannot contain spaces.";
        return null;
      },
      nonEmpty: function (v) {
        return v.trim() ? null : "Required.";
      },
    };

    /**
     * Turn free text into a name git will accept.
     *
     * Pasting a ticket title is the normal way people name a branch --
     * "SPS-1234 ALA baLa 12/02/21 something" -- and every one of those spaces
     * is a hard rejection. Rather than just refusing, offer the corrected form.
     *
     * A forward slash is KEPT where it separates words, because git allows it
     * and it is the conventional hierarchy separator (feature/x) -- rewriting
     * that would destroy meaning the other replacements do not.
     *
     * But a slash between DIGITS is flattened, because that is a date, not a
     * hierarchy. Keeping it is not merely ugly: a slash makes a directory under
     * refs/heads, so "...-10/11/2345-now" permanently blocks "...-10" and
     * "...-10/11" from ever being branches ("cannot lock ref ... exists").
     * Pasting a ticket title would silently reserve names nobody asked for.
     *
     * Case is kept: it is a preference, not a validity problem, and silently
     * lowercasing someone's ticket id would be a surprise.
     */
    var DLG_SANITIZE = {
      refName: function (v) {
        var s = String(v);
        // Everything git forbids outright, plus control characters.
        s = s.replace(/[\u0000-\u001F\u007F~^:?*\[\\]/g, "-");
        s = s.replace(/@\{/g, "-");
        // Any run of whitespace becomes ONE hyphen.
        s = s.replace(/\s+/g, "-");
        // A slash BETWEEN DIGITS is a date or a fraction, never a ref
        // hierarchy -- see the note above on refs/heads directories.
        s = s.replace(/(\d)\/(\d)/g, "$1-$2");
        // Sequences git rejects, and repeats that read as typos.
        s = s.replace(/\.{2,}/g, ".");
        s = s.replace(/\/{2,}/g, "/");
        s = s.replace(/-{2,}/g, "-");
        // Per path component: may not start with a dot, end with a dot, or
        // end with ".lock". Empty components collapse away.
        var parts = s.split("/");
        var kept = [];
        for (var i = 0; i < parts.length; i++) {
          var part = parts[i]
            .replace(/^[.]+/, "")
            .replace(/[.]+$/, "")
            .replace(/[.]lock$/i, "")
            .replace(/^-+/, "")
            .replace(/-+$/, "");
          if (part) kept.push(part);
        }
        s = kept.join("/");
        if (s === "@") return "";
        return s;
      },
    };

    /** Shell shared by every dialog kind: scrim, panel, Escape, focus return. */
    function beginDialog(spec) {
      teardownDialog();
      dlgReturnFocus = document.activeElement;
      dlgBackdrop = el("div", "rp-backdrop");
      dlgBackdrop.addEventListener("click", function () { closeDialog(undefined); });
      document.body.appendChild(dlgBackdrop);
      // On WINDOW, capture phase. The push modal has its own capture-phase
      // handler that stops Escape, so a listener on our input alone would let
      // Escape close the modal UNDERNEATH us and leave this dialog up. Capture
      // propagates root-first, so a window listener runs BEFORE the modal's
      // document-level one — registering on document instead fires second and is
      // useless. stopImmediatePropagation (not merely stopPropagation) is
      // required: stopPropagation does not suppress listeners on the same target.
      dlgKeyHandler = function (e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          closeDialog(undefined);
        }
      };
      window.addEventListener("keydown", dlgKeyHandler, true);

      dlgEl = el("div", "rp-panel");
      dlgEl.setAttribute("role", "dialog");
      dlgEl.setAttribute("aria-modal", "true");
      dlgEl.setAttribute("aria-label", spec.title);
      var titleEl = el("div", "rp-title");
      titleEl.textContent = spec.title;
      dlgEl.appendChild(titleEl);
      if (spec.hint) {
        var hintEl = el("div", "rp-hint");
        hintEl.textContent = spec.hint;
        dlgEl.appendChild(hintEl);
      }
      return dlgEl;
    }

    /** The Cancel / confirm footer. Returns the confirm button. */
    function dialogFoot(panel, confirmLabel, danger, onConfirm) {
      var foot = el("div", "rp-foot");
      var cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", function () { closeDialog(undefined); });
      var ok = document.createElement("button");
      ok.className = "primary" + (danger ? " danger" : "");
      ok.textContent = confirmLabel || "OK";
      ok.addEventListener("click", onConfirm);
      foot.appendChild(cancel);
      foot.appendChild(ok);
      panel.appendChild(foot);
      document.body.appendChild(panel);
      return ok;
    }

    /**
     * Text entry with completion over 'candidates'.
     *
     * Local callers pass 'onConfirm'; host dialogs leave it off and are answered
     * through closeDialog. 'strict' requires one of the candidates; otherwise any
     * free text is accepted (a sha, 'origin/main~3', a brand-new branch name).
     */
    function openInputDialog(spec, onConfirm) {
      var candidates = spec.candidates || [];
      var sel = -1;
      var shown = [];
      // The candidate a click picked: its name alone may be another ref's
      // too (a branch and a tag), so a local caller is handed the candidate.
      var picked = null;
      var panel = beginDialog(spec);

      var wrap = el("div", "rp-inputwrap");
      var input = spec.multiline
        ? document.createElement("textarea")
        : document.createElement("input");
      if (!spec.multiline) input.type = spec.secret ? "password" : "text";
      input.placeholder = spec.placeholder || "";
      input.value = spec.value || "";
      input.setAttribute("aria-label", spec.title);
      wrap.appendChild(input);
      panel.appendChild(wrap);

      var err = el("div", "rp-err");
      err.style.display = "none";
      panel.appendChild(err);

      // The corrected form of what was typed, offered rather than imposed.
      var sug = el("div", "rp-sug");
      sug.style.display = "none";
      panel.appendChild(sug);

      var list = el("div", "rp-list");
      panel.appendChild(list);

      var ok = dialogFoot(panel, spec.confirmLabel, false, confirm);

      function currentValue() {
        if (sel >= 0 && shown[sel]) return shown[sel].name;
        return spec.multiline ? input.value : input.value.trim();
      }
      /** The candidate the value is, when one was picked (never one typed). */
      function currentPick() {
        if (sel >= 0 && shown[sel]) return shown[sel];
        return picked && picked.name === currentValue() ? picked : null;
      }

      function problem(v) {
        // A named validator from the host, or the function a local caller passed.
        var fn = typeof spec.validate === "function"
          ? spec.validate
          : DLG_VALIDATORS[spec.validate];
        var msg = fn ? fn(v) : null;
        if (msg) return msg;
        if (spec.strict && candidates.length) {
          for (var i = 0; i < candidates.length; i++) {
            if (candidates[i].name === v) return null;
          }
          return "Pick one of the listed entries.";
        }
        return null;
      }

      function showSuggestion(v, msg) {
        sug.textContent = "";
        sug.style.display = "none";
        // Only for ref names, only when what was typed is actually a problem,
        // and only when the fix is itself valid and different.
        if (spec.validate !== "refName" || !v || !msg) return;
        var fix = DLG_SANITIZE.refName(v);
        if (!fix || fix === v || problem(fix)) return;

        sug.appendChild(el("span", "rp-sug-lead", "Use instead"));
        // textContent, never el()'s innerHTML: a ref name may contain < > &.
        var nameEl = el("code", "rp-sug-name");
        nameEl.textContent = fix;
        sug.appendChild(nameEl);

        var useBtn = el("button", "rp-sug-btn");
        useBtn.type = "button";
        useBtn.textContent = "Use";
        useBtn.title = "Replace what you typed with this";
        useBtn.addEventListener("click", function () {
          input.value = fix;
          input.focus();
          if (input.setSelectionRange) input.setSelectionRange(fix.length, fix.length);
          validate();
          renderList();
        });
        sug.appendChild(useBtn);

        var copyBtn = el("button", "rp-sug-btn");
        copyBtn.type = "button";
        copyBtn.textContent = "Copy";
        copyBtn.title = "Copy it to edit somewhere else";
        copyBtn.addEventListener("click", function () {
          var done = function () {
            copyBtn.textContent = "Copied";
            setTimeout(function () { copyBtn.textContent = "Copy"; }, 1200);
          };
          try {
            if (navigator.clipboard && navigator.clipboard.writeText) {
              navigator.clipboard.writeText(fix).then(done, function () {});
              return;
            }
          } catch (e) { /* fall through */ }
          // No clipboard API: select it so the usual copy shortcut works.
          input.value = fix;
          input.focus();
          if (input.select) input.select();
          validate();
        });
        sug.appendChild(copyBtn);

        sug.style.display = "";
      }

      function validate() {
        var v = currentValue();
        var msg = v ? problem(v) : null;
        if (msg) {
          err.textContent = msg;
          err.style.display = "";
        } else {
          err.style.display = "none";
        }
        showSuggestion(v, msg);
        // An empty value is only refusable, never an error message — the field
        // starts empty and shouting at someone before they type is hostile.
        ok.disabled = !v || !!msg;
        return !ok.disabled;
      }

      function renderList() {
        var q = (spec.multiline ? "" : input.value.trim()).toLowerCase();
        shown = (q
          ? candidates.filter(function (c) { return c.name.toLowerCase().indexOf(q) !== -1; })
          : candidates).slice(0, 60);
        if (sel >= shown.length) sel = shown.length - 1;
        list.textContent = "";
        if (!candidates.length) return;
        if (!shown.length) {
          list.appendChild(el("div", "rp-empty",
            spec.strict ? "No matches" : "No match — Enter uses what you typed"));
          return;
        }
        shown.forEach(function (c, i) {
          var row = el("div", "rp-row" + (i === sel ? " sel" : ""));
          row.appendChild(el("span", "codicon codicon-" + (c.icon || "git-branch")));
          // textContent, NOT el()'s innerHTML: git permits < > & " in ref names
          // (it only forbids space ~ ^ : ? * [ \ and control chars), so a branch
          // named like an HTML tag would otherwise be parsed as markup. The
          // webview CSP blocks inline handlers, but that is defence in depth,
          // not a reason to interpolate untrusted text as HTML.
          var nameEl = el("span", "rp-name");
          nameEl.textContent = c.name;
          row.appendChild(nameEl);
          if (c.kind) {
            var kindEl = el("span", "rp-kind");
            kindEl.textContent = c.kind;
            row.appendChild(kindEl);
          }
          row.addEventListener("click", function () {
            input.value = c.name;
            sel = -1;
            picked = c;
            renderList();
            if (validate()) confirm();
          });
          list.appendChild(row);
        });
      }

      function confirm() {
        var v = currentValue();
        if (!v || problem(v)) return;
        var pick = currentPick();
        closeDialog(onConfirm ? undefined : v);
        if (onConfirm) onConfirm(v, pick);
      }

      input.addEventListener("input", function () { sel = -1; picked = null; renderList(); validate(); });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); closeDialog(undefined); return; }
        if (e.key === "Enter") {
          // In a textarea Enter inserts a newline; Ctrl/Cmd+Enter submits.
          if (spec.multiline && !(e.ctrlKey || e.metaKey)) return;
          e.preventDefault();
          // A held Enter from the menu that opened this must not submit it.
          if (!e.repeat) confirm();
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (!shown.length) return;
          e.preventDefault();
          sel = e.key === "ArrowDown"
            ? Math.min(sel + 1, shown.length - 1)
            : Math.max(sel - 1, -1);
          renderList();
          var selEl = list.querySelector(".rp-row.sel");
          if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
          validate();
        }
      });

      renderList();
      validate();
      input.focus();
      // A message to EDIT (selectOnOpen false) keeps its text: the caret goes
      // to the start rather than selecting it all for the first keystroke.
      if (spec.selectOnOpen === false) {
        if (input.setSelectionRange) input.setSelectionRange(0, 0);
        input.scrollTop = 0;
      } else if (input.select) {
        input.select();
      }
    }

    /** Build one choice row (shared by pick and multiPick). */
    function choiceRow(c, selected, multi) {
      var row = el("div", "rp-row rp-choice" + (c.danger ? " danger" : "") +
        (selected ? " sel" : ""));
      if (multi) {
        var box = document.createElement("input");
        box.type = "checkbox";
        box.className = "rp-check";
        box.checked = !!c.picked;
        box.tabIndex = -1;
        row.appendChild(box);
      }
      if (c.icon) {
        row.appendChild(el("span", "codicon codicon-" + c.icon));
      }
      var text = el("div", "rp-choice-text");
      var label = el("div", "rp-choice-label");
      label.textContent = c.label;
      text.appendChild(label);
      if (c.description) {
        var desc = el("div", "rp-choice-desc");
        desc.textContent = c.description;
        text.appendChild(desc);
      }
      row.appendChild(text);
      if (c.detail) {
        var det = el("span", "rp-choice-detail");
        det.textContent = c.detail;
        row.appendChild(det);
      }
      return row;
    }

    /** Choose exactly one option. Clicking a row commits it — no second step. */
    function openPickDialog(spec) {
      var choices = spec.choices || [];
      var useFilter = spec.filter === undefined ? choices.length > 8 : !!spec.filter;
      var sel = 0;
      var shown = choices;
      var panel = beginDialog(spec);
      if (spec.message) {
        var pmsg = el("div", "rp-msg");
        pmsg.textContent = spec.message;
        panel.appendChild(pmsg);
      }

      var input = null;
      if (useFilter) {
        var wrap = el("div", "rp-inputwrap");
        input = document.createElement("input");
        input.type = "text";
        input.placeholder = "Filter";
        input.setAttribute("aria-label", "Filter " + spec.title);
        wrap.appendChild(input);
        panel.appendChild(wrap);
      }

      var list = el("div", "rp-list");
      panel.appendChild(list);
      renderDialogOptions(panel, spec);

      // No confirm button: a pick IS the commit, exactly like the branch menu.
      var foot = el("div", "rp-foot");
      var cancel = document.createElement("button");
      cancel.textContent = "Cancel";
      cancel.addEventListener("click", function () { closeDialog(undefined); });
      foot.appendChild(cancel);
      panel.appendChild(foot);
      document.body.appendChild(panel);

      function render() {
        var q = input ? input.value.trim().toLowerCase() : "";
        shown = q
          ? choices.filter(function (c) {
              return (c.label + " " + (c.description || "")).toLowerCase().indexOf(q) !== -1;
            })
          : choices;
        if (sel >= shown.length) sel = shown.length - 1;
        if (sel < 0) sel = 0;
        list.textContent = "";
        if (!shown.length) {
          list.appendChild(el("div", "rp-empty", "No matches"));
          return;
        }
        shown.forEach(function (c, i) {
          var row = choiceRow(c, i === sel, false);
          row.addEventListener("click", function () { closeDialog(c.id); });
          list.appendChild(row);
        });
      }

      function onKey(e) {
        if (e.key === "Escape") { e.preventDefault(); closeDialog(undefined); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          // A held Enter from the menu that opened this must not pick for you.
          if (!e.repeat && shown[sel]) closeDialog(shown[sel].id);
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (!shown.length) return;
          e.preventDefault();
          sel = e.key === "ArrowDown"
            ? Math.min(sel + 1, shown.length - 1)
            : Math.max(sel - 1, 0);
          render();
          var selEl = list.querySelector(".rp-row.sel");
          if (selEl && selEl.scrollIntoView) selEl.scrollIntoView({ block: "nearest" });
        }
      }

      if (input) {
        input.addEventListener("input", function () { sel = 0; render(); });
        input.addEventListener("keydown", onKey);
      } else {
        panel.tabIndex = -1;
        panel.addEventListener("keydown", onKey);
      }

      render();
      if (input) input.focus(); else panel.focus();
    }

    /** Choose any number of options — the answer is a (possibly empty) id list. */
    function openMultiPickDialog(spec) {
      var choices = (spec.choices || []).map(function (c) {
        return {
          id: c.id, label: c.label, icon: c.icon, detail: c.detail,
          description: c.description, danger: c.danger, picked: !!c.picked,
        };
      });
      var sel = 0;
      var panel = beginDialog(spec);
      var list = el("div", "rp-list");
      panel.appendChild(list);

      dialogFoot(panel, spec.confirmLabel, false, function () {
        closeDialog(choices.filter(function (c) { return c.picked; })
          .map(function (c) { return c.id; }));
      });

      function toggle(i) {
        choices[i].picked = !choices[i].picked;
        sel = i;
        render();
      }

      function render() {
        list.textContent = "";
        choices.forEach(function (c, i) {
          var row = choiceRow(c, i === sel, true);
          row.addEventListener("click", function () { toggle(i); });
          list.appendChild(row);
        });
      }

      panel.tabIndex = -1;
      panel.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); closeDialog(undefined); return; }
        if (e.key === " ") { e.preventDefault(); toggle(sel); return; }
        if (e.key === "Enter") {
          e.preventDefault();
          if (e.repeat) return; // a held key is not an answer
          closeDialog(choices.filter(function (c) { return c.picked; })
            .map(function (c) { return c.id; }));
          return;
        }
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          if (!choices.length) return;
          e.preventDefault();
          sel = e.key === "ArrowDown"
            ? Math.min(sel + 1, choices.length - 1)
            : Math.max(sel - 1, 0);
          render();
        }
      });

      render();
      panel.focus();
    }

    /** Yes/no. Dismissing is "no", so a destructive default can never fire. */
    function openConfirmDialog(spec) {
      var panel = beginDialog(spec);
      var msg = el("div", "rp-msg");
      msg.textContent = spec.message;
      panel.appendChild(msg);
      renderDialogOptions(panel, spec);
      var ok = dialogFoot(panel, spec.confirmLabel, spec.danger, function () {
        closeDialog("ok");
      });
      panel.tabIndex = -1;
      panel.addEventListener("keydown", function (e) {
        if (e.key === "Escape") { e.preventDefault(); closeDialog(undefined); return; }
        // Not a held key: the Enter that picked "Reset…" or "Delete" in the
        // branch menu can still be repeating when this question opens.
        if (e.key === "Enter") { e.preventDefault(); if (!e.repeat) closeDialog("ok"); }
      });
      // A destructive action never starts focused — Enter out of muscle memory
      // should not delete a branch. Cancel takes focus instead.
      if (spec.danger) panel.focus(); else ok.focus();
    }

    /** Open whichever dialog a host-requested spec describes. */
    function openDialog(spec, hostId) {
      startDialog(hostId, function () {
        if (spec.kind === "pick") return openPickDialog(spec);
        if (spec.kind === "multiPick") return openMultiPickDialog(spec);
        if (spec.kind === "confirm") return openConfirmDialog(spec);
        return openInputDialog(spec, null);
      });
    }

    /**
     * This webview's own callers (the branch menu, the push modal), which pass
     * an onConfirm callback and a validate FUNCTION rather than a validator
     * name. No host is waiting, so the correlation id is cleared.
     */
    function openRefPrompt(opts) {
      startDialog(null, function () {
        openInputDialog(opts, opts.onConfirm);
      });
    }

    /** Every ref this webview already knows, as completion candidates. */
    function allRefCandidates() {
      var out = [];
      (branchData.local || []).forEach(function (b) {
        out.push({ name: b.name, kind: "branch", icon: "git-branch" });
      });
      (branchData.remote || []).forEach(function (n) {
        out.push({ name: n, kind: "remote", icon: "cloud" });
      });
      (branchData.tags || []).forEach(function (n) {
        out.push({ name: n, kind: "tag", icon: "tag" });
      });
      return out;
    }

    function openBranchMenu() {
      if (branchMenu) { closeBranchMenu(); return; }
      branchFilter = "";
      branchQuery = "";
      pageLimits = Object.create(null);
      bmUserMoved = false;
      // A scrim dims the view behind the dialog stack, so it's unmistakable
      // that you're IN a dialog (clicking it closes, like any modal).
      branchBackdrop = el("div", "bm-backdrop");
      document.body.appendChild(branchBackdrop);
      branchMenu = el("div", "branch-menu");
      bmActiveKey = "";
      bmSubActive = -1;
      const search = el("div", "bm-search");
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Search for branches and actions";
      input.setAttribute("aria-label", "Search branches and actions");
      input.setAttribute("role", "combobox");
      input.setAttribute("aria-expanded", "true");
      input.setAttribute("aria-autocomplete", "list");
      input.setAttribute("aria-controls", "bm-list");
      input.addEventListener("input", () => {
        // Typing leaves an open submenu (a drilled-in one too) for the
        // list, for good: a host repaint must not open it again.
        subMenuFor = null;
        branchQuery = input.value.trim();
        branchFilter = branchQuery.toLowerCase();
        pageLimits = Object.create(null); // a new query starts from the first page again
        bmUserMoved = false;
        renderBranchMenu();
        // A new query starts at the top, its first group header in view —
        // not wherever the last one had been scrolled to.
        const l = bmList();
        if (l) l.scrollTop = 0;
        // Typing puts the highlight on the best match (none for an empty
        // box), so Enter runs what the search found — a branch before an
        // action it ties with.
        bmActiveKey = branchFilter && bmBest ? bmBest.key : "";
        paintBm(true);
      });
      input.addEventListener("keydown", onBmInputKey);
      search.appendChild(input);
      branchMenu.appendChild(search);
      const list = el("div", "bm-list");
      list.id = "bm-list";
      list.setAttribute("role", "listbox");
      list.setAttribute("aria-label", "Branches and actions");
      // The highlight follows the pointer, but not while a submenu is open —
      // the way to it can cross other rows — and not when the list scrolls
      // under a pointer that has not moved.
      list.addEventListener("mousemove", (e) => {
        if (!bmPointerMoved(e) || branchSubmenu) return;
        const row = e.target.closest ? e.target.closest("[data-bmkey]") : null;
        if (!row || row.dataset.bmkey === bmActiveKey) return;
        bmActiveKey = row.dataset.bmkey;
        bmUserMoved = true;
        paintBm(false);
      });
      // Rows scrolled into sight get their long names cut around the match.
      list.addEventListener("scroll", () => fitBranchNames(), { passive: true });
      branchMenu.appendChild(list);
      // A press anywhere in the menu but the box itself — a row, a group
      // header, the padding, the 'No matches' line — never takes focus from
      // the box, so the keys keep working after a click and Tab stays here.
      branchMenu.addEventListener("mousedown", (e) => {
        if (e.target === input) return;
        e.preventDefault();
        if (document.activeElement !== input) input.focus();
      });
      document.body.appendChild(branchMenu);
      bmHeldWidth = 0;
      renderBranchMenu(); // its width held and placed there (holdBranchMenuWidth, placeBranchMenu)
      branchPill.setAttribute("aria-expanded", "true");
      input.focus();
      window.addEventListener("resize", onBranchResize);
      setTimeout(() => {
        document.addEventListener("mousedown", onBranchDocDown, true);
        document.addEventListener("keydown", onBranchKey, true);
        window.addEventListener("blur", onBranchBlur, true);
      }, 0);
    }
    /** Under the pill, inside the view: moved in from the right edge when the
     *  view is too narrow for it there, and as tall as the room below the
     *  pill allows — a short panel's rows get all of it, not a fixed share. */
    function placeBranchMenu() {
      if (!branchMenu) return;
      const PAD = 6;
      const r = branchPill.getBoundingClientRect();
      const top = Math.round(r.bottom + 4);
      branchMenu.style.top = top + "px";
      branchMenu.style.maxHeight = Math.max(0, window.innerHeight - top - 8) + "px";
      branchMenu.style.left = Math.round(r.left) + "px";
      const mr = branchMenu.getBoundingClientRect();
      if (mr.right > window.innerWidth - PAD) {
        branchMenu.style.left = Math.max(PAD, window.innerWidth - mr.width - PAD) + "px";
      }
    }
    // The sidebar was resized with the menu open: it and its submenu are
    // placed again, inside the view's new edges.
    function onBranchResize() {
      if (!branchMenu) return;
      // Drilled in, the list is hidden and cannot be measured: it comes back
      // first, and the actions are placed again below — beside the menu if
      // the view is wide enough for that now.
      const sub = subMenuFor, subKey = bmSubActiveKey(); // the same item stays highlighted
      if (branchSubmenu) closeBranchSubmenu();
      subMenuFor = sub;
      // Measured on whole rows: the counts a narrower view hid come back first.
      branchMenu.querySelectorAll(".bm-branch.is-cramped").forEach((r) => r.classList.remove("is-cramped"));
      // The width the whole list needs in the new view — never what a query
      // shows: an offer quoting a long query would measure the menu at its
      // widest, and hold it there after the box was cleared.
      if (branchFilter) holdWholeListWidth();
      else holdBranchMenuWidth();
      placeBranchMenu();
      // Every row, measured again at the new width.
      refreshOpenBranchUi(subKey);
    }
    branchPill.addEventListener("click", openBranchMenu);
    // Switch Repository: the host builds the list (it holds every repository's
    // branch and changes) and asks through the same pick dialog the palette
    // command uses, rendered right here.
    repoPill.addEventListener("click", () => {
      if (branchMenu) closeBranchMenu();
      vscode.postMessage({ type: "switchRepo" });
    });

    // ---- Push review modal (confirm before every push) -------------------
    // Every push route (the ↑ pill, the branch-menu Push, Commit & Push) opens
    // this modal first: it lists the exact commits + file changes about to leave
    // the machine, with a confirmational Push and an "undo local commits" escape
    // hatch that returns the committed work to staged / unstaged changes.
    let pushModal = null, pushBackdrop = null, pushBusy = false;
    // Whether the modal's primary button pushes with --force-with-lease. Set
    // when the branch is known to have diverged, and again if git rejects a
    // plain push as non-fast-forward (see pushModalError).
    let pushForce = false;
    function closePushModal() {
      if (pushBackdrop) { pushBackdrop.remove(); pushBackdrop = null; }
      if (pushModal) { pushModal.remove(); pushModal = null; }
      pushBusy = false;
      document.removeEventListener("keydown", onPushKey, true);
    }
    function onPushKey(e) {
      if (e.key === "Escape" && !pushBusy) { e.preventDefault(); e.stopPropagation(); closePushModal(); }
      // A modal keeps Tab inside it: its file rows, its buttons, round again
      // — never the list behind the backdrop.
      if (e.key === "Tab" && pushModal) {
        const stops = Array.prototype.filter.call(
          pushModal.querySelectorAll("button"),
          function (b) { return !b.disabled && b.offsetParent !== null; });
        if (!stops.length) return;
        const first = stops[0], last = stops[stops.length - 1];
        const inside = pushModal.contains(document.activeElement);
        if (e.shiftKey && (!inside || document.activeElement === first)) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && (!inside || document.activeElement === last)) { e.preventDefault(); first.focus(); }
      }
    }
    function openPushModal(data) {
      closePushModal();
      closeBranchMenu();
      pushBackdrop = el("div", "push-backdrop");
      // Close only when the backdrop ITSELF is clicked — not a click that bubbled
      // up from the modal (which now lives inside the backdrop for flex centering).
      pushBackdrop.addEventListener("click", (e) => { if (e.target === pushBackdrop && !pushBusy) closePushModal(); });
      document.body.appendChild(pushBackdrop);

      const modal = el("div", "push-modal");
      modal.setAttribute("role", "dialog");
      modal.setAttribute("aria-modal", "true");
      modal.setAttribute("aria-label", "Confirm push");

      const head = el("div", "pm-head");
      head.appendChild(el("i", "codicon codicon-arrow-up"));
      const title = el("div", "pm-title");
      title.innerHTML = "Push to <b></b>";
      title.querySelector("b").textContent = data.target;
      head.appendChild(title);
      const close = el("button", "pm-close", '<i class="codicon codicon-close" aria-hidden="true"></i>');
      close.setAttribute("aria-label", "Close");
      close.addEventListener("click", () => { if (!pushBusy) closePushModal(); });
      head.appendChild(close);
      modal.appendChild(head);
      // Reviewing another worktree's push (from the Worktrees view): say whose.
      if (data.worktree) {
        const where = el("div", "pm-where", '<i class="codicon codicon-worktree" aria-hidden="true"></i>');
        const whereText = el("span");
        whereText.textContent = "From the worktree " + data.worktree.name + " — " + data.worktree.shownPath;
        where.appendChild(whereText);
        modal.appendChild(where);
        modal.setAttribute("aria-label", "Confirm push from the worktree " + data.worktree.name);
      }

      const stats = el("div", "pm-stats");
      const nC = data.commits.length, nF = data.files.length;
      const cStat = el("span", "pm-stat"); cStat.innerHTML = "<b></b> ";
      cStat.querySelector("b").textContent = String(nC);
      cStat.appendChild(document.createTextNode(nC === 1 ? "commit" : "commits"));
      stats.appendChild(cStat);
      const fStat = el("span", "pm-stat"); fStat.innerHTML = "<b></b> ";
      fStat.querySelector("b").textContent = String(nF);
      fStat.appendChild(document.createTextNode(nF === 1 ? "file changed" : "files changed"));
      stats.appendChild(fStat);
      if (data.additions) stats.appendChild(el("span", "pm-add", "+" + data.additions));
      if (data.deletions) stats.appendChild(el("span", "pm-del", "−" + data.deletions));
      if (data.behind > 0) {
        // "pull first" is the right remedy only when the remote genuinely moved
        // ahead of us. When WE rewrote our own tip (amending a pushed commit is
        // the everyday case) pulling is actively destructive: with pull.rebase
        // it drops the amended commit as "previously applied" and silently
        // reverts the message, and without it you get a merge that puts the old
        // commit back beside the new one. Say what actually happened instead.
        const b = el("span", data.needsForce ? "pm-rewrite" : "pm-behind",
          '<i class="codicon codicon-' + (data.needsForce ? "warning" : "arrow-down") + '"></i>');
        b.appendChild(document.createTextNode(data.needsForce
          ? "Rewrites the remote branch"
          : data.behind + " behind — pull first"));
        stats.appendChild(b);
      }
      modal.appendChild(stats);

      const body = el("div", "pm-body cr-list");
      // The rows the Worktrees view draws too (webview-ui/changeRows, loaded
      // as change-rows.js): each commit opens to what IT changed; the files
      // below are what all of them change together. Clicking a file opens its
      // diff in the editor; the modal stays.
      const R = window.GsChangeRows;
      body.appendChild(R ? R.sectionLabel("Commits to push") : el("div", "cr-section-label", "Commits to push"));
      data.commits.forEach((c) => {
        if (!R) { body.appendChild(el("div", "cr-commit", esc(c.sha.slice(0, 7) + "  " + c.subject))); return; }
        body.appendChild(R.commitRow(c, {
          loadFiles: (commit) => vscode.postMessage({ type: "pushCommitFiles", sha: commit.sha }),
          onOpenFile: (commit, f) => vscode.postMessage({
            type: "openPushCommitFile", sha: commit.sha, parent: (commit.parents || [])[0],
            path: f.path, oldPath: f.oldPath, status: f.status,
          }),
        }));
      });
      body.appendChild(R ? R.sectionLabel("Files changed") : el("div", "cr-section-label", "Files changed"));
      if (!data.files.length) {
        body.appendChild(R ? R.emptyNote("No file changes in these commits.") : el("div", "cr-empty", "No file changes in these commits."));
      } else {
        data.files.forEach((f) => {
          if (!R) { body.appendChild(el("div", "cr-file", esc(f.path))); return; }
          body.appendChild(R.fileRow(f, {
            onOpen: (file) => vscode.postMessage({ type: "openPushFileDiff", path: file.path, oldPath: file.oldPath }),
          }));
        });
      }
      if (!data.canPush && data.reason) {
        const err = el("div", "pm-error"); err.textContent = data.reason; body.appendChild(err);
      }
      modal.appendChild(body);

      const foot = el("div", "pm-foot");
      const alt = el("div", "pm-foot-alt");
      const undo = el("button", "pm-btn danger", '<i class="codicon codicon-discard"></i>');
      undo.appendChild(document.createTextNode("Undo commits…"));
      undo.title = "Undo these local commits — reset them back to staged / unstaged changes";
      undo.addEventListener("click", () => { if (!pushBusy) vscode.postMessage({ type: "discardLocalCommits" }); });
      alt.appendChild(undo);
      // Branch off instead of pushing here — create a new branch at these commits.
      const newBranch = el("button", "pm-btn ghost", '<i class="codicon codicon-git-branch"></i>');
      newBranch.appendChild(document.createTextNode("New branch…"));
      newBranch.title = "Create a new branch from these commits (and switch to it)";
      newBranch.addEventListener("click", () => {
        if (pushBusy) return;
        openRefPrompt({
          title: "New Branch from These Commits",
          hint: "Creates the branch at the current commit and switches to it.",
          placeholder: "feature/my-change",
          confirmLabel: "Create Branch",
          candidates: [],
          allowFreeText: true,
          validate: "refName",
          onConfirm: function (v) {
            vscode.postMessage({ type: "newBranchFromPush", ref: v });
          },
        });
      });
      alt.appendChild(newBranch);
      foot.appendChild(alt);
      const cancel = el("button", "pm-btn secondary", "Cancel");
      cancel.addEventListener("click", () => { if (!pushBusy) closePushModal(); });
      foot.appendChild(cancel);
      // A plain push CANNOT succeed once the branch diverged in both
      // directions — git refuses the non-fast-forward. Offering it anyway is
      // what made amending look broken: the button was enabled, focused, and
      // doomed. In that state the button becomes the force, and says so.
      const pushB = el("button", "pm-btn primary" + (data.needsForce ? " danger" : ""),
        '<i class="codicon codicon-' + (data.needsForce ? "repo-force-push" : "arrow-up") + '"></i>');
      pushB.appendChild(document.createTextNode(data.needsForce ? "Force push" : "Push"));
      pushForce = !!data.needsForce;
      if (data.needsForce) {
        pushB.title =
          "You rewrote a commit the remote already has, so a normal push is refused. "
          + "This replaces only the versions you rewrote — nobody else's commits are on the remote branch.";
      }
      if (!data.canPush) { pushB.disabled = true; pushB.title = data.reason || "Cannot push"; }
      pushB.addEventListener("click", () => {
        if (pushBusy || !data.canPush) return;
        pushBusy = true;
        pushB.disabled = true; cancel.disabled = true; undo.disabled = true; newBranch.disabled = true;
        // Keep the "Push" label (no width jump) — just spin the arrow into a
        // loader, exactly like the header pull/push pills.
        pushB.classList.add("loading");
        const i = pushB.querySelector(".codicon");
        if (i) i.className = "codicon codicon-loading codicon-modifier-spin";
        vscode.postMessage({ type: "confirmPush", force: pushForce });
      });
      foot.appendChild(pushB);
      modal.appendChild(foot);

      pushBackdrop.appendChild(modal); // inside the backdrop → flex-centered at any width
      pushModal = modal;
      pushBusy = false;
      document.addEventListener("keydown", onPushKey, true);
      // A destructive action never starts focused: Enter must not force-push.
      if (data.canPush && !data.needsForce) pushB.focus(); else cancel.focus();
    }
    function pushModalError(text) {
      if (!pushModal) return;
      pushBusy = false;
      let err = pushModal.querySelector(".pm-error");
      if (!err) { err = el("div", "pm-error"); pushModal.querySelector(".pm-body").appendChild(err); }
      err.textContent = text || "Operation failed.";
      pushModal.querySelectorAll(".pm-btn").forEach((b) => { b.disabled = false; });
      const pushB = pushModal.querySelector(".pm-btn.primary");
      // A rejection git blames on fast-forward means the same push will be
      // refused every time. Re-enabling the identical button invites the user
      // to press it again forever; promote it to the force instead, which is
      // the only thing that CAN work from here.
      const rejected = /non-fast-forward|fetch first|behind its remote/i.test(text || "");
      if (pushB && rejected && !pushB.classList.contains("danger")) {
        pushB.classList.add("danger");
        pushB.textContent = "";
        const ic = el("i", "codicon codicon-repo-force-push");
        pushB.appendChild(ic);
        pushB.appendChild(document.createTextNode("Force push"));
        pushB.title =
          "The remote refused a normal push. This uses --force-with-lease, "
          + "which still refuses if someone else pushed.";
        pushForce = true;
      }
      if (pushB) {
        pushB.classList.remove("loading");
        const i = pushB.querySelector(".codicon");
        if (i && !rejected) i.className = "codicon codicon-arrow-up";
      }
      err.scrollIntoView({ block: "nearest" });
    }

    // ---- No-repository onboarding actions --------------------------------
    $("open-folder").addEventListener("click", () => vscode.postMessage({ type: "openFolder" }));
    $("open-graph").addEventListener("click", () => vscode.postMessage({ type: "openGraph" }));

    // ---- Tree building (client-side from repo-relative paths) -----------
    // Build a nested folder tree, compacting single-child folder chains the way
    // VS Code's SCM does (a/b/c with one child each => "a/b/c").
    function buildTree(entries) {
      const root = { name: "", path: "", dirs: new Map(), files: [] };
      for (const e of entries) {
        const parts = e.path.split("/");
        const fileName = parts.pop();
        let node = root;
        let acc = "";
        for (const part of parts) {
          acc = acc ? acc + "/" + part : part;
          let child = node.dirs.get(part);
          if (!child) {
            child = { name: part, path: acc, dirs: new Map(), files: [] };
            node.dirs.set(part, child);
          }
          node = child;
        }
        node.files.push({ name: fileName, entry: e });
      }
      compact(root);
      return root;
    }
    // Merge a folder that has exactly one sub-folder and no files into it.
    function compact(node) {
      for (const [, child] of node.dirs) compact(child);
      const dirs = [...node.dirs.values()];
      if (node.path && node.files.length === 0 && dirs.length === 1) {
        const only = dirs[0];
        node.name = node.name + "/" + only.name;
        node.path = only.path;
        node.dirs = only.dirs;
        node.files = only.files;
      }
    }

    let folderKeyAccumulator = [];
    function collectFolderKeys() { return folderKeyAccumulator; }

    // ---- Rendering -------------------------------------------------------
    const GROUP_DEFS = [
      { kind: "merge", label: "Merge Conflicts", staged: false },
      { kind: "staged", label: "Staged", staged: true },
      { kind: "unstaged", label: "Unstaged", staged: false },
    ];

    // Signature of everything the file-list render depends on (layout + each
    // group's paths/statuses). Used to skip a rebuild when nothing changed.
    let lastRenderSig = null;
    function stateSig() {
      // The staging model belongs in the signature: it changes how these exact
      // files are ARRANGED, and without it a model switch made in Settings —
      // where the file list is identical — is skipped as "nothing changed" and
      // the view keeps showing the other model. And whether anything has been
      // read yet: a first state with no files must still paint "Working tree
      // clean" over the reading state's empty list.
      let s = (stateSeen ? "read" : "unread") + "|" + layout + "|" + stagingModel;
      for (const k of ["merge", "staged", "unstaged"]) {
        const list = lastState[k] || [];
        s += "|" + k + ":";
        for (const e of list) s += e.path + e.status + ",";
      }
      return s;
    }
    // The firehose pushes state on EVERY git poke (fetches, unrelated ref
    // writes, background status polls). Rebuilding the whole list each time is
    // wasted work AND it resets the native tooltip's hover timer, so hovering a
    // button never shows its title. Only re-render when the state truly changed;
    // user interactions (collapse, layout) still call render() directly.
    function renderIfChanged() {
      if (stateSig() === lastRenderSig) return;
      render();
    }

    /**
     * render() with the selection reconciled afterwards.
     *
     * A file that was selected and has since been staged, committed or reverted
     * is simply gone from the list, and a selection still counting it would
     * offer to stash files that are not there. Everything render() can reach is
     * in rowOrder, so anything outside it no longer exists.
     */
    function render() {
      // Where the keyboard is, so a row that leaves the list (staged,
      // discarded) hands focus to the next row still there — or, with none
      // after it, the one before — instead of dropping it on the page.
      const was = focusPlace(groupsEl);
      renderRows();
      if (tipTarget && !tipTarget.isConnected) hideTip();
      let dropped = false;
      selectedRows.forEach((k) => {
        if (selScope(k) === "tree" && rowOrder.indexOf(k) === -1) { selectedRows.delete(k); dropped = true; }
      });
      if (dropped) paintSelection();
      if (dropped && selectionAnchor && orderOf(selectionAnchor).indexOf(selectionAnchor) === -1) {
        selectionAnchor = null;
      }
      applyRoving();
      handFocusOn(was, groupsEl);
      updateSelectionBar();
      if (drag) paintDrop();
    }

    /**
     * Where the keyboard is among container's treeitems, and every item
     * showing on each side of it — the whole run, not only the neighbours:
     * a folder, a group or a stash takes its rows with it. The run spans the
     * whole tree (the working tree's rows and the Stashes group's), so a box
     * left empty can hand the keyboard across; index counts container's own
     * rows. Null when the keyboard is elsewhere.
     */
    function focusPlace(container) {
      const ae = document.activeElement;
      const focused = ae && container.contains(ae) ? itemOf(ae) : null;
      if (!focused) return null;
      const items = treeItems();
      const i = items.indexOf(focused);
      const keyOf = (n) => n.dataset.tkey;
      let own = -1;
      for (let j = 0; i >= 0 && j <= i; j++) if (container.contains(items[j])) own++;
      return {
        tkey: focused.dataset.tkey,
        after: i < 0 ? [] : items.slice(i + 1).map(keyOf),
        before: i < 0 ? [] : items.slice(0, i).reverse().map(keyOf),
        index: own,
      };
    }
    /**
     * After a repaint of container: when the item that had the keyboard is
     * gone (or can no longer be seen), the same item's new row takes it — or
     * the next one still showing, else the one before — in container first.
     * The working tree's last file leaving goes up to the file above it, not
     * down to the Stashes header (the next treeitem, but another box). Only
     * with nothing left showing in container does the other box take it (the
     * last stash leaving hands it up to the working tree's last row); with no
     * item left in the whole tree, fallback() names the place (never the
     * page itself).
     */
    function handFocusOn(was, container, fallback) {
      if (!was) return;
      // Only to a row that can be seen: the header of a group this render
      // emptied is still in the DOM (and may still hold the focus for a
      // frame), and a focus() on it lands nowhere.
      const now = document.activeElement;
      const lost = !container.contains(now) || (!!itemOf(now) && !shownItem(itemOf(now)));
      if (!lost) return;
      // One pass over the rows (a Stage All can take thousands at once).
      const items = treeItems();
      const here = new Map();
      const elsewhere = new Map();
      const mine = [];
      for (let j = 0; j < items.length; j++) {
        const it = items[j];
        if (container.contains(it)) { here.set(it.dataset.tkey, it); mine.push(it); }
        else elsewhere.set(it.dataset.tkey, it);
      }
      const nearest = (shown) => {
        let to = shown.get(was.tkey) || null;
        for (let j = 0; !to && j < was.after.length; j++) to = shown.get(was.after[j]) || null;
        for (let j = 0; !to && j < was.before.length; j++) to = shown.get(was.before[j]) || null;
        return to;
      };
      let to = nearest(here);
      if (!to && mine.length) to = mine[Math.min(Math.max(was.index, 0), mine.length - 1)];
      if (!to) to = nearest(elsewhere);
      if (to) { focusItem(to); return; }
      const other = fallback ? fallback() : null;
      if (other) other.focus({ preventScroll: true });
    }

    function renderRows() {
      lastRenderSig = stateSig();
      folderKeyAccumulator = [];
      rowOrder = [];
      nextRowCache = new Map();
      const data = {
        merge: lastState.merge,
        staged: lastState.staged,
        unstaged: lastState.unstaged,
      };
      const total =
        data.merge.length + data.staged.length + data.unstaged.length;
      emptyEl.classList.toggle("visible", stateSeen && total === 0);
      // Nothing for them to take: Stage All has no unstaged file, Stash no
      // change at all. They looked (and posted) the same on a clean tree.
      // Conflicted files do not count for Stage All: it is the Changes
      // group's (VS Code's "Stage All Changes"), and the host never marks a
      // conflict resolved for it — the Merge Changes header's Stage All does,
      // past the marker check. Lit over conflicted files alone, a click
      // staged nothing and said nothing.
      stageAllTopBtn.disabled = data.unstaged.length === 0;
      stashChangesBtn.disabled = total === 0;
      // "Changed Files" counts files: a partly staged file is one file, in
      // both groups. It said 4 over a checkbox list of 3.
      const files = new Set();
      for (const k of ["merge", "staged", "unstaged"]) {
        for (const e of data[k]) files.add(e.path);
      }
      changesTotal.textContent = String(files.size);
      changesTotal.classList.toggle("visible", files.size > 0);
      changesTotal.setAttribute("aria-label", countWords(files.size, "changed file", "changed files"));

      const groups = [];
      if (stagingModel === "checkboxes") {
        groups.push(renderChecklist(data));
      } else {
        for (const def of GROUP_DEFS) {
          const list = data[def.kind];
          if (def.kind === "merge" && list.length === 0) continue;
          groups.push(renderGroup(def, list));
        }
      }
      patchChildren(groupsEl, groups);
      // What this render did not ask for is gone: its rows are not kept.
      rowCache = nextRowCache;
    }

    // ── Checkbox model (gitstudio.changes.stagingModel = "checkboxes") ─────────
    //
    // One list, a tick per file, JetBrains-style — no staged/unstaged split to
    // think about (issue #16).
    //
    // The tick IS the index. Ticking stages the file, unticking runs the unstage
    // that already exists, and the checked state is read straight back from
    // whether git reports the file as staged. That is the whole trick: no shadow
    // selection to drift out of sync with the repository, nothing new to persist,
    // and every other surface (the badge, the commit count, an external git add
    // in a terminal) keeps agreeing with what you see.
    function renderChecklist(data) {
      // ONE ROW PER FILE, merged by path.
      //
      // A partly staged file is in BOTH data.staged and data.unstaged — that is
      // how git describes it — so concatenating the two lists gave it two rows,
      // identical and side by side. That is wrong twice: this model exists to be
      // one list with one tick per file, and two rows for one file cannot both
      // be right about its state.
      //
      // Merged, the two memberships become the tick's three states: in staged
      // only is checked, in unstaged only is empty, and in both is the
      // indeterminate mark — "some of this file is staged", which is exactly
      // what git is saying.
      const byPath = new Map();
      const note = function (e, kind, isStaged) {
        const prev = byPath.get(e.path);
        if (!prev) {
          byPath.set(e.path, {
            entry: e,
            kind: kind,
            inStaged: isStaged,
            inUnstaged: !isStaged,
          });
          return;
        }
        prev.inStaged = prev.inStaged || isStaged;
        prev.inUnstaged = prev.inUnstaged || !isStaged;
        // A conflicted file outranks either list: it is not a staging question.
        if (kind === "merge") prev.kind = "merge";
        // Prefer the entry carrying a real status letter over a placeholder.
        if (!prev.entry.status && e.status) prev.entry = e;
      };
      data.merge.forEach(function (e) { note(e, "merge", false); });
      data.staged.forEach(function (e) { note(e, "staged", true); });
      data.unstaged.forEach(function (e) { note(e, "unstaged", false); });

      const all = [];
      byPath.forEach(function (v) {
        const state = v.kind === "merge"
          ? "unstaged"
          : v.inStaged && v.inUnstaged
            ? "partial"
            : v.inStaged ? "staged" : "unstaged";
        all.push({
          entry: v.entry,
          kind: v.kind,
          state: state,
          // Kept for the row's own def and actions: a partly staged file still
          // has work to stage, so it behaves as unstaged for those.
          staged: state === "staged",
        });
      });
      all.sort(function (a, b) { return a.entry.path.localeCompare(b.entry.path); });

      // The group and its header are built once and kept: what changes from
      // render to render (the master tick, the count, the rows it acts on)
      // is painted onto them below, and read by its handlers from __live.
      const group = keep("grp|ck", "", buildChecklistShell);
      const header = group.firstChild;
      const checkedCount = all.filter(function (f) { return f.staged; }).length;
      header.__live = { all: all, checkedCount: checkedCount };
      const wantClass = "group group--all" + (all.length === 0 ? " empty" : "");
      if (group.className !== wantClass) group.className = wantClass;
      const master = header.querySelector(".ck-master");
      master.checked = checkedCount > 0 && checkedCount === all.length;
      // A partly staged file is some of the changes included, too: the header
      // said "none" over a staged part.
      master.indeterminate = !master.checked &&
        all.some(function (f) { return f.state !== "unstaged"; });
      const masterTip = master.checked ? "Uncheck all" : "Check all";
      if (master.dataset.tip !== masterTip) master.dataset.tip = masterTip;
      setAttr(header, "aria-checked", master.indeterminate ? "mixed" : master.checked ? "true" : "false");
      setAttr(header, "aria-label", "Changes, " + countWords(all.length));
      header.querySelector(".gcount").textContent = String(all.length);

      const stagedByPath = new Map();
      const kindByPath = new Map();
      const stateByPath = new Map();
      for (const f of all) {
        stagedByPath.set(f.entry.path, f.staged);
        kindByPath.set(f.entry.path, f.kind);
        stateByPath.set(f.entry.path, f.state);
      }
      const defForEntry = function (entry) {
        const kind = kindByPath.get(entry.path);
        return kind === "merge"
          ? GROUP_DEFS[0]
          : stagedByPath.get(entry.path) ? GROUP_DEFS[1] : GROUP_DEFS[2];
      };

      /**
       * The tick (and the changes twisty) for one file row. sig is part of
       * the row's signature — the tick's handler is built from the state —
       * and decorate prepends them to a row being built.
       */
      const tickFor = function (entry) {
        const state = stateByPath.get(entry.path) || "unstaged";
        const kind = kindByPath.get(entry.path);
        // Any file with changes can be opened up to tick them individually.
        //
        // This used to exclude fully staged files, on the reasoning that they
        // had "nothing left to pick from" — true when the list held only
        // UNSTAGED changes, and false now that a listed change can be unticked.
        // The effect was that staging the last change removed the twisty and the
        // open list in one go, so the whole panel evaporated at exactly the
        // moment the user finished with it.
        const expandable = kind !== "merge";
        return {
          sig: state + "/" + kind,
          expandable: expandable,
          decorate: function (row) { decorateTick(row, entry.path, state, expandable); },
        };
      };

      // Both layouts, so the tree/list toggle keeps working in this model. It
      // used to build a flat list unconditionally, which left that toggle
      // visible and inert whenever the checkbox model was on.
      const nodes = [];
      if (layout === "tree") {
        renderTreeInto(nodes, GROUP_DEFS[2], all.map(function (f) { return f.entry; }), {
          defFor: defForEntry,
          tick: tickFor,
        });
      } else {
        for (const f of all) {
          renderFileRow(nodes, defForEntry(f.entry), f.entry, 1, tickFor(f.entry));
        }
      }
      patchChildren(group.lastChild, nodes);
      return group;
    }

    /** The checkbox model's group and header, built once (see renderChecklist). */
    function buildChecklistShell() {
      const group = el("div", "group group--all");
      group.setAttribute("role", "none");
      const header = el("div", "group-header");
      header.tabIndex = -1;
      header.setAttribute("role", "treeitem");
      header.setAttribute("aria-level", "1");
      // It holds every file and never closes.
      header.setAttribute("aria-expanded", "true");
      header.dataset.tkey = "g:all";
      const master = el("input", "ck ck-master");
      master.type = "checkbox";
      // The header itself is the tick for the keyboard (Space) and for a
      // screen reader (aria-checked); this box is the pointer's.
      master.tabIndex = -1;
      master.setAttribute("aria-hidden", "true");
      const toggleAll = function () {
        const live = header.__live;
        // Aim at the state the user is asking for, not at a toggle of each row:
        // from indeterminate, one click should mean "include everything".
        if (live.checkedCount === live.all.length && live.all.length > 0) {
          queueGroup("staged", "unstage");
          vscode.postMessage({ type: "unstageAll" });
        } else {
          queueGroup("unstaged", "stage");
          vscode.postMessage({ type: "stageAllForCommit" });
        }
      };
      master.addEventListener("click", function (ev) {
        ev.stopPropagation();
        toggleAll();
      });
      header.__activate = function (how) { if (how === "space") toggleAll(); };
      const glabel = el("span", "glabel");
      glabel.textContent = "Changes";
      const gcount = el("span", "gcount");
      const actions = el("span", "group-actions");
      const discardAllNow = function () {
        vscode.postMessage({ type: "discardAll", group: "unstaged" });
      };
      const discardAll = rowBtn(ICON_DISCARD, "Discard All", function (ev) {
        ev.stopPropagation();
        discardAllNow();
      });
      actions.appendChild(discardAll);
      // Selecting a "section" in this model. There is only one list here — the
      // split into Staged and Unstaged is exactly what the checkbox model does
      // away with — so the sections the user means are the CHECKED rows and the
      // UNCHECKED ones. Ctrl/cmd-click takes everything, matching the split
      // model's headers; right-click offers the two halves by name, because
      // there is no second header to modifier-click.
      header.title = "Changes — Ctrl/Cmd-click to select every file, " +
        "right-click to select just the checked or unchecked ones";
      const selectKeys = function (keys) {
        selectedRows.clear();
        for (let i = 0; i < keys.length; i++) selectedRows.add(keys[i]);
        selectionAnchor = keys.length > 0 ? keys[keys.length - 1] : null;
        paintSelection();
      };
      const keysFor = function (which) {
        const out = [];
        for (const f of header.__live.all) {
          if (which === "checked" && !f.staged) continue;
          if (which === "unchecked" && f.staged) continue;
          const kind = f.kind === "merge" ? "merge" : f.staged ? "staged" : "unstaged";
          out.push(rowKey(kind, f.entry.path));
        }
        return out;
      };
      header.addEventListener("click", function (ev) {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const every = keysFor("all");
        const allOn = every.length > 0 && every.every(function (k) { return selectedRows.has(k); });
        selectKeys(allOn ? [] : every);
      });
      const menu = function (ev) {
        ev.preventDefault();
        const all = header.__live.all;
        const checked = keysFor("checked");
        const unchecked = keysFor("unchecked");
        const items = [];
        items.push({ icon: "check-all", label: "Select All (" + all.length + ")",
          fn: function () { selectKeys(keysFor("all")); } });
        if (checked.length > 0) {
          items.push({ icon: "check", label: "Select Checked (" + checked.length + ")",
            fn: function () { selectKeys(checked); } });
        }
        if (unchecked.length > 0) {
          items.push({ icon: "circle-outline", label: "Select Unchecked (" + unchecked.length + ")",
            fn: function () { selectKeys(unchecked); } });
        }
        items.push({ sep: true });
        items.push({ icon: "git-stash", label: "Stash Everything Staged",
          fn: function () { vscode.postMessage({ type: "stashStaged" }); } });
        items.push({ icon: "git-stash", label: "Stash All Changes",
          fn: function () { vscode.postMessage({ type: "stash" }); } });
        // The header's own button, for the keyboard (it is out of the tab order).
        items.push({ sep: true });
        items.push({ icon: "discard", label: "Discard All", danger: true, fn: discardAllNow });
        openActionMenu("Changes", items, header, null);
      };
      header.__menu = menu;
      header.addEventListener("contextmenu", menu);

      header.append(master, glabel, actions, gcount);
      group.appendChild(header);
      const body = el("div", "group-body");
      body.setAttribute("role", "group");
      group.appendChild(body);
      return group;
    }

    /** Prepends a checkbox-model row's tick (and its changes twisty) as the row is built. */
    function decorateTick(row, path, state, expandable) {
      const ck = el("input", "ck");
      ck.type = "checkbox";
      // Named by its file for the pointer's tooltip; the ROW is the tick for
      // the keyboard (Space) and for a screen reader (aria-checked), so the
      // box itself is out of the tab order and the accessibility tree.
      ck.setAttribute("aria-label", "Include " + path + " in the commit");
      ck.tabIndex = -1;
      ck.setAttribute("aria-hidden", "true");
      ck.checked = state === "staged";
      // Some of this file is staged and some is not. An empty box would claim
      // none of it is and a ticked one that all of it is; both are false, and
      // showing it as two rows instead was worse than either.
      ck.indeterminate = state === "partial";
      row.setAttribute("aria-checked", state === "staged" ? "true" : state === "partial" ? "mixed" : "false");
      ck.title = state === "staged"
        ? "Included in the commit — click to remove it"
        : state === "partial"
          ? "Partly included — click to include the rest"
          : "Not included — click to include it";
      const tick = function () {
        // Ticking the file supersedes any hunk view of it — the indexes it was
        // showing describe a state that no longer exists.
        expandedHunks.delete(path);
        hunkCache.delete(path);
        // Partial completes rather than reverting: the visible state is "not
        // finished", so forward is the obvious direction, and unstaging would
        // discard the part already staged.
        vscode.postMessage({
          type: state === "staged" ? "unstage" : "stage",
          path: path,
        });
      };
      ck.addEventListener("click", function (ev) {
        // The row itself opens the diff; the tick must not.
        ev.stopPropagation();
        tick();
      });
      row.__tick = tick;
      row.insertBefore(ck, row.firstChild);
      if (!expandable) return;

      const twist = el("button", "hunk-twisty", ICON_CHEVRON);
      twist.type = "button";
      twist.tabIndex = -1;
      const setOpen = function (next) {
        // Toggle ONE row in place. This used to call render(), which
        // rebuilt every group and every row of the whole Changes view to
        // open a single file -- the lag -- and threw away scroll position
        // and focus while doing it, which is the glitching. Nothing outside
        // this row changes, so nothing outside this row is rebuilt.
        const isOpen = expandedHunks.has(path);
        if (next === isOpen) return;
        paintTwist(row, next);
        const after = row.nextSibling;
        const panel =
          after && after.classList && after.classList.contains("hunks")
            ? after
            : null;
        if (isOpen) {
          expandedHunks.delete(path);
          if (panel) panel.remove();
          return;
        }
        expandedHunks.add(path);
        // Ask every time rather than trusting the cache: the file may have
        // changed on disk since it was last listed.
        vscode.postMessage({ type: "requestHunks", path: path });
        if (!panel && row.parentNode) {
          row.parentNode.insertBefore(renderHunks(path), row.nextSibling);
        }
      };
      twist.addEventListener("click", function (ev) {
        ev.stopPropagation();
        setOpen(!expandedHunks.has(path));
      });
      row.__expand = setOpen;
      row.insertBefore(twist, row.firstChild);
      paintTwist(row, expandedHunks.has(path));
    }

    /** A checkbox-model row's changes toggle, open or closed — on the button and on the row. */
    function paintTwist(row, open) {
      const twist = row.querySelector(".hunk-twisty");
      if (!twist) return;
      if (twist.classList.contains("open") !== open) twist.classList.toggle("open", open);
      setAttr(twist, "aria-expanded", open ? "true" : "false");
      const tip = open ? "Hide individual changes" : "Show individual changes";
      if (twist.dataset.tip !== tip && twist.getAttribute("title") !== tip) twist.title = tip;
      setAttr(row, "aria-expanded", open ? "true" : "false");
    }

    // The individual changes inside one file, each with its own tick (#20). These
    // are the changes NOT yet staged — ticking one stages it, so it leaves the
    // list on the next refresh, exactly like the file-level tick.
    function renderHunks(path) {
      const wrap = buildHunks(path);
      hunkPanelEls.set(path, wrap);
      // Register the in-place updater for this panel. Rebuilding calls
      // renderHunks again, so the map always points at the live element; a
      // panel that has been detached (the file collapsed, or its row gone)
      // reports false and forgets itself.
      hunkPanels.set(path, function () {
        if (!wrap.parentNode) {
          hunkPanels.delete(path);
          return false;
        }
        const focusedHunk = wrap.contains(document.activeElement)
          ? itemOf(document.activeElement)
          : null;
        const fresh = renderHunks(path);
        wrap.parentNode.replaceChild(fresh, wrap);
        // The keyboard was on one of these changes: keep it on the same one.
        if (focusedHunk) {
          const again = itemByTKey(focusedHunk.dataset.tkey) || itemOf(fresh.firstChild) || null;
          if (again) focusItem(again);
        } else {
          applyRoving();
        }
        return true;
      });
      return wrap;
    }
    // path -> the open changes panel now in the list, so a render keeps it
    // rather than rebuilding it (and its ticks) on every click elsewhere.
    const hunkPanelEls = new Map();
    // path -> the tree level its changes sit at (one below their file's row).
    const hunkLevels = new Map();
    function hunkPanelFor(path, level) {
      hunkLevels.set(path, level);
      const live = hunkPanelEls.get(path);
      if (live && live.isConnected && live.dataset.level === String(level)) return live;
      return renderHunks(path);
    }

    function buildHunks(path) {
      const wrap = el("div", "hunks");
      wrap.setAttribute("role", "group");
      const level = hunkLevels.get(path) || 3;
      wrap.dataset.level = String(level);
      const hunks = hunkCache.get(path);
      if (!hunks) {
        wrap.appendChild(el("div", "hunk-empty", "Reading changes…"));
        return wrap;
      }
      if (hunks.length === 0) {
        wrap.appendChild(el("div", "hunk-empty", "No separate changes to pick from."));
        return wrap;
      }
      for (const h of hunks) {
        const state = h.state || "unstaged";
        const hrow = el("div", "hunk-row hunk-" + state);
        const hck = el("input", "ck");
        hck.type = "checkbox";
        // The row is the tick for the keyboard and a screen reader (below).
        hck.tabIndex = -1;
        hck.setAttribute("aria-hidden", "true");
        // The real state, so a ticked change STAYS in the list showing itself as
        // ticked. It used to be hard-coded false because the list only ever held
        // unstaged changes, which made ticking one look like it deleted the row.
        hck.checked = state === "staged";
        hck.indeterminate = state === "partial";
        hck.title = state === "staged"
          ? "Staged — click to unstage this change"
          : state === "partial"
            ? "Partly staged — click to stage the rest"
            : "Include this change in the commit";
        const tickHunk = function () {
          // Paint the new state immediately. The host round trip re-reads git
          // and repaints authoritatively a moment later; without this the tick
          // sits visibly unchanged until then, which reads as lag.
          if (state === "staged") { hck.checked = false; hck.indeterminate = false; }
          else { hck.checked = true; hck.indeterminate = false; }
          hrow.setAttribute("aria-checked", hck.checked ? "true" : "false");
          hrow.classList.add("is-busy");
          vscode.postMessage({ type: "stageHunk", path: path, hunkIndex: h.index });
        };
        hck.addEventListener("click", function (ev) {
          ev.stopPropagation();
          tickHunk();
        });
        const lines = el("span", "hunk-lines");
        // 1-based, matching what the editor's gutter shows.
        lines.textContent = h.lineCount > 1
          ? "L" + (h.start + 1) + "–" + (h.end + 1)
          : "L" + (h.start + 1);
        const prev = el("span", "hunk-preview");
        prev.textContent = h.preview || "(whitespace only)";
        hrow.append(hck, lines, prev);

        // Clicking the row opens the file's diff at THIS change — the same way
        // clicking the file opens its diff. Without it a change is something you
        // can tick but never actually look at, which is backwards.
        hrow.tabIndex = -1;
        hrow.setAttribute("role", "treeitem");
        hrow.setAttribute("aria-level", String(level));
        hrow.setAttribute("aria-checked", state === "staged" ? "true" : state === "partial" ? "mixed" : "false");
        hrow.setAttribute("aria-label", (h.lineCount > 1
          ? "Lines " + (h.start + 1) + " to " + (h.end + 1)
          : "Line " + (h.start + 1)) + ": " + (h.preview || "whitespace only"));
        hrow.dataset.tkey = "h:" + path + ":" + h.index;
        hrow.dataset.tip = "Open this change in the diff";
        const openHunk = function () {
          vscode.postMessage({
            type: "openDiff", path: path, staged: false, line: h.start,
          });
        };
        hrow.addEventListener("click", openHunk);
        hrow.__activate = function (how) { if (how === "space") tickHunk(); else openHunk(); };

        wrap.appendChild(hrow);
      }
      return wrap;
    }

    function renderGroup(def, list) {
      const collapseKey = "group:" + def.kind;
      const isCollapsed = collapsed[collapseKey] === true;
      // Kept across renders; its count, its open state and the files its
      // Ctrl/Cmd-click selects are painted on below.
      const group = keep("grp|" + def.kind, "", function () { return buildGroupShell(def); });
      const wantClass = "group group--" + def.kind +
        (list.length === 0 ? " empty" : "") +
        (isCollapsed ? " collapsed" : "");
      if (group.className !== wantClass) group.className = wantClass;
      const header = group.firstChild;
      header.__list = list;
      setAttr(header, "aria-expanded", isCollapsed ? "false" : "true");
      setAttr(header, "aria-label", def.label + ", " + countWords(list.length));
      const gcount = header.querySelector(".gcount");
      if (gcount.textContent !== String(list.length)) gcount.textContent = String(list.length);

      const nodes = [];
      if (layout === "tree") {
        renderTreeInto(nodes, def, list);
      } else {
        for (const f of list) renderFileRow(nodes, def, f, 1);
      }
      patchChildren(group.lastChild, nodes);
      return group;
    }

    /** A split-model group and its header, built once per group (see renderGroup). */
    function buildGroupShell(def) {
      const collapseKey = "group:" + def.kind;
      const group = el("div", "group group--" + def.kind);
      group.setAttribute("role", "none");
      const header = el("div", "group-header");
      header.tabIndex = -1;
      header.setAttribute("role", "treeitem");
      header.setAttribute("aria-level", "1");
      header.dataset.tkey = "g:" + def.kind;
      const twisty = el("span", "twisty", ICON_CHEVRON);
      const gdot = el("span", "gdot");
      const glabel = el("span", "glabel");
      glabel.textContent = def.label;
      header.title = def.label + " — click to collapse, " +
        "Ctrl/Cmd-click to select every file in it, right-click for its actions";
      const gcount = el("span", "gcount");

      // Select the whole section. Ctrl/cmd-click matches the row modifier, and a
      // stash button that already follows the selection then means "stash this
      // whole section" without a second mechanism for it.
      header.addEventListener("click", (ev) => {
        if (!(ev.ctrlKey || ev.metaKey)) return;
        ev.preventDefault();
        ev.stopPropagation();
        const list = header.__list || [];
        const keys = [];
        for (let i = 0; i < list.length; i++) keys.push(rowKey(def.kind, list[i].path));
        // A stash's files selected before: this selection is the working
        // tree's, so it starts over.
        selectedRows.forEach((k) => { if (selScope(k) !== "tree") selectedRows.delete(k); });
        const allOn = keys.length > 0 && keys.every((k) => selectedRows.has(k));
        for (let i = 0; i < keys.length; i++) {
          if (allOn) selectedRows.delete(keys[i]);
          else selectedRows.add(keys[i]);
        }
        selectionAnchor = keys.length > 0 ? keys[keys.length - 1] : null;
        paintSelection();
      });

      // The header's buttons, and the same actions in its menu (right-click,
      // Shift+F10) — the keyboard's way to them, as the buttons are out of
      // the tab order.
      const acts = [];
      if (def.kind === "staged") {
        acts.push({ svg: ICON_UNSTAGE, icon: "remove", label: "Unstage All", fn: () => {
          queueGroup("staged", "unstage");
          vscode.postMessage({ type: "unstageAll", group: def.kind });
        } });
      } else {
        acts.push({ svg: ICON_STAGE, icon: "add", label: "Stage All", fn: () => {
          queueGroup(def.kind, "stage");
          vscode.postMessage({ type: "stageAll", group: def.kind });
        } });
        if (def.kind === "unstaged") {
          acts.push({ svg: ICON_DISCARD, icon: "discard", label: "Discard All", danger: true, fn: () => {
            vscode.postMessage({ type: "discardAll", group: def.kind });
          } });
        }
      }
      const actions = el("span", "group-actions");
      for (const a of acts) {
        actions.appendChild(rowBtn(a.svg, a.label, (ev) => { ev.stopPropagation(); a.fn(); }));
      }
      header.__menu = (ev) => {
        if (ev) ev.preventDefault();
        const list = header.__list || [];
        const items = acts.map((a) => ({ icon: a.icon, label: a.label, fn: a.fn, danger: a.danger }));
        // What Ctrl/Cmd-click on the header does, from the keyboard.
        items.push({ sep: true });
        items.push({ icon: "check-all", label: "Select All (" + list.length + ")", fn: () => {
          selectedRows.clear();
          for (let i = 0; i < list.length; i++) selectedRows.add(rowKey(def.kind, list[i].path));
          selectionAnchor = list.length > 0 ? rowKey(def.kind, list[list.length - 1].path) : null;
          paintSelection();
        } });
        if (def.kind !== "merge") {
          items.push({ sep: true });
          items.push(def.kind === "staged"
            ? { icon: "git-stash", label: "Stash Everything Staged", fn: () => vscode.postMessage({ type: "stashStaged" }) }
            : { icon: "git-stash", label: "Stash All Changes", fn: () => vscode.postMessage({ type: "stash" }) });
        }
        openActionMenu(def.label, items, header, null);
      };
      header.addEventListener("contextmenu", header.__menu);

      header.append(twisty, gdot, glabel, actions, gcount);
      const setOpen = (open) => {
        collapsed[collapseKey] = !open;
        render();
      };
      // A Ctrl/Cmd-click selects the group's files (above) and leaves it
      // open: it used to fold the group away over the selection it had
      // just made — stopPropagation stops neither listener on one element.
      header.addEventListener("click", (ev) => {
        if (ev.ctrlKey || ev.metaKey) return;
        setOpen(collapsed[collapseKey] === true);
      });
      header.__expand = setOpen;
      header.__activate = () => setOpen(collapsed[collapseKey] === true);
      group.appendChild(header);

      const body = el("div", "group-body");
      body.setAttribute("role", "group");
      group.appendChild(body);
      return group;
    }

    /**
     * The opts argument lets the checkbox model reuse this tree.
     *
     * That model merges staged and unstaged files into one list, so each FILE
     * needs its own def for its row buttons (defFor) and each row needs its tick
     * prepended (tick) — while the folder rows keep the single def they are
     * given. Without this the tree/list toggle was visible but inert in checkbox
     * mode, because the checklist only ever built a flat list.
     */
    function renderTreeInto(nodes, def, list, opts) {
      const tree = buildTree(list);
      renderNode(nodes, def, tree, 1, opts);
    }

    // Flatten every file path under a folder node (direct + nested) so a
    // folder-level stage/unstage can hand the whole set to one git op.
    function collectFolderFiles(node, out) {
      for (const f of node.files) out.push(f.entry.path);
      for (const [, d] of node.dirs) collectFolderFiles(d, out);
      return out;
    }

    function renderNode(nodes, def, node, depth, opts) {
      // Folders first (alphabetical), then files.
      const dirs = [...node.dirs.values()].sort((a, b) =>
        a.name.localeCompare(b.name));
      for (const dir of dirs) {
        const key = "folder:" + def.kind + ":" + dir.path;
        folderKeyAccumulator.push(key);
        const isCollapsed = collapsed[key] === true;
        const row = keep(
          "fold|" + stagingModel + "|" + def.kind + "|" + dir.path,
          dir.name + "|" + depth,
          function () { return buildFolderRow(def, dir.name, dir.path, key, depth); },
        );
        // The files a folder's Stage / Unstage / Discard act on are today's.
        row.__paths = collectFolderFiles(dir, []);
        if (row.classList.contains("collapsed") !== isCollapsed) row.classList.toggle("collapsed", isCollapsed);
        setAttr(row, "aria-expanded", isCollapsed ? "false" : "true");
        setAttr(row, "aria-label", dir.name + ", folder, " + countWords(row.__paths.length));
        nodes.push(row);
        if (!isCollapsed) renderNode(nodes, def, dir, depth + 1, opts);
      }
      for (const f of node.files.slice().sort((a, b) =>
        a.name.localeCompare(b.name))) {
        const rowDef = opts && opts.defFor ? opts.defFor(f.entry) : def;
        fileRowNode(nodes, rowDef, f.entry, f.name, null, depth + 1, depth * 12 + 16,
          opts && opts.tick ? opts.tick(f.entry) : null);
      }
    }

    function buildFolderRow(def, name, path, key, depth) {
      const row = el("div", "row");
      row.style.paddingLeft = (depth * 12) + "px";
      row.tabIndex = -1;
      // It opens and closes like a group header: a treeitem one level in.
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(depth + 1));
      row.dataset.tkey = "d:" + stagingModel + ":" + def.kind + ":" + path;
      row.appendChild(el("span", "twisty", ICON_CHEVRON));
      row.appendChild(el("span", "file-icon folder-icon", ICON_FOLDER));
      const nameEl = el("span", "name");
      nameEl.textContent = name;
      row.appendChild(nameEl);
      row.appendChild(el("span", "spacer"));
      // Folder-level stage/unstage/discard — one git op over every file under
      // this folder (mirrors the per-file actions; stopPropagation so the
      // button click never toggles the folder's collapse).
      // The same actions are the folder's menu (right-click, Shift+F10): its
      // buttons are the pointer's, and out of the tab order.
      const acts = [];
      if (def.staged) {
        acts.push({ svg: ICON_UNSTAGE, icon: "remove", tip: "Unstage folder", label: "Unstage Folder", fn: () => {
          queueFiles(row.__paths, "unstage");
          vscode.postMessage({ type: "unstageFolder", paths: row.__paths });
        } });
      } else {
        acts.push({ svg: ICON_STAGE, icon: "add", tip: "Stage folder", label: "Stage Folder", fn: () => {
          queueFiles(row.__paths, "stage");
          vscode.postMessage({ type: "stageFolder", paths: row.__paths });
        } });
        if (def.kind === "unstaged") {
          acts.push({ svg: ICON_DISCARD, icon: "discard", tip: "Discard folder", label: "Discard Folder", danger: true, fn: () => {
            vscode.postMessage({ type: "discardFolder", paths: row.__paths });
          } });
        }
      }
      const factions = el("span", "row-actions");
      for (const a of acts) {
        factions.appendChild(rowBtn(a.svg, a.tip, (ev) => { ev.stopPropagation(); a.fn(); }));
      }
      row.appendChild(factions);
      const setOpen = (open) => { collapsed[key] = !open; render(); };
      row.addEventListener("click", () => setOpen(collapsed[key] === true));
      row.__expand = setOpen;
      row.__activate = () => setOpen(collapsed[key] === true);
      row.__menu = (ev) => {
        if (ev) ev.preventDefault();
        const items = acts.map((a) => ({ icon: a.icon, label: a.label, fn: a.fn, danger: a.danger }));
        // A conflicted file is not stashed; the other folders' files can be.
        if (def.kind !== "merge") {
          items.push({ sep: true });
          items.push({ icon: "git-stash", label: "Stash This Folder",
            fn: () => vscode.postMessage({ type: "stashPaths", paths: row.__paths }) });
        }
        openActionMenu(name, items, row, "folder");
      };
      row.addEventListener("contextmenu", row.__menu);
      // Dragged onto the Stashes header, its files are stashed (not a
      // conflicted one: git cannot stash it).
      row.draggable = true;
      row.addEventListener("dragstart", (ev) => {
        const paths = def.kind === "merge" ? [] : treeDragPaths(null, row.__paths || []);
        beginDrag(ev, { kind: "tree", paths: paths }, [row], paths.length ? paths.join("\n") : path);
      });
      row.addEventListener("dragend", endDrag);
      return row;
    }

    /** A file row in the flat list: its name, then the folder it is in. */
    function renderFileRow(nodes, def, e, depth, tick) {
      const slash = e.path.lastIndexOf("/");
      const fileName = slash === -1 ? e.path : e.path.slice(slash + 1);
      const dir = slash === -1 ? "" : e.path.slice(0, slash);
      fileRowNode(nodes, def, e, fileName, dir, depth + 1, 20, tick);
    }

    /**
     * One file row, kept by its key while nothing it was built from changes,
     * followed by its open changes panel in the checkbox model. The row's
     * handlers are built from def, the path and the status, so all of them
     * are in its signature; its selection is painted on every render.
     */
    function fileRowNode(nodes, def, e, fileName, dir, level, padLeft, tick) {
      const key = rowKey(def.kind, e.path);
      rowOrder.push(key);
      const sig = [
        def.kind, def.staged ? 1 : 0, e.status, fileName, dir == null ? "\u0000" : dir,
        level, padLeft, tick ? tick.sig : "",
      ].join("|");
      const row = keep("file|" + stagingModel + "|" + key, sig, function () {
        const r = makeFileRow(def, e, fileName, dir);
        r.style.paddingLeft = padLeft + "px";
        r.setAttribute("aria-level", String(level));
        // In the checkbox model a file keeps its place (and the keyboard) when
        // it is ticked, though its group changes; in the split model it moves
        // to the other group, and the keyboard stays where the file was.
        r.dataset.tkey = stagingModel === "checkboxes"
          ? "f:ck:" + e.path
          : "f:" + key;
        if (tick) tick.decorate(r);
        return r;
      });
      paintRowSelected(row);
      nodes.push(row);
      if (tick && tick.expandable) {
        const open = expandedHunks.has(e.path);
        paintTwist(row, open);
        if (open) nodes.push(hunkPanelFor(e.path, level + 1));
      }
      return row;
    }

    function makeFileRow(def, e, fileName, dir) {
      const letter = e.status;
      const conflict = CONFLICT_LETTERS.has(letter);
      const row = el("div", "row is-file " + statusClass(letter) +
        (letter === "D" ? " is-deleted" : "") +
        (conflict ? " is-conflict" : ""));
      row.tabIndex = -1;
      // A treeitem, not a button: a button's content is read as one name, so
      // the row was heard as "README.md Stage file Discard changes M". Its
      // name is the file and what happened to it; its folder is the tip.
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-label", fileName + ", " + statusTitle(letter));
      row.title = e.path;
      // The path is not otherwise recoverable from the DOM: the title attribute
      // is moved to data-tip and removed by upgradeTips, so a delegated handler
      // or a drop target has nothing to read without these.
      const key = rowKey(def.kind, e.path);
      row.dataset.path = e.path;
      row.dataset.kind = def.kind;
      row.dataset.key = key;

      row.appendChild(el("span", "file-icon", ICON_FILE));
      const name = el("span", "name");
      name.textContent = fileName;
      row.appendChild(name);

      if (dir != null && dir !== "") {
        // The box clips from the start (CSS direction: rtl) to keep the tail;
        // the path is an isolated left-to-right run inside it. Setting the
        // box itself to ltr (as it was) cancelled the clip.
        const dirEl = el("span", "dir");
        const dirText = document.createElement("bdi");
        dirText.textContent = dir;
        dirEl.appendChild(dirText);
        row.appendChild(dirEl);
      } else {
        row.appendChild(el("span", "spacer"));
      }

      const actions = el("span", "row-actions");
      if (def.staged) {
        actions.appendChild(rowBtn(ICON_UNSTAGE, "Unstage file", (ev) => {
          ev.stopPropagation();
          queueOp(e.path, "unstage");
          vscode.postMessage({ type: "unstage", path: e.path });
        }));
      } else {
        actions.appendChild(rowBtn(ICON_STAGE, "Stage file", (ev) => {
          ev.stopPropagation();
          queueOp(e.path, "stage");
          vscode.postMessage({ type: "stage", path: e.path });
        }));
        if (def.kind === "unstaged") {
          actions.appendChild(rowBtn(ICON_DISCARD, "Discard changes", (ev) => {
            ev.stopPropagation();
            vscode.postMessage({ type: "discard", path: e.path });
          }));
        }
      }
      row.appendChild(actions);

      const status = el("span", "status " + statusClass(letter));
      status.textContent = letter;
      status.dataset.tip = statusTitle(letter);
      status.setAttribute("aria-hidden", "true");
      row.appendChild(status);

      const open = () => vscode.postMessage({
        type: "openDiff", path: e.path, staged: !!def.staged,
      });
      const menu = (ev) => {
        ev.preventDefault();
        // Right-clicking a row OUTSIDE the selection acts on that row, and
        // replaces the selection — otherwise the menu would quietly operate on
        // files scrolled off screen that the user has forgotten selecting.
        if (selectedRows.size > 0 && !selectedRows.has(key)) {
          clearSelection();
        }
        const multi = selectedRows.has(key) && selectedRows.size > 1;
        if (multi) {
          openActionMenu(String(selectionPaths().length) + " files", multiItems(), row, "files");
          return;
        }
        const items = [
          { icon: "git-compare", label: "Open Changes", fn: open },
        ];
        if (letter !== "D") {
          items.push({ icon: "go-to-file", label: "Open File",
            fn: () => vscode.postMessage({ type: "openFile", path: e.path }) });
        }
        items.push({ sep: true });
        if (def.staged) {
          items.push({ icon: "remove", label: "Unstage",
            fn: () => { queueOp(e.path, "unstage"); vscode.postMessage({ type: "unstage", path: e.path }); } });
        } else {
          items.push({ icon: "add", label: "Stage",
            fn: () => { queueOp(e.path, "stage"); vscode.postMessage({ type: "stage", path: e.path }); } });
          if (letter !== "!") {
            items.push({ icon: "discard", label: "Discard Changes", danger: true,
              fn: () => vscode.postMessage({ type: "discard", path: e.path }) });
          }
        }
        items.push({ sep: true });
        items.push({ icon: "git-stash", label: "Stash This File",
          fn: () => vscode.postMessage({ type: "stashPaths", paths: [e.path] }) });
        items.push({ icon: "git-stash", label: def.staged ? "Stash Everything Staged" : "Stash All Changes",
          fn: () => vscode.postMessage(
            def.staged ? { type: "stashStaged" } : { type: "stash" }) });
        openActionMenu(fileName, items, row, "file");
      };
      row.addEventListener("click", (ev) => {
        // A modifier click selects; a plain one opens, as it always has.
        if (handleSelectionClick(ev, key)) return;
        // The second click of a double-click: the first one opened the diff.
        if (ev.detail > 1) return;
        open();
      });
      // Enter opens; Space ticks in the checkbox model and opens otherwise.
      row.__activate = (how) => {
        if (how === "space" && row.__tick) row.__tick();
        else open();
      };
      // Double-click OR right-click a file → an actions menu (open / stage / discard).
      row.addEventListener("dblclick", menu);
      row.addEventListener("contextmenu", menu);

      // Drag it — or the selection it is in — onto the Stashes header to
      // stash them. An unselected row goes alone, and the selection is left
      // as it was: a drag is not a click, and never takes files the user has
      // forgotten selecting somewhere off screen.
      row.draggable = true;
      row.addEventListener("dragstart", (ev) => {
        const inSelection = selectedRows.has(key);
        const paths = treeDragPaths(key, [e.path]);
        const rows = inSelection ? Array.from(groupsEl.querySelectorAll(".row.is-file.is-selected")) : [row];
        beginDrag(ev, { kind: "tree", paths: paths, selection: inSelection }, rows, paths.length ? paths.join("\n") : e.path);
      });
      // Its own, too: a row a render took out mid-drag hears its end, the page does not.
      row.addEventListener("dragend", endDrag);
      row.__menu = menu;
      return row;
    }

    function makeIconBtn(svg, title, onClick) {
      const b = el("button", "icon-btn", svg);
      b.type = "button";
      // data-tip drives our own tooltip (native title is flaky in webviews);
      // aria-label keeps it accessible.
      b.dataset.tip = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", onClick);
      return b;
    }

    /** A row's own button: the pointer's, out of the tab order (the tree has one stop). */
    function rowBtn(svg, title, onClick) {
      const b = makeIconBtn(svg, title, onClick);
      b.tabIndex = -1;
      return b;
    }

    /**
     * A row's verb in WORDS — a stash's Apply and Pop, a stash file's Move
     * and Copy, whose glyphs read alike. The pointer's, out of the tab order
     * like rowBtn (the row's menu has the same verbs for the keyboard); its
     * tip says exactly what happens.
     */
    function wordBtn(label, tip, onClick) {
      const b = el("button", "word-btn");
      b.type = "button";
      b.textContent = label;
      b.dataset.tip = tip;
      b.setAttribute("aria-description", tip);
      b.tabIndex = -1;
      b.addEventListener("click", onClick);
      return b;
    }
    const TIP_APPLY = "Apply: put these changes back and keep the stash";
    const TIP_POP = "Pop: put these changes back and delete the stash";
    /**
     * Where some of a stash's files come back, named as the groups on screen
     * name it: a file comes back as it was stashed — staged if it was — so a
     * staged one lands in Staged, not in "Changes" (in the split model no
     * group is called that).
     */
    function landsIn(files) {
      const staged = files.some((f) => f.staged);
      const unstaged = files.some((f) => f.staged !== "all");
      const asWas = " as " + (files.length === 1 ? "it was" : "they were") + " stashed";
      if (stagingModel === "checkboxes") return "into Changes" + (staged ? ", staged" + asWas : "");
      if (!staged) return "into Unstaged";
      return (unstaged ? "into Staged and Unstaged" : "into Staged") + asWas;
    }
    /** Some of a stash's files, by path, as its list has them. */
    function stashFilesOf(s, paths) {
      const files = stashFiles.get(s.sha) || [];
      return paths.map((p) => files.find((f) => f.path === p) || { path: p });
    }
    /** Move / Copy's tips, for the files they would bring back ("this file" for one). */
    function tipMove(files) {
      return "Move: take " + (files.length === 1 ? "this file" : "these " + files.length + " files") +
        " out of the stash, back " + landsIn(files);
    }
    function tipCopy(files) {
      const one = files.length === 1;
      return "Copy: bring " + (one ? "this file" : "these " + files.length + " files") +
        " back " + landsIn(files) + ", and keep " + (one ? "it" : "them") + " in the stash";
    }

    // ---- Stashes group ---------------------------------------------------
    // Every stash, after the file groups: a row each (its words, where and
    // when it was made, how many files), opening to ALL its files — tracked,
    // staged, untracked — as Changes rows, a page at a time. A file comes back with Move to
    // Changes (it leaves the stash) or Copy to Changes (the stash keeps it);
    // a stash with Apply, Pop, Create Branch… or Drop…. Every message names a
    // stash by its full sha, never stash@{n}.
    //
    // authStashes is the host's list; the rows show it with every action
    // still in flight laid over it (stashPending), so a Pop takes its row away
    // at the click and a Cancel puts it back — never a reload of the list.
    let authStashes = [];
    // sha -> { remove, busy, moved: [paths], busyPaths: [paths], at }
    const stashPending = new Map();
    // A stash action can wait on a question (Stash & Retry, the staging one),
    // so this is long; it only matters when the host never answers.
    const STASH_PENDING_TTL = 60000;
    // What the user opened, and whether the group is folded — the webview's
    // own state, so hiding the view or reloading the window keeps both. The
    // group starts open, each stash closed.
    const stashUi = (function () {
      try { return (vscode.getState && vscode.getState()) || {}; } catch (e) { return {}; }
    })();
    const stashOpen = new Set(Array.isArray(stashUi.stashOpen) ? stashUi.stashOpen : []);
    let stashGroupCollapsed = stashUi.stashGroupCollapsed === true;
    let lastStashSig = null;
    // A stash's files, by its sha. A stash never changes, so what was read
    // once is its files for good. The host carries them in the list while
    // they are few (stashRows.ts); a bigger stash comes as a count, and its
    // files are asked for when it is opened ("stashReadFiles").
    const stashFiles = new Map();
    // Asked for, not answered yet; answered with nothing (said in its place).
    const stashReading = new Set();
    const stashUnreadable = new Set();
    // What is left of a stash after a move: its files are known before the
    // list that names it arrives, and a list read before the move must not
    // forget them.
    const stashSeeded = new Set();
    // Ctrl/Cmd-click on a stash whose files are still being read: select
    // them when they arrive.
    let stashSelectOnRead = null;
    // How many of an open stash's files are shown; "Show 200 more of N" adds a page.
    const STASH_FILE_PAGE = 200;
    const stashShown = new Map();
    function saveStashUi() {
      try {
        const prev = (vscode.getState && vscode.getState()) || {};
        vscode.setState(Object.assign({}, prev, {
          stashOpen: Array.from(stashOpen),
          stashGroupCollapsed: stashGroupCollapsed,
        }));
      } catch (e) { /* a host without webview state */ }
    }

    /** How many files a stash of the host's list holds (a list from before counts carried its files). */
    function countOf(s) {
      return typeof s.count === "number" ? s.count : Array.isArray(s.files) ? s.files.length : 0;
    }

    /** The host's list with the actions in flight laid over it. */
    function shownStashes() {
      const out = [];
      for (let i = 0; i < authStashes.length; i++) {
        const s = authStashes[i];
        const p = stashPending.get(s.sha);
        if (p && p.remove) continue;
        if (p && p.moved && p.moved.length) {
          const left = countOf(s) - p.moved.length;
          if (left <= 0) continue;
          out.push(Object.assign({}, s, { count: left, leaving: p.moved }));
          continue;
        }
        out.push(s);
      }
      return out;
    }

    /** A shown stash's files, less any on their way out; undefined until read. */
    function visibleFiles(s) {
      const files = stashFiles.get(s.sha);
      if (!files || !s.leaving) return files;
      const leaving = new Set(s.leaving);
      return files.filter((f) => !leaving.has(f.path));
    }

    /** Take in a list from the host: the files it carried, and forget the stashes it no longer has. */
    function takeStashList(list) {
      const have = new Set();
      for (let i = 0; i < list.length; i++) {
        const s = list[i];
        have.add(s.sha);
        stashSeeded.delete(s.sha);
        if (Array.isArray(s.files)) {
          stashFiles.set(s.sha, s.files);
          stashUnreadable.delete(s.sha);
        }
      }
      stashFiles.forEach((_f, sha) => {
        if (!have.has(sha) && !stashPending.has(sha) && !stashSeeded.has(sha)) stashFiles.delete(sha);
      });
      stashUnreadable.forEach((sha) => { if (!have.has(sha)) stashUnreadable.delete(sha); });
      authStashes = list;
    }

    /** Ask the host for a stash's files, once. */
    function readStashFiles(sha) {
      if (stashReading.has(sha) || stashFiles.has(sha) || stashUnreadable.has(sha)) return;
      stashReading.add(sha);
      vscode.postMessage({ type: "stashReadFiles", sha: sha });
    }

    /** Drop the patches the host's list now agrees with, or that aged out. */
    function reconcileStashPending() {
      const now = Date.now();
      const have = new Set(authStashes.map((s) => s.sha));
      stashPending.forEach((p, sha) => {
        if (now - p.at > STASH_PENDING_TTL) { stashPending.delete(sha); return; }
        // Taken off the list (Pop, Drop, a branch, a move): settled once the
        // list no longer holds that sha — what is left of a move is a NEW sha.
        if ((p.remove || p.moved) && !have.has(sha)) stashPending.delete(sha);
      });
    }

    /**
     * The selected files of ONE stash: the first one on screen that has any.
     * A selection never spans two (handleSelectionClick starts over in the
     * other); if it ever did, the other stash's files are left out rather
     * than sent under this one's sha.
     */
    function stashSelection() {
      let sha = null;
      const paths = [];
      for (let i = 0; i < stashRowOrder.length; i++) {
        const k = stashRowOrder[i];
        if (!selectedRows.has(k)) continue;
        const rest = k.slice(6);
        const cut = rest.indexOf(":");
        const at = rest.slice(0, cut);
        if (sha === null) sha = at;
        else if (at !== sha) continue;
        paths.push(rest.slice(cut + 1));
      }
      return sha ? { sha: sha, paths: paths } : null;
    }

    function countFiles(n) { return n === 1 ? "1 file" : String(n) + " files"; }

    /**
     * Everything a stash row shows, so an identical re-post touches nothing.
     * A stash's files are named by its sha and whether they have been read —
     * they never change — so a post of a big stash costs no more than a small one.
     */
    function stashSig(list) {
      // The staging model too: the Move and Copy tips name its groups.
      return JSON.stringify([
        layout, stagingModel, stashGroupCollapsed, Array.from(stashOpen),
        list.map((s) => {
          const p = stashPending.get(s.sha);
          return [s.sha, s.text, s.branch || "", s.time, s.rel || "", countOf(s),
            stashFiles.has(s.sha) ? 1 : stashUnreadable.has(s.sha) ? 2 : 0, s.leaving || 0, stashShown.get(s.sha) || 0,
            p && p.busy ? 1 : 0, p && p.busyPaths ? p.busyPaths : 0];
        }),
        Object.keys(collapsed).filter((k) => k.indexOf("stashfolder:") === 0 && collapsed[k]),
      ]);
    }

    function renderStashesIfChanged() {
      if (stashSig(shownStashes()) === lastStashSig) return;
      renderStashes();
    }

    function renderStashes() {
      const list = shownStashes();
      lastStashSig = stashSig(list);
      // The group is built again (it changes only when the list or what is
      // open does): the keyboard goes back to the same row's new node, or —
      // a row that left — to the next one showing, as in the file groups.
      const was = focusPlace(stashesEl);
      stashesEl.textContent = "";
      stashRowOrder = [];
      // No stash, no group — but while the working tree's files are being
      // dragged, its header is where they go, so it is there then.
      const shown = list.length > 0 || (!!drag && drag.kind === "tree" && drag.paths.length > 0);
      stashesEl.hidden = !shown;
      if (shown) stashesEl.appendChild(renderStashGroup(list));
      paintSelection();
      applyRoving();
      handFocusOn(was, stashesEl, nearestAboveStashes);
      // A tooltip over a row that was just replaced has nothing under it.
      if (tipTarget && !tipTarget.isConnected) hideTip();
      // A stash that is gone, or files that left it, are not selected any more.
      let dropped = false;
      selectedRows.forEach((k) => {
        if (selScope(k) !== "tree" && stashRowOrder.indexOf(k) === -1) { selectedRows.delete(k); dropped = true; }
      });
      if (dropped && selectionAnchor && orderOf(selectionAnchor).indexOf(selectionAnchor) === -1) {
        selectionAnchor = null;
      }
      updateSelectionBar();
      if (drag) paintDrop();
    }

    /**
     * Where the keyboard goes when the Stashes group has gone with the stash
     * that had it and no row is showing above it (the working tree's last
     * row takes it when there is one — handFocusOn): the toolbar's last
     * button, never the page.
     */
    function nearestAboveStashes() {
      const tools = document.querySelectorAll(".changes-toolbar .icon-btn:not(:disabled)");
      return tools.length ? tools[tools.length - 1] : null;
    }

    /** A row of the Stashes group as a treeitem of the list's tree, out of the tab order until the arrows reach it. */
    function stashItem(row, tkey, level) {
      row.tabIndex = -1;
      row.setAttribute("role", "treeitem");
      row.setAttribute("aria-level", String(level));
      row.dataset.tkey = tkey;
    }

    function renderStashGroup(list) {
      const group = el("div", "group group--stashes" + (stashGroupCollapsed ? " collapsed" : ""));
      group.setAttribute("role", "none");
      const header = el("div", "group-header");
      stashItem(header, "group:stashes", 1);
      header.setAttribute("aria-expanded", stashGroupCollapsed ? "false" : "true");
      header.setAttribute("aria-label", "Stashes, " + countWords(list.length, "stash", "stashes"));
      const glabel = el("span", "glabel");
      glabel.textContent = "Stashes";
      const gcount = el("span", "gcount");
      gcount.textContent = String(list.length);
      header.title = "Stashes — click to " + (stashGroupCollapsed ? "show" : "hide") + " them";
      header.append(el("span", "twisty", ICON_CHEVRON), el("span", "gdot"), glabel, el("span", "group-actions"));
      // None yet (a drag of the working tree's files shows the header): no "0".
      if (list.length > 0) header.appendChild(gcount);
      const setOpen = (open) => {
        if (stashGroupCollapsed === !open) return;
        stashGroupCollapsed = !open;
        saveStashUi();
        renderStashes();
      };
      header.addEventListener("click", () => setOpen(stashGroupCollapsed));
      header.__expand = setOpen;
      header.__activate = () => setOpen(stashGroupCollapsed);
      group.appendChild(header);
      const body = el("div", "group-body");
      body.setAttribute("role", "group");
      if (!stashGroupCollapsed) {
        for (let i = 0; i < list.length; i++) {
          const s = list[i];
          const open = stashOpen.has(s.sha);
          body.appendChild(makeStashRow(s, open));
          if (!open) continue;
          const files = visibleFiles(s);
          if (!files) {
            // Not carried with the list: asked for, and said in its place.
            body.appendChild(makeStashNote(stashUnreadable.has(s.sha)));
            readStashFiles(s.sha);
            continue;
          }
          // A page at a time: a stash of thousands of files (a dependency
          // folder stashed with -u) is thousands of rows otherwise.
          const limit = stashShown.get(s.sha) || STASH_FILE_PAGE;
          const page = files.length > limit ? files.slice(0, limit) : files;
          if (layout === "tree") renderStashNode(body, s, buildTree(page), 2, files);
          else for (const f of page) body.appendChild(makeStashFileRow(s, f, null, 2));
          if (page.length < files.length) body.appendChild(makeStashMore(s, files, page.length));
        }
      }
      group.appendChild(body);
      return group;
    }

    function stashMeta(s) {
      const parts = [];
      if (s.branch) parts.push(s.branch);
      // Its age from the host's one formatter ("3h", "2d"), as the Commits
      // list and the push review say it.
      if (s.rel) parts.push(s.rel);
      parts.push(countFiles(countOf(s)));
      return parts.join(" · ");
    }

    /** Where an open stash's files would be: being read, or unreadable. */
    function makeStashNote(failed) {
      const row = el("div", "row stash-note");
      row.style.paddingLeft = (2 * 12 + 16) + "px";
      row.appendChild(el("span", "file-icon", failed
        ? '<i class="codicon codicon-warning" aria-hidden="true"></i>'
        : '<i class="codicon codicon-loading codicon-modifier-spin" aria-hidden="true"></i>'));
      const text = el("span", "name");
      text.textContent = failed ? "Its files couldn't be read." : "Reading its files…";
      row.appendChild(text);
      if (!failed) row.setAttribute("aria-busy", "true");
      return row;
    }

    /**
     * "Show 200 more of 250": the next page of a stash's files, in the branch
     * menu's words for its tags (showMoreLabel). From the keyboard, the first file it showed
     * takes the keyboard, so reading goes on where it stopped.
     */
    function makeStashMore(s, files, shownCount) {
      const hidden = files.length - shownCount;
      const row = el("div", "row stash-more");
      row.style.paddingLeft = (2 * 12 + 16) + "px";
      stashItem(row, "stashmore:" + s.sha, 3);
      row.appendChild(el("span", "file-icon"));
      const text = el("span", "name");
      text.textContent = showMoreLabel(hidden, STASH_FILE_PAGE);
      row.appendChild(text);
      const grow = () => {
        const fromKeys = document.activeElement === row;
        stashShown.set(s.sha, shownCount + STASH_FILE_PAGE);
        renderStashes();
        if (!fromKeys) return;
        const first = stashKey(s.sha, files[shownCount].path);
        const rows = stashesEl.querySelectorAll(".row.is-file");
        for (let i = 0; i < rows.length; i++) {
          if (rows[i].dataset.key === first) {
            focusItem(rows[i]);
            break;
          }
        }
      };
      row.addEventListener("click", (ev) => { ev.preventDefault(); grow(); });
      // Enter or Space, from the tree's keys.
      row.__activate = grow;
      return row;
    }

    /** Select every file of an open stash that is on screen. */
    function selectStashFiles(sha) {
      const prefix = "stash:" + sha + ":";
      const keys = stashRowOrder.filter((k) => k.indexOf(prefix) === 0);
      selectedRows.clear();
      for (let i = 0; i < keys.length; i++) selectedRows.add(keys[i]);
      selectionAnchor = keys.length ? keys[keys.length - 1] : null;
      paintSelection();
    }

    /** A stash action from its row or its menu: the row moves now, the host settles it. */
    function stashAct(s, action) {
      if (stashPending.has(s.sha)) return;
      // Pop takes the row away at once; Drop and Create Branch ask first, so
      // their row waits (dimmed) until the host says the question was
      // answered; Apply keeps it, dimmed while it runs.
      stashPending.set(s.sha, action === "pop" ? { remove: true, at: Date.now() } : { busy: true, at: Date.now() });
      renderStashes();
      vscode.postMessage({ type: "stashAct", sha: s.sha, action: action });
    }

    /** Move / Copy to Changes for some of a stash's files. */
    function stashFilesAct(s, paths, action) {
      const files = stashFiles.get(s.sha);
      if (!files || stashPending.has(s.sha)) return;
      // Only the paths this stash holds: "all of them" is counted against
      // its own files, never against a list that could carry another's.
      const have = new Set(files.map((f) => f.path));
      const mine = paths.filter((p) => have.has(p));
      if (!mine.length) return;
      const all = mine.length >= files.length;
      stashPending.set(s.sha, action === "move"
        ? (all ? { remove: true, at: Date.now() } : { moved: mine.slice(), at: Date.now() })
        : { busyPaths: mine.slice(), at: Date.now() });
      clearSelection();
      renderStashes();
      vscode.postMessage({ type: "stashFiles", sha: s.sha, action: action, paths: mine });
    }

    function stashItems(s) {
      return [
        { icon: "diff-multiple", label: "Open All Changes",
          fn: () => vscode.postMessage({ type: "stashOpenAll", sha: s.sha }) },
        { sep: true },
        { icon: "git-stash-apply", label: "Apply", tip: TIP_APPLY, fn: () => stashAct(s, "apply") },
        { icon: "git-stash-pop", label: "Pop", tip: TIP_POP, fn: () => stashAct(s, "pop") },
        { icon: "git-branch", label: "Create Branch…", fn: () => stashAct(s, "branch") },
        { sep: true },
        { icon: "trash", label: "Drop…", danger: true, fn: () => stashAct(s, "drop") },
      ];
    }

    function makeStashRow(s, open) {
      const p = stashPending.get(s.sha);
      const busy = !!(p && p.busy);
      const row = el("div", "row stash-row" + (open ? "" : " collapsed") + (busy ? " is-busy" : ""));
      row.style.paddingLeft = "12px";
      stashItem(row, "stash:" + s.sha, 2);
      row.dataset.sha = s.sha;
      row.setAttribute("aria-expanded", open ? "true" : "false");
      if (busy) row.setAttribute("aria-busy", "true");
      row.appendChild(el("span", "twisty", ICON_CHEVRON));
      row.appendChild(el("span", "file-icon stash-icon",
        '<i class="codicon ' + (busy ? "codicon-loading codicon-modifier-spin" : "codicon-git-stash") + '" aria-hidden="true"></i>'));
      const text = el("span", "stash-text");
      const msgEl = el("span", "stash-msg");
      msgEl.textContent = s.text;
      const meta = el("span", "stash-meta");
      meta.textContent = stashMeta(s);
      text.append(msgEl, meta);
      row.appendChild(text);
      // Its name for a screen reader: the words, then where, when, how many.
      row.setAttribute("aria-label", s.text + ", " + stashMeta(s));
      row.title = s.message + " — " + new Date(s.time * 1000).toLocaleString();

      // The pointer's buttons, out of the tab order: the keyboard has them
      // in the row's menu (Shift+F10), as a file row's are.
      const actions = el("span", "row-actions");
      const applyBtn = wordBtn("Apply", TIP_APPLY, (ev) => { ev.stopPropagation(); stashAct(s, "apply"); });
      const popBtn = wordBtn("Pop", TIP_POP, (ev) => { ev.stopPropagation(); stashAct(s, "pop"); });
      applyBtn.classList.add("stash-quick");
      applyBtn.dataset.act = "apply";
      popBtn.classList.add("stash-quick");
      popBtn.dataset.act = "pop";
      actions.append(applyBtn, popBtn);
      actions.appendChild(rowBtn('<i class="codicon codicon-ellipsis" aria-hidden="true"></i>',
        "More Actions…", (ev) => { ev.stopPropagation(); openActionMenu(s.text, stashItems(s), row, "git-stash"); }));
      row.appendChild(actions);

      const setOpen = (want) => {
        if (stashOpen.has(s.sha) === want) return;
        // Closed, it opens again at its first page.
        if (want) stashOpen.add(s.sha);
        else { stashOpen.delete(s.sha); stashShown.delete(s.sha); }
        saveStashUi();
        renderStashes();
      };
      const toggle = () => setOpen(!stashOpen.has(s.sha));
      row.addEventListener("click", (ev) => {
        // The second click of a double-click: the first one already toggled.
        if (ev.detail > 1) return;
        if (ev.ctrlKey || ev.metaKey) {
          // Every file of this stash on screen, as a header's Ctrl/Cmd-click
          // selects a group — once they are read, if they are being read.
          ev.preventDefault();
          if (!stashOpen.has(s.sha)) { stashOpen.add(s.sha); saveStashUi(); renderStashes(); }
          if (stashFiles.has(s.sha)) selectStashFiles(s.sha);
          else stashSelectOnRead = s.sha;
          return;
        }
        toggle();
      });
      const menu = (ev) => {
        if (ev) ev.preventDefault();
        openActionMenu(s.text, stashItems(s), row, "git-stash");
      };
      row.addEventListener("contextmenu", menu);
      // The tree's keys: Enter and Space open or close it, Right and Left
      // too, Shift+F10 its menu.
      row.__expand = setOpen;
      row.__activate = toggle;
      row.__menu = menu;
      row.addEventListener("keydown", (ev) => {
        if (ev.target !== row || ev.ctrlKey || ev.metaKey || ev.altKey) return;
        // Delete, and the Mac's delete key, ask to drop it.
        if (ev.key === "Delete" || ev.key === "Backspace") { ev.preventDefault(); stashAct(s, "drop"); }
      });
      // Dragged onto the working tree (or its clean note): Apply (Alt: Pop).
      row.draggable = !busy;
      row.addEventListener("dragstart", (ev) => {
        if (stashPending.has(s.sha)) { ev.preventDefault(); return; }
        beginDrag(ev, { kind: "stash", sha: s.sha }, [row], "");
      });
      row.addEventListener("dragend", endDrag);
      return row;
    }

    /**
     * A stash's folders, in the tree layout: the Changes tree's rows. The
     * last argument is every file of the stash, shown or not: a folder's Move
     * takes all of its files, not only the page on screen.
     */
    function renderStashNode(container, s, node, depth, all) {
      const dirs = Array.from(node.dirs.values()).sort((a, b) => a.name.localeCompare(b.name));
      for (const dir of dirs) {
        const key = "stashfolder:" + s.sha + ":" + dir.path;
        const isCollapsed = collapsed[key] === true;
        const row = el("div", "row stash-folder" + (isCollapsed ? " collapsed" : ""));
        row.style.paddingLeft = (depth * 12) + "px";
        stashItem(row, key, depth + 1);
        row.dataset.sha = s.sha;
        row.setAttribute("aria-expanded", isCollapsed ? "false" : "true");
        row.appendChild(el("span", "twisty", ICON_CHEVRON));
        row.appendChild(el("span", "file-icon folder-icon", ICON_FOLDER));
        const name = el("span", "name");
        name.textContent = dir.name;
        row.appendChild(name);
        row.appendChild(el("span", "spacer"));
        const under = dir.path + "/";
        const insideFiles = all.filter((f) => f.path.indexOf(under) === 0);
        const inside = insideFiles.map((f) => f.path);
        row.setAttribute("aria-label", dir.name + ", folder, " + countWords(inside.length));
        const factions = el("span", "row-actions");
        const moveBtn = wordBtn("Move", tipMove(insideFiles), (ev) => { ev.stopPropagation(); stashFilesAct(s, inside, "move"); });
        const copyBtn = wordBtn("Copy", tipCopy(insideFiles), (ev) => { ev.stopPropagation(); stashFilesAct(s, inside, "copy"); });
        moveBtn.dataset.act = "move";
        copyBtn.dataset.act = "copy";
        factions.append(moveBtn, copyBtn);
        row.appendChild(factions);
        // Dragged onto the working tree (or its clean note): Move its files (Alt: Copy).
        row.draggable = true;
        row.addEventListener("dragstart", (ev) => {
          if (stashPending.has(s.sha)) { ev.preventDefault(); return; }
          beginDrag(ev, { kind: "stashFiles", sha: s.sha, paths: inside.slice() }, [row], inside.join("\n"));
        });
        row.addEventListener("dragend", endDrag);
        const setOpen = (open) => { collapsed[key] = !open; renderStashes(); };
        row.addEventListener("click", () => setOpen(collapsed[key] === true));
        row.__expand = setOpen;
        row.__activate = () => setOpen(collapsed[key] === true);
        // Its button, and Copy beside it, from the keyboard.
        row.__menu = (ev) => {
          if (ev) ev.preventDefault();
          const n = countWords(inside.length);
          openActionMenu(dir.name, [
            { icon: "git-stash-pop", label: "Move " + n + " to Changes", tip: tipMove(insideFiles), fn: () => stashFilesAct(s, inside, "move") },
            { icon: "git-stash-apply", label: "Copy " + n + " to Changes", tip: tipCopy(insideFiles), fn: () => stashFilesAct(s, inside, "copy") },
          ], row, "folder");
        };
        row.addEventListener("contextmenu", row.__menu);
        container.appendChild(row);
        if (!isCollapsed) renderStashNode(container, s, dir, depth + 1, all);
      }
      for (const f of node.files.slice().sort((a, b) => a.name.localeCompare(b.name))) {
        container.appendChild(makeStashFileRow(s, f.entry, f.name, depth));
      }
    }

    /**
     * One file of a stash, as a Changes row: its status letter (U for a file
     * git did not track), its name and folder, "staged" when the stash had it
     * staged. Click opens its diff; the hover action is Move to Changes.
     * fileName is null in the list layout (the folder is shown beside it).
     */
    function makeStashFileRow(s, f, fileName, depth) {
      const letter = f.status;
      const key = stashKey(s.sha, f.path);
      const p = stashPending.get(s.sha);
      const busy = !!(p && p.busyPaths && p.busyPaths.indexOf(f.path) !== -1);
      const row = el("div", "row is-file stash-file " + statusClass(letter) +
        (letter === "D" ? " is-deleted" : "") + (busy ? " is-busy" : ""));
      row.style.paddingLeft = (depth * 12 + 16) + "px";
      stashItem(row, key, depth + 1);
      row.dataset.key = key;
      row.dataset.path = f.path;
      row.dataset.sha = s.sha;
      stashRowOrder.push(key);
      paintRowSelected(row);
      if (busy) row.setAttribute("aria-busy", "true");
      row.title = f.oldPath ? f.path + " (was " + f.oldPath + ")" : f.path;
      row.appendChild(el("span", "file-icon", ICON_FILE));
      const slash = f.path.lastIndexOf("/");
      const name = el("span", "name");
      name.textContent = fileName !== null ? fileName : (slash === -1 ? f.path : f.path.slice(slash + 1));
      row.appendChild(name);
      const dir = fileName !== null ? "" : (slash === -1 ? "" : f.path.slice(0, slash));
      if (dir) {
        const dirEl = el("span", "dir");
        const dirText = document.createElement("bdi");
        dirText.textContent = dir;
        dirEl.appendChild(dirText);
        row.appendChild(dirEl);
      } else {
        row.appendChild(el("span", "spacer"));
      }
      if (f.staged) {
        const w = el("span", "stash-staged");
        w.textContent = f.staged === "all" ? "staged" : "partly staged";
        w.dataset.tip = f.staged === "all"
          ? "Staged when it was stashed: it comes back staged"
          : "Staged, then changed again, when it was stashed: both versions come back";
        row.appendChild(w);
      }
      const actions = el("span", "row-actions");
      const moveBtn = wordBtn("Move", tipMove([f]), (ev) => { ev.stopPropagation(); stashFilesAct(s, [f.path], "move"); });
      const copyBtn = wordBtn("Copy", tipCopy([f]), (ev) => { ev.stopPropagation(); stashFilesAct(s, [f.path], "copy"); });
      moveBtn.dataset.act = "move";
      copyBtn.dataset.act = "copy";
      actions.append(moveBtn, copyBtn);
      row.appendChild(actions);
      const status = el("span", "status " + statusClass(letter));
      status.setAttribute("aria-hidden", "true");
      status.textContent = letter;
      // The staged word gives way at the narrowest widths; its tip keeps it
      // for the pointer, and the row's name below for a screen reader.
      status.dataset.tip = statusTitle(letter) +
        (f.staged === "all" ? ", staged" : f.staged === "part" ? ", partly staged" : "");
      row.appendChild(status);
      // Its name in words — the file, its folder, its change, its staging —
      // rather than the row's text run together ("login.ts src/auth Move to
      // Changes… M"), which lost the staging wherever the word was hidden.
      const folder = slash === -1 ? "" : f.path.slice(0, slash);
      row.setAttribute("aria-label", [
        slash === -1 ? f.path : f.path.slice(slash + 1),
        folder,
        statusTitle(letter).toLowerCase() + (f.oldPath ? " from " + f.oldPath : ""),
        f.staged === "all" ? "staged" : f.staged === "part" ? "partly staged" : "",
      ].filter(Boolean).join(", "));

      const open = () => vscode.postMessage({ type: "stashOpenFile", sha: s.sha, path: f.path });
      const menu = (ev) => {
        if (ev) ev.preventDefault();
        if (selectedRows.size > 0 && !selectedRows.has(key)) clearSelection();
        const sel = stashSelection();
        if (sel && sel.sha === s.sha && selectedRows.has(key) && sel.paths.length > 1) {
          const n = countFiles(sel.paths.length);
          openActionMenu(n + " from “" + s.text + "”", [
            { icon: "git-stash-pop", label: "Move " + n + " to Changes", tip: tipMove(stashFilesOf(s, sel.paths)), fn: () => stashFilesAct(s, sel.paths, "move") },
            { icon: "git-stash-apply", label: "Copy " + n + " to Changes", tip: tipCopy(stashFilesOf(s, sel.paths)), fn: () => stashFilesAct(s, sel.paths, "copy") },
            { sep: true },
            { icon: "close", label: "Clear Selection", fn: clearSelection },
          ], row);
          return;
        }
        const items = [{ icon: "git-compare", label: "Open Changes", fn: open }];
        if (f.staged && !f.onlyStaged) {
          items.push({ icon: "git-compare", label: "Open Staged Changes",
            fn: () => vscode.postMessage({ type: "stashOpenFile", sha: s.sha, path: f.path, staged: true }) });
        }
        items.push({ sep: true });
        items.push({ icon: "git-stash-pop", label: "Move to Changes", tip: tipMove([f]), fn: () => stashFilesAct(s, [f.path], "move") });
        items.push({ icon: "git-stash-apply", label: "Copy to Changes", tip: tipCopy([f]), fn: () => stashFilesAct(s, [f.path], "copy") });
        openActionMenu(name.textContent, items, row);
      };
      row.addEventListener("click", (ev) => {
        if (handleSelectionClick(ev, key)) return;
        if (ev.detail > 1) return;
        open();
      });
      row.addEventListener("dblclick", menu);
      row.addEventListener("contextmenu", menu);
      // The tree's keys: Enter (and Space, as in the split model) open its
      // diff, Shift+F10 its menu.
      row.__activate = open;
      row.__menu = menu;
      // Dragged onto the working tree (or its clean note) — with the files of
      // this stash selected beside it, when it is one of them: Move (Alt: Copy).
      row.draggable = !busy;
      row.addEventListener("dragstart", (ev) => {
        if (stashPending.has(s.sha) || !stashFiles.has(s.sha)) { ev.preventDefault(); return; }
        const sel = stashSelection();
        const many = !!sel && sel.sha === s.sha && selectedRows.has(key);
        const paths = many ? sel.paths.slice() : [f.path];
        const rows = many ? Array.from(stashesEl.querySelectorAll(".row.is-file.is-selected")) : [row];
        beginDrag(ev, { kind: "stashFiles", sha: s.sha, paths: paths }, rows, paths.join("\n"));
      });
      row.addEventListener("dragend", endDrag);
      return row;
    }

    selbarMoveBtn.addEventListener("click", () => {
      const sel = stashSelection();
      const s = sel && authStashes.find((x) => x.sha === sel.sha);
      if (s) stashFilesAct(s, sel.paths, "move");
    });
    selbarCopyBtn.addEventListener("click", () => {
      const sel = stashSelection();
      const s = sel && authStashes.find((x) => x.sha === sel.sha);
      if (s) stashFilesAct(s, sel.paths, "copy");
    });

    // ---- Operation banner ------------------------------------------------
    // A stopped merge / rebase / cherry-pick / revert / am / stash apply, as
    // the host read it from git (OperationProvider, never git's prose). Every
    // string is set as TEXT: branch names and commit subjects are user data.
    // Continue / Skip / Abort lock ALL the banner's buttons on click, until the
    // host says the verb finished ("operationDone") — a second click while its
    // confirm is up must not start a second one.
    const opBanner = $("op-banner");
    let opLocked = false;
    let lastOp = null;
    let lastOpSig = "";
    function opButton(label, cls, onClick, tip, locks) {
      const b = el("button", "gs-commit " + cls);
      b.type = "button";
      // Two faces: the whole verb, and its first word for a narrow banner
      // ("Abort Rebase" / "Abort") — the title above already names the
      // operation. The name is always the whole verb.
      const long = el("span", "lbl-long");
      long.textContent = label;
      const short = el("span", "lbl-short");
      short.textContent = label.split(" ")[0];
      b.appendChild(long);
      b.appendChild(short);
      b.setAttribute("aria-label", label);
      if (tip) b.title = tip;
      b.addEventListener("click", function () {
        if (opLocked) return;
        if (locks) {
          opLocked = true;
          opBanner.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
        }
        onClick();
      });
      return b;
    }
    function renderOpBanner(op, force) {
      const sig = JSON.stringify(op || null);
      if (!force && sig === lastOpSig) return;
      lastOpSig = sig;
      lastOp = op || null;
      opBanner.textContent = "";
      if (!op) { opBanner.hidden = true; return; }
      // Its tone and icon are the host's: amber while something is in the
      // way, the accent once nothing is (a pause, or every conflict resolved).
      opBanner.className = "op-banner tone-" + (op.tone || "attention");
      const title = el("div", "op-title");
      const icon = el("i", "codicon codicon-" + (op.icon || "warning"));
      icon.setAttribute("aria-hidden", "true");
      title.appendChild(icon);
      const titleText = el("span");
      titleText.textContent = op.title;
      title.appendChild(titleText);
      opBanner.appendChild(title);
      if (op.step) {
        const st = el("div", "op-step");
        st.textContent = op.step;
        opBanner.appendChild(st);
      }
      if (op.direction) {
        const d = el("div", "op-direction");
        d.textContent = op.direction;
        opBanner.appendChild(d);
      }
      if (op.note) {
        const n = el("div", "op-note");
        n.textContent = op.note;
        opBanner.appendChild(n);
      }
      const acts = el("div", "op-actions");
      // The lead action — the one this stop is waiting for — gets a row of
      // its own when the banner is too narrow for every button side by side.
      if (op.conflicts > 0) {
        acts.appendChild(opButton("Resolve Conflicts…", "primary op-lead", function () {
          vscode.postMessage({ type: "resolveConflicts" });
        }, "", false));
      }
      if (op.continueLabel) {
        const lead = !(op.conflicts > 0) && op.canContinue;
        const c = opButton(op.continueLabel, lead ? "primary op-lead" : "split", function () {
          vscode.postMessage({ type: "operation", verb: "continue" });
        }, op.continueBlocked || "", true);
        c.disabled = !op.canContinue;
        acts.appendChild(c);
      }
      if (op.skipLabel) {
        acts.appendChild(opButton(op.skipLabel, "split", function () {
          vscode.postMessage({ type: "operation", verb: "skip" });
        }, "", true));
      }
      acts.appendChild(opButton(op.abortLabel, "split", function () {
        vscode.postMessage({ type: "operation", verb: "abort" });
      }, "", true));
      opBanner.appendChild(acts);
      if (opLocked) {
        opBanner.querySelectorAll("button").forEach(function (x) { x.disabled = true; });
      }
      opBanner.hidden = false;
      fitOpActions();
    }
    /**
     * Every button side by side when they fit; otherwise the lead action on a
     * row of its own and the rest sharing one row by their first word
     * ("Continue", "Skip", "Abort"). At a sidebar's width the buttons used to
     * wrap into three rows. Measured at the width they want (max-content),
     * not the width a flex row has already squeezed them to.
     */
    function fitOpActions() {
      const acts = opBanner.querySelector(".op-actions");
      if (!acts || opBanner.hidden || !acts.classList) return;
      acts.classList.remove("stacked");
      const avail = acts.clientWidth;
      if (!avail) return;
      const was = acts.style.width;
      acts.style.width = "max-content";
      const need = acts.offsetWidth;
      acts.style.width = was;
      acts.classList.toggle("stacked", need > avail + 0.5);
    }
    if (typeof ResizeObserver === "function") {
      let lastOpWidth = 0;
      new ResizeObserver(function (entries) {
        const w = Math.round(entries[0].contentRect.width);
        if (w === lastOpWidth) return;
        lastOpWidth = w;
        fitOpActions();
      }).observe(opBanner);
    }

    // ---- Host messages ---------------------------------------------------
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "dialog") {
        // A host-side command needs an answer. It is awaiting our
        // "dialogResult" reply, so every close path must post exactly once —
        // closeDialog() owns that, and openDialog claims the id in the right
        // order (see startDialog).
        openDialog(msg.spec, msg.dialogId);
        return;
      }
      if (msg.type === "openBranchMenu") {
        // The status bar asked for the branch UI. This is the same menu the
        // branch pill opens — one branch surface, not a second one that has to
        // be kept in step with it.
        //
        // Take focus first, so the menu is usable from the keyboard the moment
        // it appears — the request came from the status bar, so focus is not in
        // this webview yet.
        window.focus();
        branchPill.focus();
        openBranchMenu();
        return;
      }
      if (msg.type === "hunks") {
        const rows = msg.hunks || [];
        const had = hunkCache.get(msg.path);
        hunkCache.set(msg.path, rows);
        // Everything in this file is now staged: fold it back. The file is
        // finished, so leaving it open is a panel of ticked boxes taking up the
        // list. It stays expandable, so reopening to untick is one click away —
        // this is a deliberate collapse, not the contents disappearing.
        const allStaged =
          rows.length > 0 && rows.every(function (h) { return h.state === "staged"; });
        const wasIncomplete =
          !had || had.some(function (h) { return h.state !== "staged"; });
        if (allStaged && wasIncomplete) {
          // The file folds away — that IS a structural change, so a full
          // render is the honest thing to do (and it is rare).
          expandedHunks.delete(msg.path);
          hunkPanels.delete(msg.path);
          render();
          return;
        }
        // Otherwise only this one panel's contents changed. Swap it and leave
        // every other row, the scroll position and the focus exactly alone.
        const refresh = hunkPanels.get(msg.path);
        if (refresh && refresh()) {
          return;
        }
        render();
        return;
      }
      if (msg.type === "state") {
        setBusy(!!msg.busy);
        stateSeen = true;
        // No repository YET (discovery still running) is not "none": keep
        // the reading state up, and say what it is doing.
        const discovering = !msg.hasRepo && !!msg.discovering;
        document.body.classList.toggle("no-repo", !msg.hasRepo && !discovering);
        document.body.classList.toggle("discovering", discovering);
        loadingEl.classList.toggle("visible", discovering);
        if (discovering) loadingText.textContent = "Looking for a repository…";
        renderHeader(msg);
        renderOpBanner(msg.hasRepo ? msg.operation : undefined);
        generateBtn.classList.toggle("visible", !!msg.aiEnabled);
        reviewBtn.classList.toggle("visible", !!msg.aiEnabled);
        // Not while the user has turned AI off: that plug invited them to
        // connect what they had just switched off.
        connectAiBtn.classList.toggle("visible", !msg.aiEnabled && !msg.aiOff);
        if (msg.layout && msg.layout !== layout) {
          layout = msg.layout;
          applyLayoutClass();
        }
        // Fold the authoritative git state in under any still-pending optimistic
        // moves, so a reconcile never snaps a just-clicked row back mid-flight.
        authState = {
          merge: msg.merge || [],
          staged: msg.staged || [],
          unstaged: msg.unstaged || [],
        };
        reconcilePending(authState);
        lastState = applyPending(authState);
        stagedCount = lastState.staged.length;
        // From the MESSAGE, not from lastState: applyPending() rebuilds lastState
        // out of the three file lists, so anything else on the payload is dropped.
        stagingModel = msg.stagingModel || "split";
        applyModelToggleLabel();
        const wasLoading = branchesLoading;
        branchData = applyPendingFavorites(msg.branches) || { local: [], remote: [], recent: [], tags: [] };
        branchesLoading = !!msg.hasRepo && !msg.branches;
        // The branches arrived after something was typed: the width to hold
        // is the whole list's, not that of what the query shows.
        if (branchMenu && wasLoading && !branchesLoading && branchFilter) holdWholeListWidth();
        // Only rebuild an OPEN branch menu when the branch data actually
        // changed. Every state push (and now the redundant 2nd post) would
        // otherwise call renderBranchMenu(), which closeBranchSubmenu()s and
        // replaceChildren()s — wiping a submenu the user just opened and
        // resetting the scroll position. refreshOpenBranchUi re-opens the
        // same branch's submenu on its fresh row, so the stack survives.
        // Loading is part of it: a repository that really has no branches
        // yet answers with the same empty lists the loading menu holds. So
        // is a detached HEAD, which takes Pull and Push away.
        const branchSig = bmSig();
        if (branchMenu && branchSig !== lastBranchSig) refreshOpenBranchUi();
        lastBranchSig = branchSig;
        if (typeof msg.lastMessage === "string" && amend.checked &&
            message.value.trim() === "") {
          message.value = msg.lastMessage;
          autoGrow();
          updateComposer();
        }
        if (msg.signoffDefault && !signoff.dataset.touched) {
          signoff.checked = true;
        }
        renderCount();
        renderIfChanged();
        // The stash list: absent means "not read yet, keep what is shown".
        if (Array.isArray(msg.stashes)) {
          takeStashList(msg.stashes);
          reconcileStashPending();
        }
        renderStashesIfChanged();
      } else if (msg.type === "stashFilesRead") {
        // The files of a stash the list carried as a count, read when it opened.
        stashReading.delete(msg.sha);
        if (Array.isArray(msg.files)) stashFiles.set(msg.sha, msg.files);
        else stashUnreadable.add(msg.sha);
        renderStashes();
        if (stashSelectOnRead === msg.sha) {
          stashSelectOnRead = null;
          if (stashFiles.has(msg.sha)) selectStashFiles(msg.sha);
        }
      } else if (msg.type === "stashPending") {
        // Drop's confirm or Create Branch's name was answered: the row leaves
        // now, before git has run, and comes back if it did not happen.
        stashPending.set(msg.sha, { remove: true, at: Date.now() });
        renderStashes();
      } else if (msg.type === "stashDone") {
        const o = msg.outcome || { kind: "kept" };
        const p = stashPending.get(msg.sha);
        // What is left of a stash after a move is a new sha where it was:
        // it stays open if it was, as many of its files shown, and its files
        // are the stash's less the ones moved — nothing to read again.
        if (o.kind === "done" && o.rest) {
          const had = stashFiles.get(msg.sha);
          if (had && Array.isArray(msg.paths)) {
            const moved = new Set(msg.paths);
            stashFiles.set(o.rest, had.filter((f) => !moved.has(f.path)));
            stashSeeded.add(o.rest);
          }
          if (stashShown.has(msg.sha)) stashShown.set(o.rest, stashShown.get(msg.sha));
          if (stashOpen.has(msg.sha)) {
            stashOpen.delete(msg.sha);
            stashOpen.add(o.rest);
            saveStashUi();
          }
        }
        if (p) {
          if (o.kind === "gone") {
            p.remove = true; p.busy = false; p.busyPaths = null; p.at = Date.now();
          } else if (o.kind === "done" && (p.remove || p.moved)) {
            // Gone from the list once the host's next list agrees (reconcile).
            p.at = Date.now();
          } else {
            // Applied or copied — or it did not happen: back as it was.
            stashPending.delete(msg.sha);
          }
        }
        renderStashes();
      } else if (msg.type === "branchActionDone") {
        // A sync op finished — clear every in-flight face (the fresh counts
        // arrived via the state push the host sent just before this).
        if (msg.action === "pull" || msg.action === "pullMerge" || msg.action === "pullRebase" || msg.action === "push") {
          syncBusy = "";
          // Re-derive pill visibility from the last real counts — the busy
          // face force-showed the pill, which must not linger at count 0.
          if (lastHeaderState) renderHeader(lastHeaderState);
          else applySyncBusy();
        }
        if (menuSyncBusy === msg.action) menuSyncBusy = "";
        if (subLive && subLive.action === msg.action) subLive = null;
        // Repaint the open dialog stack in place: fresh badges + labels, and
        // the submenu (if one is up) rebuilt for the same branch.
        refreshOpenBranchUi();
      } else if (msg.type === "setMessage") {
        if (typeof msg.text === "string") {
          message.value = msg.text; autoGrow(); updateComposer();
        }
      } else if (msg.type === "pushPreview") {
        openPushModal(msg);
      } else if (msg.type === "pushCommitFiles") {
        // A commit in the push review opened: its own files.
        var item = pushModal && Array.prototype.find.call(
          pushModal.querySelectorAll(".cr-commit-item"),
          function (n) { return n.dataset.sha === msg.sha; });
        if (item && window.GsChangeRows) window.GsChangeRows.setCommitFiles(item, msg.files || null);
      } else if (msg.type === "pushDone") {
        if (msg.ok) closePushModal();
        else pushModalError(msg.error);
      } else if (msg.type === "commitDone") {
        // Commit finished (ok or not) — clear the in-button spinner. A successful
        // Commit & Push then opens the review modal via a separate pushPreview.
        clearCommitBusy();
      } else if (msg.type === "opFailed") {
        // git refused a stage / unstage / discard: put the rows it moved back
        // now, rather than leaving them where they were dropped until the
        // optimistic move times out. The host has already said why.
        const failed = msg.paths || [];
        for (let i = 0; i < failed.length; i++) pending.delete(failed[i]);
        applyOptimistic();
      } else if (msg.type === "generateDone") {
        setGenerating(false);
      } else if (msg.type === "operationDone") {
        opLocked = false;
        renderOpBanner(lastOp, true);
      } else if (msg.type === "clear") {
        message.value = "";
        amend.checked = false;
        author.value = "";
        authorRow.classList.add("hidden");
        authorToggle.setAttribute("aria-expanded", "false");
        autoGrow();
        updateComposer();
        renderCount();
      }
    });

    // ---- Reliable tooltips ------------------------------------------------
    // Native title tooltips are unreliable inside webviews. Move every title
    // onto data-tip and render ONE shared, viewport-positioned tooltip so it is
    // never clipped by a scrolling/overflow ancestor and always appears.
    const tipEl = document.createElement("div");
    tipEl.className = "gs-tip";
    tipEl.setAttribute("aria-hidden", "true");
    document.body.appendChild(tipEl);
    let tipTarget = null;
    let tipTimer = 0;
    function upgradeTips(node) {
      if (!node || node.nodeType !== 1) return;
      if (node.hasAttribute && node.hasAttribute("title")) moveTitle(node);
      if (node.querySelectorAll) node.querySelectorAll("[title]").forEach(moveTitle);
    }
    /**
     * A title moves into data-tip (the view draws its own tooltip) WITHOUT
     * taking the accessible name along: the title is what named every tick
     * and icon-only button, and deleting it left them nameless to a screen
     * reader. What it gave stays in ARIA — the name of an element with no
     * text of its own (a tick, an icon button), else the description. A name
     * the element carries itself is kept; the tip becomes its description.
     */
    function moveTitle(c) {
      const tip = c.getAttribute("title");
      c.dataset.tip = tip;
      c.removeAttribute("title");
      const ownName = c.hasAttribute("aria-labelledby") ||
        (c.hasAttribute("aria-label") && c.dataset.tipNamed !== "1");
      const namedByText = !/^(INPUT|SELECT|TEXTAREA)$/.test(c.tagName) && c.textContent.trim() !== "";
      if (ownName || namedByText) {
        if (tip !== c.getAttribute("aria-label")) c.setAttribute("aria-description", tip);
        return;
      }
      c.setAttribute("aria-label", tip);
      c.dataset.tipNamed = "1";
    }
    function hideTip() { clearTimeout(tipTimer); tipTarget = null; tipEl.classList.remove("show"); }
    /**
     * Whether a tip says something the element does not already show: other
     * words (an icon button's name, a folder, an explanation), or its own
     * words while some of them are cut off. A tip repeating a label that is
     * there in full ("Copy Branch Name" over Copy Branch Name) is noise.
     */
    function tipAdds(t, text) {
      const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();
      const tip = norm(text);
      const shown = norm(t.innerText);
      if (!shown) return true;
      const cut = (n) => n.scrollWidth > n.clientWidth + 1 && getComputedStyle(n).overflowX !== "visible";
      const all = [t].concat(Array.prototype.slice.call(t.querySelectorAll("*")));
      if (tip === shown) return all.some(cut);
      // A row's own words, each shown in full on its own: a file's name, its
      // folder. A tip that is one of them ("README.md" over README.md), or a
      // path that is the folder and the name both there in full, repeats
      // them; one that is cut short is still worth its tip.
      const whole = new Set();
      for (let i = 1; i < all.length; i++) {
        const n = all[i];
        if (!n.getClientRects().length || getComputedStyle(n).visibility === "hidden") continue;
        let clipped = false;
        for (let a = n; a && !clipped; a = a === t ? null : a.parentElement) clipped = cut(a);
        if (!clipped) whole.add(norm(n.innerText));
      }
      if (whole.has(tip)) return false;
      const slash = tip.lastIndexOf("/");
      return !(slash > 0 && whole.has(tip.slice(slash + 1)) && whole.has(tip.slice(0, slash)));
    }
    function showTip() {
      // The hovered node can be swapped out by a live dialog repaint before
      // the delay fires — a tip for a detached node would float orphaned.
      if (!tipTarget || !tipTarget.isConnected) { hideTip(); return; }
      const text = tipTarget.getAttribute("data-tip");
      if (!text || !tipAdds(tipTarget, text)) return;
      tipEl.textContent = text;
      tipEl.classList.add("show");
      // Grow to the full single-line width, and ONLY wrap when that width
      // exceeds the viewport. The tip is position fixed, so an auto width is a
      // shrink-to-fit; reset left to 0 first so the measurement sees the whole
      // viewport (a stale left from the previous tip would narrow it). With
      // white-space nowrap, offsetWidth is the TRUE single-line width.
      const avail = window.innerWidth - 12;
      tipEl.style.left = "0px";
      tipEl.style.right = "auto";
      tipEl.style.whiteSpace = "nowrap";
      tipEl.style.wordBreak = "normal";
      tipEl.style.overflowWrap = "normal";
      tipEl.style.width = "auto";
      tipEl.style.maxWidth = "none";
      if (tipEl.offsetWidth > avail) {
        // Genuinely too wide for the panel — wrap. A name (a path, a branch)
        // breaks anywhere, so each line fills COMPLETELY and the remainder
        // just overflows to the next row, instead of break-word snapping at
        // the last hyphen and leaving a ragged gap on line 1 (which reads as
        // "there's still room, why did it wrap?"). Words in a sentence wrap
        // between them: "as it w / as stashed" read as broken.
        const sentence = /\s/.test(text.trim());
        tipEl.style.whiteSpace = "normal";
        tipEl.style.wordBreak = sentence ? "normal" : "break-all";
        tipEl.style.overflowWrap = sentence ? "anywhere" : "normal";
        tipEl.style.width = avail + "px";
        tipEl.style.maxWidth = avail + "px";
      }
      const r = tipTarget.getBoundingClientRect();
      const tw = tipEl.offsetWidth;
      let left = r.left + r.width / 2;
      left = Math.max(tw / 2 + 5, Math.min(window.innerWidth - tw / 2 - 5, left));
      let top = r.top - 6;
      tipEl.classList.toggle("below", top - tipEl.offsetHeight < 2);
      if (top - tipEl.offsetHeight < 2) top = r.bottom + 6;
      tipEl.style.left = Math.round(left) + "px";
      tipEl.style.top = Math.round(top) + "px";
    }
    document.addEventListener("pointerover", (e) => {
      const t = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (t === tipTarget) return;
      hideTip();
      if (t) { tipTarget = t; tipTimer = setTimeout(showTip, 350); }
    });
    document.addEventListener("pointerout", (e) => {
      const t = e.target.closest ? e.target.closest("[data-tip]") : null;
      if (t && t === tipTarget) hideTip();
    });
    document.addEventListener("pointerdown", hideTip);
    window.addEventListener("scroll", hideTip, true);
    // The keyboard gets the tip too: a button reached with Tab says what it
    // does, as it does under the pointer. Not the tree's rows — their name is
    // read out, and a tip over the next row at every arrow press is noise.
    document.addEventListener("focusin", (e) => {
      const t = e.target;
      if (!t || !t.getAttribute || !t.getAttribute("data-tip")) return;
      if (t.getAttribute("role") === "treeitem") return;
      let keyboard = false;
      try { keyboard = t.matches(":focus-visible"); } catch (_) { keyboard = false; }
      if (!keyboard) return;
      hideTip();
      tipTarget = t;
      tipTimer = setTimeout(showTip, 350);
    });
    document.addEventListener("focusout", (e) => {
      if (e.target === tipTarget) hideTip();
    });
    upgradeTips(document.body);
    new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach(upgradeTips);
        if (m.type === "attributes" && m.target.getAttribute("title")) upgradeTips(m.target);
      }
    }).observe(document.body, {
      subtree: true, childList: true, attributes: true, attributeFilter: ["title"],
    });

    applyLayoutClass();
    renderCount();
    updateComposer();
    render();
    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }

  dispose(): void {
    this.pushTarget?.release();
    this.pushTarget = undefined;
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** A staging op's `{ ok: false, stderr }`: git refused it. */
function isRefusal(result: unknown): result is { ok: false; stderr: string } {
  return (
    typeof result === "object" &&
    result !== null &&
    (result as { ok?: unknown }).ok === false &&
    typeof (result as { stderr?: unknown }).stderr === "string"
  );
}

/**
 * Why some files were not staged: they are unmerged and still carry conflict
 * markers. The one-file sentence is the desktop app's Stage refusal, word for
 * word, so the same refusal reads the same in both.
 */
function markedConflictsMessage(held: string[], stagedTheRest: boolean): string {
  if (held.length === 1 && !stagedTheRest) {
    return (
      `${held[0]} still contains conflict markers. Staging it would mark the conflict ` +
      "resolved and commit the markers — resolve them first."
    );
  }
  const head = held.slice(0, 3).join(", ");
  const list = held.length > 3 ? `${head} and ${held.length - 3} more` : head;
  const count = held.length === 1 ? "1 file still contains" : `${held.length} files still contain`;
  return (
    (stagedTheRest ? "Staged everything else. " : "") +
    `${count} conflict markers (${list}) — staging a file with markers in it tells git ` +
    "the conflict is settled. Resolve them first."
  );
}

/** "src/a.ts", or "3 files" — what a failed stage/unstage/discard was about. */
function describePaths(paths: string[]): string {
  if (paths.length === 1) return paths[0];
  if (paths.length === 0) return "the changes";
  return `${paths.length} files`;
}

/**
 * What a discard does, in words that match what git does.
 *
 * `git checkout -- <file>` restores from the INDEX, not from HEAD: a file with
 * staged edits keeps them. The old sentence ("goes back to its committed
 * state") was only true for files with nothing staged. An untracked file is
 * deleted (`git clean`), which is its own sentence.
 */
function discardConsequence(files: FileEntry[], partlyStaged: number): string {
  const untracked = files.filter((f) => f.status === "U").length;
  const tracked = files.length - untracked;
  const gone = "These edits were never committed, so nothing — not even Undo — can bring them back.";
  if (files.length === 1) {
    if (untracked === 1) {
      return "The file is deleted. Git has never tracked it, so nothing — not even Undo — can bring it back.";
    }
    return partlyStaged === 1
      ? `Its unstaged edits are lost; the part you staged stays staged. ${gone}`
      : `The file goes back to its committed version. ${gone}`;
  }
  const parts: string[] = [];
  if (tracked > 0) {
    parts.push(
      partlyStaged > 0
        ? `Unstaged edits are lost; ${partlyStaged === 1 ? "the file that has staged changes keeps them" : `the ${partlyStaged} files that have staged changes keep them`}.`
        : tracked === 1
          ? "The changed file goes back to its committed version."
          : `All ${tracked} changed files go back to their committed version.`,
    );
  }
  if (untracked > 0) {
    parts.push(untracked === 1 ? "The untracked file is deleted." : `The ${untracked} untracked files are deleted.`);
  }
  parts.push(gone);
  return parts.join(" ");
}

/** Find the Change whose repo-relative path matches `path`. */
function findIn(
  changes: Change[],
  root: string,
  path: string,
): Change | undefined {
  return changes.find((c) => relativePath(root, c.uri.fsPath) === path);
}
