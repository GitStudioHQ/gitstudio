import * as monaco from "monaco-editor";
import type {
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
  category,
  isEmptySpan,
  sideBlockSpan,
} from "@gitstudio/engine/types";
import { paintTone, type PaintTone, type SideFate } from "./paint";

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
   * What became of a handled side: taken into the Result, or discarded. A
   * view that does not say treats every handled side as taken.
   */
  sideFate?: (block: ChangeBlock, side: Side) => SideFate;
  /** The words a settled side, or a settled Result, says on hover ("Took Yours (test)"). */
  traceWords?: (block: ChangeBlock) => { left?: string; right?: string; result?: string };
  /**
   * Whether a side's text has been written into the result for this block.
   * The result then no longer holds the base text the word ranges were
   * computed on, so its word tints would mark the wrong characters.
   */
  isApplied?: (block: ChangeBlock) => boolean;
  /** When false, character-level inner decorations are skipped (line-only). */
  showInner?: boolean;
  /**
   * The Result of this pending change already holds text merged outside the
   * conflict markers (the view seeded it from the file): painted like a
   * half-settled Result — the muted tint between faint lines — with a hover
   * that says so, never like the open conflicts around it.
   */
  isSeeded?: (block: ChangeBlock) => boolean;
}

/** What a seeded Result says on hover (isSeeded). */
export const SEEDED_WORDS = "Already merged in the file, outside the conflict markers (by git, or by hand): check it";

/** What a whitespace-only change says on hover: it has no word tints, and no mark of its own. */
export const WHITESPACE_WORDS = "Only whitespace changed here";

