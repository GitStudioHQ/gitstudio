// A new pull request — its data and its rules — shared by the VS Code
// extension's New pull request form and, when it mounts the same component,
// the desktop's. Pure: the GraphQL transport is handed in, so what is asked
// and what the form proposes, allows and says are unit-tested without a
// network (test/prCreate.test.ts).
//
// ONE QUESTION for the repository it opens on: the default branch, its
// branches (the first hundred — any other can be typed), its pull request
// templates (GitHub's own reading of .github/, docs/ and the root), its
// labels and the people who can be assigned, the viewer, and what the viewer
// may set. Verified read-only against api.github.com (microsoft/vscode).
//
// WHAT IS PROPOSED is what github.com proposes: the title is the subject of
// the branch's only commit, or the branch's name in words; the description is
// the repository's template when it has one, else the only commit's body,
// else the commits as a list (GitStudio's addition: GitHub leaves it empty).

import type { PrCreateLabel, PrPermission, PrPerson } from "@gitstudio/host-bridge/prProtocol";
import { PrListError, type GraphqlFn } from "./prList";

// ── The question ─────────────────────────────────────────────────────────────

export const PR_CREATE_QUERY = `query($owner: String!, $name: String!) {
  viewer { login avatarUrl(size: 40) }
  repository(owner: $owner, name: $name) {
    nameWithOwner viewerPermission
    defaultBranchRef { name }
    pullRequestTemplates { filename body }
    refs(refPrefix: "refs/heads/", first: 100, orderBy: {field: ALPHABETICAL, direction: ASC}) { totalCount nodes { name } }
    labels(first: 100, orderBy: {field: NAME, direction: ASC}) { totalCount nodes { name color description } }
    assignableUsers(first: 100) { totalCount nodes { login avatarUrl(size: 40) } }
  }
}`;

export interface PrCreateRepoData {
  /** "owner/repo", as GitHub spells it. */
  repo: string;
  viewer?: PrPerson;
  permission: PrPermission;
  defaultBranch?: string;
  templates: { filename: string; body: string }[];
  /** The first hundred branches, by name. */
  branches: string[];
  branchesTotal: number;
  labels: PrCreateLabel[];
  people: PrPerson[];
  /** More labels or people than were read. */
  truncated: boolean;
}

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]+$/;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

function personOf(u: Json): PrPerson | null {
  return u && typeof u.login === "string" ? { login: u.login, avatarUrl: typeof u.avatarUrl === "string" ? u.avatarUrl : null } : null;
}

function permissionOf(v: unknown): PrPermission {
  return v === "ADMIN" || v === "MAINTAIN" || v === "WRITE" || v === "TRIAGE" ? v : "READ";
}

/** What the form needs of the repository it opens on, in one request. */
export async function fetchCreateData(graphql: GraphqlFn, owner: string, repo: string): Promise<PrCreateRepoData> {
  if (!OWNER_OR_REPO.test(owner) || !OWNER_OR_REPO.test(repo)) {
    throw new PrListError(`"${owner}/${repo}" isn't a GitHub repository name.`, "query");
  }
  const res = await graphql(PR_CREATE_QUERY, { owner, name: repo });
  const limited = res.errors?.find((e) => e.type === "RATE_LIMITED");
  if (limited) throw new PrListError(limited.message || "GitHub's rate limit was reached.", "rate-limit");
  const data = res.data as Json;
  const r = data?.repository;
  if (!r) throw new PrListError(res.errors?.[0]?.message || `GitHub has no repository ${owner}/${repo}.`, "not-found");
  const labels: PrCreateLabel[] = (r.labels?.nodes ?? [])
    .filter((l: Json) => l && typeof l.name === "string")
    .map((l: Json) => ({
      name: l.name,
      color: /^[0-9a-fA-F]{6}$/.test(String(l.color)) ? String(l.color) : "888888",
      ...(typeof l.description === "string" && l.description ? { description: l.description } : {}),
    }));
  const people = (r.assignableUsers?.nodes ?? []).map(personOf).filter((p: PrPerson | null): p is PrPerson => p !== null);
  const viewer = personOf(data?.viewer);
  return {
    repo: typeof r.nameWithOwner === "string" ? r.nameWithOwner : `${owner}/${repo}`,
    ...(viewer ? { viewer } : {}),
    permission: permissionOf(r.viewerPermission),
    ...(typeof r.defaultBranchRef?.name === "string" ? { defaultBranch: r.defaultBranchRef.name } : {}),
    templates: (r.pullRequestTemplates ?? [])
      .filter((t: Json) => t && typeof t.body === "string")
      .map((t: Json) => ({ filename: typeof t.filename === "string" && t.filename ? t.filename : "pull_request_template.md", body: t.body })),
    branches: (r.refs?.nodes ?? []).map((n: Json) => n?.name).filter((n: unknown): n is string => typeof n === "string"),
    branchesTotal: Number(r.refs?.totalCount ?? 0),
    labels,
    people,
    truncated: Number(r.labels?.totalCount ?? 0) > labels.length || Number(r.assignableUsers?.totalCount ?? 0) > people.length,
  };
}

// ── What is proposed ─────────────────────────────────────────────────────────

