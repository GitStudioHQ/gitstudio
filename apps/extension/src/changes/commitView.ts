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

interface StatePayload {
  type: "state";
  merge: FileEntry[];
  staged: FileEntry[];
  unstaged: FileEntry[];
  stagedCount: number;
  branch?: string;
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
    | "amendToggled";
  path?: string;
  staged?: boolean;
  group?: GroupKind;
  layout?: "tree" | "list";
  message?: string;
  amend?: boolean;
  signoff?: boolean;
  author?: string;
  push?: boolean;
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
    view.webview.options = { enableScripts: true };
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
    const branch = state?.HEAD?.name;
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

    const payload: StatePayload = {
      type: "state",
      merge,
      staged,
      unstaged,
      stagedCount,
      branch,
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
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}'`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
      --gs-font-ui: var(--vscode-font-family);
      --gs-font-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
      --gs-fg: var(--vscode-foreground);
      --gs-fg-muted: var(--vscode-descriptionForeground);
      --gs-accent: var(--vscode-focusBorder);
      --gs-hover: var(--vscode-list-hoverBackground);
      --gs-radius: 4px;
      --gs-motion: 150ms;
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
      padding: 8px 6px 10px;
      color: var(--gs-fg);
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.4;
      background: var(--vscode-sideBar-background, transparent);
    }

    /* ---- Message field ------------------------------------------------- */
    .message-wrap { position: relative; margin: 0 2px; }
    textarea {
      width: 100%;
      resize: none;
      min-height: 54px;
      max-height: 320px;
      padding: 7px 9px;
      padding-right: 34px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: var(--gs-radius);
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.45;
      outline: none;
      transition: border-color var(--gs-motion) ease;
    }
    textarea:focus { border-color: var(--gs-accent); }
    textarea::placeholder { color: var(--vscode-input-placeholderForeground); }

    /* ---- Sparkle / generate button (crisp SVG, never emoji) ----------- */
    .sparkle {
      position: absolute;
      top: 5px;
      right: 5px;
      display: none;
      align-items: center;
      justify-content: center;
      width: 24px;
      height: 24px;
      padding: 0;
      border: none;
      border-radius: var(--gs-radius);
      background: transparent;
      color: var(--gs-fg-muted);
      cursor: pointer;
      transition: color var(--gs-motion) ease, background var(--gs-motion) ease;
    }
    .sparkle.visible { display: inline-flex; }
    .sparkle svg { width: 15px; height: 15px; display: block; }
    .sparkle .spinner { display: none; }
    .sparkle.loading .glyph { display: none; }
    .sparkle.loading .spinner { display: block; }
    .sparkle:hover {
      color: var(--vscode-textLink-foreground, var(--gs-fg));
      background: var(--vscode-toolbar-hoverBackground, var(--gs-hover));
    }
    .sparkle:disabled { cursor: default; }
    .sparkle:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }
    .sparkle.loading .spinner { animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }

    /* ---- Toggles row --------------------------------------------------- */
    .toggles {
      display: flex;
      flex-wrap: wrap;
      gap: 6px 14px;
      align-items: center;
      margin: 9px 4px 7px;
      font-size: 12px;
    }
    .toggles label {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
      color: var(--gs-fg);
    }
    .toggles input[type="checkbox"] { accent-color: var(--gs-accent); margin: 0; }

    /* ---- Author override row ------------------------------------------ */
    .author-row { margin: 0 4px 7px; }
    .author-row.hidden { display: none; }
    .author-row input {
      width: 100%;
      padding: 5px 9px;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: var(--gs-radius);
      font-family: var(--gs-font-ui);
      font-size: 12px;
      outline: none;
      transition: border-color var(--gs-motion) ease;
    }
    .author-row input:focus { border-color: var(--gs-accent); }

    /* ---- Inline link button (Author…) --------------------------------- */
    .link {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      background: none; border: none; padding: 2px 2px;
      color: var(--vscode-textLink-foreground);
      cursor: pointer; font-size: 11.5px;
      border-radius: var(--gs-radius);
    }
    .link svg { width: 12px; height: 12px; }
    .link[aria-expanded="true"] .chev { transform: rotate(180deg); }
    .link .chev { transition: transform var(--gs-motion) ease; }

    /* ---- Action buttons ----------------------------------------------- */
    .actions { display: flex; gap: 6px; margin: 0 4px; }
    button.gs-commit {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      border: 1px solid transparent;
      border-radius: var(--gs-radius);
      padding: 6px 10px;
      cursor: pointer;
      font-family: var(--gs-font-ui);
      font-size: 13px;
      line-height: 1.2;
      transition: background var(--gs-motion) ease, opacity var(--gs-motion) ease;
    }
    button.gs-commit svg { width: 14px; height: 14px; flex: 0 0 auto; }
    button.primary {
      flex: 1;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      font-weight: 600;
    }
    button.primary:hover { background: var(--vscode-button-hoverBackground); }
    button.split {
      color: var(--vscode-button-secondaryForeground, var(--vscode-button-foreground));
      background: var(--vscode-button-secondaryBackground, var(--vscode-button-background));
    }
    button.split:hover {
      background: var(--vscode-button-secondaryHoverBackground, var(--vscode-button-hoverBackground));
    }
    button.gs-commit:disabled { opacity: 0.45; cursor: default; }
    button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 2px; }
    .link:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 1px; }

    /* ---- Keyboard hint ------------------------------------------------- */
    .hint {
      margin: 7px 4px 0;
      font-size: 10.5px;
      color: var(--gs-fg-muted);
    }
    .hint kbd {
      font-family: var(--gs-font-mono);
      font-size: 10px;
      padding: 0 3px;
      border-radius: 3px;
      background: color-mix(in srgb, var(--gs-fg-muted) 16%, transparent);
      color: var(--gs-fg);
    }

    /* ---- Changes toolbar ---------------------------------------------- */
    .changes-toolbar {
      display: flex;
      align-items: center;
      gap: 2px;
      margin: 12px 2px 2px;
      padding: 2px 2px 4px;
      border-top: 1px solid var(--vscode-panel-border, transparent);
      padding-top: 8px;
    }
    .changes-toolbar .title {
      flex: 1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
      color: var(--gs-fg-muted);
    }
    .icon-btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      width: 22px;
      height: 22px;
      padding: 0;
      border: none;
      border-radius: var(--gs-radius);
      background: transparent;
      color: var(--gs-fg-muted);
      cursor: pointer;
      transition: color var(--gs-motion) ease, background var(--gs-motion) ease;
    }
    .icon-btn svg { width: 16px; height: 16px; display: block; }
    .icon-btn:hover {
      color: var(--gs-fg);
      background: var(--vscode-toolbar-hoverBackground, var(--gs-hover));
    }
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
    .group { margin-top: 2px; }
    .group.empty { display: none; }
    .group-header {
      display: flex;
      align-items: center;
      gap: 4px;
      height: 24px;
      padding: 0 4px 0 2px;
      cursor: pointer;
      border-radius: var(--gs-radius);
      user-select: none;
    }
    .group-header:hover { background: var(--gs-hover); }
    .group-header .twisty {
      width: 16px; height: 16px;
      display: inline-flex; align-items: center; justify-content: center;
      color: var(--gs-fg-muted);
      flex: 0 0 auto;
      transition: transform var(--gs-motion) ease;
    }
    .group.collapsed .group-header .twisty { transform: rotate(-90deg); }
    .group-header .twisty svg { width: 12px; height: 12px; }
    .group-header .glabel {
      flex: 1;
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      font-weight: 600;
      color: var(--gs-fg-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .group-header .gcount {
      font-family: var(--gs-font-mono);
      font-variant-numeric: tabular-nums;
      font-size: 11px;
      min-width: 18px;
      text-align: center;
      padding: 0 5px;
      border-radius: 9px;
      background: var(--vscode-badge-background);
      color: var(--vscode-badge-foreground);
      flex: 0 0 auto;
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
      display: flex;
      align-items: center;
      gap: 6px;
      height: 22px;
      padding: 0 4px 0 0;
      border-radius: var(--gs-radius);
      cursor: pointer;
      user-select: none;
    }
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
    }
    .row .file-icon svg { width: 15px; height: 15px; }
    .row .folder-icon { color: var(--vscode-symbolIcon-folderForeground, var(--gs-fg-muted)); }
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
      font-family: var(--gs-font-mono);
      font-size: 11px;
      font-weight: 600;
      width: 14px;
      text-align: center;
      flex: 0 0 auto;
    }
    .st-M { color: var(--gs-status-modified); }
    .st-A { color: var(--gs-status-added); }
    .st-U { color: var(--gs-status-untracked); }
    .st-D { color: var(--gs-status-deleted); }
    .st-R { color: var(--gs-status-renamed); }
    .st-C { color: var(--gs-status-renamed); }
    .st-T { color: var(--gs-status-modified); }
    .st-I { color: var(--gs-status-ignored); }
    .row.is-conflict .status { color: var(--gs-status-conflict); }

    /* ---- Empty state --------------------------------------------------- */
    .empty-state {
      display: none;
      align-items: center;
      gap: 8px;
      margin: 8px 6px;
      padding: 14px 10px;
      color: var(--gs-fg-muted);
      font-size: 12px;
      justify-content: center;
      text-align: center;
    }
    .empty-state.visible { display: flex; }
    .empty-state svg { width: 16px; height: 16px; opacity: 0.8; flex: 0 0 auto; }

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
  <div class="message-wrap">
    <textarea id="message" rows="3"
      placeholder="Commit message"
      aria-label="Commit message"></textarea>
    <button class="sparkle" id="generate" type="button"
      title="Generate commit message with GitBrain"
      aria-label="Generate commit message">
      <svg class="glyph" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 1.6l1.5 3.9 3.9 1.5-3.9 1.5L8 12.4 6.5 8.5 2.6 7l3.9-1.5z"/>
        <path d="M12.8 11.2l.7 1.7 1.7.7-1.7.7-.7 1.7-.7-1.7-1.7-.7 1.7-.7z"/>
      </svg>
      <svg class="spinner" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.6" stroke-linecap="round" aria-hidden="true">
        <path d="M8 1.8a6.2 6.2 0 1 1-4.4 1.8" opacity="0.9"/>
      </svg>
    </button>
  </div>

  <div class="toggles">
    <label><input type="checkbox" id="amend" /> Amend</label>
    <label><input type="checkbox" id="signoff" /> Sign-off</label>
    <button class="link" id="author-toggle" type="button" aria-expanded="false"
      aria-controls="author-row">
      Author
      <svg class="chev" viewBox="0 0 16 16" fill="none" stroke="currentColor"
        stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M4 6l4 4 4-4"/>
      </svg>
    </button>
  </div>

  <div class="author-row hidden" id="author-row">
    <input id="author" type="text"
      placeholder="Author override — Name &lt;email@example.com&gt;"
      aria-label="Author override" />
  </div>

  <div class="actions">
    <button class="gs-commit primary" id="commit" type="button">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="8" cy="8" r="2.4"/>
        <path d="M8 1.4v4.2M8 10.4v4.2"/>
      </svg>
      <span id="commit-label">Commit</span>
    </button>
    <button class="gs-commit split" id="commit-push" type="button"
      title="Commit &amp; Push" aria-label="Commit and Push">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M8 13.5V4.5M4.5 8L8 4.5 11.5 8"/>
      </svg>
      <span>Push</span>
    </button>
  </div>

  <div class="changes-toolbar">
    <span class="title" id="changes-title">Changes</span>
    <button class="icon-btn layout" id="layout-toggle" type="button"
      title="Toggle tree / list view" aria-label="Toggle tree / list view">
      <svg class="to-tree" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M2 3h12v1.5H2zM4.5 7.25h9.5v1.5H4.5zM4.5 11.5h9.5V13H4.5zM2.5 7.25v4.25h1.2"
          fill="none" stroke="currentColor" stroke-width="1.2"/>
        <circle cx="2.75" cy="3.75" r="0"/>
      </svg>
      <svg class="to-list" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
        <path d="M5 3h9v1.4H5zM5 7.3h9v1.4H5zM5 11.6h9V13H5z"/>
        <circle cx="2.4" cy="3.7" r="1"/>
        <circle cx="2.4" cy="8" r="1"/>
        <circle cx="2.4" cy="12.3" r="1"/>
      </svg>
    </button>
    <button class="icon-btn stage-all-top" id="stage-all-top" type="button"
      title="Stage All Changes" aria-label="Stage All Changes">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4"
        stroke-linecap="round" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>
    </button>
    <button class="icon-btn collapse-all" id="collapse-all" type="button"
      title="Collapse All Folders" aria-label="Collapse All Folders">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M5 4l3 3 3-3M5 12l3-3 3 3"/></svg>
    </button>
    <button class="icon-btn refresh" id="refresh" type="button"
      title="Refresh" aria-label="Refresh">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
        stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M13 8a5 5 0 1 1-1.46-3.54M13 2.5V5h-2.5"/></svg>
    </button>
  </div>

  <div class="groups" id="groups"></div>

  <div class="empty-state" id="empty-state">
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"
      stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="8" cy="8" r="6"/><path d="M5.5 8.2l1.7 1.7L10.8 6"/></svg>
    <span>No changes</span>
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
    const changesTitle = $("changes-title");
    const groupsEl = $("groups");
    const emptyEl = $("empty-state");
    const layoutToggle = $("layout-toggle");
    const collapseAllBtn = $("collapse-all");
    const stageAllTopBtn = $("stage-all-top");
    const refreshBtn = $("refresh");

    let stagedCount = 0;
    let generating = false;
    let layout = "list";
    // Persisted-in-DOM collapse memory, keyed by group + folder path.
    const collapsed = Object.create(null);
    let lastState = { merge: [], staged: [], unstaged: [] };

    // ---- SVG glyphs (status + folder + file) -----------------------------
    const ICON_FILE =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linejoin="round" aria-hidden="true"><path d="M4 1.5h5l3 3v10H4z"/><path d="M9 1.5V4.5h3"/></svg>';
    const ICON_FOLDER =
      '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M1.5 3.5h4l1.2 1.4H14.5v8H1.5z"/></svg>';
    const ICON_CHEVRON =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 3.5L10 8l-4.5 4.5"/></svg>';
    const ICON_STAGE =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M8 3.5v9M3.5 8h9"/></svg>';
    const ICON_UNSTAGE =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M3.5 8h9"/></svg>';
    const ICON_DISCARD =
      '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12.5 5.5A5 5 0 1 0 13 9M12.5 2.5v3h-3"/></svg>';

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

    // ---- Auto-grow message ----------------------------------------------
    function autoGrow() {
      message.style.height = "auto";
      message.style.height = Math.min(message.scrollHeight, 320) + "px";
    }
    message.addEventListener("input", autoGrow);

    function setBusy(busy) {
      commitBtn.disabled = busy;
      pushBtn.disabled = busy;
    }

    function renderCount() {
      const files = (n) => n + " staged " + (n === 1 ? "file" : "files");
      if (amend.checked) {
        commitLabel.textContent = "Amend";
        changesTitle.textContent = stagedCount > 0
          ? "Amend · " + files(stagedCount) : "Changes";
      } else {
        commitLabel.textContent = "Commit";
        changesTitle.textContent = stagedCount > 0
          ? "Commit " + files(stagedCount) : "Changes";
      }
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
      { kind: "merge", label: "Merge Changes", staged: false },
      { kind: "staged", label: "Staged Changes", staged: true },
      { kind: "unstaged", label: "Changes", staged: false },
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

      for (const def of GROUP_DEFS) {
        const list = data[def.kind];
        if (def.kind === "merge" && list.length === 0) continue;
        groupsEl.appendChild(renderGroup(def, list));
      }
    }

    function renderGroup(def, list) {
      const collapseKey = "group:" + def.kind;
      const isCollapsed = collapsed[collapseKey] === true;
      const group = el("div", "group" + (list.length === 0 ? " empty" : "") +
        (isCollapsed ? " collapsed" : ""));

      const header = el("div", "group-header");
      header.tabIndex = 0;
      header.setAttribute("role", "button");
      const twisty = el("span", "twisty", ICON_CHEVRON);
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

      header.append(twisty, glabel, actions, gcount);
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
      const row = el("div", "row" +
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
        if (typeof msg.lastMessage === "string" && amend.checked &&
            message.value.trim() === "") {
          message.value = msg.lastMessage;
          autoGrow();
        }
        if (msg.signoffDefault && !signoff.dataset.touched) {
          signoff.checked = true;
        }
        renderCount();
        render();
      } else if (msg.type === "setMessage") {
        if (typeof msg.text === "string") { message.value = msg.text; autoGrow(); }
      } else if (msg.type === "generateDone") {
        setGenerating(false);
      } else if (msg.type === "clear") {
        message.value = "";
        amend.checked = false;
        author.value = "";
        authorRow.classList.add("hidden");
        authorToggle.setAttribute("aria-expanded", "false");
        autoGrow();
        renderCount();
      }
    });

    applyLayoutClass();
    renderCount();
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
