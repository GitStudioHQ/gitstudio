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
import { getProjectBoard, listProjects } from "../src/main/github/projects";
import { resolveThread, reviewThreads } from "../src/main/github/prs";

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
        message: "Could not resolve to a Repository with the name 'contoso-internal/ledger-service'.",
      },
    ],
  });
  try {
    await assert.rejects(
      () => client.graphql("query{…}", {}),
      (e: unknown) => {
        assert.equal(isExpectedError(e), true, "must not reach the crash reporter");
        assert.match((e as Error).message, /contoso-internal\/ledger-service/);
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

test("a token without the Projects scope is a state of the account, not a crash", async () => {
  // GitHub's REAL answer (captured with a read-only `gh api graphql` against a
  // token that lacks `read:project`): a 200 with no `data`, and the type is
  // INSUFFICIENT_SCOPES — not FORBIDDEN, which is the only permission type the
  // classifier knew. So a pasted token without the scope (sign-in by token is
  // supported; the device flow asks for `project`) filed a crash report from
  // ipc:project:list — the channel #14/#17 came from — every time Projects
  // was opened.
  const { client, restore } = servingGraphql({
    errors: [
      {
        type: "INSUFFICIENT_SCOPES",
        locations: [{ line: 1, column: 75 }],
        message:
          "Your token has not been granted the required scopes to execute this query. The " +
          "'projectsV2' field requires one of the following scopes: ['read:project'], but your " +
          "token has only been granted the: ['admin:public_key', 'gist', 'read:org', 'repo'] " +
          "scopes. Please modify your token's scopes at: https://github.com/settings/tokens.",
      },
    ],
  });
  try {
    await assert.rejects(
      () => listProjects(client, "acme-private", "billing-pipeline"),
      (e: unknown) => {
        assert.equal(isExpectedError(e), true, "not crash-report material");
        assert.match((e as Error).message, /read:project/, "…and it still says which scope is missing");
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
      list.projects.map((p) => p.title),
      ["Roadmap", "Bugs"],
      "one unreadable entry must not take the readable ones down with it",
    );
    // …and the list must not pass itself off as complete. Without the count
    // the view had no way to say that a project was missing, so two projects
    // read as "this repository has two projects".
    assert.equal(list.unreadable, 1, "the view is told how many it could not read");
  } finally {
    restore();
  }
});

test("a pull request GitHub cannot resolve does not read as 'no review threads'", async () => {
  // The nested case the partial-data rule first got wrong. The query has one
  // root, the root resolves, and the object the query exists to read — the
  // pull request — does not. Keeping that "partial" answer handed reviewThreads
  // `pullRequest: null`, which it turns into `[]`: a confident empty list, and
  // no report, for a number the app sent that names nothing. The client used to
  // throw here, and must still.
  const { client, restore } = servingGraphql({
    data: { repository: { pullRequest: null } },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository", "pullRequest"],
        message: "Could not resolve to a PullRequest with the number of 999.",
      },
    ],
  });
  try {
    await assert.rejects(
      () => reviewThreads(client, "acme", "widgets", 999),
      (e: unknown) => {
        assert.equal(isExpectedError(e), false, "a number we sent that resolves to nothing is ours to hear about");
        assert.match((e as Error).message, /PullRequest with the number of 999/);
        return true;
      },
    );
  } finally {
    restore();
  }
});

test("a board with one card GitHub cannot resolve still shows the others", async () => {
  // The "some resolve, one does not" case, on the read that renders it: one
  // element of a list is missing and its siblings are still the answer.
  const card = (id: string, n: number, title: string) => ({
    id,
    type: "ISSUE",
    fieldValueByName: { optionId: "o1", name: "Todo" },
    content: { __typename: "Issue", number: n, title, url: `u${n}`, state: "OPEN", author: { login: "a" } },
  });
  const { client, restore } = servingGraphql({
    data: {
      node: {
        field: { id: "F1", name: "Status", options: [{ id: "o1", name: "Todo", color: "GRAY" }] },
        items: {
          nodes: [card("I1", 1, "Readable one"), { ...card("I2", 2, "x"), content: null }, card("I3", 3, "Readable two")],
        },
      },
    },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["node", "items", "nodes", 1, "content"],
        message: "Could not resolve to a Repository with the name 'acme/moved-away'.",
      },
    ],
  });
  try {
    const board = await getProjectBoard(client, "o", "r", "PVT_1");
    assert.deepEqual(
      board.items.map((i) => i.title),
      ["Readable one", "Readable two"],
    );
    assert.equal(board.unreadable, 1, "…and says a card is missing rather than hiding it");
  } finally {
    restore();
  }
});

test("a complete answer says nothing is missing", async () => {
  const { client, restore } = servingGraphql({
    data: {
      repository: {
        projectsV2: {
          nodes: [{ id: "P_1", number: 1, title: "Roadmap", url: "u1", closed: false, items: { totalCount: 3 } }],
        },
      },
    },
  });
  try {
    assert.equal((await listProjects(client, "o", "r")).unreadable, 0);
  } finally {
    restore();
  }
});

test("a pull request with one review thread GitHub cannot resolve keeps the others, and says so", async () => {
  // The third read that keeps partial data. Its mapper read `t.comments` off
  // every node, so a null thread — exactly what a kept NOT_FOUND on one list
  // element leaves — threw a TypeError out of the read: the whole panel failed
  // (and filed a report) over one thread, the failure keepsPartialData exists
  // to prevent.
  const thread = (id: string, line: number) => ({
    id,
    path: "src/a.ts",
    line,
    isResolved: false,
    isOutdated: false,
    comments: { nodes: [{ id: `${id}-c`, author: { login: "a" }, body: "hi", createdAt: "2026-01-01T00:00:00Z" }] },
  });
  const { client, restore } = servingGraphql({
    data: {
      repository: { pullRequest: { reviewThreads: { nodes: [thread("T1", 3), null, thread("T3", 9)] } } },
    },
    errors: [
      {
        type: "NOT_FOUND",
        path: ["repository", "pullRequest", "reviewThreads", "nodes", 1],
        message: "Could not resolve to a node with the global id of 'PRRT_x'.",
      },
    ],
  });
  try {
    const r = await reviewThreads(client, "acme", "widgets", 7);
    assert.deepEqual(
      r.threads.map((t) => t.id),
      ["T1", "T3"],
    );
    assert.equal(r.unreadable, 1);
  } finally {
    restore();
  }
});