/** A commit, as proposing from it needs it. */
export interface ProposalCommit {
  subject: string;
  /** The message after the subject line. */
  body?: string;
}

/**
 * The title GitHub itself proposes: the subject of the branch's only commit,
 * or — with several — the branch name in words ("fix-login_page" → "Fix login
 * page"; a folder like "feature/" is dropped).
 */
export function proposedTitle(commits: readonly ProposalCommit[], branch: string): string {
  if (commits.length === 1 && commits[0].subject.trim()) return commits[0].subject.trim();
  const leaf = branch.includes("/") ? branch.slice(branch.lastIndexOf("/") + 1) : branch;
  const words = (leaf || branch).replace(/[-_]+/g, " ").trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : branch;
}

/**
 * The template the description starts from: the only one, or — with several
 * (a PULL_REQUEST_TEMPLATE folder) — the one named pull_request_template.md,
 * as GitHub fills that one in and asks for the others by name.
 */
export function defaultTemplate(templates: readonly { filename: string }[]): string | undefined {
  if (templates.length === 1) return templates[0].filename;
  return templates.find((t) => /(^|\/)pull_request_template\.md$/i.test(t.filename))?.filename;
}

/**
 * The description proposed: the chosen template; else the only commit's body;
 * else the commits as a list, oldest first (`commits` is newest first, as
 * `git log` gives it).
 */
export function proposedBody(
  commits: readonly ProposalCommit[],
  templates: readonly { filename: string; body: string }[],
  template: string | undefined,
): { body: string; from: "template" | "commit" | "commits" | "empty" } {
  const t = template !== undefined ? templates.find((x) => x.filename === template) : undefined;
  if (t) return { body: t.body.replace(/\r\n/g, "\n"), from: "template" };
  if (commits.length === 1) {
    const body = (commits[0].body ?? "").trim();
    return body ? { body, from: "commit" } : { body: "", from: "empty" };
  }
  if (commits.length > 1) {
    return { body: [...commits].reverse().map((c) => `- ${c.subject.trim()}`).join("\n"), from: "commits" };
  }
  return { body: "", from: "empty" };
}

/** The commits as a Markdown list, oldest first — what "Commit list" puts in the description. */
export function commitList(commits: readonly ProposalCommit[]): string {
  return [...commits].reverse().map((c) => `- ${c.subject.trim()}`).join("\n");
}

// ── What is sent, and what stops it ──────────────────────────────────────────

/**
 * The head as GitHub reads it: a bare branch name is a branch of the TARGET
 * repository, so one that lives in a fork is `owner:branch`.
 */
export function headForGitHub(branch: string, headOwner: string | undefined, targetOwner: string): string {
  return headOwner && headOwner.toLowerCase() !== targetOwner.toLowerCase() ? `${headOwner}:${branch}` : branch;
}

/** Reviewers, labels and assignees take triage access (or more) to the repository. */
export function canSetMetadata(permission: PrPermission): boolean {
  return permission !== "READ";
}

export function metadataNote(repo: string): string {
  return `Reviewers, labels and assignees take triage access to ${repo}. Its maintainers can add them.`;
}

/** Why the pull request can't be created as things are — or undefined when it can. */
export function createProblem(p: {
  branch?: string;
  base?: string;
  sameRepository: boolean;
  compareReady: boolean;
  commits: number;
  existing?: { number: number };
  push?: "new" | "ahead" | "pushed" | "diverged" | "unknown";
  remote?: string;
}): string | undefined {
  if (!p.branch) return "Pick the branch to open it from.";
  if (!p.base) return "Pick the branch it goes into.";
  if (p.sameRepository && p.branch === p.base) return `${p.branch} can't go into itself: pick another base.`;
  if (p.existing) return `${p.branch} already has an open pull request, #${p.existing.number}.`;
  if (p.push === "diverged") {
    return `${p.branch} and ${p.remote ?? "its remote"}/${p.branch} have both moved on: pull, then create it.`;
  }
  if (p.push === "unknown") return `${p.branch} has no GitHub remote to be pushed to.`;
  if (p.compareReady && p.commits === 0) return `Nothing to compare: ${p.branch} has no commits that ${p.base} doesn't.`;
  return undefined;
}

/** Where the branch stands on its remote, in words — said above Create. */
export function pushWords(h: { branch: string; remote?: string; push: string; ahead: number }): string | undefined {
  if (!h.remote) return undefined;
  if (h.push === "new") return `${h.branch} isn't on ${h.remote} yet: it is pushed there first.`;
  if (h.push === "ahead") {
    return `${h.ahead === 1 ? "1 commit isn't" : `${h.ahead} commits aren't`} on ${h.remote}/${h.branch} yet: ${h.ahead === 1 ? "it is" : "they are"} pushed first.`;
  }
  return undefined;
}

/** A `git diff --name-status` letter → the Files tab's status word. */
export function statusOfLetter(letter: string): "added" | "removed" | "modified" | "renamed" | "copied" | "changed" {
  switch (letter.charAt(0)) {
    case "A":
      return "added";
    case "D":
      return "removed";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    default:
      return "changed";
  }
}
