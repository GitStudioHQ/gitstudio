// A pull request's page — the corners test/prPage.test.ts leaves: every
// timeline event, a sparse (or garbled) answer read field by field, the
// check words of each state, the REST file statuses, and the three GraphQL
// mutations the page sends, with GitHub's refusals in its own words.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FILE_STATUS,
  PR_MUTATIONS,
  checkStateOf,
  MERGE_METHODS,
  checkWords,
  ciOfChecks,
  durationWords,
  defaultMergeTitle,
  fileStatusOf,
  fileTree,
  markReadyForReview,
  mergeBoxOf,
  mergeMethodsFor,
  parsePrPage,
  replyToThread,
  setThreadResolved,
  sortChecks,
  timelineEventWords,
  type PrDetail,
} from "../src/forge/prPage";
import { PrListError } from "../src/forge/prList";
import type { PrCheck, PrPageFile } from "@gitstudio/host-bridge/prProtocol";

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub's JSON */

/** The smallest answer GitHub could give: a repository with one pull request and little else. */
function sparse(pr: Record<string, any> = {}, repo: Record<string, any> = {}, viewer: any = null): { data: any } {
  return { data: { viewer, repository: { ...repo, pullRequest: { ...pr } } } };
}

// ── The answer, read field by field ──────────────────────────────────────────

test("a sparse answer reads as an empty open pull request with GitHub's defaults", () => {
  const d = parsePrPage("acme", "app", 9, sparse({ state: "OPEN" }));
  assert.equal(d.number, 9, "the number asked for when GitHub's is missing");
  assert.equal(d.url, "https://github.com/acme/app/pull/9");
  assert.equal(d.kind, "open");
  assert.equal(d.title, "");
  assert.equal(d.author, null);
  assert.equal(d.mergedAt, null);
  assert.equal(d.closedAt, null);
  assert.equal(d.headOwner, null);
  assert.equal(d.headRepo, null);
  assert.equal(d.mergeState, "UNKNOWN");
  assert.equal("reviewDecision" in d, false);
  assert.deepEqual([d.additions, d.deletions, d.changedFiles, d.commitCount], [0, 0, 0, 0]);
  assert.deepEqual([d.labels, d.assignees, d.reviewers, d.timeline, d.threads, d.commits, d.checks], [[], [], [], [], [], [], []]);
  assert.deepEqual(d.ci, { state: "none", total: 0, failed: 0, pending: 0 }, "no rollup and no checks is no CI at all");
  assert.equal(d.checksTotal, 0);
  // Every method is allowed unless GitHub says otherwise; no viewer, so no login.
  assert.deepEqual(d.repo, { id: "acme/app", mergeMethods: ["merge", "squash", "rebase"], deleteBranchOnMerge: false });
  assert.deepEqual(d.viewer, { permission: "READ", isAuthor: false, canUpdate: false, canUpdateBranch: false, canDeleteBranch: false });
});

test("the updated date falls back to the created date, and a non-numeric count to zero", () => {
  const d = parsePrPage("acme", "app", 9, sparse({ createdAt: "2026-01-01T00:00:00Z", additions: "lots", number: "12" }));
  assert.equal(d.updatedAt, "2026-01-01T00:00:00Z");
  assert.equal(d.additions, 0);
  assert.equal(d.number, 12);
  assert.equal(d.kind, "closed", "a state that isn't OPEN is closed");
});

test("the viewer's default merge method is kept only when the repository allows it", () => {
  const off = parsePrPage("acme", "app", 1, sparse({}, { rebaseMergeAllowed: false, viewerDefaultMergeMethod: "REBASE" }));
  assert.deepEqual(off.repo.mergeMethods, ["merge", "squash"]);
  assert.equal(off.repo.defaultMethod, undefined);
  const merge = parsePrPage("acme", "app", 1, sparse({}, { viewerDefaultMergeMethod: "MERGE", deleteBranchOnMerge: true, nameWithOwner: "Acme/App" }));
  assert.equal(merge.repo.defaultMethod, "merge");
  assert.equal(merge.repo.deleteBranchOnMerge, true);
  assert.equal(merge.repo.id, "Acme/App");
  const odd = parsePrPage("acme", "app", 1, sparse({}, { viewerDefaultMergeMethod: "FAST_FORWARD" }));
  assert.equal(odd.repo.defaultMethod, undefined);
});

