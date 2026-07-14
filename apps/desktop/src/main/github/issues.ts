// Issues — the repo-scoped GitHub Issues surface for the desktop app.
//
// Standalone, self-contained functions over the shared `GitHubClient`
// primitives. main.ts wires each channel through `github.withRepo((c, o, r) =>
// …)`, so every function here takes `(client, owner, repo, …args)`.
//
// Convention (post-2026-06-27):
//   • READ functions THROW on error (the client primitives already throw via
//     `toError`) so the renderer can show a real error state.
//   • MUTATION functions never throw — they return a CommitActionResult-shaped
//     `{ ok, changed, message? }` so the renderer can toast cleanly.
//
// Everything here is REST (Issues live under the OAuth `repo` scope, same as
// PRs); GraphQL is only needed for Projects v2, which lives elsewhere.

import { GitHubClient, enc, mapUser, type RawUser } from "../githubClient";
import type {
  CommitActionResult,
  GitHubUser,
  IssueComment,
  IssueDetail,
  IssueInfo,
  MilestoneInfo,
  RepoLabel,
} from "../../shared/ipc";

// ── Raw GitHub payloads (only what we read) ──────────────────────────────────

interface RawLabelRef {
  name: string;
  color: string;
}
interface RawIssue {
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
  pull_request?: unknown;
}
interface RawIssueComment {
  id: number;
  user?: RawUser | null;
  body?: string | null;
  created_at: string;
}
interface RawRepoLabel {
  name: string;
  color: string;
  description?: string | null;
}
interface RawMilestone {
  number: number;
  title: string;
  state: string;
  due_on?: string | null;
  open_issues: number;
  closed_issues: number;
}

// ── Mappers ──────────────────────────────────────────────────────────────────

function mapIssue(i: RawIssue): IssueInfo {
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
    assignees: (i.assignees ?? [])
      .map(mapUser)
      .filter((u): u is GitHubUser => u !== null),
  };
}

function mapComment(c: RawIssueComment): IssueComment {
  return {
    id: c.id,
    author: mapUser(c.user ?? null),
    body: c.body ?? "",
    createdAt: c.created_at,
  };
}

function mapLabel(l: RawRepoLabel): RepoLabel {
  return { name: l.name, color: l.color, description: l.description ?? null };
}

function mapMilestone(m: RawMilestone): MilestoneInfo {
  return {
    number: m.number,
    title: m.title,
    state: m.state === "closed" ? "closed" : "open",
    dueOn: m.due_on ?? null,
    openIssues: m.open_issues,
    closedIssues: m.closed_issues,
  };
}

/** Coerce any thrown value into a clean, user-facing message. */
function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── Reads (THROW on error) ───────────────────────────────────────────────────

/**
 * Open (or closed/all) issues for the repo, newest-updated first. The `issues`
 * endpoint also returns PRs, so we drop anything carrying a `pull_request` node.
 */
export async function listIssues(
  client: GitHubClient,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all" = "open",
): Promise<IssueInfo[]> {
  const raw = await client.request<RawIssue[]>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/issues?state=${state}&sort=updated&direction=desc&per_page=50`,
  );
  return raw.filter((i) => !i.pull_request).map(mapIssue);
}

/**
 * One issue plus its comment timeline (oldest → newest, GitHub's default order)
 * and the current assignee logins. The issue read throws on error; the comments
 * read is best-effort (a comment-fetch hiccup shouldn't blank the whole detail).
 */
export async function getIssueDetail(
  client: GitHubClient,
  owner: string,
  repo: string,
  n: number,
): Promise<IssueDetail> {
  const issue = mapIssue(
    await client.request<RawIssue>("GET", `/repos/${enc(owner)}/${enc(repo)}/issues/${n}`),
  );
  const comments = await client
    .request<RawIssueComment[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/issues/${n}/comments?per_page=100`,
    )
    .then((raw) => raw.map(mapComment))
    .catch(() => [] as IssueComment[]);
  return { issue, comments, assignees: issue.assignees.map((a) => a.login) };
}

