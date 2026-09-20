import * as vscode from "vscode";
import { computeGraphLayout } from "@gitstudio/engine/graph/layout";
import type { GraphInputCommit } from "@gitstudio/engine/graph/layout";
import type { CommitRecord, GitRef } from "@gitstudio/git-service/index";
import { UNCOMMITTED_SHA } from "@gitstudio/git-service/index";
import type {
  GraphHostMessage,
  GraphWebviewMessage,
  GraphRefEntry,
  GraphRefFilter,
  WireRow,
  WireRef,
  RowStat,
} from "@gitstudio/host-bridge/graphProtocol";
import type {
  CommitDetailsPayload,
  CommitFileChange,
} from "@gitstudio/host-bridge/commitDetailsProtocol";
import { buildWireRows } from "@gitstudio/host-bridge/graphWire";
import {
  chipRefsUnderFilter,
  normalizeRefFilter,
  refEntries,
  sameRefFilter,
} from "@gitstudio/host-bridge/graphRefFilter";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { getGraphHtml, getNonce } from "./graphHtml";
import { getAuthorAvatarResolver } from "./authorAvatars";
import { getRefFilterStore } from "./refFilterStore";
import { commitMenuItems, refActionId, refMenuItems, runCommitAction } from "./commitActions";
import { readRewritableChain } from "@gitstudio/git-service/rebaseChain";
import { buildRebasePlan } from "@gitstudio/git-service/rebasePlan";
import { runRebasePlan, isRebaseInProgress } from "../rebase/rebaseRunner";
import { promptPick } from "../ui/dialogs";
import { openRevisionDiff } from "../history/revisionContentProvider";
import { commitWebUrl } from "../util/remoteUrl";
import { relativePath, statusLetter } from "../changes/changesView";
import type { Change } from "../git/git";

/** git's canonical empty-tree object — the "parent" of a root commit's diff. */
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Map the details-panel action ids to runCommitAction's ids. */
const ACTION_ID_MAP: Record<string, string> = {
  "checkout": "checkout",
  "branch": "branch",
  "tag": "tag",
  "cherry-pick": "cherryPick",
  "revert": "revert",
  "reset": "reset",
  "copy-sha": "copySha",
};

/** Commits per page. The first page lands fast; more stream in on scroll. */
const PAGE_SIZE = 500;
// The FIRST page is deliberately small so the graph paints fast on open (a
// 500-commit log + full lane layout was the bulk of the first-paint cost);
// deeper history streams in via loadMore as you scroll.
const FIRST_PAGE_SIZE = 150;
/** Debounce repo-change rebuilds (a rebase touches many refs in a burst). */
const REFRESH_DEBOUNCE_MS = 300;
/** Shas per `git log --numstat` spawn when the graph asks for row stats. */

/**
 * The singleton commit-graph panel: one editor-area WebviewPanel that streams
 * `git log --all`, lays it out with the engine, decorates rows with ref chips,
 * pages on scroll, and rebuilds (debounced) when the active repo changes.
 */
export class CommitGraphPanel {
  private static current: CommitGraphPanel | undefined;
  private static currentPanel: vscode.WebviewPanel | undefined;

  /** True while the graph panel exists. */
  static get isOpen(): boolean {
    return CommitGraphPanel.currentPanel !== undefined;
  }


