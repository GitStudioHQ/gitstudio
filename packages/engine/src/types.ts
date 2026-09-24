// Pure, serializable data model for a 3-way merge. No vscode/monaco imports so
// it can run in the webview, the worker, or headless tests.

export type ChangeRole = "inserted" | "deleted" | "modified" | "conflict";
/** What one side did to a region, relative to base. */
export type ChangeType = Exclude<ChangeRole, "conflict">;
export type BlockKind = "left-only" | "right-only" | "conflict" | "both-same";
export type Side = "left" | "right";

/**
 * The colour category of a block — JetBrains' merge model, in the words the
 * merge UI uses. Left is always Yours (the hosts map the stages before the
 * payload is built), so "yours-only" is the engine's left-only.
 * - "conflict": both sides changed the region differently;
 * - "same": both sides made the same change (exactly, or up to whitespace);
 * - "yours-only" / "theirs-only": one side changed it.
 */
export type MergeCategory = "conflict" | "same" | "yours-only" | "theirs-only";

/**
 * The paint of a block: the DECISION it needs, never what it did.
 * - "conflict" (red): the sides differ, you choose;
 * - "same" (green): the same change on both sides, whether lines were added,
 *   changed or removed — nothing to choose, either arrow takes it;
 * - "one-sided" (blue): a change on one side only, whether added, changed or
 *   removed — safe to take.
 * What a change DID stays readable from the shape of its band (a band that
 * meets a line on the other side was added there, or removed) and from its
 * word highlights.
 */
export type BlockTone = "conflict" | "same" | "one-sided";

/** A line-ending style. */
export type LineEnding = "LF" | "CRLF" | "CR";

/**
 * Yours and Theirs disagree about line endings. The merge runs on normalised
 * text; the result is written back in `result` (Yours' dominant ending).
 */
export interface EolMismatch {
  /** Dominant ending of Yours; "none" when it has no line break at all. */
  yours: LineEnding | "none";
  /** Dominant ending of Theirs; "none" when it has no line break at all. */
  theirs: LineEnding | "none";
  /** What the merged result is written with. */
  result: LineEnding;
}

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
  /**
   * Only whitespace differs from base. Found when the merge ignores
   * whitespace: the change is invisible to the whitespace-blind diff but the
   * bytes differ, so it is kept (flagged) rather than silently dropped.
   * No inner ranges — it is painted as a line tint only.
   */
  whitespaceOnly?: boolean;
}

/** A contiguous region of change, anchored on base/result coordinates. */
export interface ChangeBlock {
  id: number;
  kind: BlockKind;
  /** Union span in base/result coordinates. */
  baseSpan: LineSpan;
  left?: SideChange;
  right?: SideChange;
  /**
   * JetBrains' merge type for the block (MergeRangeUtil.getMergeType): what
   * the change did when the sides agree or only one side changed, else
   * "conflict". Judged on the block's full regions, and on the DOCUMENT for
   * emptiness — so an add/add of identical files is "inserted", and both
   * sides deleting the file is "deleted".
   */
  type: ChangeRole;
  /** What Yours did to the block's region (only when Yours changed it). */
  leftType?: ChangeType;
  /** What Theirs did to the block's region (only when Theirs changed it). */
  rightType?: ChangeType;
  /**
   * "both-same" only: the two regions are byte-identical (after line-ending
   * normalisation). False means identical only up to whitespace (≈), so the
   * pick decides whose whitespace wins.
   */
  exact?: boolean;
  /** Every change in the block is whitespace-only. */
  whitespaceOnly?: boolean;
  /**
   * "conflict" only: both regions are non-empty and no Yours edit overlaps a
   * Theirs edit (touching is fine), so applying both is well defined — the
   * magic wand writes `resolvedText`.
   */
  resolvable?: boolean;
  /** Base region with both sides' edits applied in base order (resolvable only). */
  resolvedText?: string;
}

export interface MergeCounts {
  total: number;
  conflicts: number;
  /** Blocks that are not conflicts (identical + one-sided). */
  autoResolvable: number;
  /** "both-same" blocks (exact or up to whitespace). */
  identical: number;
  /** Conflicts the wand can resolve. */
  resolvableConflicts: number;
}

export interface MergeModel {
  blocks: ChangeBlock[];
  counts: MergeCounts;
  /** The line ending the merged result is written with (Yours' dominant one). */
  eol: LineEnding;
  /** Set when Yours and Theirs use different line endings. */
  eolMismatch?: EolMismatch;
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

/**
 * The display role for a block: "conflict" for a conflict, else what the
 * change did. Kept for callers that predate the categories; the merge view
 * paints by `category` / `blockTone`.
 */
export function blockRole(block: ChangeBlock): ChangeRole {
  return block.type;
}

/** The colour category of a block (see MergeCategory). */
export function category(block: ChangeBlock): MergeCategory {
  switch (block.kind) {
    case "conflict":
      return "conflict";
    case "both-same":
      return "same";
    case "left-only":
      return "yours-only";
    case "right-only":
      return "theirs-only";
  }
}

/** The paint of a block: the decision it needs (see BlockTone). */
export function blockTone(block: ChangeBlock): BlockTone {
  switch (block.kind) {
    case "conflict":
      return "conflict";
    case "both-same":
      return "same";
    case "left-only":
    case "right-only":
      return "one-sided";
  }
}
