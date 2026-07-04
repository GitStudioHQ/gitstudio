// GitHub pull-request write actions + the Create-PR support reads.
//
// These standalone functions are the section's GitHub logic. They are invoked
// from main.ts through the bridge's `withRepo` helper, which supplies an
// authenticated `GitHubClient` plus the resolved owner/repo. Following the
// section convention:
//   • READ helpers (branches / reviewers) THROW on a real API error so the
//     renderer can surface an errorState; they only degrade to a benign empty
//     result for the "no collaborator access" sub-case, where a free-text
//     fallback is the right UX.
//   • MUTATIONS never throw: they return a CommitActionResult-shaped object
//     ({ ok, changed, message }). `changed` is ALWAYS false here — none of these
//     PR API writes touch the local working tree (unlike pr:checkout), so the
//     graph/sync widgets must NOT refresh off them.
//
// We reuse the client's PUBLIC primitives (request / requestBody / graphql) and
// the shared `enc` / `mapUser` helpers; the Raw* shapes + mappers we need that
// the client keeps private (RawPull/mapPull) are redefined locally so this
// module is self-contained.

import { GitHubClient, enc, mapUser, RawUser } from "../githubClient";
import type {
  BranchRef,
  CommitActionResult,
  CreatePrRequest,
  FileDiff,
  PrPrefill,
  PrReviewComment,
  PrReviewRequest,
  PrReviewThread,
  PullRequest,
  RepoCollaborator,
  RepoLabel,
} from "../../shared/ipc";

// ── Raw API shapes (snake_case, GitHub REST) ──────────────────────────────────

interface RawRef {
  ref: string;
  sha: string;
}
interface RawPull {
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
}
interface RawBranch {
  name: string;
}
interface RawRepoMeta {
  default_branch?: string;
}
interface RawLabel {
  name: string;
  color: string;
  description: string | null;
}
/** The base64 file-contents payload from GET /contents/{path}. */
interface RawContents {
  content?: string;
  encoding?: string;
  /** Bytes; present for blobs. GitHub stops inlining content for very large files. */
  size?: number;
}

