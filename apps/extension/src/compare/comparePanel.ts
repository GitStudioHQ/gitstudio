import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";
import { getNonce } from "../webview/html";
import { relativeTime } from "../util/relativeTime";
// Shared design tokens, inlined as text by esbuild (see esbuild.js .css loader),
// so the compare panel matches every other GitStudio surface.
import tokensCss from "../../../../packages/webview-ui/src/styles/tokens.css";
import {
  compareRefsData,
  fileDiffPatch,
  openCompareFileDiff,
  pickRef,
  type CompareResult,
} from "./refCompare";
import type { GitRef } from "@gitstudio/host-bridge/git";

/** Messages the compare webview posts back to the host. */
type CompareMessage =
  | { type: "pickBase" }
  | { type: "pickHead" }
  | { type: "swap" }
  | { type: "setMode"; threeDot: boolean }
  | { type: "openCommit"; sha: string }
  | { type: "openFile"; path: string; oldPath?: string }
  | { type: "loadFileDiff"; path: string; oldPath?: string }
  | { type: "refresh" };

/**
 * The branch/ref comparison panel (editor area) — a GitHub/GitLab-grade compare:
 * a base + compare ref, a "what head adds (3-dot)" vs "all differences (2-dot)"
 * toggle, a commits/files/additions/deletions diffstat header, and a Files view
 * that renders every changed file's diff INLINE (unified or split, lazily
 * loaded), with a tree/flat toggle and a path filter. Commits reveal in the
 * graph; each file can also open in the native side-by-side editor.
 */
export class ComparePanel {
  private static current: ComparePanel | undefined;

  static async show(
    repos: RepoManager,
    extensionUri: vscode.Uri,
    base?: string,
    head?: string,
  ): Promise<void> {
    const active = repos.getActive();
    if (!active) {
      void vscode.window.showInformationMessage(
        "GitStudio: no active repository to compare.",
      );
      return;
    }
    const headRef = await active.ctx.refs.getHead();
    const current = headRef.detached ? headRef.sha : headRef.branch;
    const b = base ?? current;
    let h = head;
    if (!h) {
      // Palette entry point — prompt for the ref to compare `b` against.
      const refs = (await active.ctx.refs.listRefs()).filter(
        (r: GitRef) =>
          r.type === "head" || r.type === "remote" || r.type === "tag",
      );
      h = await pickRef(refs, `Compare ${b} with…`);
    }
    if (!b || !h) {
      return;
    }

    if (ComparePanel.current) {
      ComparePanel.current.setRefs(b, h);
      ComparePanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    ComparePanel.current = new ComparePanel(repos, extensionUri, b, h);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private base: string;
  private head: string;
  private threeDot = true;

  private constructor(
    private readonly repos: RepoManager,
    private readonly extensionUri: vscode.Uri,
    base: string,
    head: string,
  ) {
    this.base = base;
    this.head = head;
    this.panel = vscode.window.createWebviewPanel(
      "gitstudio.compare",
      "Compare",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: CompareMessage) =>
        this.onMessage(m),
      ),
      this.panel.onDidDispose(() => this.dispose()),
      this.repos.onDidChange(() => void this.update()),
    );
    void this.update();
  }

  private setRefs(base: string, head: string): void {
    this.base = base;
    this.head = head;
    void this.update();
  }

  /** Re-run the comparison and re-render. */
  private async update(): Promise<void> {
    this.panel.title = `Compare: ${this.base} ↔ ${this.head}`;
    const active = this.repos.getActive();
    if (!active) {
      this.panel.webview.html = this.errorHtml("No active repository.");
      return;
    }
    let result: CompareResult;
    try {
      result = await compareRefsData(
        active,
        this.base,
        this.head,
        this.threeDot,
      );
    } catch {
      if (this.disposed) {
        return;
      }
      this.panel.webview.html = this.errorHtml(
        `Couldn't compare ${this.base} with ${this.head}.`,
      );
      return;
    }
    // The panel can be closed while compareRefsData() is in flight; writing to a
    // disposed webview throws an unhandled "Webview is disposed" rejection.
    if (this.disposed) {
      return;
    }
    this.panel.webview.html = this.render(result);
  }

  private async onMessage(m: CompareMessage): Promise<void> {
    const active = this.repos.getActive();
    switch (m.type) {
      case "pickBase":
      case "pickHead": {
        if (!active) {
          return;
        }
        const refs = (await active.ctx.refs.listRefs()).filter(
          (r: GitRef) =>
            r.type === "head" || r.type === "remote" || r.type === "tag",
        );
        const picked = await pickRef(
          refs,
          m.type === "pickBase" ? "Compare from (base)…" : "Compare to (head)…",
        );
        if (picked) {
          if (m.type === "pickBase") {
            this.base = picked;
          } else {
            this.head = picked;
          }
          void this.update();
        }
        return;
      }
      case "swap": {
        [this.base, this.head] = [this.head, this.base];
        void this.update();
        return;
      }
      case "setMode": {
        this.threeDot = m.threeDot;
        void this.update();
        return;
      }
      case "openCommit": {
        await vscode.commands.executeCommand(
          "gitstudio.openCommitInGraph",
          m.sha,
        );
        return;
      }
      case "openFile": {
        if (!active) {
          return;
        }
        // The left side depends on the dot-mode (merge-base for 3-dot); the
        // panel already resolved it into `filesLeftRef` for the current render.
        await openCompareFileDiff({
          root: active.root,
          refA: this.filesLeftRef,
          refB: this.head,
          path: m.path,
          oldPath: m.oldPath,
        });
        return;
      }
      case "loadFileDiff": {
        if (!active) {
          return;
        }
        let patch = "";
        try {
          patch = await fileDiffPatch(
            active,
            this.base,
            this.head,
            m.path,
            m.oldPath,
            this.threeDot,
          );
        } catch {
          patch = "";
        }
        if (this.disposed) {
          return;
        }
        void this.panel.webview.postMessage({
          type: "fileDiff",
          path: m.path,
          patch,
        });
        return;
      }
      case "refresh": {
        void this.update();
        return;
      }
    }
  }

