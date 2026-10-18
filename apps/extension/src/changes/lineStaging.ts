import * as vscode from "vscode";
import { computeHunks, type LineRange } from "@gitstudio/engine/staging/applyLineChanges";
import {
  stageHunks,
  stageSelection,
  unstageHunks,
  unstageSelection,
  type SelectionWrite,
} from "@gitstudio/engine/staging/selectionStaging";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativePath } from "./changesView";
import { selectionLines } from "./lineTargets";
import { failed } from "../ui/notify";
import * as l10n from "@vscode/l10n";

// Line / hunk staging commands — the headline differentiator. These operate on
// the active editor (a working file, or the modified side of a diff editor): the
// user's selection (or the hunk under the cursor) is reconstructed against the
// staged/working baseline and written to the index via the engine's pure
// applySelectedChanges + git-service's content staging. After each op we refresh
// the views and invalidate open index/HEAD diffs.

/** What a staging command needs from the host after refreshing the index. */
export interface StagingRefresh {
  refresh(): void;
}

/**
 * Resolves the active editor to a (repo, relPath, document) triple, or shows a
 * gentle message and returns undefined. Works for a plain file editor and for
 * the modified side of a diff editor (both expose a `file:` document).
 */
function resolveTarget(
  repos: RepoManager,
  editor: vscode.TextEditor | undefined = vscode.window.activeTextEditor,
): { entry: RepoEntry; rel: string; doc: vscode.TextDocument } | undefined {
  if (!editor || editor.document.uri.scheme !== "file") {
    void vscode.window.showInformationMessage(
      l10n.t("GitStudio: open a file in a Git repository to stage lines."),
    );
    return undefined;
  }
  const entry = repoForFile(repos, editor.document.uri.fsPath);
  if (!entry) {
    void vscode.window.showInformationMessage(
      l10n.t("GitStudio: this file is not inside an open Git repository."),
    );
    return undefined;
  }
  const rel = relativePath(entry.root, editor.document.uri.fsPath);
  return { entry, rel, doc: editor.document };
}

/** Finds the open repo whose root contains `fsPath` (longest match wins). */
function repoForFile(repos: RepoManager, fsPath: string): RepoEntry | undefined {
  const norm = fsPath.replace(/\\/g, "/");
  let best: RepoEntry | undefined;
  for (const entry of repos.getAll()) {
    const root = entry.root.replace(/\\/g, "/").replace(/\/+$/, "");
    if (norm === root || norm.startsWith(root + "/")) {
      if (!best || entry.root.length > best.root.length) {
        best = entry;
      }
    }
  }
  return best;
}

/** The editor's selections as 0-based inclusive line ranges (document coords), boundaries included. */
function selectionRanges(editor: vscode.TextEditor): LineRange[] {
  const doc = editor.document;
  const last = doc.lineCount - 1;
  return selectionLines(editor.selections, { line: last, character: doc.lineAt(last).text.length });
}

/** Each cursor's line (document coords). */
function cursorLines(editor: vscode.TextEditor): number[] {
  return editor.selections.map((s) => s.active.line);
}

/**
 * Stage the selected lines of the active editor. `original` is the staged
 * (index) version — falling back to HEAD, then to "" for a brand-new file — and
 * `modified` is the live document text, so unsaved edits are honored.
 */
export async function stageSelectedLines(
  repos: RepoManager,
  refresh: StagingRefresh,
  /** The editor whose selection to stage; the active one when not given (the palette, a key). */
  inEditor?: vscode.TextEditor,
): Promise<void> {
  const target = resolveTarget(repos, inEditor ?? vscode.window.activeTextEditor);
  if (!target) {
    return;
  }
  const editor = inEditor ?? vscode.window.activeTextEditor!;
  const ranges = selectionRanges(editor);
  await stageRangesAgainstIndex(target.entry, target.rel, target.doc, ranges, refresh);
}

/**
 * Stage the hunk(s) the cursor(s) currently sit in, whole (stageHunks) — a
 * deletion counting as the line it sits above.
 */
export async function stageHunk(
  repos: RepoManager,
  refresh: StagingRefresh,
): Promise<void> {
  const target = resolveTarget(repos);
  if (!target) {
    return;
  }
  const editor = vscode.window.activeTextEditor!;
  const original = await baselineForStaging(target.entry, target.rel);
  const staged = stageHunks(original, target.doc.getText(), cursorLines(editor));
  if (!staged) {
    void vscode.window.setStatusBarMessage(
      l10n.t("$(info) GitStudio: no change under the cursor to stage"),
      2500,
    );
    return;
  }
  await commitStage(target.entry, target.rel, staged.content, staged.changes, refresh);
}

