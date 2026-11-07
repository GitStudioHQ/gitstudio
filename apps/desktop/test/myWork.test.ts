// My Work's four searches and what it says when none of them answers.
//
// Crash reports "ipc:github:myWork" — "GitHub didn't answer any of the work
// searches." — came from people whose four searches each failed with an
// ExpectedError (offline, a proxy, an expired token, the search rate limiter).
// Each bucket swallowed its own, and the total failure was thrown as a fresh
// plain Error: a network state, laundered into a crash.

import { test } from "node:test";
import assert from "node:assert/strict";
import { myWork } from "../src/main/github/myWork";
import { ExpectedError, isExpectedError } from "../src/main/expectedError";
import type { GitHubClient } from "../src/main/githubClient";

/** A client whose search answers per query — `answer` throws to fail one. */
function client(answer: (q: string) => unknown): GitHubClient & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async request(_method: string, path: string) {
      const q = new URLSearchParams(path.slice(path.indexOf("?") + 1)).get("q") ?? "";
      queries.push(q);
      return answer(q);
    },
  } as unknown as GitHubClient & { queries: string[] };
}

const offline = (): never => {
  throw new ExpectedError("Couldn't reach GitHub (ERR_CONNECTION_RESET) — api.github.com/search/issues. Check your network or proxy settings.");
};

test("every search failing for a network reason is a state, in the network's words", async () => {
  await assert.rejects(myWork(client(offline), undefined, undefined), (e: Error) => {
    assert.equal(isExpectedError(e), true, "must not be crash-reported");
    assert.match(e.message, /Couldn't reach GitHub \(ERR_CONNECTION_RESET\)/, "says why, not just that it failed");
    assert.equal(e.toString(), `Error: ${e.message}`, "indistinguishable on the wire");
    return true;
  });
});

test("every search failing is still reported when one of them is OUR defect", async () => {
  // A query GitHub refuses is exactly what a report should tell us about —
  // and the report should name it, not the generic sentence.
  const c = client((q) => {
    if (q.includes("assignee:@me")) throw new Error("Search q invalid");
    return offline();
  });
  await assert.rejects(myWork(c, "acme", "widgets"), (e: Error) => {
    assert.equal(isExpectedError(e), false);
    assert.equal(e.message, "Search q invalid");
    return true;
  });
});

test("some searches failing still answers with what the others found", async () => {
  const c = client((q) => {
    if (!q.includes("review-requested:@me")) return offline();
    return {
      items: [
        {
          number: 7,
          title: "Add a thing",
          state: "open",
          pull_request: {},
          updated_at: "2026-01-01T00:00:00Z",
          repository_url: "https://api.github.com/repos/acme/widgets",
        },
      ],
    };
  });
  const items = await myWork(c, undefined, undefined);
  assert.deepEqual(
    items.map((i) => [i.kind, i.type, i.number]),
    [["review-requested", "pr", 7]],
  );
  assert.equal(c.queries.length, 4);
});