  /** The files-left ref for the current render (set in render()). */
  private filesLeftRef = "";

  private render(result: CompareResult): string {
    this.filesLeftRef = result.filesLeftRef;
    const nonce = getNonce();
    const codiconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}' ${this.panel.webview.cspSource}`,
      `font-src ${this.panel.webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join("; ");

    // Everything the client needs to render commits + files + inline diffs,
    // embedded as JSON (safe: `<` escaped so it can't break out of the script).
    const data = {
      base: this.base,
      head: this.head,
      threeDot: this.threeDot,
      ahead: result.ahead,
      behind: result.behind,
      additions: result.additions,
      deletions: result.deletions,
      commits: result.commits.map((c) => ({
        sha: c.sha,
        subject: c.subject || "(no message)",
        author: c.author,
        rel: relativeTime(c.authorDate),
      })),
      files: result.files.map((f) => ({
        path: f.path,
        status: (f.status || "M").charAt(0).toUpperCase(),
        additions: f.additions,
        deletions: f.deletions,
        oldPath: f.oldPath,
      })),
    };
    const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${codiconUri}" rel="stylesheet" />
<style nonce="${nonce}">${tokensCss}</style>
<style nonce="${nonce}">${COMPARE_CSS}</style>
</head>
<body>
  <div class="cmp-bar">
    <button class="ref-pick" id="pick-base" title="Change base ref"><i class="codicon codicon-git-branch"></i><span class="nm">${esc(this.base)}</span></button>
    <span class="cmp-dots" title="${this.threeDot ? "Three-dot: changes since the merge-base" : "Two-dot: direct difference"}">${this.threeDot ? "..." : ".."}</span>
    <button class="ref-pick" id="pick-head" title="Change compare ref"><i class="codicon codicon-git-branch"></i><span class="nm">${esc(this.head)}</span></button>
    <button class="icon-btn" id="swap" title="Swap base and compare"><i class="codicon codicon-arrow-swap"></i></button>
    <div class="cmp-mode" role="group" aria-label="Comparison mode">
      <button id="mode-3" class="${this.threeDot ? "on" : ""}" title="Commits and changes ${esc(this.head)} adds on top of the merge-base">What ${esc(this.head)} adds</button>
      <button id="mode-2" class="${this.threeDot ? "" : "on"}" title="Every difference between the two refs">All differences</button>
    </div>
  </div>

  <div class="cmp-diffstat">
    <div class="ds-headline">
      <b class="ds-head">${esc(this.head)}</b>
      <span class="ds-vs">compared with</span>
      <b class="ds-base">${esc(this.base)}</b>
    </div>
    <div class="ds-metrics">
      <span class="ds-metric"><b id="m-commits">${result.ahead}</b> commits</span>
      <span class="ds-sep">·</span>
      <span class="ds-metric"><b id="m-files">${result.files.length}</b> files changed</span>
      <span class="ds-sep">·</span>
      <span class="ds-metric ds-add">+${result.additions}</span>
      <span class="ds-metric ds-del">−${result.deletions}</span>
      <span class="ds-bar" id="ds-bar" aria-hidden="true"></span>
      ${result.behind > 0 ? `<span class="ds-behind" title="${esc(this.base)} has commits ${esc(this.head)} doesn't"><i class="codicon codicon-arrow-down"></i>${result.behind} behind</span>` : ""}
    </div>
  </div>

  <div class="cmp-seg" role="tablist">
    <button id="seg-files" class="on" role="tab"><i class="codicon codicon-file"></i>Files<span class="count">${result.files.length}</span></button>
    <button id="seg-commits" role="tab"><i class="codicon codicon-git-commit"></i>Commits<span class="count">${result.ahead}</span></button>
  </div>

  <div class="cmp-panel" id="panel-files">
    <div class="files-toolbar">
      <button class="tb-btn" id="toggle-tree" title="Toggle file tree" aria-pressed="true"><i class="codicon codicon-list-tree"></i></button>
      <div class="filter-wrap">
        <i class="codicon codicon-search"></i>
        <input id="file-filter" type="text" placeholder="Filter changed files…" aria-label="Filter changed files" />
      </div>
      <span class="tb-spacer"></span>
      <button class="tb-btn" id="expand-all" title="Expand all files"><i class="codicon codicon-unfold"></i></button>
      <button class="tb-btn" id="collapse-all" title="Collapse all files"><i class="codicon codicon-fold"></i></button>
      <div class="tb-group" role="group" aria-label="Diff style">
        <button class="tb-seg on" id="diff-unified" title="Unified diff"><i class="codicon codicon-list-selection"></i></button>
        <button class="tb-seg" id="diff-split" title="Split diff"><i class="codicon codicon-split-horizontal"></i></button>
      </div>
    </div>
    <div class="cmp-files-layout" id="files-layout">
      <aside class="cmp-tree-sidebar" id="tree-sidebar" aria-label="Changed files">
        <div class="tree-head"><span>Files</span><span class="tree-head-count" id="tree-count">0</span></div>
        <div class="tree-nav" id="tree-nav"></div>
      </aside>
      <div class="tree-resizer" id="tree-resizer" title="Drag to resize"></div>
      <div class="files-main">
        <div class="files-list" id="files-list"></div>
        <div class="cmp-empty" id="files-empty" hidden>No file changes between these refs.</div>
        <div class="cmp-empty" id="files-nomatch" hidden>No files match the filter.</div>
      </div>
    </div>
  </div>

  <div class="cmp-panel" id="panel-commits" hidden>
    <div class="commits-list" id="commits-list"></div>
    <div class="cmp-empty" id="commits-empty" hidden>No commits — <b>${esc(this.head)}</b> has nothing that <b>${esc(this.base)}</b> doesn't.</div>
  </div>

<script nonce="${nonce}">
const DATA = ${dataJson};
${COMPARE_JS}
</script>
</body></html>`;
  }

  private errorHtml(message: string): string {
    const nonce = getNonce();
    const csp = `default-src 'none'; style-src 'nonce-${nonce}'`;
    return `<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}" /><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-descriptionForeground);padding:32px;text-align:center;}</style></head><body>${esc(message)}</body></html>`;
  }

  private dispose(): void {
    this.disposed = true;
    ComparePanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Webview CSS (GitHub/GitLab-style compare) ───────────────────────────────
const COMPARE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 40px; color: var(--gs-fg); font-family: var(--gs-font-ui); font-size: 13px; background: var(--gs-bg); }
  .codicon { font-size: 14px; vertical-align: -0.12em; }

  .cmp-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--gs-border); position: sticky; top: 0; background: var(--gs-bg); z-index: 5; }
  .ref-pick { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--gs-border); border-radius: var(--gs-radius); background: var(--gs-surface); color: var(--gs-fg); font: inherit; cursor: pointer; max-width: 260px; }
  .ref-pick:hover { background: var(--gs-hover); border-color: var(--gs-fg-subtle); }
  .ref-pick:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  .ref-pick .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmp-dots { color: var(--gs-fg-muted); font-family: var(--gs-font-mono); cursor: default; }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 1px solid transparent; border-radius: var(--gs-radius); background: transparent; color: var(--gs-fg-muted); cursor: pointer; }
  .icon-btn:hover { background: var(--gs-hover); color: var(--gs-fg); }
  .icon-btn:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  .cmp-mode { display: inline-flex; margin-left: auto; border: 1px solid var(--gs-border); border-radius: var(--gs-radius); overflow: hidden; }
  .cmp-mode button { height: 28px; padding: 0 10px; border: none; background: transparent; color: var(--gs-fg-muted); font: inherit; cursor: pointer; transition: background var(--gs-motion-fast) var(--gs-ease), color var(--gs-motion-fast) var(--gs-ease); }
  .cmp-mode button:hover:not(.on) { background: var(--gs-hover); color: var(--gs-fg); }
  .cmp-mode button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -2px; }
  .cmp-mode button.on { background: color-mix(in srgb, var(--gs-brand) 18%, transparent); color: var(--gs-brand); font-weight: 600; }

  .cmp-diffstat { padding: 12px 14px 10px; border-bottom: 1px solid var(--gs-border-soft); }
  .ds-headline { font-size: 13px; margin-bottom: 6px; }
  .ds-head { color: var(--gs-accent-text); }
  .ds-base { color: var(--gs-fg); }
  .ds-vs { color: var(--gs-fg-muted); margin: 0 4px; font-weight: 400; }
  .ds-metrics { display: flex; align-items: center; gap: 8px; color: var(--gs-fg-muted); font-size: 12px; flex-wrap: wrap; }
  .ds-metric b { color: var(--gs-fg); font-variant-numeric: tabular-nums; }
  .ds-sep { opacity: 0.5; }
  .ds-add { color: var(--gs-status-added); font-weight: 600; font-variant-numeric: tabular-nums; }
  .ds-del { color: var(--gs-status-deleted); font-weight: 600; font-variant-numeric: tabular-nums; }
  .ds-bar { display: inline-flex; gap: 1px; margin-left: 2px; }
  .ds-bar i { width: 8px; height: 8px; border-radius: 1px; background: var(--gs-border); }
  .ds-bar i.on-add { background: var(--gs-status-added); }
  .ds-bar i.on-del { background: var(--gs-status-deleted); }
  .ds-behind { margin-left: auto; display: inline-flex; align-items: center; gap: 3px; color: var(--gs-amber); font-weight: 600; }
  .ds-behind .codicon { font-size: 12px; }

  .cmp-seg { display: flex; gap: 2px; padding: 8px 12px 0; border-bottom: 1px solid var(--gs-border); background: var(--gs-bg); z-index: 4; }
  .cmp-seg button { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--gs-fg-muted); font: inherit; cursor: pointer; transition: color var(--gs-motion-fast) var(--gs-ease), border-color var(--gs-motion-fast) var(--gs-ease); }
  .cmp-seg button:hover:not(.on) { color: var(--gs-fg); }
  .cmp-seg button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -2px; }
  .cmp-seg button.on { color: var(--gs-fg); border-bottom-color: var(--gs-brand); }
  .cmp-seg .count { min-width: 18px; height: 16px; padding: 0 6px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--gs-fg) 11%, transparent); color: var(--gs-fg-muted); }

  .files-toolbar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--gs-bg); z-index: 3; border-bottom: 1px solid var(--gs-border-soft); flex-wrap: wrap; }
  .filter-wrap { position: relative; display: inline-flex; align-items: center; flex: 0 1 320px; }
  .filter-wrap .codicon { position: absolute; left: 8px; color: var(--gs-fg-muted); font-size: 13px; pointer-events: none; }
  .filter-wrap input { width: 100%; height: 26px; padding: 0 8px 0 26px; color: var(--vscode-input-foreground); background: var(--vscode-input-background, var(--gs-surface)); border: 1px solid var(--gs-border); border-radius: var(--gs-radius-sm); font: inherit; font-size: 12px; outline: none; }
  .filter-wrap input:focus { border-color: var(--gs-accent); }
  .tb-spacer { flex: 1 1 auto; }
  .tb-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 26px; border: 1px solid transparent; border-radius: var(--gs-radius-sm); background: transparent; color: var(--gs-fg-muted); cursor: pointer; }
  .tb-btn:hover { background: var(--gs-hover); color: var(--gs-fg); }
  .tb-group { display: inline-flex; border: 1px solid var(--gs-border); border-radius: var(--gs-radius-sm); overflow: hidden; }
  .tb-seg { display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 26px; border: none; background: transparent; color: var(--gs-fg-muted); cursor: pointer; }
  .tb-seg:hover:not(.on) { background: var(--gs-hover); color: var(--gs-fg); }
  .tb-seg.on { background: color-mix(in srgb, var(--gs-brand) 16%, transparent); color: var(--gs-brand); }

  .commits-list { padding: 8px 12px 0; }

  /* ── Two-pane files view: file-tree sidebar (left) + diffs (right) ────────── */
  .cmp-files-layout { display: flex; align-items: flex-start; }
  .cmp-files-layout.no-tree .cmp-tree-sidebar,
  .cmp-files-layout.no-tree .tree-resizer { display: none; }
  .cmp-tree-sidebar {
    flex: 0 0 var(--tree-w, 264px);
    align-self: stretch;
    position: sticky; top: 0;
    max-height: 100vh; overflow: auto;
    border-right: 1px solid var(--gs-border);
    padding: 8px 6px 16px;
    background: var(--gs-bg);
  }
  .tree-head { display: flex; align-items: center; justify-content: space-between; padding: 2px 6px 8px; font-size: 10px; font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gs-fg-muted); }
  .tree-head-count { font-variant-numeric: tabular-nums; letter-spacing: 0; }
  .tree-nav { font-size: 12px; }
  /* A slim draggable divider between the tree and the diffs. */
  .tree-resizer { flex: 0 0 5px; align-self: stretch; cursor: col-resize; position: sticky; top: 0; height: 100vh; margin-left: -3px; z-index: 2; }
  .tree-resizer:hover, .tree-resizer.dragging { background: color-mix(in srgb, var(--gs-accent) 40%, transparent); }
  .files-main { flex: 1 1 auto; min-width: 0; padding: 8px 12px 30vh; }

  /* Tree nav rows (sidebar). */
  .tnav-folder { display: flex; align-items: center; gap: 4px; padding: 3px 6px; color: var(--gs-fg-muted); cursor: pointer; border-radius: var(--gs-radius-sm); white-space: nowrap; }
  .tnav-folder:hover { background: var(--gs-hover); color: var(--gs-fg); }
  .tnav-folder .codicon { font-size: 13px; flex: 0 0 auto; }
  .tnav-folder .tw { transition: transform var(--gs-motion-fast) var(--gs-ease); }
  .tnav-folder.collapsed .tw { transform: rotate(-90deg); }
  .tnav-folder .fname { overflow: hidden; text-overflow: ellipsis; }
  .tnav-file { display: flex; align-items: center; gap: 6px; padding: 3px 6px; border-radius: var(--gs-radius-sm); cursor: pointer; color: var(--gs-fg); }
  .tnav-file:hover { background: var(--gs-hover); }
  .tnav-file.active { background: color-mix(in srgb, var(--gs-brand) 18%, transparent); }
  .tnav-file .st { flex: 0 0 auto; width: 12px; text-align: center; font-family: var(--gs-font-mono); font-weight: 700; font-size: 10px; }
  .tnav-file .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tnav-file .nums { flex: 0 0 auto; font-family: var(--gs-font-mono); font-size: 10px; font-variant-numeric: tabular-nums; }
  .tnav-file .nums .a { color: var(--gs-status-added); }
  .tnav-file .nums .d { color: var(--gs-status-deleted); margin-left: 3px; }
  .tnav-collapsed-body { display: none; }

  .file { border: 1px solid var(--gs-border); border-radius: var(--gs-radius); margin-bottom: 10px; overflow: hidden; background: var(--gs-surface); }
  .file-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: pointer; background: var(--gs-surface-2); }
  .file-head:hover { background: var(--gs-hover); }
  .file-head .chev { color: var(--gs-fg-muted); transition: transform var(--gs-motion-fast) var(--gs-ease); font-size: 13px; flex: 0 0 auto; }
  .file.open .file-head .chev { transform: rotate(90deg); }
  .file-head .st { flex: 0 0 auto; width: 14px; text-align: center; font-family: var(--gs-font-mono); font-weight: 700; font-size: 11px; }
  .file-head .path { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--gs-font-mono); font-size: 12px; }
  .file-head .path .dir { color: var(--gs-fg-muted); }
  .file-head .path .old { color: var(--gs-fg-subtle); }
  .file-head .fnums { flex: 0 0 auto; font-family: var(--gs-font-mono); font-size: 11px; font-variant-numeric: tabular-nums; display: inline-flex; align-items: center; gap: 6px; }
  .file-head .fnums .add { color: var(--gs-status-added); }
  .file-head .fnums .del { color: var(--gs-status-deleted); }
  .file-head .minibar { display: inline-flex; gap: 1px; }
  .file-head .minibar i { width: 7px; height: 7px; border-radius: 1px; background: var(--gs-border); }
  .file-head .minibar i.on-add { background: var(--gs-status-added); }
  .file-head .minibar i.on-del { background: var(--gs-status-deleted); }
  .file-head .open-native { flex: 0 0 auto; width: 24px; height: 24px; display: inline-flex; align-items: center; justify-content: center; border: none; background: transparent; color: var(--gs-fg-muted); border-radius: var(--gs-radius-sm); cursor: pointer; opacity: 0; }
  .file-head:hover .open-native { opacity: 1; }
  .file-head .open-native:hover { background: var(--gs-hover-strong); color: var(--gs-fg); }
  .st-A { color: var(--gs-status-added); }
  .st-M { color: var(--gs-status-modified); }
  .st-D { color: var(--gs-status-deleted); }
  .st-R { color: var(--gs-status-renamed); }
  .st-C { color: var(--gs-status-renamed); }

  .file-body { display: none; border-top: 1px solid var(--gs-border); background: var(--vscode-editor-background, var(--gs-bg)); overflow-x: auto; }
  .file.open .file-body { display: block; }
  .diff-loading, .diff-note { padding: 10px 12px; color: var(--gs-fg-muted); font-size: 12px; font-family: var(--gs-font-mono); }

  /* Unified diff. */
  .diff { font-family: var(--gs-font-mono); font-size: 12px; line-height: 1.5; min-width: max-content; }
  .dl { display: flex; white-space: pre; }
  .dl .ln { flex: 0 0 auto; width: 44px; padding: 0 8px 0 0; text-align: right; color: var(--gs-fg-subtle); background: color-mix(in srgb, var(--gs-fg) 4%, transparent); user-select: none; }
  .dl .code { flex: 1 1 auto; padding: 0 10px; white-space: pre; }
  .dl.hunk { background: color-mix(in srgb, var(--gs-accent) 10%, transparent); color: var(--gs-fg-muted); }
  .dl.hunk .code { color: var(--vscode-textLink-foreground, var(--gs-accent)); }
  .dl.add { background: color-mix(in srgb, var(--gs-status-added) 15%, transparent); }
  .dl.add .ln { background: color-mix(in srgb, var(--gs-status-added) 22%, transparent); }
  .dl.del { background: color-mix(in srgb, var(--gs-status-deleted) 15%, transparent); }
  .dl.del .ln { background: color-mix(in srgb, var(--gs-status-deleted) 22%, transparent); }
  .dl .sign { display: inline-block; width: 1ch; }
  .wd-add { background: color-mix(in srgb, var(--gs-status-added) 34%, transparent); border-radius: 2px; }
  .wd-del { background: color-mix(in srgb, var(--gs-status-deleted) 34%, transparent); border-radius: 2px; }

  /* Split diff. */
  .split { display: grid; grid-template-columns: 44px 1fr 44px 1fr; font-family: var(--gs-font-mono); font-size: 12px; line-height: 1.5; min-width: max-content; }
  .split .cell { padding: 0 10px; white-space: pre; overflow: visible; }
  .split .gut { padding: 0 8px 0 0; text-align: right; color: var(--gs-fg-subtle); background: color-mix(in srgb, var(--gs-fg) 4%, transparent); user-select: none; }
  .split .s-add { background: color-mix(in srgb, var(--gs-status-added) 15%, transparent); }
  .split .s-add.gut { background: color-mix(in srgb, var(--gs-status-added) 22%, transparent); }
  .split .s-del { background: color-mix(in srgb, var(--gs-status-deleted) 15%, transparent); }
  .split .s-del.gut { background: color-mix(in srgb, var(--gs-status-deleted) 22%, transparent); }
  .split .s-empty { background: color-mix(in srgb, var(--gs-fg) 3%, transparent); }
  .split .hunkrow { grid-column: 1 / -1; background: color-mix(in srgb, var(--gs-accent) 10%, transparent); color: var(--vscode-textLink-foreground, var(--gs-accent)); padding: 0 10px; white-space: pre; }

  .commits-list { padding: 10px 12px 0; }
  .cmp-commit { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; padding: 8px 10px; border: 1px solid var(--gs-border); border-radius: var(--gs-radius); background: var(--gs-surface); color: var(--gs-fg); font: inherit; cursor: pointer; margin-bottom: 8px; }
  .cmp-commit:hover { background: var(--gs-hover); border-color: var(--gs-fg-subtle); }
  .cmp-commit .subject { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmp-commit .csha { flex: 0 0 auto; font-family: var(--gs-font-mono); font-size: 11px; color: var(--gs-accent-text); }
  .cmp-commit .meta { flex: 0 0 auto; font-size: 11.5px; color: var(--gs-fg-muted); }

  .cmp-empty { padding: 40px 16px; text-align: center; color: var(--gs-fg-muted); }
  .cmp-panel[hidden] { display: none; }
`;

// ── Webview JS (client-rendered lists + inline diff parser/renderer) ─────────
const COMPARE_JS = String.raw`
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const patches = new Map();     // path -> patch text ("" = binary/empty)
const openPaths = new Set();    // paths whose inline diff is expanded (survives re-render)
const collapsedDirs = new Set();// tree-sidebar folder paths the user collapsed
let diffMode = "unified";      // "unified" | "split"
let showTree = true;           // the left file-tree sidebar (optional, toggleable)
let filter = "";

function escText(s) { const d = document.createElement("span"); d.textContent = s; return d.innerHTML; }
function el(tag, cls, html) { const n = document.createElement(tag); if (cls) n.className = cls; if (html != null) n.innerHTML = html; return n; }
function statusClass(st) { return "st-" + (/^[AMDRC]$/.test(st) ? st : "M"); }

// ---- Diffstat header bar (10 cells, add/del proportional) ----
(function renderBar() {
  const bar = $("ds-bar");
  if (!bar) return;
  const a = DATA.additions, d = DATA.deletions, total = a + d;
  const cells = 10;
  const addN = total === 0 ? 0 : Math.round((a / total) * cells);
  for (let i = 0; i < cells; i++) {
    const c = el("i");
    if (total > 0) c.className = i < addN ? "on-add" : "on-del";
    bar.appendChild(c);
  }
})();

// ---- Tab switching ----
const segFiles = $("seg-files"), segCommits = $("seg-commits");
const panelFiles = $("panel-files"), panelCommits = $("panel-commits");
segFiles.onclick = () => { segFiles.classList.add("on"); segCommits.classList.remove("on"); panelFiles.hidden = false; panelCommits.hidden = true; };
segCommits.onclick = () => { segCommits.classList.add("on"); segFiles.classList.remove("on"); panelCommits.hidden = false; panelFiles.hidden = true; renderCommits(); };

// ---- Toolbar ----
$("pick-base").onclick = () => vscode.postMessage({ type: "pickBase" });
$("pick-head").onclick = () => vscode.postMessage({ type: "pickHead" });
$("swap").onclick = () => vscode.postMessage({ type: "swap" });
$("mode-3").onclick = () => vscode.postMessage({ type: "setMode", threeDot: true });
$("mode-2").onclick = () => vscode.postMessage({ type: "setMode", threeDot: false });

const filterInput = $("file-filter");
filterInput.addEventListener("input", () => { filter = filterInput.value.trim().toLowerCase(); renderFiles(); });

// ---- File-tree sidebar toggle (GitHub/GitLab-style) ----
const layoutEl = $("files-layout");
function applyTree() {
  layoutEl.classList.toggle("no-tree", !showTree);
  $("toggle-tree").classList.toggle("on", showTree);
  $("toggle-tree").setAttribute("aria-pressed", String(showTree));
}
$("toggle-tree").onclick = () => { showTree = !showTree; applyTree(); if (showTree) renderTreeNav(); };
// Auto-hide the sidebar on a narrow panel (like GitHub) — but honour an explicit
// user toggle afterwards.
let userToggledTree = false;
$("toggle-tree").addEventListener("click", () => { userToggledTree = true; }, true);
function autoTree() {
  if (userToggledTree) return;
  const want = window.innerWidth >= 820;
  if (want !== showTree) { showTree = want; applyTree(); if (showTree) renderTreeNav(); }
}
window.addEventListener("resize", autoTree);

// ---- Sidebar resizer (drag the divider) ----
(function wireResizer() {
  const rez = $("tree-resizer");
  let startX = 0, startW = 0, dragging = false;
  rez.addEventListener("pointerdown", (e) => {
    dragging = true; startX = e.clientX;
    startW = $("tree-sidebar").getBoundingClientRect().width;
    rez.classList.add("dragging"); rez.setPointerCapture(e.pointerId);
    document.body.style.userSelect = "none";
  });
  rez.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const w = Math.max(160, Math.min(520, startW + (e.clientX - startX)));
    document.documentElement.style.setProperty("--tree-w", w + "px");
  });
  const end = (e) => { if (!dragging) return; dragging = false; rez.classList.remove("dragging"); document.body.style.userSelect = ""; try { rez.releasePointerCapture(e.pointerId); } catch (_) {} };
  rez.addEventListener("pointerup", end);
  rez.addEventListener("pointercancel", end);
})();