/**
 * Applies the JetBrains-style merge decorations, by colour CATEGORY
 * (PLAN §3.6). JetBrains' rules for WHAT is resolved (TextMergeChange,
 * ThreesideMergeHighlighters, DiffViewerHighlighters): each side of a change
 * is resolved on its own — applied or ignored — and the change (so its result
 * lines) only when both are. Only a side that changed is highlighted at all.
 * What each state LOOKS like is ours, calmer than JetBrains' dotted frames:
 *
 * - pending, as JetBrains paints it (the owner's colours, 24 Sep 2026): the
 *   line-number column in the tone's FULL colour (`jb-margin-<tone>`), which
 *   the ribbon continues across the gutter; the lines in the LIGHTER colour
 *   (`jb-line-<tone>`) with the changed words in the full colour, where the
 *   change has words to compare (comparedByWords) — an insertion or a
 *   deletion is the lighter lines alone (the owner: its solid full-colour
 *   block was the part that was not pale enough); a 1px
 *   line in the full colour for an
 *   insertion or deletion point (`jb-point`); and `jb-frame` edge lines that
 *   only high contrast themes draw (solid, 1px, on the band's first and last
 *   pixel row). Nothing else: no bar beside the line numbers (the owner: no
 *   vertical per-line bars between the numbers and the code), no bright rule;
 * - a handled side leaves a TRACE of what happened to it (the owner: a
 *   resolved conflict must still show which side was chosen, which was
 *   discarded, or that both went in):
 *   - taken (`jb-trace-<tone>`): its band stays in the lighter colour, line
 *     numbers included, no word tints — and its ribbon to the Result stays
 *     too, in the lighter colour (ribbons.ts);
 *   - discarded (`jb-done`): an outline only — a 1px line on the band's first
 *     and last row, in the full colour — and no ribbon;
 * - half done — a conflict with one side in and the other still to decide:
 *   the RESULT is the lighter tint (`jb-half`) with no line above or below it
 *   (bright rules there read as wires across the Result) — no longer the
 *   open question, not settled either; the pending side keeps its full band;
 * - resolved: the RESULT keeps a band in the lighter colour of what went in
 *   (`jb-trace-<tone>`, no lines: calmer than anything still open), or, when
 *   nothing was taken, only its outline (`jb-done`);
 * - whitespace-only: the lighter tint only, never a word tint, and a hover
 *   that says only whitespace changed (its dotted left edge went with the
 *   bars).
 *
 * A settled side or Result says what happened in words, on hover ("Took
 * Yours (test)", "Discarded Theirs (master)", "Took both").
 *
 * Every block decoration also carries `jb-cat-<category>` so a reader (or a
 * test) can tell the four categories apart without decoding colours.
 *
 * Tones (paint.ts) are the DECISION a change needs — orange a conflict (you
 * choose), green the same change on both sides (either arrow takes it), blue
 * a change on one side only (safe to take) — and grey for lines removed
 * without a conflict (on one side, or the same on both). Added or changed
 * reads from the band's shape and the word tints.
 *
 * No overview-ruler marks: the Result's ruler and scrollbar sat on the
 * Result|gutter seam and cut every band there. The merge's one overview is
 * its own strip at the view's right edge (overviewMap.ts).
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

    for (const block of model.blocks) {
      const tone = paintTone(block);
      const cat = category(block);
      const resolved = options.isResolved?.(block) ?? false;
      const fate = (side: Side): SideFate | undefined => {
        if (!(side === "left" ? block.left : block.right)) return undefined;
        if (options.sideFate) return options.sideFate(block, side);
        return (options.isSideDone?.(block, side) ?? false) ? "took" : "pending";
      };
      const fates = { left: fate("left"), right: fate("right") };
      const handled = (f: SideFate | undefined): boolean => f === "took" || f === "discarded";
      // A side of its own is in while the change is not: half done.
      const half = !resolved && (handled(fates.left) || handled(fates.right));
      const words = resolved || half ? options.traceWords?.(block) : undefined;

      const span = options.resultSpanOf?.(block) ?? block.baseSpan;
      // Word tints only where the change has words to compare
      // (comparedByWords): on every pane of the change alike.
      const pendingLines = (side: Side): boolean => fates[side] === "pending" && !isEmptySpan(sideBlockSpan(block, side));
      const byWords = comparedByWords([pendingLines("left"), !isEmptySpan(span), pendingLines("right")], showInner);
      if (resolved) {
        // Settled: the Result keeps a muted band in the colour of what went
        // in — or only its outline when nothing did.
        if (fates.left === "took" || fates.right === "took") {
          pushTrace(result, this.editors.result, span, tone, cat, words?.result);
        } else {
          pushDone(result, this.editors.result, span, tone, cat, words?.result);
        }
      } else {
        const seeded = !half && (options.isSeeded?.(block) ?? false);
        pushPending(
          result,
          this.editors.result,
          span,
          tone,
          cat,
          half || seeded,
          seeded ? SEEDED_WORDS : block.whitespaceOnly ? WHITESPACE_WORDS : undefined,
        );
        if (byWords && !half && !seeded && !block.whitespaceOnly && !(options.isApplied?.(block) ?? false)) {
          // Word ranges are in BASE coordinates; the result is base while the
          // block is untouched, but blocks above may have changed height. A
          // side that deletes these lines marks no words in them: its range
          // is the whole text (JetBrains compares what is left with the
          // other side).
          const shift = span.start - block.baseSpan.start;
          for (const change of [block.left, block.right]) {
            if (change && !isEmptySpan(change.sideSpan)) pushInner(result, change.innerBase, tone, shift);
          }
        }
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
        const f = fates[side];
        if (f === "took") {
          pushTrace(target, editor, region, tone, cat, words?.[side]);
          continue;
        }
        if (f === "discarded") {
          pushDone(target, editor, region, tone, cat, words?.[side]);
          continue;
        }
        pushPending(target, editor, region, tone, cat, false, change.whitespaceOnly ? WHITESPACE_WORDS : undefined);
        if (byWords && !change.whitespaceOnly) {
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
      const role = block.role;
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
 * Resolves the role -> stripe colour map from the live CSS palette, for the
 * 2-way diff's IntelliJ-style overview-ruler ("error stripe") marks:
 * `--jb-ruler-<role>`, the role's colour at reduced strength — a thin mark to
 * find a change by, not a block to read. The 2-way diff has no decision to
 * make, so it keeps colouring by what a change did (green added, blue
 * changed, grey removed); only the merge paints by decision.
 */
