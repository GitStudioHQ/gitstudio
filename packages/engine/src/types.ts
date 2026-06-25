// Pure, serializable data model for a 3-way merge. No vscode/monaco imports so
// it can run in the webview, the worker, or headless tests.

export type ChangeRole = "inserted" | "deleted" | "modified" | "conflict";
export type BlockKind = "left-only" | "right-only" | "conflict" | "both-same";
export type Side = "left" | "right";

/** A 1-based, end-exclusive span of lines. Empty when start === endExclusive. */
export interface LineSpan {
  start: number;
  endExclusive: number;
}

/** A 1-based character range (within a single editor's text). */
export interface InnerRange {
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/** One side's change relative to the common ancestor (base). */
export interface SideChange {
  side: Side;
  /** inserted / deleted / modified, relative to base. */
  role: Exclude<ChangeRole, "conflict">;
  /** The affected span in base/result coordinates. */
  baseSpan: LineSpan;
  /** The affected span in the side's own document (ours=left, theirs=right). */
  sideSpan: LineSpan;
  /** Character-level diffs within the side document. */
  innerSide: InnerRange[];
  /** Character-level diffs within base. */
  innerBase: InnerRange[];
}

/** A contiguous region of change, anchored on base/result coordinates. */
export interface ChangeBlock {
  id: number;
  kind: BlockKind;
  /** Union span in base/result coordinates. */
  baseSpan: LineSpan;
  left?: SideChange;
  right?: SideChange;
}

export interface MergeCounts {
  total: number;
  conflicts: number;
  autoResolvable: number;
}

export interface MergeModel {
  blocks: ChangeBlock[];
  counts: MergeCounts;
}

/** One change in a 2-way diff (left = original, right = modified). */
export interface DiffBlock {
  id: number;
  role: Exclude<ChangeRole, "conflict">;
  /** Affected span in the left (original) document. */
  leftSpan: LineSpan;
  /** Affected span in the right (modified) document. */
  rightSpan: LineSpan;
  /** Character-level diffs within the left document. */
  innerLeft: InnerRange[];
  /** Character-level diffs within the right document. */
  innerRight: InnerRange[];
}

export interface DiffModel {
  blocks: DiffBlock[];
}

export function isEmptySpan(span: LineSpan): boolean {
  return span.start === span.endExclusive;
}

/**
 * A side's full extent for a block, in that side's own coordinates
 * (ours = left, theirs = right), INCLUDING passthrough lines the side did not
 * change. A block's `baseSpan` is the union of both sides' changes, so it can
 * cover base lines one side left untouched; those lines still exist verbatim in
 * that side and must travel with its version when it is accepted — otherwise
 * accepting the side drops them (e.g. the unchanged `def` line of a function
 * whose body the other side deleted). Returns an empty span at the block start
 * when the side made no change here. Mirrors the lead-in/trailing arithmetic in
 * the alignment computation's placeSide.
 */
export function sideBlockSpan(block: ChangeBlock, side: Side): LineSpan {
  const change = side === "left" ? block.left : block.right;
  if (!change) {
    return { start: block.baseSpan.start, endExclusive: block.baseSpan.start };
  }
  const leadIn = change.baseSpan.start - block.baseSpan.start;
  const trailing = block.baseSpan.endExclusive - change.baseSpan.endExclusive;
  return {
    start: change.sideSpan.start - leadIn,
    endExclusive: change.sideSpan.endExclusive + trailing,
  };
}

/** The display role (color) for a block: conflicts are red, else the side's role. */
export function blockRole(block: ChangeBlock): ChangeRole {
  if (block.kind === "conflict") {
    return "conflict";
  }
  return block.left?.role ?? block.right?.role ?? "modified";
}
