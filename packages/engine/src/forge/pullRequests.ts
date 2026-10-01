// A pull request's rules and words, shared by the VS Code extension and the
// desktop app — pure, no host import, each one unit-tested on its own
// (test/pullRequests.test.ts): what state a PR is in, what its checks add up
// to, what its reviews have decided, which lines of a changed file GitHub
// lets a review comment land on, and the exact review payload GitHub is sent.
//
// THE VOCABULARY. One table per fact — the word a surface shows, the codicon
// beside it and the TONE it is drawn in — so a PR reads the same in the
// extension's list, its PR page and the desktop's section. A tone is a role,
// not a colour: each host's stylesheet maps it to its own theme's ink
// (open → green, merged → purple, closed → red, draft → muted: the owner's
// table, memory issue-state-colors). The glyphs are codicons that exist,
// never invented marks, and every one travels with its words.

// The shapes are the wire's (host-bridge/prProtocol), so a row a host sends
// and the rules that fill it can't disagree.
import type { CiRollup, CiState, PrKind, ReviewDecision } from "@gitstudio/host-bridge/prProtocol";
import * as l10n from "@vscode/l10n";

export type { CiRollup, CiState, PrKind, ReviewDecision };

// ── State ─────────────────────────────────────────────────────────────────────

/** The fields a PR's display state is decided from. */
export interface PrStateFields {
  state: string;
  draft: boolean;
  mergedAt?: string | null;
}

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

/**
 * How a fact is drawn: the role its colour plays. Hosts map each to their
 * theme (the extension: charts-green / -purple / -red, descriptionForeground;
 * the desktop: --status-add, --gs-accent-ink, --status-del, --app-muted).
 */
export type PrTone = "open" | "merged" | "closed" | "draft" | "success" | "failure" | "pending" | "muted";

/** Word, codicon and colour class per state — one table, used everywhere a PR's state is drawn. */
export const PR_STATES: Record<PrKind, { word: string; codicon: string; cls: string; tone: PrTone }> = {
  open: { word: l10n.t("Open"), codicon: "git-pull-request", cls: "open", tone: "open" },
  draft: { word: l10n.t("Draft"), codicon: "git-pull-request-draft", cls: "draft", tone: "draft" },
  merged: { word: l10n.t("Merged"), codicon: "git-merge", cls: "merged", tone: "merged" },
  closed: { word: l10n.t("Closed"), codicon: "git-pull-request-closed", cls: "closed", tone: "closed" },
};

/** The desktop's name for the open kind (its stylesheet's `open-pr`). */
export function desktopPrKind(pr: PrStateFields): "open-pr" | "draft" | "merged" | "closed" {
  const k = prKind(pr);
  return k === "open" ? "open-pr" : k;
}

// ── Actions ─────────────────────────────────────────────────────────────────

/** Everything a pull request surface lets you do, by one name. */
export type PrActionId =
  | "open"
  | "checkout"
  | "review"
  | "approve"
  | "merge"
  | "markReady"
  | "updateBranch"
  | "close"
  | "reopen"
  | "copyLink"
  | "openOnGitHub"
  | "refresh"
  | "more"
  | "newPullRequest";

/**
 * The words and codicon for each action — the desktop's words, so a pull
 * request is acted on in the same words in both products: "Checkout", not
 * "Check Out"; "Mark ready", "Update branch", "Copy link" in sentence case;
 * "Merge" and "Review" plain, a chevron beside them where they open a box or a
 * menu. `title` is what the control says on hover, in words.
 */
export const PR_ACTIONS: Record<PrActionId, { label: string; icon: string; title: string }> = {
  open: { label: l10n.t("Open"), icon: "git-pull-request", title: l10n.t("Open the pull request's page") },
  checkout: { label: l10n.t("Checkout"), icon: "git-branch", title: l10n.t("Check out its branch here, tracking it on GitHub, so a push reaches the pull request") },
  review: { label: l10n.t("Review"), icon: "comment", title: l10n.t("Comment, approve or request changes") },
  approve: { label: l10n.t("Approve"), icon: "check", title: l10n.t("Approve this pull request — opens the review box") },
  merge: { label: l10n.t("Merge"), icon: "git-merge", title: l10n.t("Merge this pull request — choose how") },
  markReady: { label: l10n.t("Mark ready"), icon: "eye", title: l10n.t("Convert this draft to ready for review") },
  updateBranch: { label: l10n.t("Update branch"), icon: "git-merge", title: l10n.t("Merge the base branch into this one, on GitHub") },
  close: { label: l10n.t("Close pull request"), icon: "git-pull-request-closed", title: l10n.t("Close it without merging (you can reopen it)") },
  reopen: { label: l10n.t("Reopen pull request"), icon: "git-pull-request", title: l10n.t("Reopen this pull request") },
  copyLink: { label: l10n.t("Copy link"), icon: "copy", title: l10n.t("Copy the pull request's link") },
  openOnGitHub: { label: l10n.t("Open on GitHub"), icon: "link-external", title: l10n.t("Open this pull request on GitHub") },
  refresh: { label: l10n.t("Refresh"), icon: "refresh", title: l10n.t("Read the pull request again") },
  more: { label: l10n.t("More actions"), icon: "ellipsis", title: l10n.t("More actions") },
  newPullRequest: { label: l10n.t("New pull request"), icon: "git-pull-request", title: l10n.t("Open a new pull request") },
};

/** A pull request page's sections — the desktop's tabs, in its words and glyphs. */
export const PR_TABS = {
  conversation: { label: l10n.t("Conversation"), icon: "comment-discussion" },
  commits: { label: l10n.t("Commits"), icon: "git-commit" },
  checks: { label: l10n.t("Checks"), icon: "play" },
  files: { label: l10n.t("Files"), icon: "code" },
} as const;

