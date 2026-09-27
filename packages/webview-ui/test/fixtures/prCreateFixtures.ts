// New pull request states for the headless tests and the screenshot harness
// (apps/extension/harness/pr/createShots.ts): a realistic branch — a few
// commits, a handful of changed files, a repository with a template, labels
// and people — and a view state per situation the form can be in. Fictional
// repository and people: nothing here is anyone's real data.

import type { PrCreateViewState } from "@gitstudio/host-bridge/prProtocol";
import { NOW, PEOPLE } from "./prListFixtures";

export { NOW, PEOPLE };

const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

export const TEMPLATE = `## What does this change?

## How was it tested?

- [ ] Unit tests
- [ ] Tried it by hand
`;

export const COMMITS = [
  { sha: "c3".repeat(20), shortSha: "c3c3c3c", subject: "Keep the scroll position while chunks arrive", author: "Sam Rivera", date: ago(40 * MIN) },
  { sha: "b2".repeat(20), shortSha: "b2b2b2b", subject: "Stream the right side of large diffs", author: "Sam Rivera", date: ago(3 * HOUR) },
  { sha: "a1".repeat(20), shortSha: "a1a1a1a", subject: "Stream the left side of large diffs", author: "Sam Rivera", date: ago(5 * HOUR) },
];

export const FILES: PrCreateViewState["compare"]["files"] = [
  { path: "src/diff/stream.ts", status: "added", additions: 96, deletions: 0, binary: false },
  { path: "src/diff/diffView.ts", status: "modified", additions: 41, deletions: 18, binary: false },
  { path: "src/diff/chunks.ts", previousPath: "src/diff/split.ts", status: "renamed", additions: 3, deletions: 3, binary: false },
  { path: "src/diff/legacyLoader.ts", status: "removed", additions: 0, deletions: 57, binary: false },
  { path: "test/fixtures/big.lock", status: "added", additions: 0, deletions: 0, binary: true },
];

const LABELS = [
  { name: "bug", color: "d73a4a", description: "Something isn't working" },
  { name: "performance", color: "0e8a16", description: "Faster, smaller" },
  { name: "needs-review", color: "fbca04" },
  { name: "ui", color: "1d76db", description: "How it looks" },
];

export function createState(over: Partial<PrCreateViewState> = {}): PrCreateViewState {
  return {
    seq: 1,
    status: "ready",
    targets: [
      { id: "acme/webapp", owner: "acme", repo: "webapp", detail: "remote upstream — origin was forked from it" },
      { id: "sam-rivera/webapp", owner: "sam-rivera", repo: "webapp", detail: "remote origin — a fork of acme/webapp" },
    ],
    target: "acme/webapp",
    viewer: PEOPLE.me,
    branches: [
      { name: "perf/stream-large-diffs", current: true },
      { name: "fix/login-redirect", current: false },
      { name: "main", current: false },
    ],
    head: { branch: "perf/stream-large-diffs", remote: "origin", owner: "sam-rivera", ref: "sam-rivera:perf/stream-large-diffs", push: "pushed", ahead: 0, behind: 0 },
    pushRemotes: [
      { name: "origin", repo: "sam-rivera/webapp", detail: "your fork" },
      { name: "upstream", repo: "acme/webapp", detail: "where it opens" },
    ],
    bases: [
      { name: "main", isDefault: true },
      { name: "release/2.4", isDefault: false },
      { name: "develop", isDefault: false },
    ],
    base: "main",
    compare: { status: "ready", commits: COMMITS, commitsTotal: COMMITS.length, files: FILES, additions: 140, deletions: 78 },
    proposed: { key: "k1", title: "Stream large diffs", body: TEMPLATE, bodyFrom: "template" },
    templates: [{ filename: ".github/pull_request_template.md" }],
    template: ".github/pull_request_template.md",
    options: { labels: LABELS, people: [PEOPLE.me, PEOPLE.alice, PEOPLE.bob, PEOPLE.dana, PEOPLE.eli], truncated: false },
    canSetMetadata: true,
    ai: true,
    refreshing: false,
    now: NOW,
    ...over,
  };
}

