// A pull request's page — its data and its rules — shared by the VS Code
// extension's PR page and, when it mounts the same component, the desktop's.
// Pure: the GraphQL transport is handed in (each product has its own
// authenticated client), so what is asked, what an answer means and what
// the page may offer in each state are unit-tested without a network
// (test/prPage.test.ts).
//
// ONE QUESTION for the page: the header, the reviewers with their verdicts,
// the timeline (comments, reviews, and what happened), the review threads,
// the commits, every check on the head, and what the viewer may do — the
// repository's merge methods, their permission, whether they wrote it. The
// changed files are REST's (their patches decide where a review comment may
// go), asked beside it.
//
// THE RULES. What the header offers (prPageActions) and what the merge box
// says (mergeBoxOf) are functions of the pull request alone, so every cell
// of the state table — kind × permission × authorship × merge state — is a
// test of one call, not of a rendered page.

import type {
  CiRollup,
  CiState,
  PrCheck,
  PrCheckState,
  PrCommit,
  PrDetail,
  PrMergeMethod,
  PrMergeState,
  PrPageFile,
  PrPermission,
  PrPerson,
  PrReviewer,
  PrReviewState,
  PrThread,
  PrTimelineEvent,
  PrTimelineItem,
} from "@gitstudio/host-bridge/prProtocol";
import { PR_ACTIONS, ciFromRollupState, prKind, reviewDecisionOf, type PrTone } from "./pullRequests";
import { PrListError, type GraphqlFn } from "./prList";
import * as l10n from "@vscode/l10n";

export type { PrDetail, PrMergeMethod, PrMergeState, PrCheck, PrCheckState, PrThread, PrTimelineItem, PrPageFile };

// ── The question ─────────────────────────────────────────────────────────────

const PERSON = "login avatarUrl(size: 40)";

/** What the page asks GitHub for one pull request (checked against the live API, read-only). */
export const PR_PAGE_QUERY = `query($owner: String!, $name: String!, $n: Int!) {
  viewer { ${PERSON} }
  repository(owner: $owner, name: $name) {
    nameWithOwner viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod
    pullRequest(number: $n) {
      id number title body url state isDraft mergedAt closedAt createdAt updatedAt
      author { ${PERSON} }
      mergedBy { ${PERSON} }
      headRefName headRefOid baseRefName baseRefOid isCrossRepository maintainerCanModify
      headRepositoryOwner { login }
      headRepository { nameWithOwner url }
      additions deletions changedFiles
      mergeStateStatus reviewDecision
      viewerDidAuthor viewerCanUpdate viewerCanUpdateBranch viewerCanDeleteHeadRef
      labels(first: 20) { nodes { name color } }
      assignees(first: 10) { nodes { ${PERSON} } }
      reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { ${PERSON} } ... on Team { slug } ... on Bot { login } ... on Mannequin { login } } } }
      latestReviews(first: 30) { nodes { state author { ${PERSON} } } }
      commits(last: 100) { totalCount nodes { commit { oid abbreviatedOid messageHeadline messageBody committedDate author { name user { ${PERSON} } } statusCheckRollup { state } } } }
      checks: commits(last: 1) { nodes { commit { oid statusCheckRollup { state contexts(first: 100) { totalCount nodes { __typename
        ... on CheckRun { name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber: $n) checkSuite { app { name } workflowRun { workflow { name } } } }
        ... on StatusContext { context state description targetUrl createdAt isRequired(pullRequestNumber: $n) } } } } } } }
      timelineItems(last: 100, itemTypes: [ISSUE_COMMENT, PULL_REQUEST_REVIEW, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT, READY_FOR_REVIEW_EVENT, CONVERT_TO_DRAFT_EVENT, HEAD_REF_FORCE_PUSHED_EVENT, REVIEW_REQUESTED_EVENT, REVIEW_DISMISSED_EVENT]) {
        totalCount
        nodes { __typename
          ... on IssueComment { id author { ${PERSON} } body createdAt url }
          ... on PullRequestReview { id author { ${PERSON} } state body submittedAt createdAt url }
          ... on MergedEvent { id actor { ${PERSON} } createdAt commit { abbreviatedOid } }
          ... on ClosedEvent { id actor { ${PERSON} } createdAt }
          ... on ReopenedEvent { id actor { ${PERSON} } createdAt }
          ... on ReadyForReviewEvent { id actor { ${PERSON} } createdAt }
          ... on ConvertToDraftEvent { id actor { ${PERSON} } createdAt }
          ... on HeadRefForcePushedEvent { id actor { ${PERSON} } createdAt beforeCommit { abbreviatedOid } afterCommit { abbreviatedOid } }
          ... on ReviewRequestedEvent { id actor { ${PERSON} } createdAt requestedReviewer { __typename ... on User { login } ... on Team { slug } ... on Bot { login } ... on Mannequin { login } } }
          ... on ReviewDismissedEvent { id actor { ${PERSON} } createdAt }
        }
      }
      reviewThreads(first: 100) {
        totalCount
        nodes { id path line startLine originalLine diffSide isResolved isOutdated viewerCanResolve viewerCanUnresolve viewerCanReply
          resolvedBy { login }
          comments(first: 50) { totalCount nodes { id author { ${PERSON} } body createdAt url pullRequestReview { id } } }
        }
      }
    }
  }
}`;

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;