test("labels, assignees and reviewers skip what isn't a name", () => {
  const d = parsePrPage(
    "acme",
    "app",
    1,
    sparse({
      author: { login: "Alice" },
      labels: { nodes: [null, { color: "ffffff" }, { name: "ok", color: null }] },
      assignees: { nodes: [null, { login: 5 }, { login: "bob", avatarUrl: 7 }] },
      latestReviews: {
        nodes: [
          null,
          { state: "APPROVED", author: null },
          { state: "COMMENTED", author: { login: "alice" } }, // the author, replying: no verdict
          { state: "APPROVED", author: { login: "ALICE", avatarUrl: "a.png" } }, // the author approving is kept
          { state: "WEIRD", author: { login: "carl" } }, // unknown verdict reads as a comment
        ],
      },
      reviewRequests: {
        nodes: [
          null,
          { requestedReviewer: null },
          { requestedReviewer: { __typename: "Team" } }, // a team without a slug and no login
          { requestedReviewer: { __typename: "Bot", login: "dependabot" } },
          { requestedReviewer: { __typename: "User", login: "Alice" } }, // asked again after answering
        ],
      },
    }),
  );
  assert.deepEqual(d.labels, [{ name: "ok", color: "888888" }]);
  assert.deepEqual(d.assignees, [{ login: "bob", avatarUrl: null }]);
  assert.deepEqual(d.reviewers, [
    { login: "Alice", avatarUrl: "a.png", verdict: "APPROVED", requested: true },
    { login: "carl", avatarUrl: null, verdict: "COMMENTED", requested: false },
    { login: "dependabot", avatarUrl: null, requested: true },
  ]);
});

test("every timeline event GitHub sends becomes a line, and a missing id is made from its type and time", () => {
  const at = "2026-09-25T10:00:00Z";
  const actor = { login: "alice", avatarUrl: null };
  const d = parsePrPage(
    "acme",
    "app",
    1,
    sparse({
      timelineItems: {
        totalCount: "9",
        nodes: [
          { __typename: "MergedEvent", id: "M", actor, createdAt: at, commit: { abbreviatedOid: "abc1234" } },
          { __typename: "MergedEvent", actor: null, createdAt: at, commit: null },
          { __typename: "ClosedEvent", id: "C", actor, createdAt: at },
          { __typename: "ReopenedEvent", id: "R", actor, createdAt: at },
          { __typename: "ReadyForReviewEvent", id: "RR", actor, createdAt: at },
          { __typename: "ConvertToDraftEvent", id: "D", actor, createdAt: at },
          { __typename: "HeadRefForcePushedEvent", id: "F", actor, createdAt: at, beforeCommit: null, afterCommit: { abbreviatedOid: "2" } },
          { __typename: "ReviewRequestedEvent", id: "Q", actor, createdAt: at, requestedReviewer: { __typename: "User", login: "dana" } },
          { __typename: "ReviewRequestedEvent", id: "Q2", actor, createdAt: at, requestedReviewer: null },
          { __typename: "ReviewDismissedEvent", id: "X", actor, createdAt: at },
          { __typename: "PullRequestReview", id: "PR", author: actor, state: "APPROVED", body: null, submittedAt: null, createdAt: "2026-09-25T09:00:00Z" },
        ],
      },
    }),
  );
  assert.deepEqual(
    d.timeline.map((t) => (t.kind === "event" ? [t.id, t.event, t.detail ?? null, t.actor?.login ?? null] : [t.id, t.kind])),
    [
      ["M", "merged", "abc1234", "alice"],
      [`MergedEvent-${at}`, "merged", null, null],
      ["C", "closed", null, "alice"],
      ["R", "reopened", null, "alice"],
      ["RR", "ready", null, "alice"],
      ["D", "draft", null, "alice"],
      ["F", "forcePushed", null, "alice"],
      ["Q", "reviewRequested", "dana", "alice"],
      ["Q2", "reviewRequested", null, "alice"],
      ["X", "reviewDismissed", null, "alice"],
      ["PR", "review"],
    ],
  );
  const review = d.timeline.at(-1)!;
  assert.equal(review.kind === "review" && review.createdAt, "2026-09-25T09:00:00Z", "an unsubmitted date falls back to when it was created");
  assert.equal(d.timelineTotal, 9);
});