/** Every situation the form can be in, by name. */
export function createScenes(): Record<string, PrCreateViewState> {
  const base = createState();
  return {
    ready: base,
    sameRepo: createState({
      targets: [{ id: "acme/webapp", owner: "acme", repo: "webapp", detail: "remote origin" }],
      head: { branch: "perf/stream-large-diffs", remote: "origin", owner: "acme", ref: "perf/stream-large-diffs", push: "pushed", ahead: 0, behind: 0 },
      pushRemotes: [{ name: "origin", repo: "acme/webapp", detail: "where it opens" }],
    }),
    newBranch: createState({ head: { ...base.head!, push: "new", ahead: 0 } }),
    ahead: createState({ head: { ...base.head!, push: "ahead", ahead: 2 } }),
    existing: createState({
      existing: { number: 482, title: "Stream large diffs instead of loading them whole", url: "https://github.com/acme/webapp/pull/482", draft: false },
      problem: "perf/stream-large-diffs already has an open pull request, #482.",
    }),
    nothing: createState({
      compare: { status: "ready", commits: [], commitsTotal: 0, files: [], additions: 0, deletions: 0 },
      problem: "Nothing to compare: perf/stream-large-diffs has no commits that main doesn't.",
      proposed: { key: "k-empty", title: "Stream large diffs", body: TEMPLATE, bodyFrom: "template" },
    }),
    diverged: createState({
      head: { ...base.head!, push: "diverged", ahead: 1, behind: 2 },
      problem: "perf/stream-large-diffs and origin/perf/stream-large-diffs have both moved on: pull, then create it.",
    }),
    comparing: createState({ compare: { status: "loading", commits: [], commitsTotal: 0, files: [], additions: 0, deletions: 0 } }),
    compareFailed: createState({
      compare: { status: "failed", commits: [], commitsTotal: 0, files: [], additions: 0, deletions: 0, error: "main couldn't be fetched from acme/webapp: Could not resolve host: github.com" },
    }),
    stale: createState({ compare: { ...base.compare, stale: true } }),
    reader: createState({ canSetMetadata: false, metadataNote: "Reviewers, labels and assignees take triage access to acme/webapp. Its maintainers can add them." }),
    noTemplate: createState({
      templates: [],
      template: undefined,
      proposed: { key: "k-list", title: "Stream large diffs", body: "- Stream the left side of large diffs\n- Stream the right side of large diffs\n- Keep the scroll position while chunks arrive", bodyFrom: "commits" },
    }),
    manyTemplates: createState({
      templates: [{ filename: ".github/PULL_REQUEST_TEMPLATE/feature.md" }, { filename: ".github/PULL_REQUEST_TEMPLATE/bugfix.md" }],
      template: undefined,
      proposed: { key: "k-none", title: "Stream large diffs", body: "", bodyFrom: "empty" },
    }),
    creating: createState({ head: { ...base.head!, push: "ahead", ahead: 2 }, busy: "create" }),
    drafting: createState({ busy: "ai" }),
    failed: createState({
      notice: { icon: "warning", tone: "warning", title: "Couldn't create the pull request: Validation Failed: base: invalid", detail: "Everything you wrote is still here.", buttons: [] },
    }),
    loading: createState({ status: "loading", compare: { status: "idle", commits: [], commitsTotal: 0, files: [], additions: 0, deletions: 0 }, proposed: { key: "", title: "", body: "", bodyFrom: "empty" } }),
    signedOut: createState({
      status: "message",
      message: {
        icon: "github",
        tone: "info",
        title: "Sign in to GitHub to open a pull request",
        detail: "GitStudio uses VS Code's GitHub account — no token to paste.",
        buttons: [{ label: "Sign in to GitHub", icon: "sign-in", primary: true, action: { kind: "signIn" } }],
      },
    }),
    noGitHub: createState({
      status: "message",
      targets: [],
      target: "",
      message: { icon: "repo", tone: "info", title: "This repository has no GitHub remote", detail: "Pull requests are opened on github.com repositories. Add a remote that points at one.", buttons: [] },
    }),
  };
}