/** Read a pull request's page: one GraphQL request. */
export async function fetchPrPage(graphql: GraphqlFn, owner: string, repo: string, n: number): Promise<PrDetail> {
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo)) {
    throw new PrListError(l10n.t("\"{0}/{1}\" isn't a GitHub repository name.", owner, repo), "query");
  }
  if (!Number.isSafeInteger(n) || n <= 0) throw new PrListError(l10n.t("#{0} isn't a pull request number.", n), "query");
  return parsePrPage(owner, repo, n, await graphql(PR_PAGE_QUERY, { owner, name: repo, n }));
}

// ── The answer ───────────────────────────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub's JSON, read field by field */
type Json = any;

function person(u: Json): PrPerson | null {
  if (!u || typeof u.login !== "string") return null;
  return { login: u.login, avatarUrl: typeof u.avatarUrl === "string" ? u.avatarUrl : null };
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

const MERGE_STATES = new Set<PrMergeState>(["CLEAN", "UNSTABLE", "HAS_HOOKS", "BEHIND", "BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"]);
const PERMISSIONS = new Set<PrPermission>(["ADMIN", "MAINTAIN", "WRITE", "TRIAGE", "READ"]);
const REVIEW_STATES = new Set<PrReviewState>(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]);

function mergeStateOf(v: unknown): PrMergeState {
  return MERGE_STATES.has(v as PrMergeState) ? (v as PrMergeState) : "UNKNOWN";
}

function reviewStateOf(v: unknown): PrReviewState {
  return REVIEW_STATES.has(v as PrReviewState) ? (v as PrReviewState) : "COMMENTED";
}

function methodOf(v: unknown): PrMergeMethod | undefined {
  return v === "MERGE" ? "merge" : v === "SQUASH" ? "squash" : v === "REBASE" ? "rebase" : undefined;
}

/** A check run's (or a status's) result, in the page's six words. */
export function checkStateOf(typename: string, status: unknown, conclusion: unknown): PrCheckState {
  if (typename === "StatusContext") {
    // A status has one field: `status` is its state.
    if (status === "SUCCESS") return "success";
    if (status === "FAILURE" || status === "ERROR") return "failure";
    return "pending";
  }
  if (status !== "COMPLETED") return "pending";
  switch (conclusion) {
    case "SUCCESS":
      return "success";
    case "FAILURE":
    case "TIMED_OUT":
    case "ACTION_REQUIRED":
    case "STARTUP_FAILURE":
      return "failure";
    case "CANCELLED":
      return "cancelled";
    case "SKIPPED":
      return "skipped";
    default:
      return "neutral";
  }
}

const CHECK_ORDER: Record<PrCheckState, number> = { failure: 0, pending: 1, cancelled: 2, success: 3, neutral: 4, skipped: 5 };

function mapCheck(c: Json): PrCheck | null {
  if (!c) return null;
  if (c.__typename === "CheckRun") {
    const state = checkStateOf("CheckRun", c.status, c.conclusion);
    return {
      name: str(c.name, "Check"),
      ...(typeof c.checkSuite?.workflowRun?.workflow?.name === "string" ? { workflow: c.checkSuite.workflowRun.workflow.name } : {}),
      ...(typeof c.checkSuite?.app?.name === "string" ? { app: c.checkSuite.app.name } : {}),
      state,
      raw: str(c.status === "COMPLETED" ? c.conclusion : c.status),
      ...(typeof c.startedAt === "string" ? { startedAt: c.startedAt } : {}),
      ...(typeof c.completedAt === "string" && c.status === "COMPLETED" ? { completedAt: c.completedAt } : {}),
      ...(typeof c.detailsUrl === "string" && c.detailsUrl ? { url: c.detailsUrl } : {}),
      required: c.isRequired === true,
    };
  }
  if (c.__typename === "StatusContext") {
    return {
      name: str(c.context, "Status"),
      state: checkStateOf("StatusContext", c.state, undefined),
      raw: str(c.state),
      ...(typeof c.createdAt === "string" ? { startedAt: c.createdAt } : {}),
      ...(typeof c.targetUrl === "string" && c.targetUrl ? { url: c.targetUrl } : {}),
      required: c.isRequired === true,
      ...(typeof c.description === "string" && c.description ? { description: c.description } : {}),
    };
  }
  return null;
}

/** The order the Checks tab lists them in: what failed, what runs, then the rest; by name within. */
export function sortChecks(checks: readonly PrCheck[]): PrCheck[] {
  return [...checks].sort(
    (a, b) =>
      CHECK_ORDER[a.state] - CHECK_ORDER[b.state] ||
      Number(b.required) - Number(a.required) ||
      `${a.workflow ?? a.app ?? ""} ${a.name}`.localeCompare(`${b.workflow ?? b.app ?? ""} ${b.name}`),
  );
}

/** A head's checks, counted: GitHub's state, and how many failed and run. */
export function ciOfChecks(state: unknown, checks: readonly PrCheck[]): CiRollup {
  let failed = 0;
  let pending = 0;
  for (const c of checks) {
    if (c.state === "failure") failed++;
    else if (c.state === "pending") pending++;
  }
  const s: CiState = checks.length === 0 && (state === null || state === undefined) ? "none" : ciFromRollupState(str(state));
  return { state: s, total: checks.length, failed, pending };
}

