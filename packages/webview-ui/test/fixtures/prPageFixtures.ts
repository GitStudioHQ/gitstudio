// Pull request page states for the headless tests and the screenshot harness
// (apps/extension/harness/pr/pageShots.ts): a realistic pull request — a
// described change, a conversation with reviews and threads, commits, every
// kind of check, a tree of changed files — and a view state per situation the
// page can be in. Fictional repository and people: nothing here is anyone's
// real data.

import type { PrCheck, PrDetail, PrPageFile, PrPageViewState, PrThread, PrTimelineItem } from "@gitstudio/host-bridge/prProtocol";
import { NOW, PEOPLE } from "./prListFixtures";

export { NOW, PEOPLE };

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const BODY = `## What

Large diffs are **streamed** to the diff view instead of being loaded whole, so a 40 MB lockfile no longer freezes the window.

- [x] Stream the left and right sides
- [x] Keep the scroll position while chunks arrive
- [ ] Measure on Windows

| File size | Before | After |
|-----------|-------:|------:|
| 4 MB      | 1.9 s  | 0.2 s |
| 40 MB     | 21 s   | 0.4 s |

Fixes #455, and follows up acme/infra#12. Thanks @dana-okafor for the profile.

\`\`\`ts
for await (const chunk of stream(path)) view.append(chunk);
\`\`\`

<details><summary>Profiler output</summary>

Most of the time went to \`splitLines\`.

</details>`;

function check(name: string, state: PrCheck["state"], over: Partial<PrCheck> = {}): PrCheck {
  const raw = { success: "SUCCESS", failure: "FAILURE", pending: "IN_PROGRESS", cancelled: "CANCELLED", skipped: "SKIPPED", neutral: "NEUTRAL" }[state];
  return {
    name,
    workflow: "CI",
    app: "GitHub Actions",
    state,
    raw,
    startedAt: ago(40 * MIN),
    ...(state === "pending" ? {} : { completedAt: ago(40 * MIN - 6 * MIN - 18_000) }),
    url: "https://github.com/acme/webapp/actions/runs/1/job/2",
    required: false,
    ...over,
  };
}

export const CHECKS: PrCheck[] = [
  check("test (windows-latest)", "failure", { required: true, raw: "TIMED_OUT", completedAt: ago(10 * MIN) }),
  check("test (ubuntu-latest)", "pending", { required: true, startedAt: ago(3 * MIN) }),
  check("build", "success", { required: true }),
  check("lint", "success"),
  { name: "ci/legacy-perf", state: "success", raw: "SUCCESS", startedAt: ago(35 * MIN), url: "https://ci.example.com/job/88", required: false, description: "Within budget" },
  check("docs preview", "skipped", { workflow: "Docs" }),
  check("nightly smoke", "cancelled", { workflow: "Nightly" }),
];

export const THREADS: PrThread[] = [
  {
    id: "T_1",
    path: "src/diff/stream.ts",
    line: 48,
    startLine: 44,
    originalLine: 48,
    side: "RIGHT",
    resolved: false,
    outdated: false,
    canResolve: true,
    canUnresolve: false,
    canReply: true,
    reviewId: "R_1",
    comments: [
      { id: "C_1", author: PEOPLE.dana, body: "What happens when a chunk ends in the middle of a `\\r\\n`?", createdAt: ago(20 * HOUR), url: "https://github.com/acme/webapp/pull/482#discussion_r1" },
      { id: "C_2", author: PEOPLE.me, body: "It carries the `\\r` into the next chunk — see `carry` on line 51.", createdAt: ago(18 * HOUR), url: "https://github.com/acme/webapp/pull/482#discussion_r2" },
    ],
    totalComments: 2,
  },
  {
    id: "T_2",
    path: "src/diff/view.ts",
    line: null,
    startLine: null,
    originalLine: 120,
    side: "RIGHT",
    resolved: true,
    outdated: true,
    resolvedBy: "sam-rivera",
    canResolve: false,
    canUnresolve: true,
    canReply: true,
    reviewId: "R_1",
    comments: [{ id: "C_3", author: PEOPLE.dana, body: "Nit: this can be a `const`.", createdAt: ago(20 * HOUR), url: "https://github.com/acme/webapp/pull/482#discussion_r3" }],
    totalComments: 1,
  },
];

export const TIMELINE: PrTimelineItem[] = [
  { kind: "event", id: "E_1", event: "reviewRequested", actor: PEOPLE.me, createdAt: ago(2 * DAY), detail: "dana-okafor" },
  { kind: "comment", id: "IC_1", author: PEOPLE.bob, body: "Tried it on the monorepo — the 40 MB lockfile opens instantly now. :rocket:", createdAt: ago(30 * HOUR), url: "https://github.com/acme/webapp/pull/482#issuecomment-1" },
  { kind: "review", id: "R_1", author: PEOPLE.dana, state: "CHANGES_REQUESTED", body: "Close — one question about line endings before this goes in.", createdAt: ago(20 * HOUR), url: "https://github.com/acme/webapp/pull/482#pullrequestreview-1" },
  { kind: "event", id: "E_2", event: "forcePushed", actor: PEOPLE.me, createdAt: ago(5 * HOUR), detail: "1a2b3c4→5d6e7f8" },
  { kind: "review", id: "R_2", author: PEOPLE.bob, state: "APPROVED", body: "", createdAt: ago(3 * HOUR), url: "https://github.com/acme/webapp/pull/482#pullrequestreview-2" },
];

