import * as monaco from "monaco-editor";
import type {
  BlockTone,
  ChangeBlock,
  ChangeRole,
  DiffModel,
  InnerRange,
  LineSpan,
  MergeCategory,
  MergeModel,
  Side,
  SideChange,
} from "@gitstudio/engine/types";
import {
  blockTone,
  category,
  isEmptySpan,
  sideBlockSpan,
} from "@gitstudio/engine/types";

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
  /** Whether a block has been fully resolved (every pane then shows it dashed). */
  isResolved?: (block: ChangeBlock) => boolean;
  /** Whether one side of a block has been processed (that side is then dashed). */
  isSideDone?: (block: ChangeBlock, side: Side) => boolean;
  /** When false, character-level inner decorations are skipped (line-only). */
  showInner?: boolean;
}

/**
 * Applies the JetBrains-style merge decorations, by colour CATEGORY
 * (PLAN §3.6):
 *
 * - pending block: the tone's line tint (`jb-line-<tone>`), word tints when
 *   granularity allows, a double marker line for an insertion/deletion point
 *   (`jb-marker-<tone>`), and `jb-frame-<tone>` edge lines that only high
 *   contrast themes draw (solid top + bottom);
 * - applied / ignored side or block: NO fill — a 1px dashed top and bottom edge
 *   in the tone's edge colour (`jb-applied-<tone>`), in every pane that showed
 *   it, so what was taken stays readable as what it was;
 * - whitespace-only: line tint only, never a word tint, plus a dotted left
 *   edge (`jb-ws`).
 *
 * Every block decoration also carries `jb-cat-<category>` so a reader (or a
 * test) can tell the four categories apart without decoding colours.
 *
 * Tones: a conflict is orange, an identical change violet, and a one-sided
 * change is coloured by what it did (green inserted, blue modified, grey
 * deleted).
 */
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
      const tone = blockTone(block);
      const cat = category(block);
      const resolved = options.isResolved?.(block) ?? false;
      const leftDone =
        resolved || (options.isSideDone?.(block, "left") ?? false);
      const rightDone =
        resolved || (options.isSideDone?.(block, "right") ?? false);

      const span = options.resultSpanOf?.(block) ?? block.baseSpan;
      if (!resolved) {
        pushPending(result, this.editors.result, span, tone, cat, !!block.whitespaceOnly, {
          color: palette[tone],
          // The error stripe: conflicts take the full width, everything else a
          // narrow lane, so a conflict is findable from the scrollbar alone.
          position:
            tone === "conflict"
              ? monaco.editor.OverviewRulerLane.Full
              : monaco.editor.OverviewRulerLane.Center,
        });
        if (showInner && !block.whitespaceOnly) {
          // Word ranges are in BASE coordinates; the result is base while the
          // block is pending, but blocks above may have changed height.
          const shift = span.start - block.baseSpan.start;
          pushInner(result, block.left?.innerBase, tone, shift);
          pushInner(result, block.right?.innerBase, tone, shift);
        }
      } else {
        pushApplied(result, this.editors.result, span, tone, cat);
      }
      for (const [side, editor, target, done] of [
        ["left", this.editors.left, left, leftDone],
        ["right", this.editors.right, right, rightDone],
      ] as const) {
        const change = side === "left" ? block.left : block.right;
        if (!change) {
          continue;
        }
        // The side's FULL region — its change plus the block's passthrough
        // lines — which is what accepting it writes, and what the ribbons and
        // the alignment spacers measure.
        const region = sideBlockSpan(block, side);
        if (done) {
          pushApplied(target, editor, region, tone, cat);
          continue;
        }
        pushPending(target, editor, region, tone, cat, !!change.whitespaceOnly);
        if (showInner && !change.whitespaceOnly) {
          pushInner(target, change.innerSide, tone);
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
 * Resolves the tone -> stripe colour map from the live CSS palette, for the
 * IntelliJ-style overview-ruler ("error stripe") marks: the EDGE colours, which
 * are the ones measured to stand off the editor background (≥ 3:1).
 */
function rulerPalette(): Record<BlockTone, string> {
  const styles = getComputedStyle(document.body);
  const read = (name: string) => styles.getPropertyValue(name).trim();
  return {
    inserted: read("--jb-edge-inserted"),
    deleted: read("--jb-edge-deleted"),
    modified: read("--jb-edge-modified"),
    same: read("--jb-edge-same"),
    conflict: read("--jb-edge-conflict"),
  };
}

/** The line a decoration for a (possibly empty) span sits on, inside the document. */
function clampLine(editor: Editor, line: number): number {
  const lineCount = editor.getModel()?.getLineCount() ?? 1;
  return Math.min(Math.max(line, 1), lineCount);
}

/**
 * A pending block's region in one pane: the tint, and the edge lines a high
 * contrast theme draws. An empty region (an insertion or deletion point) is a
 * double marker line instead.
 */
function pushPending(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  tone: BlockTone,
  cat: MergeCategory,
  whitespaceOnly: boolean,
  ruler?: monaco.editor.IModelDecorationOverviewRulerOptions,
): void {
  if (isEmptySpan(span)) {
    const line = clampLine(editor, span.start);
    target.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: `jb-marker-${tone} jb-cat-${cat}`,
        overviewRuler: ruler,
      },
    });
    return;
  }
  const last = span.endExclusive - 1;
  target.push({
    range: new monaco.Range(span.start, 1, last, 1),
    options: {
      isWholeLine: true,
      className: `jb-line-${tone} jb-cat-${cat}${whitespaceOnly ? " jb-ws" : ""}`,
      // Tint the line-number margin too, like IntelliJ, so the change
      // band runs uninterrupted across the pane.
      marginClassName: `jb-line-${tone}`,
      overviewRuler: ruler,
    },
  });
  pushEdges(target, span, `jb-frame-${tone}`);
}

