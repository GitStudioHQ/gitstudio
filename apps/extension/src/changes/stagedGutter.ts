import * as vscode from "vscode";
import { stat } from "node:fs/promises";
import {
  changeBlocksFrom,
  isStageableText,
  readBaselines,
  setBlockStaged,
} from "@gitstudio/git-service/blockStaging";
import type { Baselines, ChangeBlock } from "@gitstudio/git-service/blockStaging";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativePath } from "./changesView";
import { blockAtLine } from "./blockAtLine";
import { touches } from "../git/repoChange";
import * as l10n from "@vscode/l10n";

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
 * gutter — as a dot (grey: unstaged, half amber: partly staged, green: staged),
 * never as a checkbox. The marks were checkboxes once, and in VS Code's diff
 * editor that read as a column of controls that did nothing when clicked (#87,
 * reopened); a mark that can only report must not look like a control
 * (test/stagedGutterGlyphs.test.ts). Then give ways to change the state that
 * do not need a clickable glyph — a HOVER on the changed lines with Stage /
 * Unstage links (editorStagingActions.ts; in the text editor, a hover link is
 * the one plain click that reaches an extension), an opt-in CodeLens, a
 * keybinding, the line-number context menu, and the Changes list. Anyone who
 * wants the tick itself is one command away from our own diff page, where the
 * gutter is ours and the tick is real.
 *
 * The line-number menu is also what a RIGHT-click on the glyph opens (VS Code
 * opens it for the glyph margin too), so "right-click the mark" works — in a
 * diff editor as well, which is where the marks are most often seen: #87 found
 * the menu's item hidden there, because VS Code's scmActiveResourceHasChanges is
 * false in every diff editor. The menu gates live in package.json and are
 * pinned in test/editorMenus.test.ts.
 *
 * The point of this half is that a user who never leaves VS Code's diff still
 * SEES what is staged, and keeps their keybindings, their other extensions'
 * decorations, their find widget and their diff settings while doing it.
 */

type State = "staged" | "unstaged" | "partial";

/** The settings that decide whether blocks are read, and whether marks are drawn. */
const WATCHED_SETTINGS = [
  "gitstudio.staging.showGutterState",
  "gitstudio.staging.hoverActions",
  "gitstudio.staging.codeLens",
];

function readShowMarks(): boolean {
  return vscode.workspace.getConfiguration("gitstudio").get<boolean>("staging.showGutterState", true) !== false;
}