test("threads and commits keep only what has an id, and fill in what GitHub left out", () => {
  const d = parsePrPage(
    "acme",
    "app",
    1,
    sparse({
      reviewThreads: {
        totalCount: 3,
        nodes: [
          null,
          { id: 42 },
          { id: "T", path: "a.ts", comments: { totalCount: null, nodes: [null, { id: 1 }, { id: "C", body: "hi" }] } },
          { id: "T2" },
        ],
      },
      commits: {
        totalCount: 3,
        nodes: [
          null,
          { commit: { oid: 5 } },
          { commit: { oid: "abcdef0123456789", author: { user: { login: "u" } }, statusCheckRollup: { state: "SUCCESS" } } },
          { commit: { oid: "fedcba9876543210", author: null } },
        ],
      },
    }),
  );
  assert.deepEqual(
    d.threads.map((t) => [t.id, t.path, t.line, t.startLine, t.originalLine, t.side, t.resolved, t.canReply, t.comments.map((c) => c.id), t.totalComments, t.reviewId ?? null]),
    [
      ["T", "a.ts", null, null, null, "RIGHT", false, false, ["C"], 1, null],
      ["T2", "", null, null, null, "RIGHT", false, false, [], 0, null],
    ],
  );
  assert.deepEqual(
    d.commits.map((c) => [c.shortSha, c.authorName, c.author?.login ?? null, c.ci, c.headline]),
    [
      ["abcdef0", "u", "u", "success", ""],
      ["fedcba9", "", null, "none", ""],
    ],
  );
});

test("a check suite without names falls back to Check and Status, and an odd context is dropped", () => {
  const d = parsePrPage(
    "acme",
    "app",
    1,
    sparse({
      checks: {
        nodes: [
          {
            commit: {
              statusCheckRollup: {
                state: "PENDING",
                contexts: {
                  totalCount: 1,
                  nodes: [
                    null,
                    { __typename: "SomethingNew" },
                    { __typename: "CheckRun", status: "QUEUED", completedAt: "2026-01-01T00:00:00Z", detailsUrl: "" },
                    { __typename: "StatusContext", state: "ERROR", targetUrl: "", description: "" },
                  ],
                },
              },
            },
          },
        ],
      },
    }),
  );
  assert.deepEqual(d.checks, [
    { name: "Status", state: "failure", raw: "ERROR", required: false },
    { name: "Check", state: "pending", raw: "QUEUED", required: false },
  ]);
  assert.equal(d.checksTotal, 2, "never fewer than it lists");
  assert.deepEqual(d.ci, { state: "pending", total: 2, failed: 1, pending: 1 }, "the state is GitHub's rollup; the counts are the checks'");
});

test("GitHub's refusals without a message still say what went wrong", () => {
  const kindOf = (res: any): string => {
    try {
      parsePrPage("acme", "app", 3, res);
    } catch (e) {
      assert.ok(e instanceof PrListError);
      return `${e.kind}: ${e.message}`;
    }
    return "no error";
  };
  assert.match(kindOf({ errors: [{ type: "RATE_LIMITED" }] }), /^rate-limit: GitHub's rate limit was reached/);
  assert.equal(kindOf({ errors: [{ type: "FORBIDDEN" }] }), "forbidden: GitHub refused to show acme/app.");
  assert.match(kindOf({ data: { repository: null } }), /^not-found: GitHub has no repository acme\/app/);
  assert.equal(kindOf({}), "query: GitHub couldn't answer the query.");
  assert.equal(kindOf({ data: {}, errors: [] }), "query: GitHub couldn't answer the query.");
});

// ── The vocabulary ───────────────────────────────────────────────────────────

test("a status's state and a run's conclusion each read as one of six words", () => {
  assert.equal(checkStateOf("StatusContext", "SUCCESS", undefined), "success");
  assert.equal(checkStateOf("StatusContext", "FAILURE", undefined), "failure");
  assert.equal(checkStateOf("StatusContext", "EXPECTED", undefined), "pending");
  assert.equal(checkStateOf("CheckRun", "IN_PROGRESS", "SUCCESS"), "pending", "not completed is pending, whatever the conclusion");
  for (const c of ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]) assert.equal(checkStateOf("CheckRun", "COMPLETED", c), "failure", c);
  assert.equal(checkStateOf("CheckRun", "COMPLETED", "CANCELLED"), "cancelled");
  assert.equal(checkStateOf("CheckRun", "COMPLETED", "SKIPPED"), "skipped");
  assert.equal(checkStateOf("CheckRun", "COMPLETED", "NEUTRAL"), "neutral");
  assert.equal(checkStateOf("CheckRun", "COMPLETED", "STALE"), "neutral");
});

