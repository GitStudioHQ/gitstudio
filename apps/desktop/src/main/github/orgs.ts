// The Organizations section's GitHub logic (main process). Four pure, read-only
// REST list calls — orgs the signed-in user belongs to, plus each org's repos,
// teams, and members. These are USER-scoped (not repo-scoped), so the functions
// take only the client; main.ts invokes them via `github.withClient((c) => …)`.
//
// All four THROW on API error (the client's request<T>() throws a clean Error via
// toError(): 401 → token invalid, 403 → permissions/rate-limit, 404 → not found),
// so the renderer paints an errorState + Retry rather than a misleading empty
// list. There are no mutations here, so the {ok,changed,message} result shape is
// not used anywhere in this module.

import { GitHubClient, enc } from "../githubClient";
import { PAGE_CAPS } from "../githubPaging";
import type {
  GhUserInfo,
  OrgInfo,
  OrgMember,
  OrgRepo,
  OrgRepoDetail,
  OrgTeam,
} from "../../shared/ipc";

// ── Raw GitHub shapes (only the fields we map) ────────────────────────────────

/** `/user/orgs` returns the SHORT org object: no `html_url`/`name`, so we
 *  synthesize the profile URL from the login in the mapper. */
interface RawOrg {
  login: string;
  name?: string | null;
  avatar_url?: string;
  description?: string | null;
}
interface RawRepo {
  name: string;
  full_name: string;
  html_url: string;
  description?: string | null;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  language?: string | null;
  stargazers_count?: number;
  pushed_at?: string;
}
interface RawTeam {
  name: string;
  slug: string;
  description?: string | null;
  privacy?: string;
  html_url?: string;
}
interface RawMember {
  login: string;
  avatar_url?: string;
  html_url?: string;
}

// ── Raw → public mappers ──────────────────────────────────────────────────────

function mapOrg(o: RawOrg): OrgInfo {
  return {
    login: o.login,
    name: o.name ?? null,
    avatarUrl: o.avatar_url ?? null,
    description: o.description ?? null,
    htmlUrl: `https://github.com/${o.login}`,
  };
}
function mapRepo(r: RawRepo): OrgRepo {
  return {
    name: r.name,
    fullName: r.full_name,
    htmlUrl: r.html_url,
    description: r.description ?? null,
    private: r.private ?? false,
    fork: r.fork ?? false,
    archived: r.archived ?? false,
    language: r.language ?? null,
    stargazersCount: r.stargazers_count ?? 0,
    pushedAt: r.pushed_at ?? "",
  };
}
function mapTeam(t: RawTeam): OrgTeam {
  return {
    name: t.name,
    slug: t.slug,
    description: t.description ?? null,
    privacy: t.privacy ?? "",
    htmlUrl: t.html_url ?? "",
  };
}
function mapMember(m: RawMember): OrgMember {
  return {
    login: m.login,
    avatarUrl: m.avatar_url ?? null,
    htmlUrl: m.html_url ?? `https://github.com/${m.login}`,
  };
}

// ── Read functions (user-scoped; throw on error) ─────────────────────────────

/** Orgs the signed-in user has visible membership in. Orgs that hide the user's
 *  membership won't appear — expected GitHub behavior. */
export async function listOrgs(client: GitHubClient): Promise<OrgInfo[]> {
  const raw = await client.requestPaged<RawOrg>(`/user/orgs?per_page=100`, PAGE_CAPS.account);
  return raw.map(mapOrg);
}

/** An org's repositories, most-recently-pushed first. Private repos appear when
 *  the OAuth token also carries `repo`; needs no extra scope of its own. */
export async function listOrgRepos(client: GitHubClient, org: string): Promise<OrgRepo[]> {
  const raw = await client.requestPaged<RawRepo>(
    `/orgs/${enc(org)}/repos?sort=pushed&direction=desc&per_page=100`,
    PAGE_CAPS.account,
  );
  return raw.map(mapRepo);
}

/** An org's teams. Requires `read:org` + org membership; non-members get a 403
 *  that surfaces as the renderer's errorState + Retry. */
export async function listOrgTeams(client: GitHubClient, org: string): Promise<OrgTeam[]> {
  const raw = await client.requestPaged<RawTeam>(`/orgs/${enc(org)}/teams?per_page=100`, PAGE_CAPS.account);
  return raw.map(mapTeam);
}

