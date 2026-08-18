import * as vscode from "vscode";
import { listChangeBlocks, setBlockStaged } from "@gitstudio/git-service/blockStaging";
import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativePath } from "./changesView";
import { blockAtLine } from "./blockAtLine";

/**
 * Staging state in VS Code's OWN editor gutter.
 *
 * The honest limitation, stated once: a VS Code extension cannot put a
 * CLICKABLE tick in a native gutter. `TextEditorDecorationType` exposes only
 * `key` and `dispose()`, `DecorationOptions` carries no command, and
 * `gutterIconPath` is a bare URI with no click and no hover. The API that is
 * exactly this feature — `diffEditor/gutter/hunk` — is proposed-only and cannot
 * ship on the Marketplace.
 *
 * What CAN be done, and is done here: show the state truthfully in the real
 * gutter, and give three ways to change it that do not need a clickable glyph —
 * a keybinding, the line-number context menu, and the Changes list. Anyone who
 * wants the tick itself is one command away from our own diff page, where the
 * gutter is ours and the tick is real.
 *
 * The point of this half is that a user who never leaves VS Code's diff still
 * SEES what is staged, and keeps their keybindings, their other extensions'
 * decorations, their find widget and their diff settings while doing it.
 */

type State = "staged" | "unstaged" | "partial";

const STATES: readonly State[] = ["staged", "unstaged", "partial"];

/** How long to wait after an edit before re-reading git for this document. */
const REFRESH_DEBOUNCE_MS = 300;

