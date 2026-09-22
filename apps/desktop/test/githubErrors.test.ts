import { test } from "node:test";
import assert from "node:assert/strict";
import { isExpectedError } from "../src/main/expectedError";
import {
  errorFields,
  githubHttpError,
  graphqlError,
  keepsPartialData,
  networkError,
  type GraphqlFailure,
} from "../src/main/githubErrors";
import { EMPTY_REPO_MESSAGE } from "../src/shared/githubStates";

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

// ── Reports #13, #14, #17: three GitHub ANSWERS filed as crashes ─────────────

test("a repository with no commits is a state, whatever status GitHub used", async () => {
  // The whole reason this one is classified by the MESSAGE. GitHub reports an
  // empty repository with a different status on every endpoint the browser
  // touches: the contents API answers 404 (which the policy above deliberately
  // reports), /commits and /git/trees answer 409. Report #13 is the 404 half,
  // filed for somebody browsing a repository they had just created.
  for (const [status, detail] of [
    [404, "This repository is empty."],
    [409, "Git Repository is empty."],
    [409, "This repository is empty."],
  ] as const) {
    const e = await githubHttpError(json(status, { message: detail }));
    assert.equal(isExpectedError(e), true, `HTTP ${status} "${detail}" must not be reported`);
    // ONE wording, so the renderer has one string to recognise across IPC —
    // where an error is only ever its message — and the collector one to dedupe.
    assert.equal(e.message, EMPTY_REPO_MESSAGE);
  }
});

test("a 409 that is not an empty repository keeps GitHub's own detail", async () => {
  const e = await githubHttpError(json(409, { message: "Merge conflict" }));
  assert.equal(isExpectedError(e), true, "a conflict is the repository's state, not our bug");
  assert.equal(e.message, "Merge conflict");
});

test("a 404 that is NOT about emptiness is still reported", async () => {
  // The empty-repository rule must not swallow the 404 policy whole.
  const e = await githubHttpError(json(404, { message: "Not Found" }));
  assert.equal(isExpectedError(e), false);
});

test("a repository GraphQL cannot resolve is a state, and says so in English", () => {
  // Reports #14 and #17: the repository behind the open repo's remote was
  // renamed, deleted, or moved somewhere this account cannot see. Filed as a
  // crash twice, and shown to the user in GraphQL's own vocabulary.
  const e = graphqlError({
    message: "Could not resolve to a Repository with the name 'acme-private/billing-pipeline'.",
    type: "NOT_FOUND",
    path: ["repository"],
  });
  assert.equal(isExpectedError(e), true);
  assert.match(e.message, /acme-private\/billing-pipeline/, "it still names the repository");
  assert.doesNotMatch(e.message, /resolve to a/i, "but not in GraphQL's vocabulary");
  assert.match(e.message, /renamed or deleted|access/i, "and it says what that might mean");
  assert.equal(e.toString(), `Error: ${e.message}`, "indistinguishable on the wire");
});

test("a NOT_FOUND about an id WE sent is still reported", () => {
  // The other half of the #14/#17 fix, and the one it must not cost us.
  //
  // A GraphQL node id is not a name from the user's world — it is a payload
  // this app built: a project item id, a review thread id, a pull request id,
  // each carried from a read through the renderer into a mutation. Building
  // that payload wrong is this codebase's most-repeated defect (issues #12/#19,
  // plus three more found in a single sweep), and it is exactly the bug the
  // 404 rule above is deliberately kept loud for. Marking it `expected` would
  // have turned every one of those into a blue toast and no report.
  const e = graphqlError({
    message: "Could not resolve to a node with the global id of 'PRRT_kwDOAbc'.",
    type: "NOT_FOUND",
  });
  assert.equal(isExpectedError(e), false, "a request we built wrong must reach the reporter");
  assert.equal(
    e.message,
    "Could not resolve to a node with the global id of 'PRRT_kwDOAbc'.",
    "and the user reads GitHub's own sentence, unchanged",
  );
});

test("partial GraphQL data is kept only when keeping it cannot lie", () => {
  const notFound: GraphqlFailure[] = [{ message: "Could not resolve…", type: "NOT_FOUND", path: ["b"] }];

  assert.equal(
    keepsPartialData({ a: { projects: [] }, b: null }, notFound),
    true,
    "one object of several missing must not discard the ones that DID resolve",
  );
  assert.equal(
    keepsPartialData({ repository: null }, notFound),
    false,
    "nothing came back, so there is nothing to keep — that one still throws",
  );
  // The opposite mistake is worse than the one being fixed: a rate limit or a
  // denied scope makes the answer INCOMPLETE for a reason that is
  // indistinguishable from "empty" once it reaches a list. Those keep throwing.
  for (const type of ["RATE_LIMITED", "FORBIDDEN", undefined]) {
    assert.equal(
      keepsPartialData({ a: { projects: [] } }, [{ message: "no", type }]),
      false,
      `${type ?? "an untyped error"} must not be laundered into a short list`,
    );
  }
  assert.equal(
    keepsPartialData({ a: 1 }, [
      { message: "gone", type: "NOT_FOUND" },
      { message: "slow down", type: "RATE_LIMITED" },
    ]),
    false,
    "one unsafe error in the array is enough",
  );
  assert.equal(keepsPartialData(null, notFound), false);
  assert.equal(keepsPartialData({ a: 1 }, []), false, "no errors is not the partial path at all");
});

test("a NOT_FOUND on the object a query READS is not a partial answer", () => {
  // The trap in "something non-null came back": a single-root query keeps its
  // root when a NESTED object is missing. `repository{pullRequest(number:999)}`
  // answers `{ repository: { pullRequest: null } }`, and keeping that let the
  // review-thread read report "no threads" for a pull request that does not
  // exist — silently, where the client used to throw and report.
  assert.equal(
    keepsPartialData({ repository: { pullRequest: null } }, [
      { message: "Could not resolve to a PullRequest with the number of 999.", type: "NOT_FOUND", path: ["repository", "pullRequest"] },
    ]),
    false,
    "the pull request IS the answer; without it there is nothing partial to keep",
  );
  assert.equal(
    keepsPartialData({ repository: { projectsV2: { nodes: [{ id: "P_1" }, null] } } }, [
      { message: "Could not resolve…", type: "NOT_FOUND", path: ["repository", "projectsV2", "nodes", 1] },
    ]),
    true,
    "one element of a list is missing — its siblings are still the answer",
  );
  assert.equal(
    keepsPartialData({ a: { projects: [] } }, [{ message: "Could not resolve…", type: "NOT_FOUND" }]),
    false,
    "an error that does not say WHAT is missing cannot be proved partial",
  );
});