function mapEvent(n: Json): PrTimelineItem | null {
  const at = str(n.createdAt);
  const base = { kind: "event" as const, id: str(n.id, `${n.__typename}-${at}`), actor: person(n.actor), createdAt: at };
  switch (n.__typename) {
    case "MergedEvent":
      return { ...base, event: "merged", ...(n.commit?.abbreviatedOid ? { detail: String(n.commit.abbreviatedOid) } : {}) };
    case "ClosedEvent":
      return { ...base, event: "closed" };
    case "ReopenedEvent":
      return { ...base, event: "reopened" };
    case "ReadyForReviewEvent":
      return { ...base, event: "ready" };
    case "ConvertToDraftEvent":
      return { ...base, event: "draft" };
    case "HeadRefForcePushedEvent": {
      const from = n.beforeCommit?.abbreviatedOid;
      const to = n.afterCommit?.abbreviatedOid;
      return { ...base, event: "forcePushed", ...(from && to ? { detail: `${from}→${to}` } : {}) };
    }
    case "ReviewRequestedEvent": {
      const who = n.requestedReviewer;
      const name = who?.__typename === "Team" ? who?.slug : who?.login;
      return { ...base, event: "reviewRequested", ...(typeof name === "string" ? { detail: name } : {}) };
    }
    case "ReviewDismissedEvent":
      return { ...base, event: "reviewDismissed" };
  }
  return null;
}

function mapTimeline(nodes: Json[]): PrTimelineItem[] {
  const out: PrTimelineItem[] = [];
  for (const n of nodes ?? []) {
    if (!n) continue;
    if (n.__typename === "IssueComment") {
      out.push({ kind: "comment", id: str(n.id), author: person(n.author), body: str(n.body), createdAt: str(n.createdAt), url: str(n.url) });
    } else if (n.__typename === "PullRequestReview") {
      const state = reviewStateOf(n.state);
      // Your review in progress on github.com is yours to finish there; the
      // page's own pending review is the one GitStudio keeps.
      if (state === "PENDING") continue;
      out.push({
        kind: "review",
        id: str(n.id),
        author: person(n.author),
        state,
        body: str(n.body),
        createdAt: str(n.submittedAt ?? n.createdAt),
        url: str(n.url),
      });
    } else {
      const e = mapEvent(n);
      if (e) out.push(e);
    }
  }
  return out;
}

function mapThreads(nodes: Json[]): PrThread[] {
  const out: PrThread[] = [];
  for (const t of nodes ?? []) {
    if (!t || typeof t.id !== "string") continue;
    const comments = (t.comments?.nodes ?? [])
      .filter((c: Json) => c && typeof c.id === "string")
      .map((c: Json) => ({ id: c.id, author: person(c.author), body: str(c.body), createdAt: str(c.createdAt), url: str(c.url) }));
    const reviewId = t.comments?.nodes?.[0]?.pullRequestReview?.id;
    out.push({
      id: t.id,
      path: str(t.path),
      line: typeof t.line === "number" ? t.line : null,
      startLine: typeof t.startLine === "number" ? t.startLine : null,
      originalLine: typeof t.originalLine === "number" ? t.originalLine : null,
      side: t.diffSide === "LEFT" ? "LEFT" : "RIGHT",
      resolved: t.isResolved === true,
      outdated: t.isOutdated === true,
      ...(typeof t.resolvedBy?.login === "string" ? { resolvedBy: t.resolvedBy.login } : {}),
      canResolve: t.viewerCanResolve === true,
      canUnresolve: t.viewerCanUnresolve === true,
      canReply: t.viewerCanReply === true,
      ...(typeof reviewId === "string" ? { reviewId } : {}),
      comments,
      totalComments: Math.max(num(t.comments?.totalCount), comments.length),
    });
  }
  return out;
}

function mapCommits(nodes: Json[]): PrCommit[] {
  const out: PrCommit[] = [];
  for (const n of nodes ?? []) {
    const c = n?.commit;
    if (!c || typeof c.oid !== "string") continue;
    out.push({
      sha: c.oid,
      shortSha: str(c.abbreviatedOid, c.oid.slice(0, 7)),
      headline: str(c.messageHeadline),
      body: str(c.messageBody),
      author: person(c.author?.user),
      authorName: str(c.author?.name, c.author?.user?.login ?? ""),
      committedAt: str(c.committedDate),
      ci: c.statusCheckRollup ? ciFromRollupState(c.statusCheckRollup.state) : "none",
    });
  }
  return out;
}

/**
 * Who reviews it: everyone asked (people and teams) and everyone who has
 * answered, each with their latest verdict. The REST `requested_reviewers`
 * drops a reviewer the moment they answer — an approved pull request showed
 * no approver.
 */
function mapReviewers(requests: Json[], latest: Json[], author: string | undefined): PrReviewer[] {
  const out = new Map<string, PrReviewer>();
  for (const r of latest ?? []) {
    const who = person(r?.author);
    if (!who) continue;
    const state = reviewStateOf(r.state);
    if (state === "PENDING") continue;
    if (author && who.login.toLowerCase() === author.toLowerCase() && state === "COMMENTED") continue; // replies on their own
    out.set(`u:${who.login.toLowerCase()}`, { login: who.login, avatarUrl: who.avatarUrl, verdict: state, requested: false });
  }
  for (const r of requests ?? []) {
    const who = r?.requestedReviewer;
    if (!who) continue;
    if (who.__typename === "Team" && typeof who.slug === "string") {
      out.set(`t:${who.slug.toLowerCase()}`, { team: who.slug, requested: true });
    } else if (typeof who.login === "string") {
      const key = `u:${who.login.toLowerCase()}`;
      const had = out.get(key);
      // Asked again after answering: their last verdict stands beside the ask.
      out.set(key, { ...(had ?? {}), login: who.login, avatarUrl: who.avatarUrl ?? had?.avatarUrl ?? null, requested: true });
    }
  }
  return [...out.values()];
}