$("diff-unified").onclick = () => setDiffMode("unified");
$("diff-split").onclick = () => setDiffMode("split");
function setDiffMode(m) {
  diffMode = m;
  $("diff-unified").classList.toggle("on", m === "unified");
  $("diff-split").classList.toggle("on", m === "split");
  // Re-render any already-open diffs from cache.
  document.querySelectorAll(".file.open").forEach((fEl) => {
    const p = fEl.dataset.path;
    if (patches.has(p)) renderDiffInto(fEl.querySelector(".file-body"), patches.get(p));
  });
}
$("expand-all").onclick = () => {
  // Count only files we actually expand (skip already-open ones) so the cap
  // reliably opens up to 60 collapsed files per click.
  let n = 0;
  document.querySelectorAll("#files-list .file").forEach((fEl) => {
    if (n >= 60) return;
    if (!fEl.classList.contains("open")) { toggleFile(fEl); n++; }
  });
};
$("collapse-all").onclick = () => {
  openPaths.clear();
  document.querySelectorAll("#files-list .file.open").forEach((fEl) => fEl.classList.remove("open"));
};

// ---- File list rendering (list or tree) ----
function fileMatches(f) { return !filter || f.path.toLowerCase().indexOf(filter) !== -1; }

function pathParts(p) {
  const i = p.lastIndexOf("/");
  return { name: i >= 0 ? p.slice(i + 1) : p, dir: i >= 0 ? p.slice(0, i) : "" };
}