// ── Reviews ─────────────────────────────────────────────────────────────────

/**
 * What a PR's reviews add up to, as GitHub decides it (GraphQL's
 * `reviewDecision`): null when the repository requires no review and nobody
 * has approved or asked for changes.
 */
export const REVIEW_DECISIONS: Record<ReviewDecision, { word: string; codicon: string; tone: PrTone }> = {
  APPROVED: { word: "Approved", codicon: "check", tone: "success" },
  CHANGES_REQUESTED: { word: l10n.t("Changes requested"), codicon: "request-changes", tone: "failure" },
  REVIEW_REQUIRED: { word: l10n.t("Review required"), codicon: "eye", tone: "pending" },
};

/** GraphQL's answer → ours; anything else (null, a value GitHub adds later) is none. */
export function reviewDecisionOf(v: unknown): ReviewDecision | undefined {
  return v === "APPROVED" || v === "CHANGES_REQUESTED" || v === "REVIEW_REQUIRED" ? v : undefined;
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

/** The three verdicts a reviewer submits — the words both products' review boxes offer. */
export const REVIEW_VERDICTS: ReadonlyArray<{ event: ReviewEvent; label: string; icon: string; hint: string }> = [
  { event: "COMMENT", label: l10n.t("Comment"), icon: "comment", hint: l10n.t("Feedback without an explicit approval") },
  { event: "APPROVE", label: l10n.t("Approve"), icon: "check", hint: l10n.t("The change is good to merge") },
  { event: "REQUEST_CHANGES", label: l10n.t("Request changes"), icon: "request-changes", hint: l10n.t("Must be addressed before merging") },
];

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

/**
 * A commit's checks, per state: the sentence, the one word a row has room
 * for, the codicon and the tone. The glyphs are the desktop's (and VS Code's
 * own GitHub extension's): a check, a cross, the sync arrows — one weight,
 * colour doing the rest, so red and green are never the only difference.
 */
export const CI_STATES: Record<CiState, { word: string; short: string; codicon: string; tone: PrTone }> = {
  success: { word: l10n.t("Checks passed"), short: "Passed", codicon: "check", tone: "success" },
  failure: { word: l10n.t("Checks failed"), short: "Failed", codicon: "close", tone: "failure" },
  pending: { word: l10n.t("Checks running"), short: "Running", codicon: "sync", tone: "pending" },
  none: { word: l10n.t("No checks"), short: l10n.t("No checks"), codicon: "circle-slash", tone: "muted" },
};

/** Check-run states GitHub counts as failed (its merge box's reading). */
const FAILED_RUN_STATES = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "CANCELLED"]);
const PENDING_RUN_STATES = new Set(["IN_PROGRESS", "PENDING", "QUEUED", "WAITING", "REQUESTED"]);

/** One `{ state, count }` of GraphQL's checkRunCountsByState / statusContextCountsByState. */
export interface StateCount {
  state?: string | null;
  count?: number | null;
}

/**
 * GraphQL's `statusCheckRollup` → a rollup with counts. The STATE is GitHub's
 * own (it already weighs check runs and statuses together); the counts —
 * from `contexts { checkRunCountsByState, statusContextCountsByState }` —
 * only say how many, for the words. A rollup that is absent means the
 * commit has no checks at all.
 */
export function ciFromRollup(
  rollup:
    | {
        state?: string | null;
        contexts?: {
          checkRunCountsByState?: readonly StateCount[] | null;
          statusContextCountsByState?: readonly StateCount[] | null;
        } | null;
      }
    | null
    | undefined,
): CiRollup {
  const state = ciFromRollupState(rollup?.state);
  let total = 0;
  let failed = 0;
  let pending = 0;
  for (const c of rollup?.contexts?.checkRunCountsByState ?? []) {
    const n = Math.max(0, Number(c.count) || 0);
    total += n;
    if (FAILED_RUN_STATES.has(c.state ?? "")) failed += n;
    else if (PENDING_RUN_STATES.has(c.state ?? "")) pending += n;
  }
  for (const c of rollup?.contexts?.statusContextCountsByState ?? []) {
    const n = Math.max(0, Number(c.count) || 0);
    total += n;
    if (c.state === "FAILURE" || c.state === "ERROR") failed += n;
    else if (c.state === "PENDING" || c.state === "EXPECTED") pending += n;
  }
  return { state, total, failed, pending };
}

/** What the checks say, in words. */
export function ciWords(ci: CiRollup | CiState): string {
  const r = typeof ci === "string" ? undefined : ci;
  const state = typeof ci === "string" ? ci : ci.state;
  // Counts that don't back the state (GitHub's state is the authority; the
  // counts are a separate read) fall back to the plain sentence rather than
  // "0 of 5 checks failed".
  const counted = (n: number | undefined) => r !== undefined && r.total > 0 && (n ?? 0) > 0;
  switch (state) {
    case "success":
      return r && r.total > 0
        ? r.total === 1
          ? l10n.t("All 1 check passed")
          : l10n.t("All {0} checks passed", r.total)
        : l10n.t("Checks passed");
    case "failure":
      return counted(r?.failed) && r ? `${r.failed} of ${r.total} check${r.total === 1 ? "" : "s"} failed` : l10n.t("Checks failed");
    case "pending":
      return counted(r?.pending) && r ? `${r.pending} of ${r.total} check${r.total === 1 ? "" : "s"} running` : l10n.t("Checks running");
    default:
      return l10n.t("No checks");
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