test("checks sort failing first, then required, then by workflow or app and name", () => {
  const c = (name: string, state: PrCheck["state"], extra: Partial<PrCheck> = {}): PrCheck => ({ name, state, raw: "", required: false, ...extra });
  const sorted = sortChecks([
    c("z", "success"),
    c("b", "success", { app: "Beta" }),
    c("a", "success", { workflow: "Alpha" }),
    c("req", "success", { required: true }),
    c("run", "pending"),
    c("bad", "failure"),
  ]);
  assert.deepEqual(sorted.map((x) => x.name), ["bad", "run", "req", "z", "a", "b"]);
  assert.deepEqual(ciOfChecks(null, []), { state: "none", total: 0, failed: 0, pending: 0 });
  assert.equal(ciOfChecks("SUCCESS", []).state, "success", "a rollup with no contexts still says what GitHub said");
});

test("what a check says of itself, in every state it can be in", () => {
  const now = Date.parse("2026-09-26T10:10:00Z");
  const start = "2026-09-26T10:00:00Z";
  const end = "2026-09-26T10:02:05Z";
  const c = (state: PrCheck["state"], raw: string, extra: Partial<PrCheck> = {}): PrCheck => ({ name: "x", state, raw, required: false, ...extra });
  // A reported status in PENDING has been pending since it was created.
  assert.equal(checkWords(c("pending", "PENDING", { startedAt: start }), now), "Pending for 10m");
  assert.equal(checkWords(c("pending", "PENDING", { startedAt: "not a date" }), now), "Pending");
  // A run in PENDING has not started, however it is dated.
  assert.equal(checkWords(c("pending", "PENDING", { startedAt: start, app: "GitHub Actions" }), now), "Queued");
  assert.equal(checkWords(c("pending", "PENDING", { startedAt: start, workflow: "CI" }), now), "Queued");
  assert.equal(checkWords(c("pending", "QUEUED"), now), "Queued");
  assert.equal(checkWords(c("pending", "REQUESTED"), now), "Queued");
  assert.equal(checkWords(c("pending", "WAITING"), now), "Waiting");
  assert.equal(checkWords(c("pending", "EXPECTED"), now), "Expected — waiting for it to report");
  assert.equal(checkWords(c("pending", "IN_PROGRESS", { startedAt: start }), now), "Running for 10m");
  assert.equal(checkWords(c("pending", "IN_PROGRESS"), now), "Running");
  assert.equal(checkWords(c("neutral", "NEUTRAL", { startedAt: start, completedAt: end }), now), "Neutral, in 2m 5s");
  assert.equal(checkWords(c("neutral", "NEUTRAL"), now), "Neutral");
  assert.equal(checkWords(c("cancelled", "CANCELLED", { startedAt: start, completedAt: end }), now), "Cancelled after 2m 5s");
  assert.equal(checkWords(c("cancelled", "CANCELLED"), now), "Cancelled");
  assert.equal(checkWords(c("skipped", "SKIPPED", { startedAt: start, completedAt: end }), now), "Skipped");
  assert.equal(checkWords(c("success", "SUCCESS", { startedAt: end, completedAt: start }), now), "Passed", "an end before its start is no duration");
  assert.equal(checkWords(c("failure", "ACTION_REQUIRED"), now), "Needs action");
  assert.equal(checkWords(c("failure", "STARTUP_FAILURE"), now), "Failed to start");
  assert.equal(checkWords(c("failure", "ERROR", { startedAt: start, completedAt: end }), now), "Errored after 2m 5s");
  assert.equal(checkWords(c("failure", "FAILURE"), now), "Failed");
});