function makeMiniBar(add, del) {
  const total = (add > 0 ? add : 0) + (del > 0 ? del : 0);
  const bar = el("span", "minibar");
  const cells = 5;
  const addN = total === 0 ? 0 : Math.max(1, Math.round((add / total) * cells));
  for (let i = 0; i < cells; i++) {
    const c = el("i");
    if (total > 0) c.className = i < addN ? "on-add" : "on-del";
    bar.appendChild(c);
  }
  return bar;
}

function makeFileEl(f) {
  const fileEl = el("div", "file");
  fileEl.dataset.path = f.path;
  const head = el("div", "file-head");
  head.appendChild(el("i", "codicon codicon-chevron-right chev"));
  head.appendChild(el("span", "st " + statusClass(f.status), f.status));
  const parts = pathParts(f.path);
  const pathEl = el("span", "path");
  if (f.oldPath && f.oldPath !== f.path) {
    pathEl.innerHTML = '<span class="old">' + escText(f.oldPath) + '</span> → ' +
      (parts.dir ? '<span class="dir">' + escText(parts.dir + "/") + '</span>' : "") + escText(parts.name);
  } else {
    pathEl.innerHTML = (parts.dir ? '<span class="dir">' + escText(parts.dir + "/") + '</span>' : "") + escText(parts.name);
  }
  pathEl.title = f.path;
  head.appendChild(pathEl);
  const nums = el("span", "fnums");
  if (f.additions > 0) nums.appendChild(el("span", "add", "+" + f.additions));
  if (f.deletions > 0) nums.appendChild(el("span", "del", "−" + f.deletions));
  if (f.additions < 0 || f.deletions < 0) nums.appendChild(el("span", "", "binary"));
  nums.appendChild(makeMiniBar(f.additions, f.deletions));
  head.appendChild(nums);
  const open = el("button", "open-native", '<i class="codicon codicon-diff"></i>');
  open.title = "Open in diff editor";
  open.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "openFile", path: f.path, oldPath: f.oldPath }); });
  head.appendChild(open);
  head.addEventListener("click", () => toggleFile(fileEl));
  fileEl.appendChild(head);
  const body = el("div", "file-body");
  fileEl.appendChild(body);
  // Restore the expanded state + diff after a list rebuild (filter / layout).
  if (openPaths.has(f.path)) {
    fileEl.classList.add("open");
    loadDiffInto(fileEl);
  }
  return fileEl;
}