/** An org's members, per the org's visibility. A non-owner may only see public
 *  members → can be empty even for large orgs; a restricted list yields a 403. */
export async function listOrgMembers(client: GitHubClient, org: string): Promise<OrgMember[]> {
  const raw = await client.requestPaged<RawMember>(`/orgs/${enc(org)}/members?per_page=100`, PAGE_CAPS.account);
  return raw.map(mapMember);
}

/** The full-repo raw shape (only the extra fields the repo peek renders). */
interface RawRepoDetail extends RawRepo {
  clone_url?: string;
  ssh_url?: string;
  default_branch?: string;
  open_issues_count?: number;
  forks_count?: number;
  topics?: string[];
  license?: { name?: string } | null;
  created_at?: string;
  homepage?: string | null;
}

/** One repository's full record ("owner/repo") — the org-repo peek's body. */
export async function getOrgRepoDetail(
  client: GitHubClient,
  fullName: string,
): Promise<OrgRepoDetail> {
  const [owner, repo] = fullName.split("/", 2);
  const r = await client.request<RawRepoDetail>("GET", `/repos/${enc(owner)}/${enc(repo)}`);
  return {
    fullName: r.full_name,
    description: r.description ?? null,
    htmlUrl: r.html_url,
    cloneUrl: r.clone_url ?? `${r.html_url}.git`,
    sshUrl: r.ssh_url ?? "",
    defaultBranch: r.default_branch ?? "main",
    openIssuesCount: r.open_issues_count ?? 0,
    forksCount: r.forks_count ?? 0,
    stargazersCount: r.stargazers_count ?? 0,
    topics: r.topics ?? [],
    license: r.license?.name ?? null,
    language: r.language ?? null,
    private: r.private ?? false,
    archived: r.archived ?? false,
    fork: r.fork ?? false,
    pushedAt: r.pushed_at ?? "",
    createdAt: r.created_at ?? "",
    homepage: r.homepage ?? null,
  };
}

/** A team's members — the team peek's drill-in list. Same visibility rules as
 *  listOrgTeams (needs read:org; non-members 403 → errorState in the peek). */
export async function listTeamMembers(
  client: GitHubClient,
  org: string,
  slug: string,
): Promise<OrgMember[]> {
  const raw = await client.requestPaged<RawMember>(
    `/orgs/${enc(org)}/teams/${enc(slug)}/members?per_page=100`,
    PAGE_CAPS.account,
  );
  return raw.map(mapMember);
}

interface RawUser extends RawMember {
  name?: string | null;
  bio?: string | null;
  company?: string | null;
  location?: string | null;
  blog?: string | null;
  followers?: number;
  following?: number;
  public_repos?: number;
  created_at?: string;
  /** "User" or "Organization" — an Explore profile page must know which. */
  type?: string;
  twitter_username?: string | null;
  email?: string | null;
}

/** A user's public profile — the member peek's body. */
export async function getUserInfo(client: GitHubClient, login: string): Promise<GhUserInfo> {
  const u = await client.request<RawUser>("GET", `/users/${enc(login)}`);
  return {
    login: u.login,
    name: u.name ?? null,
    avatarUrl: u.avatar_url ?? null,
    bio: u.bio ?? null,
    company: u.company ?? null,
    location: u.location ?? null,
    blog: u.blog ?? null,
    htmlUrl: u.html_url ?? `https://github.com/${u.login}`,
    followers: u.followers ?? 0,
    following: u.following ?? 0,
    publicRepos: u.public_repos ?? 0,
    createdAt: u.created_at ?? "",
    type: u.type ?? "User",
    twitter: u.twitter_username ?? null,
    email: u.email ?? null,
  };
}

/** A user's public repositories — the profile page's list. Sorted by GitHub's
 *  "updated" so the page opens on what they're actually working on. */
export async function listUserRepos(client: GitHubClient, login: string): Promise<OrgRepo[]> {
  const raw = await client.requestPaged<RawRepo>(
    `/users/${enc(login)}/repos?per_page=100&sort=updated&direction=desc`,
    PAGE_CAPS.account,
  );
  return raw.map(mapRepo);
}

/** The organizations a user belongs to (public membership only). */
export async function listUserOrgs(client: GitHubClient, login: string): Promise<OrgInfo[]> {
  const raw = await client.requestPaged<RawOrg>(
    `/users/${enc(login)}/orgs?per_page=100`,
    PAGE_CAPS.account,
  );
  return raw.map(mapOrg);
}
