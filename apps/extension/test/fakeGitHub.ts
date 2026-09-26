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
  /** Hold every request whose path matches `re` until released. */
  hold(re: RegExp): Hold;
  restore(): void;
}

export function installFakeGitHub(routes: Route[]): FakeGitHub {
  const original = globalThis.fetch;
  const holds: { re: RegExp; waiting: (() => void)[]; on: boolean }[] = [];
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
    for (const h of holds) {
      if (h.on && h.re.test(path)) {
        await new Promise<void>((go) => h.waiting.push(go));
      }
    }
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const req: FakeRequest = {
      method,
      path,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      headers,
    };
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
    updated_at: new Date(Date.now() - 3 * 3600e3).toISOString(),
    merged_at: null,
    head: { ref: `feature-${n}`, sha: `${String(n).padStart(3, "0")}head`, label: `acme:feature-${n}`, repo: { full_name: "acme/app", clone_url: "https://github.com/acme/app.git" } },
    base: { ref: "main", sha: "basesha", label: "acme:main", repo: { full_name: "acme/app", clone_url: "https://github.com/acme/app.git" } },
    labels: [],
    requested_reviewers: [],
    ...over,
  };
}

/** `Link` header for page `page` of `last`. */
export function linkHeader(path: string, page: number, last: number): Record<string, string> {
  if (page >= last) return {};
  const at = (p: number) => `<https://api.github.com${path}${path.includes("?") ? "&" : "?"}page=${p}>`;
  return { link: `${at(page + 1)}; rel="next", ${at(last)}; rel="last"` };
}