// Fill a file's body from cache, or request it from the host if not yet loaded.
function loadDiffInto(fileEl) {
  const p = fileEl.dataset.path;
  const body = fileEl.querySelector(".file-body");
  if (patches.has(p)) {
    renderDiffInto(body, patches.get(p));
  } else if (!body.dataset.requested) {
    body.dataset.requested = "1";
    body.innerHTML = '<div class="diff-loading">Loading diff…</div>';
    const f = DATA.files.find((x) => x.path === p);
    vscode.postMessage({ type: "loadFileDiff", path: p, oldPath: f && f.oldPath });
  }
}

function toggleFile(fileEl) {
  const opening = !fileEl.classList.contains("open");
  fileEl.classList.toggle("open", opening);
  const p = fileEl.dataset.path;
  if (!opening) { openPaths.delete(p); return; }
  openPaths.add(p);
  loadDiffInto(fileEl);
}

// The MAIN pane is always a flat stack of file diffs (GitHub/GitLab-style); the
// tree lives in the left sidebar for navigation.
function renderFiles() {
  const list = $("files-list");
  list.textContent = "";
  const matched = DATA.files.filter(fileMatches);
  $("files-empty").hidden = DATA.files.length !== 0;
  $("files-nomatch").hidden = !(DATA.files.length !== 0 && matched.length === 0);
  matched.forEach((f) => list.appendChild(makeFileEl(f)));
  observeFiles();
  renderTreeNav();
}

