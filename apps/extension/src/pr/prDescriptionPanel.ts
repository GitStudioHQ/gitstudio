import * as vscode from "vscode";
import { getNonce } from "../webview/html";
import { relativeTime } from "../util/relativeTime";
import {
  GitHubApi,
  GitHubApiError,
  type PullRequest,
  type PrFile,
  type CombinedStatus,
} from "./githubApi";
import type { GitHubRepoContext } from "./repoContext";
import { openPrFileDiff } from "./reviewDiff";

// A read-clean PR description panel (editor area, strict CSP + nonce). All
// dynamic text is HTML-escaped on the host before it reaches the DOM — the PR
// body is rendered through a tiny, escaped Markdown-ish formatter (headings,
// bold/italic/code, links, lists) that NEVER injects raw HTML. Buttons post
// messages back to the host for Checkout / Open on GitHub / Merge / Start
// Review and a manual Refresh.

interface PanelDeps {
  api: GitHubApi;
  ctx: GitHubRepoContext;
  extensionUri: vscode.Uri;
}

interface WebviewMessage {
  type: "checkout" | "openOnGitHub" | "merge" | "startReview" | "refresh" | "openFile";
  path?: string;
}

export class PrDescriptionPanel {
  private static readonly panels = new Map<string, PrDescriptionPanel>();

  /** Open (or reveal) the description panel for a PR. */
  static async show(
    deps: PanelDeps,
    pr: PullRequest,
  ): Promise<PrDescriptionPanel> {
    const key = `${deps.ctx.owner}/${deps.ctx.repo}#${pr.number}`;
    const existing = PrDescriptionPanel.panels.get(key);
    if (existing) {
      existing.panel.reveal(vscode.ViewColumn.Active);
      await existing.update(pr);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      "gitstudio.prDescription",
      `PR #${pr.number}`,
      vscode.ViewColumn.Active,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    const instance = new PrDescriptionPanel(key, panel, deps, pr);
    PrDescriptionPanel.panels.set(key, instance);
    await instance.update(pr);
    return instance;
  }

  private readonly disposables: vscode.Disposable[] = [];
  private pr: PullRequest;
  private files: PrFile[] = [];
  private status: CombinedStatus | undefined;

  private constructor(
    private readonly key: string,
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: PanelDeps,
    pr: PullRequest,
  ) {
    this.pr = pr;
    this.panel.title = `PR #${pr.number}`;
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: WebviewMessage) =>
        this.onMessage(m),
      ),
      this.panel.onDidDispose(() => this.dispose()),
    );
  }

  /** Re-fetch the PR detail + files + status and re-render. */
  async update(pr?: PullRequest): Promise<void> {
    const { api, ctx } = this.deps;
    try {
      // Always pull fresh detail (additions/deletions etc. only on detail).
      this.pr = await api.getPull(ctx.owner, ctx.repo, (pr ?? this.pr).number);
    } catch (err) {
      if (pr) {
        this.pr = pr;
      } else {
        void this.showLoadError(err);
      }
    }
    try {
      this.files = await api.getPullFiles(ctx.owner, ctx.repo, this.pr.number);
    } catch {
      this.files = [];
    }
    try {
      this.status = await api.getCombinedStatus(
        ctx.owner,
        ctx.repo,
        this.pr.head.sha,
      );
    } catch {
      this.status = undefined;
    }
    this.render();
  }

  private async showLoadError(err: unknown): Promise<void> {
    const msg =
      err instanceof GitHubApiError
        ? err.message
        : "Couldn't load the pull request.";
    void vscode.window.showWarningMessage(msg);
  }

  private render(): void {
    this.panel.webview.html = renderHtml(this.panel.webview, this.pr, this.files, this.status);
  }

  private async onMessage(m: WebviewMessage): Promise<void> {
    switch (m.type) {
      case "refresh":
        await this.update();
        return;
      case "openOnGitHub":
        void vscode.env.openExternal(vscode.Uri.parse(this.pr.htmlUrl));
        return;
      case "checkout":
        void vscode.commands.executeCommand("gitstudio.pr.checkout", {
          pr: this.pr,
          ctx: this.deps.ctx,
        });
        return;
      case "startReview":
        void vscode.commands.executeCommand("gitstudio.pr.startReview", {
          pr: this.pr,
          ctx: this.deps.ctx,
        });
        return;
      case "merge":
        void vscode.commands.executeCommand("gitstudio.pr.merge", {
          pr: this.pr,
          ctx: this.deps.ctx,
        });
        // The merged PR will close; refresh shortly to reflect new state.
        return;
      case "openFile":
        if (m.path) {
          const file = this.files.find((f) => f.filename === m.path);
          if (file) {
            void openPrFileDiff(this.deps.ctx, this.pr, file);
          }
        }
        return;
    }
  }

  dispose(): void {
    PrDescriptionPanel.panels.delete(this.key);
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.panel.dispose();
  }
}

