import * as vscode from "vscode";
import { relative } from "node:path";
import type { BlameResult, BlameCommit } from "@gitstudio/git-service/index";
import { UNCOMMITTED_SHA } from "@gitstudio/git-service/index";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativeTime } from "../util/relativeTime";
import { commitWebUrl } from "../util/remoteUrl";
import { openRevisionDiff, toRevisionUri } from "../history/revisionContentProvider";

// How long after the selection settles before we run a blame — fast enough to
// feel live, slow enough not to spawn git on every cursor twitch.
const SELECTION_DEBOUNCE_MS = 200;
// Files larger than this skip inline/hover blame; full-file annotations are
// viewport-limited instead of refusing outright.
const MAX_BLAME_LINES = 20_000;
// When annotating a huge file, only decorate a window around the viewport.
const ANNOTATION_VIEWPORT_PAD = 200;
const ANNOTATION_MAX_LINES = 5_000;
/** Quiet period before a typing burst triggers a re-blame of the gutter. */
const ANNOTATION_DEBOUNCE_MS = 300;

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
  /**
   * JetBrains-style "Annotate" mode: when on, the blame gutter follows you to
   * every file you open and survives restarts, instead of being a one-shot
   * per-file toggle. Persisted in globalState.
   */
  private annotateAll = false;
  private static readonly ANNOTATE_KEY = "gitstudio.blame.annotateAll";
  /** Debounce + cancellation for annotation re-blames, keyed by document uri.
   *  Without these, every keystroke spawned a full-buffer `git blame` that
   *  nothing could abort, saturating the shared git pool while typing. */
  private readonly annotationTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly annotationCts = new Map<string, vscode.CancellationTokenSource>();

  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private inlineCts: vscode.CancellationTokenSource | undefined;
  // Tracks the line we last rendered so a no-op selection move is cheap.
  private lastRendered: { uri: string; line: number } | undefined;

  constructor(
    private readonly repos: RepoManager,
    private readonly context: vscode.ExtensionContext,
    private readonly log?: (m: string) => void,
  ) {
    this.statusBar = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      -10,
    );
    this.statusBar.command = "gitstudio.blame.showLineActions";

    void this.maybeDisableNativeBlame();

    // The annotation submenu is driven entirely by context keys — publish them
    // now and register the checked/unchecked command pairs behind them.
    this.registerAnnotationMenuCommands();
    void this.syncMenuContexts();

    // Restore annotate mode from the last session and light up the editor that
    // is already open, so the gutter is there before the user touches anything.
    this.annotateAll = context.globalState.get<boolean>(BlameController.ANNOTATE_KEY, false);
    // Always publish the key — the annotation submenu's `when` clause reads it,
    // and an explicit false is clearer than relying on undefined being falsy.
    void vscode.commands.executeCommand(
      "setContext",
      "gitstudio.blameAnnotated",
      this.annotateAll,
    );
    if (this.annotateAll) {
      const active = vscode.window.activeTextEditor;
      if (active) {
        void this.ensureAnnotated(active);
      }
    }

    this.disposables.push(
      this.inlineDecoration,
      this.statusBar,
      vscode.languages.registerHoverProvider(
        { scheme: "file" },
        new BlameHoverProvider(this),
      ),
      vscode.window.onDidChangeTextEditorSelection((e) => {
        this.scheduleInline(e.textEditor);
        this.onPossibleAnnotationClick(e);
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) {
          this.scheduleInline(editor);
          // Annotate mode follows the user from file to file (JetBrains-style).
          if (this.annotateAll) {
            void this.ensureAnnotated(editor);
          }
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
          // Keep the gutter aligned with the edited buffer rather than leaving
          // stale author/date rows next to shifted lines — but DEBOUNCED, so a
          // typing burst doesn't spawn one full-buffer `git blame` per keystroke.
          if (this.annotated.has(e.document.uri.toString())) {
            this.scheduleAnnotations(editor);
          }
        }
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const key = doc.uri.toString();
        this.blameCache.delete(key);
        // Annotate mode creates a decoration type per opened file; without this
        // the map (and its types) grow for every file visited in the session.
        const type = this.annotated.get(key);
        if (type) {
          type.dispose();
          this.annotated.delete(key);
        }
        const timer = this.annotationTimers.get(key);
        if (timer !== undefined) {
          clearTimeout(timer);
          this.annotationTimers.delete(key);
        }
        const cts = this.annotationCts.get(key);
        if (cts) {
          cts.cancel();
          cts.dispose();
          this.annotationCts.delete(key);
        }
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
      // The annotation right-click actions (JetBrains parity).
      // Same handler as the toggle, but titled for the "already annotating"
      // state so the menu reads like JetBrains' "Close Annotations".
      vscode.commands.registerCommand("gitstudio.blame.closeAnnotations", () =>
        this.toggleFileBlame(),
      ),
      vscode.commands.registerCommand("gitstudio.blame.copyRevision", () =>
        this.copyRevision(),
      ),
      vscode.commands.registerCommand("gitstudio.blame.showDiff", () =>
        this.showRevisionDiff(),
      ),
      vscode.commands.registerCommand("gitstudio.blame.showCommit", () =>
        this.showCommitInPanel(),
      ),
      vscode.commands.registerCommand("gitstudio.blame.openPreviousRevision", () =>
        this.openPreviousRevision(),
      ),
      vscode.commands.registerCommand("gitstudio.blame.viewInBrowser", () =>
        this.viewRevisionInBrowser(),
      ),
      // Editing the gutter settings (from the right-click submenu or the
      // Settings UI) must repaint immediately and keep the menu's checkmarks in
      // sync, rather than waiting for the next scroll or edit.
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("gitstudio.blame.gutter") ||
          e.affectsConfiguration("gitstudio.blame.heatmap") ||
          e.affectsConfiguration("gitstudio.blame.showDiffOnHover")
        ) {
          void this.syncMenuContexts();
          void this.refreshAllAnnotations();
        }
      }),
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

  // --- Status-bar line action ----------------------------------------------

  /**
   * Clicking the status-bar blame item reveals that commit in OUR Commit Graph,
   * beside the code. Deliberately NOT a QuickPick: the blame surface stays
   * inside GitStudio's own UI rather than bouncing through the editor's
   * command-palette chrome.
   */
  private async showLineActions(): Promise<void> {
    const at = await this.commitAtCursor();
    if (!at) {
      return;
    }
    await vscode.commands.executeCommand("gitstudio.revealCommitInGraph", at.commit.sha);
  }

  // --- Full-file annotations toggle ----------------------------------------

  /**
   * Toggle the JetBrains-style annotate gutter. This is a MODE, not a per-file
   * switch: once on, every file you open shows the blame column (author + date
   * in a fixed-width rule down the left of the code), and the choice survives a
   * restart. Turning it off clears every annotated editor at once.
   */
  private async toggleFileBlame(): Promise<void> {
    this.annotateAll = !this.annotateAll;
    await this.context.globalState.update(BlameController.ANNOTATE_KEY, this.annotateAll);
    await vscode.commands.executeCommand(
      "setContext",
      "gitstudio.blameAnnotated",
      this.annotateAll,
    );

    if (!this.annotateAll) {
      this.clearAllAnnotations();
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return;
    }
    if (!this.resolveFor(editor.document)) {
      void vscode.window.showInformationMessage(
        "GitStudio: this file isn't in an open Git repository.",
      );
      return;
    }
    await this.ensureAnnotated(editor);
  }

  /** Create (once) and render the gutter for an editor while annotate mode is on. */
  private async ensureAnnotated(editor: vscode.TextEditor): Promise<void> {
    const key = editor.document.uri.toString();
    if (!this.annotated.has(key)) {
      if (!this.resolveFor(editor.document)) {
        return; // not in a repo — silently skip, mode stays on for other files
      }
      this.annotated.set(
        key,
        vscode.window.createTextEditorDecorationType({ before: { margin: "0 1em 0 0" } }),
      );
    }
    await this.renderAnnotations(editor);
  }

  /** Drop every annotation (mode off, or shutting down). */
  private clearAllAnnotations(): void {
    for (const [key, type] of this.annotated) {
      for (const ed of vscode.window.visibleTextEditors) {
        if (ed.document.uri.toString() === key) {
          ed.setDecorations(type, []);
        }
      }
      type.dispose();
    }
    this.annotated.clear();
  }

  /** Coalesce annotation re-renders while the user is typing. */
  private scheduleAnnotations(editor: vscode.TextEditor, delay = ANNOTATION_DEBOUNCE_MS): void {
    const key = editor.document.uri.toString();
    const existing = this.annotationTimers.get(key);
    if (existing !== undefined) {
      clearTimeout(existing);
    }
    this.annotationTimers.set(
      key,
      setTimeout(() => {
        this.annotationTimers.delete(key);
        void this.renderAnnotations(editor);
      }, delay),
    );
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

    // Supersede any blame still in flight for this document, so an obsolete
    // result can neither burn a git slot nor paint over a newer one.
    this.annotationCts.get(key)?.cancel();
    this.annotationCts.get(key)?.dispose();
    const cts = new vscode.CancellationTokenSource();
    this.annotationCts.set(key, cts);
    const version = editor.document.version;

    const blame = await this.getBlame(editor.document, ctx, cts.token);
    if (this.annotationCts.get(key) === cts) {
      this.annotationCts.delete(key);
      cts.dispose();
    }
    if (!blame || cts.token.isCancellationRequested || !this.annotated.has(key)) {
      return;
    }
    // The buffer moved on while we were blaming; the newer render will paint.
    if (editor.document.version !== version) {
      return;
    }

    const opts = gutterOptions();
    const total = editor.document.lineCount;
    const { start, end } = annotationWindow(editor, total);

    // Newest/oldest author times across the file drive the age ramp.
    const times = [...blame.commits.values()]
      .map((c) => c.authorTime)
      .filter((t) => t > 0);
    const newest = times.length ? Math.max(...times) : 0;
    const oldest = times.length ? Math.min(...times) : 0;

    // "Commit number" = each commit's ordinal within THIS file's history,
    // oldest first — the local analogue of JetBrains' commit-number column.
    const ordinals = new Map<string, number>();
    [...blame.commits.values()]
      .filter((c) => c.sha !== UNCOMMITTED_SHA)
      .sort((a, b) => a.authorTime - b.authorTime)
      .forEach((c, i) => ordinals.set(c.sha, i + 1));

    // Measure the widest label across EVERY commit in the file, not just the
    // lines currently on screen. Large files annotate a scrolling window, so a
    // window-local width made the column (and all the code) jump sideways while
    // scrolling. Every label derives from a commit, so this is the true maximum
    // and it stays constant for the file. Nothing is ever clipped.
    let widest = 0;
    for (const c of blame.commits.values()) {
      const len = formatGutter(c, opts, ordinals).length;
      if (len > widest) {
        widest = len;
      }
    }

    const labels = new Map<number, string>();
    for (let line = start; line < end; line++) {
      const commit = commitForLine(blame, line);
      if (!commit) {
        continue;
      }
      labels.set(line, formatGutter(commit, opts, ordinals));
    }
    if (widest === 0 || labels.size === 0) {
      editor.setDecorations(type, []);
      return;
    }

    const decorations: vscode.DecorationOptions[] = [];
    for (const [line, text] of labels) {
      const commit = commitForLine(blame, line);
      if (!commit) {
        continue;
      }
      const range = editor.document.lineAt(line).range;
      decorations.push({
        range: new vscode.Range(range.start, range.start),
        renderOptions: {
          before: {
            contentText: pad(text, widest),
            color: new vscode.ThemeColor("editorCodeLens.foreground"),
            backgroundColor: gutterTint(commit, opts, oldest, newest),
            // A monospace column sized to its widest entry, with a thin right
            // rule — the JetBrains "Annotate" gutter. The border rides in via
            // the textDecoration escape hatch (decoration CSS can't set it).
            width: `${widest + 1}ch`,
            margin: "0 0.8em 0 0",
            textDecoration:
              "none; border-right: 1px solid var(--vscode-panel-border); padding-right: 0.6em; white-space: pre",
          },
        },
      });
    }
    editor.setDecorations(type, decorations);
  }

  /**
   * Publish the annotation settings as context keys so the right-click submenu
   * can render a real checked/unchecked menu (VS Code has no checkbox state for
   * extension commands — you contribute two titled variants and switch them on
   * a `when` clause, which is what these keys drive).
   */
  private async syncMenuContexts(): Promise<void> {
    const opts = gutterOptions();
    const set = (key: string, value: unknown): Thenable<unknown> =>
      vscode.commands.executeCommand("setContext", key, value);
    await Promise.all([
      ...GUTTER_FIELDS.map((f) => set(`gitstudio.blame.f.${f}`, opts.fields.includes(f))),
      set("gitstudio.blame.c", opts.colors),
      set("gitstudio.blame.n", opts.nameStyle),
      set("gitstudio.blame.h", opts.showDiffOnHover),
    ]);
  }

  /** Add/remove one column, keeping the canonical column order. */
  private async toggleField(field: GutterField): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("gitstudio.blame");
    const current = gutterOptions().fields;
    const next = current.includes(field)
      ? current.filter((f) => f !== field)
      : GUTTER_FIELDS.filter((f) => f === field || current.includes(f));
    // Refuse to empty the gutter — an all-off column set renders nothing.
    if (!next.length) {
      void vscode.window.showInformationMessage(
        "GitStudio: keep at least one blame column (Revision, Date, Author, or Commit number).",
      );
      return;
    }
    await cfg.update("gutter.fields", next, vscode.ConfigurationTarget.Global);
  }

  private async setColors(mode: ColorMode): Promise<void> {
    await vscode.workspace
      .getConfiguration("gitstudio.blame")
      .update("gutter.colors", mode, vscode.ConfigurationTarget.Global);
  }

  private async setNames(style: NameStyle): Promise<void> {
    await vscode.workspace
      .getConfiguration("gitstudio.blame")
      .update("gutter.nameStyle", style, vscode.ConfigurationTarget.Global);
  }

  private async toggleHover(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("gitstudio.blame");
    await cfg.update(
      "showDiffOnHover",
      !gutterOptions().showDiffOnHover,
      vscode.ConfigurationTarget.Global,
    );
  }

  /**
   * The commit behind the cursor's line. Right-clicking moves the caret first,
   * so this is the commit of the annotation the user just clicked — the anchor
   * every action in the annotation menu works from.
   */
  private async commitAtCursor(quiet = false): Promise<
    { commit: BlameCommit; entry: RepoEntry; editor: vscode.TextEditor } | undefined
  > {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return undefined;
    }
    const entry = this.resolveFor(editor.document);
    if (!entry) {
      return undefined;
    }
    const blame = await this.getBlame(editor.document, entry);
    if (!blame) {
      return undefined;
    }
    const commit = commitForLine(blame, editor.selection.active.line);
    if (!commit || commit.sha === UNCOMMITTED_SHA) {
      if (commit && !quiet) {
        void vscode.window.showInformationMessage(
          "GitStudio: this line has uncommitted changes — there's no revision yet.",
        );
      }
      return undefined;
    }
    return { commit, entry, editor };
  }

  /**
   * Whether the blame annotation currently owns the column-0 strip of `uri`.
   *
   * Blame's `before` attachment physically occupies that strip, and its own
   * click inference reads clicks there. Anything else that wants to infer a
   * column-0 click has to yield while this is true, or one click fires two
   * unrelated actions.
   */
  public ownsGutterStrip(uri: vscode.Uri): boolean {
    return this.annotateAll || this.annotated.has(uri.toString());
  }

  /**
   * Clicking an annotation opens that commit in the Commit panel — the JetBrains
   * behaviour. VS Code gives decorations no click event, so we infer it: a MOUSE
   * selection change that lands collapsed on column 0 is a click in the gutter
   * strip our `before` attachment occupies. Only ever while annotating, and only
   * when the commit actually changes, so scrolling the caret around is free.
   */
  private onPossibleAnnotationClick(e: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.annotateAll && !this.annotated.has(e.textEditor.document.uri.toString())) {
      return;
    }
    if (e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) {
      return;
    }
    const sel = e.selections[0];
    if (!sel || !sel.isEmpty || sel.active.character !== 0) {
      return;
    }
    if (
      !vscode.workspace
        .getConfiguration("gitstudio.blame")
        .get<boolean>("clickOpensCommit", true)
    ) {
      return;
    }
    void (async () => {
      const at = await this.commitAtCursor(true);
      if (!at) {
        return;
      }
      // No dedupe here on purpose: the Commit panel owns that decision, and it
      // compares against what it is LIVE showing (a sha remembered here goes
      // stale the moment the user moves the selection inside the graph).
      await vscode.commands.executeCommand("gitstudio.revealCommitInGraph", at.commit.sha);
    })();
  }

  /** Copy the full 40-char SHA of the line's commit. */
  private async copyRevision(): Promise<void> {
    const at = await this.commitAtCursor();
    if (!at) {
      return;
    }
    await vscode.env.clipboard.writeText(at.commit.sha);
    void vscode.window.showInformationMessage(`Copied ${short(at.commit.sha)}`);
  }

  /** Diff THIS file as the line's commit changed it (parent ↔ commit). */
  private async showRevisionDiff(): Promise<void> {
    const at = await this.commitAtCursor();
    if (!at) {
      return;
    }
    const rel = relative(at.entry.root, at.editor.document.uri.fsPath);
    await openRevisionDiff(
      at.entry.root,
      rel,
      `${at.commit.sha}^`,
      at.commit.sha,
      `${rel.split("/").pop()} (${short(at.commit.sha)})`,
    );
  }

  /** Open this file's contents as of the revision BEFORE the line's commit. */
  private async openPreviousRevision(): Promise<void> {
    const at = await this.commitAtCursor();
    if (!at) {
      return;
    }
    const rel = relative(at.entry.root, at.editor.document.uri.fsPath);
    const doc = await vscode.workspace.openTextDocument(
      toRevisionUri(at.entry.root, `${at.commit.sha}^`, rel),
    );
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  /** Reveal the whole commit — message + changed files — in the bottom panel. */
  private async showCommitInPanel(): Promise<void> {
    const at = await this.commitAtCursor();
    if (!at) {
      return;
    }
    await vscode.commands.executeCommand("gitstudio.revealCommitInGraph", at.commit.sha);
  }

  /** Open the commit on its hosting site (GitHub/GitLab), when there is one. */
  private async viewRevisionInBrowser(): Promise<void> {
    const at = await this.commitAtCursor();
    if (!at) {
      return;
    }
    const remote = await at.entry.ctx.process.run(["remote", "get-url", "origin"]);
    const url = commitWebUrl(remote.stdout.trim(), at.commit.sha);
    if (!url) {
      void vscode.window.showInformationMessage(
        "GitStudio: this repo's origin isn't a recognised GitHub/GitLab remote.",
      );
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  /** Register the two titled variants (checked / unchecked) of every option. */
  private registerAnnotationMenuCommands(): void {
    const reg = (id: string, run: () => Promise<void>): void => {
      // Both variants of an entry share one handler; only the title differs.
      for (const variant of ["on", "off"]) {
        this.disposables.push(
          vscode.commands.registerCommand(`${id}.${variant}`, () =>
            run().then(() => this.syncMenuContexts()),
          ),
        );
      }
    };
    for (const f of GUTTER_FIELDS) {
      reg(`gitstudio.blame.field.${f}`, () => this.toggleField(f));
    }
    for (const c of COLOR_MODES) {
      reg(`gitstudio.blame.colors.${c}`, () => this.setColors(c));
    }
    for (const n of NAME_STYLES) {
      reg(`gitstudio.blame.names.${n}`, () => this.setNames(n));
    }
    reg("gitstudio.blame.hover", () => this.toggleHover());
  }

  /** Re-render every annotated editor (after a settings change). */
  private async refreshAllAnnotations(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (this.annotated.has(editor.document.uri.toString())) {
        await this.renderAnnotations(editor);
      }
    }
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
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          const msg = e instanceof Error ? e.message : String(e);
          this.log?.(`blame failed for ${relPath}: ${msg}`);
          console.error("[GitStudio] blame failed", e);
        }
        return undefined;
      });
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
    for (const timer of this.annotationTimers.values()) {
      clearTimeout(timer);
    }
    this.annotationTimers.clear();
    for (const cts of this.annotationCts.values()) {
      cts.cancel();
      cts.dispose();
    }
    this.annotationCts.clear();
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
    // Honour the "Show Diff On Hover" toggle (JetBrains' annotation option).
    if (!gutterOptions().showDiffOnHover) {
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

/** JetBrains-style gutter annotation: `<YYYY-MM-DD>  <author>`, padded to align. */
export type GutterField = "revision" | "date" | "author" | "commitNumber";
type NameStyle = "initials" | "lastName" | "firstName" | "fullName" | "email";
type ColorMode = "order" | "author" | "hide";

/** Canonical column order — also the order columns render in. */
const GUTTER_FIELDS: readonly GutterField[] = ["revision", "date", "author", "commitNumber"];
const COLOR_MODES: readonly ColorMode[] = ["author", "order", "hide"];
const NAME_STYLES: readonly NameStyle[] = [
  "initials",
  "lastName",
  "firstName",
  "fullName",
  "email",
];

interface GutterOptions {
  fields: GutterField[];
  nameStyle: NameStyle;
  colors: ColorMode;
  showDiffOnHover: boolean;
}

/** Read the annotation-gutter settings (JetBrains "Annotate" options). */
function gutterOptions(): GutterOptions {
  const cfg = vscode.workspace.getConfiguration("gitstudio.blame");
  const raw = cfg.get<string[]>("gutter.fields", ["date", "author"]);
  const allowed: GutterField[] = ["revision", "date", "author", "commitNumber"];
  const fields = allowed.filter((f) => raw.includes(f));
  // `heatmap` predates the tri-state colors setting, so it only supplies the
  // DEFAULT. An explicitly-chosen gutter.colors always wins — otherwise the
  // Colors picker silently did nothing whenever heatmap was false.
  const inspected = cfg.inspect<ColorMode>("gutter.colors");
  const explicitColors =
    inspected?.workspaceFolderValue ?? inspected?.workspaceValue ?? inspected?.globalValue;
  const colors: ColorMode =
    explicitColors ?? (cfg.get<boolean>("heatmap", true) ? "order" : "hide");

  return {
    fields: fields.length ? fields : ["date", "author"],
    nameStyle: cfg.get<NameStyle>("gutter.nameStyle", "fullName"),
    colors,
    showDiffOnHover: cfg.get<boolean>("showDiffOnHover", true),
  };
}

/** Author name in the configured style — never truncated. */
function formatName(commit: BlameCommit, style: NameStyle): string {
  const full = (commit.author || "").trim();
  const parts = full.split(/\s+/).filter(Boolean);
  switch (style) {
    case "initials":
      return parts.map((p) => p[0]?.toUpperCase() ?? "").join("").slice(0, 3) || "?";
    case "firstName":
      return parts[0] ?? full;
    case "lastName":
      return parts.length > 1 ? parts[parts.length - 1] : full;
    case "email":
      return commit.authorMail || full;
    default:
      return full;
  }
}

/** One gutter label, built from the enabled columns. */
function formatGutter(
  commit: BlameCommit,
  opts: GutterOptions,
  ordinals: Map<string, number>,
): string {
  if (commit.sha === UNCOMMITTED_SHA) {
    return "Uncommitted";
  }
  const parts: string[] = [];
  for (const field of opts.fields) {
    if (field === "revision") {
      parts.push(short(commit.sha));
    } else if (field === "date") {
      parts.push(isoDate(commit.authorTime));
    } else if (field === "author") {
      parts.push(formatName(commit, opts.nameStyle));
    } else if (field === "commitNumber") {
      parts.push(`#${ordinals.get(commit.sha) ?? "?"}`);
    }
  }
  return parts.join("  ");
}

/** The row tint for the configured color mode. */
function gutterTint(
  commit: BlameCommit,
  opts: GutterOptions,
  oldest: number,
  newest: number,
): string | undefined {
  if (opts.colors === "hide" || commit.sha === UNCOMMITTED_SHA) {
    return undefined;
  }
  if (opts.colors === "author") {
    return authorColor(commit.authorMail || commit.author);
  }
  return heatColor(commit.authorTime, oldest, newest);
}

/** A stable, low-alpha tint per author (JetBrains' "Colors → Author"). */
function authorColor(key: string): string {
  let h = 7;
  for (const ch of key) {
    h = (h * 31 + ch.charCodeAt(0)) % 360;
  }
  return `hsla(${h}, 70%, 55%, 0.14)`;
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

function authorShort(author: string, max = 12): string {
  // First name keeps the column tidy when the full name is long.
  const first = author.split(/\s+/)[0] ?? author;
  const base = first.length <= max ? author : first;
  return base.length > max ? `${base.slice(0, max - 1)}…` : base;
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
