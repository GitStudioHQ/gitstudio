// A fake api.github.com for the pull request tests: `globalThis.fetch` is
// replaced by a router over (method, path) that answers what GitHub answers —
// status, JSON body and headers (a `Link` for paging, rate-limit headers) —
// and records every request, so a test can count what one event cost.

export interface FakeRequest {
  method: string;
  /** Path + query, e.g. "/repos/acme/app/pulls?state=open&…". */
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface FakeReply {
  status?: number;
  body?: unknown;
  /** Raw bytes instead of JSON (the Contents API's raw media type). */
  bytes?: Uint8Array;
  headers?: Record<string, string>;
}

export type Route = [method: string, path: RegExp, reply: (req: FakeRequest, m: RegExpExecArray) => FakeReply];

/** Requests held in flight until released — a slow GitHub, on cue. */
export interface Hold {
  /** How many requests are waiting. */
  held(): number;
  /** Let every waiting request through, and stop holding. */
  release(): void;
}

export interface FakeGitHub {
  requests: FakeRequest[];
  /** Requests whose path matches, e.g. count(/\/pulls\?/). */
  count(re: RegExp): number;
  routes: Route[];
  /** Hold every request whose path matches `re` (or that `re` accepts) until released. */
  hold(re: RegExp | ((req: FakeRequest) => boolean)): Hold;
  restore(): void;
}

export function installFakeGitHub(routes: Route[]): FakeGitHub {
  const original = globalThis.fetch;
  const holds: { re: RegExp | ((req: FakeRequest) => boolean); waiting: (() => void)[]; on: boolean }[] = [];
  const fake: FakeGitHub = {
    requests: [],
    routes,
    count: (re) => fake.requests.filter((r) => re.test(`${r.method} ${r.path}`)).length,
    hold: (re) => {
      const h = { re, waiting: [] as (() => void)[], on: true };
      holds.push(h);
      return {
        held: () => h.waiting.length,
        release: () => {
          h.on = false;
          for (const go of h.waiting.splice(0)) go();
        },
      };
    },
    restore: () => {
      globalThis.fetch = original;
    },
  };
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.host !== "api.github.com") throw new Error(`the fake GitHub was asked for ${url.href}`);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = url.pathname + url.search;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: FakeRequest = {
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers,
    };
    for (const h of holds) {
      if (h.on && (typeof h.re === "function" ? h.re(req) : h.re.test(path))) {
        await new Promise<void>((go) => h.waiting.push(go));
      }
    }
    fake.requests.push(req);
    for (const [m, re, reply] of fake.routes) {
      if (m !== method) continue;
      const hit = re.exec(path);
      if (!hit) continue;
      const r = reply(req, hit);
      const status = r.status ?? 200;
      if (r.bytes) {
        return new Response(r.bytes, { status, headers: r.headers });
      }
      return new Response(status === 204 ? null : JSON.stringify(r.body ?? null), {
        status,
        headers: { "content-type": "application/json", ...(r.headers ?? {}) },
      });
    }
    return new Response(JSON.stringify({ message: "Not Found" }), { status: 404 });
  }) as typeof fetch;
  return fake;
}

// ── Fixtures in GitHub's own (snake_case) shapes ────────────────────────────────

/**
 * Every fixture's "three hours ago", read once: a clock read per pull ticks
 * over mid-list now and then, and the list sorted by last update comes back in
 * a different order from one page to the next.
 */
const THREE_HOURS_AGO = new Date(Date.now() - 3 * 3600e3).toISOString();

export function rawPull(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number: n,
    title: `PR ${n}`,
    body: "",
    state: "open",
    draft: false,
    html_url: `https://github.com/acme/app/pull/${n}`,
    user: { login: "alice", avatar_url: null, html_url: null },
    created_at: "2026-01-01T00:00:00Z",
    updated_at: THREE_HOURS_AGO,
    merged_at: null,
    head: { ref: `feature-${n}`, sha: `${String(n).padStart(3, "0")}head`, label: `acme:feature-${n}`, repo: { full_name: "acme/app", clone_url: "https://github.com/acme/app.git" } },
    base: { ref: "main", sha: "basesha", label: "acme:main", repo: { full_name: "acme/app", clone_url: "https://github.com/acme/app.git" } },
    labels: [],
    requested_reviewers: [],
    ...over,
  };
}

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub JSON, built field by field */
// ── GraphQL: the Pull Requests list's questions, answered from REST fixtures ──

