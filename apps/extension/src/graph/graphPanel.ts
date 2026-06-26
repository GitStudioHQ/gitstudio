import * as vscode from "vscode";
import { computeGraphLayout } from "@gitstudio/engine/graph/layout";
import type { GraphInputCommit } from "@gitstudio/engine/graph/layout";
import type { CommitRecord, GitRef } from "@gitstudio/git-service/index";
import { UNCOMMITTED_SHA } from "@gitstudio/git-service/index";
import type {
  GraphHostMessage,
  GraphWebviewMessage,
  WireRow,
  WireRef,
  RowStat,
} from "@gitstudio/host-bridge/graphProtocol";
import type {
  CommitDetailsPayload,
  CommitFileChange,
} from "@gitstudio/host-bridge/commitDetailsProtocol";
import { buildWireRows } from "@gitstudio/host-bridge/graphWire";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { getGraphHtml, getNonce } from "./graphHtml";
import { commitActionItems, runCommitAction } from "./commitActions";
import { openRevisionDiff } from "../history/revisionContentProvider";
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
/** Debounce repo-change rebuilds (a rebase touches many refs in a burst). */
const REFRESH_DEBOUNCE_MS = 300;

/**
 * The singleton commit-graph panel: one editor-area WebviewPanel that streams
 * `git log --all`, lays it out with the engine, decorates rows with ref chips,
 * pages on scroll, and rebuilds (debounced) when the active repo changes.
 */
export class CommitGraphPanel {
  private static current: CommitGraphPanel | undefined;

  static show(repos: RepoManager, extensionUri: vscode.Uri): void {
    if (CommitGraphPanel.current) {
      CommitGraphPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitstudio.commitGraph",
      "Commit Graph",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    CommitGraphPanel.current = new CommitGraphPanel(
      panel,
      repos,
      extensionUri,
    );
  }

  /** Open (or focus) the graph, then select + reveal a commit and its details. */
  static revealCommit(
    repos: RepoManager,
    extensionUri: vscode.Uri,
    sha: string,
  ): void {
    CommitGraphPanel.show(repos, extensionUri);
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
  private hasAnyRemote = false;
  private currentHeadSha = "";
  private nextSkip = 0;
  private hasMore = false;
  private ready = false;
  private repoRoot: string | undefined;
  /** A sha to reveal once the first page is loaded (from the Commits view). */
  private pendingReveal: string | undefined;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly repos: RepoManager,
    private readonly extensionUri: vscode.Uri,
  ) {
    const nonce = getNonce();
    panel.webview.html = getGraphHtml(panel.webview, extensionUri, nonce);

    this.disposables.push(
      panel.webview.onDidReceiveMessage((msg: GraphWebviewMessage) =>
        this.onMessage(msg),
      ),
      panel.onDidDispose(() => this.dispose()),
      this.repos.onDidChange(() => this.scheduleRefresh()),
    );
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
      case "selectCommit":
        void this.pushCommitDetails(msg.sha);
        break;
      case "openCommit":
        void this.pushCommitDetails(msg.sha);
        break;
      case "contextMenu":
      case "action":
        void this.showCommitMenu(msg.sha);
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
    }
  }

  private post(message: GraphHostMessage): void {
    void this.panel.webview.postMessage(message);
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
      this.nextSkip = 0;
      this.hasMore = false;
      this.post({
        type: "graphInit",
        rows: [],
        head: "",
        totalColumns: 1,
        hasMore: false,
      });
      return;
    }

    this.repoRoot = active.root;
    this.records.clear();
    this.loaded = [];
    this.nextSkip = 0;

