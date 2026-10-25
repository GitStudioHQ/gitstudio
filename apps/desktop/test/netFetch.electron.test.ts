// #133: inside Electron, the main process's requests go out over Chromium's
// network stack (net.fetch), which follows the system proxy — not over Node's
// global fetch, which connects directly and never asks about a proxy.
//
// Each of these failed on 2.7.0, where githubAuth / githubClient called the
// global fetch: the fake Chromium stack below was never asked.

import { chromium } from "./netFakeElectron";
import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { netFetch } from "../src/main/netFetch";
import { requestDeviceCode, pollForToken, GITHUB_CLIENT_ID } from "../src/main/githubAuth";
import { GitHubClient } from "../src/main/githubClient";
import { isExpectedError } from "../src/main/expectedError";

const realFetch = globalThis.fetch;
let nodeCalls: string[] = [];

beforeEach(() => {
  chromium.ready = true;
  chromium.calls = [];
  chromium.requests = [];
  chromium.answer = async () => new Response("{}", { status: 200 });
  chromium.onRequest = () => {};
  nodeCalls = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    nodeCalls.push(String(input instanceof Request ? input.url : input));
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("the device-code request goes through Chromium's network stack", async () => {
  chromium.answer = async () =>
    json({
      device_code: "dc",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
  const code = await requestDeviceCode();
  assert.equal(code.userCode, "ABCD-1234");
  assert.deepEqual(nodeCalls, [], "Node's fetch must not be used: it ignores the system proxy");
  assert.equal(chromium.calls.length, 1);
  const call = chromium.calls[0]!;
  assert.equal(call.url, "https://github.com/login/device/code");
  assert.equal(call.init.method, "POST");
  assert.equal(JSON.parse(String(call.init.body)).client_id, GITHUB_CLIENT_ID);
  assert.equal((call.init.headers as Record<string, string>)["User-Agent"], "GitStudio");
  // No session cookies, no HTTP cache: Node's fetch had neither.
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.cache, "no-store");
});

test("the token poll goes through Chromium's network stack", async () => {
  chromium.answer = async () => json({ error: "authorization_pending" });
  const r = await pollForToken("dc");
  assert.equal(r.state, "pending");
  assert.deepEqual(nodeCalls, []);
  assert.equal(chromium.calls[0]?.url, "https://github.com/login/oauth/access_token");
});

test("a proxy failure says why and which request, and stays an expected condition", async () => {
  chromium.answer = async () => {
    throw new Error("net::ERR_PROXY_CONNECTION_FAILED");
  };
  const warn = console.warn;
  const logged: unknown[][] = [];
  console.warn = (...a: unknown[]) => void logged.push(a);
  try {
    await assert.rejects(requestDeviceCode(), (e: Error) => {
      assert.equal(
        e.message,
        "Couldn't reach GitHub (ERR_PROXY_CONNECTION_FAILED) — github.com/login/device/code. Check your network or proxy settings.",
      );
      assert.equal(isExpectedError(e), true, "a network condition is not a crash");
      assert.match(String((e.cause as Error).message), /ERR_PROXY_CONNECTION_FAILED/, "the cause is kept");
      return true;
    });
  } finally {
    console.warn = warn;
  }
  assert.equal(logged.length, 1, "the failure is logged once");
  assert.match(String(logged[0]![0]), /github\.com\/login\/device\/code.*ERR_PROXY_CONNECTION_FAILED/);
});

test("GitHub API calls (REST and GraphQL) go through Chromium's network stack", async () => {
  chromium.answer = async (call) =>
    call.url.endsWith("/graphql") ? json({ data: { viewer: { login: "me" } } }) : json({ login: "me" });
  const client = new GitHubClient(() => "ghp_test");
  await client.request("GET", "/user");
  await client.requestBody("PATCH", "/repos/o/r/issues/1", { state: "closed" });
  await client.graphql("{ viewer { login } }", {});
  assert.deepEqual(nodeCalls, []);
  assert.deepEqual(
    chromium.calls.map((c) => `${c.init.method} ${c.url}`),
    [
      "GET https://api.github.com/user",
      "PATCH https://api.github.com/repos/o/r/issues/1",
      "POST https://api.github.com/graphql",
    ],
  );
  assert.equal((chromium.calls[0]!.init.headers as Record<string, string>).Authorization, "Bearer ghp_test");
});

test("an API failure names the code and the endpoint (no query string)", async () => {
  chromium.answer = async () => {
    throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ETIMEDOUT" } });
  };
  const warn = console.warn;
  console.warn = () => {};
  try {
    const client = new GitHubClient(() => "ghp_test");
    await assert.rejects(client.request("GET", "/search/issues?q=secret+words"), {
      message: "Couldn't reach GitHub (ETIMEDOUT) — api.github.com/search/issues. Check your network or proxy settings.",
    });
  } finally {
    console.warn = warn;
  }
});

test("loopback stays on Node's fetch — a local model server is never behind a proxy", async () => {
  await netFetch("http://127.0.0.1:11434/api/tags");
  await netFetch("http://localhost:1234/v1/models");
  await netFetch("http://[::1]:8080/x");
  assert.deepEqual(nodeCalls, [
    "http://127.0.0.1:11434/api/tags",
    "http://localhost:1234/v1/models",
    "http://[::1]:8080/x",
  ]);
  assert.equal(chromium.calls.length, 0);
});

test("before the app is ready there is no Chromium stack: Node's fetch is used", async () => {
  chromium.ready = false;
  await netFetch("https://api.github.com/user");
  assert.deepEqual(nodeCalls, ["https://api.github.com/user"]);
  assert.equal(chromium.calls.length, 0);
});

test("a caller's own options win over the defaults, and the rest pass through", async () => {
  const signal = AbortSignal.timeout(5000);
  await netFetch(new URL("https://example.com/a"), { method: "PUT", body: "x", cache: "reload", signal } as RequestInit);
  const call = chromium.calls[0]!;
  assert.equal(call.url, "https://example.com/a");
  assert.equal(call.init.method, "PUT");
  assert.equal(call.init.body, "x");
  assert.equal(call.init.cache, "reload");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.signal, signal);
});

test('redirect: "manual" answers with the 3xx and its Location, as undici does', async () => {
  // net.fetch rejects a manual redirect ("Redirect was cancelled"); the Actions
  // log download depends on seeing it, so that mode runs over net.request.
  chromium.onRequest = (call) =>
    call.emitter.emit("redirect", 302, "GET", "https://blob.example/log?sig=1", { "x-a": ["1"] });
  const res = await netFetch("https://api.github.com/repos/o/r/actions/jobs/1/logs", {
    headers: { Authorization: "Bearer t" },
    redirect: "manual",
  });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "https://blob.example/log?sig=1");
  const req = chromium.requests[0]!;
  assert.equal(req.options.redirect, "manual");
  assert.equal(req.options.credentials, "omit");
  assert.equal(req.headers.authorization, "Bearer t");
  assert.equal(req.aborted, true, "the redirect is not followed");
  assert.equal(chromium.calls.length, 0);
});

test('redirect: "manual" with a direct answer streams that answer', async () => {
  chromium.onRequest = (call) => {
    const res = new EventEmitter();
    Object.assign(res, { statusCode: 200, statusMessage: "OK", headers: { "content-type": "text/plain" } });
    call.emitter.emit("response", res);
    res.emit("data", Buffer.from("line 1\n"));
    res.emit("data", Buffer.from("line 2\n"));
    res.emit("end");
  };
  const res = await netFetch("https://api.github.com/x", { redirect: "manual", method: "POST", body: "payload" });
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "line 1\nline 2\n");
  assert.equal(Buffer.concat(chromium.requests[0]!.written).toString(), "payload");
});

test('redirect: "manual" honours an abort', async () => {
  const ctrl = new AbortController();
  chromium.onRequest = () => ctrl.abort();
  await assert.rejects(netFetch("https://api.github.com/x", { redirect: "manual", signal: ctrl.signal }), {
    name: "AbortError",
  });
  assert.equal(chromium.requests[0]!.aborted, true);
});

test('redirect: "manual": an abort mid-body ends the body instead of hanging it', async () => {
  const ctrl = new AbortController();
  let res!: EventEmitter;
  chromium.onRequest = (call) => {
    res = new EventEmitter();
    Object.assign(res, { statusCode: 200, statusMessage: "OK", headers: {} });
    call.emitter.emit("response", res);
    res.emit("data", Buffer.from("part"));
  };
  const r = await netFetch("https://api.github.com/x", { redirect: "manual", signal: ctrl.signal });
  const reader = r.body!.getReader();
  assert.equal(Buffer.from((await reader.read()).value!).toString(), "part");
  ctrl.abort();
  await assert.rejects(reader.read(), { name: "AbortError" });
});
