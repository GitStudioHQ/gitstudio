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
  /** Whether a block has been fully resolved (every pane then shows it calm). */
  isResolved?: (block: ChangeBlock) => boolean;
  /** Whether one side of a block has been handled — applied or ignored (that side is then calm). */
  isSideDone?: (block: ChangeBlock, side: Side) => boolean;
  /**
   * Whether a side's text has been written into the result for this block.
   * The result then no longer holds the base text the word ranges were
   * computed on, so its word tints would mark the wrong characters.
   */
  isApplied?: (block: ChangeBlock) => boolean;
  /** When false, character-level inner decorations are skipped (line-only). */
  showInner?: boolean;
  /**
   * Whether pending blocks mark the result's overview ruler. The view turns it
   * off while the whole document fits the viewport: a ruler maps the document
   * onto its full height, so in a short file one line's mark is a big block
   * beside the text — and there is nothing off-screen for it to find.
   */
  rulerMarks?: boolean;
}

/**
 * Applies the JetBrains-style merge decorations, by colour CATEGORY
 * (PLAN §3.6). JetBrains' rules for WHAT is resolved (TextMergeChange,
 * ThreesideMergeHighlighters, DiffViewerHighlighters): each side of a change
 * is resolved on its own — applied or ignored — and the change (so its result
 * lines) only when both are. Only a side that changed is highlighted at all.
 * What each state LOOKS like is ours, calmer than JetBrains' dotted frames:
 *
 * - pending: the tone's line tint (`jb-line-<tone>`, the line-number margin
 *   included, so the band runs uninterrupted across the pane), word tints when
 *   granularity allows, a POINT_PX line for an insertion/deletion point
 *   (`jb-point`), and `jb-frame` edge lines that only high contrast themes
 *   draw (solid, 1px, on the band's first and last pixel row);
 * - half done — a conflict with one side taken or ignored and the other still
 *   to decide: the handled side is calm (no fill, a faint 1px line on its
 *   band's first and last row, `jb-done`); the RESULT drops to a tint under
 *   half strength (`jb-half`) between the same faint lines — no longer the
 *   open question, not settled either; the pending side keeps its full band;
 * - resolved: nothing in the side panes, and in the result one neutral faint
 *   line top and bottom (`jb-settled`) — done, and quiet;
 * - whitespace-only: line tint only, never a word tint, plus a dotted left
 *   edge (`jb-ws`).
 *
 * Every block decoration also carries `jb-cat-<category>` so a reader (or a
 * test) can tell the four categories apart without decoding colours.
 *
 * Tones: a conflict is red, a change made the same on both sides violet, and
 * a one-sided change is coloured by what it did (green inserted, blue
 * modified, grey deleted).
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
    const palette = options.rulerMarks === false ? undefined : rulerPalette();

    for (const block of model.blocks) {
      const tone = blockTone(block);
      const cat = category(block);
      const resolved = options.isResolved?.(block) ?? false;
      const sideDone = (side: Side): boolean =>
        !!(side === "left" ? block.left : block.right) && (options.isSideDone?.(block, side) ?? false);
      // A side of its own is in while the change is not: half done.
      const half = !resolved && (sideDone("left") || sideDone("right"));

      const span = options.resultSpanOf?.(block) ?? block.baseSpan;
      if (resolved) {
        // Settled: one neutral faint line in the result, nothing in the side
        // panes — and nothing across the gutters (ribbons.ts).
        pushSettled(result, this.editors.result, span, cat);
        continue;
      }
      pushPending(result, this.editors.result, span, tone, cat, !!block.whitespaceOnly, palette && {
        color: palette[tone],
        // A thin mark in the right lane: findable from the scrollbar,
        // never a block beside the text.
        position: monaco.editor.OverviewRulerLane.Right,
      }, half);
      if (showInner && !half && !block.whitespaceOnly && !(options.isApplied?.(block) ?? false)) {
        // Word ranges are in BASE coordinates; the result is base while the
        // block is untouched, but blocks above may have changed height.
        const shift = span.start - block.baseSpan.start;
        pushInner(result, block.left?.innerBase, tone, shift);
        pushInner(result, block.right?.innerBase, tone, shift);
      }
      for (const [side, editor, target] of [
        ["left", this.editors.left, left],
        ["right", this.editors.right, right],
      ] as const) {
        const change = side === "left" ? block.left : block.right;
        if (!change) {
          continue;
        }
        // The side's FULL region — its change plus the block's passthrough
        // lines — which is what accepting it writes, and what the ribbons and
        // the alignment spacers measure.
        const region = sideBlockSpan(block, side);
        if (sideDone(side)) {
          pushDone(target, editor, region, tone, cat);
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
 * IntelliJ-style overview-ruler ("error stripe") marks: `--jb-ruler-<tone>`,
 * the category colour at reduced strength — a thin mark to find a change by,
 * not a block to read.
 */
function rulerPalette(): Record<BlockTone, string> {
  // Resolved through a probe's computed `color`, not the raw custom-property
  // text: the browser's canonical "rgba(63, 185, 80, 0.6)" is the one form
  // every colour consumer (Monaco's own parser included) reads.
  const probe = document.createElement("span");
  probe.style.display = "none";
  document.body.appendChild(probe);
  const read = (name: string) => {
    probe.style.color = `var(${name})`;
    return getComputedStyle(probe).color;
  };
  const palette = {
    inserted: read("--jb-ruler-inserted"),
    deleted: read("--jb-ruler-deleted"),
    modified: read("--jb-ruler-modified"),
    same: read("--jb-ruler-same"),
    conflict: read("--jb-ruler-conflict"),
  };
  probe.remove();
  return palette;
}

