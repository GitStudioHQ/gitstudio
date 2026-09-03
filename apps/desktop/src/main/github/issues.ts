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

import { GitHubClient, enc } from "../githubClient";
import {
  mapComment,
  mapIssue,
  mapUser,
  type RawIssue,
  type RawIssueComment,
  type RawUser,
} from "./maps";
import { PAGE_CAPS } from "../githubPaging";
import { issueSearchPath } from "./searchQuery";
import { errorFields } from "../githubErrors";
import type {
  CommitActionResult,
  GitHubUser,
  IssueComment,
  IssueDetail,
  IssueInfo,
  MilestoneInfo,
  ReactionContent,
  TimelineEvent,
  ReactionSummary,
  RepoLabel,
} from "../../shared/ipc";

// ── Raw GitHub payloads (only what we read) ──────────────────────────────────

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
  const raw = await client.requestPaged<RawIssue>(
    `/repos/${enc(owner)}/${enc(repo)}/issues?state=${state}&sort=updated&direction=desc&per_page=100`,
    PAGE_CAPS.list,
  );
  return raw.filter((i) => !i.pull_request).map(mapIssue);
}

/**
 * Search this repository's issues through GitHub, rather than filtering the
 * ones that happen to be loaded.
 *
 * `listIssues` reads the three most recent pages — 300 issues — because that
 * is a sensible amount to render. It is not a sensible amount to SEARCH: on
 * any repository with a real backlog, looking for an older issue by title
 * found nothing, and every qualifier people type (`author:@me`, `no:assignee`,
 * `label:"…"`) matched zero, silently, because the box was a substring test.
 *
 * Returns the same `IssueInfo` the list renders, so the view can swap one for
 * the other without knowing which it has. `incomplete` is GitHub telling us it
 * gave up early; the caller says so rather than pretending the list is whole.
 */
export async function searchIssues(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { query: string; state?: "open" | "closed" | "all" },
): Promise<{ items: IssueInfo[]; totalCount: number; incomplete: boolean }> {
  const path = issueSearchPath(`${owner}/${repo}`, req.query, { state: req.state });
  const raw = await client.request<{
    items?: RawIssue[];
    total_count?: number;
    incomplete_results?: boolean;
  }>("GET", path);
  return {
    // `/search/issues` returns pull requests too when the query asks for them;
    // this box is the issue list, so anything carrying a `pull_request` is not
    // what was asked for.
    items: (raw.items ?? []).filter((i) => !i.pull_request).map(mapIssue),
    totalCount: raw.total_count ?? 0,
    incomplete: !!raw.incomplete_results,
  };
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
    .requestPaged<RawIssueComment>(
      `/repos/${enc(owner)}/${enc(repo)}/issues/${n}/comments?per_page=100`,
      PAGE_CAPS.detail,
    )
    .then((raw) => raw.map(mapComment))
    .catch(() => [] as IssueComment[]);
  const events = await fetchTimeline(client, owner, repo, n);
  await fillViewerReactions(client, owner, repo, issue, comments);
  return { issue, comments, assignees: issue.assignees.map((a) => a.login), events };
}

/** Raw timeline entries — only the fields the kinds below actually read. */
interface RawTimelineEvent {
  event?: string;
  created_at?: string;
  actor?: { login?: string } | null;
  label?: { name?: string; color?: string };
  assignee?: { login?: string } | null;
  milestone?: { title?: string };
  rename?: { from?: string; to?: string };
  state_reason?: string | null;
  commit_id?: string | null;
  source?: {
    type?: string;
    issue?: { number?: number; title?: string; html_url?: string; pull_request?: unknown };
  };
}

/** GitHub's event names, mapped to the ones worth drawing a line for. */
const TIMELINE_KINDS: Record<string, TimelineEvent["kind"]> = {
  closed: "closed",
  reopened: "reopened",
  labeled: "labeled",
  unlabeled: "unlabeled",
  assigned: "assigned",
  unassigned: "unassigned",
  renamed: "renamed",
  milestoned: "milestoned",
  demilestoned: "demilestoned",
  locked: "locked",
  unlocked: "unlocked",
  referenced: "referenced",
  cross_referenced: "cross-referenced",
  marked_as_duplicate: "marked-duplicate",
};

