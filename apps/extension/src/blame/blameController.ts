import * as vscode from "vscode";
import { relative } from "node:path";
import type { BlameResult, BlameCommit } from "@gitstudio/git-service/index";
import { UNCOMMITTED_SHA } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";

// How long after the selection settles before we run a blame — fast enough to
// feel live, slow enough not to spawn git on every cursor twitch.
const SELECTION_DEBOUNCE_MS = 200;
// Files larger than this skip inline/hover blame; full-file annotations are
// viewport-limited instead of refusing outright.
const MAX_BLAME_LINES = 20_000;
// When annotating a huge file, only decorate a window around the viewport.
const ANNOTATION_VIEWPORT_PAD = 200;
const ANNOTATION_MAX_LINES = 5_000;

const NATIVE_BLAME_DISABLED_KEY = "gitstudio.blame.disabledNativeBlame";

/**
 * The GitStudio blame surface: inline current-line annotation, a status bar
 * item, a rich hover, and a full-file annotation toggle with a code-age
 * heatmap. Backed by the git-service BlameProvider via the RepoManager's
 * active GitContext. All decorations are file-scheme + in-repo only.
 */
export class BlameController implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];

  // One reusable decoration type for the inline current-line annotation.
  private readonly inlineDecoration =
    vscode.window.createTextEditorDecorationType({
      isWholeLine: false,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });

  // The status bar item summarising the current line's commit.
  private readonly statusBar: vscode.StatusBarItem;

  // Per-document blame cache, keyed by document version so a single edit
  // invalidates it. Holds the in-flight promise to coalesce concurrent reads.
  private readonly blameCache = new Map<
    string,
    { version: number; result: Promise<BlameResult | undefined> }
  >();

  // Full-file annotation state, per editor (by document uri string).
  private readonly annotated = new Map<string, vscode.TextEditorDecorationType>();

  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private inlineCts: vscode.CancellationTokenSource | undefined;
  // Tracks the line we last rendered so a no-op selection move is cheap.
  private lastRendered: { uri: string; line: number } | undefined;

  constructor(
    private readonly repos: RepoManager,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -10,
    );
    this.statusBar.command = "gitstudio.blame.showLineActions";

    void this.maybeDisableNativeBlame();

    this.disposables.push(
      this.inlineDecoration,
      this.statusBar,
      vscode.languages.registerHoverProvider(
        { scheme: "file" },
        new BlameHoverProvider(this),
      ),
      vscode.window.onDidChangeTextEditorSelection((e) =>
        this.scheduleInline(e.textEditor),
      ),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.scheduleInline(editor);
        } else {
          this.clearInline();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((e) => {
        // An edit invalidates the cached blame and any current annotation.
        this.blameCache.delete(e.document.uri.toString());
        const editor = vscode.window.activeTextEditor;
        if (editor && editor.document === e.document) {
          this.clearInline();
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        this.blameCache.delete(doc.uri.toString());
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        // Re-render viewport-limited annotations as the user scrolls.
        if (this.annotated.has(e.textEditor.document.uri.toString())) {
          void this.renderAnnotations(e.textEditor);
        }
      }),
      vscode.commands.registerCommand("gitstudio.toggleFileBlame", () =>
        this.toggleFileBlame(),
      ),
      vscode.commands.registerCommand("gitstudio.blame.showLineActions", () =>
        this.showLineActions(),
      ),
      // The repo set / active repo changed: stale blame may now be wrong.
      this.repos.onDidChange(() => {
        this.blameCache.clear();
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          this.scheduleInline(editor);
        }
      }),
    );

    // Render for whatever is already open at activation.
    if (vscode.window.activeTextEditor) {
      this.scheduleInline(vscode.window.activeTextEditor);
    }
  }

  // --- Inline current-line blame ------------------------------------------

  private scheduleInline(editor: vscode.TextEditor): void {
    if (this.selectionTimer !== undefined) {
      clearTimeout(this.selectionTimer);
    }
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = undefined;
      void this.renderInline(editor);
    }, SELECTION_DEBOUNCE_MS);
  }

  private clearInline(): void {
    this.inlineCts?.cancel();
    this.lastRendered = undefined;
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.inlineDecoration, []);
    }
    this.statusBar.hide();
  }

  private async renderInline(editor: vscode.TextEditor): Promise<void> {
    const config = vscode.workspace.getConfiguration("gitstudio.blame");
    const inlineEnabled = config.get<boolean>("inlineEnabled", true);
    const statusBarEnabled = config.get<boolean>("statusBarEnabled", true);

    if (editor !== vscode.window.activeTextEditor) {
      return;
    }

    const ctx = this.resolveFor(editor.document);
    if (!ctx) {
      this.clearForEditor(editor);
      return;
    }

    const line = editor.selection.active.line; // 0-based
    if (
      this.lastRendered &&
      this.lastRendered.uri === editor.document.uri.toString() &&
      this.lastRendered.line === line
    ) {
      return; // same line — nothing to redo
    }

    this.inlineCts?.cancel();
    const cts = new vscode.CancellationTokenSource();
    this.inlineCts = cts;

    const blame = await this.getBlame(editor.document, ctx, cts.token);
    if (cts.token.isCancellationRequested || editor !== vscode.window.activeTextEditor) {
      return;
    }
    if (!blame) {
      this.clearForEditor(editor);
      return;
    }

    const commit = commitForLine(blame, line);
    if (!commit) {
      editor.setDecorations(this.inlineDecoration, []);
      this.statusBar.hide();
      return;
    }

    this.lastRendered = { uri: editor.document.uri.toString(), line };

    if (inlineEnabled) {
      const label = inlineLabel(commit);
      const range = editor.document.lineAt(line).range;
      const decoration: vscode.DecorationOptions = {
        range: new vscode.Range(range.end, range.end),
        renderOptions: {
          after: {
            contentText: label,
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            fontStyle: "italic",
            margin: "0 0 0 3em",
          },
        },
      };
      editor.setDecorations(this.inlineDecoration, [decoration]);
    } else {
      editor.setDecorations(this.inlineDecoration, []);
    }

    if (statusBarEnabled) {
      this.statusBar.text = statusBarText(commit);
      this.statusBar.tooltip = statusBarTooltip(commit);
      this.statusBar.show();
    } else {
      this.statusBar.hide();
    }
  }

  private clearForEditor(editor: vscode.TextEditor): void {
    editor.setDecorations(this.inlineDecoration, []);
    this.statusBar.hide();
    this.lastRendered = undefined;
  }

  // --- Status-bar line actions --------------------------------------------

  private async showLineActions(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const ctx = this.resolveFor(editor.document);
    if (!ctx) {
      return;
    }
    const blame = await this.getBlame(editor.document, ctx);
    if (!blame) {
      return;
    }
    const commit = commitForLine(blame, editor.selection.active.line);
    if (!commit) {
      return;
    }

    const isUncommitted = commit.sha === UNCOMMITTED_SHA;
    const items: Array<vscode.QuickPickItem & { id: string }> = [
      { id: "sha", label: "$(copy) Copy SHA", description: short(commit.sha) },
      { id: "author", label: "$(account) Copy Author", description: commit.author },
      { id: "history", label: "$(history) Show File History" },
      { id: "toggle", label: "$(list-flat) Toggle File Blame" },
    ];
    const picked = await vscode.window.showQuickPick(
      isUncommitted ? items.filter((i) => i.id === "toggle") : items,
      { placeHolder: isUncommitted ? "Uncommitted changes" : commit.summary },
    );
    if (!picked) {
      return;
    }
    switch (picked.id) {
      case "sha":
        await vscode.env.clipboard.writeText(commit.sha);
        void vscode.window.showInformationMessage(`Copied ${short(commit.sha)}`);
        break;
      case "author":
        await vscode.env.clipboard.writeText(commit.author);
        void vscode.window.showInformationMessage(`Copied ${commit.author}`);
        break;
      case "history":
        // Stub: file history lands in a later milestone.
        void vscode.window.showInformationMessage(
          "File history is coming in a later GitStudio milestone.",
        );
        break;
      case "toggle":
        await this.toggleFileBlame();
        break;
    }
  }

  // --- Full-file annotations toggle ----------------------------------------

  private async toggleFileBlame(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    const key = editor.document.uri.toString();
    const existing = this.annotated.get(key);
    if (existing) {
      editor.setDecorations(existing, []);
      existing.dispose();
      this.annotated.delete(key);
      return;
    }
    const ctx = this.resolveFor(editor.document);
    if (!ctx) {
      void vscode.window.showInformationMessage(
        "GitStudio: this file isn't in an open Git repository.",
      );
      return;
    }
    const type = vscode.window.createTextEditorDecorationType({
      before: { margin: "0 1em 0 0" },
    });
    this.annotated.set(key, type);
    await this.renderAnnotations(editor);
  }

  private async renderAnnotations(editor: vscode.TextEditor): Promise<void> {
    const key = editor.document.uri.toString();
    const type = this.annotated.get(key);
    if (!type) {
      return;
    }
    const ctx = this.resolveFor(editor.document);
    if (!ctx) {
      return;
    }
    const blame = await this.getBlame(editor.document, ctx);
    if (!blame || !this.annotated.has(key)) {
      return;
    }

    const heatmap = vscode.workspace
      .getConfiguration("gitstudio.blame")
      .get<boolean>("heatmap", true);

    const total = editor.document.lineCount;
    const { start, end } = annotationWindow(editor, total);

    // Newest/oldest author times across the file drive the heatmap ramp.
    const times = [...blame.commits.values()]
      .map((c) => c.authorTime)
      .filter((t) => t > 0);
    const newest = times.length ? Math.max(...times) : 0;
    const oldest = times.length ? Math.min(...times) : 0;

    const decorations: vscode.DecorationOptions[] = [];
    for (let line = start; line < end; line++) {
      const commit = commitForLine(blame, line);
      if (!commit) {
        continue;
      }
      const ramp =
        heatmap && commit.sha !== UNCOMMITTED_SHA
          ? heatColor(commit.authorTime, oldest, newest)
          : undefined;
      const range = editor.document.lineAt(line).range;
      decorations.push({
        range: new vscode.Range(range.start, range.start),
        renderOptions: {
          before: {
            contentText: annotationGutter(commit),
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            backgroundColor: ramp,
            width: "13em",
          },
        },
      });
    }
    editor.setDecorations(type, decorations);
  }

  // --- Blame access (used by the hover provider too) -----------------------

  resolveFor(document: vscode.TextDocument): RepoEntry | undefined {
    if (document.uri.scheme !== "file") {
      return undefined;
    }
    const active = this.repos.getActive();
    if (active && isInside(document.uri.fsPath, active.root)) {
      return active;
    }
    for (const entry of this.repos.getAll()) {
      if (isInside(document.uri.fsPath, entry.root)) {
        return entry;
      }
    }
    return undefined;
  }

  async getBlame(
    document: vscode.TextDocument,
    ctx: RepoEntry,
    token?: vscode.CancellationToken,
  ): Promise<BlameResult | undefined> {
    if (document.lineCount > MAX_BLAME_LINES) {
      return undefined;
    }
    const key = document.uri.toString();
    const cached = this.blameCache.get(key);
    if (cached && cached.version === document.version) {
      return cached.result;
    }

    const relPath = relative(ctx.root, document.uri.fsPath);
    const controller = new AbortController();
    if (token) {
      token.onCancellationRequested(() => controller.abort());
    }
    // Feed the live (possibly dirty) buffer so blame matches what's on screen.
    const contents = document.isDirty ? document.getText() : undefined;

    const promise = ctx.ctx.blame
      .blameFile(relPath, { contents, signal: controller.signal })
      .catch(() => undefined);
    this.blameCache.set(key, { version: document.version, result: promise });
    return promise;
  }

  // --- Native-blame de-duplication (one-time) ------------------------------

  private async maybeDisableNativeBlame(): Promise<void> {
    if (this.context.globalState.get<boolean>(NATIVE_BLAME_DISABLED_KEY)) {
      return;
    }
    const git = vscode.workspace.getConfiguration("git");
    const editorDecoration = git.inspect<boolean>("blame.editorDecoration.enabled");
    const statusBarItem = git.inspect<boolean>("blame.statusBarItem.enabled");

    // Only act when the *effective* value is on AND the user hasn't explicitly
    // set it (globally or per-workspace) themselves.
    const userSet = (v?: { globalValue?: boolean; workspaceValue?: boolean }) =>
      v?.globalValue !== undefined || v?.workspaceValue !== undefined;

    const decOn =
      editorDecoration?.defaultValue === true && !userSet(editorDecoration);
    const sbOn = statusBarItem?.defaultValue === true && !userSet(statusBarItem);

    // Mark handled regardless, so we never nag again on this machine.
    await this.context.globalState.update(NATIVE_BLAME_DISABLED_KEY, true);

    if (!decOn && !sbOn) {
      return;
    }
    try {
      if (decOn) {
        await git.update(
          "blame.editorDecoration.enabled",
          false,
          vscode.ConfigurationTarget.Global,
        );
      }
      if (sbOn) {
        await git.update(
          "blame.statusBarItem.enabled",
          false,
          vscode.ConfigurationTarget.Global,
        );
      }
      void vscode.window.showInformationMessage(
        "GitStudio inline blame is on; disabled the built-in blame to avoid " +
          "duplicate annotations. You can re-enable it in settings.",
      );
    } catch {
      // Best-effort: a settings write failure shouldn't break activation.
    }
  }

  dispose(): void {
    if (this.selectionTimer !== undefined) {
      clearTimeout(this.selectionTimer);
    }
    this.inlineCts?.cancel();
    for (const type of this.annotated.values()) {
      type.dispose();
    }
    this.annotated.clear();
    this.blameCache.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }
}

