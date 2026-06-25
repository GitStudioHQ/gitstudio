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
    ? `<span class="badge badge-draft">Draft</span>`
    : pr.state === "open"
      ? `<span class="badge badge-open">Open</span>`
      : `<span class="badge">${esc(pr.state)}</span>`;

  const author = pr.user;
  const avatar = author?.avatarUrl
    ? `<img class="avatar" src="${esc(author.avatarUrl)}" alt="" width="20" height="20" />`
    : "";
  const age = relativeTime(Date.parse(pr.createdAt) / 1000);

  const labels = pr.labels
    .map(
      (l) =>
        `<span class="label" style="border-color:#${esc(sanitizeColor(l.color))}">${esc(l.name)}</span>`,
    )
    .join(" ");

  const reviewers = pr.requestedReviewers
    .map((r) => `<span class="reviewer">@${esc(r.login)}</span>`)
    .join(" ");

  const checks = status
    ? `<div class="checks ${checkClass(status.state)}">${checkLabel(status)}</div>`
    : "";

  const fileRows = files
    .map((f) => {
      const stat = `<span class="add">+${f.additions}</span> <span class="del">−${f.deletions}</span>`;
      return `<li><button class="filerow" data-path="${esc(f.filename)}">
        <span class="fname">${esc(f.filename)}</span>
        <span class="fstat">${stat}</span>
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
  body {
    color: var(--vscode-foreground);
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    padding: 0 20px 24px;
    line-height: 1.5;
  }
  h1 { font-size: 1.4em; margin: 16px 0 4px; }
  .num { color: var(--vscode-descriptionForeground); font-weight: normal; }
  .meta { color: var(--vscode-descriptionForeground); display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .avatar { border-radius: 50%; vertical-align: middle; }
  .branches { margin: 10px 0; font-family: var(--vscode-editor-font-family, monospace); }
  .branch { background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; }
  .badge { padding: 2px 8px; border-radius: 10px; font-size: 0.85em; border: 1px solid var(--vscode-panel-border); }
  .badge-open { background: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #2da44e)); color: var(--vscode-editor-background, #fff); border: none; }
  .badge-draft { background: var(--vscode-descriptionForeground); color: var(--vscode-editor-background); border: none; }
  .toolbar { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; }
  button { font-family: inherit; font-size: inherit; cursor: pointer; }
  .toolbar button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none; padding: 5px 12px; border-radius: 4px;
  }
  .toolbar button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  .toolbar button:hover { background: var(--vscode-button-hoverBackground); }
  button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
  .section { margin-top: 18px; }
  .section h2 { font-size: 0.95em; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
  .label { border: 1px solid; border-radius: 10px; padding: 1px 8px; font-size: 0.85em; }
  .reviewer { color: var(--vscode-textLink-foreground); }
  .checks { display: inline-block; padding: 4px 10px; border-radius: 4px; }
  .checks.ok { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #2da44e)); }
  .checks.fail { color: var(--vscode-errorForeground); }
  .checks.pending { color: var(--vscode-descriptionForeground); }
  .body { background: var(--vscode-textCodeBlock-background); border: 1px solid var(--vscode-panel-border); border-radius: 6px; padding: 12px 16px; }
  .body code { background: var(--vscode-textPreformat-background, rgba(127,127,127,0.2)); padding: 0 4px; border-radius: 3px; font-family: var(--vscode-editor-font-family, monospace); }
  .body pre { background: var(--vscode-textPreformat-background, rgba(127,127,127,0.2)); padding: 8px 12px; border-radius: 4px; overflow-x: auto; }
  .body a { color: var(--vscode-textLink-foreground); }
  .body ul { padding-left: 20px; }
  ul.files { list-style: none; padding: 0; }
  .filerow { display: flex; justify-content: space-between; width: 100%; text-align: left; background: transparent; color: var(--vscode-foreground); border: none; border-bottom: 1px solid var(--vscode-panel-border); padding: 6px 4px; }
  .filerow:hover { background: var(--vscode-list-hoverBackground); }
  .filerow:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .fname { font-family: var(--vscode-editor-font-family, monospace); }
  .add { color: var(--vscode-gitDecoration-addedResourceForeground, var(--vscode-charts-green, #2da44e)); } .del { color: var(--vscode-errorForeground); }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
  <h1><span class="num">#${pr.number}</span> ${esc(pr.title)}</h1>
  <div class="meta">
    ${stateBadge}
    ${avatar}
    <span>${esc(author?.login ?? "unknown")}</span>
    <span>opened ${esc(age)} ago</span>
  </div>
  <div class="branches">
    <span class="branch">${esc(pr.base.ref)}</span> ← <span class="branch">${esc(pr.head.label)}</span>
  </div>

  <div class="toolbar">
    <button id="btn-checkout">Checkout</button>
    <button id="btn-review" class="secondary">Start Review</button>
    <button id="btn-merge" class="secondary">Merge…</button>
    <button id="btn-open" class="secondary">Open on GitHub</button>
    <button id="btn-refresh" class="secondary">Refresh</button>
  </div>

  ${checks ? `<div class="section">${checks}</div>` : ""}
  ${labels ? `<div class="section"><h2>Labels</h2>${labels}</div>` : ""}
  ${reviewers ? `<div class="section"><h2>Reviewers</h2>${reviewers}</div>` : ""}

  <div class="section">
    <h2>Description</h2>
    <div class="body">${bodyHtml || `<span class="empty">No description provided.</span>`}</div>
  </div>

  <div class="section">
    <h2>Changed files (${files.length})</h2>
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
      return `✓ All ${status.totalCount} checks passed`;
    case "failure":
    case "error":
      return `✗ Some checks failed`;
    default:
      return `● Checks pending`;
  }
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
