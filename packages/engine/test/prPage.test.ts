// A pull request's page — its question, its answer and its rules
// (src/forge/prPage.ts). The rules are a state table: what the header offers
// and what the merge box says, cell by cell — kind × permission × who may
// update it × merge state × reviews × checks — each asserted by what the
// page would say and offer, not by how it is drawn. The extension's page is
// driven end to end in apps/extension/test/prPage*.test.ts.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CHECK_STATES,
  MERGE_METHODS,
  PR_PAGE_QUERY,
  REVIEW_STATE_WORDS,
  checkStateOf,
  checkWords,
  ciOfChecks,
  defaultMergeTitle,
  durationWords,
  fetchPrPage,
  fileTree,
  mergeBoxOf,
  mergeMethodsFor,
  parsePrPage,
  PR_PAGE_ACTION_WORDS,
  prPageActions,
  reviewVerdictsFor,
  sortChecks,
  timelineEventWords,
  type MergeBox,
  type PrDetail,
} from "../src/forge/prPage";
import type { PrCheck, PrKind, PrMergeState, PrPermission } from "@gitstudio/host-bridge/prProtocol";

/* eslint-disable @typescript-eslint/no-explicit-any -- GitHub's JSON */

/** A GraphQL answer for the page, in the shape GitHub gave it (checked live against microsoft/vscode). */
function answer(over: { repo?: Record<string, any>; pr?: Record<string, any>; viewer?: any } = {}): { data: any } {
  return {
    data: {
      viewer: over.viewer ?? { login: "sam", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4" },
      repository: {
        nameWithOwner: "acme/app",
        viewerPermission: "WRITE",
        mergeCommitAllowed: false,
        squashMergeAllowed: true,
        rebaseMergeAllowed: true,
        deleteBranchOnMerge: false,
        viewerDefaultMergeMethod: "SQUASH",
        ...over.repo,
        pullRequest: {
          id: "PR_1",
          number: 37,
          title: "Drop Commit",
          body: "## Why\n\nBecause.",
          url: "https://github.com/acme/app/pull/37",
          state: "OPEN",
          isDraft: false,
          mergedAt: null,
          closedAt: null,
          createdAt: "2026-09-20T10:00:00Z",
          updatedAt: "2026-09-26T10:00:00Z",
          author: { login: "alice", avatarUrl: null },
          mergedBy: null,
          headRefName: "feature/drop",
          headRefOid: "a".repeat(40),
          baseRefName: "main",
          baseRefOid: "b".repeat(40),
          isCrossRepository: false,
          maintainerCanModify: false,
          headRepositoryOwner: { login: "acme" },
          headRepository: { nameWithOwner: "acme/app", url: "https://github.com/acme/app" },
          additions: 120,
          deletions: 14,
          changedFiles: 3,
          mergeStateStatus: "BLOCKED",
          reviewDecision: "CHANGES_REQUESTED",
          viewerDidAuthor: false,
          viewerCanUpdate: true,
          viewerCanUpdateBranch: true,
          viewerCanDeleteHeadRef: true,
          labels: { nodes: [{ name: "bug", color: "d73a4a" }, { name: "odd", color: "not-hex" }] },
          assignees: { nodes: [{ login: "bob", avatarUrl: null }] },
          reviewRequests: {
            nodes: [
              { requestedReviewer: { __typename: "Team", slug: "core" } },
              { requestedReviewer: { __typename: "User", login: "dana", avatarUrl: null } },
              { requestedReviewer: { __typename: "User", login: "eli", avatarUrl: null } },
            ],
          },
          latestReviews: {
            nodes: [
              { state: "CHANGES_REQUESTED", author: { login: "dana", avatarUrl: null } },
              { state: "APPROVED", author: { login: "bob", avatarUrl: null } },
              { state: "COMMENTED", author: { login: "alice", avatarUrl: null } },
              { state: "PENDING", author: { login: "sam", avatarUrl: null } },
            ],
          },
          commits: {
            totalCount: 2,
            nodes: [
              { commit: { oid: "c1".padEnd(40, "0"), abbreviatedOid: "c100000", messageHeadline: "First", messageBody: "", committedDate: "2026-09-20T10:00:00Z", author: { name: "Alice", user: { login: "alice", avatarUrl: null } }, statusCheckRollup: { state: "FAILURE" } } },
              { commit: { oid: "c2".padEnd(40, "0"), abbreviatedOid: "c200000", messageHeadline: "Second", messageBody: "Body", committedDate: "2026-09-21T10:00:00Z", author: { name: "Nobody", user: null }, statusCheckRollup: null } },
            ],
          },
          checks: {
            nodes: [
              {
                commit: {
                  oid: "a".repeat(40),
                  statusCheckRollup: {
                    state: "FAILURE",
                    contexts: {
                      totalCount: 4,
                      nodes: [
                        { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-26T10:00:00Z", completedAt: "2026-09-26T10:06:18Z", detailsUrl: "https://github.com/acme/app/actions/runs/1/job/2", isRequired: false, checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } } },
                        { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "TIMED_OUT", startedAt: "2026-09-26T10:00:00Z", completedAt: "2026-09-26T10:30:00Z", detailsUrl: "https://github.com/acme/app/actions/runs/1/job/3", isRequired: true, checkSuite: { app: { name: "GitHub Actions" }, workflowRun: { workflow: { name: "CI" } } } },
                        { __typename: "CheckRun", name: "build", status: "IN_PROGRESS", conclusion: null, startedAt: "2026-09-26T10:00:00Z", completedAt: null, detailsUrl: null, isRequired: true, checkSuite: { app: { name: "GitHub Actions" }, workflowRun: null } },
                        { __typename: "StatusContext", context: "ci/legacy", state: "SUCCESS", description: "All good", targetUrl: "https://ci.example.com/1", createdAt: "2026-09-26T10:01:00Z", isRequired: false },
                      ],
                    },
                  },
                },
              },
            ],
          },
          timelineItems: {
            totalCount: 6,
            nodes: [
              { __typename: "IssueComment", id: "IC_1", author: { login: "bob", avatarUrl: null }, body: "Looks good", createdAt: "2026-09-21T10:00:00Z", url: "u1" },
              { __typename: "PullRequestReview", id: "PRR_1", author: { login: "dana", avatarUrl: null }, state: "CHANGES_REQUESTED", body: "", submittedAt: "2026-09-22T10:00:00Z", createdAt: "2026-09-22T09:00:00Z", url: "u2" },
              { __typename: "PullRequestReview", id: "PRR_2", author: { login: "sam", avatarUrl: null }, state: "PENDING", body: "", submittedAt: null, createdAt: "2026-09-23T09:00:00Z", url: "u3" },
              { __typename: "HeadRefForcePushedEvent", id: "E_1", actor: { login: "alice", avatarUrl: null }, createdAt: "2026-09-24T10:00:00Z", beforeCommit: { abbreviatedOid: "1111111" }, afterCommit: { abbreviatedOid: "2222222" } },
              { __typename: "ReviewRequestedEvent", id: "E_2", actor: { login: "alice", avatarUrl: null }, createdAt: "2026-09-24T11:00:00Z", requestedReviewer: { __typename: "Team", slug: "core" } },
              { __typename: "LabeledEvent", id: "E_3", createdAt: "2026-09-24T12:00:00Z" },
              null,
            ],
          },
          reviewThreads: {
            totalCount: 2,
            nodes: [
              { id: "T_1", path: "src/a.ts", line: 12, startLine: 10, originalLine: 12, diffSide: "RIGHT", isResolved: false, isOutdated: false, viewerCanResolve: true, viewerCanUnresolve: false, viewerCanReply: true, resolvedBy: null, comments: { totalCount: 2, nodes: [{ id: "C_1", author: { login: "dana", avatarUrl: null }, body: "Why?", createdAt: "2026-09-22T10:00:00Z", url: "c1", pullRequestReview: { id: "PRR_1" } }, { id: "C_2", author: { login: "alice", avatarUrl: null }, body: "Because.", createdAt: "2026-09-22T11:00:00Z", url: "c2", pullRequestReview: { id: "PRR_9" } }] } },
              { id: "T_2", path: "docs/gone.md", line: null, startLine: null, originalLine: 3, diffSide: "LEFT", isResolved: true, isOutdated: true, viewerCanResolve: false, viewerCanUnresolve: true, viewerCanReply: true, resolvedBy: { login: "alice" }, comments: { totalCount: 60, nodes: [{ id: "C_3", author: null, body: "Gone?", createdAt: "2026-09-22T10:00:00Z", url: "c3", pullRequestReview: null }] } },
            ],
          },
          ...over.pr,
        },
      },
    },
  };
}

function detail(over: Parameters<typeof answer>[0] = {}): PrDetail {
  return parsePrPage("acme", "app", 37, answer(over));
}

test("the question asks for what the page shows, in one request — and nothing is asked for a name that isn't one", async () => {
  for (const field of [
    "viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed deleteBranchOnMerge viewerDefaultMergeMethod",
    "mergeStateStatus reviewDecision",
    "viewerDidAuthor viewerCanUpdate viewerCanUpdateBranch viewerCanDeleteHeadRef",
    "isRequired(pullRequestNumber: $n)",
    "latestReviews(first: 30)",
    "reviewThreads(first: 100)",
    "pullRequestReview { id }",
    "timelineItems(last: 100",
  ]) {
    assert.ok(PR_PAGE_QUERY.includes(field), field);
  }
  let asked = 0;
  const gql = async () => {
    asked++;
    return answer();
  };
  await assert.rejects(fetchPrPage(gql, "acme", "app --upload-pack=x", 1), /isn't a GitHub repository name/);
  await assert.rejects(fetchPrPage(gql, "acme", "app", 0), /isn't a pull request number/);
  assert.equal(asked, 0);
  const d = await fetchPrPage(async (q, v) => {
    asked++;
    assert.equal(q, PR_PAGE_QUERY);
    assert.deepEqual(v, { owner: "acme", name: "app", n: 37 });
    return answer();
  }, "acme", "app", 37);
  assert.equal(asked, 1);
  assert.equal(d.title, "Drop Commit");
});

test("the answer: header, reviewers with their verdicts, and what the viewer may do", () => {
  const d = detail();
  assert.equal(d.kind, "open");
  assert.equal(d.mergeState, "BLOCKED");
  assert.equal(d.reviewDecision, "CHANGES_REQUESTED");
  assert.deepEqual(d.labels, [{ name: "bug", color: "d73a4a" }, { name: "odd", color: "888888" }], "a colour that isn't hex is grey");
  assert.deepEqual(d.repo, { id: "acme/app", mergeMethods: ["squash", "rebase"], defaultMethod: "squash", deleteBranchOnMerge: false });
  assert.deepEqual(d.viewer, { login: "sam", avatarUrl: "https://avatars.githubusercontent.com/u/1?v=4", permission: "WRITE", isAuthor: false, canUpdate: true, canUpdateBranch: true, canDeleteBranch: true });
  // Everyone asked AND everyone who answered: REST's requested_reviewers
  // drops a reviewer the moment they answer — an approver vanished.
  assert.deepEqual(
    d.reviewers.map((r) => [r.login ?? `team:${r.team}`, r.verdict ?? "-", r.requested]),
    [
      ["dana", "CHANGES_REQUESTED", true],
      ["bob", "APPROVED", false],
      ["team:core", "-", true],
      ["eli", "-", true],
    ],
    "the author's own replies and the viewer's pending review are not verdicts",
  );
  assert.equal(parsePrPage("acme", "app", 37, answer({ repo: { viewerPermission: "SOMETHING_NEW" } })).viewer.permission, "READ", "an unknown role reads as the least");
  assert.equal(parsePrPage("acme", "app", 37, answer({ pr: { mergeStateStatus: "NEW_STATE" } })).mergeState, "UNKNOWN");
  assert.equal(parsePrPage("acme", "app", 37, answer({ pr: { state: "MERGED", mergedAt: "2026-09-26T00:00:00Z" } })).kind, "merged");
  assert.equal(parsePrPage("acme", "app", 37, answer({ pr: { state: "CLOSED" } })).kind, "closed");
  assert.equal(parsePrPage("acme", "app", 37, answer({ pr: { isDraft: true } })).kind, "draft");
});

test("the answer: the timeline in order, the review threads with their review, commits, and checks — failing first", () => {
  const d = detail();
  assert.deepEqual(
    d.timeline.map((t) => (t.kind === "event" ? `${t.event}:${t.detail ?? ""}` : t.kind === "review" ? `review:${t.state}` : `comment:${t.body}`)),
    ["comment:Looks good", "review:CHANGES_REQUESTED", "forcePushed:1111111→2222222", "reviewRequested:core"],
    "a review in progress on github.com, an event the page doesn't draw and a null are left out",
  );
  const review = d.timeline[1];
  assert.equal(review.kind === "review" && review.createdAt, "2026-09-22T10:00:00Z", "a review is dated when it was submitted");
  assert.equal(d.timelineTotal, 6);
  const [t1, t2] = d.threads;
  assert.deepEqual([t1.path, t1.line, t1.startLine, t1.side, t1.resolved, t1.outdated, t1.reviewId, t1.canResolve], ["src/a.ts", 12, 10, "RIGHT", false, false, "PRR_1", true]);
  assert.deepEqual([t2.line, t2.originalLine, t2.side, t2.resolved, t2.outdated, t2.resolvedBy, t2.canUnresolve, t2.totalComments], [null, 3, "LEFT", true, true, "alice", true, 60]);
  assert.equal(t2.comments[0].author, null, "a deleted account");
  assert.deepEqual(d.commits.map((c) => [c.shortSha, c.headline, c.author?.login ?? c.authorName, c.ci]), [
    ["c100000", "First", "alice", "failure"],
    ["c200000", "Second", "Nobody", "none"],
  ]);
  assert.equal(d.commitCount, 2);
  assert.deepEqual(
    d.checks.map((c) => [c.workflow ?? c.app ?? "", c.name, c.state, c.required]),
    [
      ["CI", "test", "failure", true],
      ["GitHub Actions", "build", "pending", true],
      ["", "ci/legacy", "success", false],
      ["CI", "lint", "success", false],
    ],
  );
  assert.deepEqual(d.ci, { state: "failure", total: 4, failed: 1, pending: 1 });
  assert.equal(d.checksTotal, 4);
});

test("the answer: GitHub's failures say what went wrong", () => {
  assert.throws(() => parsePrPage("acme", "app", 37, { data: { repository: null }, errors: [{ type: "NOT_FOUND", message: "x" }] }), (e: any) => e.kind === "not-found" && /no repository acme\/app/.test(e.message));
  assert.throws(() => parsePrPage("acme", "app", 37, { data: { viewer: {}, repository: { pullRequest: null } } }), (e: any) => e.kind === "not-found" && /no pull request #37/.test(e.message));
  assert.throws(() => parsePrPage("acme", "app", 37, { errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] }), (e: any) => e.kind === "rate-limit");
  assert.throws(() => parsePrPage("acme", "app", 37, { errors: [{ type: "FORBIDDEN", message: "Resource protected by organization SAML enforcement." }] }), (e: any) => e.kind === "forbidden" && /SAML/.test(e.message));
  assert.throws(() => parsePrPage("acme", "app", 37, { errors: [{ message: "Something odd" }] }), (e: any) => e.kind === "query" && /Something odd/.test(e.message));
});

// ── The header's actions: the state table ─────────────────────────────────────

const KINDS: PrKind[] = ["open", "draft", "closed", "merged"];
const ROLES: PrPermission[] = ["ADMIN", "WRITE", "TRIAGE", "READ"];

test("the header offers, per state, only what can apply — every cell of kind × role × may-update × may-update-branch × author × merge methods", () => {
  // The table, as the owner reads it — the desktop's set, in the desktop's
  // words: one primary action per state, never Merge on a draft or for a
  // reader, never Approve on your own, never Review or Close once it is done.
  const expected = (kind: PrKind, role: PrPermission, canUpdate: boolean, canUpdateBranch: boolean, isAuthor: boolean, methods: number) => {
    const writer = role === "ADMIN" || role === "WRITE";
    const primary =
      kind === "open" && writer && methods > 0 ? "merge" : kind === "draft" && canUpdate ? "markReady" : kind === "closed" && canUpdate ? "reopen" : undefined;
    const open = kind === "open" || kind === "draft";
    return {
      ...(primary ? { primary } : {}),
      buttons: open ? ["checkout", ...(isAuthor ? [] : ["approve"]), "review"] : ["checkout"],
      more: [...(open && canUpdateBranch ? ["updateBranch"] : []), ...(open && canUpdate ? ["close"] : []), "copyLink"],
    };
  };
  let cells = 0;
  for (const kind of KINDS) {
    for (const role of ROLES) {
      for (const canUpdate of [true, false]) {
        for (const canUpdateBranch of [true, false]) {
          for (const isAuthor of [false, true]) {
            for (const methods of [3, 0]) {
              const pr = {
                kind,
                viewer: { permission: role, isAuthor, canUpdate, canUpdateBranch, canDeleteBranch: false },
                repo: { id: "acme/app", mergeMethods: methods ? (["merge", "squash", "rebase"] as const).slice() : [], deleteBranchOnMerge: false },
              };
              const cell = `${kind} × ${role} × canUpdate=${canUpdate} × canUpdateBranch=${canUpdateBranch} × author=${isAuthor} × methods=${methods}`;
              assert.deepEqual(prPageActions(pr as never), expected(kind, role, canUpdate, canUpdateBranch, isAuthor, methods), cell);
              cells++;
            }
          }
        }
      }
    }
  }
  assert.equal(cells, 256);
  // The words are the desktop's: one vocabulary.
  assert.deepEqual(
    Object.fromEntries(Object.entries(PR_PAGE_ACTION_WORDS).map(([k, w]) => [k, `${w.label} (${w.icon})`])),
    {
      merge: "Merge (git-merge)",
      markReady: "Mark ready (eye)",
      reopen: "Reopen pull request (git-pull-request)",
      close: "Close pull request (git-pull-request-closed)",
      checkout: "Checkout (git-branch)",
      approve: "Approve (check)",
      review: "Review (comment)",
      updateBranch: "Update branch (git-merge)",
      copyLink: "Copy link (copy)",
      openOnGitHub: "Open on GitHub (link-external)",
      refresh: "Refresh (refresh)",
    },
  );
  // MAINTAIN is a writer too.
  assert.equal(prPageActions({ kind: "open", viewer: { permission: "MAINTAIN", canUpdate: false }, repo: { mergeMethods: ["squash"] } } as never).primary, "merge");
});

// ── The merge box: the state table ────────────────────────────────────────────

const STATES: PrMergeState[] = ["CLEAN", "HAS_HOOKS", "UNSTABLE", "BEHIND", "BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"];

function box(mergeState: PrMergeState, over: Record<string, any> = {}): MergeBox | undefined {
  return mergeBoxOf({
    kind: "open",
    mergeState,
    ci: { state: "success", total: 3, failed: 0, pending: 0 },
    baseRef: "main",
    viewer: { permission: "WRITE", isAuthor: false, canUpdate: true, canUpdateBranch: true, canDeleteBranch: true },
    repo: { id: "acme/app", mergeMethods: ["merge", "squash", "rebase"], deleteBranchOnMerge: false },
    ...over,
  } as never);
}

test("the merge box says, for every merge state, whether it can be merged, why not, and the one thing that helps", () => {
  // A writer on an open pull request: the eight states GitHub reports.
  const table: Record<PrMergeState, [title: string, canMerge: boolean, fix: string | undefined, tone: string]> = {
    CLEAN: ["Ready to merge", true, undefined, "success"],
    HAS_HOOKS: ["Ready to merge", true, undefined, "success"],
    UNSTABLE: ["Some checks didn't pass", true, undefined, "pending"],
    BEHIND: ["main has moved on", false, "updateBranch", "pending"],
    BLOCKED: ["Merging is blocked", false, undefined, "failure"],
    DIRTY: ["This branch has conflicts", false, "checkout", "failure"],
    DRAFT: ["This pull request is still a draft", false, "markReady", "draft"],
    UNKNOWN: ["GitHub is checking whether it can be merged", true, "refresh", "muted"],
  };
  for (const s of STATES) {
    const b = box(s)!;
    assert.deepEqual([b.title, b.canMerge, b.fix, b.tone], table[s], s);
    assert.match(b.icon, /^[a-z][a-z-]*$/, `${s}: a codicon`);
    assert.ok(b.detail.length > 10 && /\.$/.test(b.detail), `${s}: a sentence: ${b.detail}`);
  }
  // …and each as a reader sees it: never mergeable, told why, no fix only a writer can use.
  for (const s of STATES) {
    const w = box(s)!;
    for (const role of ["READ", "TRIAGE"]) {
      const r = box(s, { viewer: { permission: role, canUpdate: false, canUpdateBranch: false } })!;
      assert.equal(r.canMerge, false, `${s} × ${role}`);
      assert.equal(r.title, w.title, `${s} × ${role}: the same state`);
      if (s === "DRAFT") {
        assert.match(r.detail, /Its author marks it ready/);
        assert.equal(r.fix, undefined);
      } else {
        assert.match(r.detail, /Only people with write access to acme\/app can merge it\.$/, `${s} × ${role}`);
        assert.equal(r.fix, s === "DIRTY" ? "checkout" : undefined, `${s} × ${role}: ${r.fix}`);
      }
    }
  }
  // BEHIND offers Update Branch only to whoever GitHub lets update it.
  assert.equal(box("BEHIND", { viewer: { permission: "WRITE", canUpdate: true, canUpdateBranch: false } })!.fix, undefined);
  // A merged or closed pull request has no merge box; a draft has one whatever GitHub's state.
  for (const kind of ["merged", "closed"]) assert.equal(box("CLEAN", { kind }), undefined, kind);
  assert.equal(box("CLEAN", { kind: "draft" })!.title, "This pull request is still a draft");
  // A repository that allows no method GitStudio can use.
  assert.deepEqual(
    [box("CLEAN", { repo: { id: "acme/app", mergeMethods: [] } })!.canMerge, box("CLEAN", { repo: { id: "acme/app", mergeMethods: [] } })!.title],
    [false, "No merge method is allowed"],
  );
});

test("a blocked pull request says what blocks it: the reviews, the checks, or the branch's rules", () => {
  const blocked = (reviewDecision: string | undefined, ci: string) =>
    box("BLOCKED", { reviewDecision, ci: { state: ci, total: 2, failed: ci === "failure" ? 1 : 0, pending: ci === "pending" ? 1 : 0 } })!.detail;
  assert.equal(blocked("CHANGES_REQUESTED", "success"), "Changes were requested.");
  assert.equal(blocked("REVIEW_REQUIRED", "success"), "It needs an approving review.");
  assert.equal(blocked("REVIEW_REQUIRED", "failure"), "It needs an approving review, and required checks failed.");
  assert.equal(blocked("APPROVED", "pending"), "Required checks haven't finished.");
  assert.equal(blocked(undefined, "none"), "The rules that protect main aren't met yet.");
});

test("merge methods: only the repository's, the preferred one first, each saying what it does", () => {
  const pr = { repo: { id: "acme/app", mergeMethods: ["merge", "squash", "rebase"] as const, defaultMethod: "rebase" as const, deleteBranchOnMerge: false } };
  assert.deepEqual(mergeMethodsFor(pr as never), ["rebase", "merge", "squash"], "GitHub's default for this viewer first");
  assert.deepEqual(mergeMethodsFor(pr as never, "squash"), ["squash", "merge", "rebase"], "the setting's choice beats it");
  assert.deepEqual(mergeMethodsFor({ repo: { mergeMethods: ["merge"] } } as never, "squash"), ["merge"], "a method the repository turned off is never offered");
  assert.equal(MERGE_METHODS.squash.what(3, "main"), "The 3 commits become one commit on main.");
  assert.equal(MERGE_METHODS.squash.what(1, "main"), "The commit is added to main as one new commit.");
  assert.equal(MERGE_METHODS.merge.what(3, "main"), "All 3 commits are added to main, joined by a merge commit.");
  assert.equal(MERGE_METHODS.rebase.what(2, "dev"), "The 2 commits are replayed onto dev one by one, with no merge commit.");
  assert.equal(new Set(Object.values(MERGE_METHODS).map((m) => m.icon)).size, 3, "three methods, three glyphs");
  const d = detail();
  assert.equal(defaultMergeTitle(d, "squash", "acme"), "Drop Commit (#37)");
  assert.equal(defaultMergeTitle(d, "merge", "acme"), "Merge pull request #37 from acme/feature/drop");
  assert.equal(defaultMergeTitle(d, "rebase", "acme"), "", "a rebase makes no commit of its own");
});

test("the merge box's words: sentence case, as github.com's own — and as every other button here", () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(MERGE_METHODS).map(([k, m]) => [k, [m.label, m.confirm]])),
    {
      merge: ["Create a merge commit", "Confirm merge"],
      squash: ["Squash and merge", "Confirm squash and merge"],
      rebase: ["Rebase and merge", "Confirm rebase and merge"],
    },
  );
  // Every word after the first is lower case — but a name (GitHub).
  const words = [...Object.values(MERGE_METHODS).flatMap((m) => [m.label, m.confirm]), ...Object.values(PR_PAGE_ACTION_WORDS).map((w) => w.label)];
  for (const w of words) assert.ok(w.split(" ").slice(1).every((x) => x === "GitHub" || x === x.toLowerCase()), `sentence case: ${w}`);
});

test("a review's verdicts: Approve and Request changes are not the author's to give", () => {
  const mine = reviewVerdictsFor({ viewer: { isAuthor: true } } as never);
  assert.deepEqual(mine.map((v) => [v.event, v.allowed]), [["COMMENT", true], ["APPROVE", false], ["REQUEST_CHANGES", false]]);
  assert.match(mine[1].why!, /your own pull request/);
  assert.ok(reviewVerdictsFor({ viewer: { isAuthor: false } } as never).every((v) => v.allowed));
});

// ── Checks ────────────────────────────────────────────────────────────────────

test("a check's result, and what it says of itself — how long it took, or has been running", () => {
  const now = Date.parse("2026-09-26T10:10:00Z");
  const run = (over: Partial<PrCheck>): PrCheck => ({ name: "test", state: "success", raw: "SUCCESS", required: false, startedAt: "2026-09-26T10:00:00Z", completedAt: "2026-09-26T10:06:18Z", ...over });
  assert.equal(checkWords(run({}), now), "Passed in 6m 18s");
  assert.equal(checkWords(run({ state: "failure", raw: "FAILURE" }), now), "Failed after 6m 18s");
  assert.equal(checkWords(run({ state: "failure", raw: "TIMED_OUT" }), now), "Timed out after 6m 18s");
  assert.equal(checkWords(run({ state: "pending", raw: "IN_PROGRESS", completedAt: undefined }), now), "Running for 10m");
  assert.equal(checkWords(run({ state: "pending", raw: "QUEUED", startedAt: undefined, completedAt: undefined }), now), "Queued");
  assert.equal(checkWords(run({ state: "pending", raw: "EXPECTED", startedAt: undefined, completedAt: undefined }), now), "Expected — waiting for it to report");
  assert.equal(checkWords(run({ state: "cancelled", raw: "CANCELLED" }), now), "Cancelled after 6m 18s");
  assert.equal(checkWords(run({ state: "skipped", raw: "SKIPPED" }), now), "Skipped");
  assert.equal(checkWords(run({ state: "success", raw: "SUCCESS", completedAt: undefined }), now), "Passed", "a status says no time");
  assert.deepEqual([durationWords(40_000), durationWords(60_000), durationWords(378_000), durationWords(7_500_000)], ["40s", "1m", "6m 18s", "2h 5m"]);
  // Every conclusion GitHub has, into six words.
  const conclusions: [string, string][] = [
    ["SUCCESS", "success"], ["FAILURE", "failure"], ["TIMED_OUT", "failure"], ["ACTION_REQUIRED", "failure"], ["STARTUP_FAILURE", "failure"],
    ["CANCELLED", "cancelled"], ["SKIPPED", "skipped"], ["NEUTRAL", "neutral"], ["STALE", "neutral"],
  ];
  for (const [c, want] of conclusions) assert.equal(checkStateOf("CheckRun", "COMPLETED", c), want, c);
  for (const s of ["QUEUED", "IN_PROGRESS", "WAITING", "PENDING", "REQUESTED"]) assert.equal(checkStateOf("CheckRun", s, null), "pending", s);
  for (const [s, want] of [["SUCCESS", "success"], ["FAILURE", "failure"], ["ERROR", "failure"], ["PENDING", "pending"], ["EXPECTED", "pending"]]) {
    assert.equal(checkStateOf("StatusContext", s, undefined), want, `status ${s}`);
  }
  assert.equal(new Set(Object.values(CHECK_STATES).map((s) => s.codicon)).size, 6, "six results, six glyphs");
  assert.deepEqual(sortChecks([run({ name: "b" }), run({ name: "a", state: "failure" }), run({ name: "c", state: "pending" }), run({ name: "a2", required: true })]).map((c) => c.name), ["a", "c", "a2", "b"]);
  assert.deepEqual(ciOfChecks(null, []), { state: "none", total: 0, failed: 0, pending: 0 });
});

test("the timeline's words: each event says what happened, and each verdict has a glyph of its own", () => {
  assert.equal(timelineEventWords({ event: "merged", detail: "949da6f" }, "main").text, "merged commit 949da6f into main");
  assert.equal(timelineEventWords({ event: "forcePushed", detail: "1111111→2222222" }, "main").text, "force-pushed the branch from 1111111 to 2222222");
  assert.equal(timelineEventWords({ event: "reviewRequested", detail: "core" }, "main").text, "asked core for a review");
  const verdicts = ["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"] as const;
  assert.equal(new Set(verdicts.map((v) => REVIEW_STATE_WORDS[v].codicon)).size, 4);
});

// ── Files ─────────────────────────────────────────────────────────────────────

test("the files as a tree: folders first, by name, and a folder of one folder is one row", () => {
  const f = (path: string) => ({ path, status: "modified" as const, additions: 1, deletions: 0, noDiff: false });
  const tree = fileTree([f("src/pr/b.ts"), f("src/pr/a.ts"), f("README.md"), f("packages/engine/src/forge/prPage.ts"), f("src/x.ts")]);
  const show = (nodes: ReturnType<typeof fileTree>, depth = 0): string[] =>
    nodes.flatMap((n) => (n.kind === "dir" ? [`${"  ".repeat(depth)}${n.name}/`, ...show(n.children, depth + 1)] : [`${"  ".repeat(depth)}${n.name}`]));
  assert.deepEqual(show(tree), ["packages/engine/src/forge/", "  prPage.ts", "src/", "  pr/", "    a.ts", "    b.ts", "  x.ts", "README.md"]);
  const dir = tree[1];
  assert.equal(dir.kind === "dir" && dir.children[0].kind === "dir" && dir.children[0].path, "src/pr", "a folder knows its whole path");
});