test("each timeline event says what happened, with or without its detail", () => {
  const words = (event: any, detail?: string) => timelineEventWords({ event, ...(detail ? { detail } : {}) }, "main");
  assert.deepEqual(words("merged"), { text: "merged this into main", codicon: "git-merge", tone: "merged" });
  assert.deepEqual(words("merged", "abc1234"), { text: "merged commit abc1234 into main", codicon: "git-merge", tone: "merged" });
  assert.deepEqual(words("closed"), { text: "closed this", codicon: "git-pull-request-closed", tone: "closed" });
  assert.deepEqual(words("reopened"), { text: "reopened this", codicon: "git-pull-request", tone: "open" });
  assert.equal(words("ready").text, "marked this ready for review");
  assert.deepEqual(words("draft"), { text: "marked this as a draft", codicon: "git-pull-request-draft", tone: "muted" });
  assert.equal(words("forcePushed", "1111111→2222222").text, "force-pushed the branch from 1111111 to 2222222");
  assert.equal(words("forcePushed").text, "force-pushed the branch");
  assert.equal(words("forcePushed", "only-one").text, "force-pushed the branch");
  assert.equal(words("reviewRequested", "core").text, "asked core for a review");
  assert.equal(words("reviewRequested").text, "asked for a review");
  assert.deepEqual(words("reviewDismissed"), { text: "dismissed a review", codicon: "circle-slash", tone: "muted" });
});

test("merge methods: the repository's default leads when nothing is preferred, and titles per method", () => {
  const pr = { repo: { id: "acme/app", mergeMethods: ["merge", "squash", "rebase"] as const, defaultMethod: "rebase" as const, deleteBranchOnMerge: false } } as unknown as Pick<PrDetail, "repo">;
  assert.deepEqual(mergeMethodsFor(pr), ["rebase", "merge", "squash"]);
  assert.deepEqual(mergeMethodsFor(pr, "squash"), ["squash", "merge", "rebase"]);
  const head = { number: 4, title: "T", headRef: "feat", headOwner: null, isFork: false };
  assert.equal(defaultMergeTitle(head, "merge", "acme"), "Merge pull request #4 from acme/feat", "the owner stands in for a missing head owner");
  assert.equal(defaultMergeTitle({ ...head, headOwner: "fork" }, "merge", "acme"), "Merge pull request #4 from fork/feat");
  assert.equal(defaultMergeTitle(head, "rebase", "acme"), "");
});

test("a draft's merge box offers Mark ready only to who may update it", () => {
  const base = { kind: "open", mergeState: "DRAFT", ci: { state: "none", total: 0, failed: 0, pending: 0 }, baseRef: "main", repo: { id: "acme/app", mergeMethods: ["merge"], deleteBranchOnMerge: false } };
  const reader = mergeBoxOf({ ...base, viewer: { permission: "READ", isAuthor: false, canUpdate: false, canUpdateBranch: false, canDeleteBranch: false } } as any)!;
  assert.equal(reader.fix, undefined);
  assert.match(reader.detail, /Its author marks it ready/);
  const blocked = mergeBoxOf({ ...base, mergeState: "BLOCKED", reviewDecision: "REVIEW_REQUIRED", ci: { state: "pending", total: 1, failed: 0, pending: 1 }, viewer: { permission: "WRITE", isAuthor: false, canUpdate: true, canUpdateBranch: false, canDeleteBranch: false } } as any)!;
  assert.equal(blocked.detail, "It needs an approving review, and required checks haven't finished.");
  const behindReader = mergeBoxOf({ ...base, mergeState: "BEHIND", viewer: { permission: "READ", isAuthor: false, canUpdate: false, canUpdateBranch: true, canDeleteBranch: false } } as any)!;
  assert.equal(behindReader.fix, "updateBranch", "a reader who may update the branch keeps that fix");
  assert.equal(behindReader.canMerge, false);
  assert.match(behindReader.detail, /Only people with write access to acme\/app can merge it\.$/);
});

