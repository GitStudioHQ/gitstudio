import * as vscode from "vscode";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { UndoLedger } from "../undo/undoLedger";
import { getNonce } from "../webview/html";
import { relativeTime } from "../util/relativeTime";
import {
  runRebasePlan,
  continueRebase,
  abortRebaseAt,
  type RebaseOutcome,
} from "./rebaseRunner";
// Shared design tokens, inlined by esbuild — matches every other GitStudio surface.
import tokensCss from "../../../../packages/webview-ui/src/styles/tokens.css";

interface RebaseCommit {
  sha: string;
  shortSha: string;
  subject: string;
  author: string;
  rel: string;
}

type PlanRow = { sha: string; action: string; subject: string; message?: string };

type FromWebview =
  | { type: "apply"; rows: PlanRow[] }
  | { type: "cancel" }
  | { type: "continue" }
  | { type: "abort" };

/**
 * The GitStudio Interactive Rebase workspace — a full editor-area panel (peer of
 * the commit-graph panel) that lets you compose a `git rebase -i` plan visually:
 * drag to reorder, set each commit's action (pick / reword / squash / fixup /
 * edit / drop), and reword inline. Applying drives the rebase NON-interactively
 * (see rebaseRunner) so it works identically in VS Code, Cursor, and VSCodium.
 */
export class RebaseWorkspacePanel {
  private static current: RebaseWorkspacePanel | undefined;