/** The rich hover for a blamed line. */
class BlameHoverProvider implements vscode.HoverProvider {
  constructor(private readonly controller: BlameController) {}

  async provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
    token: vscode.CancellationToken,
  ): Promise<vscode.Hover | undefined> {
    const ctx = this.controller.resolveFor(document);
    if (!ctx) {
      return undefined;
    }
    const blame = await this.controller.getBlame(document, ctx, token);
    if (!blame || token.isCancellationRequested) {
      return undefined;
    }
    const commit = commitForLine(blame, position.line);
    if (!commit) {
      return undefined;
    }
    return new vscode.Hover(hoverMarkdown(commit), document.lineAt(position.line).range);
  }
}

// --- Presentation helpers (pure, no editor state) --------------------------

/** Inline label format: `  <Author>, <relative time> • <summary>`. */
function inlineLabel(commit: BlameCommit): string {
  if (commit.sha === UNCOMMITTED_SHA) {
    return "  You, now • Uncommitted changes";
  }
  return `  ${commit.author}, ${relativeTime(commit.authorTime)} • ${truncate(commit.summary, 60)}`;
}

function statusBarText(commit: BlameCommit): string {
  if (commit.sha === UNCOMMITTED_SHA) {
    return "$(git-commit) Uncommitted changes";
  }
  return `$(git-commit) ${commit.author}, ${relativeTime(commit.authorTime)}`;
}