/** GitHub's answer → the page's pull request. */
export function parsePrPage(owner: string, repo: string, n: number, res: { data?: unknown; errors?: readonly { type?: string; message?: string }[] }): PrDetail {
  const data = (res.data ?? null) as Json;
  const errors = res.errors;
  const limited = errors?.find((e) => e.type === "RATE_LIMITED");
  if (limited) throw new PrListError(limited.message || l10n.t("GitHub's rate limit was reached. Try again in a few minutes."), "rate-limit");
  const r = data?.repository;
  const where = `${owner}/${repo}`;
  if (!r) {
    const forbidden = errors?.find((e) => e.type === "FORBIDDEN");
    if (forbidden) throw new PrListError(forbidden.message || l10n.t("GitHub refused to show {0}.", where), "forbidden");
    if (errors?.some((e) => e.type === "NOT_FOUND") || (data && data.repository === null)) {
      throw new PrListError(l10n.t("GitHub has no repository {0} — or this sign-in can't see it.", where), "not-found");
    }
    throw new PrListError(errors?.[0]?.message || l10n.t("GitHub couldn't answer the query."), "query");
  }
  const p = r.pullRequest;
  if (!p) throw new PrListError(l10n.t("{0} has no pull request #{1}.", where, n), "not-found");
  const state: "open" | "closed" = p.state === "OPEN" ? "open" : "closed";
  const draft = p.isDraft === true;
  const mergedAt = typeof p.mergedAt === "string" ? p.mergedAt : null;
  const author = person(p.author);
  const headRollup = p.checks?.nodes?.[0]?.commit?.statusCheckRollup;
  const checks = sortChecks((headRollup?.contexts?.nodes ?? []).map(mapCheck).filter((c: PrCheck | null): c is PrCheck => c !== null));
  const methods: PrMergeMethod[] = [];
  if (r.mergeCommitAllowed !== false) methods.push("merge");
  if (r.squashMergeAllowed !== false) methods.push("squash");
  if (r.rebaseMergeAllowed !== false) methods.push("rebase");
  const permission: PrPermission = PERMISSIONS.has(r.viewerPermission) ? r.viewerPermission : "READ";
  const viewer = person(data?.viewer);
  const defaultMethod = methodOf(r.viewerDefaultMergeMethod);
  return {
    id: str(p.id),
    number: num(p.number) || n,
    title: str(p.title),
    body: str(p.body),
    url: str(p.url, `https://github.com/${where}/pull/${n}`),
    kind: prKind({ state, draft, mergedAt }),
    draft,
    state,
    mergedAt,
    closedAt: typeof p.closedAt === "string" ? p.closedAt : null,
    createdAt: str(p.createdAt),
    updatedAt: str(p.updatedAt, str(p.createdAt)),
    author,
    mergedBy: person(p.mergedBy),
    headRef: str(p.headRefName),
    headSha: str(p.headRefOid),
    headOwner: typeof p.headRepositoryOwner?.login === "string" ? p.headRepositoryOwner.login : null,
    headRepo: typeof p.headRepository?.nameWithOwner === "string" ? p.headRepository.nameWithOwner : null,
    baseRef: str(p.baseRefName),
    baseSha: str(p.baseRefOid),
    isFork: p.isCrossRepository === true,
    maintainerCanModify: p.maintainerCanModify === true,
    additions: num(p.additions),
    deletions: num(p.deletions),
    changedFiles: num(p.changedFiles),
    commitCount: num(p.commits?.totalCount),
    mergeState: mergeStateOf(p.mergeStateStatus),
    ...(reviewDecisionOf(p.reviewDecision) ? { reviewDecision: reviewDecisionOf(p.reviewDecision) } : {}),
    labels: (p.labels?.nodes ?? [])
      .filter((l: Json) => l && typeof l.name === "string")
      .map((l: Json) => ({ name: l.name, color: /^[0-9a-fA-F]{6}$/.test(String(l.color)) ? String(l.color) : "888888" })),
    assignees: (p.assignees?.nodes ?? []).map(person).filter((x: PrPerson | null): x is PrPerson => x !== null),
    reviewers: mapReviewers(p.reviewRequests?.nodes, p.latestReviews?.nodes, author?.login),
    ci: ciOfChecks(headRollup?.state, checks),
    timeline: mapTimeline(p.timelineItems?.nodes),
    timelineTotal: num(p.timelineItems?.totalCount),
    threads: mapThreads(p.reviewThreads?.nodes),
    threadsTotal: num(p.reviewThreads?.totalCount),
    commits: mapCommits(p.commits?.nodes),
    checks,
    checksTotal: Math.max(num(headRollup?.contexts?.totalCount), checks.length),
    viewer: {
      ...(viewer ? { login: viewer.login, avatarUrl: viewer.avatarUrl } : {}),
      permission,
      isAuthor: p.viewerDidAuthor === true,
      canUpdate: p.viewerCanUpdate === true,
      canUpdateBranch: p.viewerCanUpdateBranch === true,
      canDeleteBranch: p.viewerCanDeleteHeadRef === true,
    },
    repo: {
      id: str(r.nameWithOwner, where),
      mergeMethods: methods,
      ...(defaultMethod && methods.includes(defaultMethod) ? { defaultMethod } : {}),
      deleteBranchOnMerge: r.deleteBranchOnMerge === true,
    },
  };
}

// ── The vocabulary ───────────────────────────────────────────────────────────

