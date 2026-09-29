// A fake api.github.com for the desktop's GitHub tests: it replaces the global
// fetch, answers each request from a route table keyed "METHOD /path?query",
// and records every request so a test can assert what was SENT — method, path,
// JSON body, headers — as well as what the code made of the answer.
//
// A request with no route answers 404 with a message naming it (and is listed
// in `unmatched`), so a path built wrong fails loudly instead of quietly
// reading as "not found".

import type { TestContext } from "node:test";
import { GitHubClient } from "../src/main/githubClient";

const API = "https://api.github.com";

export interface FakeCall {
  method: string;
  /** The full URL fetched. */
  url: string;
  /** The URL relative to api.github.com (the full URL for any other host). */
  path: string;
  /** The JSON-decoded body, the raw body when it is not a string, or undefined. */
  body: unknown;
  headers: Record<string, string>;
}

/** A route's answer: a Response as-is, an Error thrown (a network failure),
 *  anything else served as JSON at HTTP 200. A function is called per request. */
export type FakeReply = unknown | ((call: FakeCall) => unknown | Promise<unknown>);

export interface FakeGitHub {
  calls: FakeCall[];
  unmatched: string[];
  client: GitHubClient;
  /** The calls made with this method + path (exact). */
  sent(method: string, path: string): FakeCall[];
  /** Add or replace a route. */
  route(key: string, reply: FakeReply): void;
}

/** A JSON response at `status`, with optional extra headers (e.g. `link`). */
export function reply(status: number, json?: unknown, headers: Record<string, string> = {}): Response {
  if (status === 204) return new Response(null, { status, headers });
  return new Response(json === undefined ? "" : JSON.stringify(json), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

/** A 200 page of a paged list with a rel="next" link to `next` (an API path). */
export function page(items: unknown, next?: string): Response {
  return reply(200, items, next ? { link: `<${API}${next}>; rel="next", <${API}/last>; rel="last"` } : {});
}

/** Base64, as the contents API inlines file bodies. */
export function b64(text: string | Uint8Array): string {
  return Buffer.from(text).toString("base64");
}

export function fakeGitHub(
  t: TestContext,
  routes: Record<string, FakeReply> = {},
  /** null: a client with no token (signed out). */
  token: string | null = "ghp_test",
): FakeGitHub {
  const table = new Map<string, FakeReply>(Object.entries(routes));
  const calls: FakeCall[] = [];
  const unmatched: string[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = (init?.method ?? "GET").toUpperCase();
    // By origin, not by prefix: "https://api.github.com.evil" must not match.
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    const path = parsed && parsed.origin === new URL(API).origin ? parsed.pathname + parsed.search : url;
    let body: unknown = init?.body ?? undefined;
    if (typeof body === "string") {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep the raw string */
      }
    }
    const headers = { ...((init?.headers as Record<string, string> | undefined) ?? {}) };
    const call: FakeCall = { method, url, path, body, headers };
    calls.push(call);
    const key = `${method} ${path}`;
    if (!table.has(key)) {
      unmatched.push(key);
      return reply(404, { message: `no fake route: ${key}` });
    }
    const r = table.get(key);
    const v = typeof r === "function" ? await (r as (c: FakeCall) => unknown)(call) : r;
    if (v instanceof Error) throw v;
    if (v instanceof Response) return v;
    return reply(200, v);
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = real;
  });
  return {
    calls,
    unmatched,
    client: new GitHubClient(() => token ?? undefined),
    sent: (method, path) => calls.filter((c) => c.method === method && c.path === path),
    route: (key, r) => void table.set(key, r),
  };
}
