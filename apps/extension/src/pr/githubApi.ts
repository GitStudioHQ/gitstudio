// A thin GitHub REST (+ one GraphQL query) client for the PR layer (M11). It
// runs on the extension host via Node's global `fetch`, talks only to
// api.github.com, and returns typed results. Errors are normalised into a
// friendly `GitHubApiError` rather than raw throws so call sites (and
// especially tree refreshes) can degrade gracefully — 401 → re-auth, 403/429
// rate limits → when to retry, 404 → not found, 422 → what GitHub objected to,
// network → offline message.
//
// Every list follows GitHub's `Link: rel="next"` chain. `per_page=100` alone
// silently cut a busy repository's open PRs at 100, and a big PR's files at
// 100 — and the list, the panel's count and the review's commentable files
// all said so as if it were complete.

import {
  ciFromRollupState,
  rollupCi,
  type CiRollup,
  type CiState,
  type ReviewPayload,
} from "./prModel";

const API_BASE = "https://api.github.com";
const GRAPHQL = `${API_BASE}/graphql`;

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
  /** Set when the PR was merged; a closed PR without it was closed unmerged. */
  mergedAt: string | null;
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
  /** The path before a rename or copy. */
  previousFilename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** Absent for a binary file, or one too large for GitHub to diff. */
  patch?: string;
}

/** A list GitHub may have more of than we read. */
export interface Paged<T> {
  items: T[];
  /** True when the page cap stopped the read with pages still to come. */
  truncated: boolean;
}

/** A file's content at one commit, as the diff panes need it. */
export type FileContent =
  | { kind: "text"; text: string }
  /** The path does not exist at that commit (added / deleted side). */
  | { kind: "missing" }
  | { kind: "binary"; bytes: number }
  | { kind: "too-large"; bytes: number };

/** The repository settings Merge and Create PR read. */
export interface RepoSettings {
  defaultBranch?: string;
  /** The merge methods the repository allows, in GitHub's order. */
  mergeMethods: MergeMethod[];
}

export type ReviewEvent = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";

export interface CreatePrInput {
  title: string;
  /** The branch, or `owner:branch` when it lives in another repository (a fork). */
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
    /**
     * Where on github.com the user can put it right, when GitHub names a
     * place: a 403 from an organization's SAML single sign-on carries the
     * page that authorizes this sign-in for it (`X-GitHub-SSO: required;
     * url=…`).
     */
    readonly helpUrl?: string,
  ) {
    super(message);
    this.name = "GitHubApiError";
  }
}

export interface GitHubApiOptions {
  /** Async token getter; called per request so an expired token can refresh. */
  getToken: (opts?: { interactive?: boolean }) => Promise<string | undefined>;
}

interface RequestInitLite {
  interactiveAuth?: boolean;
  signal?: AbortSignal;
  accept?: string;
}

/** Page caps: how many 100-item pages a list follows before it stops and says so. */
export const PAGE_CAPS = {
  /** Open pull requests: 1,000. */
  pulls: 10,
  /** A PR's files: GitHub itself lists at most 3,000. */
  files: 30,
  /** Check runs and statuses on one commit. */
  checks: 5,
} as const;

