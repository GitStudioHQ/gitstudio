// #133: "Couldn't reach …" used to drop the one word that says what went wrong.

import { test } from "node:test";
import assert from "node:assert/strict";
import { endpointOf, networkReason } from "../src/networkReason";

test("undici: the code under `cause`", () => {
  const err = new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) });
  assert.equal(networkReason(err), "UND_ERR_CONNECT_TIMEOUT");
  assert.equal(networkReason(Object.assign(new TypeError("fetch failed"), { cause: { code: "ENOTFOUND" } })), "ENOTFOUND");
});

test("undici: every address failed (AggregateError under `cause`)", () => {
  const agg = new AggregateError([Object.assign(new Error("a"), { code: "ECONNREFUSED" })], "");
  assert.equal(networkReason(new TypeError("fetch failed", { cause: agg })), "ECONNREFUSED");
});

test("Chromium (Electron net.fetch): the net:: code in the message", () => {
  assert.equal(networkReason(new Error("net::ERR_PROXY_CONNECTION_FAILED")), "ERR_PROXY_CONNECTION_FAILED");
  assert.equal(networkReason(new Error("net::ERR_TUNNEL_CONNECTION_FAILED")), "ERR_TUNNEL_CONNECTION_FAILED");
});

test("a timeout from AbortSignal.timeout", () => {
  assert.equal(networkReason(new DOMException("The operation was aborted due to timeout", "TimeoutError")), "TimeoutError");
});

test("no code: the message, but never the empty 'fetch failed'", () => {
  assert.equal(networkReason(new TypeError("fetch failed")), undefined);
  assert.equal(networkReason(new Error("certificate has expired")), "certificate has expired");
  assert.equal(networkReason(undefined), undefined);
  assert.equal(networkReason("socket hang up"), "socket hang up");
});

test("a numeric or lower-case `code` is not a reason (DOMException codes are numbers)", () => {
  assert.equal(networkReason(Object.assign(new Error("x"), { code: 20 })), "x");
});

test("a cyclic cause chain terminates", () => {
  const a: { message: string; cause?: unknown } = { message: "fetch failed" };
  a.cause = a;
  assert.equal(networkReason(a), undefined);
});

test("endpointOf: host and path, never the query or credentials", () => {
  assert.equal(endpointOf("https://github.com/login/device/code"), "github.com/login/device/code");
  assert.equal(endpointOf("https://api.github.com/search/issues?q=secret"), "api.github.com/search/issues");
  assert.equal(endpointOf("https://user:pw@example.com/"), "example.com");
  assert.equal(endpointOf("http://localhost:11434/v1"), "localhost:11434/v1");
  assert.equal(endpointOf("not a url"), "not a url");
});