test("each merge method says what it does to one commit, and to several", () => {
  assert.equal(MERGE_METHODS.merge.what(1, "main"), "The commit is added to main, joined by a merge commit.");
  assert.equal(MERGE_METHODS.merge.what(3, "main"), "All 3 commits are added to main, joined by a merge commit.");
  assert.equal(MERGE_METHODS.rebase.what(1, "main"), "The commit is replayed onto main one by one, with no merge commit.");
  assert.equal(MERGE_METHODS.rebase.what(2, "main"), "The 2 commits are replayed onto main one by one, with no merge commit.");
  assert.equal(MERGE_METHODS.squash.what(1, "dev"), "The commit is added to dev as one new commit.");
});

test("durations: whole hours drop their minutes, and a negative span is zero", () => {
  assert.equal(durationWords(2 * 3600_000), "2h");
  assert.equal(durationWords(2 * 3600_000 + 5 * 60_000), "2h 5m");
  assert.equal(durationWords(-5000), "0s");
});

test("a closed pull request keeps when it was closed", () => {
  const d = parsePrPage("acme", "app", 2, sparse({ state: "CLOSED", closedAt: "2026-09-27T00:00:00Z" }));
  assert.equal(d.kind, "closed");
  assert.equal(d.closedAt, "2026-09-27T00:00:00Z");
});

// ── The files ────────────────────────────────────────────────────────────────

test("REST's file statuses map to the page's, anything new reads as changed", () => {
  for (const s of ["added", "removed", "modified", "renamed", "copied", "unchanged"] as const) {
    assert.equal(fileStatusOf(s), s);
    assert.ok(FILE_STATUS[s].letter.length === 1);
  }
  assert.equal(fileStatusOf("changed"), "changed");
  assert.equal(fileStatusOf("type-changed"), "changed");
  assert.equal(FILE_STATUS[fileStatusOf("whatever")].word, "Changed");
});

test("the file tree compacts a folder chain but not a folder that also holds files", () => {
  const f = (path: string): PrPageFile => ({ path, status: "modified", additions: 1, deletions: 0 }) as unknown as PrPageFile;
  const tree = fileTree([f("a/b/c/deep.ts"), f("a/top.ts"), f("/lead/x.ts")]);
  const shape = (nodes: ReturnType<typeof fileTree>): unknown =>
    nodes.map((n) => (n.kind === "dir" ? { [n.path]: shape(n.children) } : n.name));
  assert.deepEqual(shape(tree), [{ a: [{ "a/b/c": ["deep.ts"] }, "top.ts"] }, { lead: ["x.ts"] }]);
  const [a] = tree;
  assert.ok(a.kind === "dir");
  const [bc] = a.children;
  assert.ok(bc.kind === "dir" && bc.name === "b/c");
});

// ── The mutations ────────────────────────────────────────────────────────────

type Call = { q: string; v: Record<string, unknown> };
function gqlReturning(res: any): { fn: (q: string, v: Record<string, unknown>) => Promise<any>; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fn: async (q, v) => {
      calls.push({ q, v });
      return typeof res === "function" ? res(q, v) : res;
    },
  };
}

test("marking ready sends one mutation for the pull request's id", async () => {
  const g = gqlReturning({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } });
  await markReadyForReview(g.fn as any, "PR_1");
  assert.deepEqual(g.calls, [{ q: PR_MUTATIONS.markReady, v: { id: "PR_1" } }]);
});