/** One repository, as the fake GraphQL endpoint knows it. */
export interface FakeRepo {
  /** Its pull requests, in the REST shape (rawPull). */
  pulls: () => Record<string, unknown>[];
  /** statusCheckRollup.state per PR number (absent: no checks). */
  ci?: Record<number, string>;
  /** reviewDecision per PR number. */
  review?: Record<number, string>;
  isFork?: boolean;
  parent?: string;
  labels?: { name: string; color: string }[];
  people?: string[];
  /** The signed-in account's role in it (GraphQL viewerPermission); WRITE when absent. */
  permission?: string;
  /** The merge methods it allows; all three when absent. */
  methods?: ("merge" | "squash" | "rebase")[];
  /** What a pull request's page reads beyond its REST fixture, per number. */
  page?: Record<number, FakePage>;
  /** The New pull request form's reading: templates, branches, default branch. */
  templates?: { filename: string; body: string }[];
  branches?: string[];
  defaultBranch?: string;
}

/** A pull request's page, beyond what its REST fixture says. */
export interface FakePage {
  mergeState?: string;
  /** GraphQL reviewThreads nodes. */
  threads?: Record<string, unknown>[];
  /** GraphQL timelineItems nodes. */
  timeline?: Record<string, unknown>[];
  /** GraphQL latestReviews nodes. */
  reviews?: Record<string, unknown>[];
  viewerIsAuthor?: boolean;
  canUpdate?: boolean;
  canDeleteBranch?: boolean;
  /** GraphQL statusCheckRollup.contexts nodes of the head. */
  checks?: Record<string, unknown>[];
}

/** A REST pull request as the page's GraphQL answer (engine/forge/prPage's PR_PAGE_QUERY). */
export function gqlPage(p: Record<string, any>, repo: string, world: FakeRepo, viewer: string): Record<string, unknown> {
  const node = gqlNode(p, repo, world);
  const page = world.page?.[p.number] ?? {};
  const methods = world.methods ?? ["merge", "squash", "rebase"];
  const ci = world.ci?.[p.number];
  const checks =
    page.checks ??
    (ci
      ? [
          {
            __typename: "CheckRun",
            name: "test",
            status: ci === "PENDING" ? "IN_PROGRESS" : "COMPLETED",
            conclusion: ci === "PENDING" ? null : ci,
            startedAt: "2026-09-26T10:00:00Z",
            completedAt: ci === "PENDING" ? null : "2026-09-26T10:05:00Z",
            detailsUrl: "https://github.com/acme/app/actions/runs/1/job/1",
            isRequired: true,
            checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } },
          },
        ]
      : []);
  return {
    viewer: { login: viewer, avatarUrl: null },
    repository: {
      nameWithOwner: repo,
      viewerPermission: world.permission ?? "WRITE",
      mergeCommitAllowed: methods.includes("merge"),
      squashMergeAllowed: methods.includes("squash"),
      rebaseMergeAllowed: methods.includes("rebase"),
      deleteBranchOnMerge: false,
      viewerDefaultMergeMethod: "SQUASH",
      pullRequest: {
        ...node,
        id: `PR_node_${p.number}`,
        body: p.body ?? "",
        mergedBy: p.merged_at ? { login: viewer, avatarUrl: null } : null,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        changedFiles: p.changed_files ?? 0,
        mergeStateStatus: page.mergeState ?? (p.draft ? "DRAFT" : "CLEAN"),
        viewerDidAuthor: page.viewerIsAuthor ?? (p.user?.login === viewer),
        viewerCanUpdate: page.canUpdate ?? true,
        viewerCanUpdateBranch: true,
        viewerCanDeleteHeadRef: page.canDeleteBranch ?? true,
        latestReviews: { nodes: page.reviews ?? [] },
        commits: {
          totalCount: 1,
          nodes: [{ commit: { oid: p.head?.sha, abbreviatedOid: String(p.head?.sha ?? "").slice(0, 7), messageHeadline: p.title, messageBody: "", committedDate: p.updated_at, author: { name: p.user?.login ?? "", user: p.user ? { login: p.user.login, avatarUrl: null } : null }, statusCheckRollup: ci ? { state: ci } : null } }],
        },
        checks: { nodes: [{ commit: { oid: p.head?.sha, statusCheckRollup: ci || checks.length ? { state: ci ?? "SUCCESS", contexts: { totalCount: checks.length, nodes: checks } } : null } }] },
        timelineItems: { totalCount: (page.timeline ?? []).length, nodes: page.timeline ?? [] },
        reviewThreads: { totalCount: (page.threads ?? []).length, nodes: page.threads ?? [] },
      },
    },
  };
}

const gqlState = (p: Record<string, any>) => (p.merged_at ? "MERGED" : p.state === "closed" ? "CLOSED" : "OPEN");

