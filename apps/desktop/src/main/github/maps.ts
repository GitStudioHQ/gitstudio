// The ONE home for GitHub raw-payload shapes and their wire-type mappers.
//
// Pure module — imports nothing but the shared IPC types (like githubPaging),
// so every mapper unit-tests in isolation with canned API JSON. Before this
// module existed, mapRun/mapPull/mapIssue each lived in TWO divergent copies
// (githubClient.ts vs github/*.ts) and quietly disagreed about which fields
// survive; new fields now land HERE, once.
//
// Mapping convention: raw fields are optional (GitHub omits more than its
// docs admit), mapped fields are concrete — absent strings become "", absent
// arrays [], absent users null. The UI never branches on undefined.

import type {
  GitHubUser,
  IssueComment,
  IssueInfo,
  NotificationThread,
  PullRequest,
  ReactionSummary,
  WorkflowJob,
  WorkflowRun,
  WorkflowStep,
} from "../../shared/ipc";

// ── Users ────────────────────────────────────────────────────────────────────

export interface RawUser {
  login: string;
  avatar_url?: string;
}

export function mapUser(u: RawUser | null | undefined): GitHubUser | null {
  return u ? { login: u.login, avatarUrl: u.avatar_url ?? null } : null;
}

// ── Workflow runs ────────────────────────────────────────────────────────────

export interface RawRun {
  id: number;
  run_number?: number;
  run_attempt?: number;
  /** The WORKFLOW's name ("Desktop CI"). */
  name?: string;
  /** The run's own title (commit subject / PR title). */
  display_title?: string;
  status?: string;
  conclusion?: string;
  head_branch?: string;
  head_sha?: string;
  event?: string;
  created_at?: string;
  updated_at?: string;
  run_started_at?: string;
  html_url?: string;
  actor?: RawUser | null;
  triggering_actor?: RawUser | null;
  workflow_id?: number;
  /** The workflow file path (".github/workflows/desktop.yml"). */
  path?: string;
  head_commit?: { message?: string; author?: { name?: string } | null } | null;
  pull_requests?: { number: number }[];
}

export function mapRun(r: RawRun): WorkflowRun {
  return {
    id: r.id,
    runNumber: r.run_number ?? 0,
    runAttempt: r.run_attempt ?? 1,
    name: r.name ?? r.display_title ?? "(run)",
    displayTitle: r.display_title ?? r.name ?? "(run)",
    status: r.status ?? "",
    conclusion: r.conclusion ?? "",
    branch: r.head_branch ?? "",
    headSha: r.head_sha ?? "",
    event: r.event ?? "",
    createdAt: r.created_at ?? "",
    updatedAt: r.updated_at ?? "",
    runStartedAt: r.run_started_at ?? "",
    htmlUrl: r.html_url ?? "",
    actor: mapUser(r.actor),
    triggeringActor: mapUser(r.triggering_actor),
    workflowId: r.workflow_id ?? 0,
    workflowPath: r.path ?? "",
    headCommitMessage: r.head_commit?.message ?? "",
    headCommitAuthor: r.head_commit?.author?.name ?? "",
    pullRequests: (r.pull_requests ?? []).map((p) => ({ number: p.number })),
  };
}

// ── Workflow jobs + steps ────────────────────────────────────────────────────

export interface RawStep {
  name?: string;
  status?: string;
  conclusion?: string;
  number?: number;
  started_at?: string | null;
  completed_at?: string | null;
}

export interface RawJob {
  id: number;
  run_id?: number;
  run_attempt?: number;
  name?: string;
  status?: string;
  conclusion?: string;
  html_url?: string;
  /** Queued time — `started_at − created_at` is the queue latency. */
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  steps?: RawStep[];
  runner_name?: string | null;
  runner_group_name?: string | null;
  labels?: string[];
  workflow_name?: string | null;
  head_branch?: string | null;
}

export function mapStep(s: RawStep): WorkflowStep {
  return {
    name: s.name ?? "",
    status: s.status ?? "",
    conclusion: s.conclusion ?? "",
    number: s.number ?? 0,
    startedAt: s.started_at ?? "",
    completedAt: s.completed_at ?? "",
  };
}