function rulerPalette(): Record<Exclude<ChangeRole, "conflict">, string> {
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

/** A hover's words, as Monaco takes them (plain text: markdown's marks escaped). */
function hoverOf(words: string | undefined): monaco.IMarkdownString | undefined {
  return words ? { value: words.replace(/[\\`*_{}[\]()#+\-.!<>|]/g, "\\$&") } : undefined;
}

/**
 * An insertion or deletion POINT: a line (mergePointPx, ribbons.ts) on the
 * line after the boundary (its top rows), or on the last line's bottom rows
 * for the point after it. The ribbon's end at a point is exactly those rows.
 */
function pushPoint(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  className: string,
  cat: MergeCategory,
  hover?: string,
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
      hoverMessage: hoverOf(hover),
    },
  });
}

/**
 * Whether a change has words to mark — JetBrains' rule (intellij-community
 * DiffUtil.compareThreesideInner, MergeThreesideViewer's word diff): it
 * compares the change's texts word by word — each pending side that has
 * lines, and the Result's — only when there are at least two. A change with
 * text on one pane only — an insertion on one side, a deletion on one side or
 * the same on both — is new, or gone, as a whole: its lighter lines and its
 * full-colour column say so, and no word of it is marked (Monaco's word range
 * for it is the whole text). One answer for every pane of the change; none
 * with word highlighting off.
 */
function comparedByWords(texts: readonly boolean[], showInner: boolean): boolean {
  return showInner && texts.filter(Boolean).length >= 2;
}

/**
 * A pending block's region in one pane: the line-number column in the full
 * colour, the lines in the lighter one, and the edge lines a high
 * contrast theme draws. An empty region (an insertion or deletion point) is a
 * point line instead. `half`: the result of a conflict with one side in — the
 * lighter tint (`jb-half`), its line numbers too, and nothing else; the ribbon
 * of its pending side still meets it on the same rows, and the lighter ribbon
 * of the side that is in continues into it. A whitespace-only change is the
 * lighter tint alone, and says so on hover (WHITESPACE_WORDS).
 */
function pushPending(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  tone: PaintTone,
  cat: MergeCategory,
  half = false,
  hover?: string,
): void {
  if (isEmptySpan(span)) {
    pushPoint(target, editor, span, half ? `jb-done jb-done-${tone}` : `jb-point-${tone}`, cat, hover);
    return;
  }
  const last = span.endExclusive - 1;
  const lineClass = `jb-line-${tone}${half ? " jb-half" : ""}`;
  target.push({
    range: new monaco.Range(span.start, 1, last, 1),
    options: {
      isWholeLine: true,
      className: `${lineClass} jb-cat-${cat}`,
      // The line-number column in the full colour, as JetBrains paints it:
      // with the ribbon across the gutter, one strong column per change
      // beside its lighter lines. Nothing is drawn between the numbers and
      // the text: no bar, in any state.
      marginClassName: half ? lineClass : `jb-margin-${tone}`,
      hoverMessage: hoverOf(hover),
    },
  });
  if (half) {
    // The half-done Result: the muted tint, and no line above or below it.
    return;
  }
  pushEdges(target, span, `jb-frame jb-frame-${tone}`);
}

/**
 * A side that was TAKEN (in its own pane), or a settled Result that holds
 * what was taken: the band stays, muted (`jb-trace-<tone>`: the tint at about
 * half strength, no word tints, no lines) — calmer than anything still open,
 * and joined to the Result by its muted ribbon (ribbons.ts). High contrast
 * adds a faint solid edge (`jb-trace-edge`), so it never rests on a tint
 * alone. An empty region (a deletion taken) keeps a faint point line.
 */
function pushTrace(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  tone: PaintTone,
  cat: MergeCategory,
  hover?: string,
): void {
  if (isEmptySpan(span)) {
    pushPoint(target, editor, span, `jb-done jb-done-${tone}`, cat, hover);
    return;
  }
  target.push({
    range: new monaco.Range(span.start, 1, span.endExclusive - 1, 1),
    options: {
      isWholeLine: true,
      className: `jb-trace jb-trace-${tone} jb-cat-${cat}`,
      marginClassName: `jb-trace jb-trace-${tone}`,
      hoverMessage: hoverOf(hover),
    },
  });
  pushEdges(target, span, `jb-frame jb-trace-edge jb-trace-edge-${tone}`);
}

/**
 * A side that was DISCARDED — or a settled Result that took nothing (it keeps
 * the original): an outline only. No fill — a faint 1px line on the region's
 * first and last pixel row, and no ribbon; an empty region keeps its point
 * line, faint.
 */
function pushDone(
  target: Deco[],
  editor: Editor,
  span: LineSpan,
  tone: PaintTone,
  cat: MergeCategory,
  hover?: string,
): void {
  if (isEmptySpan(span)) {
    pushPoint(target, editor, span, `jb-done jb-done-${tone}`, cat, hover);
    return;
  }
  pushEdges(target, span, `jb-done jb-done-${tone}`, cat, hover);
}

/**
 * Top and bottom edge lines of a region. A whole-line decoration is drawn
 * once PER LINE, so a border on the range's own class would rule every line;
 * the edges go on the first line (`jb-edge-top`) and the last
 * (`jb-edge-bottom`) only — both on a one-line region. The margin carries
 * them too, so an edge runs across the line numbers as well. A hover names
 * what an outline stands for, on every line between its edges.
 */
function pushEdges(target: Deco[], span: LineSpan, className: string, cat?: MergeCategory, hover?: string): void {
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
  if (hover) {
    target.push({
      range: new monaco.Range(span.start, 1, last, 1),
      options: { isWholeLine: true, hoverMessage: hoverOf(hover) },
    });
  }
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
  tone: ChangeRole | PaintTone,
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