function mapPull(p: RawPull): PullRequest {
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
  };
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Resolve a PR's base + head commit SHAs (anchors for diffs + review comments). */
async function prRefs(
  client: GitHubClient,
  owner: string,
  repo: string,
  n: number,
): Promise<{ baseSha: string; headSha: string }> {
  const p = await client.request<RawPull>("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`);
  return { baseSha: p.base.sha, headSha: p.head.sha };
}

/**
 * The text of a file at a given ref via the Contents API, or "" when the path
 * doesn't exist on that side (404 = added/removed) or can't be read as text.
 *
 *  • 404 → "" (the file was added on head / deleted on base — that side is empty).
 *  • Over GitHub's ~1MB inline cap (no `content` returned) → a short placeholder
 *    so the diff degrades gracefully instead of throwing.
 *  • A real network / auth error still throws (the caller is a READ → surfaces an
 *    errorState).
 */
async function fileTextAt(
  client: GitHubClient,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  // Hard cap: never decode more than ~2MB of base64 into the renderer.
  const MAX_BYTES = 2 * 1024 * 1024;
  let raw: RawContents;
  try {
    raw = await client.request<RawContents>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/contents/${path.split("/").map(enc).join("/")}?ref=${enc(ref)}`,
    );
  } catch (err) {
    // The Contents API 404s when the path is absent at this ref — that's the
    // "added on one side / removed on the other" case, so the side is empty.
    if (/not found/i.test(errMessage(err))) return "";
    throw err;
  }
  if (typeof raw.size === "number" && raw.size > MAX_BYTES) {
    return `// File too large to display (${Math.round(raw.size / 1024)} KB).`;
  }
  if (raw.encoding !== "base64" || !raw.content) {
    // No inlined content (oversized blob or a non-file entry) — degrade cleanly.
    return raw.content ? raw.content : "// Diff not available for this file.";
  }
  try {
    const text = Buffer.from(raw.content, "base64").toString("utf8");
    // A NUL byte means binary — Monaco would render mojibake, so blank it.
    if (text.includes(String.fromCharCode(0))) return "// Binary file not shown.";
    return text;
  } catch {
    return "// Diff not available for this file.";
  }
}

// ── Mutations (never throw; return CommitActionResult) ────────────────────────

/**
 * Create a pull request. On success the message carries the new PR number
 * (e.g. "#42") so the renderer can name it in the success toast.
 */
export async function prCreate(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: CreatePrRequest,
): Promise<CommitActionResult> {
  try {
    const raw = await client.request<RawPull>("POST", `/repos/${enc(owner)}/${enc(repo)}/pulls`, {
      title: req.title,
      head: req.head,
      base: req.base,
      body: req.body ?? "",
      draft: req.draft ?? false,
    });
    return { ok: true, changed: false, message: `#${mapPull(raw).number}` };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Add an issue comment to the PR's conversation (PRs share the issues endpoint). */
export async function prComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; body: string },
): Promise<CommitActionResult> {
  try {
    await client.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}/comments`, {
      body: req.body,
    });
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Submit a review: REQUEST_CHANGES | COMMENT (APPROVE keeps flowing through the
 * existing pr:approve path). GitHub requires a non-empty body for both events
 * here — the renderer enforces that before calling; a 422 surfaces verbatim.
 */
export async function prReview(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: PrReviewRequest,
): Promise<CommitActionResult> {
  try {
    await client.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/pulls/${req.number}/reviews`, {
      event: req.event,
      ...(req.body ? { body: req.body } : {}),
    });
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Close or reopen a PR (PATCH state on the pulls resource). */
export async function prSetState(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; state: "open" | "closed" },
): Promise<CommitActionResult> {
  try {
    await client.requestBody("PATCH", `/repos/${enc(owner)}/${enc(repo)}/pulls/${req.number}`, {
      state: req.state,
    });
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Request reviewers for a PR. 422s on non-collaborators / the PR author. */
export async function prRequestReviewers(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; reviewers: string[] },
): Promise<CommitActionResult> {
  try {
    await client.requestBody(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${req.number}/requested_reviewers`,
      { reviewers: req.reviewers },
    );
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Convert a draft PR to ready-for-review. GitHub exposes this ONLY via GraphQL,
 * so we first resolve the PR node id, then run the mutation.
 */
export async function prMarkReady(
  client: GitHubClient,
  owner: string,
  repo: string,
  n: number,
): Promise<CommitActionResult> {
  try {
    const data = await client.graphql<{ repository?: { pullRequest?: { id: string } } }>(
      `query($owner:String!,$repo:String!,$n:Int!){repository(owner:$owner,name:$repo){pullRequest(number:$n){id}}}`,
      { owner, repo, n },
    );
    const id = data?.repository?.pullRequest?.id;
    if (!id) {
      return { ok: false, changed: false, message: "Couldn't resolve the pull request to mark ready." };
    }
    await client.graphql<unknown>(
      `mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{number}}}`,
      { id },
    );
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

// ── Create-PR support reads (throw on API error) ──────────────────────────────

/**
 * All branches in the repo (head/base selectors), flagged with the default.
 * Single page of 100, matching the rest of the client's pagination convention.
 */
export async function prBranches(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<BranchRef[]> {
  const [branches, def] = await Promise.all([
    client.request<RawBranch[]>("GET", `/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100`),
    client
      .request<RawRepoMeta>("GET", `/repos/${enc(owner)}/${enc(repo)}`)
      .then((m) => m.default_branch ?? "main")
      .catch(() => "main"),
  ]);
  return branches.map((b) => ({ name: b.name, isDefault: b.name === def }));
}

/**
 * Collaborators with push access — the candidate set for "Request reviewers".
 * This GET 403s for non-admins on some repos; we degrade to [] so the renderer
 * can fall back to a free-text login list rather than erroring the whole flow.
 */
export async function prReviewers(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoCollaborator[]> {
  try {
    const raw = await client.request<RawUser[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/collaborators?per_page=100`,
    );
    return raw.map((u) => ({ login: u.login, avatarUrl: u.avatar_url ?? null }));
  } catch {
    return [];
  }
}

