// A thin GitHub REST client for the PR layer (M11). It runs on the extension
// host via Node's global `fetch`, talks only to api.github.com, and returns
// typed results. Errors are normalised into a friendly `GitHubApiError` rather
// than raw throws so call sites (and especially tree refreshes) can degrade
// gracefully — 401 → re-auth, 403 rate-limit → reset time, 404 → not found,
// network → offline message.

const API_BASE = "https://api.github.com";

/** Minimal shape of a PR as returned by the list + detail endpoints. */
export interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  state: string;
  draft: boolean;
  htmlUrl: string;
  user: GitHubUser | null;
  createdAt: string;
  updatedAt: string;
  head: PrRef;
  base: PrRef;
  labels: PrLabel[];
  requestedReviewers: GitHubUser[];
  /** Total additions/deletions/changed files, present on the detail response. */
  additions?: number;
  deletions?: number;
  changedFiles?: number;
}

export interface PrRef {
  ref: string;
  sha: string;
  /** "owner:branch" label; differs from `ref` for cross-fork PRs. */
  label: string;
  repoFullName: string | null;
  cloneUrl: string | null;
}

export interface PrLabel {
  name: string;
  color: string;
}

export interface GitHubUser {
  login: string;
  avatarUrl: string | null;
  htmlUrl: string | null;
}

/** One changed file in a PR, with its unified-diff patch when available. */
export interface PrFile {
  filename: string;
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/** Roll-up of a ref's commit status / check-runs. */
export interface CombinedStatus {
  /** "success" | "failure" | "pending" | "error" | "" (none). */
  state: string;
  totalCount: number;
}

export interface ReviewComment {
  path: string;
  line: number;
  side?: "LEFT" | "RIGHT";
  body: string;
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface SubmitReviewInput {
  event: ReviewEvent;
  body?: string;
  comments?: ReviewComment[];
}

export interface CreatePrInput {
  title: string;
  head: string;
  base: string;
  body?: string;
  draft?: boolean;
}

export type MergeMethod = "merge" | "squash" | "rebase";

/** A normalised API failure with a human-friendly message. */
export class GitHubApiError extends Error {
  constructor(
    message: string,
    readonly kind:
      | "auth"
      | "rate-limit"
      | "not-found"
      | "validation"
      | "network"
      | "server",
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubApiOptions {
  /** Async token getter; called per request so an expired token can refresh. */
  getToken: (opts?: { interactive?: boolean }) => Promise<string | undefined>;
}

export class GitHubApi {
  constructor(private readonly opts: GitHubApiOptions) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: { interactiveAuth?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    const token = await this.opts.getToken({
      interactive: init?.interactiveAuth ?? false,
    });
    if (!token) {
      throw new GitHubApiError(
        "Connect GitHub to use pull requests.",
        "auth",
        401,
      );
    }

    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "GitStudio",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: init?.signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }
      throw new GitHubApiError(
        "Couldn't reach GitHub. Check your network connection.",
        "network",
      );
    }

    if (res.ok) {
      // 204 No Content (e.g. an empty body) → undefined cast to T.
      if (res.status === 204) {
        return undefined as T;
      }
      const text = await res.text();
      return (text.length > 0 ? JSON.parse(text) : undefined) as T;
    }

    throw await this.toError(res);
  }

