// The crash reporter (errorReporter.ts) as a whole: what it sends, where, and
// when it sends nothing. The collector is a server on 127.0.0.1 run by this
// test, so the payload checked is the one that crossed the wire.
//
//  · a thrown error / a failed git op arrive scrubbed, tagged with the install
//    id, versions and OS — and never twice for the same failure;
//  · nothing leaves while VS Code's telemetry is off, the setting is off, or
//    the endpoint is blank or not http(s) — and a change to either is heard;
//  · at most 50 reports a session;
//  · process-wide rejections are reported only when their stack is ours;
//  · dispose stops listening.

import Module from "node:module";
import { join } from "node:path";
import { test, after, before } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import type { AddressInfo } from "node:net";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const vscode = require("vscode") as Record<string, unknown>;

// Consent and configuration, changeable per test.
const settings: { enabled?: boolean; endpoint?: string } = {};
const env = {
  isTelemetryEnabled: true,
  appName: "Cursor",
  onDidChangeTelemetryEnabled: (l: () => void) => {
    telemetryListeners.push(l);
    return { dispose: () => void telemetryListeners.splice(telemetryListeners.indexOf(l), 1) };
  },
};
const telemetryListeners: (() => void)[] = [];
const configListeners: ((e: { affectsConfiguration: (s: string) => boolean }) => void)[] = [];
vscode.env = env;
vscode.version = "1.99.0";
vscode.workspace = {
  getConfiguration: (section: string) => ({
    get: (key: string, d?: unknown) => {
      assert.equal(section, "gitstudio.errorReporting");
      const v = (settings as Record<string, unknown>)[key];
      return v === undefined ? d : v;
    },
  }),
  onDidChangeConfiguration: (l: (e: { affectsConfiguration: (s: string) => boolean }) => void) => {
    configListeners.push(l);
    return { dispose: () => void configListeners.splice(configListeners.indexOf(l), 1) };
  },
};
const { ErrorReporter } = require("../src/reporting/errorReporter") as typeof import("../src/reporting/errorReporter");
/* eslint-enable @typescript-eslint/no-require-imports */

// Every request the reporter STARTS (synchronously), to prove a negative
// without waiting on a network that must stay silent.
const started: string[] = [];
// eslint-disable-next-line @typescript-eslint/no-require-imports -- the module object itself, not an import's copy of it
const httpModule = require("node:http") as { request: typeof http.request };
const realRequest = httpModule.request;
httpModule.request = (...args: Parameters<typeof http.request>) => {
  const opts = args[0] as { hostname?: string; path?: string };
  started.push(`${opts.hostname}${opts.path}`);
  return realRequest(...args);
};