export const FILES: PrPageFile[] = [
  { path: "src/diff/stream.ts", status: "added", additions: 212, deletions: 0, noDiff: false },
  { path: "src/diff/view.ts", status: "modified", additions: 64, deletions: 38, noDiff: false },
  { path: "src/diff/chunks/split.ts", previousPath: "src/diff/split.ts", status: "renamed", additions: 12, deletions: 9, noDiff: false },
  { path: "src/diff/legacyLoader.ts", status: "removed", additions: 0, deletions: 141, noDiff: false },
  { path: "test/fixtures/large.bin", status: "added", additions: 0, deletions: 0, noDiff: true },
  { path: "test/stream.test.ts", status: "added", additions: 96, deletions: 0, noDiff: false },
  { path: "README.md", status: "modified", additions: 4, deletions: 1, noDiff: false },
];

export function detail(over: Partial<PrDetail> = {}): PrDetail {
  return {
    id: "PR_482",
    number: 482,
    title: "Stream large diffs instead of loading them whole",
    body: BODY,
    url: "https://github.com/acme/webapp/pull/482",
    kind: "open",
    draft: false,
    state: "open",
    mergedAt: null,
    closedAt: null,
    createdAt: ago(3 * DAY),
    updatedAt: ago(12 * MIN),
    author: PEOPLE.me,
    mergedBy: null,
    headRef: "stream-diffs",
    headSha: "5d6e7f8".padEnd(40, "0"),
    headOwner: "acme",
    headRepo: "acme/webapp",
    baseRef: "main",
    baseSha: "b".repeat(40),
    isFork: false,
    maintainerCanModify: false,
    additions: 388,
    deletions: 188,
    changedFiles: 7,
    commitCount: 4,
    mergeState: "BLOCKED",
    reviewDecision: "CHANGES_REQUESTED",
    labels: [
      { name: "performance", color: "fbca04" },
      { name: "diff", color: "1d76db" },
    ],
    assignees: [PEOPLE.me],
    reviewers: [
      { login: PEOPLE.dana.login, avatarUrl: PEOPLE.dana.avatarUrl, verdict: "CHANGES_REQUESTED", requested: false },
      { login: PEOPLE.bob.login, avatarUrl: PEOPLE.bob.avatarUrl, verdict: "APPROVED", requested: false },
      { team: "diff-owners", requested: true },
    ],
    ci: { state: "failure", total: 7, failed: 1, pending: 1 },
    timeline: TIMELINE,
    timelineTotal: TIMELINE.length,
    threads: THREADS,
    threadsTotal: THREADS.length,
    commits: [
      { sha: "1".repeat(40), shortSha: "1111111", headline: "Stream both sides of a diff", body: "Reads each side a chunk at a time.\n\nNo change to small files.", author: PEOPLE.me, authorName: "Sam Rivera", committedAt: ago(3 * DAY), ci: "success" },
      { sha: "2".repeat(40), shortSha: "2222222", headline: "Keep the scroll position while chunks arrive", body: "", author: PEOPLE.me, authorName: "Sam Rivera", committedAt: ago(2 * DAY), ci: "success" },
      { sha: "3".repeat(40), shortSha: "3333333", headline: "Move split.ts under chunks/", body: "", author: null, authorName: "build-bot", committedAt: ago(1 * DAY), ci: "none" },
      { sha: "5d6e7f8".padEnd(40, "0"), shortSha: "5d6e7f8", headline: "Carry a split CRLF into the next chunk", body: "", author: PEOPLE.me, authorName: "Sam Rivera", committedAt: ago(5 * HOUR), ci: "failure" },
    ],
    checks: CHECKS,
    checksTotal: CHECKS.length,
    viewer: { login: PEOPLE.alice.login, avatarUrl: PEOPLE.alice.avatarUrl, permission: "WRITE", isAuthor: false, canUpdate: true, canUpdateBranch: true, canDeleteBranch: true },
    repo: { id: "acme/webapp", mergeMethods: ["merge", "squash", "rebase"], defaultMethod: "squash", deleteBranchOnMerge: false },
    ...over,
  };
}

function base(over: Partial<PrPageViewState> = {}): PrPageViewState {
  return {
    seq: 1,
    status: "ready",
    repo: "acme/webapp",
    number: 482,
    tab: "conversation",
    pr: detail(),
    files: { items: FILES, truncated: false },
    commitFiles: {},
    busy: [],
    refreshing: false,
    checkedOut: false,
    now: NOW,
    ...over,
  };
}

const PENDING = {
  comments: [
    { path: "src/diff/stream.ts", line: 51, side: "RIGHT" as const, body: "Could this reuse the decoder from the file reader?" },
    { path: "src/diff/view.ts", line: 88, startLine: 84, side: "RIGHT" as const, body: "These four lines read as one step; a helper would say what it is." },
    { path: "src/diff/legacyLoader.ts", line: 12, side: "LEFT" as const, body: "Is anything outside diff/ still calling this?" },
  ],
  started: true,
  headSha: "5d6e7f8".padEnd(40, "0"),
  stale: false,
};

