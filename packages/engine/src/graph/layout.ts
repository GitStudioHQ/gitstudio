// Pure commit-graph lane-assignment (pvigier "active branches" algorithm).
// Given commits in display order (newest first, as from
// `git log --parents --date-order`), assigns each commit a column (lane) and a
// color, and emits the line segments needed to render a GitKraken/GitLens-style
// branch graph. No vscode/monaco/fs imports => unit-testable and host-agnostic.

export interface GraphInputCommit {
  sha: string;
  /** Parent shas, first parent first (the mainline). */
  parents: string[];
}

/**
 * A connection spanning ONE row vertically: it enters at the row's top edge in
 * `fromColumn` and exits at the row's bottom edge in `toColumn` — a straight
 * vertical when equal, a diagonal when the lane shifts. `color` is a lane-color
 * index in `0..colorCount-1`.
 */
export interface GraphSegment {
  fromColumn: number;
  toColumn: number;
  color: number;
}

export interface GraphRow {
  sha: string;
  /** The lane this commit's node sits in. */
  column: number;
  /** The commit's lane color (its first-parent lane keeps it). */
  color: number;
  parents: string[];
  /** parents.length > 1 */
  isMerge: boolean;
  /**
   * Every lane passing THROUGH this row: the node's own continuation, lanes
   * merely passing by, and the merge/branch diagonals into/out of the node's
   * column. Enough to draw the row's gutter on its own.
   */
  segments: GraphSegment[];
  /** Widest column index active in this row, for per-row width sizing. */
  maxColumn: number;
}

export interface GraphLayout {
  rows: GraphRow[];
  /** Max columns used across all rows (totalColumns = maxColumn + 1). */
  totalColumns: number;
}

interface Lane {
  /** The next commit sha this lane is waiting to reach. */
  sha: string;
  color: number;
}

/**
 * Computes lane columns, colors, and per-row segments for a commit DAG.
 *
 * Lanes are an ordered, sparse array (free slots are `null`). Each lane "waits"
 * for a particular sha — the next commit on that branch line. Processing
 * top→bottom, a commit takes the leftmost lane waiting for it (or a fresh lane
 * if it's a tip); other lanes waiting for it are merges that terminate here; its
 * first parent continues its lane, and extra parents open new lanes. Lane
 * columns are kept as stable as possible to avoid jitter.
 */