  static async show(
    repos: RepoManager,
    undo: UndoLedger,
    extensionUri: vscode.Uri,
    sha?: string,
  ): Promise<void> {
    const active = repos.getActive();
    if (!active) {
      void vscode.window.showInformationMessage("GitStudio: no active repository.");
      return;
    }
    // A rebase already running? Send them to resolve it, don't stack a new one.
    if (await isRebaseInProgress(active)) {
      void vscode.window.showWarningMessage(
        "A rebase is already in progress — continue or abort it first.",
      );
      return;
    }
    const base = await resolveBase(active, sha);
    if (!base) {
      return;
    }
    const commits = await loadCommits(active, base);
    if (commits.length === 0) {
      void vscode.window.showInformationMessage(
        "GitStudio: no commits to rebase from that point.",
      );
      return;
    }
    if (commits.length > 200) {
      const go = await vscode.window.showWarningMessage(
        `That's ${commits.length} commits. Interactive rebase over a very long range is slow and error-prone — continue?`,
        { modal: true },
        "Continue",
      );
      if (go !== "Continue") {
        return;
      }
    }

    const [branch, baseCommit] = await Promise.all([
      currentBranch(active),
      loadBaseCommit(active, base),
    ]);

    if (RebaseWorkspacePanel.current) {
      RebaseWorkspacePanel.current.dispose();
    }
    RebaseWorkspacePanel.current = new RebaseWorkspacePanel(
      repos,
      undo,
      extensionUri,
      base,
      commits,
      branch,
      baseCommit,
    );
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;

  private constructor(
    private readonly repos: RepoManager,
    private readonly undo: UndoLedger,
    private readonly extensionUri: vscode.Uri,
    private readonly base: string,
    private readonly commits: RebaseCommit[],
    private readonly branch: string,
    private readonly baseCommit: { shortSha: string; subject: string } | null,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "gitstudio.rebaseWorkspace",
      "Interactive Rebase",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist")],
      },
    );
    this.disposables.push(
      this.panel.webview.onDidReceiveMessage((m: FromWebview) => this.onMessage(m)),
      this.panel.onDidDispose(() => this.dispose()),
    );
    this.panel.webview.html = this.render();
  }

  private async onMessage(m: FromWebview): Promise<void> {
    switch (m.type) {
      case "cancel":
        this.dispose();
        return;
      case "apply":
        await this.apply(m.rows);
        return;
      case "continue":
        await this.finish(() => continueRebase(this.repoRoot()));
        return;
      case "abort": {
        const ok = await abortRebaseAt(this.repoRoot());
        this.post({ type: "aborted", ok });
        if (ok) {
          vscode.window.setStatusBarMessage("$(discard) Rebase aborted", 2500);
          this.dispose();
        }
        return;
      }
    }
  }

  private async apply(rows: PlanRow[]): Promise<void> {
    const active = this.repos.getActive();
    if (!active) {
      return;
    }
    // Guard: the first surviving commit can't be squash/fixup (nothing precedes it).
    const firstKept = rows.find((r) => r.action !== "drop");
    if (firstKept && (firstKept.action === "squash" || firstKept.action === "fixup")) {
      this.post({
        type: "result",
        outcome: { status: "failed", message: `The first commit can't be "${firstKept.action}" — there's nothing above it to fold into.` },
      });
      return;
    }
    if (!rows.some((r) => r.action !== "drop")) {
      this.post({ type: "result", outcome: { status: "failed", message: "Dropping every commit would erase the whole range." } });
      return;
    }

    const todo =
      rows.map((r) => `${r.action} ${r.sha} ${r.subject}`.trimEnd()).join("\n") + "\n";
    const rewordMessages = rows
      .filter((r) => r.action === "reword")
      .map((r) => (r.message ?? "").trim() || r.subject);

    await this.finish(() =>
      this.undo.runWithUndo(active, `Interactive rebase onto ${shortRef(this.base)}`, () =>
        runRebasePlan(active.root, { base: this.base, todo, rewordMessages }),
      ),
    );
  }

  /** Run a rebase step, report the outcome, and refresh/close on success. */
  private async finish(op: () => Promise<RebaseOutcome>): Promise<void> {
    let outcome: RebaseOutcome;
    try {
      outcome = await op();
    } catch (err) {
      outcome = { status: "failed", message: err instanceof Error ? err.message : String(err) };
    }
    if (this.disposed) {
      return;
    }
    this.post({ type: "result", outcome });
    if (outcome.status === "done") {
      const entry = this.repos.getActive();
      void entry?.repo?.status?.();
      void vscode.commands.executeCommand("gitstudio.refreshCommits");
      vscode.window.setStatusBarMessage("$(check) Rebase complete", 3000);
      this.dispose();
    } else if (outcome.status === "stopped") {
      // Refresh status so the app's auto-conflict handler opens the merge editor
      // for any conflicted files; the in-panel banner offers Continue / Abort.
      const entry = this.repos.getActive();
      void entry?.repo?.status?.();
    }
  }

  private repoRoot(): string {
    return this.repos.getActive()?.root ?? "";
  }

  private post(msg: unknown): void {
    void this.panel.webview.postMessage(msg);
  }

  private render(): string {
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
    const data = {
      base: shortRef(this.base),
      branch: this.branch,
      baseCommit: this.baseCommit,
      commits: this.commits,
    };
    const dataJson = JSON.stringify(data).replace(/</g, "\\u003c");
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta http-equiv="Content-Security-Policy" content="${csp}" />
<link href="${codiconUri}" rel="stylesheet" />
<style nonce="${nonce}">${tokensCss}</style>
<style nonce="${nonce}">${REBASE_CSS}</style>
</head>
<body>
  <div class="rb-head">
    <div class="rb-title"><i class="codicon codicon-git-pull-request-draft"></i> Interactive Rebase</div>
    <div class="rb-sub"><i class="codicon codicon-git-branch"></i> <b class="rb-branch">${esc(this.branch)}</b> onto <b>${esc(shortRef(this.base))}</b> · <span id="rb-count"></span></div>
    <span class="rb-spacer"></span>
  </div>
  <div class="rb-explain" id="rb-explain">
    <button class="rb-explain-x" id="rb-explain-x" aria-label="Dismiss">&times;</button>
    <div class="rb-explain-lead"><i class="codicon codicon-info"></i> <b>Tidy up your recent commits before you push.</b> Reorder them by dragging, or pick what happens to each one below. Oldest is at the top; they replay top&nbsp;→&nbsp;bottom. <b>Nothing changes until you press “Start Rebase,”</b> and Undo (⌘⌥G&nbsp;Z) reverses it.</div>
    <div class="rb-gloss">
      <span><b class="g-pick">Pick</b> keep the commit as it is</span>
      <span><b class="g-reword">Reword</b> keep it, but rewrite the message</span>
      <span><b class="g-squash">Squash</b> merge into the commit above — keep both messages</span>
      <span><b class="g-fixup">Fixup</b> merge into the commit above — drop this message</span>
      <span><b class="g-edit">Edit</b> pause here so you can amend the commit</span>
      <span><b class="g-drop">Drop</b> delete the commit</span>
    </div>
  </div>
  <div class="rb-hint"><i class="codicon codicon-move"></i> Drag a commit to reorder it (or focus it and press Alt+↑ / Alt+↓).</div>
  <div class="rb-list" id="rb-list" role="list"></div>
  <div class="rb-banner" id="rb-banner" hidden></div>
  <div class="rb-foot">
    <button class="rb-btn ghost" id="rb-reset"><i class="codicon codicon-history"></i>Reset plan</button>
    <span class="rb-spacer"></span>
    <span class="rb-preview" id="rb-preview"></span>
    <button class="rb-btn secondary" id="rb-cancel">Cancel</button>
    <button class="rb-btn primary" id="rb-apply"><i class="codicon codicon-play glyph"></i><i class="codicon codicon-loading codicon-modifier-spin spin"></i><span id="rb-apply-label">Start Rebase</span></button>
  </div>
<script nonce="${nonce}">
const DATA = ${dataJson};
${REBASE_JS}
</script>
</body></html>`;
  }

  private dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    RebaseWorkspacePanel.current = undefined;
    this.panel.dispose();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

// ── helpers (host) ──────────────────────────────────────────────────────────

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function shortRef(ref: string): string {
  if (ref === "--root") return "the root commit";
  return /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref;
}

async function resolveBase(active: RepoEntry, sha?: string): Promise<string | undefined> {
  if (!sha) {
    const ref = await vscode.window.showInputBox({
      title: "Interactive Rebase",
      prompt: "Rebase onto which commit/branch? (the base, exclusive)",
      placeHolder: "e.g. HEAD~5, main, origin/main",
    });
    return ref?.trim() || undefined;
  }
  const parent = await active.ctx.process.run(["rev-parse", "--verify", "--quiet", `${sha}^`]);
  return parent.code === 0 ? `${sha}^` : "--root";
}

async function loadCommits(active: RepoEntry, base: string): Promise<RebaseCommit[]> {
  const range = base === "--root" ? "HEAD" : `${base}..HEAD`;
  const sep = "\x1f";
  const r = await active.ctx.process.run([
    "log",
    "--reverse", // oldest first — git's todo order
    `--format=%H${sep}%h${sep}%an${sep}%at${sep}%s`,
    range,
  ]);
  if (r.code !== 0) {
    return [];
  }
  const out: RebaseCommit[] = [];
  for (const line of r.stdout.split("\n")) {
    if (!line.trim()) continue;
    const [sha, shortSha, author, at, subject] = line.split(sep);
    out.push({
      sha,
      shortSha,
      author,
      subject: subject ?? "",
      rel: relativeTime(Number(at) || 0),
    });
  }
  return out;
}

async function currentBranch(active: RepoEntry): Promise<string> {
  const r = await active.ctx.process.run(["rev-parse", "--abbrev-ref", "HEAD"]);
  const b = r.stdout.trim();
  return b && b !== "HEAD" ? b : "detached HEAD";
}

/** The commit being rebased ONTO, for the dimmed base row + rail anchor. */
async function loadBaseCommit(
  active: RepoEntry,
  base: string,
): Promise<{ shortSha: string; subject: string } | null> {
  if (base === "--root") {
    return null;
  }
  const r = await active.ctx.process.run(["log", "-1", "--format=%h\x1f%s", base]);
  if (r.code !== 0 || !r.stdout.trim()) {
    return null;
  }
  const [shortSha, subject] = r.stdout.trim().split("\x1f");
  return { shortSha, subject: subject ?? "" };
}

async function isRebaseInProgress(active: RepoEntry): Promise<boolean> {
  const status = await active.ctx.process.run(["status"]);
  return /rebase in progress|interactive rebase in progress/i.test(status.stdout);
}

// ── Webview CSS ─────────────────────────────────────────────────────────────
const REBASE_CSS = `
  * { box-sizing: border-box; }
  body { margin: 0; padding: 0 0 76px; color: var(--gs-fg); font-family: var(--gs-font-ui); font-size: 13px; background: var(--gs-bg); }
  .codicon { font-size: 14px; vertical-align: -0.12em; }

  .rb-head { display: flex; align-items: center; gap: 10px; padding: 14px 18px 10px; position: sticky; top: 0; background: var(--gs-bg); z-index: 5; border-bottom: 1px solid var(--gs-border-soft); flex-wrap: wrap; }
  .rb-head .codicon-git-pull-request-draft { color: var(--gs-brand); font-size: 16px; }
  .rb-title { font-size: 14px; font-weight: 600; }
  .rb-sub { color: var(--gs-fg-muted); font-size: 12px; }
  .rb-sub b { color: var(--gs-accent-text); font-family: var(--gs-font-mono); }
  .rb-spacer { flex: 1 1 auto; }
  .rb-legend { display: inline-flex; gap: 10px; font-size: 11px; color: var(--gs-fg-muted); flex-wrap: wrap; }
  .rb-legend span { display: inline-flex; align-items: center; gap: 4px; }
  .rb-legend i.dot { width: 8px; height: 8px; border-radius: 2px; display: inline-block; }
  .rb-hint { padding: 8px 18px; color: var(--gs-fg-muted); font-size: 11.5px; }
  .rb-hint b { color: var(--gs-fg); }
  .rb-hint .codicon { font-size: 12px; }

  /* Plain-English explainer + action glossary (dismissible). */
  .rb-explain { position: relative; margin: 8px 14px 2px; padding: 12px 34px 12px 14px; border: 1px solid var(--gs-border); border-radius: var(--gs-radius); background: color-mix(in srgb, var(--gs-accent) 7%, var(--gs-surface)); }
  .rb-explain.hidden { display: none; }
  .rb-explain-lead { font-size: 12.5px; line-height: 1.55; }
  .rb-explain-lead .codicon { color: var(--gs-accent); }
  .rb-explain-x { position: absolute; top: 7px; right: 8px; width: 22px; height: 22px; border: none; background: transparent; color: var(--gs-fg-muted); font-size: 16px; line-height: 1; cursor: pointer; border-radius: var(--gs-radius-sm); }
  .rb-explain-x:hover { background: var(--gs-hover-strong); color: var(--gs-fg); }
  .rb-gloss { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 3px 18px; margin-top: 10px; font-size: 11.5px; color: var(--gs-fg-muted); }
  .rb-gloss b { font-weight: 600; margin-right: 6px; }
  .g-pick { color: var(--gs-status-modified); }
  .g-reword { color: var(--gs-accent); }
  .g-squash, .g-fixup { color: var(--gs-brand); }
  .g-edit { color: var(--gs-amber); }
  .g-drop { color: var(--gs-status-deleted); }

  /* Per-commit plain-English consequence of the chosen action. */
  .rb-consequence { margin-top: 5px; font-size: 11.5px; color: var(--gs-fg-muted); display: none; align-items: center; gap: 5px; }
  .rb-consequence .codicon { font-size: 12px; }
  .rb-consequence b { color: var(--gs-fg); font-weight: 500; }
  .rb-row[data-action="squash"] .rb-consequence, .rb-row[data-action="fixup"] .rb-consequence, .rb-row[data-action="edit"] .rb-consequence, .rb-row[data-action="drop"] .rb-consequence { display: flex; }
  .rb-row[data-action="squash"] .rb-consequence, .rb-row[data-action="fixup"] .rb-consequence { color: var(--gs-brand); }
  .rb-row[data-action="drop"] .rb-consequence { color: var(--gs-status-deleted); }
  .rb-row[data-action="edit"] .rb-consequence { color: var(--gs-amber); }

  .rb-list { padding: 4px 14px 8px; }

  .rb-row { display: flex; align-items: stretch; gap: 9px; padding: 8px 10px 8px 0; position: relative; border-radius: var(--gs-radius); transition: background var(--gs-motion-fast) var(--gs-ease), opacity var(--gs-motion-fast) var(--gs-ease); }
  .rb-row:hover { background: var(--gs-hover); }
  .rb-row.dragging { opacity: 0.4; }
  .rb-row.drop-target { box-shadow: 0 -2px 0 var(--gs-accent) inset; }
  .rb-row:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }

  /* Continuous commit rail: a vertical line down the left with a node per row. */
  .rb-rail { flex: 0 0 24px; position: relative; }
  .rb-rail::before { content: ""; position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; transform: translateX(-50%); background: var(--gs-brand); opacity: 0.55; }
  .rb-row:first-child .rb-rail::before { top: 50%; }
  .rb-row.rb-base .rb-rail::before { bottom: 50%; }
  .rb-node { position: absolute; left: 50%; top: 50%; width: 11px; height: 11px; border-radius: 50%; transform: translate(-50%, -50%); background: var(--gs-brand); box-shadow: 0 0 0 3px var(--gs-bg); }
  .rb-row[data-action="squash"] .rb-node, .rb-row[data-action="fixup"] .rb-node { width: 8px; height: 8px; background: var(--gs-bg); border: 2px solid var(--gs-brand); }
  .rb-row.dropped .rb-node { background: var(--gs-bg); border: 2px solid var(--gs-status-deleted); }
  .rb-row.rb-base .rb-node { background: var(--gs-bg); border: 2px solid var(--gs-fg-subtle); }

  .rb-grip { flex: 0 0 auto; align-self: center; cursor: grab; color: var(--gs-fg-subtle); opacity: 0; transition: opacity var(--gs-motion-fast) var(--gs-ease); }
  .rb-row:hover .rb-grip { opacity: 1; }
  .rb-grip:active { cursor: grabbing; }

  /* Action dropdown — GitLens-style select, color-coded by action. */
  .rb-action { flex: 0 0 auto; align-self: center; height: 26px; min-width: 88px; padding: 0 6px; border: 1px solid var(--gs-border); border-radius: var(--gs-radius-sm); background: var(--gs-surface); color: var(--gs-fg); font: inherit; font-size: 11.5px; font-weight: 600; cursor: pointer; text-transform: capitalize; }
  .rb-action:hover { border-color: var(--gs-fg-subtle); }
  .rb-action:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  .rb-action.a-pick { color: var(--gs-status-modified); }
  .rb-action.a-reword { color: var(--gs-accent); }
  .rb-action.a-squash, .rb-action.a-fixup { color: var(--gs-brand); }
  .rb-action.a-edit { color: var(--gs-amber); }
  .rb-action.a-drop { color: var(--gs-status-deleted); }

  .rb-main { flex: 1 1 auto; min-width: 0; align-self: center; }
  .rb-line { display: flex; align-items: center; gap: 9px; }
  .rb-subj { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .rb-avatar { flex: 0 0 auto; width: 18px; height: 18px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font-size: 8.5px; font-weight: 700; color: #fff; background: hsl(var(--h, 250) 42% 52%); }
  .rb-meta { flex: 0 0 auto; font-size: 11.5px; color: var(--gs-fg-muted); }
  .rb-sha { flex: 0 0 auto; font-family: var(--gs-font-mono); font-size: 11px; color: var(--gs-fg-subtle); display: inline-flex; align-items: center; gap: 3px; }
  .rb-sha .codicon { font-size: 11px; }
  .rb-row.dropped { opacity: 0.55; }
  .rb-row.dropped .rb-subj { text-decoration: line-through; }
  .rb-reword { margin-top: 7px; display: none; }
  .rb-row[data-action="reword"] .rb-reword { display: block; }
  .rb-reword textarea { width: 100%; min-height: 40px; resize: vertical; padding: 6px 8px; font-family: var(--gs-font-ui); font-size: 12px; color: var(--vscode-input-foreground); background: var(--vscode-input-background, var(--gs-bg)); border: 1px solid var(--gs-border); border-radius: var(--gs-radius-sm); outline: none; }
  .rb-reword textarea:focus { border-color: var(--gs-accent); }

  /* The dimmed base "onto" row — the target, not editable. */
  .rb-row.rb-base { opacity: 0.72; cursor: default; }
  .rb-row.rb-base:hover { background: transparent; }
  .rb-onto { flex: 0 0 auto; align-self: center; min-width: 88px; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--gs-fg-muted); }

  .rb-banner { margin: 4px 18px; padding: 10px 12px; border-radius: var(--gs-radius); font-size: 12.5px; display: flex; align-items: center; gap: 8px; }
  .rb-banner.warn { background: color-mix(in srgb, var(--gs-amber) 15%, transparent); border: 1px solid color-mix(in srgb, var(--gs-amber) 40%, transparent); color: var(--gs-fg); }
  .rb-banner.err { background: color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 12%, transparent); border: 1px solid color-mix(in srgb, var(--vscode-errorForeground, #e15a5a) 40%, transparent); color: var(--vscode-errorForeground, #e15a5a); }
  .rb-banner .codicon { flex: 0 0 auto; }
  .rb-banner .b-actions { margin-left: auto; display: inline-flex; gap: 6px; }

  .rb-foot { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--gs-border); background: color-mix(in srgb, var(--gs-fg) 3%, var(--gs-bg)); backdrop-filter: blur(6px); }
  .rb-preview { color: var(--gs-fg-muted); font-size: 12px; margin-right: 6px; }
  .rb-preview b { color: var(--gs-fg); font-variant-numeric: tabular-nums; }
  .rb-btn { flex: 0 0 auto; height: 30px; padding: 0 15px; border-radius: var(--gs-radius); border: 1px solid transparent; font-family: var(--gs-font-ui); font-size: 12.5px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: background var(--gs-motion-fast) var(--gs-ease), filter var(--gs-motion-fast) var(--gs-ease), transform var(--gs-motion-fast) var(--gs-ease); }
  .rb-btn:active { transform: translateY(1px); }
  .rb-btn:disabled { opacity: 0.5; cursor: default; }
  .rb-btn.ghost { color: var(--gs-fg-muted); }
  .rb-btn.ghost:hover { color: var(--gs-fg); background: var(--gs-hover); }
  .rb-btn.secondary { color: var(--gs-fg); background: color-mix(in srgb, var(--gs-fg) 7%, transparent); border-color: var(--gs-border); }
  .rb-btn.secondary:hover { background: color-mix(in srgb, var(--gs-fg) 13%, transparent); }
  .rb-btn.primary { color: var(--gs-brand-fg); font-weight: 600; padding: 0 18px; border-color: var(--gs-brand); background: linear-gradient(180deg, color-mix(in srgb, var(--gs-brand) 88%, white 12%), var(--gs-brand)); box-shadow: var(--gs-shadow-1), inset 0 1px 0 color-mix(in srgb, white 22%, transparent); }
  .rb-btn.primary:hover { filter: brightness(1.08); transform: translateY(-1px); }
  .rb-btn .spin { display: none; }
  .rb-btn.busy .glyph { display: none; }
  .rb-btn.busy .spin { display: inline-flex; }
  .rb-btn.busy { opacity: 1; cursor: default; }
  .codicon-modifier-spin { animation: codicon-spin 1s steps(12) infinite; }
  @keyframes codicon-spin { 100% { transform: rotate(360deg); } }
`;

// ── Webview JS ──────────────────────────────────────────────────────────────
const REBASE_JS = String.raw`
const vscode = acquireVsCodeApi();
const $ = (id) => document.getElementById(id);
const ACTIONS = [
  { id: "pick",   label: "Pick",   hint: "keep the commit" },
  { id: "reword", label: "Reword", hint: "keep, change message" },
  { id: "squash", label: "Squash", hint: "fold up, keep both messages" },
  { id: "fixup",  label: "Fixup",  hint: "fold up, discard message" },
  { id: "edit",   label: "Edit",   hint: "stop to amend" },
  { id: "drop",   label: "Drop",   hint: "remove the commit" },
];
function el(t, c, h) { const n = document.createElement(t); if (c) n.className = c; if (h != null) n.innerHTML = h; return n; }
function escText(s) { const d = document.createElement("span"); d.textContent = s == null ? "" : s; return d.innerHTML; }
function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

// The commit a squash/fixup folds INTO: the nearest kept commit above it
// (skipping drops and other fold rows, which chain into the same base).
function foldTargetSubject(i) {
  for (let j = i - 1; j >= 0; j--) {
    const a = rows[j].action;
    if (a === "drop" || a === "squash" || a === "fixup") continue;
    return rows[j].subject;
  }
  return null;
}
function consequenceHtml(action, targetSubj) {
  const into = targetSubj ? ' <b>' + escText(clip(targetSubj, 44)) + '</b>' : ' the commit above';
  switch (action) {
    case "squash": return '<i class="codicon codicon-fold-up"></i> Folds up into' + into + ' — keeps both messages';
    case "fixup":  return '<i class="codicon codicon-fold-up"></i> Folds up into' + into + ' — drops this message';
    case "edit":   return '<i class="codicon codicon-debug-pause"></i> The rebase pauses here so you can amend this commit, then Continue';
    case "drop":   return '<i class="codicon codicon-trash"></i> This commit will be deleted';
    default: return "";
  }
}

// Working model — clones so Reset can restore the original order/actions.
const ORIGINAL = DATA.commits.map((c) => ({ ...c, action: "pick", message: c.subject }));
let rows = ORIGINAL.map((c) => ({ ...c }));
let busy = false;

$("rb-count").textContent = rows.length + (rows.length === 1 ? " commit" : " commits");

function initials(name) { const p = (name || "?").trim().split(/\s+/); return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); }
function hue(name) { let h = 7; for (const c of (name || "")) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function makeRow(r, i) {
  const row = el("div", "rb-row");
  row.dataset.action = r.action;
  row.dataset.sha = r.sha;
  row.setAttribute("role", "listitem");
  row.tabIndex = 0;
  row.draggable = true;
  if (r.action === "drop") row.classList.add("dropped");

  const rail = el("div", "rb-rail"); rail.appendChild(el("span", "rb-node")); row.appendChild(rail);
  row.appendChild(el("span", "rb-grip", '<i class="codicon codicon-gripper"></i>'));

  // Action dropdown (color-coded by the current action).
  const sel = el("select", "rb-action a-" + r.action);
  ACTIONS.forEach((a) => { const o = el("option"); o.value = a.id; o.textContent = a.label; if (a.id === r.action) o.selected = true; sel.appendChild(o); });
  sel.title = (ACTIONS.find((a) => a.id === r.action) || {}).hint || "";
  sel.addEventListener("change", () => setAction(i, sel.value));
  row.appendChild(sel);

  const main = el("div", "rb-main");
  const line = el("div", "rb-line");
  const subj = el("span", "rb-subj", escText(r.subject)); subj.title = r.subject; line.appendChild(subj);
  const av = el("span", "rb-avatar", escText(initials(r.author))); av.style.setProperty("--h", hue(r.author)); av.title = r.author; line.appendChild(av);
  line.appendChild(el("span", "rb-meta", escText(r.rel)));
  line.appendChild(el("span", "rb-sha", '<i class="codicon codicon-git-commit"></i>' + escText(r.shortSha)));
  main.appendChild(line);
  const rw = el("div", "rb-reword");
  const ta = el("textarea"); ta.value = r.message || r.subject; ta.placeholder = "New commit message…";
  ta.addEventListener("input", () => { r.message = ta.value; });
  rw.appendChild(ta); main.appendChild(rw);
  const cons = el("div", "rb-consequence"); cons.innerHTML = consequenceHtml(r.action, foldTargetSubject(i)); main.appendChild(cons);
  row.appendChild(main);

  wireDrag(row, i);
  return row;
}

function makeBaseRow() {
  const row = el("div", "rb-row rb-base");
  const rail = el("div", "rb-rail"); rail.appendChild(el("span", "rb-node")); row.appendChild(rail);
  row.appendChild(el("span", "rb-onto", "onto"));
  const main = el("div", "rb-main");
  const line = el("div", "rb-line");
  const subj = el("span", "rb-subj", escText(DATA.baseCommit.subject)); subj.title = DATA.baseCommit.subject; line.appendChild(subj);
  line.appendChild(el("span", "rb-sha", '<i class="codicon codicon-git-commit"></i>' + escText(DATA.baseCommit.shortSha)));
  main.appendChild(line);
  row.appendChild(main);
  return row;
}

function renderList() {
  const list = $("rb-list");
  list.textContent = "";
  rows.forEach((r, i) => list.appendChild(makeRow(r, i)));
  if (DATA.baseCommit) list.appendChild(makeBaseRow());
  updatePreview();
}

function setAction(i, action) {
  // Guard: the first surviving row can't fold upward.
  if (action === "squash" || action === "fixup") {
    const firstKept = rows.findIndex((r) => r.action !== "drop");
    if (i === firstKept) { flashBanner("The top commit has nothing above it to fold into.", "warn"); renderList(); return; }
  }
  rows[i].action = action;
  renderList();
}

// ---- Drag to reorder ----
let dragFrom = -1;
function wireDrag(row, i) {
  row.addEventListener("dragstart", (e) => { dragFrom = i; row.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; });
  row.addEventListener("dragend", () => { dragFrom = -1; row.classList.remove("dragging"); document.querySelectorAll(".rb-row.drop-target").forEach((r) => r.classList.remove("drop-target")); });
  row.addEventListener("dragover", (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; row.classList.add("drop-target"); });
  row.addEventListener("dragleave", () => row.classList.remove("drop-target"));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    row.classList.remove("drop-target");
    if (dragFrom === -1 || dragFrom === i) return;
    const [moved] = rows.splice(dragFrom, 1);
    rows.splice(i, 0, moved);
    renderList();
  });
}