/** The line a decoration for a (possibly empty) span sits on, inside the document. */
function clampLine(editor: Editor, line: number): number {
  const lineCount = editor.getModel()?.getLineCount() ?? 1;
  return Math.min(Math.max(line, 1), lineCount);
}

/**
 * A point AFTER the last line (an insertion after an unterminated last line):
 * Monaco has no such line, so its marker goes on the last line's BOTTOM edge
 * (`jb-point-after`) — drawn on the top edge, it said the text goes above
 * the line it actually follows.
 */
function pastEnd(editor: Editor, line: number): boolean {
  return line > (editor.getModel()?.getLineCount() ?? 1);
}

/**
 * An insertion or deletion POINT: a POINT_PX line on the line after the
 * boundary (its top rows), or on the last line's bottom rows for the point
 * after it. The ribbon's end at a point is exactly those rows (ribbons.ts).
 */
function pushPoint(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  className: string,
  cat: MergeCategory,
  ruler?: monaco.editor.IModelDecorationOverviewRulerOptions,
): void {
  const line = clampLine(editor, span.start);
  const classes = `${className} jb-point${pastEnd(editor, span.start) ? " jb-point-after" : ""}`;
  target.push({
    range: new monaco.Range(line, 1, line, 1),
    options: {
      isWholeLine: true,
      className: `${classes} jb-cat-${cat}`,
      // The line-number margin too, so the mark runs across the whole pane.
      marginClassName: classes,
      overviewRuler: ruler,
    },
  });
}

/**
 * A pending block's region in one pane: the tint, and the edge lines a high
 * contrast theme draws. An empty region (an insertion or deletion point) is a
 * point line instead. `half`: the result of a conflict with one side in — the
 * tint under half strength (`jb-half`), between the handled side's faint
 * lines; the ribbon of its pending side still meets it on the same rows.
 */
function pushPending(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  tone: BlockTone,
  cat: MergeCategory,
  whitespaceOnly: boolean,
  ruler?: monaco.editor.IModelDecorationOverviewRulerOptions,
  half = false,
): void {
  if (isEmptySpan(span)) {
    pushPoint(target, editor, span, `jb-point-${tone}`, cat, ruler);
    return;
  }
  const last = span.endExclusive - 1;
  const halfClass = half ? " jb-half" : "";
  target.push({
    range: new monaco.Range(span.start, 1, last, 1),
    options: {
      isWholeLine: true,
      className: `jb-line-${tone}${halfClass} jb-cat-${cat}${whitespaceOnly ? " jb-ws" : ""}`,
      // Tint the line-number margin too, like IntelliJ, so the change
      // band runs uninterrupted across the pane.
      marginClassName: `jb-line-${tone}${halfClass}`,
      overviewRuler: ruler,
    },
  });
  if (half) {
    pushEdges(target, span, `jb-done jb-done-${tone}`, cat);
    return;
  }
  pushEdges(target, span, `jb-frame jb-frame-${tone}`);
}

/**
 * A resolved change, in the result: one neutral faint line on its first and
 * last pixel row (an empty region: a faint point line). It is settled and
 * says so without a colour of its own.
 */
function pushSettled(target: Deco[], editor: Editor, span: LineSpan, cat: MergeCategory): void {
  if (isEmptySpan(span)) {
    pushPoint(target, editor, span, "jb-settled", cat);
    return;
  }
  pushEdges(target, span, "jb-settled", cat);
}

/**
 * A handled side while the other side of its conflict is still to decide:
 * calm. No fill — a faint 1px line on the region's first and last pixel row;
 * an empty region keeps its point line, faint.
 */
function pushDone(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  tone: BlockTone,
  cat: MergeCategory,
): void {
  if (isEmptySpan(span)) {
    pushPoint(target, editor, span, `jb-done jb-done-${tone}`, cat);
    return;
  }
  pushEdges(target, span, `jb-done jb-done-${tone}`, cat);
}

/**
 * Top and bottom edge lines of a region. A whole-line decoration is drawn
 * once PER LINE, so a border on the range's own class would rule every line;
 * the edges go on the first line (`jb-edge-top`) and the last
 * (`jb-edge-bottom`) only — both on a one-line region. The margin carries
 * them too, so an edge runs across the line numbers as well.
 */
function pushEdges(target: Deco[], span: LineSpan, className: string, cat?: MergeCategory): void {
  const last = span.endExclusive - 1;
  const catClass = cat ? ` jb-cat-${cat}` : "";
  const edge = (line: number, edges: string) => {
    target.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        isWholeLine: true,
        className: `${className} ${edges}${catClass}`,
        marginClassName: `${className} ${edges}`,
      },
    });
  };
  if (last === span.start) {
    edge(span.start, "jb-edge-top jb-edge-bottom");
    return;
  }
  edge(span.start, "jb-edge-top");
  edge(last, "jb-edge-bottom");
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
    const line = clampLine(editor, span.start);
    const after = pastEnd(editor, span.start) ? " jb-marker-after" : "";
    target.push({
      range: new monaco.Range(line, 1, line, 1),
      options: { isWholeLine: true, className: `jb-marker-${role}${after}`, overviewRuler },
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