export class StagedGutter implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly decorations = new Map<State, vscode.TextEditorDecorationType>();
  /** Per-document debounce timers, so typing does not spawn a git read per key. */
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * The blocks last computed per document, so a toggle command knows which
   * change the cursor is in without re-deriving it.
   */
  private readonly blocksByDoc = new Map<string, ChangeBlock[]>();
  /**
   * Bumped on every refresh for a document. A refresh that finishes after a
   * newer one started must not paint — the stale-write class of bug this
   * codebase keeps hitting.
   */
  private readonly generation = new Map<string, number>();
  private enabled: boolean;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly repos: RepoManager,
    /**
     * Whether the blame annotation owns column 0 of a document. Blame's own
     * click inference reads that strip, so ours yields while it is annotating —
     * otherwise one click both opens a commit and stages a change.
     */
    private readonly blameOwnsStrip: (uri: vscode.Uri) => boolean = () => false,
  ) {
    for (const state of STATES) {
      this.decorations.set(
        state,
        vscode.window.createTextEditorDecorationType({
          gutterIconPath: vscode.Uri.joinPath(
            context.extensionUri,
            "media",
            "staging",
            `${state}.svg`,
          ),
          gutterIconSize: "contain",
          // The glyph belongs to the line, and must survive edits above it
          // without smearing onto neighbours.
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
          overviewRulerLane: vscode.OverviewRulerLane.Left,
        }),
      );
    }

    this.enabled = vscode.workspace
      .getConfiguration("gitstudio")
      .get<boolean>("staging.showGutterState", true);

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) void this.schedule(editor.document, 0);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        void this.schedule(event.document, REFRESH_DEBOUNCE_MS);
      }),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.schedule(doc, 0)),
      vscode.window.onDidChangeTextEditorSelection((event) =>
        this.onPossibleGutterClick(event),
      ),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!event.affectsConfiguration("gitstudio.staging.showGutterState")) return;
        this.enabled = vscode.workspace
          .getConfiguration("gitstudio")
          .get<boolean>("staging.showGutterState", true);
        this.refreshAll();
      }),
    );

    this.refreshAll();
  }

  /** Re-reads git for every visible editor — after a commit, stage, or setting change. */
  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      void this.schedule(editor.document, 0);
    }
  }

  private schedule(document: vscode.TextDocument, delay: number): void {
    if (document.uri.scheme !== "file") return;
    const key = document.uri.toString();
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.refresh(document);
      }, delay),
    );
  }

  private async refresh(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const gen = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, gen);

    const target = this.resolve(document.uri);
    if (!target || !this.enabled) {
      this.blocksByDoc.delete(key);
      this.paint(document, []);
      return;
    }

    let blocks: ChangeBlock[] = [];
    try {
      // A conflicted file has no stage-0 index entry, so the tick model would
      // read every change as unstaged. Say nothing rather than something wrong.
      const conflicted = await target.entry.ctx.conflict.isConflicted(target.rel);
      blocks = conflicted
        ? []
        : await listChangeBlocks(target.entry.ctx, target.rel, document.getText());
    } catch {
      blocks = [];
    }
    // A newer refresh started while git was answering; its answer wins.
    if (this.generation.get(key) !== gen) return;

    this.blocksByDoc.set(key, blocks);
    this.paint(document, blocks);
  }

  private paint(document: vscode.TextDocument, blocks: ChangeBlock[]): void {
    const editors = vscode.window.visibleTextEditors.filter(
      (e) => e.document.uri.toString() === document.uri.toString(),
    );
    if (editors.length === 0) return;

    const ranges = new Map<State, vscode.Range[]>();
    for (const state of STATES) ranges.set(state, []);

    const lastLine = Math.max(0, document.lineCount - 1);
    for (const block of blocks) {
      // The glyph marks the change's FIRST line. A pure deletion has a
      // zero-width working span, whose `start` is still the line the deletion
      // sits above — so it is marked rather than skipped.
      const line = Math.min(Math.max(0, block.working.start), lastLine);
      ranges.get(block.state)?.push(new vscode.Range(line, 0, line, 0));
    }

    for (const editor of editors) {
      for (const state of STATES) {
        const decoration = this.decorations.get(state);
        if (decoration) editor.setDecorations(decoration, ranges.get(state) ?? []);
      }
    }
  }

  /**
   * Toggle by clicking the gutter strip — OFF by default, and deliberately so.
   *
   * VS Code gives decorations no click event, so this is an inference: a MOUSE
   * selection change that lands collapsed on column 0 is treated as a click on
   * the strip our glyph occupies. The same trick blame already ships. It works,
   * but it cannot be told apart from someone genuinely putting their caret at
   * the start of a line — which is a thing people do constantly — so staging a
   * change on that gesture is only defensible when the user has asked for it.
   *
   * Two guards beyond the setting: the line must actually carry a change, and
   * blame must not be annotating, since its `before` attachment physically owns
   * that strip and reads the same gesture.
   */
  private onPossibleGutterClick(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.enabled) return;
    if (event.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;

    const selection = event.selections[0];
    if (!selection || !selection.isEmpty || selection.active.character !== 0) return;

    const document = event.textEditor.document;
    if (document.uri.scheme !== "file") return;
    if (this.blameOwnsStrip(document.uri)) return;

    if (
      !vscode.workspace
        .getConfiguration("gitstudio.staging")
        .get<boolean>("clickGutterToggles", false)
    ) {
      return;
    }

    // Only act where there is genuinely a change; a click at column 0 of an
    // unchanged line must stay an ordinary caret move.
    const blocks = this.blocksByDoc.get(document.uri.toString());
    if (!blocks || !blockAtLine(blocks, selection.active.line)) return;

    void this.toggleAtLine(document, selection.active.line);
  }

  /**
   * Toggles the change at `line` (0-based), or the one the cursor is in.
   *
   * `line` arrives from the line-number context menu, which hands over
   * `{ lineNumber, uri }` with a 1-BASED line. Everything else here is 0-based,
   * so the conversion happens at the command boundary and nowhere else.
   */
  async toggleAtLine(document: vscode.TextDocument, line: number): Promise<void> {
    const target = this.resolve(document.uri);
    if (!target) {
      void vscode.window.showInformationMessage(
        "GitStudio: this file is not inside an open Git repository.",
      );
      return;
    }
    const key = document.uri.toString();
    const blocks =
      this.blocksByDoc.get(key) ??
      (await listChangeBlocks(target.entry.ctx, target.rel, document.getText()));

    const block = blockAtLine(blocks, line);
    if (!block) {
      void vscode.window.setStatusBarMessage(
        "$(info) GitStudio: no change on this line to stage",
        2500,
      );
      return;
    }

    // A partial block stages the remainder; unstaging it would discard work the
    // user staged earlier, which is the more surprising direction.
    const staged = block.state !== "staged";
    const result = await setBlockStaged(
      target.entry.ctx,
      target.rel,
      document.getText(),
      block,
      staged,
    );
    if (!result.ok) {
      void vscode.window.setStatusBarMessage(`$(info) GitStudio: ${result.stderr}`, 4000);
    }
    await this.refresh(document);
  }

  private resolve(uri: vscode.Uri): { entry: RepoEntry; rel: string } | undefined {
    if (uri.scheme !== "file") return undefined;
    const norm = uri.fsPath.replace(/\\/g, "/");
    let best: RepoEntry | undefined;
    for (const entry of this.repos.getAll()) {
      const root = entry.root.replace(/\\/g, "/").replace(/\/+$/, "");
      if (norm === root || norm.startsWith(root + "/")) {
        if (!best || entry.root.length > best.root.length) best = entry;
      }
    }
    if (!best) return undefined;
    return { entry: best, rel: relativePath(best.root, uri.fsPath) };
  }

  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const decoration of this.decorations.values()) decoration.dispose();
    this.decorations.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
