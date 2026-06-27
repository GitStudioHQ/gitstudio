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
  PrReviewRequest,
  PullRequest,
  RepoCollaborator,
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
