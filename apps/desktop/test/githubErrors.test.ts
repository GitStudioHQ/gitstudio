import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpectedError } from "../src/main/expectedError";
import {
  errorFields,
  githubHttpError,
  graphqlError,
  networkError,
} from "../src/main/githubErrors";

// 1.1.1 stopped filing "Not connected to GitHub." as a crash. Its siblings kept
// arriving: being offline, an expired token, the rate limiter. None of them are
// defects — they are states a user is allowed to be in — and anyone on flaky
// wifi produced a stream of reports.
//
// These tests pin the policy in main/githubErrors.ts: our bugs get reported,
// the network / the user's auth state / GitHub's own health do not. They assert
// the MESSAGE too, because the whole point is that nothing the user sees
// changes — only whether a report is filed.

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

test("being offline is a condition, not a crash", () => {
  const e = networkError();
  assert.equal(isExpectedError(e), true);
  assert.equal(e.message, "Couldn't reach GitHub. Check your network connection.");
  assert.ok(e instanceof Error, "must stay an Error for existing catch sites");
});

test("networkError keeps a caller's own wording", () => {
  const e = networkError("Couldn't download from GitHub's storage. Check your network connection.");
  assert.equal(isExpectedError(e), true);
  assert.match(e.message, /GitHub's storage/);
});

test("an expired or revoked token is not reported", async () => {
  const e = await githubHttpError(json(401, { message: "Bad credentials" }));
  assert.equal(isExpectedError(e), true);
  // Deliberately OUR wording, not GitHub's "Bad credentials", which reads as an
  // accusation rather than "sign in again".
  assert.equal(e.message, "Your GitHub token is invalid or expired.");
});

test("a missing scope and the secondary rate limit are not reported", async () => {
  const e = await githubHttpError(json(403, { message: "API rate limit exceeded" }));
  assert.equal(isExpectedError(e), true);
  assert.equal(e.message, "API rate limit exceeded", "GitHub's own detail is the useful one here");
});

test("the primary rate limiter is not reported", async () => {
  const e = await githubHttpError(json(429, {}));
  assert.equal(isExpectedError(e), true);
  assert.match(e.message, /rate-limiting/);
});

test("GitHub being down is not our defect", async () => {
  for (const status of [500, 502, 503]) {
    const e = await githubHttpError(json(status, {}));
    assert.equal(isExpectedError(e), true, `HTTP ${status} must not be reported`);
    assert.match(e.message, new RegExp(String(status)));
  }
});

test("a malformed request IS reported — that one is ours", async () => {
  for (const status of [400, 422]) {
    const e = await githubHttpError(json(status, { message: "Validation Failed" }));
    assert.equal(isExpectedError(e), false, `HTTP ${status} is a bug we want to hear about`);
  }
});

test("404 stays reported, deliberately", async () => {
  // The edge case in the policy. Some 404s are an auth state (GitHub answers 404
  // rather than 403 for a private repo a token cannot see), but a path we built
  // wrong is exactly the bug a crash report is best at catching. Documented in
  // githubErrors.ts; change both together if real reports say otherwise.
  const e = await githubHttpError(json(404, {}));
  assert.equal(isExpectedError(e), false);
  assert.equal(e.message, "Not found on GitHub.");
});

test("a non-JSON error body does not itself throw", async () => {
  // A captive portal or a GitHub error page answers HTML. res.json() rejects,
  // and an unhandled rejection here would file a crash for the very condition
  // this module exists to classify.
  const e = await githubHttpError(new Response("<html>nope</html>", { status: 503 }));
  assert.equal(isExpectedError(e), true);
  assert.ok(e.message.length > 0, "must still say something useful");
});

test("GraphQL reports its rate limit in a 200 body, so it is classified separately", () => {
  assert.equal(
    isExpectedError(graphqlError({ message: "API rate limit exceeded", type: "RATE_LIMITED" })),
    true,
  );
  assert.equal(
    isExpectedError(graphqlError({ message: "Resource not accessible", type: "FORBIDDEN" })),
    true,
  );
  assert.equal(
    isExpectedError(graphqlError({ message: "Field 'nope' doesn't exist on type 'Repository'" })),
    false,
    "a bad query is our bug and must keep reaching the reporter",
  );
});

test("a mutation that CATCHES an expected error still returns it as expected", async () => {
  // The gap that made everything above only half a fix. Mutation handlers do not
  // let the throw escape — they catch it and hand the renderer
  // `{ok:false, message}` — and rebuilding the result from `err.message` alone
  // dropped the marker, so the IPC wrapper's ok:false branch filed the crash
  // report the throw had just been spared. That is every mutation in the app:
  // closing an issue, re-running a workflow, publishing a release.
  const expired = await githubHttpError(json(401, {}));
  const result = { ok: false, changed: false, ...errorFields(expired) };

  assert.equal(isExpectedError(result), true, "the marker must survive the catch");
  assert.equal(result.message, "Your GitHub token is invalid or expired.");
});

test("a real bug caught by the same handler is still reported", () => {
  const bug = new TypeError("undefined is not a function");
  const result = { ok: false, changed: false, ...errorFields(bug) };

  assert.equal(isExpectedError(result), false);
  assert.equal(result.message, "undefined is not a function");
  assert.equal("expected" in result, false, "absent, not `expected: false`");
});

test("errorFields copes with a non-Error throw", () => {
  assert.deepEqual(errorFields("just a string"), { message: "just a string" });
  assert.deepEqual(errorFields(undefined), { message: "undefined" });
});

test("every expected error still reaches the user unchanged", async () => {
  // The reporter is the only thing that treats these differently. Electron
  // serializes a rejection as the error's toString(), so a subclass that set
  // `name` would put "ExpectedError:" in front of every message — see
  // expectedError.test.ts. Guard it here too, for the errors this module makes.
  const cases: Error[] = [
    networkError(),
    await githubHttpError(json(401, {})),
    await githubHttpError(json(403, { message: "denied" })),
    graphqlError({ message: "API rate limit exceeded", type: "RATE_LIMITED" }),
  ];
  for (const e of cases) {
    assert.equal(e.toString(), `Error: ${e.message}`, "must be indistinguishable on the wire");
  }
});
