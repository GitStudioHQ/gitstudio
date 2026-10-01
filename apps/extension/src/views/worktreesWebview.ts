import * as vscode from "vscode";
import * as path from "node:path";
import { existsSync } from "node:fs";
import type {
  WorktreeFileChange,
  WorktreeStatus,
  WorktreeSummary,
  WorktreesSnapshot,
} from "@gitstudio/git-service/worktreeState";
import { unpublishedRange, unpublishedRule } from "@gitstudio/git-service/worktreeState";
import { nativePath, sameFolder } from "@gitstudio/git-service/folderPath";
import {
  WORKTREE_COMMITS_SHOWN,
  WORKTREE_FILES_SHOWN,
  unpublishedTitle,
  worktreeCaps,
  type WorktreeAction,
  type WorktreeDetails,
  type WorktreeRow,
  type WorktreeRowStatus,
  type WorktreesToHost,
  type WorktreesToPage,
} from "@gitstudio/host-bridge/worktreesProtocol";
import type { ChangeCommit, ChangeFile } from "@gitstudio/host-bridge/changeRows";
import type { RepoEntry, RepoManager } from "../git/repoManager";
import { getNonce } from "../webview/html";
import { tildify } from "./branchElsewhere";
import {
  EMPTY_TREE,
  commitChangeSides,
  openSidesDiff,
  revisionSideUri,
} from "../history/revisionContentProvider";
import {
  addWorktree,
  copyWorktreePath,
  forgetWorktree,
  lockWorktree,
  openWorktreeIn,
  openWorktreeTerminal,
  pruneWorktrees,
  pullWorktree,
  pushTargetFor,
  removeWorktree,
  revealWorktree,
  worktreesOpenHere,
  type WorktreeUi,
} from "./worktreesView";
import * as l10n from "@vscode/l10n";
import { l10nWebviewScript } from "@gitstudio/l10n/index";

// The Worktrees view — a webview (it was a native tree that could show one
// line per worktree and nothing else). Its page is packages/webview-ui's
// worktrees/ entry; what its rows say and what each one offers come from
// host-bridge/worktreesProtocol, the same functions the tests pin.
//
// What it reads, and when (git-service/worktreeState.ts has the why):
//   · tier 0 — every worktree, three spawns — on every repository change,
//     when the view shows again, and on Refresh;
//   · tier 1 — a row's working tree and stopped operation — only for the
//     rows the page says are in view, the one this window has open and the
//     open ones; four at a time; at most once per TTL unless something
//     changed; never while the view is hidden;
//   · tier 2 — an open row's files and commits, and a commit's files when
//     that commit is opened.
//
// Nothing is re-sent that did not change, and a one-click action patches its
// row (and puts it back if git says no) instead of reloading the list.

/** A row's tier 1, and when it was read. */
interface StatusRead {
  at: number;
  status: WorktreeStatus | undefined;
}

/** How long a row's tier 1 is fresh when nothing says it changed. */
const STATUS_TTL_MS = 10_000;
/** How many rows' tier 1 is read at once. */
const STATUS_CONCURRENCY = 4;

export interface WorktreesDeps {
  /** Open the push review for a worktree (the Changes view's). */
  openPushReview(target?: { entry: RepoEntry; name: string; shownPath: string; release(): void }): Promise<void>;
  /** Other views that list what these actions change (the Changes view's Stashes group). */
  onChanged?(): void;
}

/** How Reveal reads on this platform — VS Code's own words for it. */
export function revealLabel(platform: NodeJS.Platform = process.platform): string {
  return platform === "darwin"
    ? l10n.t("Reveal in Finder")
    : platform === "win32"
      ? l10n.t("Reveal in File Explorer")
      : l10n.t("Open Containing Folder");
}

/** The folder relative to the main worktree's parent — or, outside it, the whole folder with ~. */
export function relativeWorktreePath(mainPath: string, p: string): string {
  const rel = path.relative(path.dirname(mainPath), p);
  return !rel || rel.startsWith("..") || path.isAbsolute(rel) ? tildify(nativePath(p)) : rel.split(path.sep).join("/");
}