export function mapJob(j: RawJob): WorkflowJob {
  return {
    id: j.id,
    runId: j.run_id ?? 0,
    runAttempt: j.run_attempt ?? 1,
    name: j.name ?? "(job)",
    status: j.status ?? "",
    conclusion: j.conclusion ?? "",
    htmlUrl: j.html_url ?? "",
    createdAt: j.created_at ?? "",
    startedAt: j.started_at ?? "",
    completedAt: j.completed_at ?? "",
    steps: (j.steps ?? []).map(mapStep),
    runnerName: j.runner_name ?? "",
    runnerGroupName: j.runner_group_name ?? "",
    labels: j.labels ?? [],
    workflowName: j.workflow_name ?? "",
    headBranch: j.head_branch ?? "",
  };
}

// ── Reactions ────────────────────────────────────────────────────────────────

export interface RawReactions {
  total_count?: number;
  "+1"?: number;
  "-1"?: number;
  laugh?: number;
  hooray?: number;
  confused?: number;
  heart?: number;
  rocket?: number;
  eyes?: number;
}

/** Undefined when nobody reacted — the UI renders nothing rather than a row of
 *  zeroes, which is what GitHub does and what reads honestly. */
export function mapReactions(r: RawReactions | null | undefined): ReactionSummary | undefined {
  if (!r) return undefined;
  const total = r.total_count ?? 0;
  if (total <= 0) return undefined;
  return {
    total,
    plusOne: r["+1"] ?? 0,
    minusOne: r["-1"] ?? 0,
    laugh: r.laugh ?? 0,
    hooray: r.hooray ?? 0,
    confused: r.confused ?? 0,
    heart: r.heart ?? 0,
    rocket: r.rocket ?? 0,
    eyes: r.eyes ?? 0,
  };
}

// ── Pull requests ────────────────────────────────────────────────────────────

export interface RawRef {
  ref: string;
  sha: string;
  repo?: { full_name?: string } | null;
}

export interface RawPull {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft?: boolean;
  html_url: string;
  user: RawUser | null;
  created_at: string;
  updated_at: string;
  head: RawRef;
  base: RawRef;
  labels?: { name: string; color: string }[];
  comments?: number;
  additions?: number;
  deletions?: number;
  changed_files?: number;
  assignees?: RawUser[];
  merged_at?: string | null;
  closed_at?: string | null;
  merged_by?: RawUser | null;
  review_comments?: number;
  commits?: number;
  requested_reviewers?: RawUser[];
  milestone?: { number: number; title: string } | null;
  author_association?: string;
  reactions?: RawReactions | null;
}

/** Users, with the nulls dropped — a list mapper that keeps `null` holes makes
 *  every caller re-filter. */
function userList(raw: RawUser[] | undefined): GitHubUser[] {
  return (raw ?? []).map(mapUser).filter((u): u is GitHubUser => u !== null);
}

export function mapPull(p: RawPull): PullRequest {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    draft: p.draft ?? false,
    htmlUrl: p.html_url,
    user: mapUser(p.user),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    head: { ref: p.head.ref, sha: p.head.sha },
    base: { ref: p.base.ref, sha: p.base.sha },
    labels: (p.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    comments: p.comments,
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
    assignees: userList(p.assignees),
    mergedAt: p.merged_at ?? null,
    closedAt: p.closed_at ?? null,
    mergedBy: mapUser(p.merged_by),
    reviewComments: p.review_comments,
    commits: p.commits,
    requestedReviewers: userList(p.requested_reviewers),
    milestone: p.milestone ? { number: p.milestone.number, title: p.milestone.title } : null,
    authorAssociation: p.author_association,
    // Only meaningful when it DIFFERS from base — a same-repo branch is the
    // normal case and shouldn't paint a "fork" pill on every row.
    headRepoFullName:
      p.head.repo?.full_name && p.head.repo.full_name !== p.base.repo?.full_name
        ? p.head.repo.full_name
        : null,
    reactions: mapReactions(p.reactions),
  };
}

// ── Issues ───────────────────────────────────────────────────────────────────

export interface RawLabelRef {
  name: string;
  color: string;
}

export interface RawIssue {
  number: number;
  title: string;
  body: string | null;
  state: string;
  html_url: string;
  user: RawUser | null;
  created_at: string;
  updated_at: string;
  comments: number;
  labels?: (RawLabelRef | string)[];
  assignees?: RawUser[];
  milestone?: { number: number; title: string } | null;
  pull_request?: unknown;
  closed_at?: string | null;
  closed_by?: RawUser | null;
  state_reason?: string | null;
  author_association?: string;
  reactions?: RawReactions | null;
}

