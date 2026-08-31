// A thin GitHub REST + GraphQL client for the desktop app's PRs / Issues /
// Projects views. It runs in the Electron MAIN process over Node's global
// `fetch`, talks only to api.github.com, and returns typed results. Mirrors the
// extension's githubApi.ts (the proven PR client) and adds Issues + Projects.
// The token is supplied by the caller (GitHubBridge reads it from safeStorage).

import { ExpectedError } from "./expectedError";
import { githubHttpError, graphqlError, networkError } from "./githubErrors";
import { nextPagePath, PAGE_CAPS } from "./githubPaging";
import { mapIssue, mapPull, mapUser, type RawIssue, type RawPull, type RawUser } from "./github/maps";
import type {
  CheckRun,
  GitHubUser,
  IssueInfo,
  ProjectInfo,
  PrComment,
  PrCommitInfo,
  PrFile,
  PullRequest,
  WorkflowRun,
} from "../shared/ipc";

const API_BASE = "https://api.github.com";
const GRAPHQL = "https://api.github.com/graphql";

interface CombinedStatus {
  state: string;
  totalCount: number;
}

export type TokenGetter = () => string | undefined;

export class GitHubClient {
  constructor(private readonly getToken: TokenGetter) {}

  /** The shared fetch under `request`/`requestPaged`: auth headers, timeout,
   *  network-error wrapping, non-2xx → githubHttpError. Returns the RESPONSE so
   *  paged callers can read the `Link` header. */
  private async fetchRes(
    method: string,
    path: string,
    body?: unknown,
    opts?: { accept?: string },
  ): Promise<Response> {
    const token = this.getToken();
    if (!token) {
      throw new ExpectedError("Not connected to GitHub.");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      // Some endpoints need a different media type to return the good stuff —
      // code search only includes match fragments under text-match+json.
      Accept: opts?.accept ?? "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "GitStudio",
    };
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
    }
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        // A hung request used to hang every gated section on its skeleton
        // forever — the API must fail fast enough for the UI to say so.
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw networkError();
    }
    if (!res.ok) {
      throw await githubHttpError(res);
    }
    return res;
  }

  /** REST call returning the parsed JSON body. `body` (POST/PATCH/PUT) is sent as
   *  JSON. Throws a clean Error on non-2xx or network failure. Public so the
   *  per-section modules under ./github can call it. */
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    opts?: { accept?: string },
  ): Promise<T> {
    const res = await this.fetchRes(method, path, body, opts);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text.length > 0 ? JSON.parse(text) : undefined) as T;
  }

  /**
   * GET an ARRAY-bodied list endpoint, following the `Link: rel="next"` chain
   * up to `maxPages` pages and concatenating the results. The first page's
   * failure throws; a FOLLOW-UP page's failure returns what was gathered so far
   * (a partial long list beats an error state the user already had data for).
   */
  async requestPaged<T>(path: string, maxPages: number): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      let res: Response;
      try {
        res = await this.fetchRes("GET", next);
      } catch (e) {
        if (page === 0) throw e;
        break;
      }
      const text = await res.text();
      const chunk = (text.length > 0 ? JSON.parse(text) : []) as T[];
      out.push(...chunk);
      next = nextPagePath(res.headers.get("link"), API_BASE);
    }
    return out;
  }

  /**
   * As {@link requestPaged}, for OBJECT-bodied list endpoints (`{ total_count,
   * workflow_runs: [...] }` and friends) — `key` names the array to gather.
   */
  async requestPagedKey<T>(path: string, key: string, maxPages: number): Promise<T[]> {
    const out: T[] = [];
    let next: string | undefined = path;
    for (let page = 0; next && page < maxPages; page++) {
      let res: Response;
      try {
        res = await this.fetchRes("GET", next);
      } catch (e) {
        if (page === 0) throw e;
        break;
      }
      const text = await res.text();
      const body = (text.length > 0 ? JSON.parse(text) : {}) as Record<string, unknown>;
      const chunk = body[key];
      if (Array.isArray(chunk)) out.push(...(chunk as T[]));
      next = nextPagePath(res.headers.get("link"), API_BASE);
    }
    return out;
  }

  /**
   * Upload one release asset (binary) to uploads.github.com — a different host
   * than the API base, hence its own fetch. Generous timeout: installers are
   * hundreds of megabytes.
   */
  async uploadReleaseAsset(
    owner: string,
    repo: string,
    releaseId: number,
    name: string,
    data: Uint8Array,
    contentType: string,
  ): Promise<void> {
    const token = this.getToken();
    if (!token) {
      throw new ExpectedError("Not connected to GitHub.");
    }
    let res: Response;
    try {
      res = await fetch(
        `https://uploads.github.com/repos/${enc(owner)}/${enc(repo)}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            "User-Agent": "GitStudio",
            "Content-Type": contentType,
          },
          body: data as unknown as RequestInit["body"],
          signal: AbortSignal.timeout(300_000),
        },
      );
    } catch {
      throw networkError();
    }
    if (!res.ok) {
      throw await githubHttpError(res);
    }
  }

  /** REST call that ignores the response body (fire-and-forget mutations). */
  async requestBody(method: string, path: string, body: unknown): Promise<void> {
    const token = this.getToken();
    if (!token) {
      throw new ExpectedError("Not connected to GitHub.");
    }
    // Wrapped for the same reason `request` is: an unwrapped fetch lets a bare
    // `TypeError: fetch failed` escape to the crash reporter, so going offline
    // filed a report instead of telling the user to check their connection.
    let res: Response;
    try {
      res = await fetch(`${API_BASE}${path}`, {
        method,
        signal: AbortSignal.timeout(30_000),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "GitStudio",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw networkError();
    }
    if (!res.ok) {
      throw await githubHttpError(res);
    }
  }

  /** GraphQL call (Projects v2 etc.). Public for the per-section modules. */
  async graphql<T>(query: string, variables: unknown): Promise<T> {
    const token = this.getToken();
    if (!token) {
      throw new ExpectedError("Not connected to GitHub.");
    }
    let res: Response;
    try {
      res = await fetch(GRAPHQL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "User-Agent": "GitStudio",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ query, variables }),
      });
    } catch {
      throw networkError();
    }
    if (!res.ok) {
      throw await githubHttpError(res);
    }
    const json = (await res.json()) as {
      data?: T;
      errors?: { message: string; type?: string }[];
    };
    if (json.errors && json.errors.length) {
      // GraphQL reports failure in a 200 body, so the status-code policy never
      // sees it — a rate limit or a missing scope arrives here instead.
      throw graphqlError(json.errors[0]);
    }
    return json.data as T;
  }

  // ── User ──
  async currentLogin(): Promise<string | undefined> {
    try {
      const u = await this.request<{ login: string }>("GET", "/user");
      return u.login;
    } catch {
      return undefined;
    }
  }

  // ── Pull requests ──
  /** `state` is GitHub's: open | closed | all. "merged" is not a state upstream
   *  — a merged PR is closed with `merged_at` set — so the renderer asks for
   *  `closed` and narrows locally. */
  async listPulls(owner: string, repo: string, state: "open" | "closed" | "all" = "open"): Promise<PullRequest[]> {
    const raw = await this.requestPaged<RawPull>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls?state=${state}&sort=updated&direction=desc&per_page=100`,
      PAGE_CAPS.list,
    );
    return raw.map(mapPull);
  }
  async getPull(owner: string, repo: string, n: number): Promise<PullRequest> {
    return mapPull(await this.request<RawPull>("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`));
  }
  async getPullFiles(owner: string, repo: string, n: number): Promise<PrFile[]> {
    const raw = await this.requestPaged<RawFile>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/files?per_page=100`,
      PAGE_CAPS.detail,
    );
    return raw.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      // In the response already — dropping it left every rename unable to say
      // what it was renamed from.
      ...(f.previous_filename ? { previousFilename: f.previous_filename } : {}),
    }));
  }
  async mergePull(owner: string, repo: string, n: number, method: "merge" | "squash" | "rebase"): Promise<void> {
    await this.requestBody("PUT", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/merge`, { merge_method: method });
  }
  async approvePull(owner: string, repo: string, n: number): Promise<void> {
    await this.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/reviews`, { event: "APPROVE" });
  }
  async listPrCommits(owner: string, repo: string, n: number): Promise<PrCommitInfo[]> {
    const raw = await this.requestPaged<RawPrCommit>(
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/commits?per_page=100`,
      PAGE_CAPS.detail,
    );
    return raw.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      message: (c.commit?.message ?? "").split("\n", 1)[0],
      author: c.commit?.author?.name ?? c.author?.login ?? "unknown",
      date: c.commit?.author?.date ?? "",
    }));
  }
  /** The conversation = issue comments + reviews, merged chronologically. */
  async listConversation(owner: string, repo: string, n: number): Promise<PrComment[]> {
    const [comments, reviews] = await Promise.all([
      this.requestPaged<RawComment>(`/repos/${enc(owner)}/${enc(repo)}/issues/${n}/comments?per_page=100`, PAGE_CAPS.detail).catch(() => []),
      this.requestPaged<RawReview>(`/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/reviews?per_page=100`, PAGE_CAPS.detail).catch(() => []),
    ]);
    const out: PrComment[] = [];
    for (const c of comments) {
      out.push({ author: c.user?.login ?? "unknown", body: c.body ?? "", createdAt: c.created_at, kind: "comment" });
    }
    for (const r of reviews) {
      if (r.state === "PENDING") continue;
      out.push({ author: r.user?.login ?? "unknown", body: r.body ?? "", createdAt: r.submitted_at ?? "", kind: "review", state: r.state });
    }
    out.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    return out;
  }
  async listCheckRuns(owner: string, repo: string, ref: string): Promise<CheckRun[]> {
    try {
      const raw = await this.request<{ check_runs?: RawCheck[] }>(
        "GET",
        `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/check-runs?per_page=100`,
      );
      return (raw.check_runs ?? []).map((c) => ({
        name: c.name,
        status: c.status ?? "",
        conclusion: c.conclusion ?? "",
        detailsUrl: c.details_url ?? undefined,
      }));
    } catch {
      return [];
    }
  }
  async getCombinedStatus(owner: string, repo: string, ref: string): Promise<CombinedStatus> {
    try {
      const raw = await this.request<{ state?: string; total_count?: number }>(
        "GET",
        `/repos/${enc(owner)}/${enc(repo)}/commits/${enc(ref)}/status`,
      );
      return { state: raw.state ?? "", totalCount: raw.total_count ?? 0 };
    } catch {
      return { state: "", totalCount: 0 };
    }
  }

  // ── Issues (the issues endpoint also returns PRs — filter them out) ──
  async listOpenIssues(owner: string, repo: string): Promise<IssueInfo[]> {
    const raw = await this.requestPaged<RawIssue>(
      `/repos/${enc(owner)}/${enc(repo)}/issues?state=open&sort=updated&direction=desc&per_page=100`,
      PAGE_CAPS.list,
    );
    return raw.filter((i) => !i.pull_request).map(mapIssue);
  }
  async getIssue(owner: string, repo: string, n: number): Promise<IssueInfo> {
    return mapIssue(await this.request<RawIssue>("GET", `/repos/${enc(owner)}/${enc(repo)}/issues/${n}`));
  }

  // ── Projects (v2, via GraphQL) ──
  async listProjects(owner: string, repo: string): Promise<ProjectInfo[]> {
    try {
      const data = await this.graphql<RawProjectsData>(
        `query($owner:String!,$repo:String!){repository(owner:$owner,name:$repo){projectsV2(first:20,orderBy:{field:UPDATED_AT,direction:DESC}){nodes{id number title shortDescription url closed updatedAt items{totalCount}}}}}`,
        { owner, repo },
      );
      const nodes = data?.repository?.projectsV2?.nodes ?? [];
      return nodes.map((p) => ({
        id: p.id ?? "",
        number: p.number,
        title: p.title,
        shortDescription: p.shortDescription ?? "",
        url: p.url,
        itemCount: p.items?.totalCount ?? 0,
        closed: p.closed,
        updatedAt: p.updatedAt ?? "",
      }));
    } catch {
      return [];
    }
  }
}

export function enc(part: string): string {
  return encodeURIComponent(part);
}

// RawUser + mapUser live in github/maps.ts now (imported above) — re-exported
// here so the per-section modules' existing `import { mapUser } from
// "../githubClient"` keeps working.
export { mapUser, type RawUser };
interface RawRef {
  ref: string;
  sha: string;
}
interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  /** GitHub's own field name, present on renames and copies. */
  previous_filename?: string;
}
interface RawPrCommit {
  sha: string;
  commit?: { message?: string; author?: { name?: string; date?: string } };
  author?: { login?: string } | null;
}
interface RawComment {
  user?: RawUser | null;
  body?: string;
  created_at: string;
}
interface RawReview {
  user?: RawUser | null;
  body?: string;
  state?: string;
  submitted_at?: string;
}
interface RawCheck {
  name: string;
  status?: string;
  conclusion?: string;
  details_url?: string;
}
interface RawProjectsData {
  repository?: {
    projectsV2?: {
      nodes?: {
        id?: string;
        number: number;
        title: string;
        shortDescription?: string;
        url: string;
        closed: boolean;
        updatedAt?: string;
        items?: { totalCount: number };
      }[];
    };
  };
}