/** Each merge method: what its button says, its glyph, and what it does — in words, before you press it. */
export const MERGE_METHODS: Record<
  PrMergeMethod,
  { label: string; confirm: string; icon: string; what: (commits: number, base: string) => string }
> = {
  merge: {
    label: l10n.t("Create a merge commit"),
    confirm: l10n.t("Confirm merge"),
    icon: "git-merge",
    what: (n, base) => l10n.t("{0} added to {1}, joined by a merge commit.", n === 1 ? l10n.t("The commit is") : l10n.t("All {0} commits are", n), base),
  },
  squash: {
    label: l10n.t("Squash and merge"),
    confirm: l10n.t("Confirm squash and merge"),
    icon: "git-commit",
    what: (n, base) => (n === 1 ? l10n.t("The commit is added to {0} as one new commit.", base) : l10n.t("The {0} commits become one commit on {1}.", n, base)),
  },
  rebase: {
    label: l10n.t("Rebase and merge"),
    confirm: l10n.t("Confirm rebase and merge"),
    icon: "git-compare",
    what: (n, base) => l10n.t("{0} replayed onto {1} one by one, with no merge commit.", n === 1 ? l10n.t("The commit is") : l10n.t("The {0} commits are", n), base),
  },
};

/** The order the merge box offers them in: the viewer's (or setting's) choice first. */
export function mergeMethodsFor(pr: Pick<PrDetail, "repo">, preferred?: PrMergeMethod): PrMergeMethod[] {
  const allowed = pr.repo.mergeMethods;
  const first = preferred && allowed.includes(preferred) ? preferred : pr.repo.defaultMethod;
  return [...allowed].sort((a, b) => (a === first ? -1 : b === first ? 1 : 0));
}

/** The commit title GitHub proposes for a method (the page lets you change it). */
export function defaultMergeTitle(pr: Pick<PrDetail, "number" | "title" | "headRef" | "headOwner" | "isFork">, method: PrMergeMethod, owner: string): string {
  if (method === "squash") return `${pr.title} (#${pr.number})`;
  if (method === "merge") return l10n.t("Merge pull request #{0} from {1}/{2}", pr.number, pr.headOwner ?? owner, pr.headRef);
  return "";
}

/** A check's result: its word, glyph and tone. */
export const CHECK_STATES: Record<PrCheckState, { word: string; codicon: string; tone: PrTone }> = {
  success: { word: l10n.t("Passed"), codicon: "check", tone: "success" },
  failure: { word: l10n.t("Failed"), codicon: "close", tone: "failure" },
  pending: { word: l10n.t("Running"), codicon: "sync", tone: "pending" },
  cancelled: { word: l10n.t("Cancelled"), codicon: "stop-circle", tone: "muted" },
  skipped: { word: l10n.t("Skipped"), codicon: "circle-slash", tone: "muted" },
  neutral: { word: l10n.t("Neutral"), codicon: "circle-large-outline", tone: "muted" },
};

/** "6m 18s", "2h 5m", "40s". */
export function durationWords(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return l10n.t("{0}s", s);
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? l10n.t("{0}m {1}s", m, s % 60) : l10n.t("{0}m", m);
  const h = Math.floor(m / 60);
  return m % 60 ? l10n.t("{0}h {1}m", h, m % 60) : l10n.t("{0}h", h);
}

/** What a check says of itself, in one line: "Passed in 6m 18s", "Timed out after 30m", "Running for 3m", "Queued". */
export function checkWords(c: PrCheck, now: number): string {
  const start = c.startedAt ? Date.parse(c.startedAt) : NaN;
  const end = c.completedAt ? Date.parse(c.completedAt) : NaN;
  const took = Number.isFinite(start) && Number.isFinite(end) && end >= start ? durationWords(end - start) : undefined;
  switch (c.state) {
    case "success":
      return took ? l10n.t("Passed in {0}", took) : l10n.t("Passed");
    case "failure": {
      const word = c.raw === "TIMED_OUT" ? l10n.t("Timed out") : c.raw === "ACTION_REQUIRED" ? l10n.t("Needs action") : c.raw === "STARTUP_FAILURE" ? l10n.t("Failed to start") : c.raw === "ERROR" ? l10n.t("Errored") : l10n.t("Failed");
      return took ? l10n.t("{0} after {1}", word, took) : word;
    }
    case "pending":
      if (c.raw === "QUEUED" || c.raw === "REQUESTED" || c.raw === "WAITING" || c.raw === "PENDING" || c.raw === "EXPECTED") {
        if (c.raw === "EXPECTED") return l10n.t("Expected — waiting for it to report");
        if (c.raw === "WAITING") return l10n.t("Waiting");
        // A status in PENDING has been reported; a run in PENDING has not started.
        if (c.raw === "PENDING" && c.startedAt && !c.app && !c.workflow) {
          return Number.isFinite(start) ? l10n.t("Pending for {0}", durationWords(now - start)) : l10n.t("Pending");
        }
        return l10n.t("Queued");
      }
      return Number.isFinite(start) ? l10n.t("Running for {0}", durationWords(now - start)) : l10n.t("Running");
    case "cancelled":
      return took ? l10n.t("Cancelled after {0}", took) : l10n.t("Cancelled");
    case "skipped":
      return l10n.t("Skipped");
    default:
      return took ? l10n.t("Neutral, in {0}", took) : l10n.t("Neutral");
  }
}