  private async toError(res: Response): Promise<GitHubApiError> {
    let detail = "";
    try {
      const data = (await res.json()) as { message?: string };
      detail = data?.message ?? "";
    } catch {
      // Non-JSON error body — ignore.
    }

    if (res.status === 401) {
      return new GitHubApiError(
        "Your GitHub session expired. Sign in again to continue.",
        "auth",
        401,
      );
    }
    if (res.status === 403) {
      const remaining = res.headers.get("x-ratelimit-remaining");
      if (remaining === "0") {
        const reset = res.headers.get("x-ratelimit-reset");
        const when = reset
          ? new Date(Number(reset) * 1000).toLocaleTimeString()
          : "later";
        return new GitHubApiError(
          `GitHub rate limit reached. Try again after ${when}.`,
          "rate-limit",
          403,
        );
      }
      return new GitHubApiError(
        detail || "GitHub denied the request (insufficient permissions).",
        "auth",
        403,
      );
    }
    if (res.status === 404) {
      return new GitHubApiError(
        detail || "Not found on GitHub.",
        "not-found",
        404,
      );
    }
    if (res.status === 422) {
      return new GitHubApiError(
        detail || "GitHub rejected the request.",
        "validation",
        422,
      );
    }
    return new GitHubApiError(
      detail || `GitHub request failed (HTTP ${res.status}).`,
      "server",
      res.status,
    );
  }

  // ── User ───────────────────────────────────────────────────────────────────

  /** `GET /user` → the authenticated login, or undefined when not signed in. */
  async currentLogin(interactive = false): Promise<GitHubUser | undefined> {
    try {
      const u = await this.request<RawUser>("GET", "/user", undefined, {
        interactiveAuth: interactive,
      });
      return mapUser(u);
    } catch {
      return undefined;
    }
  }

  // ── Repository ───────────────────────────────────────────────────────────────

  /** `GET /repos/{owner}/{repo}` → the default branch name (best-effort). */
  async defaultBranch(
    owner: string,
    repo: string,
  ): Promise<string | undefined> {
    try {
      const raw = await this.request<{ default_branch?: string }>(
        "GET",
        `/repos/${enc(owner)}/${enc(repo)}`,
      );
      return raw.default_branch;
    } catch {
      return undefined;
    }
  }

  // ── Pull requests ────────────────────────────────────────────────────────────

  /**
   * Best-effort map of commit-author email → GitHub avatar URL from one
   * `GET /repos/{owner}/{repo}/commits?per_page=100` page. GitHub resolves each
   * commit's author to a user account (when the email is associated with one)
   * and returns `author.avatar_url`; we key it by the git email so the commit
   * graph can show real profile photos. Unresolved emails simply don't appear
   * (the graph then falls back to Gravatar / the initials disc).
   */
  async commitAuthorAvatars(
    owner: string,
    repo: string,
    ref?: string,
    init?: { signal?: AbortSignal },
  ): Promise<Record<string, string>> {
    const q = ref ? `?sha=${enc(ref)}&per_page=100` : `?per_page=100`;
    const raw = await this.request<RawCommitListItem[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/commits${q}`,
      undefined,
      init,
    );
    const map: Record<string, string> = {};
    for (const c of raw ?? []) {
      const email = c.commit?.author?.email?.toLowerCase();
      const avatar = c.author?.avatar_url;
      if (email && avatar) {
        map[email] = avatar;
      }
    }
    return map;
  }

  /** `GET /repos/{owner}/{repo}/pulls?state=open` (paged, first 100). */
  async listOpenPulls(
    owner: string,
    repo: string,
    init?: { interactiveAuth?: boolean; signal?: AbortSignal },
  ): Promise<PullRequest[]> {
    const raw = await this.request<RawPull[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      undefined,
      init,
    );
    return raw.map(mapPull);
  }

  /** `GET /repos/{owner}/{repo}/pulls/{n}`. */
  async getPull(
    owner: string,
    repo: string,
    number: number,
    init?: { interactiveAuth?: boolean; signal?: AbortSignal },
  ): Promise<PullRequest> {
    const raw = await this.request<RawPull>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`,
      undefined,
      init,
    );
    return mapPull(raw);
  }