function statusBarTooltip(commit: BlameCommit): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  if (commit.sha === UNCOMMITTED_SHA) {
    md.appendMarkdown("Uncommitted changes");
    return md;
  }
  md.appendMarkdown(`**${escapeMarkdown(commit.summary)}**\n\n`);
  md.appendMarkdown(`$(git-commit) \`${short(commit.sha)}\``);
  return md;
}

/** Gutter annotation: `<short-sha> <author short> <date>`. */
function annotationGutter(commit: BlameCommit): string {
  if (commit.sha === UNCOMMITTED_SHA) {
    return "0000000 You             now";
  }
  const sha = short(commit.sha);
  const author = pad(authorShort(commit.author), 12);
  const date = isoDate(commit.authorTime);
  return `${sha} ${author} ${date}`;
}

function hoverMarkdown(commit: BlameCommit): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.isTrusted = { enabledCommands: ["gitstudio.copyCommitSha"] };

  if (commit.sha === UNCOMMITTED_SHA) {
    md.appendMarkdown("$(git-commit) **Uncommitted changes**\n\n");
    md.appendMarkdown("This line has local, not-yet-committed edits.");
    return md;
  }

  const date = new Date(commit.authorTime * 1000);
  md.appendMarkdown(`**${escapeMarkdown(commit.summary)}**\n\n`);
  md.appendMarkdown(
    `$(account) ${escapeMarkdown(commit.author)} <${escapeMarkdown(commit.authorMail)}>\n\n`,
  );
  md.appendMarkdown(
    `$(calendar) ${escapeMarkdown(date.toLocaleString())} (${relativeTime(commit.authorTime)})\n\n`,
  );
  const copyArg = encodeURIComponent(JSON.stringify(commit.sha));
  md.appendMarkdown(
    `$(git-commit) \`${short(commit.sha)}\` ` +
      `&nbsp;[$(copy) Copy SHA](command:gitstudio.copyCommitSha?${copyArg})`,
  );
  return md;
}