/** A submitted review, in the timeline and beside its reviewer. */
export const REVIEW_STATE_WORDS: Record<PrReviewState, { verb: string; word: string; codicon: string; tone: PrTone }> = {
  APPROVED: { verb: l10n.t("approved these changes"), word: l10n.t("Approved"), codicon: "check", tone: "success" },
  CHANGES_REQUESTED: { verb: l10n.t("requested changes"), word: l10n.t("Changes requested"), codicon: "request-changes", tone: "failure" },
  COMMENTED: { verb: l10n.t("reviewed"), word: l10n.t("Commented"), codicon: "eye", tone: "muted" },
  DISMISSED: { verb: l10n.t("reviewed (dismissed)"), word: l10n.t("Dismissed"), codicon: "circle-slash", tone: "muted" },
  PENDING: { verb: l10n.t("started a review"), word: l10n.t("Pending"), codicon: "comment-draft", tone: "pending" },
};

/** What happened, as a timeline line says it (after the actor's name). */
export function timelineEventWords(e: { event: PrTimelineEvent; detail?: string }, base: string): { text: string; codicon: string; tone: PrTone } {
  switch (e.event) {
    case "merged":
      return {
        text: e.detail ? l10n.t("merged commit {0} into {1}", e.detail, base) : l10n.t("merged this into {0}", base),
        codicon: "git-merge",
        tone: "merged",
      };
    case "closed":
      return { text: l10n.t("closed this"), codicon: "git-pull-request-closed", tone: "closed" };
    case "reopened":
      return { text: l10n.t("reopened this"), codicon: "git-pull-request", tone: "open" };
    case "ready":
      return { text: l10n.t("marked this ready for review"), codicon: "eye", tone: "muted" };
    case "draft":
      return { text: l10n.t("marked this as a draft"), codicon: "git-pull-request-draft", tone: "muted" };
    case "forcePushed": {
      const [from, to] = (e.detail ?? "").split("→");
      return {
        text: from && to ? l10n.t("force-pushed the branch from {0} to {1}", from, to) : l10n.t("force-pushed the branch"),
        codicon: "repo-force-push",
        tone: "muted",
      };
    }
    case "reviewRequested":
      return { text: e.detail ? l10n.t("asked {0} for a review", e.detail) : l10n.t("asked for a review"), codicon: "eye", tone: "muted" };
    case "reviewDismissed":
      return { text: l10n.t("dismissed a review"), codicon: "circle-slash", tone: "muted" };
  }
}

// ── The rules ────────────────────────────────────────────────────────────────

/** Anything the page's header can do. */
export type PrPageAction =
  | "merge"
  | "markReady"
  | "reopen"
  | "close"
  | "checkout"
  | "approve"
  | "review"
  | "updateBranch"
  | "copyLink"
  | "openOnGitHub"
  | "refresh";

/** The header's words and glyphs: the shared vocabulary's (PR_ACTIONS), the desktop's. */
export const PR_PAGE_ACTION_WORDS: Record<PrPageAction, { label: string; icon: string; title: string }> = {
  merge: PR_ACTIONS.merge,
  markReady: PR_ACTIONS.markReady,
  reopen: PR_ACTIONS.reopen,
  close: PR_ACTIONS.close,
  checkout: PR_ACTIONS.checkout,
  approve: PR_ACTIONS.approve,
  review: PR_ACTIONS.review,
  updateBranch: PR_ACTIONS.updateBranch,
  copyLink: PR_ACTIONS.copyLink,
  openOnGitHub: PR_ACTIONS.openOnGitHub,
  refresh: PR_ACTIONS.refresh,
};

const WRITE: ReadonlySet<PrPermission> = new Set(["ADMIN", "MAINTAIN", "WRITE"]);

/** May this viewer merge pull requests in the repository? */
export function canMergeHere(pr: Pick<PrDetail, "viewer">): boolean {
  return WRITE.has(pr.viewer.permission);
}

/**
 * What the header offers, by state — the desktop's set: one primary action
 * (Merge for an open pull request the viewer can merge, Mark ready for a
 * draft, Reopen for a closed one — none for a merged one), then Checkout,
 * Approve (not on your own: GitHub takes no approval from its author) and
 * Review, and the rest in More actions (Update branch, Close pull request,
 * Copy link). Only what can apply: GitHub merges no draft, reviews no closed
 * pull request, and lets only its author or a writer close it.
 */
export function prPageActions(pr: Pick<PrDetail, "kind" | "viewer" | "repo">): { primary?: PrPageAction; buttons: PrPageAction[]; more: PrPageAction[] } {
  const buttons: PrPageAction[] = [];
  const more: PrPageAction[] = [];
  let primary: PrPageAction | undefined;
  const open = pr.kind === "open" || pr.kind === "draft";
  if (pr.kind === "open" && canMergeHere(pr) && pr.repo.mergeMethods.length > 0) primary = "merge";
  if (pr.kind === "draft" && pr.viewer.canUpdate) primary = "markReady";
  if (pr.kind === "closed" && pr.viewer.canUpdate) primary = "reopen";
  buttons.push("checkout");
  if (open && !pr.viewer.isAuthor) buttons.push("approve");
  if (open) buttons.push("review");
  if (open && pr.viewer.canUpdateBranch) more.push("updateBranch");
  if (open && pr.viewer.canUpdate) more.push("close");
  more.push("copyLink");
  return { ...(primary ? { primary } : {}), buttons, more };
}

/** What the merge box says, and what can be done about it. */
export interface MergeBox {
  tone: PrTone;
  icon: string;
  title: string;
  detail: string;
  /** Merge can be pressed. */
  canMerge: boolean;
  /** The one thing that helps, when something does. */
  fix?: "updateBranch" | "checkout" | "markReady" | "refresh";
}

