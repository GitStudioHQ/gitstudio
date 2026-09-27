// Pull Requests list states for the headless tests and the screenshot harness
// (apps/extension/harness/pr/listShots.ts): realistic rows covering every
// variant a row has — each kind, each checks result, each review decision,
// a fork, labels, comments, the branch checked out — and a view state per
// situation the list can be in. Fictional repository and people: nothing here
// is anyone's real data.

import type { PrListViewState, PrRowView } from "@gitstudio/host-bridge/prProtocol";

/** 2026-09-27 12:00 UTC: every age below is counted from it. */
export const NOW = Date.UTC(2026, 8, 27, 12, 0, 0);

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A portrait-like avatar as an SVG data URL: GitHub's pictures, without the network. */
export function fakeAvatar(hue: number): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},55%,62%)"/><stop offset="1" stop-color="hsl(${(hue + 40) % 360},50%,38%)"/></linearGradient></defs><rect width="40" height="40" fill="url(#g)"/><circle cx="20" cy="16" r="7" fill="hsl(${hue},35%,88%)"/><path d="M6 40c2-9 8-13 14-13s12 4 14 13z" fill="hsl(${hue},35%,88%)"/></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export const PEOPLE = {
  me: { login: "sam-rivera", avatarUrl: fakeAvatar(265) },
  alice: { login: "alice-chen", avatarUrl: fakeAvatar(20) },
  bob: { login: "bobk", avatarUrl: fakeAvatar(140) },
  dana: { login: "dana-okafor", avatarUrl: fakeAvatar(200) },
  eli: { login: "eli", avatarUrl: null },
  bot: { login: "renovate[bot]", avatarUrl: fakeAvatar(90) },
};

export function row(n: number, over: Partial<PrRowView> = {}): PrRowView {
  return {
    number: n,
    title: `Pull request ${n}`,
    url: `https://github.com/acme/webapp/pull/${n}`,
    kind: "open",
    draft: false,
    state: "open",
    mergedAt: null,
    closedAt: null,
    createdAt: ago(6 * DAY),
    updatedAt: ago(3 * HOUR),
    author: PEOPLE.alice,
    headRef: `feature-${n}`,
    headSha: `${n}`.padEnd(40, "a"),
    headOwner: "acme",
    headRepo: "acme/webapp",
    headUrl: "https://github.com/acme/webapp",
    baseRef: "main",
    baseSha: "b".repeat(40),
    isFork: false,
    maintainerCanModify: false,
    labels: [],
    assignees: [],
    reviewRequests: [],
    ci: { state: "none", total: 0, failed: 0, pending: 0 },
    comments: 0,
    repository: "acme/webapp",
    checkedOut: false,
    ...over,
  };
}

/** The open list: one of every row a busy repository shows. */
export function openRows(): PrRowView[] {
  return [
    row(482, {
      title: "Stream large diffs instead of loading them whole",
      author: PEOPLE.me,
      headRef: "stream-diffs",
      updatedAt: ago(12 * MIN),
      ci: { state: "failure", total: 6, failed: 1, pending: 0 },
      reviewDecision: "CHANGES_REQUESTED",
      comments: 7,
      labels: [{ name: "performance", color: "fbca04" }],
      checkedOut: true,
    }),
    row(479, {
      title: "Keyboard navigation for the file tree",
      author: PEOPLE.dana,
      headRef: "tree-keys",
      kind: "draft",
      draft: true,
      updatedAt: ago(48 * MIN),
      ci: { state: "pending", total: 5, failed: 0, pending: 2 },
      comments: 2,
    }),
    row(476, {
      title: "Fix the crash when a submodule has no commits yet",
      author: PEOPLE.bob,
      headRef: "main",
      headOwner: "bobk",
      headRepo: "bobk/webapp",
      isFork: true,
      maintainerCanModify: true,
      updatedAt: ago(5 * HOUR),
      ci: { state: "success", total: 6, failed: 0, pending: 0 },
      reviewDecision: "APPROVED",
      comments: 3,
      labels: [
        { name: "bug", color: "d73a4a" },
        { name: "good first issue", color: "7057ff" },
      ],
    }),
    row(471, {
      title: "Bump esbuild from 0.27.4 to 0.28.1",
      author: PEOPLE.bot,
      headRef: "renovate/esbuild-0.x",
      updatedAt: ago(1 * DAY + 2 * HOUR),
      ci: { state: "success", total: 6, failed: 0, pending: 0 },
      reviewDecision: "REVIEW_REQUIRED",
      labels: [{ name: "dependencies", color: "0366d6" }],
    }),
    row(468, {
      title: "Document the release checklist, and what each step checks before it tags anything",
      author: PEOPLE.eli,
      headRef: "docs/release-checklist-and-what-each-step-checks",
      updatedAt: ago(4 * DAY),
      comments: 1,
      labels: [{ name: "documentation", color: "0075ca" }],
    }),
    row(455, {
      title: "Settings sync for the merge editor's layout",
      author: PEOPLE.alice,
      headRef: "merge-layout-sync",
      updatedAt: ago(19 * DAY),
      ci: { state: "failure", total: 4, failed: 4, pending: 0 },
      reviewDecision: "REVIEW_REQUIRED",
    }),
    row(431, {
      title: "Offline mode for the commit graph",
      author: PEOPLE.dana,
      headRef: "offline-graph",
      kind: "draft",
      draft: true,
      updatedAt: ago(75 * DAY),
    }),
  ];
}