/**
 * The things that happened to an issue besides being commented on.
 *
 * The thread was comments only, so an issue closed between two of them never
 * said it had been closed, by whom, or why: the rail read CLOSED AS NOT PLANNED
 * while the conversation skipped straight past the moment it happened.
 *
 * Comments are NOT taken from here even though this endpoint carries them — the
 * separate comment read already carries reactions and author associations that
 * are wired through the card, and swapping the source to save one request would
 * risk all of that to fix none of it. This adds the events and nothing else.
 *
 * Best-effort: a failure returns an empty list and the thread renders as it
 * always did, rather than the whole detail page failing over a decoration.
 */
async function fetchTimeline(
  client: GitHubClient,
  owner: string,
  repo: string,
  n: number,
): Promise<TimelineEvent[]> {
  let raw: RawTimelineEvent[];
  try {
    raw = await client.requestPaged<RawTimelineEvent>(
      `/repos/${enc(owner)}/${enc(repo)}/issues/${n}/timeline?per_page=100`,
      PAGE_CAPS.detail,
    );
  } catch {
    return [];
  }
  const out: TimelineEvent[] = [];
  for (const e of raw) {
    const kind = e.event ? TIMELINE_KINDS[e.event] : undefined;
    if (!kind || !e.created_at) continue;
    const ev: TimelineEvent = {
      kind,
      actor: e.actor?.login ?? null,
      createdAt: e.created_at,
    };
    if (e.label?.name) ev.label = { name: e.label.name, color: e.label.color ?? "888888" };
    if (kind === "assigned" || kind === "unassigned") ev.assignee = e.assignee?.login ?? null;
    if (e.milestone?.title) ev.milestone = e.milestone.title;
    if (e.rename?.from && e.rename?.to) ev.rename = { from: e.rename.from, to: e.rename.to };
    if (e.state_reason) ev.reason = e.state_reason;
    if (kind === "referenced" && e.commit_id) {
      ev.source = { kind: "commit", ref: e.commit_id.slice(0, 7) };
    }
    if (kind === "cross-referenced" && e.source?.issue?.number) {
      const i = e.source.issue;
      ev.source = {
        // A pull request IS an issue to this API and only the presence of
        // `pull_request` tells them apart — calling a PR an issue here would
        // send the reader to the wrong kind of page.
        kind: i.pull_request ? "pr" : "issue",
        ref: `#${i.number}`,
        title: i.title,
        url: i.html_url,
      };
    }
    out.push(ev);
  }
  return out;
}

/**
 * Mark which reactions are YOURS, so a chip can render as already-pressed.
 *
 * GitHub's reaction summary counts and does not say who, so this is a second
 * read — and the reason it is affordable is that it only asks about subjects
 * that have any reactions at all. Most comments have none, so the cost is
 * proportional to the reactions actually there rather than to the length of
 * the thread: a fifty-comment issue with two reactions costs two requests.
 *
 * Best-effort throughout. A reaction lookup that fails leaves `mine` undefined,
 * which the view reads as "not known" and renders exactly as it did before —
 * never as "you have not reacted", which would be a claim we cannot make.
 */
async function fillViewerReactions(
  client: GitHubClient,
  owner: string,
  repo: string,
  issue: IssueInfo,
  comments: IssueComment[],
): Promise<void> {
  const me = await client
    .request<{ login?: string }>("GET", "/user")
    .then((u) => u.login)
    .catch(() => undefined);
  if (!me) return;

  const subjects: Array<{ path: string; target: ReactionSummary }> = [];
  if (issue.reactions && issue.reactions.total > 0) {
    subjects.push({
      path: `/repos/${enc(owner)}/${enc(repo)}/issues/${issue.number}/reactions?per_page=100`,
      target: issue.reactions,
    });
  }
  for (const c of comments) {
    if (c.reactions && c.reactions.total > 0) {
      subjects.push({
        path: `/repos/${enc(owner)}/${enc(repo)}/issues/comments/${c.id}/reactions?per_page=100`,
        target: c.reactions,
      });
    }
  }
  await Promise.all(
    subjects.map(async ({ path, target }) => {
      try {
        const raw = await client.request<Array<{ content?: string; user?: { login?: string } }>>(
          "GET",
          path,
        );
        target.mine = raw
          .filter((r) => r.user?.login === me)
          .map((r) => r.content as ReactionContent)
          .filter(Boolean);
      } catch {
        /* leave undefined — "not known", which the view renders as before */
      }
    }),
  );
}