/**
 * The merge box of an open (or draft) pull request: whether it can be merged
 * now and, when it can't, why — GitHub's mergeStateStatus in words, with the
 * reviews and checks that decide a BLOCKED one. Undefined for a merged or
 * closed pull request: there is nothing left to merge.
 */
export function mergeBoxOf(pr: Pick<PrDetail, "kind" | "mergeState" | "reviewDecision" | "ci" | "baseRef" | "viewer" | "repo">): MergeBox | undefined {
  if (pr.kind === "merged" || pr.kind === "closed") return undefined;
  if (pr.kind === "draft" || pr.mergeState === "DRAFT") {
    return {
      tone: "draft",
      icon: "git-pull-request-draft",
      title: l10n.t("This pull request is still a draft"),
      detail: pr.viewer.canUpdate ? l10n.t("Mark it ready for review to merge it.") : l10n.t("Its author marks it ready for review before it can be merged."),
      canMerge: false,
      ...(pr.viewer.canUpdate ? { fix: "markReady" as const } : {}),
    };
  }
  const writer = canMergeHere(pr);
  // A reader sees why it can or can't be merged, and that merging isn't
  // theirs to do; a fix only a writer could make (Refresh until GitHub has
  // decided) isn't offered.
  const cannot = (box: MergeBox): MergeBox => {
    if (writer) return box;
    const { fix, ...rest } = box;
    return {
      ...rest,
      ...(fix && fix !== "refresh" ? { fix } : {}),
      canMerge: false,
      detail: l10n.t("{0} Only people with write access to {1} can merge it.", box.detail, pr.repo.id),
    };
  };
  if (pr.repo.mergeMethods.length === 0) {
    return { tone: "failure", icon: "circle-slash", title: l10n.t("No merge method is allowed"), detail: l10n.t("{0} turns off every merge method GitHub has. Merge it on GitHub.", pr.repo.id), canMerge: false };
  }
  switch (pr.mergeState) {
    case "CLEAN":
      return cannot({ tone: "success", icon: "check", title: l10n.t("Ready to merge"), detail: l10n.t("Nothing is blocking it."), canMerge: true });
    case "HAS_HOOKS":
      return cannot({ tone: "success", icon: "check", title: l10n.t("Ready to merge"), detail: l10n.t("The repository's hooks run as it merges."), canMerge: true });
    case "UNSTABLE":
      return cannot({
        tone: "pending",
        icon: "warning",
        title: l10n.t("Some checks didn't pass"),
        detail: l10n.t("None of them is required: merging is still allowed."),
        canMerge: true,
      });
    case "BEHIND":
      return cannot({
        tone: "pending",
        icon: "arrow-down",
        title: l10n.t("{0} has moved on", pr.baseRef),
        detail: l10n.t("This branch is out of date with {0}, and the repository requires it to be up to date. Update the branch to merge it.", pr.baseRef),
        canMerge: false,
        ...(pr.viewer.canUpdateBranch ? { fix: "updateBranch" as const } : {}),
      });
    case "DIRTY":
      return cannot({
        tone: "failure",
        icon: "warning",
        title: l10n.t("This branch has conflicts"),
        detail: l10n.t("It can't be merged into {0} until they are resolved: check it out, merge {1} into it and push.", pr.baseRef, pr.baseRef),
        canMerge: false,
        fix: "checkout",
      });
    case "BLOCKED": {
      const why: string[] = [];
      if (pr.reviewDecision === "CHANGES_REQUESTED") why.push(l10n.t("changes were requested"));
      else if (pr.reviewDecision === "REVIEW_REQUIRED") why.push(l10n.t("it needs an approving review"));
      if (pr.ci.state === "failure") why.push(l10n.t("required checks failed"));
      else if (pr.ci.state === "pending") why.push(l10n.t("required checks haven't finished"));
      return cannot({
        tone: "failure",
        icon: "circle-slash",
        title: l10n.t("Merging is blocked"),
        detail: why.length > 0 ? l10n.t("{0}.", capital(why.join(l10n.t(", and ")))) : l10n.t("The rules that protect {0} aren't met yet.", pr.baseRef),
        canMerge: false,
      });
    }
    default:
      return cannot({
        tone: "muted",
        icon: "sync",
        title: l10n.t("GitHub is checking whether it can be merged"),
        detail: l10n.t("This takes a moment after a push. Refresh to see."),
        canMerge: true,
        fix: "refresh",
      });
  }
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Can this viewer approve, or request changes? Not on their own pull request. */
export function reviewVerdictsFor(pr: Pick<PrDetail, "viewer">): { event: "COMMENT" | "APPROVE" | "REQUEST_CHANGES"; allowed: boolean; why?: string }[] {
  const own = pr.viewer.isAuthor;
  return [
    { event: "COMMENT", allowed: true },
    { event: "APPROVE", allowed: !own, ...(own ? { why: l10n.t("GitHub takes no approval of your own pull request") } : {}) },
    { event: "REQUEST_CHANGES", allowed: !own, ...(own ? { why: l10n.t("GitHub takes no change request on your own pull request") } : {}) },
  ];
}

// ── The files, as a tree ─────────────────────────────────────────────────────

export type PrFileNode =
  | { kind: "dir"; name: string; path: string; children: PrFileNode[] }
  | { kind: "file"; name: string; file: PrPageFile };

/**
 * The changed files as a tree: folders first, then files, each by name; a
 * folder with nothing but one folder in it is one row ("src/pr"), as VS
 * Code's own compact folders are.
 */
export function fileTree(files: readonly PrPageFile[]): PrFileNode[] {
  interface Dir {
    dirs: Map<string, Dir>;
    files: PrPageFile[];
  }
  const root: Dir = { dirs: new Map(), files: [] };
  for (const f of files) {
    const parts = f.path.split("/").filter(Boolean);
    let d = root;
    for (const p of parts.slice(0, -1)) {
      let next = d.dirs.get(p);
      if (!next) {
        next = { dirs: new Map(), files: [] };
        d.dirs.set(p, next);
      }
      d = next;
    }
    d.files.push(f);
  }
  const build = (d: Dir, prefix: string): PrFileNode[] => {
    const out: PrFileNode[] = [];
    for (const [name, sub] of [...d.dirs].sort(([a], [b]) => a.localeCompare(b))) {
      let label = name;
      let node = sub;
      while (node.files.length === 0 && node.dirs.size === 1) {
        const [[n2, s2]] = [...node.dirs];
        label = `${label}/${n2}`;
        node = s2;
      }
      const path = prefix ? `${prefix}/${label}` : label;
      out.push({ kind: "dir", name: label, path, children: build(node, path) });
    }
    for (const f of [...d.files].sort((a, b) => a.path.localeCompare(b.path))) {
      out.push({ kind: "file", name: f.path.slice(f.path.lastIndexOf("/") + 1), file: f });
    }
    return out;
  };
  return build(root, "");
}

/** REST's file status → the page's. */
export function fileStatusOf(s: string): PrPageFile["status"] {
  switch (s) {
    case "added":
    case "removed":
    case "modified":
    case "renamed":
    case "copied":
    case "unchanged":
      return s;
    default:
      return "changed";
  }
}

/** A file's status: the letter VS Code's own SCM uses, its word and tone. */
export const FILE_STATUS: Record<PrPageFile["status"], { letter: string; word: string; tone: "added" | "deleted" | "modified" | "renamed" }> = {
  added: { letter: "A", word: "Added", tone: "added" },
  removed: { letter: "D", word: "Deleted", tone: "deleted" },
  modified: { letter: "M", word: "Modified", tone: "modified" },
  renamed: { letter: "R", word: "Renamed", tone: "renamed" },
  copied: { letter: "C", word: "Copied", tone: "added" },
  changed: { letter: "M", word: "Changed", tone: "modified" },
  unchanged: { letter: "M", word: "Unchanged", tone: "modified" },
};

// ── What the page changes (GraphQL: GitHub has no REST for these) ────────────

export const PR_MUTATIONS = {
  markReady: `mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }`,
  reply: `mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id url createdAt body author { ${PERSON} } } } }`,
  resolve: `mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { id isResolved resolvedBy { login } } } }`,
  unresolve: `mutation($thread: ID!) { unresolveReviewThread(input: {threadId: $thread}) { thread { id isResolved } } }`,
} as const;

/** A mutation's answer: its data, or GitHub's reason in its own words. */
function mutated(res: { data?: unknown; errors?: readonly { type?: string; message?: string }[] }, field: string, what: string): Json {
  const node = (res.data as Json)?.[field];
  if (node && !res.errors?.length) return node;
  const e = res.errors?.[0];
  if (e?.type === "RATE_LIMITED") throw new PrListError(e.message || l10n.t("GitHub's rate limit was reached."), "rate-limit");
  if (e?.type === "FORBIDDEN") throw new PrListError(e.message || l10n.t("GitHub refused to {0}.", what), "forbidden");
  if (e?.type === "NOT_FOUND") throw new PrListError(e.message || l10n.t("GitHub couldn't find what to {0}.", what), "not-found");
  if (node) return node;
  throw new PrListError(e?.message || l10n.t("GitHub couldn't {0}.", what), "query");
}

/** Take a draft out of draft. */
export async function markReadyForReview(graphql: GraphqlFn, pullRequestId: string): Promise<void> {
  if (!pullRequestId) throw new PrListError(l10n.t("The pull request isn't loaded yet."), "query");
  mutated(await graphql(PR_MUTATIONS.markReady, { id: pullRequestId }), "markPullRequestReadyForReview", l10n.t("mark it ready for review"));
}

/** Reply to a review thread; the comment as GitHub stored it. */
export async function replyToThread(
  graphql: GraphqlFn,
  threadId: string,
  body: string,
): Promise<{ id: string; url: string; createdAt: string; body: string; author: PrPerson | null }> {
  const r = mutated(await graphql(PR_MUTATIONS.reply, { thread: threadId, body }), "addPullRequestReviewThreadReply", l10n.t("post the reply"));
  const c = r?.comment;
  return { id: str(c?.id), url: str(c?.url), createdAt: str(c?.createdAt, new Date().toISOString()), body: str(c?.body, body), author: person(c?.author) };
}

/** Resolve a review thread, or open it again. */
export async function setThreadResolved(graphql: GraphqlFn, threadId: string, resolved: boolean): Promise<{ resolved: boolean; resolvedBy?: string }> {
  const field = resolved ? "resolveReviewThread" : "unresolveReviewThread";
  const r = mutated(await graphql(resolved ? PR_MUTATIONS.resolve : PR_MUTATIONS.unresolve, { thread: threadId }), field, resolved ? l10n.t("resolve the conversation") : l10n.t("unresolve the conversation"));
  return { resolved: r?.thread?.isResolved === true, ...(typeof r?.thread?.resolvedBy?.login === "string" ? { resolvedBy: r.thread.resolvedBy.login } : {}) };
}