/** A REST pull request as GitHub's GraphQL PullRequest node. */
export function gqlNode(p: Record<string, any>, repo: string, world: FakeRepo): Record<string, unknown> {
  const head = p.head ?? {};
  const headRepo = head.repo?.full_name ?? null;
  const ci = world.ci?.[p.number];
  return {
    number: p.number,
    title: p.title,
    url: p.html_url,
    state: gqlState(p),
    isDraft: !!p.draft,
    mergedAt: p.merged_at ?? null,
    closedAt: p.closed_at ?? (p.state === "closed" ? p.updated_at : null),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    repository: { nameWithOwner: repo },
    author: p.user ? { login: p.user.login, avatarUrl: p.user.avatar_url ?? null } : null,
    headRefName: head.ref,
    headRefOid: head.sha,
    baseRefName: p.base?.ref,
    baseRefOid: p.base?.sha,
    isCrossRepository: !!headRepo && headRepo !== repo,
    maintainerCanModify: !!p.maintainer_can_modify,
    headRepositoryOwner: headRepo ? { login: headRepo.split("/")[0] } : null,
    headRepository: headRepo ? { nameWithOwner: headRepo, url: `https://github.com/${headRepo}` } : null,
    reviewDecision: world.review?.[p.number] ?? null,
    comments: { totalCount: p.comments ?? 0 },
    labels: { nodes: p.labels ?? [] },
    assignees: { nodes: (p.assignees ?? []).map((a: any) => ({ login: a.login, avatarUrl: null })) },
    reviewRequests: { nodes: (p.requested_reviewers ?? []).map((u: any) => ({ requestedReviewer: { __typename: "User", login: u.login } })) },
    commits: {
      nodes: [
        {
          commit: {
            statusCheckRollup: ci
              ? { state: ci, contexts: { checkRunCountsByState: [{ state: ci === "FAILURE" ? "FAILURE" : ci === "PENDING" ? "IN_PROGRESS" : "SUCCESS", count: 1 }, { state: "SUCCESS", count: 2 }], statusContextCountsByState: [] } }
              : null,
          },
        },
      ],
    },
  };
}

/** What a search string asks, as far as the fake reads it. */
function searchMatches(p: Record<string, any>, q: string, viewer: string): boolean {
  const words = q.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];
  for (const w of words) {
    const [k, ...rest] = w.split(":");
    const v = rest.join(":").replace(/^"|"$/g, "");
    if (w === "is:pr" || k === "repo" || k === "sort") continue;
    if (w === "is:open" && gqlState(p) !== "OPEN") return false;
    if (w === "is:merged" && gqlState(p) !== "MERGED") return false;
    if (w === "is:closed" && gqlState(p) === "OPEN") return false;
    if (w === "is:unmerged" && gqlState(p) === "MERGED") return false;
    if (k === "author" && (p.user?.login ?? "") !== (v === "@me" ? viewer : v)) return false;
    if (k === "label" && !(p.labels ?? []).some((l: any) => l.name === v)) return false;
    if (k === "review-requested" && !(p.requested_reviewers ?? []).some((u: any) => u.login === (v === "@me" ? viewer : v))) return false;
    if (k === "assignee" && !(p.assignees ?? []).some((u: any) => u.login === (v === "@me" ? viewer : v))) return false;
    if (w === "no:assignee" && (p.assignees ?? []).length > 0) return false;
    if (!rest.length && !String(p.title).toLowerCase().includes(w.toLowerCase())) return false;
  }
  return true;
}

/**
 * POST /graphql for the Pull Requests list: the page queries (list and
 * search shapes, with their counts and the viewer), a repository's fork
 * parent, and the filter menus' labels and people. `repos` is keyed
 * "owner/repo". Anything else falls through to `other`.
 */