/** The repo's defined labels, for the label picker (GET …/labels). */
export async function listLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoLabel[]> {
  const raw = await client.request<RawRepoLabel[]>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/labels?per_page=100`,
  );
  return raw.map(mapLabel);
}

/** Repo-level label CRUD (the maintainer's label management surface). */
export async function createLabel(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { name: string; color: string; description?: string },
): Promise<CommitActionResult> {
  try {
    await client.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/labels`, {
      name: req.name,
      color: req.color.replace(/^#/, ""),
      description: req.description ?? "",
    });
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

export async function updateLabel(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { name: string; newName?: string; color?: string; description?: string },
): Promise<CommitActionResult> {
  try {
    const body: Record<string, string> = {};
    if (req.newName) body.new_name = req.newName;
    if (req.color) body.color = req.color.replace(/^#/, "");
    if (req.description !== undefined) body.description = req.description;
    await client.requestBody(
      "PATCH",
      `/repos/${enc(owner)}/${enc(repo)}/labels/${enc(req.name)}`,
      body,
    );
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

export async function deleteLabel(
  client: GitHubClient,
  owner: string,
  repo: string,
  name: string,
): Promise<CommitActionResult> {
  try {
    await client.request("DELETE", `/repos/${enc(owner)}/${enc(repo)}/labels/${enc(name)}`);
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Every milestone (open AND closed) for the repo, for the milestone filter and
 * the per-issue milestone picker. `state=all` so closed milestones still show
 * (an issue can carry a closed milestone). Newest-due first is GitHub's default.
 */
export async function milestones(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<MilestoneInfo[]> {
  const raw = await client.request<RawMilestone[]>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/milestones?state=all&per_page=100`,
  );
  return raw.map(mapMilestone);
}

// ── Mutations (never throw — return CommitActionResult) ──────────────────────

/**
 * Open a new issue. Returns the created issue's `number` so the caller can
 * select it. This is its own result shape (carries `number`) per the channel.
 */
export async function createIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { title: string; body?: string },
): Promise<{ ok: boolean; number?: number; message?: string }> {
  const title = req.title.trim();
  if (!title) {
    return { ok: false, message: "An issue needs a title." };
  }
  try {
    const created = await client.request<RawIssue>(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/issues`,
      { title, body: req.body ?? "" },
    );
    return { ok: true, number: created.number };
  } catch (err) {
    return { ok: false, message: errMessage(err) };
  }
}

/** Post a comment on an issue (POST …/issues/{n}/comments). */
export async function commentIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; body: string },
): Promise<CommitActionResult> {
  const body = req.body.trim();
  if (!body) {
    return { ok: false, changed: false, message: "Write a comment first." };
  }
  try {
    await client.requestBody(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}/comments`,
      { body },
    );
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Close or reopen an issue (PATCH state). */
export async function setIssueState(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; state: "open" | "closed" },
): Promise<CommitActionResult> {
  try {
    await client.requestBody("PATCH", `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}`, {
      state: req.state,
    });
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Edit an issue's title and/or body (PATCH). */
export async function editIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; title?: string; body?: string },
): Promise<CommitActionResult> {
  const fields: { title?: string; body?: string } = {};
  if (typeof req.title === "string") fields.title = req.title.trim();
  if (typeof req.body === "string") fields.body = req.body;
  if (fields.title !== undefined && fields.title === "") {
    return { ok: false, changed: false, message: "An issue needs a title." };
  }
  if (fields.title === undefined && fields.body === undefined) {
    return { ok: false, changed: false, message: "Nothing to update." };
  }
  try {
    await client.requestBody(
      "PATCH",
      `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}`,
      fields,
    );
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Replace the issue's full label set (PUT …/issues/{n}/labels). PUT replaces
 * the whole set, which is exactly what the label-toggle picker needs.
 */
export async function setIssueLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; labels: string[] },
): Promise<CommitActionResult> {
  try {
    await client.requestBody(
      "PUT",
      `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}/labels`,
      { labels: req.labels },
    );
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Replace the issue's assignee set. GitHub has no single "replace assignees"
 * call, but the `assignees` array on PATCH /issues/{n} replaces the set
 * atomically. Non-collaborator logins are silently dropped by GitHub (no 422);
 * the renderer re-fetches afterward to show the authoritative set.
 */
export async function setIssueAssignees(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; assignees: string[] },
): Promise<CommitActionResult> {
  try {
    await client.requestBody("PATCH", `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}`, {
      assignees: req.assignees,
    });
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Set or clear the issue's milestone (PATCH /issues/{n}). `milestone` is the
 * milestone number to assign, or `null` to remove it — GitHub accepts a literal
 * `null` on this field to clear it, which is exactly what the picker's "No
 * milestone" choice sends.
 */
export async function setMilestone(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; milestone: number | null },
): Promise<CommitActionResult> {
  try {
    await client.requestBody("PATCH", `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}`, {
      milestone: req.milestone,
    });
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}