export function mapIssue(i: RawIssue): IssueInfo {
  return {
    number: i.number,
    title: i.title,
    body: i.body,
    state: i.state,
    htmlUrl: i.html_url,
    user: mapUser(i.user),
    createdAt: i.created_at,
    updatedAt: i.updated_at,
    comments: i.comments,
    labels: (i.labels ?? []).map((l) =>
      typeof l === "string" ? { name: l, color: "888888" } : { name: l.name, color: l.color },
    ),
    assignees: userList(i.assignees),
    milestone: i.milestone ? { number: i.milestone.number, title: i.milestone.title } : null,
    closedAt: i.closed_at ?? null,
    closedBy: mapUser(i.closed_by),
    stateReason: i.state_reason ?? null,
    authorAssociation: i.author_association,
    reactions: mapReactions(i.reactions),
  };
}

export interface RawIssueComment {
  id: number;
  user?: RawUser | null;
  body?: string | null;
  created_at: string;
  updated_at?: string;
  author_association?: string;
  reactions?: RawReactions | null;
  html_url?: string;
}

export function mapComment(c: RawIssueComment): IssueComment {
  return {
    id: c.id,
    author: mapUser(c.user ?? null),
    body: c.body ?? "",
    createdAt: c.created_at,
    updatedAt: c.updated_at,
    authorAssociation: c.author_association,
    reactions: mapReactions(c.reactions),
    htmlUrl: c.html_url,
  };
}

// ── Notifications ────────────────────────────────────────────────────────────

export interface RawNotification {
  id: string;
  unread: boolean;
  reason: string;
  updated_at: string;
  last_read_at?: string | null;
  subject: { title?: string; type?: string; url?: string | null } | null;
  repository: {
    full_name: string;
    html_url: string;
    owner?: { avatar_url?: string } | null;
  } | null;
}

/** What a notification is ABOUT, parsed out of the subject's API url.
 *
 *  This is the whole reason Inbox rows can open in-app: the subject carries no
 *  html_url and no number, but its API url's tail IS the number (or the sha).
 *  Pure and exported so every form GitHub emits is pinned by tests. */
export function subjectRef(
  type: string | undefined,
  apiUrl: string | null | undefined,
): { kind: NotificationThread["subjectKind"]; number?: number; sha?: string } {
  const url = apiUrl ?? "";
  const numbered = /\/repos\/[^/]+\/[^/]+\/(pulls|issues|releases)\/(\d+)(?:$|[?#])/.exec(url);
  if (numbered) {
    const kind = numbered[1] === "pulls" ? "pull" : numbered[1] === "issues" ? "issue" : "release";
    return { kind, number: Number(numbered[2]) };
  }
  const commit = /\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-f]{7,40})(?:$|[?#])/i.exec(url);
  if (commit) return { kind: "commit", sha: commit[1] };
  // No usable url (Discussions, and Releases addressed by tag) — fall back to
  // the declared subject type so the row can still say what it is.
  const t = (type ?? "").toLowerCase();
  if (t === "pullrequest") return { kind: "pull" };
  if (t === "issue") return { kind: "issue" };
  if (t === "release") return { kind: "release" };
  if (t === "commit") return { kind: "commit" };
  if (t === "discussion") return { kind: "discussion" };
  return { kind: "other" };
}

/** github.com url for a notification subject — numbered issues/PRs/releases
 *  resolve exactly; anything else falls back to the repository. */
export function subjectHtmlUrl(n: RawNotification): string {
  const repo = n.repository?.full_name ?? "";
  const ref = subjectRef(n.subject?.type, n.subject?.url);
  if (repo && ref.number !== undefined) {
    const path = ref.kind === "pull" ? "pull" : ref.kind === "issue" ? "issues" : "releases";
    return `https://github.com/${repo}/${path}/${ref.number}`;
  }
  if (repo && ref.sha) return `https://github.com/${repo}/commit/${ref.sha}`;
  return n.repository?.html_url ?? "";
}

export function mapNotification(n: RawNotification): NotificationThread {
  const ref = subjectRef(n.subject?.type, n.subject?.url);
  return {
    id: n.id,
    title: n.subject?.title ?? "(untitled)",
    type: n.subject?.type ?? "",
    reason: n.reason ?? "",
    repo: n.repository?.full_name ?? "",
    repoAvatarUrl: n.repository?.owner?.avatar_url ?? null,
    updatedAt: n.updated_at ?? "",
    unread: n.unread ?? false,
    htmlUrl: subjectHtmlUrl(n),
    lastReadAt: n.last_read_at ?? null,
    subjectKind: ref.kind,
    subjectNumber: ref.number,
    subjectSha: ref.sha,
  };
}