  /** `GET /repos/{owner}/{repo}/pulls/{n}/files` (first 100 files). */
  async getPullFiles(
    owner: string,
    repo: string,
    number: number,
    init?: { interactiveAuth?: boolean; signal?: AbortSignal },
  ): Promise<PrFile[]> {
    return this.request<PrFile[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/files?per_page=100`,
      undefined,
      init,
    );
  }

  /** `GET /repos/{owner}/{repo}/commits/{ref}/status` → combined CI state. */
  async getCombinedStatus(
    owner: string,
    repo: string,
    ref: string,
    init?: { interactiveAuth?: boolean; signal?: AbortSignal },
  ): Promise<CombinedStatus> {
    const raw = await this.request<RawStatus>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status`,
      undefined,
      init,
    );
    return { state: raw.state ?? "", totalCount: raw.total_count ?? 0 };
  }

  /** `POST /repos/{owner}/{repo}/pulls/{n}/reviews` — submit a review. */
  async submitReview(
    owner: string,
    repo: string,
    number: number,
    input: SubmitReviewInput,
  ): Promise<void> {
    await this.request(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/reviews`,
      {
        event: input.event,
        body: input.body ?? "",
        comments: (input.comments ?? []).map((c) => ({
          path: c.path,
          line: c.line,
          side: c.side ?? "RIGHT",
          body: c.body,
        })),
      },
      { interactiveAuth: true },
    );
  }

  /** `POST /repos/{owner}/{repo}/pulls` — create a PR; returns the new PR. */
  async createPull(
    owner: string,
    repo: string,
    input: CreatePrInput,
  ): Promise<PullRequest> {
    const raw = await this.request<RawPull>(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/pulls`,
      input,
      { interactiveAuth: true },
    );
    return mapPull(raw);
  }

  /** `PUT /repos/{owner}/{repo}/pulls/{n}/merge`. */
  async mergePull(
    owner: string,
    repo: string,
    number: number,
    method: MergeMethod,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/merge`,
      { merge_method: method },
      { interactiveAuth: true },
    );
  }

  /** `POST /repos/{owner}/{repo}/pulls/{n}/requested_reviewers`. */
  async requestReviewers(
    owner: string,
    repo: string,
    number: number,
    reviewers: string[],
  ): Promise<void> {
    await this.request(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/requested_reviewers`,
      { reviewers },
      { interactiveAuth: true },
    );
  }
}

function enc(part: string): string {
  return encodeURIComponent(part);
}

// ── Raw → typed mapping ────────────────────────────────────────────────────────

interface RawUser {
  login: string;
  avatar_url?: string;
  html_url?: string;
}

interface RawCommitListItem {
  commit?: { author?: { email?: string | null } | null } | null;
  author?: RawUser | null;
}

interface RawRef {
  ref: string;
  sha: string;
  label?: string;
  repo?: { full_name?: string; clone_url?: string } | null;
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
  requested_reviewers?: RawUser[];
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface RawStatus {
  state?: string;
  total_count?: number;
}

function mapUser(u: RawUser | null): GitHubUser | undefined {
  if (!u) {
    return undefined;
  }
  return {
    login: u.login,
    avatarUrl: u.avatar_url ?? null,
    htmlUrl: u.html_url ?? null,
  };
}

function mapRef(r: RawRef): PrRef {
  return {
    ref: r.ref,
    sha: r.sha,
    label: r.label ?? r.ref,
    repoFullName: r.repo?.full_name ?? null,
    cloneUrl: r.repo?.clone_url ?? null,
  };
}

function mapPull(p: RawPull): PullRequest {
  return {
    number: p.number,
    title: p.title,
    body: p.body,
    state: p.state,
    draft: p.draft ?? false,
    htmlUrl: p.html_url,
    user: mapUser(p.user) ?? null,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    head: mapRef(p.head),
    base: mapRef(p.base),
    labels: (p.labels ?? []).map((l) => ({ name: l.name, color: l.color })),
    requestedReviewers: (p.requested_reviewers ?? [])
      .map(mapUser)
      .filter((u): u is GitHubUser => u !== undefined),
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changed_files,
  };
}
