import * as vscode from "vscode";
import { computeGraphLayout } from "@gitstudio/engine/graph/layout";
import type { GraphInputCommit } from "@gitstudio/engine/graph/layout";
import type { CommitRecord, GitRef } from "@gitstudio/git-service/index";
import type {
  GraphHostMessage,
  GraphWebviewMessage,
  WireRef,
  WireRow,
} from "@gitstudio/host-bridge/graphProtocol";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { getGraphHtml, getNonce } from "./graphHtml";
import { commitActionItems, runCommitAction } from "./commitActions";

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

  private readonly disposables: vscode.Disposable[] = [];
  private loadController: AbortController | undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;

  /** Rows already sent to the webview (for sha→record action lookups). */
  private records = new Map<string, CommitRecord>();
  /** All loaded input commits (for incremental relayout on append). */
  private loaded: GraphInputCommit[] = [];
  private refsBySha = new Map<string, GitRef[]>();
  private currentHeadSha = "";
  private nextSkip = 0;
  private hasMore = false;
  private ready = false;
  private repoRoot: string | undefined;

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
      case "selectCommit":
        // Selection is a UI affordance for now; a details panel lands in M5.
        break;
      case "openCommit":
        void this.openCommit(msg.sha);
        break;
      case "contextMenu":
      case "action":
        void this.showCommitMenu(msg.sha);
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

      const { rows, totalColumns } = this.buildRows(page);
      this.post({
        type: "graphInit",
        rows,
        head: this.currentHeadSha,
        totalColumns,
        hasMore: this.hasMore,
      });
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

  /** Lays the DAG out and decorates each row into a WireRow. */
  private buildRows(commits: GraphInputCommit[]): {
    rows: WireRow[];
    totalColumns: number;
  } {
    const layout = computeGraphLayout(commits, { colorCount: 8 });
    const rows: WireRow[] = layout.rows.map((row) => {
      const record = this.records.get(row.sha);
      return {
        sha: row.sha,
        shortSha: row.sha.slice(0, 7),
        column: row.column,
        color: row.color,
        isMerge: row.isMerge,
        segments: row.segments,
        subject: record?.subject ?? "",
        author: record?.author ?? "",
        authorEmail: record?.authorEmail ?? "",
        authorDate: record?.authorDate ?? 0,
        refs: this.wireRefs(row.sha),
      };
    });
    return { rows, totalColumns: layout.totalColumns };
  }

  /** Ref chips for a sha, current HEAD first, then locals, remotes, tags. */
  private wireRefs(sha: string): WireRef[] {
    const refs = this.refsBySha.get(sha);
    if (!refs) {
      return [];
    }
    const out: WireRef[] = [];
    for (const ref of refs) {
      if (ref.type === "head") {
        out.push({
          name: ref.name,
          kind: ref.isCurrent ? "currentHead" : "head",
        });
      } else if (ref.type === "remote") {
        out.push({ name: ref.name, kind: "remoteHead" });
      } else if (ref.type === "tag") {
        out.push({ name: ref.name, kind: "tag" });
      }
    }
    out.sort((a, b) => kindRank(a.kind) - kindRank(b.kind));
    return out;
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

function kindRank(kind: WireRef["kind"]): number {
  switch (kind) {
    case "currentHead":
      return 0;
    case "head":
      return 1;
    case "remoteHead":
      return 2;
    case "tag":
      return 3;
  }
}
