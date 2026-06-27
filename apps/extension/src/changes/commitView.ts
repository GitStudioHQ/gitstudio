import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { Change } from "../git/git";
import { getNonce } from "../webview/html";
import {
  openChangeDiff,
  relativePath,
  ChangeFileNode,
  statusLetter,
  type GroupKind,
} from "./changesView";

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

/** A local branch row for the branch menu (folds in the old Branches view). */
interface BranchRefPayload {
  name: string;
  current: boolean;
  upstream?: string;
  favorite: boolean;
}

/** Everything the branch menu needs: local branches (with favorites), remotes, recents. */
interface BranchesPayload {
  local: BranchRefPayload[];
  remote: string[];
  recent: string[];
}

interface StatePayload {
  type: "state";
  /** Whether a repository is open — drives the no-repo onboarding state. */
  hasRepo: boolean;
  merge: FileEntry[];
  staged: FileEntry[];
  unstaged: FileEntry[];
  stagedCount: number;
  branch?: string;
  /** Branch + remote lists driving the in-header branch/actions menu. */
  branches?: BranchesPayload;
  /** Upstream tracking ref (e.g. "origin/main"), when the branch tracks one. */
  upstream?: string;
  /** Commits the local branch is ahead of its upstream. */
  ahead?: number;
  /** Commits the local branch is behind its upstream. */
  behind?: number;
  /** Short repo/workspace name shown in the header. */
  repoName?: string;
  lastMessage?: string;
  signoffDefault: boolean;
  aiEnabled: boolean;
  layout: "tree" | "list";
  busy: boolean;
}

interface FromWebview {
  type:
    | "ready"
    | "commit"
    | "generateMessage"
    | "stage"
    | "unstage"
    | "discard"
    | "openDiff"
    | "stageAll"
    | "unstageAll"
    | "discardAll"
    | "setLayout"
    | "amendToggled"
    | "branchAction"
    | "branchRefCommand"
    | "openFolder"
    | "openGraph";
  path?: string;
  staged?: boolean;
  group?: GroupKind;
  layout?: "tree" | "list";
  message?: string;
  amend?: boolean;
  signoff?: boolean;
  author?: string;
  push?: boolean;
  /** Branch-menu sub-action: checkout | checkoutRemote | new | checkoutRef | pull | pullRebase | push | fetch | favorite. */
  action?: string;
  /** The ref a branch action targets (branch name or "remote/branch"). */
  ref?: string;
  /** A `gitstudio.*` command id to run with a synthetic `{ ref }` arg (branch action submenu). */
  command?: string;
  /** The kind of ref the submenu command targets: "head" (local) | "remote" | "tag". */
  refType?: "head" | "remote" | "tag";
}

/**
 * The host-side hook the commit box uses to draft a message from the staged
 * diff. Injected (not imported) so this view stays decoupled from GitBrain and
 * the key stays 100% host-side — the webview only ever receives the result text.
 * Returns null when AI is unavailable or nothing is staged.
 */
export interface CommitMessageGenerator {
  isEnabled(): Promise<boolean>;
  draft(entry: RepoEntry): Promise<string | null>;
}

const LAYOUT_KEY = "gitstudio.commit.layout";