/** Map an author time onto a warm (recent) → cool (old) translucent ramp. */
function heatColor(time: number, oldest: number, newest: number): string {
  if (newest <= oldest) {
    return "rgba(255, 153, 51, 0.10)";
  }
  // 0 = oldest, 1 = newest.
  const t = Math.max(0, Math.min(1, (time - oldest) / (newest - oldest)));
  // Warm orange (recent) → cool blue (old). Keep alpha low to stay subtle.
  const r = Math.round(60 + t * (255 - 60));
  const g = Math.round(120 + t * (153 - 120));
  const b = Math.round(220 - t * (220 - 51));
  return `rgba(${r}, ${g}, ${b}, 0.12)`;
}

function commitForLine(
  blame: BlameResult,
  zeroBasedLine: number,
): BlameCommit | undefined {
  const finalLine = zeroBasedLine + 1; // blame is 1-based
  // lines are sorted; a small file makes a linear scan fine, but index for O(1).
  const entry = blame.lines[finalLine - 1];
  const sha =
    entry && entry.finalLine === finalLine
      ? entry.sha
      : blame.lines.find((l) => l.finalLine === finalLine)?.sha;
  return sha ? blame.commits.get(sha) : undefined;
}

function annotationWindow(
  editor: vscode.TextEditor,
  total: number,
): { start: number; end: number } {
  if (total <= ANNOTATION_MAX_LINES) {
    return { start: 0, end: total };
  }
  const ranges = editor.visibleRanges;
  const first = ranges.length ? ranges[0].start.line : 0;
  const last = ranges.length ? ranges[ranges.length - 1].end.line : total;
  return {
    start: Math.max(0, first - ANNOTATION_VIEWPORT_PAD),
    end: Math.min(total, last + ANNOTATION_VIEWPORT_PAD),
  };
}

function truncate(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function authorShort(author: string): string {
  return author.length > 12 ? `${author.slice(0, 11)}…` : author;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function isoDate(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().slice(0, 10);
}

/** Escapes the markdown control characters that show up in commit text. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|>]/g, "\\$&");
}

/** True when `filePath` sits at or below `dir` (path-boundary aware). */
function isInside(filePath: string, dir: string): boolean {
  const rel = relative(dir, filePath);
  return rel.length > 0 && !rel.startsWith("..") && !rel.startsWith("/");
}