/** Shared: reconstruct `ranges` against the index baseline and stage. */
async function stageRangesAgainstIndex(
  entry: RepoEntry,
  rel: string,
  doc: vscode.TextDocument,
  ranges: LineRange[],
  refresh: StagingRefresh,
): Promise<void> {
  const original = await baselineForStaging(entry, rel);
  const staged = stageSelection(original, doc.getText(), ranges);
  if (!staged) {
    void vscode.window.setStatusBarMessage(
      l10n.t("$(info) GitStudio: nothing to stage in the selection"),
      2500,
    );
    return;
  }
  await commitStage(entry, rel, staged.content, staged.changes, refresh);
}

/**
 * Unstage the selected lines / hunk under the cursor. We reconstruct the index
 * WITHOUT the selected change: baseline = HEAD, target = current index, and we
 * apply every staged hunk EXCEPT the ones the selection covers. The result
 * becomes the new index content.
 *
 * The selection is numbered like the document — the working tree — and is
 * carried into index numbering before it is matched (see unstageSelection). It
 * used to be matched as if it were already index lines, so on a file with an
 * unstaged edit above the selection it rolled back a different staged change
 * than the one selected.
 */
export async function unstageSelectedLines(
  repos: RepoManager,
  refresh: StagingRefresh,
  /** The editor whose selection to unstage; the active one when not given. */
  inEditor?: vscode.TextEditor,
): Promise<void> {
  await unstageLines(
    repos,
    refresh,
    (head, index, working, editor) => unstageSelection(head, index, working, selectionRanges(editor)),
    inEditor,
  );
}

/** Unstage the staged change(s) under the cursor(s), whole (unstageHunks). */
export async function unstageHunk(
  repos: RepoManager,
  refresh: StagingRefresh,
): Promise<void> {
  await unstageLines(repos, refresh, (head, index, working, editor) =>
    unstageHunks(head, index, working, cursorLines(editor)),
  );
}

/** Core unstage: write what `unstage` makes of HEAD, the index and the document. */
async function unstageLines(
  repos: RepoManager,
  refresh: StagingRefresh,
  unstage: (
    head: string,
    index: string,
    working: string,
    editor: vscode.TextEditor,
  ) => SelectionWrite | undefined,
  inEditor?: vscode.TextEditor,
): Promise<void> {
  const target = resolveTarget(repos, inEditor ?? vscode.window.activeTextEditor);
  if (!target) {
    return;
  }
  const editor = inEditor ?? vscode.window.activeTextEditor!;
  const head = await target.entry.ctx.staging.headContent(target.rel);
  const index = await target.entry.ctx.staging.indexContent(target.rel);
  if (computeHunks(head, index).length === 0) {
    void vscode.window.setStatusBarMessage(
      l10n.t("$(info) GitStudio: nothing staged to unstage here"),
      2500,
    );
    return;
  }
  const unstaged = unstage(head, index, target.doc.getText(), editor);
  if (!unstaged) {
    void vscode.window.setStatusBarMessage(
      l10n.t("$(info) GitStudio: no staged change selected to unstage"),
      2500,
    );
    return;
  }
  // Rolling the last staged change of an ADDED file back to HEAD leaves "" —
  // and writing that would stage an empty file for addition instead of
  // removing the entry. Dropping the entry is what `git reset` does here.
  const result =
    unstaged.content === "" && head === ""
      ? await target.entry.ctx.staging.unstageFile(target.rel)
      : await target.entry.ctx.staging.stageContent(target.rel, unstaged.content);
  finishStaging(result.ok, result.stderr, l10n.t("Unstaged selection"), refresh);
}

/**
 * The baseline used when STAGING: the staged (index) version if the file is
 * tracked there, else HEAD, else "" (a brand-new file). Staging selected lines
 * means "make the index look like this for the selected hunks", so the index is
 * the right baseline to layer the selection onto.
 */
async function baselineForStaging(entry: RepoEntry, rel: string): Promise<string> {
  const indexed = await entry.ctx.staging.indexContent(rel);
  if (indexed !== "") {
    return indexed;
  }
  return entry.ctx.staging.headContent(rel);
}

/** Stage reconstructed `content`, then report + refresh. */
async function commitStage(
  entry: RepoEntry,
  rel: string,
  content: string,
  hunkCount: number,
  refresh: StagingRefresh,
): Promise<void> {
  const result = await entry.ctx.staging.stageContent(rel, content);
  const label =
    hunkCount === 1 ? l10n.t("Staged 1 change") : l10n.t("Staged {0} changes", hunkCount);
  finishStaging(result.ok, result.stderr, label, refresh);
}

function finishStaging(
  ok: boolean,
  stderr: string,
  label: string,
  refresh: StagingRefresh,
): void {
  if (!ok) {
    void vscode.window.showErrorMessage(failed(l10n.t("Staging"), stderr));
    return;
  }
  void vscode.window.setStatusBarMessage(l10n.t("$(check) {0}", label), 2500);
  refresh.refresh();
}