// ---- Left file-tree sidebar (navigation) ----
// Clicking a leaf scrolls the matching diff into view and expands it; a scroll
// spy keeps the active leaf in sync as you scroll the diffs.
function renderTreeNav() {
  const nav = $("tree-nav");
  if (!nav) return;
  const matched = DATA.files.filter(fileMatches);
  $("tree-count").textContent = String(matched.length);
  nav.textContent = "";
  const root = { dirs: new Map(), files: [] };
  for (const f of matched) {
    const parts = f.path.split("/");
    parts.pop();
    let node = root;
    for (const part of parts) {
      let child = node.dirs.get(part);
      if (!child) { child = { dirs: new Map(), files: [] }; node.dirs.set(part, child); }
      node = child;
    }
    node.files.push(f);
  }
  function walk(node, depth, prefix, container) {
    for (const [name, child] of node.dirs) {
      // Compact single-child folder chains (a/b/c) into one header.
      let label = name, cur = child, dirPath = prefix + name;
      while (cur.files.length === 0 && cur.dirs.size === 1) {
        const [n2, c2] = cur.dirs.entries().next().value;
        label += "/" + n2; cur = c2; dirPath += "/" + n2;
      }
      const collapsed = collapsedDirs.has(dirPath);
      const folder = el("div", "tnav-folder" + (collapsed ? " collapsed" : ""));
      folder.style.paddingLeft = (6 + depth * 12) + "px";
      folder.appendChild(el("i", "codicon codicon-chevron-down tw"));
      folder.appendChild(el("i", "codicon codicon-folder"));
      folder.appendChild(el("span", "fname", escText(label)));
      const body = el("div", collapsed ? "tnav-collapsed-body" : "");
      folder.addEventListener("click", () => {
        const c = !collapsedDirs.has(dirPath);
        if (c) collapsedDirs.add(dirPath); else collapsedDirs.delete(dirPath);
        folder.classList.toggle("collapsed", c);
        body.className = c ? "tnav-collapsed-body" : "";
      });
      container.appendChild(folder);
      container.appendChild(body);
      walk(cur, depth + 1, dirPath + "/", body);
    }
    for (const f of node.files) {
      const parts = pathParts(f.path);
      const leaf = el("div", "tnav-file");
      leaf.style.paddingLeft = (6 + depth * 12) + "px";
      leaf.dataset.path = f.path;
      leaf.appendChild(el("span", "st " + statusClass(f.status), f.status));
      const nm = el("span", "nm", escText(parts.name)); nm.title = f.path; leaf.appendChild(nm);
      const nums = el("span", "nums");
      if (f.additions > 0) nums.appendChild(el("span", "a", "+" + f.additions));
      if (f.deletions > 0) nums.appendChild(el("span", "d", "−" + f.deletions));
      leaf.appendChild(nums);
      leaf.addEventListener("click", () => revealFile(f.path));
      container.appendChild(leaf);
    }
  }
  walk(root, 0, "", nav);
}