test("marking ready before the page loaded asks nothing", async () => {
  const g = gqlReturning({});
  await assert.rejects(markReadyForReview(g.fn as any, ""), (e: any) => e instanceof PrListError && e.kind === "query" && /isn't loaded yet/.test(e.message));
  assert.equal(g.calls.length, 0);
});

test("a refused mutation says why, in GitHub's words or the page's", async () => {
  const cases: [any, string, RegExp][] = [
    [{ errors: [{ type: "RATE_LIMITED" }] }, "rate-limit", /rate limit was reached/],
    [{ errors: [{ type: "RATE_LIMITED", message: "slow down" }] }, "rate-limit", /^slow down$/],
    [{ errors: [{ type: "FORBIDDEN" }] }, "forbidden", /^GitHub refused to mark it ready for review\.$/],
    [{ errors: [{ type: "FORBIDDEN", message: "Nope" }] }, "forbidden", /^Nope$/],
    [{ errors: [{ type: "NOT_FOUND" }] }, "not-found", /^GitHub couldn't find what to mark it ready for review\.$/],
    [{ errors: [{ type: "NOT_FOUND", message: "Gone" }] }, "not-found", /^Gone$/],
    [{ errors: [{ message: "Something else" }] }, "query", /^Something else$/],
    [{ data: { markPullRequestReadyForReview: null } }, "query", /^GitHub couldn't mark it ready for review\.$/],
  ];
  for (const [res, kind, message] of cases) {
    await assert.rejects(markReadyForReview(gqlReturning(res).fn as any, "PR_1"), (e: any) => e instanceof PrListError && e.kind === kind && message.test(e.message), JSON.stringify(res));
  }
});

test("a mutation that answered alongside a non-fatal error is taken as done", async () => {
  const g = gqlReturning({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } }, errors: [{ type: "SOMETHING", message: "partial" }] });
  await markReadyForReview(g.fn as any, "PR_1");
  assert.equal(g.calls.length, 1);
});

test("a reply comes back as GitHub stored it", async () => {
  const g = gqlReturning({
    data: {
      addPullRequestReviewThreadReply: {
        comment: { id: "C_9", url: "https://github.com/acme/app/pull/1#discussion_r9", createdAt: "2026-09-26T10:00:00Z", body: "Stored body", author: { login: "sam", avatarUrl: "s.png" } },
      },
    },
  });
  const c = await replyToThread(g.fn as any, "T_1", "Typed body");
  assert.deepEqual(g.calls, [{ q: PR_MUTATIONS.reply, v: { thread: "T_1", body: "Typed body" } }]);
  assert.deepEqual(c, { id: "C_9", url: "https://github.com/acme/app/pull/1#discussion_r9", createdAt: "2026-09-26T10:00:00Z", body: "Stored body", author: { login: "sam", avatarUrl: "s.png" } });
});

test("a reply GitHub answered sparsely keeps what was typed and is dated now", async () => {
  const before = Date.now();
  const c = await replyToThread(gqlReturning({ data: { addPullRequestReviewThreadReply: { comment: null } } }).fn as any, "T_1", "Typed");
  assert.equal(c.body, "Typed");
  assert.equal(c.id, "");
  assert.equal(c.author, null);
  assert.ok(Date.parse(c.createdAt) >= before - 1000);
  await assert.rejects(replyToThread(gqlReturning({ errors: [{ type: "FORBIDDEN" }] }).fn as any, "T_1", "x"), /GitHub refused to post the reply\./);
});

test("resolving and unresolving a conversation send their own mutation and report who resolved it", async () => {
  const r = gqlReturning({ data: { resolveReviewThread: { thread: { id: "T", isResolved: true, resolvedBy: { login: "sam" } } } } });
  assert.deepEqual(await setThreadResolved(r.fn as any, "T", true), { resolved: true, resolvedBy: "sam" });
  assert.deepEqual(r.calls, [{ q: PR_MUTATIONS.resolve, v: { thread: "T" } }]);

  const u = gqlReturning({ data: { unresolveReviewThread: { thread: { id: "T", isResolved: false } } } });
  assert.deepEqual(await setThreadResolved(u.fn as any, "T", false), { resolved: false });
  assert.deepEqual(u.calls, [{ q: PR_MUTATIONS.unresolve, v: { thread: "T" } }]);

  await assert.rejects(setThreadResolved(gqlReturning({ errors: [{ type: "NOT_FOUND" }] }).fn as any, "T", false), /couldn't find what to unresolve the conversation/);
  await assert.rejects(setThreadResolved(gqlReturning({}).fn as any, "T", true), (e: any) => e.kind === "query" && /couldn't resolve the conversation/.test(e.message));
});