export function graphqlWorld(
  repos: Record<string, FakeRepo>,
  opts: { viewer?: string; other?: (req: FakeRequest) => FakeReply } = {},
): (req: FakeRequest) => FakeReply {
  const viewer = opts.viewer ?? "me";
  return (req) => {
    const body = req.body as { query: string; variables: Record<string, any> };
    const q = body.query;
    const v = body.variables ?? {};
    const byUpdate = (a: any, b: any) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : b.number - a.number);
    const page = (all: Record<string, any>[], repo: string, world: FakeRepo) => {
      const start = v.after ? Number(v.after) : 0;
      const slice = all.slice(start, start + v.first);
      const end = start + slice.length;
      return {
        nodes: slice.map((p) => gqlNode(p, repo, world)),
        pageInfo: { hasNextPage: end < all.length, endCursor: String(end) },
      };
    };
    if (/list: pullRequests/.test(q)) {
      const repo = `${v.owner}/${v.name}`;
      const world = repos[repo];
      if (!world) return { body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${repo}'.` }] } };
      const all = world.pulls().sort(byUpdate);
      const of = (s: string) => all.filter((p) => gqlState(p) === s);
      const listed = v.states ? all.filter((p) => v.states.includes(gqlState(p))) : all;
      return {
        body: {
          data: {
            ...(/viewer \{/.test(q) ? { viewer: { login: viewer, avatarUrl: null } } : {}),
            repository: {
              nameWithOwner: repo,
              ...(/open: pullRequests/.test(q)
                ? { open: { totalCount: of("OPEN").length }, merged: { totalCount: of("MERGED").length }, closed: { totalCount: of("CLOSED").length } }
                : {}),
              list: { totalCount: listed.length, ...page(listed, repo, world) },
            },
          },
        },
      };
    }
    if (/list: search/.test(q)) {
      const repo = /repo:(\S+)/.exec(String(v.q))?.[1] ?? "";
      const world = repos[repo] ?? { pulls: () => [] };
      const all = world.pulls().sort(byUpdate);
      const hits = (s: string) => all.filter((p) => searchMatches(p, s, viewer));
      const listed = hits(String(v.q));
      return {
        body: {
          data: {
            ...(/viewer \{/.test(q) ? { viewer: { login: viewer, avatarUrl: null } } : {}),
            ...(v.qOpen ? { open: { issueCount: hits(v.qOpen).length }, merged: { issueCount: hits(v.qMerged).length }, closed: { issueCount: hits(v.qClosed).length } } : {}),
            list: { issueCount: listed.length, ...page(listed, repo, world) },
          },
        },
      };
    }
    if (/pullRequest\(number: \$n\)/.test(q)) {
      const repo = `${v.owner}/${v.name}`;
      const world = repos[repo];
      if (!world) return { body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${repo}'.` }] } };
      const p = world.pulls().find((x) => x.number === v.n);
      if (!p) return { body: { data: { viewer: { login: viewer }, repository: { nameWithOwner: repo, pullRequest: null } }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a PullRequest with the number of ${v.n}.` }] } };
      return { body: { data: gqlPage(p, repo, world, viewer) } };
    }
    if (/isFork/.test(q)) {
      const repo = `${v.owner}/${v.name}`;
      const world = repos[repo];
      if (!world) return { body: { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "Could not resolve" }] } };
      return {
        body: {
          data: {
            repository: {
              nameWithOwner: repo,
              url: `https://github.com/${repo}`,
              isFork: !!world.isFork,
              defaultBranchRef: { name: "main" },
              parent: world.parent ? { nameWithOwner: world.parent, url: `https://github.com/${world.parent}` } : null,
            },
          },
        },
      };
    }
    if (/pullRequestTemplates/.test(q)) {
      // The New pull request form's one question.
      const repo = `${v.owner}/${v.name}`;
      const world = repos[repo];
      if (!world) return { body: { data: { viewer: { login: viewer, avatarUrl: null }, repository: null }, errors: [{ type: "NOT_FOUND", message: `Could not resolve to a Repository with the name '${repo}'.` }] } };
      const branches = world.branches ?? [world.defaultBranch ?? "main"];
      return {
        body: {
          data: {
            viewer: { login: viewer, avatarUrl: null },
            repository: {
              nameWithOwner: repo,
              viewerPermission: world.permission ?? "WRITE",
              defaultBranchRef: { name: world.defaultBranch ?? "main" },
              pullRequestTemplates: world.templates ?? [],
              refs: { totalCount: branches.length, nodes: branches.map((name) => ({ name })) },
              labels: { totalCount: world.labels?.length ?? 0, nodes: world.labels ?? [] },
              assignableUsers: { totalCount: world.people?.length ?? 0, nodes: (world.people ?? []).map((login) => ({ login, avatarUrl: null })) },
            },
          },
        },
      };
    }
    if (/assignableUsers/.test(q)) {
      const world = repos[`${v.owner}/${v.name}`];
      return {
        body: {
          data: {
            repository: {
              labels: { totalCount: world?.labels?.length ?? 0, nodes: world?.labels ?? [] },
              assignableUsers: { totalCount: world?.people?.length ?? 0, nodes: (world?.people ?? []).map((login) => ({ login, avatarUrl: null })) },
            },
          },
        },
      };
    }
    return opts.other ? opts.other(req) : { status: 400, body: { message: "The fake GitHub has no answer to this query." } };
  };
}

/** `Link` header for page `page` of `last`. */
export function linkHeader(path: string, page: number, last: number): Record<string, string> {
  if (page >= last) return {};
  const at = (p: number) => `<https://api.github.com${path}${path.includes("?") ? "&" : "?"}page=${p}>`;
  return { link: `${at(page + 1)}; rel="next", ${at(last)}; rel="last"` };
}