export class CommitViewProvider
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly viewId = "gitstudio.commit";

  private view: vscode.WebviewView | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;

  constructor(
    /** The extension root URI, for loading bundled assets (the codicon font). */
    private readonly extensionUri: vscode.Uri,
    private readonly repos: RepoManager,
    private readonly onCommitted: () => void,
    /** Persists the tree/list layout choice across reloads. */
    private readonly memento: vscode.Memento,
    /** Optional GitBrain hook for the "Generate message" sparkle button. */
    private readonly generator?: CommitMessageGenerator,
  ) {
    this.disposables.push(this.repos.onDidChange(() => void this.pushState()));
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
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
        void this.pushState();
      }
    });
    void this.pushState();
  }

  /** Re-push state (staged count + change lists) after an external op. */
  requestState(): void {
    void this.pushState();
  }

  private async onMessage(msg: FromWebview): Promise<void> {
    switch (msg.type) {
      case "ready":
        await this.pushState();
        return;
      case "amendToggled":
        await this.pushState(!!msg.amend);
        return;
      case "branchAction":
        await this.handleBranchAction(msg);
        return;
      case "branchRefCommand":
        await this.handleBranchRefCommand(msg);
        return;
      case "openFolder":
        await vscode.commands.executeCommand("vscode.openFolder");
        return;
      case "openGraph":
        await vscode.commands.executeCommand("gitstudio.showCommitGraph");
        return;
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
        await this.mutate((entry) =>
          entry.ctx.staging.stageFile(msg.path ?? ""),
        );
        return;
      case "unstage":
        await this.mutate((entry) =>
          entry.ctx.staging.unstageFile(msg.path ?? ""),
        );
        return;
      case "discard":
        await this.doDiscard(msg.path ?? "");
        return;
      case "openDiff":
        this.doOpenDiff(msg.path ?? "", !!msg.staged);
        return;
      case "stageAll":
        await this.doBulkStage(msg.group);
        return;
      case "unstageAll":
        await this.doBulkUnstage();
        return;
      case "discardAll":
        await this.doDiscardAll();
        return;
    }
  }

  /** Run a per-file staging op against the active repo, then refresh everything. */
  private async mutate(
    op: (entry: RepoEntry) => Promise<unknown>,
  ): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      return;
    }
    try {
      await op(entry);
    } catch {
      // Surface nothing destructive here — a failed stage just leaves state.
    }
    // Nudge vscode.git to re-scan so the change lists update promptly.
    void entry.repo.status?.();
    this.onCommitted();
    await this.pushState();
  }

  private async doDiscard(path: string): Promise<void> {
    if (!path) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Discard changes in ${path}? This cannot be undone.`,
      { modal: true },
      "Discard",
    );
    if (choice !== "Discard") {
      return;
    }
    await this.mutate((entry) => entry.ctx.staging.discardChanges(path));
  }

  private doOpenDiff(path: string, staged: boolean): void {
    const entry = this.repos.getActive();
    if (!entry || !path) {
      return;
    }
    const state = entry.repo.state;
    const kind: GroupKind = staged ? "staged" : "unstaged";
    const pool = staged
      ? state.indexChanges
      : findIn(state.mergeChanges, entry.root, path)
        ? state.mergeChanges
        : state.workingTreeChanges;
    const change = findIn(pool, entry.root, path);
    if (!change) {
      return;
    }
    const isMerge = pool === state.mergeChanges;
    const node = new ChangeFileNode(isMerge ? "merge" : kind, entry.root, change);
    void openChangeDiff(node);
  }

  private async doBulkStage(group?: GroupKind): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      return;
    }
    const state = entry.repo.state;
    const changes =
      group === "merge" ? state.mergeChanges : state.workingTreeChanges;
    await this.mutate(async (e) => {
      for (const c of changes) {
        await e.ctx.staging.stageFile(relativePath(e.root, c.uri.fsPath));
      }
    });
  }

  private async doBulkUnstage(): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      return;
    }
    const changes = entry.repo.state.indexChanges.slice();
    await this.mutate(async (e) => {
      for (const c of changes) {
        await e.ctx.staging.unstageFile(relativePath(e.root, c.uri.fsPath));
      }
    });
  }

  private async doDiscardAll(): Promise<void> {
    const entry = this.repos.getActive();
    if (!entry) {
      return;
    }
    const changes = entry.repo.state.workingTreeChanges.slice();
    if (changes.length === 0) {
      return;
    }
    const choice = await vscode.window.showWarningMessage(
      `Discard all ${changes.length} working-tree changes? This cannot be undone.`,
      { modal: true },
      "Discard All",
    );
    if (choice !== "Discard All") {
      return;
    }
    await this.mutate(async (e) => {
      for (const c of changes) {
        await e.ctx.staging.discardChanges(relativePath(e.root, c.uri.fsPath));
      }
    });
  }

  /**
   * Draft a commit message from the staged diff via GitBrain and fill the box.
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
          "$(sparkle) GitBrain: nothing to draft (stage changes first)",
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
      void vscode.window.showInformationMessage(
        "GitStudio: no Git repository is active.",
      );
      return;
    }
    const message = (msg.message ?? "").trim();
    if (message === "" && !msg.amend) {
      void vscode.window.showWarningMessage(
        "GitStudio: enter a commit message.",
      );
      return;
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
        void vscode.window.showErrorMessage(
          `GitStudio: commit failed — ${result.stderr.trim() || "unknown error"}`,
        );
        return;
      }

      if (msg.push) {
        const push = await entry.ctx.process.run(["push"]);
        if (push.code !== 0) {
          void vscode.window.showErrorMessage(
            `GitStudio: commit succeeded, but push failed — ${
              push.stderr.trim() || "unknown error"
            }`,
          );
        } else {
          void vscode.window.setStatusBarMessage("$(check) Committed & pushed", 3000);
        }
      } else {
        void vscode.window.setStatusBarMessage("$(check) Committed", 3000);
      }

      // Clear the box and refresh the views.
      this.view?.webview.postMessage({ type: "clear" });
      void entry.repo.status?.();
      this.onCommitted();
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
  private async noteRecentBranch(entry: RepoEntry, name: string): Promise<void> {
    const prev = this.memento.get<string[]>(this.recentKey(entry), []);
    const next = [name, ...prev.filter((n) => n !== name)].slice(0, 8);
    await this.memento.update(this.recentKey(entry), next);
  }

  /** Local branches (with favorites), remotes, and recents for the branch menu. */
  private async collectBranches(entry: RepoEntry): Promise<BranchesPayload> {
    let refs: Awaited<ReturnType<typeof entry.ctx.refs.listRefs>> = [];
    try {
      refs = await entry.ctx.refs.listRefs();
    } catch {
      refs = [];
    }
    const favs = new Set(this.favorites(entry));
    const local: BranchRefPayload[] = refs
      .filter((r) => r.type === "head")
      .map((r) => ({
        name: r.name,
        current: r.isCurrent,
        upstream: r.upstream,
        favorite: favs.has(r.name),
      }));
    const remote = refs
      .filter((r) => r.type === "remote" && !r.name.endsWith("/HEAD"))
      .map((r) => r.name);
    const recent = this.memento.get<string[]>(this.recentKey(entry), []);
    return { local, remote, recent };
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
    let result: { ok: boolean; stderr?: string } = { ok: true };
    try {
      switch (msg.action) {
        case "checkout":
          result = await entry.ctx.branches.checkout(ref);
          if (result.ok) await this.noteRecentBranch(entry, ref);
          break;
        case "checkoutRemote": {
          // origin/feature → local "feature" tracking the remote (git DWIM).
          const local = ref.split("/").slice(1).join("/") || ref;
          result = await entry.ctx.branches.checkout(local);
          if (result.ok) await this.noteRecentBranch(entry, local);
          break;
        }
        case "new": {
          const name = await vscode.window.showInputBox({
            title: "New Branch",
            prompt: "Create and switch to a new branch from HEAD",
            placeHolder: "feature/my-change",
            validateInput: (v) =>
              v && /\s/.test(v) ? "Branch names can't contain spaces" : undefined,
          });
          if (!name) return;
          result = await entry.ctx.branches.checkoutNew(name.trim());
          if (result.ok) await this.noteRecentBranch(entry, name.trim());
          break;
        }
        case "checkoutRef": {
          const r = await vscode.window.showInputBox({
            title: "Checkout Tag or Revision",
            prompt: "Check out a tag, commit, or revision (detached HEAD)",
            placeHolder: "v1.2.0   ·   a1b2c3d   ·   origin/main~3",
          });
          if (!r) return;
          result = await entry.ctx.branches.checkout(r.trim(), { detach: true });
          break;
        }
        case "pull":
          result = await entry.ctx.sync.pull();
          break;
        case "pullRebase":
          result = await entry.ctx.sync.pull({ rebase: true });
          break;
        case "push":
          result = await entry.ctx.sync.push();
          break;
        case "fetch":
          result = await entry.ctx.sync.fetch();
          break;
        default:
          return;
      }
    } catch (err) {
      result = { ok: false, stderr: err instanceof Error ? err.message : String(err) };
    }
    if (!result.ok) {
      void vscode.window.showErrorMessage(
        `GitStudio: ${msg.action} failed${result.stderr ? ` — ${result.stderr.trim()}` : ""}`,
      );
    }
    void entry.repo.status?.();
    this.onCommitted();
    await this.pushState();
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
    } catch (err) {
      void vscode.window.showErrorMessage(
        `GitStudio: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    void entry.repo.status?.();
    this.onCommitted();
    await this.pushState();
  }

  /**
   * Pushes the full state to the webview: branch, staged count, the merge /
   * staged / unstaged change lists, AI availability, and — when `amend` is
   * requested — the last commit's subject+body to prefill the message.
   */
  private async pushState(amend = false): Promise<void> {
    if (!this.view) {
      return;
    }
    const entry = this.repos.getActive();
    const state = entry?.repo.state;

    const toEntries = (changes: Change[] | undefined): FileEntry[] =>
      (changes ?? []).map((c) => ({
        path: relativePath(entry!.root, c.uri.fsPath),
        status: statusLetter(c.status),
      }));

    const merge = entry ? toEntries(state?.mergeChanges) : [];
    const staged = entry ? toEntries(state?.indexChanges) : [];
    const unstaged = entry ? toEntries(state?.workingTreeChanges) : [];
    const stagedCount = entry ? await this.countStaged(entry) : 0;
    const head = state?.HEAD;
    const branch = head?.name;
    const upstream = head?.upstream
      ? `${head.upstream.remote}/${head.upstream.name}`
      : undefined;
    const ahead = head?.ahead;
    const behind = head?.behind;
    const repoName = entry
      ? entry.root.split(/[\\/]/).filter(Boolean).pop()
      : undefined;
    const lastMessage =
      amend && entry ? await this.lastMessage(entry) : undefined;
    const signoffDefault = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("commit.signoffByDefault", false);
    const aiEnabled = this.generator
      ? await this.generator.isEnabled().catch(() => false)
      : false;
    const layout =
      this.memento.get<"tree" | "list">(LAYOUT_KEY) === "tree" ? "tree" : "list";
    const branches = entry ? await this.collectBranches(entry) : undefined;

    const payload: StatePayload = {
      type: "state",
      hasRepo: !!entry,
      merge,
      staged,
      unstaged,
      stagedCount,
      branch,
      branches,
      upstream,
      ahead,
      behind,
      repoName,
      lastMessage,
      signoffDefault,
      aiEnabled,
      layout,
      busy: this.busy,
    };
    void this.view.webview.postMessage(payload);
  }

  private async countStaged(entry: RepoEntry): Promise<number> {
    try {
      return await entry.ctx.staging.stagedCount();
    } catch {
      return 0;
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
    const csp = [
      `default-src 'none'`,
      // cspSource: the codicon stylesheet; nonce: our own inline <style>.
      `style-src 'nonce-${nonce}' ${webview.cspSource}`,
      // cspSource: the codicon.ttf the stylesheet @font-face references.
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link href="${codiconUri}" rel="stylesheet" />
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --gs-font-ui: var(--vscode-font-family);
      --gs-font-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
      --gs-fg: var(--vscode-foreground);
      --gs-fg-muted: var(--vscode-descriptionForeground);
      --gs-fg-subtle: color-mix(in srgb, var(--gs-fg) 50%, transparent);
      --gs-accent: var(--vscode-focusBorder);
      --gs-accent-text: var(--vscode-textLink-foreground, var(--vscode-focusBorder));
      --gs-bg: var(--vscode-sideBar-background, var(--vscode-editor-background));
      /* Theme-native elevation: lift surfaces off the base in light AND dark
         by mixing in a little foreground — no hardcoded chrome colors. */
      --gs-surface: color-mix(in srgb, var(--gs-fg) 4%, var(--gs-bg));
      --gs-surface-2: color-mix(in srgb, var(--gs-fg) 7%, var(--gs-bg));
      --gs-hover: var(--vscode-list-hoverBackground, color-mix(in srgb, var(--gs-fg) 7%, transparent));
      --gs-border: color-mix(in srgb, var(--gs-fg) 13%, transparent);
      --gs-border-soft: color-mix(in srgb, var(--gs-fg) 8%, transparent);
      --gs-radius: 7px;
      --gs-radius-sm: 5px;
      --gs-radius-pill: 999px;
      --gs-motion-fast: 110ms;
      --gs-motion: 170ms;
      --gs-ease: cubic-bezier(0.2, 0, 0, 1);
      --gs-shadow-1: 0 1px 2px rgba(0, 0, 0, 0.16);
      --gs-shadow-2: 0 2px 6px rgba(0, 0, 0, 0.14), 0 1px 2px rgba(0, 0, 0, 0.14);
      --gs-glow: 0 0 0 3px color-mix(in srgb, var(--gs-accent) 24%, transparent);
      --gs-status-added: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green));
      --gs-status-modified: var(--vscode-gitDecoration-modifiedResourceForeground, var(--vscode-charts-yellow));
      --gs-status-deleted: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red));
      --gs-status-untracked: var(--vscode-gitDecoration-untrackedResourceForeground, var(--vscode-charts-green));
      --gs-status-renamed: var(--vscode-gitDecoration-renamedResourceForeground, var(--vscode-charts-blue));
      --gs-status-conflict: var(--vscode-gitDecoration-conflictingResourceForeground, var(--vscode-charts-red));
      --gs-status-ignored: var(--vscode-gitDecoration-ignoredResourceForeground, var(--gs-fg-muted));
    }
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
      background: color-mix(in srgb, var(--gs-accent) 13%, transparent);
      border: 1px solid color-mix(in srgb, var(--gs-accent) 30%, transparent);
      color: var(--gs-accent-text);
      font-family: var(--gs-font-ui);
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: background var(--gs-motion-fast) var(--gs-ease),
                  border-color var(--gs-motion-fast) var(--gs-ease);
    }
    .branch:hover {
      background: color-mix(in srgb, var(--gs-accent) 20%, transparent);
      border-color: color-mix(in srgb, var(--gs-accent) 45%, transparent);
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
    .branch[aria-expanded="true"] {
      background: color-mix(in srgb, var(--gs-accent) 22%, transparent);
      border-color: color-mix(in srgb, var(--gs-accent) 55%, transparent);
    }
    .sync { display: inline-flex; align-items: center; gap: 5px; margin-left: auto; flex: 0 0 auto; }
    .sync.hidden { display: none; }
    .sync-pill {
      display: none;
      align-items: center;
      gap: 3px;
      height: 19px;
      padding: 0 7px 0 5px;
      border-radius: var(--gs-radius-pill);
      font-size: 11px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      color: var(--gs-fg-muted);
      background: color-mix(in srgb, var(--gs-fg) 9%, transparent);
      white-space: nowrap;
    }
    .sync-pill.visible { display: inline-flex; }
    .sync-pill svg { width: 11px; height: 11px; }
    .sync-pill.ahead.visible { color: var(--gs-status-added); background: color-mix(in srgb, var(--gs-status-added) 14%, transparent); }
    .sync-pill.behind.visible { color: var(--gs-status-modified); background: color-mix(in srgb, var(--gs-status-modified) 16%, transparent); }
    .sync-clean {
      display: none;
      align-items: center;
      gap: 4px;
      font-size: 11px;
      color: var(--gs-fg-subtle);
    }
    .sync-clean.visible { display: inline-flex; }
    .sync-clean svg { width: 12px; height: 12px; }

    /* ---- Branch + actions menu (popover; folds in the Branches view) ---- */
    .branch-menu {
      position: fixed;
      z-index: 50;
      min-width: 248px;
      max-width: 288px;
      max-height: 72vh;
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
    .bm-list { overflow-y: auto; padding: 3px; }
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
    .bm-action:hover, .bm-branch:hover { background: var(--gs-hover); }
    /* A collapsible category header: chevron + label + count, full-width button. */
    .bm-sep {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 100%;
      margin: 4px 0 1px;
      padding: 4px 8px;
      border: none;
      background: transparent;
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
    .bm-sep-label { flex: 1 1 auto; }
    .bm-sep-count {
      flex: 0 0 auto;
      font-variant-numeric: tabular-nums;
      letter-spacing: 0;
      color: var(--gs-fg-subtle);
    }
    .bm-hl { background: color-mix(in srgb, var(--gs-accent) 34%, transparent); color: inherit; border-radius: 2px; }
    .bm-branch { padding: 4px 8px 4px 4px; }
    .bm-branch.is-current .bm-bname { color: var(--gs-accent-text); font-weight: 600; }
    .bm-branch.is-current .bm-bicon { color: var(--gs-accent-text); }
    .bm-bname { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-bup { flex: 0 1 auto; font-size: 10.5px; color: var(--gs-fg-subtle); max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-bmore { flex: 0 0 auto; font-size: 13px; color: var(--gs-fg-subtle); opacity: 0; transition: opacity 100ms; }
    .bm-branch:hover .bm-bmore { opacity: 0.8; }

    /* Per-branch action submenu (flyout). */
    .branch-submenu {
      position: fixed;
      z-index: 60;
      min-width: 210px;
      max-width: 320px;
      display: flex;
      flex-direction: column;
      padding: 4px;
      background: var(--vscode-menu-background, var(--gs-surface));
      border: 1px solid var(--vscode-menu-border, var(--gs-border));
      border-radius: var(--gs-radius);
      box-shadow: var(--gs-shadow-2);
    }
    .bm-subhead {
      display: flex; align-items: center; gap: 7px;
      padding: 5px 8px 7px;
      margin-bottom: 3px;
      border-bottom: 1px solid var(--gs-border);
      color: var(--gs-fg-muted);
    }
    .bm-subhead .codicon { font-size: 13px; }
    .bm-subhead-name { font-size: 12px; font-weight: 600; color: var(--gs-fg); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .bm-sublist { display: flex; flex-direction: column; }
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
    .bm-subaction:hover { background: var(--gs-hover); }
    .bm-subaction.danger { color: var(--vscode-errorForeground, #e15a5a); }
    .bm-subaction.danger .codicon { color: var(--vscode-errorForeground, #e15a5a); }
    .bm-subaction.danger:hover { background: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 14%, transparent); }
    .bm-subsep { height: 1px; margin: 4px 6px; background: var(--gs-border); }
    .bm-star, .bm-star-spacer {
      flex: 0 0 auto;
      width: 22px; height: 22px;
      display: inline-flex; align-items: center; justify-content: center;
      border: none; background: transparent; border-radius: var(--gs-radius-sm);
      color: var(--gs-fg-subtle); cursor: pointer; padding: 0;
    }
    .bm-star:hover { background: color-mix(in srgb, var(--gs-fg) 10%, transparent); color: var(--gs-fg); }
    .bm-star.on { color: var(--vscode-charts-yellow, #d7ba00); }
    .bm-star .codicon { font-size: 13px; }
    .bm-empty { padding: 10px 8px; color: var(--gs-fg-muted); font-size: 12px; text-align: center; }

    /* ---- Message composer (elevated card) ----------------------------- */
    .message-wrap {
      position: relative;
      margin: 0 2px;
      background: var(--vscode-input-background, var(--gs-surface));
      border: 1px solid var(--gs-border);
      border-radius: var(--gs-radius);
      box-shadow: var(--gs-shadow-1);
      transition: border-color var(--gs-motion) var(--gs-ease),
                  box-shadow var(--gs-motion) var(--gs-ease);
    }
    .message-wrap:focus-within {
      border-color: var(--gs-accent);
      box-shadow: var(--gs-glow);
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
    .counter.warn { color: var(--gs-status-modified); }
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
      margin: 6px 2px 6px;
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
      color: var(--gs-accent-text);
      background: color-mix(in srgb, var(--gs-accent) 12%, transparent);
    }
    .toggles input[type="checkbox"] {
      accent-color: var(--gs-accent);
      width: 13px; height: 13px;
      margin: 0;
    }

    /* ---- Author override row ------------------------------------------ */
    .author-row { margin: 0 2px 8px; }
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

    /* ---- Action buttons ----------------------------------------------- */
    .actions { display: flex; gap: 6px; margin: 0 2px; }
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
      transition: background var(--gs-motion) var(--gs-ease),
                  box-shadow var(--gs-motion) var(--gs-ease),
                  transform var(--gs-motion-fast) var(--gs-ease),
                  opacity var(--gs-motion) var(--gs-ease);
    }
    button.gs-commit svg { width: 14px; height: 14px; flex: 0 0 auto; }
    button.primary {
      flex: 1;
      color: var(--vscode-button-foreground);
      /* Subtle vertical sheen over the theme accent — reads as a real,
         tactile primary action without leaving the theme palette. */
      background:
        linear-gradient(180deg,
          color-mix(in srgb, var(--vscode-button-background) 88%, white 12%),
          var(--vscode-button-background));
      font-weight: 600;
      letter-spacing: 0.01em;
      box-shadow: var(--gs-shadow-1),
        inset 0 1px 0 color-mix(in srgb, white 16%, transparent);
    }
    button.primary:hover {
      background: var(--vscode-button-hoverBackground, var(--vscode-button-background));
      box-shadow: var(--gs-shadow-2),
        inset 0 1px 0 color-mix(in srgb, white 18%, transparent);
    }
    button.gs-commit:active { transform: translateY(0.5px); }
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
    }
    button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 2px; }
    .link:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }

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
    .changes-toolbar .toolbar-actions { display: inline-flex; align-items: center; gap: 1px; }
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
    .icon-btn.collapse-all { display: none; }
    body.layout-tree .icon-btn.collapse-all { display: inline-flex; }

    /* The layout toggle shows the OTHER mode's glyph (click to switch to it). */
    .icon-btn.layout .to-tree { display: inline-flex; }
    .icon-btn.layout .to-list { display: none; }
    body.layout-tree .icon-btn.layout .to-tree { display: none; }
    body.layout-tree .icon-btn.layout .to-list { display: inline-flex; }

    /* ---- Groups -------------------------------------------------------- */
    .groups { margin: 0 0 2px; }
    .group { margin-top: 4px; }
    .group.empty { display: none; }
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
      transition: transform var(--gs-motion) var(--gs-ease);
    }
    .group.collapsed .group-header .twisty { transform: rotate(-90deg); }
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
    .group--staged .gcount {
      background: color-mix(in srgb, var(--gs-status-added) 18%, transparent);
      color: var(--gs-status-added);
    }
    .group--merge .gcount {
      background: color-mix(in srgb, var(--gs-status-conflict) 18%, transparent);
      color: var(--gs-status-conflict);
    }
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
    /* Status accent rail, revealed on hover/focus for a tactile pointer. */
    .row::before {
      content: "";
      position: absolute;
      left: 0; top: 3px; bottom: 3px;
      width: 2px;
      border-radius: 2px;
      background: transparent;
      transition: background var(--gs-motion-fast) var(--gs-ease);
    }
    .row.is-file:hover::before { background: var(--gs-row-accent, var(--gs-accent)); }
    .row:hover { background: var(--gs-hover); }
    .row:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
    .row .indent { flex: 0 0 auto; }
    .row .twisty {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--gs-fg-muted);
      flex: 0 0 auto;
      transition: transform var(--gs-motion) ease;
    }
    .row .twisty svg { width: 12px; height: 12px; }
    .row.collapsed .twisty { transform: rotate(-90deg); }
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
    .row .dir {
      flex: 1 1 auto;
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
      opacity: 0;
      flex: 0 0 auto;
      transition: opacity var(--gs-motion) ease;
    }
    .row:hover .row-actions,
    .row:focus-within .row-actions { opacity: 1; }
    .row .status {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-family: var(--gs-font-mono);
      font-size: 10px;
      font-weight: 700;
      width: 16px;
      height: 16px;
      border-radius: 4px;
      text-align: center;
      flex: 0 0 auto;
      color: var(--gs-row-accent, var(--gs-fg-muted));
      background: color-mix(in srgb, var(--gs-row-accent, var(--gs-fg-muted)) 15%, transparent);
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
    body.no-repo .message-wrap,
    body.no-repo .toggles,
    body.no-repo .author-row,
    body.no-repo .actions,
    body.no-repo .changes-toolbar,
    body.no-repo .groups,
    body.no-repo #empty-state { display: none !important; }
    body.no-repo #no-repo { display: flex; }

    @media (prefers-reduced-motion: reduce) {
      textarea, .author-row input, .sparkle, button.gs-commit, .link .chev,
      .icon-btn, .group-actions, .row-actions, .twisty {
        transition: none;
      }
      .sparkle.loading .spinner { animation: none; }
    }
  </style>
</head>
<body class="layout-list">
  <header class="repo-bar">
    <button class="branch" id="branch-pill" type="button" title="Branch &amp; actions"
      aria-haspopup="true" aria-expanded="false">
      <i class="codicon codicon-git-branch" aria-hidden="true"></i>
      <span class="branch-name" id="branch-name">—</span>
      <i class="codicon codicon-chevron-down branch-caret" aria-hidden="true"></i>
    </button>
    <span class="sync hidden" id="sync">
      <span class="sync-pill ahead" id="ahead" title="Commits to push">
        <i class="codicon codicon-arrow-up" aria-hidden="true"></i>
        <span id="ahead-n">0</span>
      </span>
      <span class="sync-pill behind" id="behind" title="Commits to pull">
        <i class="codicon codicon-arrow-down" aria-hidden="true"></i>
        <span id="behind-n">0</span>
      </span>
      <span class="sync-clean" id="sync-clean" title="Up to date with upstream">
        <i class="codicon codicon-check" aria-hidden="true"></i>
        <span>up to date</span>
      </span>
    </span>
  </header>

  <div class="message-wrap">
    <textarea id="message" rows="1"
      placeholder="Message (what & why)…"
      aria-label="Commit message"></textarea>
    <button class="sparkle" id="generate" type="button"
      title="Generate commit message with GitBrain"
      aria-label="Generate commit message">
      <i class="codicon codicon-sparkle glyph" aria-hidden="true"></i>
      <i class="codicon codicon-loading spinner" aria-hidden="true"></i>
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
    <button class="gs-commit primary" id="commit" type="button">
      <i class="codicon codicon-git-commit" aria-hidden="true"></i>
      <span id="commit-label">Commit</span>
    </button>
    <button class="gs-commit split" id="commit-push" type="button"
      title="Commit &amp; Push" aria-label="Commit and Push">
      <i class="codicon codicon-arrow-up" aria-hidden="true"></i>
      <span>Push</span>
    </button>
  </div>

  <div class="changes-toolbar">
    <span class="changes-title">Changed Files</span>
    <span class="changes-total" id="changes-total">0</span>
    <span class="toolbar-spacer"></span>
    <span class="toolbar-actions">
      <button class="icon-btn layout" id="layout-toggle" type="button"
        title="Toggle tree / list view" aria-label="Toggle tree / list view">
        <i class="codicon codicon-list-tree to-tree" aria-hidden="true"></i>
        <i class="codicon codicon-list-flat to-list" aria-hidden="true"></i>
      </button>
      <button class="icon-btn stage-all-top" id="stage-all-top" type="button"
        title="Stage All Changes" aria-label="Stage All Changes">
        <i class="codicon codicon-add" aria-hidden="true"></i>
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

  <div class="groups" id="groups"></div>

  <div class="empty-state" id="empty-state">
    <span class="badge">
      <i class="codicon codicon-check" aria-hidden="true"></i>
    </span>
    <span class="et">Working tree clean</span>
    <span class="es">No changes to commit.</span>
  </div>

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
    const generateBtn = $("generate");
    const commitLabel = $("commit-label");
    const authorToggle = $("author-toggle");
    const groupsEl = $("groups");
    const emptyEl = $("empty-state");
    const layoutToggle = $("layout-toggle");
    const collapseAllBtn = $("collapse-all");
    const stageAllTopBtn = $("stage-all-top");
    const refreshBtn = $("refresh");
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

    let stagedCount = 0;
    let generating = false;
    let layout = "list";
    // Persisted-in-DOM collapse memory, keyed by group + folder path.
    const collapsed = Object.create(null);
    let lastState = { merge: [], staged: [], unstaged: [] };
    let branchData = { local: [], remote: [], recent: [] };

    // ---- Icon glyphs: the real VS Code codicon font ----------------------
    const ICON_FILE = '<i class="codicon codicon-file" aria-hidden="true"></i>';
    const ICON_FOLDER = '<i class="codicon codicon-folder" aria-hidden="true"></i>';
    const ICON_CHEVRON = '<i class="codicon codicon-chevron-right" aria-hidden="true"></i>';
    const ICON_STAGE = '<i class="codicon codicon-add" aria-hidden="true"></i>';
    const ICON_UNSTAGE = '<i class="codicon codicon-dash" aria-hidden="true"></i>';
    const ICON_DISCARD = '<i class="codicon codicon-discard" aria-hidden="true"></i>';

    const CONFLICT_LETTERS = new Set(["!", "U"]);
    function statusClass(letter) {
      return "st-" + (/^[A-Z!]$/.test(letter) ? letter.replace("!", "C") : "M");
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
      const subject = text.split("\\n", 1)[0].length;
      counterEl.textContent = String(subject);
      counterEl.classList.toggle("warn", subject > 50 && subject <= 72);
      counterEl.classList.toggle("over", subject > 72);
    }
    message.addEventListener("input", () => { autoGrow(); updateComposer(); });

    function setBusy(busy) {
      commitBtn.disabled = busy;
      pushBtn.disabled = busy;
      branchPill.style.opacity = busy ? "0.6" : "";
    }

    function renderCount() {
      // Staged count lives on the Commit button itself — no redundant title.
      const verb = amend.checked ? "Amend" : "Commit";
      commitLabel.textContent = stagedCount > 0 ? verb + " " + stagedCount : verb;
    }

    // ---- Branch / sync header -------------------------------------------
    function renderHeader(state) {
      branchName.textContent = state.branch || "(no branch)";
      branchPill.title = (state.repoName ? state.repoName + " · " : "") +
        (state.branch || "detached HEAD") +
        (state.upstream ? "  ↔ " + state.upstream : "");
      const ahead = state.ahead || 0;
      const behind = state.behind || 0;
      const hasUpstream = !!state.upstream;
      aheadN.textContent = String(ahead);
      behindN.textContent = String(behind);
      aheadEl.classList.toggle("visible", ahead > 0);
      behindEl.classList.toggle("visible", behind > 0);
      syncClean.classList.toggle("visible", hasUpstream && ahead === 0 && behind === 0);
      syncEl.classList.toggle("hidden", !state.branch);
    }

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
    commitBtn.addEventListener("click", () => doCommit(false));
    pushBtn.addEventListener("click", () => doCommit(true));

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
    }
    layoutToggle.addEventListener("click", () => {
      layout = layout === "tree" ? "list" : "tree";
      applyLayoutClass();
      vscode.postMessage({ type: "setLayout", layout });
      render();
    });
    collapseAllBtn.addEventListener("click", () => {
      // Collapse every folder row in the current tree render.
      for (const key of Object.keys(collapsed)) collapsed[key] = false;
      const folders = collectFolderKeys();
      for (const k of folders) collapsed[k] = true;
      render();
    });
    stageAllTopBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "stageAll" });
    });
    refreshBtn.addEventListener("click", () => {
      vscode.postMessage({ type: "ready" });
    });

    // ---- Branch + actions menu (folds in the old Branches view) ----------
    let branchMenu = null;
    let branchFilter = "";
    let branchSubmenu = null;
    // Per-category collapse memory (Favorites / Recent / Local / Remote).
    const collapsedCats = Object.create(null);

    function closeBranchMenu() {
      closeBranchSubmenu();
      if (!branchMenu) return;
      branchMenu.remove();
      branchMenu = null;
      branchPill.setAttribute("aria-expanded", "false");
      document.removeEventListener("mousedown", onBranchDocDown, true);
      document.removeEventListener("keydown", onBranchKey, true);
    }
    function closeBranchSubmenu() {
      if (branchSubmenu) { branchSubmenu.remove(); branchSubmenu = null; }
    }
    function onBranchDocDown(e) {
      const inMenu = branchMenu && branchMenu.contains(e.target);
      const inSub = branchSubmenu && branchSubmenu.contains(e.target);
      const onPill = branchPill.contains(e.target);
      if (inSub || inMenu || onPill) return;
      closeBranchMenu();
    }
    function onBranchKey(e) {
      if (e.key === "Escape") {
        if (branchSubmenu) { closeBranchSubmenu(); return; }
        closeBranchMenu(); branchPill.focus();
      }
    }
    function branchAct(action, ref) {
      vscode.postMessage({ type: "branchAction", action: action, ref: ref });
      if (action !== "favorite") closeBranchMenu();
    }
    function matchF(s) { return !branchFilter || s.toLowerCase().indexOf(branchFilter) !== -1; }

    function bIcon(name) {
      return '<i class="codicon codicon-' + name + '" aria-hidden="true"></i>';
    }
    // HTML-escape, then wrap the matched search substring in a highlight mark.
    function esc(s) {
      return s.replace(/[&<>"]/g, (c) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
    }
    function hl(text) {
      if (!branchFilter) return esc(text);
      const i = text.toLowerCase().indexOf(branchFilter);
      if (i < 0) return esc(text);
      return esc(text.slice(0, i)) +
        '<mark class="bm-hl">' + esc(text.slice(i, i + branchFilter.length)) + '</mark>' +
        esc(text.slice(i + branchFilter.length));
    }
    function currentBranchName() {
      const cur = (branchData.local || []).find((b) => b.current);
      return cur ? cur.name : "current branch";
    }

    function branchRow(name, kind, up, fav, current) {
      const row = el("div", "bm-branch" + (current ? " is-current" : ""));
      if (kind === "local") {
        const star = el("button", "bm-star" + (fav ? " on" : ""),
          bIcon(fav ? "star-full" : "star-empty"));
        star.title = fav ? "Remove from favorites" : "Add to favorites";
        star.addEventListener("click", (e) => { e.stopPropagation(); branchAct("favorite", name); });
        row.appendChild(star);
      } else {
        row.appendChild(el("span", "bm-star-spacer"));
      }
      row.appendChild(el("i", "codicon codicon-" +
        (kind === "remote" ? "cloud" : (current ? "check" : "git-branch")) + " bm-bicon"));
      const nm = el("span", "bm-bname", hl(name)); row.appendChild(nm);
      if (up) { const u = el("span", "bm-bup"); u.textContent = up; row.appendChild(u); }
      row.appendChild(el("i", "codicon codicon-chevron-right bm-bmore"));
      row.title = "Branch actions";
      row.addEventListener("click", () => openBranchActions(name, kind, current, row));
      return row;
    }

    // ── Per-branch action submenu (JetBrains-style) ──────────────────────────
    function subAct(command, refName, refType) {
      vscode.postMessage({ type: "branchRefCommand", command: command, ref: refName, refType: refType });
      closeBranchMenu();
    }
    function plainAct(action, refName) {
      vscode.postMessage({ type: "branchAction", action: action, ref: refName });
      closeBranchMenu();
    }
    function subItem(list, icon, label, fn, danger) {
      const b = el("button", "bm-subaction" + (danger ? " danger" : ""), bIcon(icon) + "<span></span>");
      b.querySelector("span").textContent = label;
      b.title = label; // full text on hover when the label ellipsis-clips a long branch name
      b.addEventListener("click", fn);
      list.appendChild(b);
    }
    function subSep(list) { list.appendChild(el("div", "bm-subsep")); }

    function openBranchActions(name, kind, current, anchor) {
      closeBranchSubmenu();
      const cur = currentBranchName();
      const refType = kind === "remote" ? "remote" : "head";
      const menu = el("div", "branch-submenu");
      const head = el("div", "bm-subhead");
      head.appendChild(el("i", "codicon codicon-" + (kind === "remote" ? "cloud" : "git-branch")));
      head.appendChild(el("span", "bm-subhead-name", esc(name)));
      menu.appendChild(head);
      const list = el("div", "bm-sublist");
      menu.appendChild(list);

      if (current) {
        subItem(list, "arrow-down", "Pull using Rebase", () => plainAct("pullRebase", name));
        subItem(list, "arrow-down", "Pull using Merge", () => plainAct("pull", name));
        subItem(list, "arrow-up", "Push", () => plainAct("push", name));
        subSep(list);
        subItem(list, "add", "New Branch from '" + name + "'…", () => subAct("gitstudio.branch.new", name, refType));
        subItem(list, "list-tree", "New Worktree from '" + name + "'…", () => subAct("gitstudio.branch.createWorktree", name, refType));
        subItem(list, "edit", "Rename…", () => subAct("gitstudio.branch.rename", name, refType));
      } else {
        subItem(list, kind === "remote" ? "cloud-download" : "check", "Checkout", () =>
          subAct(kind === "remote" ? "gitstudio.remoteBranch.checkout" : "gitstudio.branch.checkout", name, refType));
        subItem(list, "add", "New Branch from '" + name + "'…", () => subAct("gitstudio.branch.new", name, refType));
        subSep(list);
        subItem(list, "git-compare", "Compare with '" + cur + "'", () => subAct("gitstudio.branch.compare", name, refType));
        subSep(list);
        subItem(list, "git-merge", "Merge '" + name + "' into '" + cur + "'", () => subAct("gitstudio.branch.merge", name, refType));
        subItem(list, "git-pull-request", "Rebase '" + cur + "' onto '" + name + "'", () => subAct("gitstudio.branch.rebase", name, refType));
        subSep(list);
        subItem(list, "list-tree", "New Worktree from '" + name + "'…", () => subAct("gitstudio.branch.createWorktree", name, refType));
        if (kind === "local") subItem(list, "edit", "Rename…", () => subAct("gitstudio.branch.rename", name, refType));
        subSep(list);
        subItem(list, "trash", "Delete", () =>
          subAct(kind === "remote" ? "gitstudio.remoteBranch.delete" : "gitstudio.branch.delete", name, refType), true);
      }

      document.body.appendChild(menu);
      branchSubmenu = menu;
      // Cascade as a secondary popup off the RIGHT edge of the main branch menu,
      // vertically aligned to the clicked row. Flip to the LEFT only if it would
      // overflow the (narrow) panel. SEAM = small overlap so it reads as a child.
      const SEAM = 2;
      const PAD = 6;
      const sub = menu.getBoundingClientRect();
      const subW = sub.width;
      const subH = sub.height;
      const menuRect = branchMenu
        ? branchMenu.getBoundingClientRect()
        : anchor.getBoundingClientRect();
      const rowRect = anchor.getBoundingClientRect();

      // Horizontal: hang off the menu's right edge; flip to its left on overflow.
      let left = menuRect.right - SEAM;
      if (left + subW > window.innerWidth - PAD) {
        left = menuRect.left - subW + SEAM;
      }
      left = Math.max(PAD, Math.min(left, window.innerWidth - subW - PAD));

      // Vertical: align the submenu's top to the clicked row's top, clamped.
      let top = rowRect.top;
      if (top + subH > window.innerHeight - PAD) {
        top = window.innerHeight - subH - PAD;
      }
      top = Math.max(PAD, top);

      menu.style.left = Math.round(left) + "px";
      menu.style.top = Math.round(top) + "px";
    }

    function renderBranchMenu() {
      if (!branchMenu) return;
      closeBranchSubmenu();
      const list = branchMenu.querySelector(".bm-list");
      list.replaceChildren();

      const actions = [
        { a: "pull", icon: "arrow-down", label: "Update (pull)" },
        { a: "push", icon: "arrow-up", label: "Push" },
        { a: "fetch", icon: "sync", label: "Fetch" },
        { a: "new", icon: "add", label: "New Branch…" },
        { a: "checkoutRef", icon: "tag", label: "Checkout Tag or Revision…" },
      ];
      let anyAction = false;
      for (const it of actions) {
        if (!matchF(it.label)) continue;
        anyAction = true;
        const b = el("button", "bm-action", bIcon(it.icon) + "<span></span>");
        b.querySelector("span").innerHTML = hl(it.label);
        b.addEventListener("click", () => branchAct(it.a));
        list.appendChild(b);
      }

      const locals = branchData.local || [];
      const recentNames = branchData.recent || [];
      const favs = locals.filter((b) => b.favorite && matchF(b.name));
      const recents = recentNames
        .map((n) => locals.find((b) => b.name === n))
        .filter((b) => b && !b.favorite && matchF(b.name));
      const others = locals.filter((b) =>
        !b.favorite && recentNames.indexOf(b.name) === -1 && matchF(b.name));
      const remotes = (branchData.remote || []).filter((n) => matchF(n));

      // A collapsible category: a clickable header (chevron + count) over its rows.
      // While searching, force-expand so matches are always visible.
      function group(label, rows, build) {
        if (!rows.length) return;
        const collapsed = !branchFilter && !!collapsedCats[label];
        const head = el("button", "bm-sep" + (collapsed ? " collapsed" : ""),
          bIcon("chevron-down") + '<span class="bm-sep-label"></span><span class="bm-sep-count"></span>');
        head.querySelector(".bm-sep-label").textContent = label;
        head.querySelector(".bm-sep-count").textContent = String(rows.length);
        const body = el("div", "bm-group-body");
        if (collapsed) body.style.display = "none";
        rows.forEach((r) => body.appendChild(build(r)));
        head.addEventListener("click", () => {
          collapsedCats[label] = !collapsedCats[label];
          const c = !!collapsedCats[label];
          head.classList.toggle("collapsed", c);
          body.style.display = c ? "none" : "";
        });
        list.appendChild(head);
        list.appendChild(body);
      }

      group("Favorites", favs, (b) => branchRow(b.name, "local", b.upstream, true, b.current));
      group("Recent", recents, (b) => branchRow(b.name, "local", b.upstream, false, b.current));
      group("Local", others, (b) => branchRow(b.name, "local", b.upstream, b.favorite, b.current));
      group("Remote", remotes, (n) => branchRow(n, "remote", "", false, false));

      if (!anyAction && !favs.length && !recents.length && !others.length && !remotes.length) {
        list.appendChild(el("div", "bm-empty", "No matches"));
      }
    }

    function openBranchMenu() {
      if (branchMenu) { closeBranchMenu(); return; }
      branchFilter = "";
      branchMenu = el("div", "branch-menu");
      const search = el("div", "bm-search");
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Search for branches and actions";
      input.setAttribute("aria-label", "Search branches and actions");
      input.addEventListener("input", () => { branchFilter = input.value.trim().toLowerCase(); renderBranchMenu(); });
      search.appendChild(input);
      branchMenu.appendChild(search);
      branchMenu.appendChild(el("div", "bm-list"));
      document.body.appendChild(branchMenu);
      renderBranchMenu();
      branchPill.setAttribute("aria-expanded", "true");
      const r = branchPill.getBoundingClientRect();
      branchMenu.style.left = Math.round(r.left) + "px";
      branchMenu.style.top = Math.round(r.bottom + 4) + "px";
      const mr = branchMenu.getBoundingClientRect();
      if (mr.right > window.innerWidth - 6) {
        branchMenu.style.left = Math.max(6, window.innerWidth - mr.width - 6) + "px";
      }
      input.focus();
      setTimeout(() => {
        document.addEventListener("mousedown", onBranchDocDown, true);
        document.addEventListener("keydown", onBranchKey, true);
      }, 0);
    }
    branchPill.addEventListener("click", openBranchMenu);

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

    function render() {
      groupsEl.textContent = "";
      folderKeyAccumulator = [];
      const data = {
        merge: lastState.merge,
        staged: lastState.staged,
        unstaged: lastState.unstaged,
      };
      const total =
        data.merge.length + data.staged.length + data.unstaged.length;
      emptyEl.classList.toggle("visible", total === 0);
      changesTotal.textContent = String(total);
      changesTotal.classList.toggle("visible", total > 0);

      for (const def of GROUP_DEFS) {
        const list = data[def.kind];
        if (def.kind === "merge" && list.length === 0) continue;
        groupsEl.appendChild(renderGroup(def, list));
      }
    }

    function renderGroup(def, list) {
      const collapseKey = "group:" + def.kind;
      const isCollapsed = collapsed[collapseKey] === true;
      const group = el("div", "group group--" + def.kind +
        (list.length === 0 ? " empty" : "") +
        (isCollapsed ? " collapsed" : ""));

      const header = el("div", "group-header");
      header.tabIndex = 0;
      header.setAttribute("role", "button");
      const twisty = el("span", "twisty", ICON_CHEVRON);
      const gdot = el("span", "gdot");
      const glabel = el("span", "glabel");
      glabel.textContent = def.label;
      const gcount = el("span", "gcount");
      gcount.textContent = String(list.length);

      const actions = el("span", "group-actions");
      if (def.kind === "staged") {
        actions.appendChild(makeIconBtn(ICON_UNSTAGE, "Unstage All", (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ type: "unstageAll", group: def.kind });
        }));
      } else {
        actions.appendChild(makeIconBtn(ICON_STAGE, "Stage All", (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ type: "stageAll", group: def.kind });
        }));
        if (def.kind === "unstaged") {
          actions.appendChild(makeIconBtn(ICON_DISCARD, "Discard All", (ev) => {
            ev.stopPropagation();
            vscode.postMessage({ type: "discardAll", group: def.kind });
          }));
        }
      }

      header.append(twisty, gdot, glabel, actions, gcount);
      const toggleGroup = () => {
        collapsed[collapseKey] = !(collapsed[collapseKey] === true);
        render();
      };
      header.addEventListener("click", toggleGroup);
      header.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleGroup(); }
      });
      group.appendChild(header);

      const body = el("div", "group-body");
      if (layout === "tree") {
        renderTreeInto(body, def, list);
      } else {
        for (const f of list) body.appendChild(renderFileRow(def, f, 1));
      }
      group.appendChild(body);
      return group;
    }

    function renderTreeInto(body, def, list) {
      const tree = buildTree(list);
      renderNode(body, def, tree, 1);
    }

    function renderNode(container, def, node, depth) {
      // Folders first (alphabetical), then files.
      const dirs = [...node.dirs.values()].sort((a, b) =>
        a.name.localeCompare(b.name));
      for (const dir of dirs) {
        const key = "folder:" + def.kind + ":" + dir.path;
        folderKeyAccumulator.push(key);
        const isCollapsed = collapsed[key] === true;
        const row = el("div", "row" + (isCollapsed ? " collapsed" : ""));
        row.style.paddingLeft = (depth * 12) + "px";
        row.tabIndex = 0;
        row.appendChild(el("span", "twisty", ICON_CHEVRON));
        row.appendChild(el("span", "file-icon folder-icon", ICON_FOLDER));
        const name = el("span", "name");
        name.textContent = dir.name;
        row.appendChild(name);
        row.appendChild(el("span", "spacer"));
        const toggle = () => { collapsed[key] = !isCollapsed; render(); };
        row.addEventListener("click", toggle);
        row.addEventListener("keydown", (e) => {
          if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); }
        });
        container.appendChild(row);
        if (!isCollapsed) renderNode(container, def, dir, depth + 1);
      }
      for (const f of node.files.slice().sort((a, b) =>
        a.name.localeCompare(b.name))) {
        container.appendChild(renderFileRowTree(def, f, depth));
      }
    }

    function renderFileRowTree(def, f, depth) {
      const row = makeFileRow(def, f.entry, f.name, null);
      row.style.paddingLeft = (depth * 12 + 16) + "px";
      return row;
    }

    function renderFileRow(def, e, depth) {
      const slash = e.path.lastIndexOf("/");
      const fileName = slash === -1 ? e.path : e.path.slice(slash + 1);
      const dir = slash === -1 ? "" : e.path.slice(0, slash);
      const row = makeFileRow(def, e, fileName, dir);
      row.style.paddingLeft = "20px";
      return row;
    }

    function makeFileRow(def, e, fileName, dir) {
      const letter = e.status;
      const conflict = CONFLICT_LETTERS.has(letter);
      const row = el("div", "row is-file " + statusClass(letter) +
        (letter === "D" ? " is-deleted" : "") +
        (conflict ? " is-conflict" : ""));
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.title = e.path;

      row.appendChild(el("span", "file-icon", ICON_FILE));
      const name = el("span", "name");
      name.textContent = fileName;
      row.appendChild(name);

      if (dir != null && dir !== "") {
        const dirEl = el("span", "dir");
        // RTL trick keeps the tail visible; wrap so it reads left-to-right.
        dirEl.textContent = dir;
        dirEl.setAttribute("dir", "ltr");
        dirEl.style.direction = "ltr";
        row.appendChild(dirEl);
      } else {
        row.appendChild(el("span", "spacer"));
      }

      const actions = el("span", "row-actions");
      if (def.staged) {
        actions.appendChild(makeIconBtn(ICON_UNSTAGE, "Unstage", (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ type: "unstage", path: e.path });
        }));
      } else {
        actions.appendChild(makeIconBtn(ICON_STAGE, "Stage", (ev) => {
          ev.stopPropagation();
          vscode.postMessage({ type: "stage", path: e.path });
        }));
        if (def.kind === "unstaged") {
          actions.appendChild(makeIconBtn(ICON_DISCARD, "Discard", (ev) => {
            ev.stopPropagation();
            vscode.postMessage({ type: "discard", path: e.path });
          }));
        }
      }
      row.appendChild(actions);

      const status = el("span", "status " + statusClass(letter));
      status.textContent = letter;
      row.appendChild(status);

      const open = () => vscode.postMessage({
        type: "openDiff", path: e.path, staged: !!def.staged,
      });
      row.addEventListener("click", open);
      row.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") { ev.preventDefault(); open(); }
      });
      return row;
    }

    function makeIconBtn(svg, title, onClick) {
      const b = el("button", "icon-btn", svg);
      b.type = "button";
      b.title = title;
      b.setAttribute("aria-label", title);
      b.addEventListener("click", onClick);
      return b;
    }

    // ---- Host messages ---------------------------------------------------
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type === "state") {
        stagedCount = msg.stagedCount || 0;
        setBusy(!!msg.busy);
        document.body.classList.toggle("no-repo", !msg.hasRepo);
        renderHeader(msg);
        generateBtn.classList.toggle("visible", !!msg.aiEnabled);
        if (msg.layout && msg.layout !== layout) {
          layout = msg.layout;
          applyLayoutClass();
        }
        lastState = {
          merge: msg.merge || [],
          staged: msg.staged || [],
          unstaged: msg.unstaged || [],
        };
        branchData = msg.branches || { local: [], remote: [], recent: [] };
        if (branchMenu) renderBranchMenu();
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
        render();
      } else if (msg.type === "setMessage") {
        if (typeof msg.text === "string") {
          message.value = msg.text; autoGrow(); updateComposer();
        }
      } else if (msg.type === "generateDone") {
        setGenerating(false);
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
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** Find the Change whose repo-relative path matches `path`. */
function findIn(
  changes: Change[],
  root: string,
  path: string,
): Change | undefined {
  return changes.find((c) => relativePath(root, c.uri.fsPath) === path);
}
