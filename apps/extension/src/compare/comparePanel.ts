import * as vscode from "vscode";
import type { RepoManager } from "../git/repoManager";
import { getNonce } from "../webview/html";
import { relativeTime } from "../util/relativeTime";
// Shared design tokens, inlined as text by esbuild (see esbuild.js .css loader),
// so the compare panel matches every other GitStudio surface.
import tokensCss from "../../../../packages/webview-ui/src/styles/tokens.css";
import {
  compareRefsData,
  openCompareFileDiff,
  pickRef,
  type CompareFile,
  type CompareResult,
} from "./refCompare";
import type { CommitRecord, GitRef } from "@gitstudio/host-bridge/git";

/** Messages the compare webview posts back to the host. */
type CompareMessage =
  | { type: "pickBase" }
  | { type: "pickHead" }
  | { type: "swap" }
  | { type: "setMode"; threeDot: boolean }
  | { type: "openCommit"; sha: string }
  | { type: "openFile"; path: string }
  | { type: "refresh" };

/**
 * The branch/ref comparison panel (editor area) — GitHub/GitKraken-style: a base
 * and compare ref, a "what head adds (3-dot)" vs "all differences (2-dot)"
 * toggle, ahead/behind counts, and a Commits | Files tab pair. Commits reveal in
 * the graph; files open as a native side-by-side diff. Replaces the old Search &
 * Compare tree with the app's richer experience.
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
    this.panel.webview.html = this.render(result, active.root);
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

  private render(result: CompareResult, root: string): string {
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

    const commitsHtml = result.commits.length
      ? result.commits.map((c) => this.commitRow(c)).join("")
      : `<div class="cmp-empty">No commits — <b>${esc(this.head)}</b> has nothing that <b>${esc(this.base)}</b> doesn't.</div>`;
    const filesHtml = result.files.length
      ? result.files.map((f) => this.fileRow(f)).join("")
      : `<div class="cmp-empty">No file changes between these refs.</div>`;

    const behindNote =
      result.behind > 0
        ? ` · <span class="cmp-behind">${result.behind} behind</span>`
        : "";
    const summary = `<b>${esc(this.head)}</b> is <span class="cmp-ahead">${result.ahead} ahead</span>${behindNote} of <b>${esc(this.base)}</b>`;

    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${codiconUri}" rel="stylesheet" />
<style nonce="${nonce}">${tokensCss}</style>
<style nonce="${nonce}">
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0; color: var(--gs-fg); font-family: var(--gs-font-ui); font-size: 13px; background: var(--gs-bg); }
  .cmp-bar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; padding: 10px 14px; border-bottom: 1px solid var(--gs-border); position: sticky; top: 0; background: var(--gs-bg); z-index: 2; }
  .ref-pick { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px; border: 1px solid var(--gs-border); border-radius: var(--gs-radius); background: var(--gs-surface); color: var(--gs-fg); font: inherit; cursor: pointer; max-width: 240px; }
  .ref-pick:hover { background: var(--gs-hover); border-color: var(--gs-fg-subtle); }
  .ref-pick:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  .ref-pick .nm { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmp-dots { color: var(--gs-fg-muted); font-family: var(--gs-font-mono); }
  .icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border: 1px solid transparent; border-radius: var(--gs-radius); background: transparent; color: var(--gs-fg-muted); cursor: pointer; }
  .icon-btn:hover { background: var(--gs-hover); color: var(--gs-fg); }
  .icon-btn:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  .cmp-mode { display: inline-flex; margin-left: auto; border: 1px solid var(--gs-border); border-radius: var(--gs-radius); overflow: hidden; }
  .cmp-mode button { height: 28px; padding: 0 10px; border: none; background: transparent; color: var(--gs-fg-muted); font: inherit; cursor: pointer; transition: background var(--gs-motion-fast) var(--gs-ease), color var(--gs-motion-fast) var(--gs-ease); }
  .cmp-mode button:hover:not(.on) { background: var(--gs-hover); color: var(--gs-fg); }
  .cmp-mode button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -2px; }
  .cmp-mode button.on { background: color-mix(in srgb, var(--gs-brand) 16%, transparent); color: var(--gs-brand); font-weight: 600; }
  .cmp-summary { padding: 8px 14px; color: var(--gs-fg-muted); border-bottom: 1px solid var(--gs-border-soft); }
  .cmp-ahead { color: var(--gs-status-added); font-variant-numeric: tabular-nums; }
  .cmp-behind { color: var(--gs-amber); font-variant-numeric: tabular-nums; }
  .cmp-seg { display: flex; gap: 2px; padding: 8px 12px 0; }
  .cmp-seg button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border: none; border-bottom: 2px solid transparent; background: transparent; color: var(--gs-fg-muted); font: inherit; cursor: pointer; transition: color var(--gs-motion-fast) var(--gs-ease), border-color var(--gs-motion-fast) var(--gs-ease); }
  .cmp-seg button:hover:not(.on) { color: var(--gs-fg); }
  .cmp-seg button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -2px; }
  .cmp-seg button.on { color: var(--gs-fg); border-bottom-color: var(--gs-brand); }
  .cmp-seg .count { min-width: 18px; height: 16px; padding: 0 6px; border-radius: 999px; display: inline-flex; align-items: center; justify-content: center; font-size: 10.5px; font-weight: 600; font-variant-numeric: tabular-nums; background: color-mix(in srgb, var(--gs-fg) 11%, transparent); color: var(--gs-fg-muted); }
  .cmp-list { padding: 6px 8px 24px; }
  .cmp-list[hidden] { display: none; }
  .cmp-commit, .cmp-file { display: flex; align-items: baseline; gap: 8px; width: 100%; text-align: left; padding: 6px 8px; border: none; border-radius: var(--gs-radius-sm); background: transparent; color: var(--gs-fg); font: inherit; cursor: pointer; }
  .cmp-commit:hover, .cmp-file:hover { background: var(--gs-hover); }
  .cmp-commit { flex-direction: column; gap: 2px; align-items: stretch; }
  .cmp-commit .subject { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmp-commit .meta { font-size: 11.5px; color: var(--gs-fg-muted); }
  .cmp-file .st { flex: 0 0 auto; width: 14px; text-align: center; font-family: var(--gs-font-mono); font-weight: 700; font-size: 11px; }
  .cmp-file .name { flex: 0 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cmp-file .dir { flex: 1 1 auto; min-width: 0; color: var(--gs-fg-muted); font-size: 11.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; direction: rtl; text-align: left; }
  .st-A { color: var(--gs-status-added); }
  .st-M { color: var(--gs-status-modified); }
  .st-D { color: var(--gs-status-deleted); }
  .st-R { color: var(--gs-status-renamed); }
  .cmp-empty { padding: 32px 16px; text-align: center; color: var(--gs-fg-muted); }
  .codicon { font-size: 14px; vertical-align: -0.12em; }
</style>
</head>
<body>
  <div class="cmp-bar">
    <button class="ref-pick" id="pick-base" title="Change base ref"><i class="codicon codicon-git-branch"></i><span class="nm">${esc(this.base)}</span></button>
    <span class="cmp-dots">${this.threeDot ? "..." : ".."}</span>
    <button class="ref-pick" id="pick-head" title="Change compare ref"><i class="codicon codicon-git-branch"></i><span class="nm">${esc(this.head)}</span></button>
    <button class="icon-btn" id="swap" title="Swap base and compare"><i class="codicon codicon-arrow-swap"></i></button>
    <div class="cmp-mode" role="group" aria-label="Comparison mode">
      <button id="mode-3" class="${this.threeDot ? "on" : ""}" title="Commits and changes ${esc(this.head)} adds on top of the merge-base">What ${esc(this.head)} adds</button>
      <button id="mode-2" class="${this.threeDot ? "" : "on"}" title="Every difference between the two refs">All differences</button>
    </div>
  </div>
  <div class="cmp-summary">${summary}</div>
  <div class="cmp-seg">
    <button id="seg-commits" class="on"><i class="codicon codicon-git-commit"></i>Commits<span class="count">${result.ahead}</span></button>
    <button id="seg-files"><i class="codicon codicon-file"></i>Files<span class="count">${result.files.length}</span></button>
  </div>
  <div class="cmp-list" id="list-commits">${commitsHtml}</div>
  <div class="cmp-list" id="list-files" hidden>${filesHtml}</div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  $("pick-base").onclick = () => vscode.postMessage({ type: "pickBase" });
  $("pick-head").onclick = () => vscode.postMessage({ type: "pickHead" });
  $("swap").onclick = () => vscode.postMessage({ type: "swap" });
  $("mode-3").onclick = () => vscode.postMessage({ type: "setMode", threeDot: true });
  $("mode-2").onclick = () => vscode.postMessage({ type: "setMode", threeDot: false });
  const segC = $("seg-commits"), segF = $("seg-files"), listC = $("list-commits"), listF = $("list-files");
  segC.onclick = () => { segC.classList.add("on"); segF.classList.remove("on"); listC.hidden = false; listF.hidden = true; };
  segF.onclick = () => { segF.classList.add("on"); segC.classList.remove("on"); listF.hidden = false; listC.hidden = true; };
  document.querySelectorAll(".cmp-commit").forEach((el) =>
    el.addEventListener("click", () => vscode.postMessage({ type: "openCommit", sha: el.dataset.sha })));
  document.querySelectorAll(".cmp-file").forEach((el) =>
    el.addEventListener("click", () => vscode.postMessage({ type: "openFile", path: el.dataset.path })));
</script>
</body></html>`;
  }

  private commitRow(c: CommitRecord): string {
    const shortSha = c.sha.slice(0, 7);
    const meta = `${esc(c.author)} · ${shortSha} · ${esc(relativeTime(c.authorDate))}`;
    return `<button class="cmp-commit" data-sha="${esc(c.sha)}"><span class="subject">${esc(c.subject || "(no message)")}</span><span class="meta">${meta}</span></button>`;
  }

  private fileRow(f: CompareFile): string {
    const st = (f.status || "M").charAt(0).toUpperCase();
    const name = f.path.split("/").pop() ?? f.path;
    const dir = f.path.includes("/")
      ? f.path.slice(0, f.path.lastIndexOf("/"))
      : "";
    return `<button class="cmp-file st-${esc(st)}" data-path="${esc(f.path)}"><span class="st">${esc(st)}</span><span class="name">${esc(name)}</span><span class="dir">${esc(dir)}</span></button>`;
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