/** Add or remove one of your reactions on an issue or a comment. */
export async function reactTo(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { subject: "issue" | "comment"; id: number; content: ReactionContent; on: boolean },
): Promise<CommitActionResult> {
  const base =
    req.subject === "issue"
      ? `/repos/${enc(owner)}/${enc(repo)}/issues/${req.id}/reactions`
      : `/repos/${enc(owner)}/${enc(repo)}/issues/comments/${req.id}/reactions`;
  try {
    if (req.on) {
      await client.requestBody("POST", base, { content: req.content });
      return { ok: true, changed: true };
    }
    // Removing needs the reaction's OWN id, which the add call returned and
    // nobody kept — so it is looked up. Filtering by content AND by login
    // matters: two people reacting with the same emoji are two reactions, and
    // deleting the wrong one removes a stranger's.
    const me = await client.request<{ login?: string }>("GET", "/user").then((u) => u.login);
    const all = await client.request<Array<{ id: number; content?: string; user?: { login?: string } }>>(
      "GET",
      `${base}?per_page=100`,
    );
    const mine = all.find((r) => r.content === req.content && r.user?.login === me);
    if (!mine) return { ok: true, changed: false };
    await client.request("DELETE", `${base}/${mine.id}`);
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, ...errorFields(err) };
  }
}

/** The repo's defined labels, for the label picker (GET …/labels). */
export async function listLabels(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoLabel[]> {
  const raw = await client.requestPaged<RawRepoLabel>(
    `/repos/${enc(owner)}/${enc(repo)}/labels?per_page=100`,
    PAGE_CAPS.detail,
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
    return { ok: false, changed: false, ...errorFields(err) };
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
    return { ok: false, changed: false, ...errorFields(err) };
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
    return { ok: false, changed: false, ...errorFields(err) };
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
/**
 * The REST body for a new issue, as one pure function.
 *
 * Labels, assignees and the milestone are sent WITH the issue rather than
 * patched on afterwards: a second request can fail on its own, and an issue
 * that exists without the labels its author chose has already been announced to
 * everyone watching the repository. Empty selections are OMITTED rather than
 * sent as `[]` — GitHub reads an explicit empty array as "clear these", which
 * on a create is a different statement from "I did not choose any".
 */
export function newIssueBody(req: {
  title: string;
  body?: string;
  labels?: string[];
  assignees?: string[];
  milestone?: number;
}): Record<string, unknown> {
  return {
    title: req.title,
    body: req.body ?? "",
    ...(req.labels?.length ? { labels: req.labels } : {}),
    ...(req.assignees?.length ? { assignees: req.assignees } : {}),
    ...(req.milestone !== undefined ? { milestone: req.milestone } : {}),
  };
}

export async function createIssue(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { title: string; body?: string; labels?: string[]; assignees?: string[]; milestone?: number },
): Promise<{ ok: boolean; number?: number; message?: string }> {
  const title = req.title.trim();
  if (!title) {
    return { ok: false, message: "An issue needs a title." };
  }
  try {
    const created = await client.request<RawIssue>(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/issues`,
      newIssueBody({ ...req, title }),
    );
    return { ok: true, number: created.number };
  } catch (err) {
    return { ok: false, ...errorFields(err) };
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
    return { ok: false, changed: false, ...errorFields(err) };
  }
}

/** Rewrite a comment's body. */
export async function editIssueComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { id: number; body: string },
): Promise<CommitActionResult> {
  try {
    await client.requestBody(
      "PATCH",
      `/repos/${enc(owner)}/${enc(repo)}/issues/comments/${req.id}`,
      { body: req.body },
    );
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, ...errorFields(err) };
  }
}

/** Delete a comment. There is no undo on GitHub's side, so the caller asks
 *  first — this function only carries it out. */
export async function deleteIssueComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  id: number,
): Promise<CommitActionResult> {
  try {
    await client.request("DELETE", `/repos/${enc(owner)}/${enc(repo)}/issues/comments/${id}`);
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, ...errorFields(err) };
  }
}

/** Close or reopen an issue (PATCH state). */
export async function setIssueState(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; state: "open" | "closed"; reason?: "completed" | "not_planned" },
): Promise<CommitActionResult> {
  try {
    await client.requestBody("PATCH", `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}`, {
      state: req.state,
      // Only when closing, and only when asked. Sending `state_reason` on a
      // reopen is meaningless, and sending it unset would overwrite the reason
      // a previous close recorded.
      ...(req.state === "closed" && req.reason ? { state_reason: req.reason } : {}),
    });
    return { ok: true, changed: true };
  } catch (err) {
    return { ok: false, changed: false, ...errorFields(err) };
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
    return { ok: false, changed: false, ...errorFields(err) };
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
    return { ok: false, changed: false, ...errorFields(err) };
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
    return { ok: false, changed: false, ...errorFields(err) };
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
    return { ok: false, changed: false, ...errorFields(err) };
  }
}