// ── PR review depth: per-file diffs + inline threads + metadata reads ──────────

/**
 * A single file's two sides for the shared 2-pane DiffView: the file's content
 * at the PR base vs. at the PR head. We anchor on the PR's commit SHAs (stable
 * even when the head branch isn't a local ref) and read each side through the
 * Contents API. A side that 404s (added on head / removed on base) comes back as
 * "" so the diff still renders one-sided. Throws on a real API failure so the
 * renderer can show an errorState with Retry.
 */
export async function fileDiff(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; path: string },
): Promise<FileDiff | undefined> {
  const { baseSha, headSha } = await prRefs(client, owner, repo, req.number);
  const [leftText, rightText] = await Promise.all([
    fileTextAt(client, owner, repo, req.path, baseSha),
    fileTextAt(client, owner, repo, req.path, headSha),
  ]);
  return {
    path: req.path,
    leftLabel: "base",
    rightLabel: "head",
    leftText,
    rightText,
    conflicted: false,
  };
}

// ── GraphQL shapes for review threads ──
interface RawThreadsData {
  repository?: {
    pullRequest?: {
      reviewThreads?: {
        nodes?: {
          id: string;
          path: string | null;
          line: number | null;
          isResolved: boolean;
          isOutdated: boolean;
          comments?: {
            nodes?: {
              id: string;
              author?: { login?: string; avatarUrl?: string; url?: string } | null;
              body: string;
              createdAt: string;
            }[];
          };
        }[];
      };
    };
  };
}

/**
 * The PR's inline review threads (each anchored to a file + line), with their
 * comments. GitHub exposes review threads + their resolution state ONLY via
 * GraphQL, so we query there. Throws on a real API error (READ → errorState).
 */
