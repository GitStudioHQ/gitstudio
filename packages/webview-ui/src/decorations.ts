import * as monaco from "monaco-editor";
import type {
  ChangeBlock,
  ChangeRole,
  DiffModel,
  InnerRange,
  LineSpan,
  MergeModel,
  Side,
  SideChange,
} from "@gitstudio/engine/types";
import { blockRole, isEmptySpan } from "@gitstudio/engine/types";

type Editor = monaco.editor.IStandaloneCodeEditor;
type Deco = monaco.editor.IModelDeltaDecoration;
type Collection = monaco.editor.IEditorDecorationsCollection;

export interface MergeEditors {
  left: Editor;
  result: Editor;
  right: Editor;
}

export interface DecorationOptions {
  /** Current result-pane span for a block (defaults to its base span). */
  resultSpanOf?: (block: ChangeBlock) => LineSpan;
  /** Whether a block has been fully resolved (its result highlight is then dropped). */
  isResolved?: (block: ChangeBlock) => boolean;
  /** Whether one side of a block has been processed (it is then muted). */
  isSideDone?: (block: ChangeBlock, side: Side) => boolean;
  /** When false, character-level inner decorations are skipped (line-only). */
  showInner?: boolean;
}

/** Applies JetBrains-style line/inner/marker decorations for the merge model. */
export class DecorationManager {
  private collections: Collection[] = [];

  constructor(private readonly editors: MergeEditors) {}

  public apply(model: MergeModel, options: DecorationOptions = {}): void {
    this.clear();
    const left: Deco[] = [];
    const result: Deco[] = [];
    const right: Deco[] = [];
    const showInner = options.showInner ?? true;
    const palette = rulerPalette();

    // Note: conflict frame lines are NOT drawn here. They are SVG polylines
    // in the gutter overlays (ribbons.ts) that extend across the panes — a
    // single renderer keeps them pixel-continuous, which CSS borders +
    // separate SVG strokes never quite were.
    for (const block of model.blocks) {
      const role = blockRole(block);
      const resolved = options.isResolved?.(block) ?? false;
      const leftDone =
        resolved || (options.isSideDone?.(block, "left") ?? false);
      const rightDone =
        resolved || (options.isSideDone?.(block, "right") ?? false);

      if (!resolved) {
        const span = options.resultSpanOf?.(block) ?? block.baseSpan;
        pushLine(result, this.editors.result, span, role, palette[role]);
        if (showInner) {
          pushInner(result, block.left?.innerBase, role);
          pushInner(result, block.right?.innerBase, role);
        }
      }
      if (block.left) {
        if (leftDone) {
          pushResolved(left, this.editors.left, block.left.sideSpan);
        } else {
          pushLine(left, this.editors.left, block.left.sideSpan, role);
          if (showInner) {
            pushInner(left, block.left.innerSide, role);
          }
        }
      }
      if (block.right) {
        if (rightDone) {
          pushResolved(right, this.editors.right, block.right.sideSpan);
        } else {
          pushLine(right, this.editors.right, block.right.sideSpan, role);
          if (showInner) {
            pushInner(right, block.right.innerSide, role);
          }
        }
      }
    }

    this.collections = [
      this.editors.left.createDecorationsCollection(left),
      this.editors.result.createDecorationsCollection(result),
      this.editors.right.createDecorationsCollection(right),
    ];
  }

  public clear(): void {
    for (const collection of this.collections) {
      collection.clear();
    }
    this.collections = [];
  }
}

export interface DiffEditors {
  left: Editor;
  right: Editor;
}

export interface DiffDecorationOptions {
  /** When false, character-level inner decorations are skipped (line-only). */
  showInner?: boolean;
}

/** Applies line/inner decorations for a 2-way diff (no result pane). */
export class DiffDecorationManager {
  private collections: Collection[] = [];

  constructor(private readonly editors: DiffEditors) {}

  public apply(model: DiffModel, options: DiffDecorationOptions = {}): void {
    this.clear();
    const left: Deco[] = [];
    const right: Deco[] = [];
    const showInner = options.showInner ?? true;

    const palette = rulerPalette();
    for (const block of model.blocks) {
      const role: ChangeRole = block.role;
      pushLine(left, this.editors.left, block.leftSpan, role);
      pushLine(right, this.editors.right, block.rightSpan, role, palette[role]);
      if (showInner) {
        pushInner(left, block.innerLeft, role);
        pushInner(right, block.innerRight, role);
      }
    }

    this.collections = [
      this.editors.left.createDecorationsCollection(left),
      this.editors.right.createDecorationsCollection(right),
    ];
  }

  public clear(): void {
    for (const collection of this.collections) {
      collection.clear();
    }
    this.collections = [];
  }
}

/**
 * Resolves the role -> stripe color map from the live CSS palette, for the
 * IntelliJ-style overview-ruler ("error stripe") marks.
 */
function rulerPalette(): Record<ChangeRole, string> {
  const styles = getComputedStyle(document.body);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  return {
    inserted: read("--jb-inner-inserted"),
    deleted: read("--jb-inner-deleted"),
    modified: read("--jb-inner-modified"),
    conflict: read("--jb-inner-conflict"),
  };
}

function pushLine(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  role: ChangeRole,
  rulerColor?: string,
): void {
  const overviewRuler = rulerColor
    ? { color: rulerColor, position: monaco.editor.OverviewRulerLane.Full }
    : undefined;
  if (isEmptySpan(span)) {
    const lineCount = editor.getModel()?.getLineCount() ?? 1;
    const line = Math.min(Math.max(span.start, 1), lineCount);
    target.push({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: `jb-marker-${role}`, overviewRuler },
    });
  } else {
    target.push({
      range: new monaco.Range(span.start, 1, span.endExclusive - 1, 1),
      options: {
        isWholeLine: true,
        className: `jb-line-${role}`,
        // Tint the line-number margin too, like IntelliJ, so the change
        // band runs uninterrupted across the pane.
        marginClassName: `jb-line-${role}`,
        overviewRuler,
      },
    });
  }
}

/**
 * IntelliJ marks already-processed changes in the side panes with a muted
 * gray wash instead of dropping the highlight entirely. Empty spans (pure
 * insertions/deletions) keep a muted point marker for the same reason.
 */
function pushResolved(target: Deco[], editor: Editor, span: LineSpan): void {
  if (isEmptySpan(span)) {
    const lineCount = editor.getModel()?.getLineCount() ?? 1;
    const line = Math.min(Math.max(span.start, 1), lineCount);
    target.push({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: "jb-marker-resolved" },
    });
    return;
  }
  target.push({
    range: new monaco.Range(span.start, 1, span.endExclusive - 1, 1),
    options: {
      isWholeLine: true,
      className: "jb-line-resolved",
      marginClassName: "jb-line-resolved",
    },
  });
}

function pushInner(
  target: Deco[],
  inners: InnerRange[] | undefined,
  role: ChangeRole,
): void {
  for (const inner of inners ?? []) {
    if (
      inner.startLine === inner.endLine &&
      inner.startColumn === inner.endColumn
    ) {
      continue; // zero-width (e.g. base side of an insertion)
    }
    target.push({
      range: new monaco.Range(
        inner.startLine,
        inner.startColumn,
        inner.endLine,
        inner.endColumn,
      ),
      options: { inlineClassName: `jb-inner-${role}` },
    });
  }
}

// Re-exported so other modules don't reach into engine internals directly.
export type { ChangeBlock, SideChange };