// The collector.
type Payload = Record<string, string>;
const received: Payload[] = [];
const waiters: (() => void)[] = [];
const server = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    assert.equal(req.headers["user-agent"], "gitstudio-error-reporter");
    received.push(JSON.parse(body) as Payload);
    res.end("ok");
    for (const w of waiters.splice(0)) w();
  });
});
let endpoint = "";
before(async () => {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/errors?v=1`;
});
after(() => server.close());

/** Resolve once the collector holds `n` reports (the requests are fire-and-forget). */
async function receivedCount(n: number): Promise<void> {
  while (received.length < n) await new Promise<void>((r) => waiters.push(r));
}

const EXT = "/home/someone/.vscode/extensions/gitstudio.gitstudio-9.9.9";
function reporter(stored?: string) {
  const state = new Map<string, unknown>(stored ? [["gitstudio.errorReporting.installId.v1", stored]] : []);
  const context = {
    extensionPath: EXT,
    extension: { packageJSON: { version: "9.9.9" } },
    globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => void state.set(k, v) },
  };
  const rejectionsBefore = new Set(process.listeners("unhandledRejection"));
  const exceptionsBefore = new Set(process.listeners("uncaughtException"));
  const r = new ErrorReporter(context as never);
  const onRejection = process.listeners("unhandledRejection").find((l) => !rejectionsBefore.has(l));
  const onException = process.listeners("uncaughtException").find((l) => !exceptionsBefore.has(l));
  return {
    r,
    state,
    onRejection: onRejection as (reason: unknown) => void,
    onException: onException as (err: Error) => void,
  };
}

function reset(): void {
  settings.enabled = undefined;
  settings.endpoint = endpoint;
  env.isTelemetryEnabled = true;
  started.length = 0;
  received.length = 0;
}

test("a thrown error reaches the collector scrubbed, tagged with the install and never twice", async () => {
  reset();
  const { r, state } = reporter();
  const id = state.get("gitstudio.errorReporting.installId.v1");
  assert.equal(typeof id, "string", "a random install id is made and kept");
  assert.equal(ErrorReporter.current, r);
  const err = new TypeError("cannot read /Users/alice/secret-project/src/a.ts for alice@example.com");
  err.stack = `TypeError: boom\n    at run (${EXT}/dist/extension.js:10:5)\n    at /Users/alice/secret-project/x.js:1:1`;
  r.captureError("commit.amend", err, { phase: "write" });
  r.captureError("commit.amend", err, { phase: "write" }); // the same failure again
  await receivedCount(1);
  assert.equal(started.length, 1, "one report per distinct failure");
  assert.equal(started[0], "127.0.0.1/api/errors?v=1", "to the configured endpoint, query and all");
  const p = received[0];
  assert.equal(p.event, "error");
  assert.equal(p.where, "commit.amend");
  assert.equal(p.name, "TypeError");
  assert.equal(p.installId, id);
  assert.equal(p.extVersion, "9.9.9");
  assert.equal(p.engine, "VS Code 1.99.0");
  assert.equal(p.product, "Cursor");
  assert.equal(p.platform, process.platform);
  assert.equal(p.arch, process.arch);
  assert.ok(p.osRelease.length > 0);
  assert.equal(p.phase, "write", "extra fields ride along");
  const all = JSON.stringify(p);
  assert.ok(!all.includes("alice"), `no user name or email leaves the machine: ${all}`);
  assert.ok(!all.includes("secret-project"), "no absolute path leaves the machine");

  // A non-Error thrown value is reported by its text.
  r.captureError("x", "plain string failure");
  await receivedCount(2);
  assert.equal(received[1].name, "Error");
  assert.equal(received[1].message, "plain string failure");
  r.dispose();
});

test("a failed git op is reported by our own label, with git's words scrubbed of file and branch names", async () => {
  reset();
  const { r } = reporter("fixed-install-id");
  r.captureGitError("git reset failed", "error: Your local changes to 'src/private/plan.md' would be overwritten\nfatal: refs/heads/feature/acme-merger");
  await receivedCount(1);
  const p = received[0];
  assert.equal(p.event, "git-error");
  assert.equal(p.op, "git reset failed");
  assert.equal(p.installId, "fixed-install-id", "an existing install id is reused");
  assert.ok(!p.stderr.includes("plan.md"), p.stderr);
  assert.ok(!p.stderr.includes("acme-merger"), p.stderr);
  r.dispose();
});

test("nothing is sent while telemetry is off, the setting is off, or there is no usable endpoint — and a change is heard live", async () => {
  reset();
  env.isTelemetryEnabled = false;
  const { r } = reporter();
  r.captureGitError("a failed", "x");
  assert.deepEqual(started, [], "VS Code telemetry off: nothing");

  env.isTelemetryEnabled = true;
  for (const l of telemetryListeners) l();
  settings.enabled = false;
  for (const l of configListeners) l({ affectsConfiguration: (s) => s === "gitstudio.errorReporting" });
  r.captureGitError("b failed", "x");
  assert.deepEqual(started, [], "our own setting off: nothing");

  settings.enabled = true;
  settings.endpoint = "   ";
  for (const l of configListeners) l({ affectsConfiguration: (s) => s === "gitstudio.errorReporting" });
  r.captureGitError("c failed", "x");
  assert.deepEqual(started, [], "a blank endpoint: nothing");

  for (const bad of ["not a url", "ftp://127.0.0.1/api", "file:///tmp/x"]) {
    settings.endpoint = bad;
    for (const l of configListeners) l({ affectsConfiguration: (s) => s === "gitstudio.errorReporting" });
    r.captureGitError(`${bad} failed`, "x");
  }
  assert.deepEqual(started, [], "an endpoint that is not http(s): nothing");

  // A change to some other setting is not a reason to re-read ours.
  settings.endpoint = endpoint;
  for (const l of configListeners) l({ affectsConfiguration: () => false });
  r.captureGitError("d failed", "x");
  assert.deepEqual(started, [], "still the last endpoint read");

  for (const l of configListeners) l({ affectsConfiguration: (s) => s === "gitstudio.errorReporting" });
  r.captureGitError("e failed", "x");
  await receivedCount(1);
  assert.equal(received[0].op, "e failed", "consent back: reports flow again");
  r.dispose();
});

test("at most 50 reports leave in one session", async () => {
  reset();
  const { r } = reporter();
  for (let i = 0; i < 60; i++) r.captureGitError(`op ${i} failed`, `distinct ${i}`);
  assert.equal(started.length, 50);
  await receivedCount(50);
  assert.deepEqual(new Set(received.map((p) => p.op)).size, 50);
  r.dispose();
});

test("a process-wide rejection is reported only when its stack is ours; dispose stops listening", async () => {
  reset();
  const { r, onRejection, onException } = reporter();
  assert.ok(onRejection, "the reporter listens for unhandled rejections");
  assert.ok(onException, "…and uncaught exceptions");
  const foreign = new Error("someone else's bug");
  foreign.stack = "Error: someone else's bug\n    at x (/home/someone/.vscode/extensions/other.ext-1.0.0/out/main.js:1:1)";
  onRejection(foreign);
  onRejection("not even an Error");
  const stackless = new Error(`at ${EXT}/dist/extension.js`);
  stackless.stack = "";
  onRejection(stackless);
  const proseOnly = new Error("no frames");
  proseOnly.stack = `Error: ENOENT ${EXT}/gitstudio/src/a.ts`; // our path in the MESSAGE, none in the frames
  onRejection(proseOnly);
  onException(foreign);
  assert.deepEqual(started, [], "other extensions' failures pass through untouched");

  const ours = new Error("our bug");
  ours.stack = `Error: our bug\n    at y (${EXT}/dist/extension.js:2:2)`;
  onRejection(ours);
  await receivedCount(1);
  assert.equal(received[0].where, "unhandledRejection");
  assert.equal(received[0].message, "our bug");
  const thrown = new RangeError("our throw");
  thrown.stack = `RangeError: our throw\n    at z (${EXT}/dist/extension.js:3:3)`;
  onException(thrown);
  await receivedCount(2);
  assert.equal(received[1].where, "uncaughtException");
  assert.equal(received[1].name, "RangeError");

  const exceptionListeners = process.listeners("uncaughtException").length;
  r.dispose();
  assert.equal(process.listeners("unhandledRejection").includes(onRejection as never), false);
  assert.equal(process.listeners("uncaughtException").length, exceptionListeners - 1);
  assert.equal(ErrorReporter.current, undefined);
  assert.equal(telemetryListeners.length, 0, "the consent listeners are gone too");
  assert.equal(configListeners.length, 0);
});