export function computeGraphLayout(
  commits: GraphInputCommit[],
  opts: { colorCount?: number } = {},
): GraphLayout {
  const colorCount = Math.max(1, opts.colorCount ?? 8);
  const lanes: (Lane | null)[] = [];
  let nextColor = 0;
  const rows: GraphRow[] = [];
  let totalColumns = 0;

  const allocColor = (): number => {
    const color = nextColor;
    nextColor = (nextColor + 1) % colorCount;
    return color;
  };

  /** First free slot, else a new slot appended on the right. */
  const claimSlot = (): number => {
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i] === null) {
        return i;
      }
    }
    lanes.push(null);
    return lanes.length - 1;
  };

  for (const commit of commits) {
    // 1. Snapshot the lane layout at the row's TOP edge (before this commit
    //    rewrites lanes). Segments are drawn from these top columns.
    const topColumns: (Lane | null)[] = lanes.slice();

    // 2. Find every lane waiting for this commit. The leftmost becomes the
    //    commit's column; the rest are branches merging in and terminate here.
    const waiting: number[] = [];
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]?.sha === commit.sha) {
        waiting.push(i);
      }
    }

    let column: number;
    let color: number;
    if (waiting.length > 0) {
      column = waiting[0];
      color = lanes[column]!.color;
    } else {
      // A branch tip / ref head with no child in the set: open a fresh lane.
      column = claimSlot();
      color = allocColor();
      lanes[column] = { sha: commit.sha, color };
    }

    // Free the extra incoming lanes (the merged-in branches end at this node).
    for (let k = 1; k < waiting.length; k++) {
      lanes[waiting[k]] = null;
    }

    // 3. Wire up parents. The node's own lane is cleared first, then each
    //    parent is placed:
    //    - If a lane already waits for that parent (shared parent / criss-cross
    //      / a sibling already opened it), connect to it — never duplicate.
    //    - Else the FIRST parent reuses the node's column, keeping the commit's
    //      color (the mainline continues straight down). Extra parents claim a
    //      fresh lane with a new color (a branch forking out to the right).
    const parents = commit.parents;
    lanes[column] = null;
    // The lane column each parent edge leaves the node toward, with its color.
    const parentTargets: { column: number; color: number }[] = [];

    for (let p = 0; p < parents.length; p++) {
      const parentSha = parents[p];
      const existing = lanes.findIndex(
        (lane) => lane !== null && lane.sha === parentSha,
      );
      let target: number;
      if (existing !== -1) {
        // Already awaited elsewhere: route this edge into that lane.
        target = existing;
      } else if (p === 0) {
        // Mainline continuation: reuse the node's column and keep its color.
        target = column;
        lanes[column] = { sha: parentSha, color };
      } else {
        target = claimSlot();
        lanes[target] = { sha: parentSha, color: allocColor() };
      }
      parentTargets.push({ column: target, color: lanes[target]!.color });
    }

    // 4. Compact: drop trailing empty lanes so the graph stays narrow without
    //    reshuffling interior lanes (interior stability beats minimal width).
    while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
      lanes.pop();
    }

    // 5. Build segments. Each lane present at the top OR bottom of the row
    //    contributes one segment from its top column to its bottom column.
    const segments: GraphSegment[] = [];

    // (a) Lanes that pass through or shift: present at top, still present at
    //     bottom (matched by the sha they're waiting for, or being the node's
    //     own continuation). The node's first-parent continuation is included.
    const bottomBySha = new Map<string, number>();
    for (let i = 0; i < lanes.length; i++) {
      const lane = lanes[i];
      if (lane && !bottomBySha.has(lane.sha)) {
        bottomBySha.set(lane.sha, i);
      }
    }

    const firstParentTarget = parentTargets[0];

    // (a) The node's own through-lane: a single full-row segment from the
    //     node's column down to where its FIRST parent continues — the node
    //     sits on it. Straight down when the first parent keeps the node's lane;
    //     a diagonal if the first parent was already awaited in another column.
    //     A root/boundary commit with no parents draws no continuation.
    if (firstParentTarget) {
      segments.push({
        fromColumn: column,
        toColumn: firstParentTarget.column,
        color: firstParentTarget.color,
      });
    }

    // (b) Branch-out edges: extra (merge) parents fork out of the node toward
    //     their lane columns — diagonals below the node.
    for (let p = 1; p < parentTargets.length; p++) {
      const out = parentTargets[p];
      segments.push({
        fromColumn: column,
        toColumn: out.column,
        color: out.color,
      });
    }

    // (c) Other lanes present at the row's top edge.
    for (let i = 0; i < topColumns.length; i++) {
      const top = topColumns[i];
      if (!top || i === column) {
        // The node's column is handled by its through-lane above.
        continue;
      }
      if (waiting.includes(i)) {
        // A branch merging INTO the node: diagonal from its top column into the
        // node's column (top half only — the branch ends at the node).
        segments.push({ fromColumn: i, toColumn: column, color: top.color });
        continue;
      }
      // A bystander lane: find where it sits at the bottom (same sha). Stable
      // columns yield a vertical; a compaction shift yields a diagonal.
      const bottom = bottomBySha.get(top.sha);
      if (bottom !== undefined) {
        segments.push({ fromColumn: i, toColumn: bottom, color: top.color });
      }
      // No bottom => the lane ended here with no node of its own (a boundary
      // parent that never appears). Drop it: nothing leaves the bottom edge.
    }

    // 6. Row width: widest column touched at top, bottom, or by the node.
    let maxColumn = column;
    for (let i = 0; i < topColumns.length; i++) {
      if (topColumns[i]) {
        maxColumn = Math.max(maxColumn, i);
      }
    }
    for (let i = 0; i < lanes.length; i++) {
      if (lanes[i]) {
        maxColumn = Math.max(maxColumn, i);
      }
    }
    for (const seg of segments) {
      maxColumn = Math.max(maxColumn, seg.fromColumn, seg.toColumn);
    }
    totalColumns = Math.max(totalColumns, maxColumn + 1);

    rows.push({
      sha: commit.sha,
      column,
      color,
      parents,
      isMerge: parents.length > 1,
      segments,
      maxColumn,
    });
  }

  return { rows, totalColumns };
}