// ---- Keyboard: Alt+Up/Down to move the focused row ----
document.addEventListener("keydown", (e) => {
  if (!e.altKey || (e.key !== "ArrowUp" && e.key !== "ArrowDown")) return;
  const focused = document.activeElement && document.activeElement.closest(".rb-row");
  if (!focused) return;
  const i = [...document.querySelectorAll(".rb-list .rb-row")].indexOf(focused);
  const j = e.key === "ArrowUp" ? i - 1 : i + 1;
  if (i < 0 || j < 0 || j >= rows.length) return;
  e.preventDefault();
  const [m] = rows.splice(i, 1); rows.splice(j, 0, m); renderList();
});

function updatePreview() {
  const kept = rows.filter((r) => r.action === "pick" || r.action === "reword" || r.action === "edit").length;
  $("rb-preview").innerHTML = "<b>" + rows.length + "</b> → <b>" + kept + "</b> commit" + (kept === 1 ? "" : "s");
}

let bannerTimer = null;
function flashBanner(text, kind) {
  const b = $("rb-banner");
  b.className = "rb-banner " + (kind || "warn");
  b.innerHTML = '<i class="codicon codicon-' + (kind === "err" ? "error" : "warning") + '"></i>';
  b.appendChild(document.createTextNode(text));
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (kind !== "err") bannerTimer = setTimeout(() => { b.hidden = true; }, 4000);
}
function showStopBanner(text) {
  const b = $("rb-banner");
  b.className = "rb-banner warn";
  b.innerHTML = '<i class="codicon codicon-debug-pause"></i>';
  b.appendChild(document.createTextNode(text));
  const acts = el("span", "b-actions");
  const cont = el("button", "rb-btn primary", "Continue"); cont.addEventListener("click", () => { setBusy(true); vscode.postMessage({ type: "continue" }); });
  const abort = el("button", "rb-btn secondary", "Abort"); abort.addEventListener("click", () => vscode.postMessage({ type: "abort" }));
  acts.appendChild(cont); acts.appendChild(abort); b.appendChild(acts);
  b.hidden = false;
}