    try {
      await this.loadRefs(active);
      const page = await this.readPage(active, 0, controller.signal);
      if (controller.signal.aborted) {
        return;
      }
      this.loaded = page;
      this.nextSkip = page.length;
      this.hasMore = page.length === PAGE_SIZE;

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
      });
      // Flush a queued reveal (e.g. from a Commits-view click) now that rows
      // exist in the webview.
      if (this.pendingReveal) {
        const sha = this.pendingReveal;
        this.pendingReveal = undefined;
        this.reveal(sha);
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        // Empty/fresh repo or a transient git error: show the empty state.
        this.post({
          type: "graphInit",
          rows: [],
          head: "",
          totalColumns: 1,
          hasMore: false,
        });
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
      if (controller.signal.aborted || page.length === 0) {
        this.hasMore = page.length === PAGE_SIZE;
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

  private async readPage(
    active: RepoEntry,
    skip: number,
    signal: AbortSignal,
  ): Promise<GraphInputCommit[]> {
    const page: GraphInputCommit[] = [];
    for await (const commit of active.ctx.log.streamCommits({
      revRange: "--all",
      maxCount: PAGE_SIZE,
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
      refsBySha: this.refsBySha,
    });
    return { rows, totalColumns: layout.totalColumns };
  }

  // ── Commit interactions ────────────────────────────────────────────────────

  private async openCommit(sha: string): Promise<void> {
    const record = this.records.get(sha);
    const subject = record?.subject ?? "(commit)";
    // A full commit-details panel is M5; for now reveal the commit visibly with
    // a quick action menu so the gesture does something useful.
    const choice = await vscode.window.showInformationMessage(
      `${sha.slice(0, 7)} · ${subject}`,
      "Copy SHA",
      "Commit Actions…",
    );
    if (choice === "Copy SHA") {
      await vscode.env.clipboard.writeText(sha);
      void vscode.window.setStatusBarMessage(
        `$(check) Copied ${sha.slice(0, 7)}`,
        2000,
      );
    } else if (choice === "Commit Actions…") {
      await this.showCommitMenu(sha);
    }
  }

  private async showCommitMenu(sha: string): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const record = this.records.get(sha);
    const picked = await vscode.window.showQuickPick(commitActionItems(), {
      title: `${sha.slice(0, 7)} · ${record?.subject ?? ""}`.trim(),
      placeHolder: "Commit actions",
    });
    if (!picked || !picked.id) {
      return;
    }

    // "Start interactive rebase here" is its own flow (it spawns a terminal +
    // opens the rebase webview), not a runCommitAction case.
    if (picked.id === "interactiveRebase") {
      await vscode.commands.executeCommand(
        "gitstudio.startInteractiveRebase",
        sha,
      );
      return;
    }

    // Route destructive ops through the Undo envelope when it's available.
    const ledger = this.repos.getUndoLedger();
    const undo = ledger
      ? <T>(label: string, fn: () => Promise<T>) =>
          ledger.runWithUndo(active, label, fn)
      : undefined;

    const changed = await runCommitAction(
      picked.id,
      active.ctx,
      { sha, subject: record?.subject ?? "" },
      undo,
    );
    if (changed) {
      this.scheduleRefresh();
    }
  }

  // ── Commit details panel (docked under the graph) ──────────────────────────

  /** Public: select + reveal a commit and show its details (from another view). */
  reveal(sha: string): void {
    if (!this.ready) {
      // The webview hasn't booted / loaded its first page yet — queue it.
      this.pendingReveal = sha;
      return;
    }
    this.post({ type: "revealCommit", sha });
    void this.pushCommitDetails(sha);
  }

  /** Prepend a synthetic "Uncommitted changes" node when the tree is dirty. */
  private injectWipNode(active: RepoEntry): void {
    if (!this.currentHeadSha) {
      return;
    }
    const st = active.repo.state;
    const dirty =
      (st.indexChanges?.length ?? 0) +
        (st.workingTreeChanges?.length ?? 0) +
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
      await this.doCopy(sha);
      void vscode.window.setStatusBarMessage(
        "$(check) Copied SHA (open-on-remote coming soon)",
        2500,
      );
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
      { sha, subject: record?.subject ?? "" },
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
  private async pushRowStats(shas: string[]): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    const stats: RowStat[] = [];
    // Bounded concurrency: a handful at a time keeps the process pool happy.
    // The synthetic WIP node has no real commit to stat.
    const queue = shas.filter((s) => s !== UNCOMMITTED_SHA).slice(0, 60);
    await Promise.all(
      queue.map(async (sha) => {
        const record = await this.getRecord(active, sha);
        if (!record) {
          return;
        }
        try {
          const files = await active.ctx.commitDetails.getCommitFiles(
            sha,
            record.parents[0],
          );
          let add = 0,
            del = 0;
          for (const f of files) {
            if (f.additions > 0) add += f.additions;
            if (f.deletions > 0) del += f.deletions;
          }
          stats.push({ sha, files: files.length, additions: add, deletions: del });
        } catch {
          stats.push({ sha, files: 0, additions: 0, deletions: 0 });
        }
      }),
    );
    if (stats.length) {
      this.post({ type: "rowStats", stats });
    }
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
    CommitGraphPanel.current = undefined;
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
    this.loaded = [];
  }
}