// A deliberate sidebar click should stay highlighted through the programmatic
// scroll — suppress the scroll spy briefly so it doesn't steal the selection
// (e.g. when a short/last file can't scroll all the way to the top).
let spySuppressUntil = 0;
function revealFile(path) {
  const sel = window.CSS && CSS.escape ? CSS.escape(path) : path;
  const fileEl = document.querySelector('#files-list .file[data-path="' + sel + '"]');
  if (!fileEl) return;
  if (!fileEl.classList.contains("open")) toggleFile(fileEl);
  spySuppressUntil = Date.now() + 800;
  fileEl.scrollIntoView({ behavior: "smooth", block: "start" });
  setActiveNav(path);
}

function setActiveNav(path) {
  document.querySelectorAll("#tree-nav .tnav-file").forEach((n) => n.classList.toggle("active", n.dataset.path === path));
}

// Scroll spy: highlight the sidebar leaf of the file-diff nearest the top.
let fileObserver = null;
function observeFiles() {
  if (fileObserver) fileObserver.disconnect();
  fileObserver = new IntersectionObserver((entries) => {
    if (Date.now() < spySuppressUntil) return;
    // Pick the top-most intersecting file head.
    let best = null, bestTop = Infinity;
    entries.forEach((e) => {
      if (e.isIntersecting) {
        const top = e.boundingClientRect.top;
        if (top < bestTop) { bestTop = top; best = e.target; }
      }
    });
    if (best) setActiveNav(best.closest(".file").dataset.path);
  }, { rootMargin: "-80px 0px -70% 0px", threshold: 0 });
  document.querySelectorAll("#files-list .file .file-head").forEach((h) => fileObserver.observe(h));
}

// ---- Commits ----
let commitsRendered = false;
function renderCommits() {
  if (commitsRendered) return;
  commitsRendered = true;
  const list = $("commits-list");
  $("commits-empty").hidden = DATA.commits.length !== 0;
  DATA.commits.forEach((c) => {
    const row = el("button", "cmp-commit");
    row.appendChild(el("span", "csha", escText(c.sha.slice(0, 7))));
    const subj = el("span", "subject", escText(c.subject)); subj.title = c.subject; row.appendChild(subj);
    row.appendChild(el("span", "meta", escText(c.author + " · " + c.rel)));
    row.addEventListener("click", () => vscode.postMessage({ type: "openCommit", sha: c.sha }));
    list.appendChild(row);
  });
}

