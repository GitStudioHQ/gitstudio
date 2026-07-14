import * as vscode from "vscode";
import {
  applySelectedChanges,
  computeHunks,
  type LineRange,
} from "@gitstudio/engine/staging/applyLineChanges";
import type { RepoManager, RepoEntry } from "../git/repoManager";
import { relativePath } from "./changesView";

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
): { entry: RepoEntry; rel: string; doc: vscode.TextDocument } | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== "file") {
    void vscode.window.showInformationMessage(
      "GitStudio: open a file in a Git repository to stage lines.",
    );
    return undefined;
  }
  const entry = repoForFile(repos, editor.document.uri.fsPath);
  if (!entry) {
    void vscode.window.showInformationMessage(
      "GitStudio: this file is not inside an open Git repository.",
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

/** The editor's selections as 0-based inclusive line ranges (document coords). */
function selectionRanges(editor: vscode.TextEditor): LineRange[] {
  return editor.selections.map((sel) => ({
    start: sel.start.line,
    end: sel.end.line,
  }));
}

/**
 * Stage the selected lines of the active editor. `original` is the staged
 * (index) version — falling back to HEAD, then to "" for a brand-new file — and
 * `modified` is the live document text, so unsaved edits are honored.
 */
export async function stageSelectedLines(
  repos: RepoManager,
  refresh: StagingRefresh,
): Promise<void> {
  const target = resolveTarget(repos);
  if (!target) {
    return;
  }
  const editor = vscode.window.activeTextEditor!;
  const ranges = selectionRanges(editor);
  await stageRangesAgainstIndex(target.entry, target.rel, target.doc, ranges, refresh);
}

/**
 * Stage the hunk(s) the cursor(s) currently sit in. Computes the hunks between
 * the index baseline and the document, then selects those whose modified span
 * contains a cursor line.
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
  const modified = target.doc.getText();
  const hunks = computeHunks(original, modified);
  const cursorLines = editor.selections.map((s) => s.active.line);
  const picked = hunks
    .filter((h) =>
      cursorLines.some((line) => line >= h.modified.start && line <= h.modified.end),
    )
    .map((h) => h.modified);

  if (picked.length === 0) {
    void vscode.window.setStatusBarMessage(
      "$(info) GitStudio: no change under the cursor to stage",
      2500,
    );
    return;
  }
  const content = applySelectedChanges(original, modified, picked);
  await commitStage(target.entry, target.rel, content, picked.length, refresh);
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
  const modified = doc.getText();
  const hunks = computeHunks(original, modified);
  const selectedHunks = hunks.filter((h) =>
    ranges.some((r) => rangesOverlap(h.modified, r)),
  );
  if (selectedHunks.length === 0) {
    void vscode.window.setStatusBarMessage(
      "$(info) GitStudio: nothing to stage in the selection",
      2500,
    );
    return;
  }
  const content = applySelectedChanges(
    original,
    modified,
    selectedHunks.map((h) => h.modified),
  );
  await commitStage(entry, rel, content, selectedHunks.length, refresh);
}

/**
 * Unstage the selected lines / hunk under the cursor. We reconstruct the index
 * WITHOUT the selected change: baseline = HEAD, target = current index, and we
 * apply every staged hunk EXCEPT the ones the selection covers. The result
 * becomes the new index content. The selection is interpreted in index
 * coordinates (the staged version), which matches unstaging from the diff
 * editor's "Staged" view or a whole-file mental model.
 */
export async function unstageSelectedLines(
  repos: RepoManager,
  refresh: StagingRefresh,
): Promise<void> {
  await unstageByPredicate(repos, refresh, (hunk, ranges) =>
    ranges.some((r) => rangesOverlap(hunk.modified, r)),
  );
}

/** Unstage the hunk(s) under the cursor (index-coordinate hunks). */
export async function unstageHunk(
  repos: RepoManager,
  refresh: StagingRefresh,
): Promise<void> {
  await unstageByPredicate(repos, refresh, (hunk, _ranges, cursorLines) =>
    cursorLines.some(
      (line) => line >= hunk.modified.start && line <= hunk.modified.end,
    ),
  );
}

/**
 * Core unstage: HEAD is the baseline, the index is the "modified" target, and we
 * re-stage every staged hunk that the `shouldDrop` predicate does NOT match —
 * effectively removing the matched change from the index while keeping the rest.
 */
async function unstageByPredicate(
  repos: RepoManager,
  refresh: StagingRefresh,
  shouldDrop: (
    hunk: ReturnType<typeof computeHunks>[number],
    ranges: LineRange[],
    cursorLines: number[],
  ) => boolean,
): Promise<void> {
  const target = resolveTarget(repos);
  if (!target) {
    return;
  }
  const editor = vscode.window.activeTextEditor!;
  const head = await target.entry.ctx.staging.headContent(target.rel);
  const index = await target.entry.ctx.staging.indexContent(target.rel);
  const hunks = computeHunks(head, index);
  if (hunks.length === 0) {
    void vscode.window.setStatusBarMessage(
      "$(info) GitStudio: nothing staged to unstage here",
      2500,
    );
    return;
  }
  const ranges = selectionRanges(editor);
  const cursorLines = editor.selections.map((s) => s.active.line);
  // Keep every staged hunk the predicate does NOT flag for removal.
  const keep = hunks.filter((h) => !shouldDrop(h, ranges, cursorLines));
  if (keep.length === hunks.length) {
    void vscode.window.setStatusBarMessage(
      "$(info) GitStudio: no staged change selected to unstage",
      2500,
    );
    return;
  }
  const newIndex = applySelectedChanges(head, index, keep.map((h) => h.modified));
  const result = await target.entry.ctx.staging.stageContent(
    target.rel,
    newIndex,
  );
  finishStaging(result.ok, result.stderr, "Unstaged selection", refresh);
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
    hunkCount === 1 ? "Staged 1 change" : `Staged ${hunkCount} changes`;
  finishStaging(result.ok, result.stderr, label, refresh);
}

function finishStaging(
  ok: boolean,
  stderr: string,
  label: string,
  refresh: StagingRefresh,
): void {
  if (!ok) {
    void vscode.window.showErrorMessage(
      `GitStudio: staging failed — ${stderr.trim() || "unknown error"}`,
    );
    return;
  }
  void vscode.window.setStatusBarMessage(`$(check) ${label}`, 2500);
  refresh.refresh();
}

/** True when two 0-based inclusive ranges overlap (insertion points included). */
function rangesOverlap(a: LineRange, b: LineRange): boolean {
  const aEnd = a.end < a.start ? a.start : a.end;
  const bEnd = b.end < b.start ? b.start : b.end;
  return a.start <= bEnd && b.start <= aEnd;
}