/** Whether anything needs the blocks: the marks, the hover (on by default) or the CodeLens (off). */
function readEnabled(): boolean {
  const config = vscode.workspace.getConfiguration("gitstudio");
  return (
    readShowMarks() ||
    config.get<boolean>("staging.hoverActions", true) !== false ||
    config.get<boolean>("staging.codeLens", false) === true
  );
}

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
  /**
   * What git said about each document when it was last read: whether it is
   * conflicted, and its HEAD and index text. An EDIT moves neither, so a
   * refresh caused only by typing diffs the buffer against these instead of
   * spawning `git status` and two `git show`s per pause in typing (#115).
   * Every other cause — focus, save, a ref or index move, a toggle — reads git
   * again and replaces the entry.
   */
  private readonly baselines = new Map<string, { conflicted: boolean; baselines: Baselines }>();
  /** Documents whose next scheduled refresh must read git, not reuse `baselines`. */
  private readonly readGit = new Set<string>();
  /** Documents with a scheduled refresh running now; a timer that fires meanwhile waits for it. */
  private readonly running = new Map<string, Promise<void>>();
  /** The document version each document's marks were last painted for. */
  private readonly paintedVersion = new Map<string, number>();
  /** Whether the marks are drawn (`staging.showGutterState`). */
  private showMarks: boolean;
  /**
   * Whether the blocks are read at all: for the marks, or for the hover and the
   * CodeLens, which act on the same blocks (any of the three settings).
   */
  private enabled: boolean;
  private readonly refreshed = new vscode.EventEmitter<vscode.Uri>();
  /** A document's blocks were re-read (or dropped) — the CodeLens repaints on it. */
  readonly onDidRefresh = this.refreshed.event;

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

    this.showMarks = readShowMarks();
    this.enabled = readEnabled();

    this.disposables.push(
      this.refreshed,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) void this.schedule(editor.document, 0);
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        // Typing: same HEAD, same index — re-diff, do not re-read git.
        void this.schedule(event.document, REFRESH_DEBOUNCE_MS, false);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => this.forget(doc.uri.toString())),
      vscode.workspace.onDidSaveTextDocument((doc) => void this.schedule(doc, 0)),
      vscode.window.onDidChangeTextEditorSelection((event) =>
        this.onPossibleGutterClick(event),
      ),
      // The index moved under us — a stage from VS Code's own Source Control
      // view or diff gutter, a terminal, another tool. Without this the marks
      // kept the state they were painted with until the file was edited or
      // re-focused, and a toggle read that stale state (#87).
      //
      // A working-tree event is vscode.git's status run — every save, every
      // window focus — and mostly the index did not move: repaint only when
      // the index FILE did (refreshIfIndexMoved). A ref or operation change
      // moves HEAD, which the marks are measured against, so it always repaints.
      repos.onDidChange((event) => {
        if (touches(event, "refs", "operation")) this.refreshAll();
        else if (touches(event, "workingTree")) void this.refreshIfIndexMoved();
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (!WATCHED_SETTINGS.some((key) => event.affectsConfiguration(key))) return;
        this.showMarks = readShowMarks();
        this.enabled = readEnabled();
        this.refreshAll();
      }),
    );

    this.refreshAll();
  }

  /** Each repository's index file (`git rev-parse --git-path index`), looked up once. */
  private readonly indexFiles = new Map<string, Promise<string | undefined>>();
  /** What each repository's index file was when its marks were last repainted for it. */
  private readonly indexSeen = new Map<string, string>();

  /**
   * Repaints the visible editors of every repository whose index file changed
   * since the last look — one stat per repository, no git process. git rewrites
   * the index through a lock file, so every write is a new file (inode) as well
   * as a new time. When the file cannot be found or read, it repaints.
   */
  private async refreshIfIndexMoved(): Promise<void> {
    const byRepo = new Map<string, { entry: RepoEntry; documents: vscode.TextDocument[] }>();
    for (const editor of vscode.window.visibleTextEditors) {
      const target = this.resolve(editor.document.uri);
      if (!target) continue;
      const group = byRepo.get(target.entry.root) ?? { entry: target.entry, documents: [] };
      group.documents.push(editor.document);
      byRepo.set(target.entry.root, group);
    }
    for (const [root, { entry, documents }] of byRepo) {
      const seen = await this.indexIdentity(entry);
      if (seen !== undefined && seen === this.indexSeen.get(root)) continue;
      if (seen !== undefined) this.indexSeen.set(root, seen);
      for (const document of documents) this.schedule(document, 0);
    }
  }

  private async indexIdentity(entry: RepoEntry): Promise<string | undefined> {
    let file = this.indexFiles.get(entry.root);
    if (!file) {
      file = entry.ctx.operation.gitPath("index").catch(() => undefined);
      this.indexFiles.set(entry.root, file);
    }
    const path = await file;
    if (!path) return undefined;
    try {
      const st = await stat(path);
      return `${st.ino}:${st.size}:${st.mtimeMs}`;
    } catch {
      return "no index";
    }
  }

  /** Re-reads git for every visible editor — after a commit, stage, or setting change. */
  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      void this.schedule(editor.document, 0);
    }
  }

  /**
   * Refreshes `document` after `delay`, coalescing: a newer call replaces a
   * pending one, and a refresh never starts while the last one for the same
   * document is still running — it runs once that one is done. `readGit`
   * false means only the buffer changed; any true call before the refresh
   * runs makes it read git.
   */
  private schedule(document: vscode.TextDocument, delay: number, readGit = true): void {
    if (document.uri.scheme !== "file") return;
    const key = document.uri.toString();
    if (readGit) this.readGit.add(key);
    const existing = this.timers.get(key);
    if (existing) clearTimeout(existing);
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.runScheduled(document);
      }, delay),
    );
  }

  private async runScheduled(document: vscode.TextDocument): Promise<void> {
    const key = document.uri.toString();
    const inFlight = this.running.get(key);
    if (inFlight) {
      // Run once it is done — unless something newer has been scheduled by then.
      await inFlight;
      if (this.timers.has(key) || this.running.has(key)) return;
    }
    const readGit = this.readGit.delete(key) || !this.baselines.has(key);
    // Only the buffer could have changed, and it has not: nothing to redo.
    if (!readGit && typeof document.version === "number" && this.paintedVersion.get(key) === document.version) {
      return;
    }
    const run = this.refresh(document, !readGit).finally(() => {
      if (this.running.get(key) === run) this.running.delete(key);
    });
    this.running.set(key, run);
    await run;
  }

  private async refresh(document: vscode.TextDocument, reuseBaselines = false): Promise<void> {
    const key = document.uri.toString();
    const gen = (this.generation.get(key) ?? 0) + 1;
    this.generation.set(key, gen);

    const target = this.resolve(document.uri);
    if (!target || !this.enabled) {
      this.blocksByDoc.delete(key);
      this.baselines.delete(key);
      this.paintedVersion.delete(key);
      this.paint(document, []);
      this.refreshed.fire(document.uri);
      return;
    }

    const version = document.version;
    const blocks = await this.readBlocks(target, document, reuseBaselines);
    // A newer refresh started while git was answering; its answer wins.
    if (this.generation.get(key) !== gen) return;

    this.blocksByDoc.set(key, blocks);
    if (typeof version === "number") this.paintedVersion.set(key, version);
    else this.paintedVersion.delete(key);
    this.paint(document, this.showMarks ? blocks : []);
    this.refreshed.fire(document.uri);
  }

  /**
   * The change blocks last read for `uri`, or undefined when none have been —
   * what the hover and the CodeLens offer actions for. They never read git
   * themselves (a hover must answer at once); the action does, see setAtLine.
   */
  blocksFor(uri: vscode.Uri): readonly ChangeBlock[] | undefined {
    return this.blocksByDoc.get(uri.toString());
  }

  private forget(key: string): void {
    const timer = this.timers.get(key);
    if (timer) clearTimeout(timer);
    this.timers.delete(key);
    this.blocksByDoc.delete(key);
    this.baselines.delete(key);
    this.readGit.delete(key);
    this.paintedVersion.delete(key);
    this.generation.delete(key);
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
   * Toggle by clicking the start of a change's line — OFF by default, and
   * deliberately so.
   *
   * VS Code gives decorations no click event, so this is an inference: a MOUSE
   * selection change that lands collapsed on column 0. The same trick blame
   * already ships. Note what it can NOT see: a click on the glyph itself. Monaco
   * swallows a left click in the glyph margin without moving the caret
   * (verified in VS Code 1.140 for #87), so no selection event arrives and the
   * glyph stays unclickable with this setting on too — the
   * gesture that works is a click at the very start of the text. It cannot be
   * told apart from someone genuinely putting their caret at the start of a
   * line — which is a thing people do constantly — so staging a change on that
   * gesture is only defensible when the user has asked for it.
   *
   * Two guards beyond the setting: the line must actually carry a change, and
   * blame must not be annotating, since its `before` attachment physically owns
   * that strip and reads the same gesture.
   */
  private onPossibleGutterClick(event: vscode.TextEditorSelectionChangeEvent): void {
    if (!this.showMarks) return;
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
    await this.setAtLine(document, line);
  }

  /**
   * Stages (`staged` true) or unstages the change at `line` (0-based) — or,
   * with `staged` undefined, toggles it as the line-number menu does. One
   * engine for every door — the menu, the keybinding, the hover, the
   * CodeLens — so each leaves the index exactly as the others would.
   */
  async setAtLine(document: vscode.TextDocument, line: number, staged?: boolean): Promise<void> {
    const target = this.resolve(document.uri);
    if (!target) {
      void vscode.window.showInformationMessage(
        l10n.t("GitStudio: this file is not inside an open Git repository."),
      );
      return;
    }
    // Read git afresh rather than trusting what was last painted: the index
    // may have moved since (see the onDidChange subscription), and the cached
    // state decides the DIRECTION — a change staged elsewhere but still
    // painted unstaged was "staged" again, which does nothing, and the toggle
    // looked dead (seen in VS Code for #87).
    const blocks = await this.readBlocks(target, document);

    const block = blockAtLine(blocks, line);
    if (!block) {
      void vscode.window.setStatusBarMessage(
        l10n.t("$(info) GitStudio: no change on this line to stage"),
        2500,
      );
      return;
    }

    // Toggling a partial block stages the remainder; unstaging it would discard
    // work the user staged earlier, which is the more surprising direction.
    const result = await setBlockStaged(
      target.entry.ctx,
      target.rel,
      document.getText(),
      block,
      staged ?? block.state !== "staged",
    );
    if (!result.ok) {
      void vscode.window.setStatusBarMessage(l10n.t("$(info) GitStudio: {0}", result.stderr), 4000);
    }
    await this.refresh(document);
  }

  /** setAtLine for the document `uri` names — open already, or opened now. */
  async toggleAtUri(uri: vscode.Uri, line: number, staged?: boolean): Promise<void> {
    let document: vscode.TextDocument;
    try {
      document = await vscode.workspace.openTextDocument(uri);
    } catch {
      return;
    }
    await this.setAtLine(document, line, staged);
  }

  /**
   * The document's change blocks as git has them NOW; none for a conflicted
   * file. `reuseBaselines`: git was read for this document since anything but
   * its text changed, so diff the text against what it said then.
   */
  private async readBlocks(
    target: { entry: RepoEntry; rel: string },
    document: vscode.TextDocument,
    reuseBaselines = false,
  ): Promise<ChangeBlock[]> {
    const key = document.uri.toString();
    // Binary or huge: no ticks, and no reason to ask git anything.
    if (!isStageableText(document.getText())) return [];
    try {
      let known = reuseBaselines ? this.baselines.get(key) : undefined;
      if (!known) {
        // A conflicted file has no stage-0 index entry, so the tick model would
        // read every change as unstaged. Say nothing rather than something wrong.
        const conflicted = await target.entry.ctx.conflict.isConflicted(target.rel);
        const baselines = conflicted
          ? { head: "", index: "" }
          : await readBaselines(target.entry.ctx, target.rel);
        known = { conflicted, baselines };
        this.baselines.set(key, known);
      }
      // The text as it is now, after git answered — not as it was when asked.
      return known.conflicted ? [] : changeBlocksFrom(known.baselines, document.getText());
    } catch {
      this.baselines.delete(key);
      return [];
    }
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
    this.baselines.clear();
    for (const decoration of this.decorations.values()) decoration.dispose();
    this.decorations.clear();
    for (const disposable of this.disposables) disposable.dispose();
    this.disposables.length = 0;
  }
}
