// A GraphQL 200 carrying an `errors` array is not a failed request.
//
// GitHub's GraphQL resolves every field it can and reports the rest in the same
// 200 body. The client threw on `errors[0]` regardless, which discarded
// everything that DID resolve — so one repository the account can no longer see
// took the whole answer down with it (crash reports #14 and #17, filed from
// ipc:project:list).
//
// These drive GitHubClient.graphql over a stubbed global fetch, because the
// distinction being fixed lives between the HTTP status and the body and cannot
// be seen from either one alone.

import { test } from "node:test";
import assert from "node:assert/strict";
import { GitHubClient } from "../src/main/githubClient";
import { isExpectedError } from "../src/main/expectedError";
import { listProjects } from "../src/main/github/projects";
import { resolveThread } from "../src/main/github/prs";

/** Answer the next fetch with this GraphQL body, at HTTP 200. */
function servingGraphql(body: unknown): { client: GitHubClient; restore: () => void } {
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  return {
    client: new GitHubClient(() => "ghp_test"),
    restore: () => {
      globalThis.fetch = real;
    },
  };
}

test("one unresolvable object does not discard the ones that resolved", async () => {
  const { client, restore } = servingGraphql({
    data: {
      mine: { projectsV2: { nodes: [{ id: "P_1", title: "Roadmap" }] } },
      gone: null,
    },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["gone"],
        message: "Could not resolve to a Repository with the name 'acme-private/billing-pipeline'.",
      },
    ],
  });
  try {
    const seen: string[] = [];
    const data = await client.graphql<{ mine?: { projectsV2?: { nodes?: { title: string }[] } } }>(
      "query{…}",
      {},
      { onPartial: (errors) => seen.push(...errors.map((e) => e.message)) },
    );
    assert.equal(data?.mine?.projectsV2?.nodes?.[0]?.title, "Roadmap", "the readable half survives");
    assert.equal(seen.length, 1, "and the caller is told what was missing");
    assert.match(seen[0], /billing-pipeline/);
  } finally {
    restore();
  }
});

test("when nothing resolved, it still throws — as an expected condition", async () => {
  // The shape reports #14/#17 actually carry: a repo-scoped query whose one root
  // field is null. There is no partial answer to keep, so the read fails — but
  // an unreachable repository is a state a user is allowed to be in, not a
  // defect, so it must not be crash-reported.
  const { client, restore } = servingGraphql({
    data: { repository: null },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository"],
        message: "Could not resolve to a Repository with the name 'contoso-internal/forms-package'.",
      },
    ],
  });
  try {
    await assert.rejects(
      () => client.graphql("query{…}", {}),
      (e: unknown) => {
        assert.equal(isExpectedError(e), true, "must not reach the crash reporter");
        assert.match((e as Error).message, /contoso-internal\/forms-package/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("a rate limit still fails loudly even with data beside it", async () => {
  // The trap in the other direction. GitHub returns partial data for a throttled
  // query too, and keeping it would present a truncated list as the whole truth
  // — the "confident empty state" failure, which is worse than an error.
  const { client, restore } = servingGraphql({
    data: { repository: { projectsV2: { nodes: [] } } },
    errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }],
  });
  try {
    await assert.rejects(
      () => client.graphql("query{…}", {}),
      (e: unknown) => {
        assert.equal(isExpectedError(e), true);
        assert.match((e as Error).message, /rate limit/i);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("a query we got wrong is still reported", async () => {
  // Nothing above may cost us the one GraphQL failure that IS our bug.
  const { client, restore } = servingGraphql({
    data: null,
    errors: [{ message: "Field 'nope' doesn't exist on type 'Repository'" }],
  });
  try {
    await assert.rejects(
      () => client.graphql("query{…}", {}),
      (e: unknown) => isExpectedError(e) === false,
    );
  } finally {
    restore();
  }
});

test("a mutation whose node id we built wrong is still reported", async () => {
  // Driven through a real mutation rather than through the classifier, because
  // that is where the id comes from: the renderer hands `threadId` to the
  // bridge, the bridge puts it in the payload, and if it is the wrong id GitHub
  // answers NOT_FOUND inside a 200. `errorFields` then decides whether the IPC
  // wrapper files a report — so this asserts the chain, not one branch of it.
  const { client, restore } = servingGraphql({
    data: { resolveReviewThread: null },
    errors: [
      { type: "NOT_FOUND", message: "Could not resolve to a node with the global id of 'PRRT_kwDOAbc'." },
    ],
  });
  try {
    const r = await resolveThread(client, "o", "r", { threadId: "PRRT_kwDOAbc", resolved: true });
    assert.equal(r.ok, false);
    assert.notEqual(r.expected, true, "a payload we built wrong must still reach the crash reporter");
    assert.match(r.message ?? "", /global id/);
  } finally {
    restore();
  }
});

test("a repository the remote no longer resolves to is NOT reported, from the same chain", async () => {
  // The #14/#17 half, proved on a real read rather than on graphqlError alone.
  const { client, restore } = servingGraphql({
    data: { repository: null },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository"],
        message: "Could not resolve to a Repository with the name 'Priv-Org/secret-thing'.",
      },
    ],
  });
  try {
    await assert.rejects(
      () => listProjects(client, "Priv-Org", "secret-thing"),
      (e: unknown) => {
        assert.equal(isExpectedError(e), true);
        assert.match((e as Error).message, /GitHub couldn't find Priv-Org\/secret-thing/);
        assert.doesNotMatch((e as Error).message, /resolve to a/i);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("a project list with one unreadable repository still renders the readable ones", async () => {
  // The partial answer has to survive the READ the renderer calls, not just the
  // client primitive: listProjects maps and filters after it.
  const { client, restore } = servingGraphql({
    data: {
      repository: {
        projectsV2: {
          nodes: [
            { id: "P_1", number: 1, title: "Roadmap", url: "u1", closed: false, items: { totalCount: 3 } },
            null,
            { id: "P_3", number: 3, title: "Bugs", url: "u3", closed: false, items: { totalCount: 1 } },
          ],
        },
      },
    },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository", "projectsV2", "nodes", 1],
        message: "Could not resolve to a Repository with the name 'Priv-Org/gone'.",
      },
    ],
  });
  try {
    const list = await listProjects(client, "o", "r");
    assert.deepEqual(
      list.map((p) => p.title),
      ["Roadmap", "Bugs"],
      "one unreadable entry must not take the readable ones down with it",
    );
  } finally {
    restore();
  }
});
