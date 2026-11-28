import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import type { ChangeBlock } from "@gitstudio/git-service/blockStaging";
import { planChangedLines, type LineChangeKind } from "./changedLines";

/**
 * Whole-line highlights for changed lines in ordinary editor tabs — opt in
 * with `gitstudio.staging.highlightChangedLines` (#160).
 *
 * The staging marks are one small dot per change, easy to miss on a busy
 * theme. This paints the lines themselves: a background on every added and
 * every modified line, and a small "3 lines deleted above" label where lines
 * were taken out, since a deletion has no line left in the buffer to colour.
 * The label is not a rule across the editor, which would read as a selection
 * or as the current-line border.
 *
 * Nothing here reads git or diffs anything: StagedGutter hands over the blocks
 * it already read for its marks, so the two can never disagree and turning
 * this on costs no extra git call.
 *
 * Only ORDINARY text tabs are painted. A diff editor already colours every
 * change itself, and painting its modified side as well would stack a second
 * tint on its own; so would VS Code's multi-file diff and merge editors. The
 * colours are contributed theme colours (`gitstudio.changedLines.*`), so a
 * theme or `workbench.colorCustomizations` can change them, and a theme switch
 * repaints them without any code here.
 */

/** The theme colour behind each kind; package.json contributes all three. */
export const CHANGED_LINE_COLORS: Readonly<Record<LineChangeKind, string>> = {
  added: "gitstudio.changedLines.addedBackground",
  modified: "gitstudio.changedLines.modifiedBackground",
  deleted: "gitstudio.changedLines.deletedBackground",
};

const KINDS: readonly LineChangeKind[] = ["added", "modified", "deleted"];

/** The decoration type for one kind. */
export function changedLineDecorationOptions(kind: LineChangeKind): vscode.DecorationRenderOptions {
  // A highlight belongs to its lines and follows typing inside them, like the
  // staging marks: a line typed onto the end of an added run is painted at
  // once, and the next refresh settles the exact lines.
  const rangeBehavior = vscode.DecorationRangeBehavior.ClosedClosed;
  // The label's text carries the count, so it is set per instance (deletedLabel).
  if (kind === "deleted") return { rangeBehavior };
  return { isWholeLine: true, backgroundColor: new vscode.ThemeColor(CHANGED_LINE_COLORS[kind]), rangeBehavior };
}

/** The "N lines deleted above" label at the end of `line` ("below" when `above` is false). */
export function deletedLabel(
  document: vscode.TextDocument,
  line: number,
  count: number,
  above = true,
): vscode.DecorationOptions {
  const end = document.lineAt(line).range.end;
  return {
    range: new vscode.Range(end, end),
    renderOptions: {
      after: {
        contentText: deletedText(count, above),
        backgroundColor: new vscode.ThemeColor(CHANGED_LINE_COLORS.deleted),
        fontStyle: "italic",
        margin: "0 0 0 2em",
        // A small pill rather than a run of text that could be taken for code.
        // Decoration CSS has no radius or padding; they ride in on the
        // textDecoration escape hatch, as blame's gutter does.
        textDecoration: "none; border-radius: 3px; padding: 0 0.4em",
      },
    },
  };
}

/** Whole messages per count and direction, so every language can word each its own way. */
function deletedText(count: number, above: boolean): string {
  if (above) return count === 1 ? l10n.t("1 line deleted above") : l10n.t("{0} lines deleted above", count);
  return count === 1 ? l10n.t("1 line deleted below") : l10n.t("{0} lines deleted below", count);
}

/**
 * Whether `editor` is the document of an ordinary text tab — not a side of a
 * diff, nor an editor embedded in some other one. Asked of the tab its column
 * shows, because a TextEditor itself does not say what it is part of; an
 * editor with no column is not a main editor at all.
 */
export function isPlainTextTab(editor: vscode.TextEditor): boolean {
  const column = editor.viewColumn;
  if (column === undefined) return false;
  const group = vscode.window.tabGroups.all.find((g) => g.viewColumn === column);
  const input = group?.activeTab?.input;
  return input instanceof vscode.TabInputText && input.uri.toString() === editor.document.uri.toString();
}

export class ChangedLineHighlights implements vscode.Disposable {
  /** Made on the first paint with something to show, so a user who never turns this on gets none. */
  private types: Map<LineChangeKind, vscode.TextEditorDecorationType> | undefined;

  /**
   * Paints `blocks` on those of `editors` (all showing `document`) that are
   * ordinary text tabs, and clears it from the rest. An empty `blocks` clears.
   * `emptyHead`: HEAD has the file and it is empty (see PlanOptions).
   */
  paint(
    editors: readonly vscode.TextEditor[],
    document: vscode.TextDocument,
    blocks: readonly ChangeBlock[],
    emptyHead = false,
  ): void {
    if (editors.length === 0) return;
    if (blocks.length === 0 && !this.types) return;
    const types = this.ensureTypes();
    const plan = planChangedLines(
      blocks,
      document.lineCount,
      emptyHead ? { emptyHead, finalNewline: document.getText().endsWith("\n") } : {},
    );
    const painted: Record<LineChangeKind, vscode.Range[] | vscode.DecorationOptions[]> = {
      added: plan.added.map((s) => new vscode.Range(s.start, 0, s.end, 0)),
      modified: plan.modified.map((s) => new vscode.Range(s.start, 0, s.end, 0)),
      deleted: plan.deleted.map((d) => deletedLabel(document, d.line, d.count, d.above)),
    };
    for (const editor of editors) {
      const show = isPlainTextTab(editor);
      for (const kind of KINDS) {
        const type = types.get(kind);
        if (type) editor.setDecorations(type, show ? painted[kind] : []);
      }
    }
  }

  /** Takes every highlight off every editor: disposing a type removes it everywhere. */
  clear(): void {
    if (!this.types) return;
    for (const type of this.types.values()) type.dispose();
    this.types = undefined;
  }

  private ensureTypes(): Map<LineChangeKind, vscode.TextEditorDecorationType> {
    if (!this.types) {
      this.types = new Map(
        KINDS.map((kind) => [kind, vscode.window.createTextEditorDecorationType(changedLineDecorationOptions(kind))]),
      );
    }
    return this.types;
  }

  dispose(): void {
    this.clear();
  }
}
