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
import type { OrgInfo, OrgMember, OrgRepo, OrgTeam } from "../../shared/ipc";

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
  const raw = await client.request<RawOrg[]>("GET", `/user/orgs?per_page=100`);
  return raw.map(mapOrg);
}

/** An org's repositories, most-recently-pushed first. Private repos appear when
 *  the OAuth token also carries `repo`; needs no extra scope of its own. */
export async function listOrgRepos(client: GitHubClient, org: string): Promise<OrgRepo[]> {
  const raw = await client.request<RawRepo[]>(
    "GET",
    `/orgs/${enc(org)}/repos?sort=pushed&direction=desc&per_page=100`,
  );
  return raw.map(mapRepo);
}

/** An org's teams. Requires `read:org` + org membership; non-members get a 403
 *  that surfaces as the renderer's errorState + Retry. */
export async function listOrgTeams(client: GitHubClient, org: string): Promise<OrgTeam[]> {
  const raw = await client.request<RawTeam[]>("GET", `/orgs/${enc(org)}/teams?per_page=100`);
  return raw.map(mapTeam);
}

/** An org's members, per the org's visibility. A non-owner may only see public
 *  members → can be empty even for large orgs; a restricted list yields a 403. */
export async function listOrgMembers(client: GitHubClient, org: string): Promise<OrgMember[]> {
  const raw = await client.request<RawMember[]>("GET", `/orgs/${enc(org)}/members?per_page=100`);
  return raw.map(mapMember);
}