/** Approved, checks green: only the merge state differs. */
function approved(over: Partial<PrDetail> = {}): PrDetail {
  return detail({
    reviewDecision: "APPROVED",
    reviewers: [{ login: PEOPLE.bob.login, avatarUrl: PEOPLE.bob.avatarUrl, verdict: "APPROVED", requested: false }],
    ci: { state: "success", total: 5, failed: 0, pending: 0 },
    checks: CHECKS.filter((c) => c.state === "success" || c.state === "skipped"),
    checksTotal: 5,
    ...over,
  });
}

/** Every situation the page can be in, by name. */
export function pageScenes(): Record<string, PrPageViewState> {
  return {
    open: base(),
    ready: base({ pr: approved({ mergeState: "CLEAN" }), checkedOut: true }),
    behind: base({ pr: approved({ mergeState: "BEHIND" }) }),
    conflicts: base({ pr: approved({ mergeState: "DIRTY" }) }),
    draft: base({ pr: detail({ kind: "draft", draft: true, mergeState: "DRAFT", reviewDecision: undefined, reviewers: [], ci: { state: "pending", total: 5, failed: 0, pending: 2 } }) }),
    merged: base({
      pr: approved({ kind: "merged", state: "closed", mergedAt: ago(2 * HOUR), closedAt: ago(2 * HOUR), mergedBy: PEOPLE.bob, mergeState: "UNKNOWN",
        timeline: [...TIMELINE, { kind: "event", id: "E_M", event: "merged", actor: PEOPLE.bob, createdAt: ago(2 * HOUR), detail: "9f8e7d6" }] }),
    }),
    closed: base({
      pr: detail({ kind: "closed", state: "closed", closedAt: ago(1 * DAY), mergeState: "UNKNOWN", timeline: [...TIMELINE, { kind: "event", id: "E_C", event: "closed", actor: PEOPLE.me, createdAt: ago(1 * DAY) }] }),
    }),
    reader: base({ pr: approved({ mergeState: "CLEAN", viewer: { login: "eli", avatarUrl: null, permission: "READ", isAuthor: false, canUpdate: false, canUpdateBranch: false, canDeleteBranch: false } }) }),
    loading: base({ status: "loading", pr: undefined, files: undefined, preview: { title: "Stream large diffs instead of loading them whole", kind: "open", author: PEOPLE.me, headRef: "stream-diffs", baseRef: "main" } }),
    failed: base({
      status: "message",
      pr: undefined,
      files: undefined,
      preview: { title: "Stream large diffs instead of loading them whole", kind: "open", author: PEOPLE.me, headRef: "stream-diffs", baseRef: "main" },
      message: {
        icon: "error",
        tone: "error",
        title: "Couldn't reach GitHub",
        detail: "Check your network connection.",
        buttons: [{ label: "Retry", icon: "refresh", primary: true, action: { kind: "retry" } }],
      },
    }),
    refreshFailed: base({
      notice: {
        icon: "warning",
        tone: "warning",
        title: "Couldn't close #482: Resource not accessible by integration.",
        detail: "It is still open.",
        buttons: [{ label: "Open on GitHub", icon: "link-external", action: { kind: "openUrl", url: "https://github.com/acme/webapp/pull/482" } }],
      },
    }),
    mergeBox: base({ pr: approved({ mergeState: "CLEAN" }), focus: { seq: 1, open: "merge" } }),
    merging: base({ pr: approved({ mergeState: "CLEAN" }), focus: { seq: 1, open: "merge" }, busy: ["merge"] }),
    reviewBox: base({ review: PENDING, focus: { seq: 1, open: "review" } }),
    reviewOwn: base({ pr: detail({ viewer: { login: PEOPLE.me.login, avatarUrl: PEOPLE.me.avatarUrl, permission: "WRITE", isAuthor: true, canUpdate: true, canUpdateBranch: true, canDeleteBranch: true } }), focus: { seq: 1, open: "review" } }),
    reviewStale: base({ review: { ...PENDING, headSha: "1a2b3c4".padEnd(40, "0"), stale: true }, focus: { seq: 1, open: "review" } }),
    commits: base({ tab: "commits", commitFiles: { ["1".repeat(40)]: { status: "loaded", files: FILES.slice(0, 3) } } }),
    checks: base({ tab: "checks" }),
    files: base({ tab: "files", review: PENDING }),
    filesEmpty: base({ tab: "files", pr: detail({ changedFiles: 0, additions: 0, deletions: 0 }), files: { items: [], truncated: false } }),
    noDescription: base({ pr: detail({ body: "", timeline: [], timelineTotal: 0, threads: [], threadsTotal: 0, reviewers: [], labels: [], assignees: [], reviewDecision: "REVIEW_REQUIRED", ci: { state: "none", total: 0, failed: 0, pending: 0 }, checks: [], checksTotal: 0 }) }),
  };
}