function setBusy(on, label) {
  busy = on;
  const apply = $("rb-apply");
  apply.classList.toggle("busy", on);
  apply.disabled = on;
  $("rb-cancel").disabled = on;
  if (label) $("rb-apply-label").textContent = label;
}

$("rb-apply").addEventListener("click", () => {
  if (busy) return;
  $("rb-banner").hidden = true;
  setBusy(true, "Rebasing…");
  vscode.postMessage({ type: "apply", rows: rows.map((r) => ({ sha: r.sha, action: r.action, subject: r.subject, message: r.action === "reword" ? (r.message || r.subject) : undefined })) });
});
$("rb-cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
$("rb-reset").addEventListener("click", () => { rows = ORIGINAL.map((c) => ({ ...c })); $("rb-banner").hidden = true; renderList(); });
$("rb-explain-x").addEventListener("click", () => $("rb-explain").classList.add("hidden"));

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "result") {
    const o = msg.outcome;
    if (o.status === "done") { setBusy(true, "Done"); return; }
    setBusy(false, "Start Rebase");
    if (o.status === "stopped") showStopBanner((o.reason === "conflict" ? "Rebase paused on a conflict — resolve the files, then Continue. " : o.reason === "edit" ? "Rebase paused to edit a commit — amend in your working tree, then Continue. " : "Rebase paused. ") + (o.message || ""));
    else flashBanner(o.message || "Rebase failed.", "err");
  } else if (msg.type === "aborted") {
    if (!msg.ok) flashBanner("Couldn't abort the rebase.", "err");
  }
});

renderList();
`;
