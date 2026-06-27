// A thin GitHub REST + GraphQL client for the desktop app's PRs / Issues /
// Projects views. It runs in the Electron MAIN process over Node's global
// `fetch`, talks only to api.github.com, and returns typed results. Mirrors the
// extension's githubApi.ts (the proven PR client) and adds Issues + Projects.
// The token is supplied by the caller (GitHubBridge reads it from safeStorage).

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

  /** REST call returning the parsed JSON body. `body` (POST/PATCH/PUT) is sent as
   *  JSON. Throws a clean Error on non-2xx or network failure. Public so the
   *  per-section modules under ./github can call it. */
  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = this.getToken();
    if (!token) {
      throw new Error("Not connected to GitHub.");
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
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
      });
    } catch {
      throw new Error("Couldn't reach GitHub. Check your network connection.");
    }
    if (res.ok) {
      if (res.status === 204) return undefined as T;
      const text = await res.text();
      return (text.length > 0 ? JSON.parse(text) : undefined) as T;
    }
    throw await this.toError(res);
  }

  /** REST call that ignores the response body (fire-and-forget mutations). */
  async requestBody(method: string, path: string, body: unknown): Promise<void> {
    const token = this.getToken();
    if (!token) {
      throw new Error("Not connected to GitHub.");
    }
    const res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "GitStudio",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw await this.toError(res);
    }
  }

  /** GraphQL call (Projects v2 etc.). Public for the per-section modules. */
  async graphql<T>(query: string, variables: unknown): Promise<T> {
    const token = this.getToken();
    if (!token) {
      throw new Error("Not connected to GitHub.");
    }
    const res = await fetch(GRAPHQL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "GitStudio",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok) {
      throw await this.toError(res);
    }
    const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
    if (json.errors && json.errors.length) {
      throw new Error(json.errors[0].message);
    }
    return json.data as T;
  }

  private async toError(res: Response): Promise<Error> {
    let detail = "";
    try {
      const data = (await res.json()) as { message?: string };
      detail = data?.message ?? "";
    } catch {
      /* non-JSON body */
    }
    if (res.status === 401) return new Error("Your GitHub token is invalid or expired.");
    if (res.status === 403) return new Error(detail || "GitHub denied the request (permissions or rate limit).");
    if (res.status === 404) return new Error(detail || "Not found on GitHub.");
    return new Error(detail || `GitHub request failed (HTTP ${res.status}).`);
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
  async listOpenPulls(owner: string, repo: string): Promise<PullRequest[]> {
    const raw = await this.request<RawPull[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&sort=updated&direction=desc&per_page=50`,
    );
    return raw.map(mapPull);
  }
  async getPull(owner: string, repo: string, n: number): Promise<PullRequest> {
    return mapPull(await this.request<RawPull>("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}`));
  }
  async getPullFiles(owner: string, repo: string, n: number): Promise<PrFile[]> {
    const raw = await this.request<RawFile[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/files?per_page=100`,
    );
    return raw.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));
  }
  async mergePull(owner: string, repo: string, n: number, method: "merge" | "squash" | "rebase"): Promise<void> {
    await this.requestBody("PUT", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/merge`, { merge_method: method });
  }
  async approvePull(owner: string, repo: string, n: number): Promise<void> {
    await this.requestBody("POST", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/reviews`, { event: "APPROVE" });
  }
  async listPrCommits(owner: string, repo: string, n: number): Promise<PrCommitInfo[]> {
    const raw = await this.request<RawPrCommit[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/commits?per_page=100`,
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
      this.request<RawComment[]>("GET", `/repos/${enc(owner)}/${enc(repo)}/issues/${n}/comments?per_page=100`).catch(() => []),
      this.request<RawReview[]>("GET", `/repos/${enc(owner)}/${enc(repo)}/pulls/${n}/reviews?per_page=100`).catch(() => []),
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
  async listWorkflowRuns(owner: string, repo: string): Promise<WorkflowRun[]> {
    try {
      const raw = await this.request<{ workflow_runs?: RawRun[] }>(
        "GET",
        `/repos/${enc(owner)}/${enc(repo)}/actions/runs?per_page=30`,
      );
      return (raw.workflow_runs ?? []).map((r) => ({
        id: r.id,
        name: r.name ?? r.display_title ?? "(run)",
        status: r.status ?? "",
        conclusion: r.conclusion ?? "",
        branch: r.head_branch ?? "",
        event: r.event ?? "",
        createdAt: r.created_at ?? "",
        htmlUrl: r.html_url ?? "",
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
    const raw = await this.request<RawIssue[]>(
      "GET",
      `/repos/${enc(owner)}/${enc(repo)}/issues?state=open&sort=updated&direction=desc&per_page=50`,
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

export interface RawUser {
  login: string;
  avatar_url?: string;
}
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
interface RawFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
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
  labels?: ({ name: string; color: string } | string)[];
  assignees?: RawUser[];
  pull_request?: unknown;
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
interface RawRun {
  id: number;
  name?: string;
  display_title?: string;
  status?: string;
  conclusion?: string;
  head_branch?: string;
  event?: string;
  created_at?: string;
  html_url?: string;
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

export function mapUser(u: RawUser | null | undefined): GitHubUser | null {
  return u ? { login: u.login, avatarUrl: u.avatar_url ?? null } : null;
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
