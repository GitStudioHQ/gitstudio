import * as vscode from "vscode";
import { promptConfirm } from "../ui/dialogs";
import { buildRebasePlan } from "@gitstudio/git-service/rebasePlan";
import { promptRevision } from "../ui/refPrompt";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import type { UndoLedger } from "../undo/undoLedger";
import { getNonce } from "../webview/html";
import { operationInProgressMessage } from "../git/pausedForUser";
import { detectOperation } from "../git/pauseNotice";
import { abortRebaseLike, nothingToAbortText } from "./rebaseAbort";
import { describeRebaseBase } from "./rebaseBase";
import type { OperationOutcome } from "@gitstudio/host-bridge/conflictsProtocol";
import { relativeTime } from "../util/relativeTime";
import {
  runRebasePlan,
  continueRebase,
  reportRebaseFailure,
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

/** What the stop banner can offer at the stop git is at (from OperationProvider). */
interface StopInfo {
  /** git names Skip as a way out here (e.g. an emptied commit on the apply backend). */
  canSkip: boolean;
  skipLabel?: string;
  /** Unmerged files at this stop — the banner offers the Conflicts dashboard. */
  conflicts: number;
}

type FromWebview =
  | { type: "apply"; rows: PlanRow[] }
  | { type: "cancel" }
  | { type: "continue" }
  | { type: "skip" }
  | { type: "resolveConflicts" }
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
    // Anything already stopped (a rebase, a merge, a cherry-pick…)? Send them
    // to finish it, don't stack a new one. Asked of the files git writes, not
    // of `git status` prose, which a non-English git words differently.
    const blocked = operationInProgressMessage(await detectOperation(active.ctx));
    if (blocked) {
      void vscode.window.showWarningMessage(blocked);
      return;
    }
    const base = await resolveBase(active, sha);
    if (!base) {
      return;
    }
    const commits = await loadCommits(active, base);
    if (commits.length === 0) {
      // Empty for three different reasons, and "no commits from that point" is
      // only true for one of them. The selection deliberately omits merges and
      // commits already applied upstream, so a branch that is entirely merged,
      // or a range made only of merges, empties the plan while plainly having
      // commits in it — and the old sentence sent people looking for a nearer
      // base, which finds fewer, not more.
      const total = await countInRange(active, base);
      void vscode.window.showInformationMessage(
        total > 0
          ? `GitStudio: nothing to rebase — all ${total} commit${total === 1 ? "" : "s"} here are either merges or changes already on the base, which a rebase would skip.`
          : "GitStudio: no commits to rebase from that point.",
      );
      return;
    }
    if (commits.length > 200) {
      const go = await promptConfirm({
        title: `Rebase ${commits.length} commits?`,
        message:
          "Interactive rebase over a range this long is slow, and a conflict in the middle leaves you resolving one commit at a time. A nearer base is usually what you want.",
        confirmLabel: "Continue",
        danger: true,
      });
      if (!go) {
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
      case "skip":
        await this.skip();
        return;
      case "resolveConflicts":
        await vscode.commands.executeCommand("gitstudio.showConflicts");
        return;
      case "abort": {
        // Through the shared operation core (rebaseAbort.ts): `am --abort`
        // for a git am stopped in the same rebase-apply/ directory, never a
        // `rebase --abort` git refuses there.
        const active = this.repos.getActive();
        const result = active ? await abortRebaseLike(active.ctx.operation) : undefined;
        const ok = !!result?.ran && result.outcome.ok;
        this.post({ type: "aborted", ok });
        if (ok) {
          vscode.window.setStatusBarMessage(`$(discard) ${result?.kind === "am" ? "Patch series abandoned" : "Rebase aborted"}`, 2500);
          this.dispose();
        } else if (result && !result.ran) {
          void vscode.window.showInformationMessage(nothingToAbortText(result.kind));
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
    // The list is newest-first on screen; git's todo is oldest-first. That single
    // reversal, the guards, and the reword queue all live in buildRebasePlan,
    // shared with the desktop app precisely because every way to get this wrong
    // is silent — the rebase would report success with the history rearranged.
    const built = buildRebasePlan(rows);
    if (!built.ok) {
      // Dropping every commit is a plan the user composed (`expected`); rows
      // with an action or a sha no UI offers are a request built wrong.
      const refused: RebaseOutcome = {
        status: "failed",
        message: built.message,
        ...(built.expected ? { expected: true as const } : {}),
      };
      reportRebaseFailure("Interactive rebase plan refused", refused);
      this.post({ type: "result", outcome: refused });
      return;
    }
    const { todo, rewords } = built;

    await this.finish(() =>
      this.undo.runWithUndo(active, `Interactive rebase onto ${describeRebaseBase(this.base)}`, () =>
        runRebasePlan(active.root, { base: this.base, todo, rewords }),
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
    const stop = outcome.status === "stopped" ? await this.stopInfo() : undefined;
    this.post({ type: "result", outcome, stop });
    if (outcome.status === "done") {
      const entry = this.repos.getActive();
      void entry?.repo?.status?.();
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

  /**
   * What the stop banner may offer where the rebase stopped: Skip only where
   * it is named as the way out (OperationProvider decides — never a skip over
   * a deliberate pause), and the Conflicts dashboard while files are unmerged.
   */
  private async stopInfo(): Promise<StopInfo> {
    const ctx = this.repos.getActive()?.ctx;
    if (!ctx) {
      return { canSkip: false, conflicts: 0 };
    }
    try {
      const [view, detected] = await Promise.all([ctx.operation.view(), detectOperation(ctx)]);
      return { canSkip: view.canSkip, skipLabel: view.verbs.skip, conflicts: detected.unmerged };
    } catch {
      return { canSkip: false, conflicts: 0 };
    }
  }

  /** Skip through the shared operation verb — its confirm, its words, one implementation. */
  private async skip(): Promise<void> {
    await this.finish(async () =>
      toRebaseOutcome(
        (await vscode.commands.executeCommand("gitstudio.operation.skip", {
          root: this.repoRoot(),
          // This panel's stop banner reports the outcome; the command would
          // toast it too, and one Skip was said twice.
          quiet: true,
        })) as OperationOutcome | undefined,
      ),
    );
  }

  private post(msg: unknown): void {
    // `panel.webview` is a getter that THROWS once disposed, so the `void` here
    // protects nothing — the throw beats the promise. Every post() sits after an
    // await on a git operation, and closing the panel mid-rebase is normal.
    if (this.disposed) {
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  private render(): string {
    const nonce = getNonce();
    const codiconUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "codicons", "codicon.css"),
    );
    // The shared plan rules (engine/rebase/planEdit, #32): selection, the
    // squash guard, block moves. Bundled, because this page's own script is a
    // string no bundler sees.
    const planUri = this.panel.webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri, "dist", "webview", "rebase-plan.js"),
    );
    const csp = [
      `default-src 'none'`,
      `style-src 'nonce-${nonce}' ${this.panel.webview.cspSource}`,
      `font-src ${this.panel.webview.cspSource}`,
      `script-src 'nonce-${nonce}' ${this.panel.webview.cspSource}`,
    ].join("; ");
    const data = {
      base: describeRebaseBase(this.base),
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
    <div class="rb-sub"><i class="codicon codicon-git-branch"></i> <b class="rb-branch">${esc(this.branch)}</b> onto <b>${esc(describeRebaseBase(this.base))}</b> · <span id="rb-count"></span></div>
    <span class="rb-spacer"></span>
    <div class="rb-tools" role="group" aria-label="Set the action of the selected commits">
      <span class="rb-selcount" id="rb-selcount" aria-live="polite"></span>
      <span class="rb-tools-label">Set action</span>
      <div class="rb-setgroup" id="rb-setgroup"></div>
    </div>
  </div>
  <div class="rb-explain" id="rb-explain">
    <button class="rb-explain-x" id="rb-explain-x" aria-label="Dismiss">&times;</button>
    <div class="rb-explain-lead"><i class="codicon codicon-info"></i> <b>Tidy up your recent commits before you push.</b> Reorder them by dragging, or pick what happens to each one below. Newest is at the top, as in Commits; git replays them bottom&nbsp;→&nbsp;top. <b>Nothing changes until you press “Start Rebase,”</b> and Undo (⌘⌥G&nbsp;Z) reverses it.</div>
    <div class="rb-gloss">
      <span><b class="g-pick">Pick</b> keep the commit as it is</span>
      <span><b class="g-reword">Reword</b> keep it, but rewrite the message</span>
      <span><b class="g-squash">Squash</b> merge into the commit below it — keep both messages</span>
      <span><b class="g-fixup">Fixup</b> merge into the commit below it — drop this message</span>
      <span><b class="g-edit">Edit</b> pause here so you can amend the commit</span>
      <span><b class="g-drop">Drop</b> delete the commit</span>
    </div>
  </div>
  <div class="rb-hint"><i class="codicon codicon-keyboard"></i><span class="rb-hint-keys" id="rb-hint-keys"></span></div>
  <div class="rb-list" id="rb-list" role="grid" aria-multiselectable="true" aria-label="Commits to rebase, newest first"></div>
  <div class="rb-foot" id="rb-foot">
    <div class="rb-banner" id="rb-banner" hidden></div>
    <button class="rb-btn ghost" id="rb-reset"><i class="codicon codicon-history"></i>Reset plan</button>
    <span class="rb-spacer"></span>
    <span class="rb-preview" id="rb-preview"></span>
    <button class="rb-btn secondary" id="rb-cancel">Cancel</button>
    <button class="rb-btn primary" id="rb-apply"><i class="codicon codicon-play glyph"></i><i class="codicon codicon-loading codicon-modifier-spin spin"></i><span id="rb-apply-label">Start Rebase</span></button>
  </div>
<script nonce="${nonce}" src="${planUri}"></script>
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

async function resolveBase(active: RepoEntry, sha?: string): Promise<string | undefined> {
  if (!sha) {
    return promptRevision(active, {
      title: "Interactive Rebase",
      hint: "Rebase onto which commit or branch? The base itself is excluded — everything after it lands in the workspace.",
      placeholder: "HEAD~5   main   origin/main",
      confirmLabel: "Open Workspace",
    });
  }
  const parent = await active.ctx.process.run(["rev-parse", "--verify", "--quiet", `${sha}^`]);
  return parent.code === 0 ? `${sha}^` : "--root";
}

async function loadCommits(active: RepoEntry, base: string): Promise<RebaseCommit[]> {
  // The same selection git's own sequencer uses. The desktop learned each of
  // these the hard way, and this panel was still building the plans they exist
  // to prevent — the todo IS the plan, so anything wrong here is executed.
  //
  //  · THREE dots + `--cherry-pick --right-only`: drops commits whose patch is
  //    already on the base (a backport, a cherry-pick that went both ways, a
  //    commit merged upstream by someone else). `base..HEAD` keeps them, git's
  //    todo does not, and running the plan made git skip one and PAUSE —
  //    "warning: skipped previously applied commit" — leaving the repo
  //    mid-rebase with a clean tree and nothing to resolve.
  //  · `--no-merges`: a rebase FLATTENS merges, and `git rebase -i` refuses
  //    `pick <merge>` outright. git checks out the base BEFORE parsing the
  //    todo, so the repo was left detached at the base, mid-rebase, with no
  //    conflict to resolve and only Abort as a way out. A feature branch with
  //    main merged into it is the ordinary shape of this.
  //  · `--topo-order`: reversed, this reproduces git's own todo; the default
  //    date ordering does not, so the plan promised one replay order and git
  //    performed another.
  const threeDot = base !== "--root";
  const range = threeDot ? `${base}...HEAD` : "HEAD";
  const sep = "\x1f";
  const r = await active.ctx.process.run([
    "log",
    ...(threeDot ? ["--cherry-pick", "--right-only"] : []),
    "--no-merges",
    "--topo-order",
    // NEWEST FIRST, matching the Commits list (issue #18). git's todo file is the
    // other way round; buildRebasePlan does that reversal in exactly one place.
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

/** Every commit in the range, merges and already-applied ones included — the
 *  number the user can see in the Commits list, so an empty plan can say what
 *  happened to them. */
async function countInRange(active: RepoEntry, base: string): Promise<number> {
  const range = base === "--root" ? "HEAD" : `${base}..HEAD`;
  const r = await active.ctx.process.run(["rev-list", "--count", range]);
  return r.code === 0 ? Number(r.stdout.trim()) || 0 : 0;
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


/** A Skip's OperationOutcome in the panel's terms. Undefined = nothing ran (cancelled). */
export function toRebaseOutcome(o: OperationOutcome | undefined): RebaseOutcome {
  if (!o) {
    return { status: "stopped", reason: "unknown", message: "" };
  }
  if (o.ok) {
    return { status: "done" };
  }
  if (o.stopped) {
    return { status: "stopped", reason: o.view.pause ? "edit" : "conflict", message: o.message ?? "" };
  }
  return { status: "failed", message: o.message || o.view.continueBlocked || "Git refused to skip." };
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
  .rb-hint { padding: 8px 18px; color: var(--gs-fg-muted); font-size: 11.5px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
  .rb-hint b { color: var(--gs-fg); }
  .rb-hint .codicon { font-size: 12px; }
  .rb-hint-keys { display: inline-flex; align-items: center; gap: 4px; flex-wrap: wrap; }
  /* VS Code's own key-label look, as its keybinding hints draw it. */
  .rb-kbd { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; min-width: 16px; height: 16px; padding: 0 4px; font: 600 10px/1 var(--gs-font-mono); border-radius: 3px; color: var(--vscode-keybindingLabel-foreground, var(--gs-fg)); background: var(--vscode-keybindingLabel-background, color-mix(in srgb, var(--gs-fg-muted) 12%, transparent)); border: 1px solid var(--vscode-keybindingLabel-border, var(--gs-border)); border-bottom-color: var(--vscode-keybindingLabel-bottomBorder, var(--gs-border)); }

  /* The selection's toolbar (#32): the header's second line, so it stays on
     screen however far a long plan scrolls. */
  :root { --rb-sel: var(--vscode-list-inactiveSelectionBackground, color-mix(in srgb, var(--gs-accent) 16%, transparent)); }
  .rb-tools { flex: 1 0 100%; display: flex; align-items: center; gap: 10px; flex-wrap: wrap; margin: 0 -18px -10px; padding: 8px 18px; border-top: 1px solid var(--gs-border-soft); }
  .rb-selcount { min-width: 78px; font-size: 12px; font-weight: 600; font-variant-numeric: tabular-nums; }
  .rb-tools-label { font-size: 11.5px; color: var(--gs-fg-muted); }
  .rb-setgroup { display: inline-flex; align-items: stretch; border: 1px solid var(--gs-border); border-radius: var(--gs-radius); overflow: hidden; background: var(--gs-surface); }
  .rb-set { border: none; background: transparent; cursor: pointer; padding: 3px 10px; font: inherit; font-size: 11.5px; font-weight: 600; line-height: 18px; color: var(--gs-fg); }
  .rb-set + .rb-set { border-left: 1px solid var(--gs-border); }
  .rb-set:hover:not(:disabled) { background: var(--gs-hover-strong, var(--gs-hover)); }
  .rb-set:disabled { opacity: 0.5; cursor: default; }
  .rb-set:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  .rb-set.a-pick { color: var(--gs-status-modified); }
  .rb-set.a-reword { color: var(--gs-accent); }
  .rb-set.a-squash, .rb-set.a-fixup { color: var(--gs-brand); }
  .rb-set.a-edit { color: var(--gs-amber); }
  .rb-set.a-drop { color: var(--gs-status-deleted); }
  /* Every selected commit is already set to this one. */
  .rb-set.is-current { background: var(--rb-sel); box-shadow: inset 0 -2px 0 currentColor; }

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
  /* The drop line on the half of the row the pointer is in; the drop lands there. */
  .rb-row.drop-before { box-shadow: inset 0 2px 0 var(--gs-accent); }
  .rb-row.drop-after { box-shadow: inset 0 -2px 0 var(--gs-accent); }
  .rb-row:focus-visible { outline: 1px solid var(--gs-accent); outline-offset: -1px; }
  /* Selected (#32). VS Code's own selection colour for a list that is not the
     focused widget: neutral, so the coloured action pickers stay legible. It
     comes after the hover rule on purpose, and a selected row keeps it under
     the pointer, as VS Code's lists do. */
  .rb-row.is-selected, .rb-row.is-selected:hover { background: var(--rb-sel); }
  .rb-row.is-selected .rb-node { box-shadow: 0 0 0 3px var(--rb-sel); }
  /* High contrast has no selection fill; a selection is drawn as an outline. */
  body.vscode-high-contrast .rb-row.is-selected { outline: 1px dashed var(--vscode-contrastActiveBorder, var(--gs-accent)); outline-offset: -1px; }
  body.vscode-high-contrast .rb-row.is-selected:focus-visible { outline-style: solid; }
  /* While the selection is painted: no easing (see paintSelection). */
  .rb-list.is-painting .rb-row { transition: none; }

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
  /* display: flex above outranks the hidden attribute's own display: none. */
  .rb-banner[hidden] { display: none; }

  /* The banner is the footer's first line, so it is on screen however long
     the plan is — under the list it was below the fold of any plan long
     enough to want a selection (#32). */
  .rb-foot { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; padding: 12px 18px; border-top: 1px solid var(--gs-border); background: color-mix(in srgb, var(--gs-fg) 3%, var(--gs-bg)); backdrop-filter: blur(6px); }
  .rb-foot > .rb-banner { flex: 1 0 100%; margin: 0 0 4px; }
  .rb-preview { color: var(--gs-fg-muted); font-size: 12px; margin-right: 6px; }
  .rb-preview b { color: var(--gs-fg); font-variant-numeric: tabular-nums; }
  .rb-btn { flex: 0 0 auto; height: 30px; padding: 0 15px; border-radius: var(--gs-radius); border: 1px solid transparent; font-family: var(--gs-font-ui); font-size: 12.5px; font-weight: 500; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; transition: background var(--gs-motion-fast) var(--gs-ease), filter var(--gs-motion-fast) var(--gs-ease), transform var(--gs-motion-fast) var(--gs-ease); }
  .rb-btn:active { transform: translateY(1px); }
  .rb-btn:disabled { opacity: 0.5; cursor: default; }
  /* Transparent in so many words: .rb-btn sets no background, so the browser's
     own grey button face showed through "Reset plan". */
  .rb-btn.ghost { color: var(--gs-fg-muted); background: transparent; }
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

// The commit a squash/fixup folds INTO: git melds into the entry BEFORE it in the
// todo, and the list is newest-first, so on screen that is the nearest kept
// commit BELOW (skipping drops and other fold rows, which chain into the same
// base). Scanning upward was right only while the list ran oldest-first.
function foldTargetSubject(i) {
  for (let j = i + 1; j < rows.length; j++) {
    const a = rows[j].action;
    if (a === "drop" || a === "squash" || a === "fixup") continue;
    return rows[j].subject;
  }
  return null;
}
function consequenceHtml(action, targetSubj) {
  // A fold whose target has DISAPPEARED (its commit dropped after the fold was
  // chosen) is a plan git cannot run — say so on the row, loudly, instead of
  // pretending "the commit below it" still exists. The desktop's sibling
  // re-validates the same way; this panel used to validate only the action
  // being SET, so a later drop orphaned the fold silently.
  if ((action === "squash" || action === "fixup") && targetSubj === null) {
    return '<i class="codicon codicon-warning"></i> Nothing below it to fold into — pick a different action or move it up';
  }
  const into = targetSubj ? ' <b>' + escText(clip(targetSubj, 44)) + '</b>' : ' the commit below it';
  switch (action) {
    case "squash": return '<i class="codicon codicon-fold-down"></i> Folds down into' + into + ' — keeps both messages';
    case "fixup":  return '<i class="codicon codicon-fold-down"></i> Folds down into' + into + ' — drops this message';
    case "edit":   return '<i class="codicon codicon-debug-pause"></i> The rebase pauses here so you can amend this commit, then Continue';
    case "drop":   return '<i class="codicon codicon-trash"></i> This commit will be deleted';
    default: return "";
  }
}

// Working model — clones so Reset can restore the original order/actions.
const ORIGINAL = DATA.commits.map((c) => ({ ...c, action: "pick", message: c.subject }));
let rows = ORIGINAL.map((c) => ({ ...c }));
let busy = false;

// The selection (#32: "select multiple and set the action at once"). Its
// rules are the shared engine's (engine/rebase/planEdit, loaded as
// GsRebasePlan), the same ones the desktop's Rebase view and the
// git-rebase-todo editor run. Rows are named by sha, so the selection moves
// with them; the newest commit starts selected so the keys work at once.
const P = window.GsRebasePlan;
const isMac = /mac/i.test(navigator.platform);
let selection = rows.length ? P.selectOnly(rows[0].sha) : P.NO_SELECTION;
// The rows a drag picked up, by sha: the selection, or just the row.
let dragging = [];

$("rb-count").textContent = rows.length + (rows.length === 1 ? " commit" : " commits");

// The toolbar's six actions, in words, each naming its key in its tooltip.
const setBtns = {};
P.PLAN_ACTIONS.forEach((a) => {
  const b = el("button", "rb-set a-" + a.id);
  b.type = "button";
  b.textContent = a.label;
  b.dataset.action = a.id;
  b.title = P.actionTooltip(a.id);
  b.setAttribute("aria-keyshortcuts", a.key);
  b.addEventListener("click", () => bulkSet(a.id, null));
  setBtns[a.id] = b;
  $("rb-setgroup").appendChild(b);
});
// …and said once where they can be found without hovering.
(function hintKeys() {
  const h = $("rb-hint-keys");
  h.appendChild(el("span", "", escText("Shift- or " + (isMac ? "⌘" : "Ctrl") + "-click selects several;")));
  P.PLAN_ACTIONS.forEach((a) => { const k = el("kbd", "rb-kbd"); k.textContent = a.key; k.title = a.label; h.appendChild(k); });
  h.appendChild(el("span", "", escText("set their action; drag or Alt+↑ / Alt+↓ moves them.")));
})();

function initials(name) { const p = (name || "?").trim().split(/\s+/); return ((p[0] || "?")[0] + (p[1] ? p[1][0] : "")).toUpperCase(); }
function hue(name) { let h = 7; for (const c of (name || "")) h = (h * 31 + c.charCodeAt(0)) % 360; return h; }

function makeRow(r, i) {
  const row = el("div", "rb-row");
  row.dataset.action = r.action;
  row.dataset.sha = r.sha;
  row.setAttribute("role", "row");
  row.setAttribute("aria-label", ((ACTIONS.find((a) => a.id === r.action) || {}).label || r.action) + " " + r.shortSha + " " + r.subject);
  row.tabIndex = -1;
  row.draggable = true;
  if (r.action === "drop") row.classList.add("dropped");

  const rail = el("div", "rb-rail"); rail.setAttribute("aria-hidden", "true"); rail.appendChild(el("span", "rb-node")); row.appendChild(rail);
  const grip = el("span", "rb-grip", '<i class="codicon codicon-gripper"></i>');
  grip.setAttribute("aria-hidden", "true");
  grip.title = "Drag to reorder — the selected commits move together (or press Alt+↑ / Alt+↓)";
  row.appendChild(grip);

  // Action dropdown (color-coded by the current action).
  const sel = el("select", "rb-action a-" + r.action);
  ACTIONS.forEach((a) => { const o = el("option"); o.value = a.id; o.textContent = a.label; if (a.id === r.action) o.selected = true; sel.appendChild(o); });
  sel.title = (ACTIONS.find((a) => a.id === r.action) || {}).hint || "";
  sel.addEventListener("change", () => setAction(i, sel.value));
  row.appendChild(sel);

  const main = el("div", "rb-main");
  main.setAttribute("role", "gridcell");
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

  wireDrag(row);
  return row;
}

function makeBaseRow() {
  const row = el("div", "rb-row rb-base");
  row.setAttribute("role", "row");
  row.setAttribute("aria-label", "Onto " + DATA.baseCommit.shortSha + " " + DATA.baseCommit.subject);
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

const order = () => rows.map((r) => r.sha);
const indexOfSha = (sha) => rows.findIndex((r) => r.sha === sha);
const rowEls = () => Array.prototype.slice.call(document.querySelectorAll(".rb-list .rb-row:not(.rb-base)"));
const rowEl = (sha) => (sha ? rowEls().find((r) => r.dataset.sha === sha) : undefined);

// Rebuild the list. refocus puts the keyboard back where it was working:
// "row" on the row it is on, "select" on a row's dropdown (sha's, else the
// focused row's). Without one the keyboard only follows when it was in the
// list already, so a toolbar button keeps it.
function renderList(refocus, sha) {
  const list = $("rb-list");
  const hadFocus = list.contains(document.activeElement);
  list.textContent = "";
  rows.forEach((r, i) => list.appendChild(makeRow(r, i)));
  if (DATA.baseCommit) list.appendChild(makeBaseRow());
  selection = P.pruneSelection(selection, order());
  paintSelection();
  updatePreview();
  const target = rowEl(sha || selection.focus);
  if (refocus === "select") { const s = target && target.querySelector(".rb-action"); if (s) s.focus(); }
  else if ((refocus === "row" || hadFocus) && target) target.focus();
}

// Selected and focused on every row, and the toolbar's count and state.
function paintSelection() {
  const list = $("rb-list");
  const on = new Set(selection.selected);
  const tabStop = selection.focus && indexOfSha(selection.focus) >= 0 ? selection.focus : (rows[0] && rows[0].sha);
  // A selection lands at once, as in every list; only the hover eases. (A
  // hidden panel's paused compositor would otherwise leave it half-painted.)
  list.classList.add("is-painting");
  rowEls().forEach((r) => {
    const k = r.dataset.sha;
    r.classList.toggle("is-selected", on.has(k));
    r.setAttribute("aria-selected", String(on.has(k)));
    r.tabIndex = k === tabStop ? 0 : -1;
  });
  void list.offsetHeight;
  list.classList.remove("is-painting");
  const n = selection.selected.length;
  $("rb-selcount").textContent = P.selectionCountText(n);
  // The action every selected row shares, if they share one, reads as current.
  const acts = new Set(rows.filter((r) => on.has(r.sha)).map((r) => r.action));
  Object.keys(setBtns).forEach((id) => {
    setBtns[id].disabled = n === 0 || busy;
    setBtns[id].classList.toggle("is-current", n > 0 && acts.size === 1 && acts.has(id));
  });
}

// Point the selection somewhere and paint it; the keyboard follows it.
function select(next, focusRow) {
  selection = next;
  paintSelection();
  if (focusRow !== false) { const r = rowEl(selection.focus); if (r) r.focus(); }
}

// Set action on the rows at idx: one row from its dropdown, or the selection
// from the toolbar and the keys. One rule either way (the shared setActions):
// a squash or fixup is refused, row by row, where nothing below it is kept
// to fold into, which git refuses outright. Across a selection every row
// folds into the kept commit below it (for a block, the one under the block);
// only when none is kept below does the oldest selected row stay as it was,
// for the rest to fold into.
//
// The dropdown once refused on the TOP row (HEAD), the most ordinary squash
// there is, while accepting one on the oldest, which git cannot run (issue
// #27); the rule is asked in one place now, the right way round.
// (No backticks in these comments: this whole script lives inside a template
// literal, and one stray backtick ends it.)
function applyActions(idx, action, refocus, sha) {
  const before = rows.map((r) => r.action);
  const res = P.setActions(before, idx, action, "newest-first");
  rows.forEach((r, i) => { r.action = res.actions[i]; });
  const said = P.refusalText(action, res, "newest-first", res.refused.length === 1 ? before[res.refused[0]] : undefined);
  if (said) flashBanner(said, "warn");
  renderList(refocus, sha);
}

function setAction(i, action) {
  applyActions([i], action, "select", rows[i] && rows[i].sha);
}

// The toolbar and the keys: every selected row.
function bulkSet(action, refocus) {
  if (busy) return;
  const idx = P.selectedInOrder(selection, order()).map(indexOfSha).filter((i) => i >= 0);
  if (!idx.length) return;
  applyActions(idx, action, refocus);
}

// Put the rows in this sha order, if it is a different one.
function reorder(keys, refocus) {
  if (keys.join("\n") === order().join("\n")) return;
  const bySha = new Map(rows.map((r) => [r.sha, r]));
  rows = keys.map((k) => bySha.get(k)).filter(Boolean);
  renderList(refocus);
}

// ---- Drag to reorder ----
// Picking up a SELECTED row carries the whole selection, in list order;
// picking up any other row selects it and carries it alone. The line is drawn
// on the half of the row the pointer is in, and the drop lands exactly there
// (a line under the row while the insert went above it put every upward drag
// one row off; the desktop learned that first).
function wireDrag(row) {
  const sha = row.dataset.sha;
  const half = (e) => { const r = row.getBoundingClientRect(); return e.clientY < r.top + r.height / 2 ? "before" : "after"; };
  const paintLine = (side) => { row.classList.toggle("drop-before", side === "before"); row.classList.toggle("drop-after", side === "after"); };
  row.addEventListener("dragstart", (e) => {
    if (selection.selected.indexOf(sha) < 0) select(P.selectOnly(sha), false);
    dragging = P.dragKeys(selection, order(), sha);
    if (e.dataTransfer) { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", sha); }
    rowEls().forEach((r) => r.classList.toggle("dragging", dragging.indexOf(r.dataset.sha) >= 0));
  });
  row.addEventListener("dragend", () => {
    dragging = [];
    rowEls().forEach((r) => r.classList.remove("dragging", "drop-before", "drop-after"));
  });
  row.addEventListener("dragover", (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = "move"; paintLine(half(e)); });
  row.addEventListener("dragleave", () => paintLine(null));
  row.addEventListener("drop", (e) => {
    e.preventDefault();
    const side = half(e);
    paintLine(null);
    const moving = dragging;
    dragging = [];
    const i = indexOfSha(sha);
    if (!moving.length || i < 0) return;
    reorder(P.moveKeysToGap(order(), moving, side === "before" ? i : i + 1), "row");
  });
}

// ---- Selecting, from the mouse and the keyboard ----
const listEl = $("rb-list");
const rowOf = (t) => (t && t.closest ? t.closest(".rb-row:not(.rb-base)") : null);
listEl.addEventListener("mousedown", (e) => {
  // A Shift-click selects rows, not the text between two clicks.
  if (e.shiftKey && rowOf(e.target)) e.preventDefault();
});
listEl.addEventListener("click", (e) => {
  const row = rowOf(e.target);
  // A row's own controls keep their clicks; focusing one selects its row.
  if (!row || e.target.closest("select, textarea, button, input, a")) return;
  select(P.clickRow(selection, order(), row.dataset.sha, { range: e.shiftKey, toggle: isMac ? e.metaKey : e.ctrlKey }));
});
listEl.addEventListener("focusin", (e) => {
  // Tabbing (or clicking) into a row's dropdown or message box makes that row
  // the one the keys act on. The row's own focus is the click's business: a
  // Cmd-click must not collapse the selection on its way in.
  const row = rowOf(e.target);
  if (!row || e.target === row) return;
  const sha = row.dataset.sha;
  if (selection.selected.indexOf(sha) < 0) select(P.selectOnly(sha), false);
  else if (selection.focus !== sha) select(Object.assign({}, selection, { focus: sha }), false);
});
listEl.addEventListener("keydown", (e) => {
  const row = rowOf(e.target);
  if (!row || busy) return;
  // Alt+Up/Down moves the selection from anywhere in a row, as it always has.
  if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
    e.preventDefault();
    const next = P.moveSelected(order(), selection.selected, e.key === "ArrowUp" ? -1 : 1);
    if (next) reorder(next, "row");
    return;
  }
  // Everything else only on the row itself: a dropdown's arrows and a message
  // box's letters are theirs.
  if (e.target !== row) return;
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if ((e.key === "ArrowUp" || e.key === "ArrowDown") && !mod && !e.altKey) {
    e.preventDefault();
    select(P.arrowRow(selection, order(), e.key === "ArrowUp" ? -1 : 1, e.shiftKey));
  } else if ((e.key === "Home" || e.key === "End") && !mod && !e.altKey) {
    e.preventDefault();
    select(P.reachRow(selection, order(), e.key === "Home" ? 0 : rows.length - 1, e.shiftKey));
  } else if (e.key === "Escape") {
    const next = P.collapseSelection(selection);
    if (next === selection) return; // nothing to collapse: Escape is not ours
    e.preventDefault();
    e.stopPropagation();
    select(next);
  } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "a") {
    e.preventDefault();
    select(P.selectAll(selection, order()));
    selectAllAt = Date.now();
  } else if (!e.altKey && !e.ctrlKey && !e.metaKey) {
    // git's own todo letters: p r s f e d.
    const action = P.actionForKey(e.key);
    if (!action) return;
    e.preventDefault();
    bulkSet(action, "row");
  }
});
// VS Code answers Cmd/Ctrl+A in a webview with its own Select All, which
// paints every word on the page as selected text a moment after the rows
// were selected. A row never holds text you would select (it drags), so a
// text selection made while a row has the keyboard is cleared.
let selectAllAt = 0;
document.addEventListener("selectionchange", () => {
  const s = window.getSelection && window.getSelection();
  if (!s || s.isCollapsed) return;
  if (rowOf(document.activeElement) === document.activeElement || Date.now() - selectAllAt < 1500) s.removeAllRanges();
});

function updatePreview() {
  const kept = rows.filter((r) => r.action === "pick" || r.action === "reword" || r.action === "edit").length;
  $("rb-preview").innerHTML = "<b>" + rows.length + "</b> → <b>" + kept + "</b> commit" + (kept === 1 ? "" : "s");
  // Re-validate the WHOLE plan, not just the action last set: a fold's target
  // can disappear long after the fold was chosen (drop the row below it, or
  // drag it to the bottom). Start stays off until the plan is one git can run
  // — the shared builder would refuse it anyway, but a disabled button with a
  // reason beats a refusal after the confirm.
  const orphaned = rows.some((r, i) =>
    (r.action === "squash" || r.action === "fixup") && foldTargetSubject(i) === null);
  const apply = $("rb-apply");
  if (!busy) {
    apply.disabled = orphaned;
    apply.title = orphaned
      ? "A squash or fixup has nothing below it to fold into — git can't run this plan."
      : "";
  }
}

let bannerTimer = null;
// The paused rebase's banner (showStopBanner), while the rebase is paused:
// its Continue, Skip and Abort are the page's way out, and the list stays
// editable under it — so a refused squash, one key away (#32), borrows the
// banner. A flash hands it BACK; hiding the banner when the flash ended left
// a paused rebase with no way out on the page.
let stopShown = null;
/** The banner as it is when nothing transient is on it. */
function restoreBanner() {
  clearTimeout(bannerTimer);
  if (stopShown) showStopBanner(stopShown.text, stopShown.stop, true);
  else $("rb-banner").hidden = true;
}
function flashBanner(text, kind) {
  const b = $("rb-banner");
  b.className = "rb-banner " + (kind || "warn");
  b.innerHTML = '<i class="codicon codicon-' + (kind === "err" ? "error" : "warning") + '"></i>';
  b.appendChild(document.createTextNode(text));
  b.hidden = false;
  clearTimeout(bannerTimer);
  if (kind !== "err") bannerTimer = setTimeout(restoreBanner, 4000);
}
// The stop banner. "stop" says what git allows at this stop (the host asks
// OperationProvider): Skip only where git names it as the way out, and the
// Conflicts dashboard while files are unmerged. Labels are set as TEXT, in
// the operation's own words (the dashboard's "Continue Rebase", not a bare
// "Continue"). A verb rebuilds the banner under the button that ran it; the
// keyboard goes back to that verb instead of falling to the page — unless
// the banner is only being handed back after a flash ("restored"), which
// moves nobody's keyboard.
function textButton(cls, label) { const n = el("button", cls); n.textContent = label; return n; }
let lastVerb = "";
function showStopBanner(text, stop, restored) {
  // The rebase is paused for as long as this says so, and a flash that was
  // still running when it paused must not hide it when its timer ends.
  stopShown = { text: text, stop: stop };
  clearTimeout(bannerTimer);
  const b = $("rb-banner");
  const active = document.activeElement;
  const keyboardHere = !active || active === document.body || (b.contains ? b.contains(active) : false);
  b.className = "rb-banner warn";
  b.innerHTML = '<i class="codicon codicon-debug-pause"></i>';
  b.appendChild(document.createTextNode(text));
  const acts = el("span", "b-actions");
  if (stop && stop.conflicts > 0) {
    const resolve = textButton("rb-btn secondary", "Resolve Conflicts…"); resolve.addEventListener("click", () => vscode.postMessage({ type: "resolveConflicts" }));
    acts.appendChild(resolve);
  }
  const verbs = {};
  const cont = textButton("rb-btn primary", "Continue Rebase"); cont.addEventListener("click", () => { lastVerb = "continue"; setBusy(true); vscode.postMessage({ type: "continue" }); });
  acts.appendChild(cont); verbs.continue = cont;
  if (stop && stop.canSkip) {
    const skip = textButton("rb-btn secondary", stop.skipLabel || "Skip this commit"); skip.addEventListener("click", () => { lastVerb = "skip"; setBusy(true); vscode.postMessage({ type: "skip" }); });
    acts.appendChild(skip); verbs.skip = skip;
  }
  const abort = textButton("rb-btn secondary", "Abort Rebase"); abort.addEventListener("click", () => { lastVerb = "abort"; vscode.postMessage({ type: "abort" }); });
  acts.appendChild(abort); b.appendChild(acts); verbs.abort = abort;
  b.hidden = false;
  const back = keyboardHere && lastVerb && !restored ? (verbs[lastVerb] || cont) : null;
  if (back && back.focus) back.focus();
}
let lastStopText = "";

function setBusy(on, label) {
  busy = on;
  const apply = $("rb-apply");
  apply.classList.toggle("busy", on);
  apply.disabled = on;
  $("rb-cancel").disabled = on;
  if (label) $("rb-apply-label").textContent = label;
  paintSelection(); // nothing sets an action while the plan is running
}

// The footer carries the banner, so it grows by the banner's height; the page
// keeps that much room under the last row, so nothing is ever hidden beneath.
// And the rows the keyboard reaches scroll clear of BOTH bars: focus scrolls
// only as far as the window's edge, which is under the sticky header or the
// fixed footer — Down to the last commit left it behind Start Rebase.
const headEl = document.querySelector(".rb-head");
function syncBars() {
  const foot = $("rb-foot").offsetHeight;
  document.body.style.paddingBottom = (foot + 16) + "px";
  document.documentElement.style.scrollPaddingBottom = (foot + 8) + "px";
  document.documentElement.style.scrollPaddingTop = ((headEl ? headEl.offsetHeight : 0) + 8) + "px";
}
syncBars();
if (window.ResizeObserver) {
  const ro = new ResizeObserver(syncBars);
  ro.observe($("rb-foot"));
  if (headEl) ro.observe(headEl);
}

$("rb-apply").addEventListener("click", () => {
  if (busy) return;
  $("rb-banner").hidden = true;
  setBusy(true, "Rebasing…");
  vscode.postMessage({ type: "apply", rows: rows.map((r) => ({ sha: r.sha, action: r.action, subject: r.subject, message: r.action === "reword" ? (r.message || r.subject) : undefined })) });
});
$("rb-cancel").addEventListener("click", () => vscode.postMessage({ type: "cancel" }));
// Reset puts the rows back; a paused rebase is still paused, and keeps its way out.
$("rb-reset").addEventListener("click", () => { rows = ORIGINAL.map((c) => ({ ...c })); restoreBanner(); renderList(); });
$("rb-explain-x").addEventListener("click", () => $("rb-explain").classList.add("hidden"));

window.addEventListener("message", (e) => {
  const msg = e.data;
  if (msg.type === "result") {
    const o = msg.outcome;
    if (o.status === "done") { setBusy(true, "Done"); return; }
    setBusy(false, "Start Rebase");
    if (o.status === "stopped") {
      // A Skip the user backed out of reports "stopped" with nothing new: keep
      // the explanation already on screen.
      const text = o.reason === "unknown" && !o.message && lastStopText
        ? lastStopText
        : (o.reason === "conflict" ? "Rebase paused on a conflict — resolve the files, then Continue. " : o.reason === "edit" ? "Rebase paused to edit a commit — amend in your working tree, then Continue. " : "Rebase paused. ") + (o.message || "");
      lastStopText = text;
      showStopBanner(text, msg.stop);
    }
    else flashBanner(o.message || "Rebase failed.", o.expected ? "warn" : "err");
  } else if (msg.type === "aborted") {
    if (!msg.ok) flashBanner("Couldn't abort the rebase.", "err");
  }
});

renderList();
`;