/** Largest blob the diff panes load (the Contents API serves up to 100 MB). */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export class GitHubApi {
  constructor(private readonly opts: GitHubApiOptions) {}

  /** Auth headers, network-error wrapping, non-2xx → GitHubApiError. */
  private async fetchRes(
    method: string,
    url: string,
    body?: unknown,
    init?: RequestInitLite,
  ): Promise<Response> {
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
      res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: init?.accept ?? "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "GitStudio",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: init?.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw err;
      }
      throw new GitHubApiError(
        "Couldn't reach GitHub. Check your network connection.",
        "network",
      );
    }
    if (!res.ok) {
      throw await toError(res);
    }
    return res;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    init?: RequestInitLite,
  ): Promise<T> {
    const res = await this.fetchRes(method, `${API_BASE}${path}`, body, init);
    // 204 No Content (e.g. an empty body) → undefined cast to T.
    if (res.status === 204) {
      return undefined as T;
    }
    const text = await res.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /**
   * GET a list, following `Link: rel="next"` up to `maxPages` pages. `key`
   * names the array in an object-bodied answer (`{ check_runs: [...] }`); an
   * array body is read as is. `signal` stops it between pages too, whatever
   * the fetch underneath does with an aborted one.
   */
  private async requestPaged<T>(
    path: string,
    maxPages: number,
    init?: RequestInitLite & { key?: string },
  ): Promise<Paged<T>> {
    const items: T[] = [];
    let next: string | undefined = `${API_BASE}${path}`;
    let pages = 0;
    while (next && pages < maxPages) {
      init?.signal?.throwIfAborted();
      const res = await this.fetchRes("GET", next, undefined, init);
      pages++;
      const text = await res.text();
      const parsed = (text.length > 0 ? JSON.parse(text) : []) as unknown;
      const chunk = init?.key
        ? (parsed as Record<string, unknown>)?.[init.key]
        : parsed;
      if (Array.isArray(chunk)) {
        items.push(...(chunk as T[]));
      }
      next = nextPageUrl(res.headers.get("link"));
    }
    return { items, truncated: next !== undefined };
  }

  /** One GraphQL query. Errors with no data at all throw; partial data is kept. */
  private async graphql<T>(
    query: string,
    variables: Record<string, unknown>,
    init?: { signal?: AbortSignal },
  ): Promise<T> {
    const res = await this.fetchRes("POST", GRAPHQL, { query, variables }, init);
    const json = (await res.json()) as { data?: T; errors?: { message?: string }[] };
    if (!json.data) {
      throw new GitHubApiError(
        json.errors?.[0]?.message || "GitHub couldn't answer the query.",
        "server",
      );
    }
    return json.data;
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
      return (await this.repoSettings(owner, repo)).defaultBranch;
    } catch {
      return undefined;
    }
  }

  /**
   * The default branch and the merge methods the repository allows. GitHub
   * refuses a method a repository has turned off (405), so Merge offers only
   * these. A repository that reports none (a token that can't read the
   * settings) is treated as allowing all three, as before.
   */
  async repoSettings(owner: string, repo: string): Promise<RepoSettings> {
    const raw = await this.request<RawRepo>("GET", `/repos/${enc(owner)}/${enc(repo)}`);
    const allowed: MergeMethod[] = [];
    if (raw.allow_merge_commit !== false) allowed.push("merge");
    if (raw.allow_squash_merge !== false) allowed.push("squash");
    if (raw.allow_rebase_merge !== false) allowed.push("rebase");
    return { defaultBranch: raw.default_branch, mergeMethods: allowed };
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

  /** Every open PR, newest update first (up to PAGE_CAPS.pulls pages). */
  async listOpenPulls(
    owner: string,
    repo: string,
    init?: { interactiveAuth?: boolean; signal?: AbortSignal },
  ): Promise<Paged<PullRequest>> {
    const raw = await this.requestPaged<RawPull>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=100`,
      PAGE_CAPS.pulls,
      init,
    );
    return { items: raw.items.map(mapPull), truncated: raw.truncated };
  }

  /** The open PR whose head is `head` (`owner:branch`), if there is one. */
  async findOpenPullForHead(
    owner: string,
    repo: string,
    head: string,
  ): Promise<PullRequest | undefined> {
    const raw = await this.request<RawPull[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&head=${enc(head)}&per_page=1`,
    );
    return raw?.[0] ? mapPull(raw[0]) : undefined;
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

  /**
   * The commit a PR's diff is counted from: the merge base of its base and
   * head. GitHub's patch for a PR is the three-dot diff — its left-hand line
   * numbers, and a LEFT review comment's `line`, are the MERGE BASE's — while
   * `base.sha` is the base branch's tip, which moves on as others merge. The
   * base side of a diff drawn at base.sha put the hunks on the wrong lines and
   * showed the base branch's own new work as if the PR removed it.
   * `per_page=1`: the answer lists commits too, and only this one is wanted.
   */
  async mergeBase(owner: string, repo: string, base: string, head: string): Promise<string | undefined> {
    const raw = await this.request<{ merge_base_commit?: { sha?: string } | null }>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/compare/${enc(base)}...${enc(head)}?per_page=1`,
    );
    const sha = raw?.merge_base_commit?.sha;
    return typeof sha === "string" && sha.length > 0 ? sha : undefined;
  }

  /**
   * A PR's changed files, every page GitHub has (it lists at most 3,000).
   * Mapped field by field: the raw answer says `previous_filename`, and cast
   * as is, every rename lost the path it was renamed from.
   */
  async getPullFiles(
    owner: string,
    repo: string,
    number: number,
    init?: { interactiveAuth?: boolean; signal?: AbortSignal },
  ): Promise<Paged<PrFile>> {
    const raw = await this.requestPaged<RawFile>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/files?per_page=100`,
      PAGE_CAPS.files,
      init,
    );
    return { items: raw.items.map(mapFile), truncated: raw.truncated };
  }

  /**
   * What a commit's checks add up to: its check runs (GitHub Actions and every
   * Checks API app) together with its legacy commit statuses. The combined
   * status endpoint alone knows only the latter, and answers "pending" with
   * none of them for every repository on Actions.
   */
  async getCi(owner: string, repo: string, sha: string): Promise<CiRollup> {
    const base = `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(sha)}`;
    const [runs, statuses] = await Promise.all([
      this.requestPaged<RawCheckRun>(`${base}/check-runs?per_page=100`, PAGE_CAPS.checks, {
        key: "check_runs",
      }),
      this.requestPaged<RawStatus>(`${base}/status?per_page=100`, PAGE_CAPS.checks, {
        key: "statuses",
      }),
    ]);
    return rollupCi(runs.items, statuses.items);
  }

  /**
   * The checks state of many PRs' heads in one GraphQL request per 50 PRs:
   * `statusCheckRollup`, which GitHub computes from check runs AND statuses.
   * Two REST calls per row would cost hundreds of requests for a busy list.
   * A PR missing from the answer is simply absent from the map.
   *
   * `signal` stops it between requests too: a list closed while its batch
   * was still paging went on asking GitHub for rows nobody would see.
   */
  async ciForPulls(
    owner: string,
    repo: string,
    numbers: readonly number[],
    init?: { signal?: AbortSignal },
  ): Promise<Map<number, CiState>> {
    const out = new Map<number, CiState>();
    for (let i = 0; i < numbers.length; i += 50) {
      init?.signal?.throwIfAborted();
      const chunk = numbers.slice(i, i + 50).filter((n) => Number.isSafeInteger(n) && n > 0);
      if (chunk.length === 0) continue;
      const fields = chunk
        .map(
          (n) =>
            `pr${n}: pullRequest(number: ${n}) { commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }`,
        )
        .join("\n");
      const data = await this.graphql<{
        repository?: Record<
          string,
          { commits?: { nodes?: { commit?: { statusCheckRollup?: { state?: string } | null } }[] } } | null
        > | null;
      }>(
        `query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) {\n${fields}\n} }`,
        { owner, name: repo },
        init,
      );
      for (const n of chunk) {
        const node = data.repository?.[`pr${n}`];
        if (!node) continue;
        out.set(n, ciFromRollupState(node.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state));
      }
    }
    return out;
  }

  /**
   * A file's content at one commit, for a diff pane. 404 means the path is
   * absent there (the added or deleted side). Binary content (a NUL byte) and
   * blobs over 5 MB are reported as such, never decoded into the editor.
   * Every other failure — signed out, rate-limited, offline — THROWS: an
   * empty pane would claim the file was added or deleted.
   */
  async fileAt(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    init?: { signal?: AbortSignal },
  ): Promise<FileContent> {
    let res: Response;
    try {
      res = await this.fetchRes(
        "GET",
        `${API_BASE}/repos/${enc(owner)}/${enc(repo)}/contents/${path
          .split("/")
          .map(enc)
          .join("/")}?ref=${enc(ref)}`,
        undefined,
        { ...init, accept: "application/vnd.github.raw+json" },
      );
    } catch (err) {
      if (err instanceof GitHubApiError && err.status === 404) {
        return { kind: "missing" };
      }
      throw err;
    }
    const declared = Number(res.headers.get("content-length") ?? NaN);
    if (Number.isFinite(declared) && declared > MAX_FILE_BYTES) {
      return { kind: "too-large", bytes: declared };
    }
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length > MAX_FILE_BYTES) {
      return { kind: "too-large", bytes: bytes.length };
    }
    if (bytes.subarray(0, 8000).includes(0)) {
      return { kind: "binary", bytes: bytes.length };
    }
    return { kind: "text", text: new TextDecoder("utf-8").decode(bytes) };
  }

  /** `POST /repos/{owner}/{repo}/pulls/{n}/reviews` — submit a review. */
  async submitReview(
    owner: string,
    repo: string,
    number: number,
    payload: ReviewPayload,
  ): Promise<void> {
    await this.request(
      "POST",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}/reviews`,
      payload,
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

/**
 * The rel="next" URL from a `Link` header, or undefined on the last page. A
 * next page on any host but api.github.com is never followed.
 */
export function nextPageUrl(link: string | null | undefined): string | undefined {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*(?:[^,]*;\s*)?rel="next"/.exec(part.trim());
    if (!m) continue;
    return m[1].startsWith(`${API_BASE}/`) ? m[1] : undefined;
  }
  return undefined;
}

/**
 * A non-2xx answer → the sentence the user sees. GitHub's own message is kept
 * where it says something; a 422's `errors[]` — WHICH field or line it
 * refused — is added, where the bare message said only "Unprocessable Entity"
 * or "Validation Failed".
 */
async function toError(res: Response): Promise<GitHubApiError> {
  let detail = "";
  let reasons: string[] = [];
  try {
    const data = (await res.json()) as {
      message?: string;
      errors?: (string | { message?: string; code?: string; field?: string; resource?: string })[];
    };
    detail = data?.message ?? "";
    reasons = (data?.errors ?? [])
      .map((e) =>
        typeof e === "string"
          ? e
          : e.message ?? [e.resource, e.field, e.code].filter(Boolean).join(" "),
      )
      .filter((s): s is string => !!s && s.length > 0);
  } catch {
    // Non-JSON error body — ignore.
  }

  const retryAt = (): string => {
    const reset = res.headers.get("x-ratelimit-reset");
    const after = Number(res.headers.get("retry-after") ?? NaN);
    if (Number.isFinite(after)) {
      return new Date(Date.now() + after * 1000).toLocaleTimeString();
    }
    return reset ? new Date(Number(reset) * 1000).toLocaleTimeString() : "a few minutes";
  };

  if (res.status === 401) {
    return new GitHubApiError(
      "Your GitHub session expired. Sign in again to continue.",
      "auth",
      401,
    );
  }
  if (
    res.status === 429 ||
    (res.status === 403 &&
      (res.headers.get("x-ratelimit-remaining") === "0" ||
        res.headers.get("retry-after") !== null ||
        /rate limit/i.test(detail)))
  ) {
    return new GitHubApiError(
      `GitHub rate limit reached. Try again after ${retryAt()}.`,
      "rate-limit",
      res.status,
    );
  }
  if (res.status === 403) {
    // Signed in, and refused: a permission, or an organization's SAML SSO —
    // which names the page that authorizes this sign-in for it.
    const sso = /\burl=(https:\/\/github\.com\/\S+)/.exec(res.headers.get("x-github-sso") ?? "")?.[1];
    return new GitHubApiError(
      detail || "GitHub denied the request (insufficient permissions).",
      "auth",
      403,
      sso,
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
    const why = reasons.length > 0 ? reasons.join("; ") : "";
    const head = detail && detail !== "Unprocessable Entity" ? detail : "GitHub rejected the request";
    return new GitHubApiError(why ? `${head}: ${why}` : `${head}.`, "validation", 422);
  }
  return new GitHubApiError(
    detail || `GitHub request failed (HTTP ${res.status}).`,
    "server",
    res.status,
  );
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
  merged_at?: string | null;
  head: RawRef;
  base: RawRef;
  labels?: { name: string; color: string }[];
  requested_reviewers?: RawUser[];
  additions?: number;
  deletions?: number;
  changed_files?: number;
}

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  additions?: number;
  deletions?: number;
  changes?: number;
  patch?: string;
}

interface RawCheckRun {
  status?: string | null;
  conclusion?: string | null;
}

interface RawStatus {
  state?: string;
}

interface RawRepo {
  default_branch?: string;
  allow_merge_commit?: boolean;
  allow_squash_merge?: boolean;
  allow_rebase_merge?: boolean;
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

function mapFile(f: RawFile): PrFile {
  return {
    filename: f.filename,
    ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
    status: f.status,
    additions: f.additions ?? 0,
    deletions: f.deletions ?? 0,
    changes: f.changes ?? 0,
    ...(typeof f.patch === "string" ? { patch: f.patch } : {}),
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
    mergedAt: p.merged_at ?? null,
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