function base(over: Partial<PrListViewState> = {}): PrListViewState {
  return {
    seq: 1,
    status: "list",
    targets: [{ id: "acme/webapp", owner: "acme", repo: "webapp", detail: "remote origin" }],
    target: "acme/webapp",
    viewer: PEOPLE.me,
    segment: "open",
    filters: {},
    counts: { open: 23, merged: 1204, closed: 57 },
    rows: openRows(),
    total: 23,
    hasMore: true,
    loadingMore: false,
    refreshing: false,
    now: NOW,
    ...over,
  };
}

/** Every situation the list can be in, by name. */
export function listScenes(): Record<string, PrListViewState> {
  const merged = [
    row(466, { title: "Remember the last-used merge method", kind: "merged", state: "closed", mergedAt: ago(2 * HOUR), updatedAt: ago(2 * HOUR), author: PEOPLE.bob, reviewDecision: "APPROVED", ci: { state: "success", total: 6, failed: 0, pending: 0 }, comments: 4 }),
    row(462, { title: "Show which remote a branch tracks", kind: "merged", state: "closed", mergedAt: ago(1 * DAY), updatedAt: ago(1 * DAY), author: PEOPLE.alice, ci: { state: "success", total: 6, failed: 0, pending: 0 } }),
    row(458, { title: "Experimental: rewrite the blame gutter", kind: "closed", state: "closed", closedAt: ago(3 * DAY), updatedAt: ago(3 * DAY), author: PEOPLE.eli, ci: { state: "failure", total: 6, failed: 2, pending: 0 }, comments: 9 }),
  ];
  return {
    open: base(),
    all: base({ segment: "all", rows: [...openRows().slice(0, 3), ...merged], total: 1284 }),
    filtered: base({
      filters: { text: "crash", author: "@me", label: "bug" },
      counts: { open: 2, merged: 5, closed: 0 },
      rows: [openRows()[0], row(401, { title: "Crash on an empty repository", author: PEOPLE.me, headRef: "empty-repo-crash", updatedAt: ago(9 * DAY), labels: [{ name: "bug", color: "d73a4a" }], ci: { state: "success", total: 6, failed: 0, pending: 0 } })],
      total: 2,
      hasMore: false,
    }),
    loading: base({ status: "loading", rows: [], counts: undefined, total: 0, hasMore: false }),
    refreshing: base({ refreshing: true }),
    refreshFailed: base({
      notice: {
        icon: "warning",
        tone: "warning",
        title: "Couldn't refresh: GitHub didn't answer.",
        detail: "Showing the list as it was 4 minutes ago.",
        buttons: [{ label: "Retry", icon: "refresh", action: { kind: "retry" } }],
      },
    }),
    emptyMerged: base({ segment: "merged", rows: [], total: 0, hasMore: false, counts: { open: 23, merged: 0, closed: 57 } }),
    emptyOpen: base({ rows: [], total: 0, hasMore: false, counts: { open: 0, merged: 12, closed: 3 } }),
    emptyFiltered: base({ filters: { text: "telemetry", assignee: "@none" }, rows: [], total: 0, hasMore: false, counts: { open: 0, merged: 0, closed: 0 } }),
    signedOut: base({
      status: "message",
      rows: [],
      counts: undefined,
      viewer: undefined,
      message: {
        icon: "github",
        tone: "info",
        title: "Sign in to GitHub to see pull requests",
        detail: "GitStudio uses VS Code's GitHub account — no token to paste. Then list, check out, review and merge pull requests here.",
        buttons: [{ label: "Sign in to GitHub", icon: "sign-in", primary: true, action: { kind: "signIn" } }],
      },
    }),
    notGitHub: base({
      status: "message",
      rows: [],
      counts: undefined,
      targets: [],
      target: undefined,
      message: {
        icon: "repo",
        tone: "info",
        title: "This repository isn't on GitHub",
        detail: "None of its remotes is on github.com: origin (gitlab.com). Pull requests are listed for github.com repositories.",
        buttons: [],
      },
    }),
    expired: base({
      status: "message",
      rows: [],
      counts: undefined,
      message: {
        icon: "warning",
        tone: "warning",
        title: "Your GitHub session expired",
        detail: "Sign in again to see acme/webapp's pull requests.",
        buttons: [{ label: "Sign in Again", icon: "sign-in", primary: true, action: { kind: "signIn", again: true } }],
      },
    }),
    offline: base({
      status: "message",
      rows: [],
      counts: undefined,
      message: {
        icon: "error",
        tone: "error",
        title: "Couldn't load pull requests",
        detail: "Couldn't reach GitHub. Check your network connection.",
        buttons: [{ label: "Retry", icon: "refresh", primary: true, action: { kind: "retry" } }],
      },
    }),
    fork: base({
      targets: [
        { id: "acme/webapp", owner: "acme", repo: "webapp", detail: "origin was forked from it" },
        { id: "sam-rivera/webapp", owner: "sam-rivera", repo: "webapp", detail: "remote origin — a fork of acme/webapp" },
      ],
      target: "acme/webapp",
    }),
    loadingMore: base({ loadingMore: true }),
  };
}