// ── HTML rendering (host-side, fully escaped) ───────────────────────────────────

function renderHtml(
  webview: vscode.Webview,
  pr: PullRequest,
  files: PrFile[],
  status: CombinedStatus | undefined,
): string {
  const nonce = getNonce();
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  const stateBadge = pr.draft
    ? `<span class="badge badge-draft">${ICON.draft}Draft</span>`
    : pr.state === "open"
      ? `<span class="badge badge-open">${ICON.prOpen}Open</span>`
      : pr.state === "closed"
        ? `<span class="badge badge-merged">${ICON.merged}${esc(cap(pr.state))}</span>`
        : `<span class="badge">${esc(cap(pr.state))}</span>`;

  const author = pr.user;
  const avatar = author?.avatarUrl
    ? `<img class="avatar" src="${esc(author.avatarUrl)}" alt="" width="20" height="20" />`
    : `<span class="avatar avatar--fallback" aria-hidden="true">${ICON.person}</span>`;
  const age = relativeTime(Date.parse(pr.createdAt) / 1000);

  const labels = pr.labels
    .map((l) => {
      const hex = sanitizeColor(l.color);
      return `<span class="gs-chip label" style="--label:#${esc(hex)}">${esc(l.name)}</span>`;
    })
    .join("");

  const reviewers = pr.requestedReviewers
    .map(
      (r) =>
        `<span class="gs-chip reviewer">${ICON.person}<span>${esc(r.login)}</span></span>`,
    )
    .join("");

  const checks = status
    ? `<div class="checks ${checkClass(status.state)}">${checkIcon(status.state)}<span>${esc(checkLabel(status))}</span></div>`
    : "";

  const totalAdd = files.reduce((n, f) => n + f.additions, 0);
  const totalDel = files.reduce((n, f) => n + f.deletions, 0);

  const fileRows = files
    .map((f) => {
      const dir = f.filename.includes("/")
        ? f.filename.slice(0, f.filename.lastIndexOf("/") + 1)
        : "";
      const name = f.filename.slice(dir.length);
      const path = dir
        ? `<span class="fdir">${esc(dir)}</span><span class="fbase">${esc(name)}</span>`
        : `<span class="fbase">${esc(name)}</span>`;
      return `<li><button class="filerow" data-path="${esc(f.filename)}" title="${esc(f.filename)}">
        <span class="fstatus fstatus--${esc(fileStatusClass(f.status))}" aria-hidden="true">${fileStatusGlyph(f.status)}</span>
        <span class="fname">${path}</span>
        <span class="fstat gs-mono"><span class="add">+${f.additions}</span><span class="del">−${f.deletions}</span></span>
      </button></li>`;
    })
    .join("");

  const bodyHtml = renderMarkdownish(pr.body ?? "");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<style nonce="${nonce}">
  :root {
    --gs-fg: var(--vscode-foreground);
    --gs-fg-muted: var(--vscode-descriptionForeground);
    --gs-border: var(--vscode-panel-border, var(--vscode-widget-border));
    --gs-hover: var(--vscode-list-hoverBackground);
    --gs-accent: var(--vscode-focusBorder);
    --gs-link: var(--vscode-textLink-foreground);
    --gs-font-ui: var(--vscode-font-family);
    --gs-font-mono: var(--vscode-editor-font-family, ui-monospace, monospace);
    --gs-radius: 6px;
    --gs-radius-sm: 5px;
    --gs-green: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green));
    --gs-red: var(--vscode-gitDecoration-deletedResourceForeground, var(--vscode-charts-red, var(--vscode-errorForeground)));
    --gs-amber: var(--vscode-charts-yellow);
    --gs-motion: 170ms;
    --gs-ease: cubic-bezier(0.2, 0, 0, 1);
  }
  * { box-sizing: border-box; }
  body {
    color: var(--gs-fg);
    font-family: var(--gs-font-ui);
    font-size: 13px;
    /* Constrain to a comfortable reading measure and center it, so the PR reads
       like a document rather than stretching across a wide editor panel. */
    max-width: 940px;
    margin: 0 auto;
    padding: 0 24px 32px;
    line-height: 1.5;
  }
  .gs-mono { font-family: var(--gs-font-mono); font-variant-numeric: tabular-nums; }
  svg { flex: none; }

  /* ── Header ─────────────────────────────────────────────── */
  .header { padding-top: 18px; }
  h1 { font-size: 19px; font-weight: 600; line-height: 1.3; margin: 0 0 6px; }
  h1 .num { color: var(--gs-fg-muted); font-weight: 400; }
  .meta { color: var(--gs-fg-muted); display: flex; align-items: center; gap: 7px; flex-wrap: wrap; font-size: 12px; }
  .meta .author { color: var(--gs-fg); font-weight: 600; }
  .meta .dot { opacity: 0.5; }
  .avatar { width: 20px; height: 20px; border-radius: 50%; vertical-align: middle; }
  .avatar--fallback { display: inline-flex; align-items: center; justify-content: center; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }

  /* ── State badges ───────────────────────────────────────── */
  .badge {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 9px 2px 7px; border-radius: 11px; font-size: 11.5px; font-weight: 600;
    color: var(--vscode-foreground); background: color-mix(in srgb, var(--gs-fg-muted) 16%, transparent);
  }
  .badge svg { width: 13px; height: 13px; }
  .badge-open { background: var(--gs-green); color: var(--vscode-editor-background); }
  .badge-draft { background: var(--gs-fg-muted); color: var(--vscode-editor-background); }
  .badge-merged { background: var(--vscode-charts-purple, var(--gs-link)); color: var(--vscode-editor-background); }

  /* ── Branch chips (base ← head) ─────────────────────────── */
  .branches { display: flex; align-items: center; gap: 8px; margin: 12px 0 4px; flex-wrap: wrap; }
  .branch {
    display: inline-flex; align-items: center; gap: 5px;
    font-family: var(--gs-font-mono); font-size: 12px;
    padding: 2px 8px; border-radius: var(--gs-radius);
    color: var(--gs-accent);
    background: color-mix(in srgb, var(--gs-accent) 12%, transparent);
    border: 1px solid color-mix(in srgb, var(--gs-accent) 30%, transparent);
  }
  .branch--head { color: var(--gs-fg); background: color-mix(in srgb, var(--gs-fg-muted) 12%, transparent); border-color: color-mix(in srgb, var(--gs-fg-muted) 26%, transparent); }
  .branch svg { width: 13px; height: 13px; opacity: 0.85; }
  .merge-arrow { color: var(--gs-fg-muted); display: inline-flex; }
  .merge-arrow svg { width: 14px; height: 14px; }

  /* ── Toolbar ────────────────────────────────────────────── */
  .toolbar { display: flex; gap: 6px; flex-wrap: wrap; margin: 16px 0 4px; }
  button { font-family: inherit; font-size: inherit; cursor: pointer; }
  .toolbar button {
    display: inline-flex; align-items: center; gap: 6px;
    height: 28px; padding: 0 13px; border-radius: var(--gs-radius);
    border: 1px solid transparent; font-weight: 600;
    background:
      linear-gradient(180deg,
        color-mix(in srgb, var(--vscode-button-background) 88%, white 12%),
        var(--vscode-button-background));
    color: var(--vscode-button-foreground);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.16),
      inset 0 1px 0 color-mix(in srgb, white 16%, transparent);
    transition: background var(--gs-motion) var(--gs-ease),
      box-shadow var(--gs-motion) var(--gs-ease),
      transform var(--gs-motion) var(--gs-ease);
  }
  .toolbar button:active { transform: translateY(0.5px); }
  .toolbar button svg { width: 14px; height: 14px; }
  .toolbar button.secondary {
    background: var(--vscode-button-secondaryBackground, transparent);
    color: var(--vscode-button-secondaryForeground, var(--gs-fg));
    border-color: var(--vscode-button-border, var(--gs-border));
    box-shadow: none;
  }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  .toolbar button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground, var(--gs-hover)); }
  button:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: 2px; }

  /* ── Sections ───────────────────────────────────────────── */
  .section { margin-top: 22px; }
  .section h2 {
    font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
    color: var(--gs-fg-muted); margin: 0 0 8px; padding-bottom: 5px;
    border-bottom: 1px solid var(--gs-border);
  }
  .chip-row { display: flex; flex-wrap: wrap; gap: 6px; }

  /* ── Chips (labels / reviewers) ─────────────────────────── */
  .gs-chip {
    display: inline-flex; align-items: center; gap: 4px;
    padding: 2px 8px; border-radius: var(--gs-radius);
    font-size: 11.5px; line-height: 1.4; white-space: nowrap;
    border: 1px solid transparent;
  }
  .label {
    color: var(--gs-fg);
    background: color-mix(in srgb, var(--label, var(--gs-fg-muted)) 16%, transparent);
    border-color: color-mix(in srgb, var(--label, var(--gs-fg-muted)) 42%, transparent);
  }
  .reviewer {
    color: var(--gs-link);
    background: color-mix(in srgb, var(--gs-link) 12%, transparent);
    border-color: color-mix(in srgb, var(--gs-link) 28%, transparent);
  }
  .reviewer svg { width: 12px; height: 12px; }

  /* ── Checks summary ─────────────────────────────────────── */
  .checks {
    display: inline-flex; align-items: center; gap: 7px;
    padding: 6px 12px; border-radius: var(--gs-radius); font-size: 12.5px; font-weight: 600;
    border: 1px solid var(--gs-border); background: color-mix(in srgb, var(--gs-fg-muted) 7%, transparent);
  }
  .checks svg { width: 15px; height: 15px; }
  .checks.ok { color: var(--gs-green); border-color: color-mix(in srgb, var(--gs-green) 35%, transparent); background: color-mix(in srgb, var(--gs-green) 8%, transparent); }
  .checks.fail { color: var(--gs-red); border-color: color-mix(in srgb, var(--gs-red) 35%, transparent); background: color-mix(in srgb, var(--gs-red) 8%, transparent); }
  .checks.pending { color: var(--gs-amber); border-color: color-mix(in srgb, var(--gs-amber) 35%, transparent); background: color-mix(in srgb, var(--gs-amber) 8%, transparent); }

  /* ── Description body ───────────────────────────────────── */
  .body { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--gs-border); border-radius: 6px; padding: 12px 16px; }
  .body :first-child { margin-top: 0; }
  .body :last-child { margin-bottom: 0; }
  .body h3, .body h4, .body h5, .body h6 { font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  .body code { background: var(--vscode-textPreformat-background, rgba(127,127,127,0.2)); padding: 1px 5px; border-radius: 3px; font-family: var(--gs-font-mono); font-size: 12px; }
  .body pre { background: var(--vscode-textPreformat-background, rgba(127,127,127,0.2)); padding: 10px 12px; border-radius: var(--gs-radius); overflow-x: auto; }
  .body pre code { background: none; padding: 0; }
  .body a { color: var(--gs-link); }
  .body ul { padding-left: 20px; }

  /* ── Changed files ──────────────────────────────────────── */
  .files-summary { display: inline-flex; align-items: center; gap: 8px; margin-left: 6px; font-size: 12px; font-weight: 400; }
  .files-summary .add { color: var(--gs-green); }
  .files-summary .del { color: var(--gs-red); }
  ul.files { list-style: none; padding: 0; margin: 0; border: 1px solid var(--gs-border); border-radius: 6px; overflow: hidden; }
  ul.files li + li .filerow { border-top: 1px solid var(--gs-border); }
  .filerow {
    display: flex; align-items: center; gap: 8px; width: 100%; min-height: 30px;
    text-align: left; background: transparent; color: var(--gs-fg);
    border: none; padding: 5px 10px;
    transition: background var(--gs-motion) ease;
  }
  .filerow:hover { background: var(--gs-hover); }
  .filerow:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  .fstatus { display: inline-flex; align-items: center; justify-content: center; width: 14px; font-family: var(--gs-font-mono); font-weight: 700; font-size: 12px; }
  .fstatus svg { width: 13px; height: 13px; }
  .fstatus--added { color: var(--gs-green); }
  .fstatus--deleted { color: var(--gs-red); }
  .fstatus--modified { color: var(--gs-amber); }
  .fstatus--renamed { color: var(--gs-link); }
  .fname { flex: 1; min-width: 0; font-family: var(--gs-font-mono); font-size: 12.5px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .fdir { color: var(--gs-fg-muted); }
  .fstat { display: inline-flex; gap: 8px; font-size: 12px; flex: none; }
  .add { color: var(--gs-green); } .del { color: var(--gs-red); }
  .empty { color: var(--gs-fg-muted); font-style: italic; }

  @media (prefers-reduced-motion: reduce) {
    .toolbar button, .filerow { transition: none; }
  }
</style>
</head>
<body>
  <header class="header">
    <h1><span class="num">#${pr.number}</span> ${esc(pr.title)}</h1>
    <div class="meta">
      ${stateBadge}
      ${avatar}
      <span class="author">${esc(author?.login ?? "unknown")}</span>
      <span class="dot">·</span>
      <span>opened ${esc(age)} ago</span>
    </div>
    <div class="branches">
      <span class="branch">${ICON.gitBranch}${esc(pr.base.ref)}</span>
      <span class="merge-arrow" aria-label="merges into" title="${esc(pr.head.label)} → ${esc(pr.base.ref)}">${ICON.arrowLeft}</span>
      <span class="branch branch--head">${ICON.gitBranch}${esc(pr.head.label)}</span>
    </div>
  </header>

  <div class="toolbar">
    <button id="btn-checkout">${ICON.checkout}Checkout</button>
    <button id="btn-review" class="secondary">${ICON.review}Start Review</button>
    <button id="btn-merge" class="secondary">${ICON.merge}Merge…</button>
    <button id="btn-open" class="secondary">${ICON.external}Open on GitHub</button>
    <button id="btn-refresh" class="secondary">${ICON.refresh}Refresh</button>
  </div>

  ${checks ? `<div class="section">${checks}</div>` : ""}
  ${labels ? `<div class="section"><h2>Labels</h2><div class="chip-row">${labels}</div></div>` : ""}
  ${reviewers ? `<div class="section"><h2>Reviewers</h2><div class="chip-row">${reviewers}</div></div>` : ""}

  <div class="section">
    <h2>Description</h2>
    <div class="body">${bodyHtml || `<span class="empty">No description provided.</span>`}</div>
  </div>

  <div class="section">
    <h2>Changed files (${files.length})${files.length > 0 ? `<span class="files-summary gs-mono"><span class="add">+${totalAdd}</span><span class="del">−${totalDel}</span></span>` : ""}</h2>
    ${files.length > 0 ? `<ul class="files">${fileRows}</ul>` : `<span class="empty">No file data.</span>`}
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const post = (type, extra) => vscode.postMessage(Object.assign({ type }, extra || {}));
    document.getElementById("btn-checkout").addEventListener("click", () => post("checkout"));
    document.getElementById("btn-review").addEventListener("click", () => post("startReview"));
    document.getElementById("btn-merge").addEventListener("click", () => post("merge"));
    document.getElementById("btn-open").addEventListener("click", () => post("openOnGitHub"));
    document.getElementById("btn-refresh").addEventListener("click", () => post("refresh"));
    for (const el of document.querySelectorAll(".filerow")) {
      el.addEventListener("click", () => post("openFile", { path: el.getAttribute("data-path") }));
    }
  </script>
</body>
</html>`;
}

function checkClass(state: string): string {
  if (state === "success") return "ok";
  if (state === "failure" || state === "error") return "fail";
  return "pending";
}

function checkLabel(status: CombinedStatus): string {
  if (status.totalCount === 0) return "No checks";
  switch (status.state) {
    case "success":
      return `All ${status.totalCount} checks passed`;
    case "failure":
    case "error":
      return `Some checks failed`;
    default:
      return `Checks pending`;
  }
}

/** Inline SVG icon for the checks summary (currentColor, no emoji). */
function checkIcon(state: string): string {
  if (state === "success") return ICON.pass;
  if (state === "failure" || state === "error") return ICON.fail;
  return ICON.pending;
}

/** Capitalize the first letter of a state word ("closed" → "Closed"). */
function cap(s: string): string {
  return s.length > 0 ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

/** Map a GitHub per-file status to a stable CSS class. */
function fileStatusClass(status: string): string {
  switch (status) {
    case "added":
      return "added";
    case "removed":
      return "deleted";
    case "renamed":
      return "renamed";
    default:
      return "modified";
  }
}

/** Single-letter status glyph (A/M/D/R), tabular-monospace — not an emoji. */
function fileStatusGlyph(status: string): string {
  switch (status) {
    case "added":
      return "A";
    case "removed":
      return "D";
    case "renamed":
      return "R";
    default:
      return "M";
  }
}

/**
 * Inline SVG icons drawn with `currentColor` so they inherit theme-native text
 * color in dark, light, and high-contrast. These replace every former emoji /
 * decorative unicode glyph (the old check / cross / dot / arrow) in this
 * surface.
 */
const ICON = {
  pass: svg(
    `<circle cx="8" cy="8" r="6.5"/><path d="M5.2 8.2l1.9 1.9 3.7-4.2"/>`,
    { stroke: true },
  ),
  fail: svg(
    `<circle cx="8" cy="8" r="6.5"/><path d="M6 6l4 4M10 6l-4 4"/>`,
    { stroke: true },
  ),
  pending: svg(
    `<circle cx="8" cy="8" r="6.5"/><path d="M8 5v3.2l2 1.3"/>`,
    { stroke: true },
  ),
  prOpen: svg(
    `<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="12" r="1.6"/><path d="M5 5.6v4.8M11 10.4V8.2a2 2 0 0 0-2-2H6.6"/>`,
    { stroke: true },
  ),
  merged: svg(
    `<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="6" r="1.6"/><path d="M5 5.6v4.8M9.4 6H8a3 3 0 0 0-3 3"/>`,
    { stroke: true },
  ),
  draft: svg(
    `<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="12" r="1.6" stroke-dasharray="1.4 1.4"/><path d="M5 5.6v4.8"/>`,
    { stroke: true },
  ),
  gitBranch: svg(
    `<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="5" r="1.6"/><path d="M5 5.6v4.8M9.6 5.4 H8a3 3 0 0 0-3 3"/>`,
    { stroke: true },
  ),
  arrowLeft: svg(`<path d="M11 8H4M7 4.5 3.5 8 7 11.5"/>`, { stroke: true }),
  person: svg(
    `<circle cx="8" cy="5.5" r="2.6"/><path d="M3.5 13c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4"/>`,
    { stroke: true },
  ),
  checkout: svg(
    `<path d="M8 2v8M5 7l3 3 3-3M3.5 13.5h9"/>`,
    { stroke: true },
  ),
  review: svg(
    `<path d="M8 4.5C5 4.5 3 8 3 8s2 3.5 5 3.5S13 8 13 8 11 4.5 8 4.5Z"/><circle cx="8" cy="8" r="1.6"/>`,
    { stroke: true },
  ),
  merge: svg(
    `<circle cx="5" cy="4" r="1.6"/><circle cx="5" cy="12" r="1.6"/><circle cx="11" cy="6" r="1.6"/><path d="M5 5.6v4.8M9.4 6H8a3 3 0 0 0-3 3"/>`,
    { stroke: true },
  ),
  external: svg(
    `<path d="M9.5 3.5H12.5V6.5M12.5 3.5 8 8M11 9v2.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5"/>`,
    { stroke: true },
  ),
  refresh: svg(
    `<path d="M12.5 8a4.5 4.5 0 1 1-1.3-3.2M12.5 2.5V5H10"/>`,
    { stroke: true },
  ),
} as const;

/** Wrap a set of SVG path/shape children into a 16×16 currentColor icon. */
function svg(children: string, opts: { stroke?: boolean } = {}): string {
  const paint = opts.stroke
    ? `fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`
    : `fill="currentColor"`;
  return `<svg viewBox="0 0 16 16" ${paint} aria-hidden="true" focusable="false">${children}</svg>`;
}

/** Only allow a 3- or 6-hex-digit color; otherwise fall back to a neutral. */
function sanitizeColor(color: string): string {
  return /^[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(color) ? color : "888888";
}

/** HTML-escape a string for safe insertion into text/attribute positions. */
function esc(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A tiny, SAFE Markdown-ish renderer. The input is escaped FIRST, so no raw
 * HTML can survive; we then re-introduce a small, fixed set of formatting tags
 * (headings, bold/italic, inline + fenced code, links, list items). Links only
 * accept http/https URLs. This is intentionally minimal — readability, not
 * fidelity, is the goal, and security is non-negotiable.
 */
function renderMarkdownish(src: string): string {
  if (src.trim().length === 0) {
    return "";
  }
  // Pull out fenced code blocks first (on escaped text) so their contents are
  // not further formatted.
  const escaped = esc(src.replace(/\r\n/g, "\n"));
  const blocks: string[] = [];
  let withFences = escaped.replace(/```([\s\S]*?)```/g, (_m, code: string) => {
    const idx = blocks.push(`<pre><code>${code.replace(/^\n/, "")}</code></pre>`) - 1;
    return ` BLOCK${idx} `;
  });

  const lines = withFences.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const raw of lines) {
    const placeholder = /^ BLOCK\d+ $/.test(raw.trim());
    if (placeholder) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(raw.trim());
      continue;
    }
    const line = raw;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const listItem = /^[-*]\s+(.*)$/.exec(line);
    if (heading) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      const level = Math.min(heading[1].length + 2, 6); // h3..h6 inside body
      out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
    } else if (listItem) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(listItem[1])}</li>`);
    } else if (line.trim().length === 0) {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push("");
    } else {
      if (inList) {
        out.push("</ul>");
        inList = false;
      }
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inList) {
    out.push("</ul>");
  }

  let html = out.join("\n");
  // Restore fenced code blocks.
  html = html.replace(/ BLOCK(\d+) /g, (_m, i: string) => blocks[Number(i)] ?? "");
  return html;
}

/** Inline formatting on already-escaped text: code, bold, italic, links. */
function inline(text: string): string {
  let s = text;
  // Inline code (no further formatting inside).
  const codes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, c: string) => {
    const idx = codes.push(`<code>${c}</code>`) - 1;
    return `C${idx}`;
  });
  // Links [text](http...). URL is validated to http/https only. The slashes
  // survive esc() untouched; only a literal `&` would have become `&amp;`.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g,
    (_m, label: string, url: string) => {
      const clean = url.replace(/&amp;/g, "&");
      return `<a href="${esc(clean)}">${label}</a>`;
    },
  );
  // Bold then italic.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/(^|[^*])\*([^*]+)\*/g, "$1<em>$2</em>");
  s = s.replace(/C(\d+)/g, (_m, i: string) => codes[Number(i)] ?? "");
  return s;
}