  /**
   * Open (or focus) the Commit Graph. `column` lets callers put it *beside* the
   * code instead of over it — what a blame-annotation reveal wants, so the file
   * and the commit stay on screen together.
   */
  static show(
    repos: RepoManager,
    extensionUri: vscode.Uri,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): void {
    if (CommitGraphPanel.currentPanel) {
      // Already open: focus it where it is rather than moving the user's layout.
      CommitGraphPanel.currentPanel.reveal(undefined, true);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitstudio.commitGraph",
      "Commit Graph",
      { viewColumn: column, preserveFocus: true },
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    CommitGraphPanel.currentPanel = panel;
    const host = new CommitGraphPanel(panel.webview, repos, extensionUri);
    CommitGraphPanel.current = host;
    panel.onDidDispose(() => {
      host.dispose();
      if (CommitGraphPanel.current === host) {
        CommitGraphPanel.current = undefined;
      }
      CommitGraphPanel.currentPanel = undefined;
    });
  }

  /**
   * Attach a graph host to an arbitrary webview — used by the Commits sidebar
   * view, which renders the SAME graph inline. The caller owns the returned
   * instance's lifecycle (call dispose() when its view goes away).
   */
  static forView(
    webview: vscode.Webview,
    repos: RepoManager,
    extensionUri: vscode.Uri,
    opts?: { sidebar?: boolean; layout?: "dock" | "side" },
  ): CommitGraphPanel {
    return new CommitGraphPanel(
      webview,
      repos,
      extensionUri,
      !!opts?.sidebar,
      opts?.layout ?? "dock",
    );
  }

  /**
   * Open (or focus) the graph, then select + reveal a commit and its details.
   *
   * @deprecated The editor-tab graph is superseded by the bottom-panel graph
   * (`gitstudio.commitPanel`), which shows the graph and the commit details
   * side by side without consuming an editor tab. Prefer the
   * `gitstudio.revealCommitInGraph` command. Retained so an existing keybinding
   * or a pinned editor tab keeps working.
   */
  static revealCommit(
    repos: RepoManager,
    extensionUri: vscode.Uri,
    sha: string,
    column: vscode.ViewColumn = vscode.ViewColumn.Active,
  ): void {
    CommitGraphPanel.show(repos, extensionUri, column);
    CommitGraphPanel.current?.reveal(sha);
  }

  private readonly disposables: vscode.Disposable[] = [];
  private loadController: AbortController | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Rows already sent to the webview (for sha→record action lookups). */
  private records = new Map<string, CommitRecord>();
  /** All loaded input commits (for incremental relayout on append). */
  private loaded: GraphInputCommit[] = [];
  private refsBySha = new Map<string, GitRef[]>();
  /** Every ref of the last loadRefs, for the picker and for pruning. */
  private refs: GitRef[] = [];
  /** False when that listing threw or found nothing — then `refs` is not the
   *  repository's list, and must not prune a stored selection (see loadInitial). */
  private refsListed = false;
  private refList: GraphRefEntry[] = [];
  /**
   * The branch filter the loaded pages were walked with (issue #30) — pruned
   * against the refs that existed at load time, null for everything. Stored
   * per repository in the RefFilterStore; this is the applied copy.
   */
  private refFilter: GraphRefFilter = null;
  private hasAnyRemote = false;
  private currentHeadSha = "";
  private nextSkip = 0;
  private hasMore = false;
  private ready = false;
  /** True once a graphInit with real rows has reached the webview. */
  private initialized = false;
  /**
   * The commit THIS surface is currently showing — updated when the host
   * reveals one and when the user selects one inside the graph. Callers dedupe
   * against this live value rather than remembering what they last asked for,
   * which goes stale the moment the graph moves on.
   */
  private shown: string | undefined;
  /** Mirrors the webview's details-dock visibility (see detailsOpen). */
  private detailsVisible = false;
  private repoRoot: string | undefined;
  /** A sha to reveal once the first page is loaded (from the Commits view). */
  private pendingReveal: string | undefined;

  private constructor(
    private readonly webview: vscode.Webview,
    private readonly repos: RepoManager,
    private readonly extensionUri: vscode.Uri,
    /** Sidebar mode: loads the compact <gitstudio-commit-rail> bundle. */
    private readonly sidebar = false,
    /** Full-surface split axis: details docked under, or beside, the graph. */
    private readonly layout: "dock" | "side" = "dock",
  ) {
    const nonce = getNonce();
    webview.html = getGraphHtml(
      webview,
      extensionUri,
      nonce,
      sidebar ? "graph-sidebar" : "graph",
      this.layout,
    );

    this.disposables.push(
      webview.onDidReceiveMessage((msg: GraphWebviewMessage) =>
        this.onMessage(msg),
      ),
      this.repos.onDidChange(() => this.scheduleRefresh()),
    );
    // The branch filter is one selection per repository, shared by every graph
    // surface in the window. A change made in the Commits sidebar has to reach
    // the bottom panel too — and the surface that made it reloads through this
    // same event, so a change has one path to a reload.
    const store = getRefFilterStore();
    if (store) {
      const off = store.onDidChange((root) => {
        if (root === this.repoRoot && this.ready) void this.loadInitial();
      });
      this.disposables.push({ dispose: off });
    }
  }

  // ── Webview messages ───────────────────────────────────────────────────────

  private onMessage(msg: GraphWebviewMessage): void {
    switch (msg.type) {
      case "ready":
        this.ready = true;
        void this.loadInitial();
        break;
      case "loadMore":
        void this.loadMore();
        break;
      case "refresh":
        void this.loadInitial();
        break;
      case "reorderCommits":
        void this.reorderCommits(msg.order, msg.updateRefs);
        break;
      case "selectCommit":
      case "openCommit":
        this.shown = msg.sha;
        void this.pushCommitDetails(msg.sha);
        break;
      case "contextMenu":
        this.openCommitMenu(msg.sha, msg.x, msg.y);
        break;
      case "action":
        this.openCommitMenu(msg.sha, -1, -1);
        break;
      case "commitMenuAction":
        void this.runCommitMenuAction(msg.sha, msg.id);
        break;
      case "openFile":
        void this.doOpenFile(msg.sha, msg.path, !!msg.wip);
        break;
      case "commitAction":
        void this.doCommitAction(msg.action, msg.sha);
        break;
      case "copyText":
        void this.doCopy(msg.text);
        break;
      case "requestStats":
        void this.pushRowStats(msg.shas);
        break;
      case "requestContains":
        void this.pushContains(msg.sha);
        break;
      case "detailsVisibility":
        this.detailsVisible = msg.open;
        break;
      case "setRefFilter":
        void this.setRefFilter(msg.refs);
        break;
      case "checkoutRef":
        // The chip menu's "Checkout <ref>": the same arm, with the same
        // questions, as the commit menu's item of that name.
        void this.runCommitMenuAction(msg.sha, refActionId(msg.kind, msg.name));
        break;
      case "openInGraph":
        // Sidebar rail → promote into the BOTTOM PANEL graph (the split view
        // beside the terminal), which supersedes the old editor-tab graph.
        void vscode.commands.executeCommand("gitstudio.revealCommitInGraph", msg.sha);
        break;
    }
  }

  private post(message: GraphHostMessage): void {
    void this.webview.postMessage(message);
  }

  /** Best-effort: resolve real author photos and push them to the webview to
   * replace the Gravatar/initials placeholders. Never blocks or fails the graph
   * — no resolver, no GitHub connection, or a network error just leaves the
   * placeholders in place. */
  private async loadAuthorAvatars(
    active: RepoEntry,
    signal: AbortSignal,
  ): Promise<void> {
    const resolver = getAuthorAvatarResolver();
    if (!resolver) {
      return;
    }
    try {
      const avatars = await resolver.resolve(active);
      if (signal.aborted || active.root !== this.repoRoot) {
        return;
      }
      if (Object.keys(avatars).length > 0) {
        this.post({ type: "authorAvatars", avatars });
      }
    } catch {
      /* best-effort — placeholders remain */
    }
  }

  // ── Loading & layout ───────────────────────────────────────────────────────

  private scheduleRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.ready) {
        void this.loadInitial();
      }
    }, REFRESH_DEBOUNCE_MS);
  }

  /** Fresh first page: resets all state and reposts a full graphInit. */
  private async loadInitial(): Promise<void> {
    this.loadController?.abort();
    const controller = new AbortController();
    this.loadController = controller;

    const active = this.repos.getActive();
    if (!active) {
      this.records.clear();
      this.loaded = [];
      this.refsBySha.clear();
      this.refs = [];
      this.refList = [];
      this.refFilter = null;
      this.nextSkip = 0;
      this.hasMore = false;
      this.post({
        type: "graphInit",
        rows: [],
        head: "",
        totalColumns: 1,
        hasMore: false,
        refFilter: null,
        refList: [],
      });
      return;
    }

    this.repoRoot = active.root;
    this.records.clear();
    this.loaded = [];
    this.nextSkip = 0;
    // Rows in the webview are about to be replaced — until the new graphInit
    // lands, a reveal has nothing to select and must queue (see reveal()).
    this.initialized = false;

    try {
      const store = getRefFilterStore();
      const wanted = store ? store.get(active.root) : this.refFilter;
      let page: GraphInputCommit[];
      if (wanted) {
        // A filter names refs, and a remembered ref can be gone by now. The
        // ref list is what prunes it, so under a filter the refs come FIRST
        // and the log walks the pruned set — a page walked against the stored
        // list and a trigger describing the pruned one would disagree the one
        // time it matters (every remembered ref deleted: the walk would show
        // HEAD alone under a label saying "All branches").
        await this.loadRefs(active);
        if (controller.signal.aborted) {
          return;
        }
        if (this.refsListed) {
          this.refFilter = normalizeRefFilter(wanted, this.refs);
          if (store && !sameRefFilter(this.refFilter, wanted)) {
            // Dropped silently, and forgotten silently: no change event, this
            // load is already the reload.
            void store.set(active.root, this.refFilter, { silent: true });
          }
        } else {
          // The listing threw or found nothing, so there is no list to prune
          // against — an empty one prunes EVERY remembered ref, and writing
          // that back turned one failed for-each-ref into a forgotten
          // selection. Applied as stored (the walk's --ignore-missing takes a
          // gone ref); the store keeps its value for a load that can prune.
          this.refFilter = wanted;
        }
        page = await this.readPage(active, 0, controller.signal, FIRST_PAGE_SIZE);
      } else {
        this.refFilter = null;
        // Refs (for-each-ref + stash) and the first log page run CONCURRENTLY —
        // refs no longer block the log spawn. buildRows needs both, but they
        // land together.
        [, page] = await Promise.all([
          this.loadRefs(active),
          this.readPage(active, 0, controller.signal, FIRST_PAGE_SIZE),
        ]);
      }
      if (controller.signal.aborted) {
        return;
      }
      this.loaded = page;
      this.nextSkip = page.length;
      this.hasMore = page.length === FIRST_PAGE_SIZE;

      // GitKraken-style WIP node: when the working tree is dirty, prepend a
      // synthetic "Uncommitted changes" commit parented on HEAD so it sits at
      // the top of the graph with a lane down to HEAD.
      this.injectWipNode(active);

      const { rows, totalColumns } = this.buildRows(this.loaded);
      this.post({
        type: "graphInit",
        rows,
        head: this.currentHeadSha,
        totalColumns,
        hasMore: this.hasMore,
        refFilter: this.refFilter,
        refList: this.refList,
      });
      // Rows now exist in the webview — reveals can land. Must be set BEFORE
      // the flush below, or the replayed reveal would just re-queue itself.
      this.initialized = true;
      // Flush a queued reveal (e.g. from a blame click or a Commits-view
      // click). Later reveals overwrite the pending one, so the commit the user
      // clicked LAST is the one that wins.
      if (this.pendingReveal) {
        const sha = this.pendingReveal;
        this.pendingReveal = undefined;
        this.reveal(sha);
      }
      // Which commits may be reordered by dragging (issue #18). Sent after
      // graphInit so the rows exist to mark, and NOT awaited into the load path
      // — it is one local rev-list, but the graph must never wait on it.
      void this.sendRebaseChain(active, controller.signal);
      // Real author photos (GitHub) land asynchronously and replace the
      // Gravatar/initials placeholders in place — never blocking the graph.
      void this.loadAuthorAvatars(active, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        // Distinguish a fresh/empty repo (no commits yet — a normal empty state)
        // from a real git failure, which deserves an error placeholder + Retry
        // rather than a silent "No commits yet" that looks like an empty repo.
        const msg = err instanceof Error ? err.message : String(err);
        const isEmptyRepo =
          /does not have any commits|bad default revision|unknown revision|ambiguous argument .HEAD./i.test(
            msg,
          );
        if (isEmptyRepo) {
          this.post({
            type: "graphInit",
            rows: [],
            head: "",
            totalColumns: 1,
            hasMore: false,
            refFilter: null,
            refList: [],
          });
        } else {
          this.post({ type: "graphError", message: msg });
        }
      }
    } finally {
      if (this.loadController === controller) {
        this.loadController = undefined;
      }
    }
  }

  /** Append the next page; relayout the full set so cross-page lanes connect. */
  private async loadMore(): Promise<void> {
    if (!this.hasMore || this.loadController) {
      return;
    }
    const active = this.repos.getActive();
    if (!active || active.root !== this.repoRoot) {
      return;
    }
    const controller = new AbortController();
    this.loadController = controller;
    const skip = this.nextSkip;
    try {
      const page = await this.readPage(active, skip, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      if (page.length === 0) {
        // History length was an exact multiple of the page size. The webview
        // disarmed its loadMore when it fired this request and only re-arms on
        // a rows/hasMore change — a silent return leaves it stuck showing
        // "loading older commits…" forever, so tell it the history ended.
        this.hasMore = false;
        this.post({
          type: "graphAppend",
          rows: [],
          totalColumns: 0,
          hasMore: false,
        });
        return;
      }
      this.nextSkip += page.length;
      this.hasMore = page.length === PAGE_SIZE;

      // Relayout the entire loaded DAG so a lane that spans the page boundary
      // keeps a continuous column/color, then emit only the new tail rows.
      const before = this.loaded.length;
      this.loaded = this.loaded.concat(page);
      const { rows, totalColumns } = this.buildRows(this.loaded);
      const appended = rows.slice(before);
      this.post({
        type: "graphAppend",
        rows: appended,
        totalColumns,
        hasMore: this.hasMore,
      });
    } catch {
      // Drop quietly; the next scroll re-arms loadMore.
    } finally {
      if (this.loadController === controller) {
        this.loadController = undefined;
      }
    }
  }

  /**
   * Tell the webview which commits it may reorder.
   *
   * Failure is silent by design: no chain means nothing is draggable, which is
   * exactly the state of a surface that never asked. A repo with no commits, no
   * upstream, or a git that predates the `update-ref` todo command all land
   * here, and none of them is worth an error banner over a feature the user may
   * not be reaching for.
   */
  /**
   * Local branches that may be CARRIED along a rewrite of `sha`.
   *
   * The branch being rebased is excluded, and that is not a nicety: git moves
   * it itself at the end, and naming it in an update-ref line makes the whole
   * rebase fail —
   *
   *   error: update_ref failed for ref 'refs/heads/main': cannot lock ref
   *   Failed to update the following refs with --update-refs: refs/heads/main
   *
   * HEAD's branch is always the top of the chain, so without this the option
   * would fail every single time it was used.
   */
  private carryableBranches(sha: string): string[] {
    return (this.refsBySha.get(sha) ?? [])
      .filter((r) => r.type === "head" && !r.isCurrent)
      .map((r) => r.name);
  }

  private async sendRebaseChain(
    active: RepoEntry,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const chain = await readRewritableChain(active.ctx.process, {
        signal,
        // A branch with thousands of unpushed commits does not need all of them
        // draggable; the cap only ever shortens the chain.
        maxCount: 500,
      });
      if (signal.aborted) {
        return;
      }
      // Local branch tips sitting on a rewritable commit, so the webview can
      // offer to carry them along. Remote-tracking refs and tags are excluded:
      // update-ref moves local branches, and moving a tag silently would be a
      // surprise nobody asked for.
      const branches: Record<string, string[]> = {};
      for (const sha of chain.shas) {
        const names = this.carryableBranches(sha);
        if (names.length > 0) {
          branches[sha] = names;
        }
      }
      this.post({
        type: "rebaseChain",
        shas: chain.shas,
        stop: chain.stop,
        base: chain.base,
        branches,
      });
    } catch {
      // See above — absent is a valid answer.
    }
  }

  /**
   * Apply a drag-reorder from the Commits list as a real rebase.
   *
   * Every guard here exists because this rewrites history from a POINTER
   * GESTURE. The order arrives from a webview that may have been looking at a
   * stale graph, so nothing it says is trusted: the chain is re-read from git
   * at this moment and the requested order must be exactly a permutation of it.
   * If a commit landed, a branch moved, or a fetch changed what is published
   * between the drag starting and the drop, the sets differ and this refuses
   * rather than rebasing something the user never saw.
   */
  private async reorderCommits(order: string[], mayUpdateRefs: boolean): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }

    if (await isRebaseInProgress(active.root)) {
      void vscode.window.showWarningMessage(
        "GitStudio: a rebase is already in progress — finish or abort it first.",
      );
      return;
    }

    // Re-read rather than trust. See the note above.
    const chain = await readRewritableChain(active.ctx.process, { maxCount: 500 });
    const same =
      chain.shas.length === order.length &&
      new Set(chain.shas).size === order.length &&
      order.every((sha) => chain.shas.includes(sha));
    if (!same) {
      void vscode.window.showWarningMessage(
        "GitStudio: the history changed while you were dragging — nothing was reordered.",
      );
      void this.loadInitial();
      return;
    }
    if (order.every((sha, i) => sha === chain.shas[i])) {
      return; // dropped back where it started
    }

    // A dirty tree makes git refuse mid-flight, which is a worse place to find
    // out. Say it before anything is rewritten.
    const status = await active.ctx.status.read();
    if (status.staged.length > 0 || status.unstaged.length > 0) {
      void vscode.window.showWarningMessage(
        "GitStudio: commit or stash your changes before reordering — a rebase needs a clean working tree.",
      );
      return;
    }

    const branches = order.flatMap((sha) => this.carryableBranches(sha));
    // The HOST decides whether the carry question is worth asking. The webview
    // sends its own view of this, but its refs can be a graph-load behind — and
    // if they are, silently not offering to carry a branch that exists is worse
    // than asking a question that turns out to be easy.
    void mayUpdateRefs;
    const carry =
      branches.length > 0
        ? await this.askCarryBranches(order.length, branches)
        : await this.askReorder(order.length);
    if (carry === undefined) {
      return; // cancelled
    }

    const rows = order.map((sha) => ({
      sha,
      action: "pick",
      subject: this.records.get(sha)?.subject ?? "",
      branches: carry ? this.carryableBranches(sha) : undefined,
    }));
    const built = buildRebasePlan(rows, { updateRefs: carry });
    if (!built.ok) {
      void vscode.window.showErrorMessage(`GitStudio: ${built.message}`);
      return;
    }

    const ledger = this.repos.getUndoLedger();
    const run = () =>
      runRebasePlan(active.root, {
        base: chain.base ?? "--root",
        todo: built.todo,
        rewords: built.rewords,
      });
    const outcome = ledger
      ? await ledger.runWithUndo(active, `Reorder ${order.length} commits`, run)
      : await run();

    if (outcome.status === "done") {
      vscode.window.setStatusBarMessage("$(check) Reordered", 3000);
    } else if (outcome.status === "stopped") {
      // Reordering can genuinely conflict — two commits touching the same lines
      // in the other order. git leaves the rebase open for the user to finish.
      void vscode.window.showWarningMessage(
        outcome.reason === "conflict"
          ? "GitStudio: reordering hit a conflict — resolve it, then continue or abort the rebase."
          : "GitStudio: the rebase stopped and needs you — continue or abort it.",
      );
    } else {
      void vscode.window.showErrorMessage(
        `GitStudio: reorder failed${outcome.message ? ` — ${outcome.message}` : ""}`,
      );
    }
    this.scheduleRefresh();
  }

  /** Confirm a reorder that touches only this branch. */
  private async askReorder(count: number): Promise<boolean | undefined> {
    const picked = await promptPick({
      title: `Reorder ${count} commit${count === 1 ? "" : "s"}?`,
      hint: "They are rewritten, so they get new identities. Undo is available afterwards.",
      choices: [
        { id: "go", label: "Reorder", icon: "git-commit" },
        { id: "no", label: "Cancel", icon: "close" },
      ],
    });
    return picked === "go" ? false : undefined;
  }

  /**
   * Confirm, and ask whether other branches should come along.
   *
   * Worth asking rather than assuming either way: leaving them behind is not
   * "no change" — they end up pointing at commits that are no longer in this
   * branch's history — but moving refs the user did not name is not something
   * to do silently either.
   */
  private async askCarryBranches(
    count: number,
    branches: string[],
  ): Promise<boolean | undefined> {
    const names = branches.slice(0, 3).join(", ") +
      (branches.length > 3 ? ` and ${branches.length - 3} more` : "");
    const picked = await promptPick({
      title: `Reorder ${count} commit${count === 1 ? "" : "s"}?`,
      hint: `${names} point into this range.`,
      choices: [
        {
          id: "carry",
          label: "Reorder and move those branches",
          icon: "git-branch",
          description: "They follow onto the rewritten commits.",
        },
        {
          id: "only",
          label: "Reorder this branch only",
          icon: "git-commit",
          description: "They keep pointing at the commits as they are now.",
        },
        { id: "no", label: "Cancel", icon: "close" },
      ],
    });
    if (picked === "carry") return true;
    if (picked === "only") return false;
    return undefined;
  }

  private async readPage(
    active: RepoEntry,
    skip: number,
    signal: AbortSignal,
    limit: number = PAGE_SIZE,
  ): Promise<GraphInputCommit[]> {
    const page: GraphInputCommit[] = [];
    for await (const commit of active.ctx.log.streamCommits({
      revRange: "--all",
      // The branch filter: every page of one load walks the same ticked set,
      // so skip-based paging stays consistent across the load.
      refs: this.refFilter ?? undefined,
      maxCount: limit,
      skip,
      signal,
    })) {
      if (signal.aborted) {
        break;
      }
      this.records.set(commit.sha, commit);
      page.push({ sha: commit.sha, parents: commit.parents });
    }
    return page;
  }

  /**
   * The Branches picker changed the filter. Remember it for this repository;
   * the store's change event is what reloads every surface showing it, this
   * one included (see the constructor). Without a store — a host constructed
   * before activation installed one — the selection lives here for the
   * session and the reload is direct.
   */
  private async setRefFilter(refs: GraphRefFilter): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const store = getRefFilterStore();
    if (store) {
      await store.set(active.root, refs);
      return;
    }
    this.refFilter = refs && refs.length > 0 ? refs : null;
    await this.loadInitial();
  }

  private async loadRefs(active: RepoEntry): Promise<void> {
    this.refsBySha.clear();
    this.currentHeadSha = "";
    this.hasAnyRemote = false;
    let refs: GitRef[] = [];
    try {
      refs = await active.ctx.refs.listRefs();
    } catch {
      refs = [];
    }
    this.refs = refs;
    this.refsListed = refs.length > 0;
    this.refList = refEntries(refs);
    for (const ref of refs) {
      if (ref.type === "stash") {
        continue;
      }
      if (ref.type === "remote") {
        this.hasAnyRemote = true;
      }
      const list = this.refsBySha.get(ref.sha);
      if (list) {
        list.push(ref);
      } else {
        this.refsBySha.set(ref.sha, [ref]);
      }
      if (ref.type === "head" && ref.isCurrent) {
        this.currentHeadSha = ref.sha;
      }
    }
  }

  /**
   * Lays the DAG out and decorates each row into a WireRow. The metadata/ref
   * denormalization is the shared, host-agnostic `buildWireRows` — the same
   * transformation the desktop main process reuses.
   */
  private buildRows(commits: GraphInputCommit[]): {
    rows: WireRow[];
    totalColumns: number;
  } {
    const layout = computeGraphLayout(commits, { colorCount: 8 });
    const rows = buildWireRows({
      rows: layout.rows,
      records: this.records,
      // Chips follow the filter: a ref the graph is not built around draws no
      // chip (the current branch always does). The details pane and the
      // commit menu keep reading the full map — they describe the commit.
      refsBySha: chipRefsUnderFilter(this.refsBySha, this.refFilter),
    });
    return { rows, totalColumns: layout.totalColumns };
  }

  // ── Commit interactions ────────────────────────────────────────────────────

  /** Open the commit actions as an IN-GRAPH popover at (x, y) — no native
   *  quick-pick. x < 0 means "position near the selected row" (keyboard menu). */
  private openCommitMenu(sha: string, x: number, y: number): void {
    const record = this.records.get(sha);
    this.post({
      type: "commitMenu",
      sha,
      x,
      y,
      title: `${sha.slice(0, 7)} · ${record?.subject ?? ""}`.trim(),
      // Refs on this row first ("Checkout main"), then the commit-scoped actions.
      items: [...refMenuItems(this.refsToWire(sha)), ...commitMenuItems()],
    });
  }

  /** Run the action the user picked in the in-graph commit popover. */
  private async runCommitMenuAction(sha: string, id: string): Promise<void> {
    const active = this.repos.getActive();
    if (!active || !id) {
      return;
    }
    // "Start interactive rebase here" is its own flow (spawns a terminal + opens
    // the rebase webview), not a runCommitAction case.
    if (id === "interactiveRebase") {
      await vscode.commands.executeCommand("gitstudio.startInteractiveRebase", sha);
      return;
    }
    const record = this.records.get(sha);
    // Route destructive ops through the Undo envelope when it's available.
    const ledger = this.repos.getUndoLedger();
    const undo = ledger
      ? <T>(label: string, fn: () => Promise<T>) =>
          ledger.runWithUndo(active, label, fn)
      : undefined;
    const changed = await runCommitAction(
      id,
      active.ctx,
      // refs let "Checkout Commit" land on the branch rather than detaching.
      { sha, subject: record?.subject ?? "", refs: this.refsToWire(sha) },
      undo,
    );
    if (changed) {
      this.scheduleRefresh();
    }
  }

  // ── Commit details panel (docked under the graph) ──────────────────────────

  /** What this surface is currently showing (undefined until something is). */
  get selectedSha(): string | undefined {
    return this.shown;
  }

  /** Whether the details dock is currently open in the webview. Mirrored from
   *  the webview because the user can dismiss it there, and only a fresh
   *  reveal re-opens it. */
  get detailsOpen(): boolean {
    return this.detailsVisible;
  }

  /** Public: select + reveal a commit and show its details (from another view). */
  reveal(sha: string): void {
    // `ready` only means the webview booted — its first page of rows arrives
    // later, and revealing into an empty graph silently no-ops. Queue until
    // graphInit has actually landed (`initialized`), or a reveal issued during
    // that window is lost.
    if (!this.ready || !this.initialized) {
      this.pendingReveal = sha;
      return;
    }
    if (!this.records.has(sha)) {
      void this.revealUnloaded(sha);
      return;
    }
    this.shown = sha;
    this.detailsVisible = true; // revealCommit re-opens the dock webview-side
    this.post({ type: "revealCommit", sha });
    void this.pushCommitDetails(sha);
  }

  /**
   * Reveal a commit that is not among the loaded rows.
   *
   * Promoted from the sidebar rail (its own instance may have paged much
   * deeper than this fresh panel): page toward the commit first, else the
   * webview's reveal silently no-ops on a row it doesn't have.
   *
   * Under a branch filter (issue #30) the first question is whether the
   * commit is in the filtered history AT ALL — a Branches-view click, a PR
   * link or a parent chip lands on a commit the ticked refs need not reach as
   * a matter of course now. Paging toward it used to walk up to 25 pages of
   * the filtered history and then post a reveal the webview no-ops: details
   * shown, no row selected, not a word. So git is asked first (one rev-list),
   * and a commit the filter hides is said so, with the way out.
   */
  private async revealUnloaded(sha: string): Promise<void> {
    const active = this.repos.getActive();
    const filter = this.refFilter;
    if (active && filter && !(await active.ctx.log.walkReaches(sha, filter))) {
      // The details still show — the pane describes the commit, whatever the
      // graph is built around — so the reveal is posted for the dock it
      // re-opens, not for a row it will not find.
      this.shown = sha;
      this.detailsVisible = true;
      this.post({ type: "revealCommit", sha });
      void this.pushCommitDetails(sha);
      this.offerAllBranches(sha, active.root);
      return;
    }
    if (this.hasMore) {
      await this.pageUntilLoaded(sha);
    }
    this.shown = sha;
    this.detailsVisible = true;
    this.post({ type: "revealCommit", sha });
    void this.pushCommitDetails(sha);
  }

  /**
   * The branch filter hides the commit that was asked for: say so, and offer
   * the way out. Taking it forgets the filter for this repository — every
   * surface showing it reloads through the store — and the reveal is replayed
   * once the unfiltered first page lands (see loadInitial's pendingReveal).
   */
  private offerAllBranches(sha: string, root: string): void {
    void vscode.window
      .showInformationMessage(
        `GitStudio: ${sha.slice(0, 7)} is hidden by the branch filter.`,
        "Show all branches",
      )
      .then((pick) => {
        if (pick !== "Show all branches" || root !== this.repoRoot) {
          return;
        }
        this.pendingReveal = sha;
        void this.setRefFilter(null);
      });
  }

  /** Page in more history until `sha` is loaded (bounded so a sha that isn't
   *  in the log at all can't trigger an unbounded full-history walk). */
  private async pageUntilLoaded(sha: string): Promise<void> {
    const MAX_STEPS = 25; // ~20 pages × 500 = 10k commits of reach
    for (let i = 0; i < MAX_STEPS; i++) {
      if (this.records.has(sha) || !this.hasMore) {
        return;
      }
      if (this.loadController) {
        // A page is already in flight (loadMore would no-op); let it land.
        await new Promise((r) => setTimeout(r, 150));
        continue;
      }
      await this.loadMore();
    }
  }

  /** Prepend a synthetic "Uncommitted changes" node when the tree is dirty. */
  private injectWipNode(active: RepoEntry): void {
    if (!this.currentHeadSha || !active.repo) {
      // No WIP node until vscode.git attaches (it drives the dirty check); the
      // commit history still renders from our git-service in the meantime.
      return;
    }
    const st = active.repo.state;
    // untrackedChanges is populated (instead of workingTreeChanges) when the
    // user sets git.untrackedChanges = "separate" — without it a worktree of
    // only-new files shows no WIP node at all.
    const dirty =
      (st.indexChanges?.length ?? 0) +
        (st.workingTreeChanges?.length ?? 0) +
        (st.untrackedChanges?.length ?? 0) +
        (st.mergeChanges?.length ?? 0) >
      0;
    if (!dirty) {
      return;
    }
    const now = Math.floor(Date.now() / 1000);
    this.records.set(UNCOMMITTED_SHA, {
      sha: UNCOMMITTED_SHA,
      parents: [this.currentHeadSha],
      author: "Uncommitted changes",
      authorEmail: "",
      authorDate: now,
      committer: "Uncommitted changes",
      committerEmail: "",
      committerDate: now,
      subject: "Uncommitted changes",
      body: "",
    });
    this.loaded.unshift({
      sha: UNCOMMITTED_SHA,
      parents: [this.currentHeadSha],
    });
  }

  /** Build the selected commit's full details payload and post it. */
  private async pushCommitDetails(sha: string): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    if (sha === UNCOMMITTED_SHA) {
      this.pushWipDetails(active);
      return;
    }
    const record = await this.getRecord(active, sha);
    if (!record) {
      this.post({ type: "commitDetails", details: null });
      return;
    }
    let files: CommitFileChange[];
    try {
      files = await active.ctx.commitDetails.getCommitFiles(
        sha,
        record.parents[0],
      );
    } catch {
      files = [];
    }
    const payload: CommitDetailsPayload = {
      kind: "commit",
      sha: record.sha,
      shortSha: record.sha.slice(0, 7),
      parents: record.parents,
      author: record.author,
      authorEmail: record.authorEmail,
      authorDate: record.authorDate,
      committer: record.committer,
      committerEmail: record.committerEmail,
      committerDate: record.committerDate,
      subject: record.subject,
      body: record.body,
      refs: this.refsToWire(sha),
      files,
      hasRemote: this.hasAnyRemote,
    };
    this.post({ type: "commitDetails", details: payload });
  }

  /** Build the working-tree (WIP) details payload from the repo state. */
  private pushWipDetails(active: RepoEntry): void {
    if (!active.repo) {
      return;
    }
    const st = active.repo.state;
    const now = Math.floor(Date.now() / 1000);
    const toFiles = (changes: Change[] | undefined) =>
      (changes ?? []).map((c) => ({
        path: relativePath(active.root, c.uri.fsPath),
        status: statusLetter(c.status),
        additions: 0,
        deletions: 0,
      }));
    const staged = toFiles(st.indexChanges);
    const unstaged = [
      ...toFiles(st.mergeChanges),
      ...toFiles(st.workingTreeChanges),
      // Populated instead of workingTreeChanges under git.untrackedChanges =
      // "separate" — omit it and new files vanish from the WIP details.
      ...toFiles(st.untrackedChanges),
    ];
    this.post({
      type: "commitDetails",
      details: {
        kind: "wip",
        sha: UNCOMMITTED_SHA,
        shortSha: "WIP",
        parents: [this.currentHeadSha],
        author: "Uncommitted changes",
        authorEmail: "",
        authorDate: now,
        committer: "",
        committerEmail: "",
        committerDate: now,
        subject: "",
        body: "",
        refs: [],
        files: [...staged, ...unstaged],
        stagedCount: staged.length,
        hasRemote: this.hasAnyRemote,
      },
    });
  }

  /** Open a changed file as a diff (commit vs first parent, or WIP vs HEAD). */
  private async doOpenFile(
    sha: string,
    path: string,
    wip: boolean,
  ): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    if (wip) {
      // Working-tree file: HEAD ↔ the live file on disk.
      await openRevisionDiff(active.root, path, "HEAD");
      return;
    }
    const record = this.records.get(sha);
    const parent = record?.parents[0] ?? EMPTY_TREE;
    const fileName = path.split("/").pop() || path;
    await openRevisionDiff(
      active.root,
      path,
      parent,
      sha,
      `${fileName} (${sha.slice(0, 7)})`,
    );
  }

  /** Run a details-panel toolbar action against the target commit. */
  private async doCommitAction(action: string, sha: string): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    // WIP actions route to the existing Changes view (where staging/commit live).
    if (sha === UNCOMMITTED_SHA) {
      if (action === "stash") {
        await vscode.commands.executeCommand("gitstudio.stash.save");
      } else {
        // Reveal the Changes view (auto-generated focus command) where staging,
        // commit, and discard live.
        await vscode.commands.executeCommand("gitstudio.commit.focus");
      }
      return;
    }
    if (action === "open-remote") {
      const remote = await active.ctx.process.run(["remote", "get-url", "origin"]);
      const url = commitWebUrl(remote.stdout.trim(), sha);
      if (!url) {
        void vscode.window.showInformationMessage(
          "GitStudio: origin isn't a recognised GitHub/GitLab/Bitbucket remote.",
        );
        return;
      }
      await vscode.env.openExternal(vscode.Uri.parse(url));
      return;
    }
    // The visual Interactive Rebase workspace opens via its command (needs the
    // RepoManager + Undo ledger), not runCommitAction — same route as the menu.
    if (action === "interactive-rebase") {
      await vscode.commands.executeCommand("gitstudio.startInteractiveRebase", sha);
      return;
    }
    const mapped = ACTION_ID_MAP[action];
    if (!mapped) {
      return;
    }
    const record = this.records.get(sha);
    const ledger = this.repos.getUndoLedger();
    const undo = ledger
      ? <T>(label: string, fn: () => Promise<T>) =>
          ledger.runWithUndo(active, label, fn)
      : undefined;
    const changed = await runCommitAction(
      mapped,
      active.ctx,
      // refs let "Checkout Commit" land on the branch rather than detaching.
      { sha, subject: record?.subject ?? "", refs: this.refsToWire(sha) },
      undo,
    );
    if (changed) {
      this.scheduleRefresh();
    }
  }

  private async doCopy(text: string): Promise<void> {
    await vscode.env.clipboard.writeText(text);
    void vscode.window.setStatusBarMessage(
      `$(check) Copied ${text.length > 12 ? text.slice(0, 7) : text}`,
      2000,
    );
  }

  /** Compute + post CHANGES-column stats for the requested (visible) shas. */
  /**
   * Answer the details pane's "in N branches" request. Lazy and best-effort:
   * `git branch --all --contains` walks history, so a slow or failing call must
   * never break the pane — we reply with an empty list instead. The sha is
   * echoed back so the webview can discard a late reply for a commit the user
   * has already navigated away from.
   */
  private async pushContains(sha: string): Promise<void> {
    const active = this.repos.getActive();
    if (!active || sha === UNCOMMITTED_SHA) {
      this.post({ type: "commitContains", sha, branches: [], truncated: false });
      return;
    }
    // One walk at a time. `git branch --all --contains` is O(history) and a
    // burst of selections would otherwise queue an unbounded number of git
    // processes; a repeat request for the same sha is simply dropped.
    if (this.containsInFlight === sha) {
      return;
    }
    this.containsInFlight = sha;
    try {
      const { branches, truncated } = await active.ctx.refs.containingBranches(sha);
      // The user may have moved on; the webview also guards, but not posting a
      // reply for a stale commit keeps the two ends honest.
      this.post({ type: "commitContains", sha, branches, truncated });
    } catch {
      this.post({ type: "commitContains", sha, branches: [], truncated: false });
    } finally {
      if (this.containsInFlight === sha) {
        this.containsInFlight = undefined;
      }
    }
  }

  /** Sha whose containment walk is currently running, if any. */
  private containsInFlight: string | undefined;

  private async pushRowStats(shas: string[]): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    // The synthetic WIP node has no real commit to stat.
    const wanted = shas.filter((s) => s !== UNCOMMITTED_SHA);
    if (!wanted.length) {
      return;
    }
    // One `git log --numstat` answers the whole visible window (the shas go
    // over stdin, so no window is too tall). The per-sha version spawned two
    // git processes a row, all sixty at once, and capped there — so on a tall
    // window the rows past sixty were never answered, stayed pending in the
    // webview, and kept a blank CHANGES cell for the rest of the session.
    const bySha = new Map<string, RowStat>();
    try {
      for (const s of await active.ctx.commitDetails.getCommitStats(wanted)) {
        bySha.set(s.sha, s);
      }
    } catch {
      // Answered below as "no stats", as a failed per-sha diff always was.
    }
    // Every sha asked for gets an answer. One git could not stat (rewritten
    // away under a live graph) renders as an empty cell — the same as a
    // commit that changed nothing — and is not asked about again; one left
    // unanswered would stay pending and never be asked about again either,
    // with nothing to show for it.
    const stats = wanted.map(
      (sha) => bySha.get(sha) ?? { sha, files: 0, additions: 0, deletions: 0 },
    );
    this.post({ type: "rowStats", stats });
  }

  /** A CommitRecord from the cache, or streamed on demand if not yet loaded. */
  private async getRecord(
    active: RepoEntry,
    sha: string,
  ): Promise<CommitRecord | undefined> {
    const cached = this.records.get(sha);
    if (cached) {
      return cached;
    }
    try {
      for await (const commit of active.ctx.log.streamCommits({
        revRange: sha,
        maxCount: 1,
      })) {
        this.records.set(commit.sha, commit);
        return commit;
      }
    } catch {
      // fall through
    }
    return undefined;
  }

  /** Map the GitRefs at a sha to the webview's WireRef chips. */
  private refsToWire(sha: string): WireRef[] {
    const refs = this.refsBySha.get(sha) ?? [];
    return refs
      .filter((r) => r.type !== "stash")
      .map((r): WireRef => {
        if (r.type === "tag") return { kind: "tag", name: r.name };
        if (r.type === "remote") return { kind: "remoteHead", name: r.name };
        return r.isCurrent
          ? { kind: "currentHead", name: r.name }
          : { kind: "head", name: r.name };
      });
  }

  dispose(): void {
    this.loadController?.abort();
    this.loadController = undefined;
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.records.clear();
    this.refsBySha.clear();
    this.refs = [];
    this.refList = [];
    this.loaded = [];
  }
}