/**
 * An applied / ignored region: no fill, a dashed top and bottom edge in the
 * tone's edge colour. An empty region keeps a dashed marker line.
 */
function pushApplied(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  tone: BlockTone,
  cat: MergeCategory,
): void {
  if (isEmptySpan(span)) {
    const line = clampLine(editor, span.start);
    target.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: `jb-applied-${tone} jb-edge-top jb-cat-${cat}`,
      },
    });
    return;
  }
  pushEdges(target, span, `jb-applied-${tone} jb-cat-${cat}`);
}

/**
 * Top and bottom edge lines around a region. A whole-line decoration is drawn
 * once PER LINE, so a border on the range's own class would rule every line;
 * the edges go on the first and last lines only (`jb-edge-top` keeps just the
 * top border, `jb-edge-bottom` just the bottom; a one-line region keeps both).
 */
function pushEdges(target: Deco[], span: LineSpan, className: string): void {
  const last = span.endExclusive - 1;
  if (last === span.start) {
    target.push({
      range: new monaco.Range(span.start, 1, span.start, 1),
      options: { isWholeLine: true, className },
    });
    return;
  }
  target.push(
    {
      range: new monaco.Range(span.start, 1, span.start, 1),
      options: { isWholeLine: true, className: `${className} jb-edge-top` },
    },
    {
      range: new monaco.Range(last, 1, last, 1),
      options: { isWholeLine: true, className: `${className} jb-edge-bottom` },
    },
  );
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

function pushInner(
  target: Deco[],
  inners: InnerRange[] | undefined,
  tone: ChangeRole | BlockTone,
  lineShift = 0,
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
        inner.startLine + lineShift,
        inner.startColumn,
        inner.endLine + lineShift,
        inner.endColumn,
      ),
      options: { inlineClassName: `jb-inner-${tone}` },
    });
  }
}

// Re-exported so other modules don't reach into engine internals directly.
export type { ChangeBlock, SideChange };
