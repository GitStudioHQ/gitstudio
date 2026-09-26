// The pull request feature's pure rules — no `vscode` import, so each one is
// unit-tested on its own (test/prModel.test.ts): what state a PR is in, what
// its checks add up to, which lines of a changed file GitHub lets a review
// comment land on, and the exact review payload GitHub is sent.
//
// The words and precedence follow the desktop app's (renderer/views/prs.ts:
// rollupChecks, prKind, sideFor; main/github/prs.ts: prReview), so a PR reads
// the same in both products.

// ── State ─────────────────────────────────────────────────────────────────────

/** The fields a PR's display state is decided from. */
export interface PrStateFields {
  state: string;
  draft: boolean;
  mergedAt?: string | null;
}

export type PrKind = "open" | "draft" | "merged" | "closed";

/**
 * The PR's display state: merged beats closed beats draft beats open.
 * GitHub has no "merged" state — a merged PR is `closed` with `merged_at` set —
 * so a closed PR without it was closed WITHOUT merging, and must not read as
 * merged.
 */
export function prKind(pr: PrStateFields): PrKind {
  if (pr.mergedAt) return "merged";
  if (pr.state === "closed") return "closed";
  if (pr.draft) return "draft";
  return "open";
}

/** Word, codicon and colour class per state — one table, used everywhere a PR's state is drawn. */
export const PR_STATES: Record<PrKind, { word: string; codicon: string; cls: string }> = {
  open: { word: "Open", codicon: "git-pull-request", cls: "open" },
  draft: { word: "Draft", codicon: "git-pull-request-draft", cls: "draft" },
  merged: { word: "Merged", codicon: "git-merge", cls: "merged" },
  closed: { word: "Closed", codicon: "git-pull-request-closed", cls: "closed" },
};

// ── Checks ────────────────────────────────────────────────────────────────────

/** One GitHub Actions / Checks API run. */
export interface CheckRunLike {
  status?: string | null;
  conclusion?: string | null;
}

/** One legacy commit status (the Statuses API). */
export interface StatusLike {
  state?: string | null;
}

export type CiState = "success" | "failure" | "pending" | "none";

export interface CiRollup {
  state: CiState;
  total: number;
  failed: number;
  pending: number;
}

const FAILED_CONCLUSIONS = new Set([
  "failure",
  "timed_out",
  "action_required",
  "startup_failure",
  "cancelled",
]);

/**
 * One state for a commit's checks: its check runs (GitHub Actions and every
 * other Checks API app) AND its legacy statuses. Any failure wins, then
 * anything still running, then success — the precedence GitHub's merge box
 * uses. "none" only when there is neither.
 *
 * The combined-status endpoint alone answers `pending` with total_count 0 for
 * a commit that has no legacy statuses — every repository on GitHub Actions —
 * so reading it alone painted a FAILED run as "running" and a passed one as
 * "No checks".
 */
export function rollupCi(
  runs: readonly CheckRunLike[],
  statuses: readonly StatusLike[],
): CiRollup {
  let failed = 0;
  let pending = 0;
  for (const r of runs) {
    if (FAILED_CONCLUSIONS.has(r.conclusion ?? "")) failed++;
    else if (!r.conclusion || /queued|in_progress|waiting|pending|requested/.test(r.status ?? "")) pending++;
  }
  for (const s of statuses) {
    if (s.state === "failure" || s.state === "error") failed++;
    else if (s.state !== "success") pending++;
  }
  const total = runs.length + statuses.length;
  const state: CiState =
    total === 0 ? "none" : failed > 0 ? "failure" : pending > 0 ? "pending" : "success";
  return { state, total, failed, pending };
}

/**
 * GraphQL's `statusCheckRollup.state` (which already combines check runs and
 * statuses) → ours. A commit with no checks at all has no rollup (null).
 */
export function ciFromRollupState(state: string | null | undefined): CiState {
  switch (state) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "ERROR":
      return "failure";
    case "PENDING":
    case "EXPECTED":
      return "pending";
    default:
      return "none";
  }
}