/** A row, from what tier 0 read and what tier 1 has (if anything). */
export function worktreeRow(
  w: WorktreeSummary,
  snap: Pick<WorktreesSnapshot, "worktrees" | "remotes" | "defaultBranch">,
  here: Set<string>,
  status: WorktreeStatus | undefined,
): WorktreeRow {
  const mainPath = snap.worktrees[0]?.path ?? w.path;
  const upstream = w.upstream?.replace(/^refs\/(remotes|heads)\//, "");
  return {
    path: w.path,
    name: path.basename(w.path),
    relPath: relativeWorktreePath(mainPath, w.path),
    // Said the system's way (git's C:/Users/… is C:\\Users\\… on Windows).
    shownPath: tildify(nativePath(w.path)),
    kind: w.bare ? "bare" : w.main ? "main" : "linked",
    ...(w.branch ? { branch: w.branch } : {}),
    head: w.head,
    current: here.has(w.path),
    locked: w.locked,
    ...(w.lockReason ? { lockReason: w.lockReason } : {}),
    missing: w.missing,
    unlinked: w.unlinked,
    ...(w.unlinked && w.prunableReason ? { unlinkedWhy: w.prunableReason } : {}),
    ...(upstream ? { upstream } : {}),
    upstreamGone: w.upstreamGone,
    ahead: w.ahead,
    behind: w.behind,
    hasRemotes: snap.remotes.length > 0,
    ...(snap.defaultBranch ? { defaultBranch: snap.defaultBranch.name } : {}),
    onDefaultBranch: !!w.branch && !!snap.defaultBranch && w.branch === snap.defaultBranch.local,
    ...(status ? { status: rowStatus(status) } : {}),
  };
}

/** Tier 1 as a row carries it (without the file list). */
function rowStatus(s: WorktreeStatus): WorktreeRowStatus {
  return {
    changed: s.changed,
    staged: s.staged,
    unstaged: s.unstaged,
    untracked: s.untracked,
    conflicted: s.conflicted,
    ...(s.operation ? { operation: s.operation } : {}),
    ...(s.rebasing ? { rebasing: s.rebasing } : {}),
    ...(s.unpublished !== undefined ? { unpublished: s.unpublished } : {}),
  };
}

function toChangeFile(f: WorktreeFileChange): ChangeFile {
  return { path: f.path, ...(f.oldPath ? { oldPath: f.oldPath } : {}), status: f.status, area: f.area };
}

export class WorktreesWebviewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = "gitstudio.worktrees";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** The last tier 0, for the active repository's root. */
  private snap: { root: string; snap: WorktreesSnapshot; here: Set<string> } | undefined;
  private readonly statuses = new Map<string, StatusRead>();
  /** Rows the page says are in view, and rows that are open. */
  private visible = new Set<string>();
  private readonly expanded = new Set<string>();
  private readonly busy = new Map<string, string>();
  /** What the page was last sent, to send nothing that did not change. */
  private lastRowsSig = "";
  private readonly lastStatusSig = new Map<string, string>();
  private readonly lastDetailsSig = new Map<string, string>();
  /** Tier-1 reads waiting and running. */
  private readonly queue: string[] = [];
  private readonly queued = new Set<string>();
  private running = 0;
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshing: Promise<void> | undefined;
  private refreshAgain = false;

  constructor(
    private readonly repos: RepoManager,
    private readonly extensionUri: vscode.Uri,
    private readonly store: vscode.Memento,
    private readonly deps: WorktreesDeps,
  ) {
    this.disposables.push(
      this.repos.onDidChange(() => this.scheduleRefresh(true)),
      vscode.window.onDidChangeWindowState((s) => {
        // Back to the window: files in other worktrees may have changed
        // without a git event this window can see.
        if (s.focused) this.scheduleRefresh(true);
      }),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: WorktreesToHost) => void this.onMessage(m), undefined, this.disposables);
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
    view.onDidChangeVisibility(
      () => {
        if (view.visible) {
          this.scheduleRefresh(false);
          void this.post({ type: "revalidate" } as never);
        }
      },
      undefined,
      this.disposables,
    );
  }

  /** Read tier 0 again now (Refresh, and after every action). */
  refresh(): void {
    this.scheduleRefresh(true, 0);
  }

  // ── Messages ──────────────────────────────────────────────────────────────

  private async onMessage(m: WorktreesToHost): Promise<void> {
    switch (m.type) {
      case "ready":
        // A new page (the view was moved or reloaded) has nothing: send all.
        this.lastRowsSig = "";
        this.lastStatusSig.clear();
        this.lastDetailsSig.clear();
        this.expanded.clear();
        this.postSeed();
        this.scheduleRefresh(false, 0);
        return;
      case "refresh":
        this.refresh();
        return;
      case "visible":
        this.visible = new Set(m.paths.filter((p) => typeof p === "string"));
        for (const p of this.visible) this.want(p, false);
        return;
      case "expand":
        if (typeof m.path !== "string") return;
        this.expanded.add(m.path);
        await this.sendDetails(m.path);
        return;
      case "collapse":
        this.expanded.delete(m.path);
        this.lastDetailsSig.delete(m.path);
        return;
      case "commitFiles":
        await this.sendCommitFiles(m.path, m.sha);
        return;
      case "openFile":
        await this.openUncommitted(m.path, m.file);
        return;
      case "openCommitFile":
        await this.openCommitFile(m.path, m.sha, m.parent, m.file);
        return;
      case "action":
        await this.act(m.path, m.action);
        return;
      case "add":
        await addWorktree(this.repos, () => this.refresh());
        return;
      case "prune":
        await pruneWorktrees(this.repos, () => this.refresh());
        return;
    }
  }

  /** The row actions, by what the page asked. */
  private async act(p: string, action: WorktreeAction): Promise<void> {
    if (typeof p !== "string") return;
    const refresh = () => this.refresh();
    const ui: WorktreeUi = {
      busy: (at, label) => this.setBusy(at, label),
      patch: (at, row) => void this.post({ type: "patch", path: at, row }),
      drop: (at) => {
        this.statuses.delete(at);
        this.expanded.delete(at);
        void this.post({ type: "drop", path: at });
      },
    };
    // Only what the row offers; a stale page cannot ask for more.
    const row = this.rowFor(p);
    if (row) {
      const caps = worktreeCaps(row);
      const gate =
        action === "pull"
          ? caps.pull
          : action === "push"
            ? caps.push
            : action === "remove"
              ? caps.remove
              : action === "openHere"
                ? caps.openHere
                : action === "openNew"
                  ? caps.openNew
                  : action === "lock"
                    ? caps.lock
                    : action === "unlock"
                      ? caps.unlock
                      : undefined;
      if (gate && !gate.ok) {
        void vscode.window.showInformationMessage(l10n.t("GitStudio: {0}", gate.why));
        return;
      }
    }
    switch (action) {
      case "openHere":
        return openWorktreeIn(this.repos, p, "here");
      case "openNew":
        return openWorktreeIn(this.repos, p, "new");
      case "reveal":
        return revealWorktree(this.repos, p);
      case "terminal":
        return openWorktreeTerminal(this.repos, p);
      case "copyPath":
        return copyWorktreePath(this.repos, p);
      case "pull":
        await pullWorktree(this.repos, p, refresh, ui);
        this.statuses.delete(p);
        return;
      case "push": {
        const target = await pushTargetFor(this.repos, p);
        if (target === "active") await this.deps.openPushReview(undefined);
        else if (target) await this.deps.openPushReview(target);
        return;
      }
      case "lock":
        return lockWorktree(this.repos, p, true, refresh, ui);
      case "unlock":
        return lockWorktree(this.repos, p, false, refresh, ui);
      case "remove":
        await removeWorktree(this.repos, p, refresh, ui);
        this.deps.onChanged?.();
        return;
      case "forget":
        await forgetWorktree(this.repos, p, refresh, ui);
        return;
    }
  }

  private setBusy(p: string, label: string | undefined): void {
    if (label) this.busy.set(p, label);
    else this.busy.delete(p);
    void this.post({ type: "busy", path: p, busy: !!label, ...(label ? { label } : {}) });
  }

  // ── Tier 0 ────────────────────────────────────────────────────────────────

  /**
   * Read the list again soon. `stale`: something may have changed in the
   * working trees too, so every row's tier 1 is read again when next wanted.
   */
  private scheduleRefresh(stale: boolean, delay = 120): void {
    if (stale) {
      for (const s of this.statuses.values()) s.at = 0;
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      void this.readList();
    }, delay);
  }

  private async readList(): Promise<void> {
    if (this.refreshing) {
      this.refreshAgain = true;
      return this.refreshing;
    }
    this.refreshing = (async () => {
      do {
        this.refreshAgain = false;
        await this.readListOnce();
      } while (this.refreshAgain);
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  private async readListOnce(): Promise<void> {
    const view = this.view;
    if (!view || !view.visible) {
      return; // no reads while hidden; showing it again reads
    }
    const a = this.repos.getActive();
    if (!a) {
      this.snap = undefined;
      this.sendRows([], this.repos.isDiscovering?.() ? "discovering" : "noRepo");
      return;
    }
    let snap: WorktreesSnapshot;
    try {
      snap = await a.ctx.worktrees.snapshot();
    } catch {
      this.sendRows(this.currentRows(), "failed");
      return;
    }
    if (snap.worktrees.length === 0) {
      // A valid repository always lists its main worktree: a failed read.
      this.sendRows(this.currentRows(), this.snap ? "ok" : "failed");
      return;
    }
    const here = worktreesOpenHere(
      snap.worktrees.map((w) => ({ path: w.path, head: w.head, bare: w.bare, branch: w.branch })),
      a.root,
    );
    if (this.snap && this.snap.root !== a.root) {
      this.statuses.clear();
      this.expanded.clear();
      this.lastStatusSig.clear();
    }
    this.snap = { root: a.root, snap, here };
    // Forget what belongs to worktrees that are gone.
    const paths = new Set(snap.worktrees.map((w) => w.path));
    for (const p of [...this.statuses.keys()]) if (!paths.has(p)) this.statuses.delete(p);
    for (const p of [...this.expanded]) if (!paths.has(p)) this.expanded.delete(p);
    void this.store.update(this.storeKey(a.root), snap);
    this.sendRows(this.currentRows(), "ok");
    // Tier 1 for what is in view, this window's worktree and the open rows.
    for (const w of snap.worktrees) {
      if (here.has(w.path) || this.visible.has(w.path) || this.expanded.has(w.path)) {
        this.want(w.path, false);
      }
    }
    for (const p of this.expanded) void this.sendDetails(p, true);
  }

  private currentRows(): WorktreeRow[] {
    const s = this.snap;
    if (!s) return [];
    return s.snap.worktrees.map((w) => worktreeRow(w, s.snap, s.here, this.statuses.get(w.path)?.status));
  }

  private rowFor(p: string): WorktreeRow | undefined {
    return this.currentRows().find((r) => r.path === p || sameFolder(r.path, p));
  }

  private sendRows(rows: WorktreeRow[], state: "ok" | "noRepo" | "discovering" | "failed"): void {
    const sig = JSON.stringify([rows, state]);
    if (sig === this.lastRowsSig) return;
    this.lastRowsSig = sig;
    for (const r of rows) {
      if (r.status) this.lastStatusSig.set(r.path, JSON.stringify(r.status));
    }
    void this.post({ type: "rows", rows, state, labels: { reveal: revealLabel() } } as WorktreesToPage);
  }

  /** The last list this workspace saw, painted at once while git answers. */
  private postSeed(): void {
    const a = this.repos.getActive();
    if (!a || this.snap) {
      if (this.snap) this.sendRows(this.currentRows(), "ok");
      return;
    }
    const seed = this.store.get<WorktreesSnapshot>(this.storeKey(a.root));
    if (!seed || !Array.isArray(seed.worktrees) || seed.worktrees.length === 0) return;
    const here = worktreesOpenHere(
      seed.worktrees.map((w) => ({ path: w.path, head: w.head, bare: w.bare, branch: w.branch })),
      a.root,
    );
    // The folders are asked again: the seed may be days old.
    const rows = seed.worktrees.map((w, i) => {
      const missing = !w.bare && !existsSync(w.path);
      const unlinked = !w.bare && i > 0 && !missing && (!!w.prunable || !existsSync(path.join(w.path, ".git")));
      return worktreeRow({ ...w, missing, unlinked }, seed, here, undefined);
    });
    this.sendRows(rows, "ok");
  }

  private storeKey(root: string): string {
    return `gitstudio.worktrees.snapshot:${root}`;
  }

  // ── Tier 1 ────────────────────────────────────────────────────────────────

  /** Read a row's tier 1 soon, unless it is fresh (`force`: even then). */
  private want(p: string, force: boolean): void {
    const s = this.snap;
    if (!s || !this.view?.visible) return;
    const w = s.snap.worktrees.find((x) => x.path === p);
    if (!w || w.bare || w.missing || w.unlinked) return;
    const read = this.statuses.get(p);
    if (!force && read && Date.now() - read.at < STATUS_TTL_MS) return;
    if (this.queued.has(p)) return;
    this.queued.add(p);
    // This window's worktree and the open rows first.
    if (s.here.has(p) || this.expanded.has(p)) this.queue.unshift(p);
    else this.queue.push(p);
    this.pump();
  }

  private pump(): void {
    while (this.running < STATUS_CONCURRENCY && this.queue.length > 0) {
      const p = this.queue.shift()!;
      this.queued.delete(p);
      this.running++;
      void this.readStatus(p).finally(() => {
        this.running--;
        this.pump();
      });
    }
  }

  private async readStatus(p: string): Promise<void> {
    const s = this.snap;
    const a = this.repos.getActive();
    if (!s || !a || !this.view?.visible) return;
    const w = s.snap.worktrees.find((x) => x.path === p);
    if (!w) return;
    let status: WorktreeStatus | undefined;
    try {
      status = await a.ctx.worktrees.status(w, s.snap);
    } catch {
      status = undefined;
    }
    // Gone from the list (or another repository became active) meanwhile.
    if (!this.snap || this.snap.root !== s.root || !this.snap.snap.worktrees.some((x) => x.path === p)) return;
    this.statuses.set(p, { at: Date.now(), status });
    const row = status ? rowStatus(status) : null;
    const sig = JSON.stringify(row);
    if (this.lastStatusSig.get(p) === sig) return;
    this.lastStatusSig.set(p, sig);
    void this.post({ type: "status", path: p, status: row });
    // The page now has what the next list would say: keep the rows'
    // signature in step, so that list is not sent again for nothing.
    this.lastRowsSig = JSON.stringify([this.currentRows(), "ok"]);
  }

  // ── Tier 2 ────────────────────────────────────────────────────────────────

  /** An open row's files and commits. `quiet`: a refresh, not the open itself. */
  private async sendDetails(p: string, quiet = false): Promise<void> {
    const s = this.snap;
    const a = this.repos.getActive();
    if (!s || !a) return;
    const w = s.snap.worktrees.find((x) => x.path === p);
    if (!w || w.bare || w.missing || w.unlinked) return;
    let status = this.statuses.get(p);
    if (!status || !status.status || Date.now() - status.at > (quiet ? STATUS_TTL_MS : 1500)) {
      await this.readStatus(p);
      status = this.statuses.get(p);
    }
    const row = worktreeRow(w, s.snap, s.here, status?.status);
    const files = status?.status?.files ?? [];
    const rule = unpublishedRule(w, s.snap);
    const range = unpublishedRange(rule);
    const title = unpublishedTitle(row);
    const toCommit = (c: { sha: string; parents: string[]; subject: string; author: string; date: number }): ChangeCommit => ({
      sha: c.sha,
      parents: c.parents,
      subject: c.subject,
      author: c.author,
      date: c.date,
    });
    const [unpushed, toPull] = await Promise.all([
      range && title ? a.ctx.worktrees.commits(w.path, range, WORKTREE_COMMITS_SHOWN) : undefined,
      w.upstream && !w.upstreamGone && w.behind > 0
        ? a.ctx.worktrees.commits(w.path, [`HEAD..${w.upstream}`], WORKTREE_COMMITS_SHOWN)
        : undefined,
    ]);
    const details: WorktreeDetails = {
      files: files.slice(0, WORKTREE_FILES_SHOWN).map(toChangeFile),
      filesTotal: files.length,
      // Unread is not clean: the row says it couldn't read them.
      ...(status?.status ? {} : { filesUnread: true as const }),
      ...(unpushed && title ? { unpushed: { title, commits: unpushed.commits.map(toCommit), more: unpushed.more } } : {}),
      ...(toPull && row.upstream
        ? { toPull: { title: l10n.t("To pull from {0}", row.upstream), commits: toPull.commits.map(toCommit), more: toPull.more } }
        : {}),
    };
    if (!this.expanded.has(p)) return;
    // A refresh that found the same sends nothing (the open row stays as it is).
    const sig = JSON.stringify(details);
    if (quiet && this.lastDetailsSig.get(p) === sig) return;
    this.lastDetailsSig.set(p, sig);
    void this.post({ type: "details", path: p, details });
  }

  private async sendCommitFiles(p: string, sha: string): Promise<void> {
    const a = this.repos.getActive();
    if (!a || typeof sha !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return;
    // null when git can't read the commit — the page says so, where an empty
    // list would read "No file changes in this commit" (the push review's
    // sibling, sendPushCommitFiles, answers the same way).
    let files: ChangeFile[] | null;
    try {
      const parents = await a.ctx.process.run(["rev-list", "--parents", "-n", "1", sha]);
      files = parents.code === 0 ? await a.ctx.commitDetails.getCommitFiles(sha, parents.stdout.trim().split(" ")[1]) : null;
    } catch {
      files = null;
    }
    void this.post({ type: "commitFiles", path: p, sha, files });
  }

  // ── Diffs, in THAT worktree ───────────────────────────────────────────────

  /**
   * An uncommitted file of a worktree: staged — HEAD against its index;
   * unstaged — its index against its working file; untracked or conflicted —
   * the file itself. Each side is read in THAT worktree (the revision URIs
   * name its folder; see RevisionContentProvider).
   */
  private async openUncommitted(p: string, f: ChangeFile): Promise<void> {
    const row = this.rowFor(p);
    if (!row || row.missing || !f || typeof f.path !== "string") return;
    const root = row.path;
    const name = f.path.split("/").pop() ?? f.path;
    const title = (sides: string) => `${name} (${sides}) — ${row.name}`;
    if (f.area === "untracked" || f.area === "conflicted") {
      await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(path.join(root, f.path)));
      return;
    }
    if (f.area === "staged") {
      const left = f.status === "A" ? { rev: EMPTY_TREE, path: f.path } : { rev: "HEAD", path: f.oldPath ?? f.path };
      const right = f.status === "D" ? { rev: EMPTY_TREE, path: f.path } : { rev: "", path: f.path };
      await openSidesDiff(root, f.path, { left, right }, title(l10n.t("HEAD ↔ Index")));
      return;
    }
    const left = { rev: "", path: f.oldPath ?? f.path };
    const right = f.status === "D" ? { rev: EMPTY_TREE, path: f.path } : { rev: undefined };
    await vscode.commands.executeCommand(
      "vscode.diff",
      revisionSideUri(root, f.path, left),
      revisionSideUri(root, f.path, right),
      title(l10n.t("Index ↔ Working Tree")),
      { preview: true } satisfies vscode.TextDocumentShowOptions,
    );
  }

  /** A file under a commit: what that commit did to it. */
  private async openCommitFile(p: string, sha: string, parent: string | undefined, f: ChangeFile): Promise<void> {
    const row = this.rowFor(p);
    if (!row || !f || typeof f.path !== "string" || !/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return;
    const first = parent && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(parent) ? parent : EMPTY_TREE;
    const sides = commitChangeSides({ sha, parent: first, path: f.path, oldPath: f.oldPath, status: f.status });
    const name = f.path.split("/").pop() ?? f.path;
    await openSidesDiff(row.path, f.path, sides, `${name} (${sha.slice(0, 7)}) — ${row.name}`);
  }

  // ── The page ──────────────────────────────────────────────────────────────

  private post(msg: WorktreesToPage | { type: "revalidate" }): Thenable<boolean> | undefined {
    return this.view?.webview.postMessage(msg);
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const dist = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "dist", ...parts));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `font-src ${webview.cspSource} data:`,
      `script-src 'nonce-${nonce}' ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${dist("codicons", "codicon.css")}" rel="stylesheet" />
  <link href="${dist("webview", "worktrees.css")}" rel="stylesheet" />
  <title>${l10n.t("Worktrees")}</title>
</head>
<body>
  <div id="root"></div>
  ${l10nWebviewScript(nonce)}
  <script nonce="${nonce}" src="${dist("webview", "worktrees.js")}"></script>
</body>
</html>`;
  }

  dispose(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