export async function reviewThreads(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<PrReviewThread[]> {
  const data = await client.graphql<RawThreadsData>(
    `query($owner:String!,$repo:String!,$n:Int!){
      repository(owner:$owner,name:$repo){
        pullRequest(number:$n){
          reviewThreads(first:100){
            nodes{
              id path line isResolved isOutdated
              comments(first:50){nodes{id author{login avatarUrl url} body createdAt}}
            }
          }
        }
      }
    }`,
    { owner, repo, n: number },
  );
  const nodes = data?.repository?.pullRequest?.reviewThreads?.nodes ?? [];
  return nodes.map((t) => {
    const comments: PrReviewComment[] = (t.comments?.nodes ?? []).map((c) => ({
      id: c.id,
      author: { login: c.author?.login ?? "ghost", avatarUrl: c.author?.avatarUrl ?? null },
      body: c.body ?? "",
      createdAt: c.createdAt ?? "",
    }));
    return {
      id: t.id,
      path: t.path ?? "",
      line: t.line ?? null,
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments,
    };
  });
}

/**
 * The repo's labels — the option set for the PR's "Labels" picker. Single page
 * of 100, matching the client's pagination convention. Throws on API error.
 */
export async function labels(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<RepoLabel[]> {
  const raw = await client.request<RawLabel[]>(
    "GET",
    `/repos/${enc(owner)}/${enc(repo)}/labels?per_page=100`,
  );
  return raw.map((l) => ({ name: l.name, color: l.color, description: l.description ?? null }));
}

/**
 * Prefill for the "Create PR from current branch" flow: the repo's default
 * branch, used as the base. The head (the current local branch) is filled in by
 * the renderer, so we leave `headRef` undefined. Kept deliberately simple — a
 * single cheap repo-meta read; degrades to "main" if it can't be resolved.
 */
export async function prefill(
  client: GitHubClient,
  owner: string,
  repo: string,
): Promise<PrPrefill> {
  const baseRef = await client
    .request<RawRepoMeta>("GET", `/repos/${enc(owner)}/${enc(repo)}`)
    .then((m) => m.default_branch ?? "main")
    .catch(() => "main");
  return { baseRef };
}

// ── PR review depth: inline review + metadata mutations (never throw) ──────────

/**
 * Add a single inline review comment on the PR's head commit at path+line. Side
 * defaults to RIGHT (the head/new side), which is what "comment on this line of
 * the diff" means. Returns a CommitActionResult — a 422 (e.g. line not part of
 * the diff) surfaces verbatim.
 */
export async function addReviewComment(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; path: string; line: number; side?: "LEFT" | "RIGHT"; body: string },
): Promise<CommitActionResult> {
  try {
    const { headSha } = await prRefs(client, owner, repo, req.number);
    await client.requestBody(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${req.number}/comments`,
      {
        body: req.body,
        commit_id: headSha,
        path: req.path,
        line: req.line,
        side: req.side ?? "RIGHT",
      },
    );
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Reply to an existing review thread. GitHub's REST reply endpoint needs the
 * root comment's numeric id, which we don't carry; the thread's node id is what
 * the renderer has, so we use the GraphQL reply mutation (anchored by thread id).
 */
export async function replyThread(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; threadId: string; body: string },
): Promise<CommitActionResult> {
  try {
    await client.graphql<unknown>(
      `mutation($threadId:ID!,$body:String!){
        addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){
          comment{id}
        }
      }`,
      { threadId: req.threadId, body: req.body },
    );
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Resolve or unresolve a review thread (GraphQL — no REST equivalent). */
export async function resolveThread(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { threadId: string; resolved: boolean },
): Promise<CommitActionResult> {
  void owner;
  void repo;
  const field = req.resolved ? "resolveReviewThread" : "unresolveReviewThread";
  try {
    await client.graphql<unknown>(
      `mutation($threadId:ID!){
        ${field}(input:{threadId:$threadId}){thread{id isResolved}}
      }`,
      { threadId: req.threadId },
    );
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/** Edit a PR's title and/or body (PATCH on the pulls resource). */
export async function edit(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; title?: string; body?: string },
): Promise<CommitActionResult> {
  try {
    const patch: Record<string, string> = {};
    if (req.title !== undefined) patch.title = req.title;
    if (req.body !== undefined) patch.body = req.body;
    await client.requestBody("PATCH", `/repos/${enc(owner)}/${enc(repo)}/pulls/${req.number}`, patch);
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Set the PR's labels (PRs share the issues endpoint). PUT replaces the full
 * set, so the renderer passes the desired final list.
 */
export async function setLabels(
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
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Reconcile the PR's assignees to exactly `req.assignees`. GitHub's assignees
 * API is additive/subtractive (no "set"), so we read the current assignees,
 * compute the add/remove deltas, and issue only the calls that are needed. PRs
 * share the issues endpoint here.
 */
export async function setAssignees(
  client: GitHubClient,
  owner: string,
  repo: string,
  req: { number: number; assignees: string[] },
): Promise<CommitActionResult> {
  try {
    const issue = await client.request<{ assignees?: { login: string }[] }>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}`,
    );
    const current = new Set((issue.assignees ?? []).map((a) => a.login));
    const wanted = new Set(req.assignees);
    const toAdd = [...wanted].filter((l) => !current.has(l));
    const toRemove = [...current].filter((l) => !wanted.has(l));
    if (toAdd.length) {
      await client.requestBody(
        "POST",
        `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}/assignees`,
        { assignees: toAdd },
      );
    }
    if (toRemove.length) {
      // DELETE with a body — the client's request() sends the JSON body for any verb.
      await client.request<unknown>(
        "DELETE",
        `/repos/${enc(owner)}/${enc(repo)}/issues/${req.number}/assignees`,
        { assignees: toRemove },
      );
    }
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}

/**
 * Update the PR's branch by merging the latest base into it (the "Update branch"
 * button). 422s when the branch is already up to date or can't be updated — the
 * message surfaces so the renderer can toast it.
 */
export async function updateBranch(
  client: GitHubClient,
  owner: string,
  repo: string,
  number: number,
): Promise<CommitActionResult> {
  try {
    await client.requestBody("PUT", `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/update-branch`, {});
    return { ok: true, changed: false };
  } catch (err) {
    return { ok: false, changed: false, message: errMessage(err) };
  }
}