// ---- Diff parsing + rendering ----
// Parse a unified patch into hunks with old/new line numbers.
function parseHunks(patch) {
  const lines = patch.split("\n");
  const hunks = [];
  let cur = null;
  let binary = false;
  for (const line of lines) {
    // A real diff line always carries a prefix (" ", "+", "-", "\\"); a truly
    // empty string is only the artifact of the trailing newline in git output —
    // skip it so it isn't rendered as a phantom context row.
    if (line === "") continue;
    if (line.startsWith("Binary files") || line.indexOf("GIT binary patch") === 0) { binary = true; continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line);
    if (m) {
      cur = { header: line, section: m[5] || "", rows: [], oldNo: parseInt(m[1], 10), newNo: parseInt(m[3], 10) };
      hunks.push(cur);
      continue;
    }
    if (!cur) continue; // skip diff --git / index / +++ / --- preamble
    const c = line[0];
    if (c === "+") cur.rows.push({ t: "add", text: line.slice(1), newNo: cur.newNo++ });
    else if (c === "-") cur.rows.push({ t: "del", text: line.slice(1), oldNo: cur.oldNo++ });
    else if (c === "\\") cur.rows.push({ t: "meta", text: line.slice(1) });
    else cur.rows.push({ t: "ctx", text: line.slice(1), oldNo: cur.oldNo++, newNo: cur.newNo++ });
  }
  return { hunks, binary };
}

function renderDiffInto(body, patch) {
  body.dataset.requested = "1";
  body.textContent = "";
  if (patch === "") { body.appendChild(el("div", "diff-note", "No textual diff (binary, empty, or rename with no content change).")); return; }
  const parsed = parseHunks(patch);
  if (parsed.binary) { body.appendChild(el("div", "diff-note", "Binary file — not shown.")); return; }
  if (!parsed.hunks.length) { body.appendChild(el("div", "diff-note", "No content changes.")); return; }
  body.appendChild(diffMode === "split" ? renderSplit(parsed.hunks) : renderUnified(parsed.hunks));
}

// Common prefix/suffix word highlight for a del/add line pair.
function wordDiff(delText, addText) {
  let s = 0;
  const minLen = Math.min(delText.length, addText.length);
  while (s < minLen && delText[s] === addText[s]) s++;
  let e = 0;
  while (e < minLen - s && delText[delText.length - 1 - e] === addText[addText.length - 1 - e]) e++;
  const dMid = delText.slice(s, delText.length - e);
  const aMid = addText.slice(s, addText.length - e);
  return {
    del: escText(delText.slice(0, s)) + (dMid ? '<span class="wd-del">' + escText(dMid) + "</span>" : "") + escText(delText.slice(delText.length - e)),
    add: escText(addText.slice(0, s)) + (aMid ? '<span class="wd-add">' + escText(aMid) + "</span>" : "") + escText(addText.slice(addText.length - e)),
  };
}

function unifiedRow(wrap, cls, oldNo, newNo, sign, codeHtml) {
  const row = el("div", "dl " + cls);
  row.appendChild(el("span", "ln", oldNo != null ? String(oldNo) : ""));
  row.appendChild(el("span", "ln", newNo != null ? String(newNo) : ""));
  const code = el("span", "code");
  code.innerHTML = '<span class="sign">' + sign + "</span>" + codeHtml;
  row.appendChild(code);
  wrap.appendChild(row);
}

function renderUnified(hunks) {
  const wrap = el("div", "diff");
  for (const h of hunks) {
    unifiedRow(wrap, "hunk", null, null, " ", escText(h.header));
    const rows = h.rows.filter((r) => r.t !== "meta");
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      // Isolated single del→add pair: highlight the intra-line change on both.
      if (r.t === "del" && rows[i + 1] && rows[i + 1].t === "add" &&
          (i === 0 || rows[i - 1].t !== "del") &&
          (!rows[i + 2] || rows[i + 2].t !== "add")) {
        const wd = wordDiff(r.text, rows[i + 1].text);
        unifiedRow(wrap, "del", r.oldNo, null, "-", wd.del);
        unifiedRow(wrap, "add", null, rows[i + 1].newNo, "+", wd.add);
        i++;
        continue;
      }
      const cls = r.t === "add" ? "add" : r.t === "del" ? "del" : "ctx";
      const sign = r.t === "add" ? "+" : r.t === "del" ? "-" : " ";
      unifiedRow(wrap, cls, r.oldNo != null ? r.oldNo : null, r.newNo != null ? r.newNo : null, sign, escText(r.text));
    }
  }
  return wrap;
}

function renderSplit(hunks) {
  const grid = el("div", "split");
  function cell(cls, num, text, sign) {
    const gut = el("div", "gut cell " + cls); gut.textContent = num != null ? String(num) : "";
    const code = el("div", "cell " + cls);
    code.textContent = (sign || "") + (text != null ? text : "");
    return [gut, code];
  }
  for (const h of hunks) {
    const hr = el("div", "hunkrow"); hr.textContent = h.header; grid.appendChild(hr);
    // Pair consecutive del/add runs side by side.
    const rows = h.rows.filter((r) => r.t !== "meta");
    let i = 0;
    while (i < rows.length) {
      const r = rows[i];
      if (r.t === "ctx") {
        const [lg, lc] = cell("", r.oldNo, r.text, " ");
        const [rg, rc] = cell("", r.newNo, r.text, " ");
        grid.append(lg, lc, rg, rc);
        i++;
      } else {
        const dels = [], adds = [];
        while (i < rows.length && rows[i].t === "del") dels.push(rows[i++]);
        while (i < rows.length && rows[i].t === "add") adds.push(rows[i++]);
        const n = Math.max(dels.length, adds.length);
        for (let k = 0; k < n; k++) {
          const d = dels[k], a = adds[k];
          if (d) { const [g, c] = cell("s-del", d.oldNo, d.text, "-"); grid.append(g, c); }
          else { grid.append(el("div", "gut cell s-empty"), el("div", "cell s-empty")); }
          if (a) { const [g, c] = cell("s-add", a.newNo, a.text, "+"); grid.append(g, c); }
          else { grid.append(el("div", "gut cell s-empty"), el("div", "cell s-empty")); }
        }
      }
    }
  }
  return grid;
}

// ---- Host → webview ----
window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "fileDiff") {
    patches.set(msg.path, msg.patch);
    const fileEl = document.querySelector('.file[data-path="' + (window.CSS && CSS.escape ? CSS.escape(msg.path) : msg.path) + '"]');
    if (fileEl && fileEl.classList.contains("open")) renderDiffInto(fileEl.querySelector(".file-body"), msg.patch);
  }
});

applyTree();
autoTree();
renderFiles();
`;