/** What the checks say, in words. */
export function ciWords(ci: CiRollup | CiState): string {
  const r = typeof ci === "string" ? undefined : ci;
  const state = typeof ci === "string" ? ci : ci.state;
  switch (state) {
    case "success":
      return r ? `All ${r.total} check${r.total === 1 ? "" : "s"} passed` : "Checks passed";
    case "failure":
      return r ? `${r.failed} of ${r.total} check${r.total === 1 ? "" : "s"} failed` : "Checks failed";
    case "pending":
      return r ? `${r.pending} of ${r.total} check${r.total === 1 ? "" : "s"} running` : "Checks running";
    default:
      return "No checks";
  }
}

// ── Where a review comment can go ───────────────────────────────────────────

/** Inclusive, 1-based line spans. */
export type LineSpan = [start: number, end: number];

export interface HunkSpans {
  /** Lines of the BASE version the diff shows (context and removed lines). */
  left: LineSpan[];
  /** Lines of the HEAD version the diff shows (context and added lines). */
  right: LineSpan[];
}

/**
 * The lines a file's unified-diff `patch` covers, per side. GitHub accepts a
 * review comment only on a line inside a diff hunk — anywhere else the whole
 * review is refused (422) — so these are the only commentable lines. A file
 * GitHub sends no patch for (binary, or too large to diff) has none.
 */
export function hunkSpans(patch: string | undefined): HunkSpans {
  const out: HunkSpans = { left: [], right: [] };
  if (!patch) return out;
  const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  for (const m of patch.matchAll(header)) {
    const oldStart = Number(m[1]);
    const oldCount = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newCount = m[4] === undefined ? 1 : Number(m[4]);
    if (oldCount > 0) out.left.push([oldStart, oldStart + oldCount - 1]);
    if (newCount > 0) out.right.push([newStart, newStart + newCount - 1]);
  }
  return out;
}

/** True when every line from `start` to `end` lies inside ONE span. */
export function withinOneSpan(spans: readonly LineSpan[], start: number, end: number): boolean {
  return spans.some(([a, b]) => start >= a && end <= b);
}

// ── The review GitHub is sent ──────────────────────────────────────────────

export type ReviewSide = "LEFT" | "RIGHT";

/** One queued line comment, as the review queue holds it. */
export interface QueuedComment {
  path: string;
  /** 1-based; the LAST line of a multi-line comment. */
  line: number;
  /** 1-based first line of a multi-line comment; absent for one line. */
  startLine?: number;
  side: ReviewSide;
  body: string;
}

export interface ReviewPayload {
  event: string;
  body: string;
  commit_id?: string;
  comments: Array<{
    path: string;
    line: number;
    side: ReviewSide;
    start_line?: number;
    start_side?: ReviewSide;
    body: string;
  }>;
}

/**
 * The POST body for `pulls/{n}/reviews`. `commitId` is the head the diffs
 * showed: without it GitHub applies the line numbers to the PR's LATEST head,
 * so a push during the review moved every comment onto whatever code now sits
 * at those lines. A multi-line comment is `start_line` + `line` (GitHub's
 * names), both on the comment's side.
 */
export function reviewPayload(input: {
  event: string;
  body?: string;
  commitId?: string;
  comments: readonly QueuedComment[];
}): ReviewPayload {
  return {
    event: input.event,
    body: input.body ?? "",
    ...(input.commitId ? { commit_id: input.commitId } : {}),
    comments: input.comments.map((c) => ({
      path: c.path,
      line: c.line,
      side: c.side,
      ...(c.startLine !== undefined && c.startLine !== c.line
        ? { start_line: c.startLine, start_side: c.side }
        : {}),
      body: c.body,
    })),
  };
}

/**
 * The queued comments GitHub would refuse — each named `path:line` — because
 * they sit outside every hunk on their side. One of them fails the whole
 * review, so they are found before anything is sent.
 */
export function commentsOutsideHunks(
  comments: readonly QueuedComment[],
  patchFor: (path: string) => string | undefined,
): string[] {
  const bad: string[] = [];
  for (const c of comments) {
    const spans = hunkSpans(patchFor(c.path));
    const side = c.side === "LEFT" ? spans.left : spans.right;
    if (!withinOneSpan(side, c.startLine ?? c.line, c.line)) {
      bad.push(`${c.path}:${c.startLine && c.startLine !== c.line ? `${c.startLine}-` : ""}${c.line}`);
    }
  }
  return bad;
}

/** The key a PR is known by: a number is only unique within its repository. */
export function prKey(owner: string, repo: string, n: number): string {
  return `${owner}/${repo}#${n}`;
}
