// Headless-render harness: fakes the preload's `window.gitstudio` bridge with
// realistic fixtures so the WHOLE desktop renderer runs in plain Chrome.
// Scene selection via ?scene=<view>[.step[.step…]] — steps are driver actions
// run after the repo screen mounts (e.g. "issues.open18" opens issue #18).
(() => {
  const now = Date.now();
  const S = (h) => Math.floor(now / 1000) - h * 3600; // epoch-secs, h hours ago
  const ISO = (h) => new Date(now - h * 3600e3).toISOString();

  const params = new URLSearchParams(location.search);
  // Steps separated by "~" (not ".") so CSS selectors in click: steps survive.
  const scene = (params.get("scene") || "issues").split("~");
  const view = scene[0];
  const steps = scene.slice(1);
  const theme = params.get("theme") || "dark";

  // Pre-seed prefs so the app boots straight into the scene's view, terminal
  // collapsed, fixed rail width — deterministic screenshots.
  //
  // `?firstrun=1` seeds NO view, which is the one state this harness could not
  // express: every scene names a view and therefore forces one, so "where does
  // the app open when it has no memory of you" — the actual first-run
  // experience — was untestable. A check asserting the landing view from a
  // scene that had already chosen it was only ever confirming its own input.
  const firstRun = params.get("firstrun") === "1";
  window.__GS_FIRST_RUN = firstRun;
  localStorage.setItem(
    "gitstudio.ui.prefs",
    JSON.stringify({
      ...(firstRun ? {} : { currentView: view === "inbox" ? "notifications" : view }),
      themeMode: theme,
      railWidth: 216,
      railCollapsed: false,
      terminalOpen: false,
      // ?staging=checkboxes drives the one-list model (issue #16). Without a way
      // in, the ticks that ARE the staging model in that mode were unreachable
      // from the harness and never looked at.
      stagingModel: params.get("staging") === "checkboxes" ? "checkboxes" : "split",
    }),
  );

  // ── cast ──
  const me = "antonarnaudov";
  const u = (login) => ({ login, avatarUrl: null });
  const label = (name, color) => ({ name, color });
  const L = {
    bug: label("bug", "d73a4a"),
    ux: label("ux", "bfdadc"),
    enhancement: label("enhancement", "a2eeef"),
    desktop: label("desktop app", "5319e7"),
    extension: label("extension", "0e8a16"),
    help: label("help wanted", "008672"),
    good: label("good first issue", "7057ff"),
    perf: label("performance", "fbca04"),
  };

  const issues = [
    { number: 31, title: "Split views make Issues and PRs unreadable on a 13\" screen", state: "open", user: u("mira-holt"), labels: [L.ux, L.desktop], assignees: [u(me)], comments: 6, h: 5, assoc: "MEMBER",
      reactions: { total: 9, plusOne: 6, minusOne: 0, laugh: 0, hooray: 2, confused: 0, heart: 1, rocket: 0, eyes: 0 },
      body: "On a MacBook Air the list pane and detail pane fight for space — the list truncates every title and the detail wraps the action buttons onto three rows.\n\n**Expected**: reading an issue should use the full width, like Linear does.\n\n**Actual**: two cramped panes, both scrolling independently." },
    { number: 30, title: "Workflow logs: streaming stops after ~400 lines", state: "open", user: u("s-ohta"), labels: [L.bug], assignees: [], comments: 2, h: 9, milestone: { number: 3, title: "v1.6" },
      body: "Long jobs stop appending output. Re-opening the run shows the full log, so it's a streaming bug, not a data bug." },
    { number: 29, title: "Notifications: mark-as-done needs a keyboard shortcut", state: "open", user: u("jparks"), labels: [L.enhancement, L.ux], assignees: [u("mira-holt")], comments: 4, h: 16,
      body: "Triaging 40 notifications with the mouse is painful. `e` to archive like every inbox, please." },
    { number: 28, title: "Rebase drag-to-reorder flickers when dropping on the last row", state: "open", user: u(me), labels: [L.bug, L.desktop], assignees: [u(me)], comments: 1, h: 28, milestone: { number: 3, title: "v1.6" },
      body: "Repro:\n1. Open Rebase with 6+ commits\n2. Drag the first commit to the end\n3. Drop marker jumps for a frame\n\nSuspect the placeholder index is off by one when `after === rows.length`." },
    { number: 27, title: "Support per-line staging, not just blocks", state: "open", user: u("dkovachev"), labels: [L.enhancement, L.help], assignees: [], comments: 9, h: 40,
      body: "`applySelectedChanges` promotes the whole block a selection touches. JetBrains lets you tick single lines. This needs engine work — see the staging notes in the wiki.\n\nThe shape it should have:\n\n```python\ndef stage(lines):\n    for n in lines:\n        if guard(n):\n            apply(n)\n    return True\n```\n\nNote the INDENTATION — this fence exists so a check can prove a copied snippet carries real spaces." },
    { number: 26, title: "Release drafting: attach assets from the app", state: "open", user: u("mira-holt"), labels: [L.enhancement], assignees: [u("s-ohta")], comments: 3, h: 51,
      body: "Creating a release works, but uploading a .dmg still means a browser round-trip." },
    { number: 25, title: "Graph: avatars blur on non-retina displays", state: "open", user: u("jparks"), labels: [L.bug, L.perf], assignees: [], comments: 2, h: 70,
      body: "Half-pixel alignment again. The gutter drawer draws avatars at y+0.5 on 1x DPR." },
    { number: 23, title: "Onboarding: first-run tour of the six local views", state: "open", user: u("dkovachev"), labels: [L.good, L.ux], assignees: [], comments: 0, h: 90,
      body: "" },
    { number: 22, title: "Add a built-in terminal multiplexer", state: "closed", stateReason: "not_planned", user: u("jparks"), labels: [L.enhancement], assignees: [], comments: 3, h: 120,
      body: "Out of scope — GitStudio ships one terminal, not a tmux clone." },
    { number: 21, title: "Stash view: show untracked files included in a stash", state: "closed", user: u("s-ohta"), labels: [L.bug], assignees: [u(me)], comments: 5, h: 130,
      body: "Fixed by reading the third parent commit when present." },
    { number: 19, title: "Checkout from the graph checks out the commit, not the branch", state: "closed", user: u("mira-holt"), labels: [L.bug], assignees: [u(me)], comments: 8, h: 200,
      body: "Detached HEAD surprise. Fixed with checkout-ref." },
  ];

  // Every comment carries a permalink, because "Copy link" is one of the four
  // things a comment can do and a fixture without one silently hides it.
  // Non-comment history. Timestamps sit BETWEEN comment timestamps on purpose:
  // a thread that bunches every label and close at the end is not a record of
  // anything, and only interleaved fixtures can catch that.
  const issueEvents = {
    31: [
      { kind: "labeled", actor: "mira-holt", createdAt: ISO(3.8), label: { name: "ux", color: "8a63d2" } },
      { kind: "assigned", actor: me, createdAt: ISO(3.2), assignee: me },
      { kind: "renamed", actor: me, createdAt: ISO(2.5), rename: { from: "Split views are bad", to: "Split views make Issues and PRs unreadable on a 13\" screen" } },
      { kind: "cross-referenced", actor: "jparks", createdAt: ISO(1.5), source: { kind: "pr", ref: "#106", title: "desktop: full-page detail views for Issues", url: "", state: "open", merged: false } },
      // A second linked PR, MERGED — the Development rail must colour the two
      // differently or "was this fixed" still cannot be answered at a glance.
      { kind: "cross-referenced", actor: "sohta", createdAt: ISO(1.2), source: { kind: "pr", ref: "#98", title: "issues: routed detail groundwork", url: "", state: "closed", merged: true } },
      // A cross-reference from ANOTHER project, deliberately numbered #106 to
      // collide with the local one above. Both defects it pins were silent: the
      // rail keyed its linked PRs by number alone, so this one replaced the
      // local #106 and two pieces of work showed as one; and its link routed by
      // number into THIS repository, opening an unrelated pull request.
      { kind: "cross-referenced", actor: "mira-holt", createdAt: ISO(1.1), source: { kind: "pr", repo: "libgit2/libgit2", ref: "#106", title: "cmake: drop the vendored zlib", url: "https://github.com/libgit2/libgit2/pull/106", state: "open", merged: false } },
      { kind: "milestoned", actor: me, createdAt: ISO(0.5), milestone: "1.6 — desktop polish" },
    ],
    // A CLOSED issue is where a close event belongs. #22 is closed as not
    // planned, and its thread never said so — the rail claimed it while the
    // conversation skipped the moment entirely.
    22: [
      { kind: "labeled", actor: "mira-holt", createdAt: ISO(30), label: { name: "wontfix", color: "cfd3d7" } },
      { kind: "closed", actor: "mira-holt", createdAt: ISO(26), reason: "not_planned" },
    ],
  };

  const issueComments = {
    31: [
      { id: 1, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/issues/31#issuecomment-1", author: u(me), createdAt: ISO(4), body: "Agreed — this is the #1 usability debt in the app. The plan:\n\n1. Lists go **full width** with richer rows\n2. Opening an item replaces the list with a **full detail view** (Esc / ← goes back)\n3. Properties move to a right rail with inline editing\n\nSame pattern for Issues, PRs, Actions, Releases." },
      { id: 2, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/issues/31#issuecomment-2", author: u("mira-holt"), createdAt: ISO(3.5), updatedAt: ISO(3.4), authorAssociation: "MEMBER", body: "Yes. Also please keep keyboard flow: `↑↓` in the list, `Enter` to open, `Esc` back, `c` to comment." },
      { id: 3, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/issues/31#issuecomment-3", author: u("jparks"), createdAt: ISO(3), authorAssociation: "FIRST_TIME_CONTRIBUTOR", reactions: { total: 4, plusOne: 3, minusOne: 0, laugh: 0, hooray: 0, confused: 0, heart: 1, rocket: 0, eyes: 0, mine: ["+1"] }, body: "While you're in there — the *Open on GitHub* buttons everywhere feel like the app giving up. If the data's already on screen, let me act on it in place." },
      { id: 4, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/issues/31#issuecomment-4", author: u(me), createdAt: ISO(2), body: "> the app giving up\n\nFair. In-app actions become primary; the GitHub link stays as a small escape hatch on every detail view.\n\nDuring Tuesday's GitHub outage the local half of the app kept working fine — the redesign should make the GitHub half feel just as solid.\n\nPrior art in #98 here, and libgit2/libgit2#106 over there." },
    ],
  };

  const prs = [
    { number: 106, title: "desktop: full-page detail views for Issues (kills the split pane)", body: "First section converted to the new list ⇄ detail navigation.\n\n- `sec-*` full-width list rows\n- `det-*` detail page with a property rail\n- Esc / ⌘[ walk back through real history", state: "open", draft: false, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/pull/106", user: u(me), createdAt: ISO(3), updatedAt: ISO(1), head: { ref: "redesign/issues-detail", sha: "a1b2c3d" }, base: { ref: "main", sha: "9f8e7d6" }, labels: [L.desktop, L.ux], comments: 4, additions: 612, deletions: 348, changedFiles: 9, assignees: [u(me), u("mira-holt")], mergedAt: null, closedAt: null, mergedBy: null, reviewComments: 7, commits: 14, requestedReviewers: [u("dkovachev")], milestone: { number: 3, title: "Desktop 1.6" }, authorAssociation: "OWNER", headRepoFullName: null, reactions: { total: 5, plusOne: 4, minusOne: 0, laugh: 0, hooray: 1, confused: 0, heart: 0, rocket: 0, eyes: 0 } },
    { number: 104, title: "actions: stream job logs over IPC with backpressure", body: "", state: "open", draft: false, htmlUrl: "", user: u("s-ohta"), createdAt: ISO(7), updatedAt: ISO(2), head: { ref: "fix/log-stream", sha: "b2c3d4e" }, base: { ref: "main", sha: "9f8e7d6" }, labels: [L.bug], comments: 2, additions: 210, deletions: 64, changedFiles: 4, reviewComments: 2, commits: 5, requestedReviewers: [u(me)], authorAssociation: "MEMBER", headRepoFullName: "s-ohta/gitstudio" },
    { number: 103, title: "engine: per-line staging groundwork (hunk splitting)", body: "", state: "open", draft: true, htmlUrl: "", user: u("dkovachev"), createdAt: ISO(20), updatedAt: ISO(6), head: { ref: "feat/line-staging", sha: "c3d4e5f" }, base: { ref: "main", sha: "9f8e7d6" }, labels: [L.enhancement], comments: 11, additions: 1240, deletions: 180, changedFiles: 17 },
    { number: 101, title: "ci: run desktop tests on windows-latest too", body: "", state: "open", draft: false, htmlUrl: "", user: u("jparks"), createdAt: ISO(30), updatedAt: ISO(26), head: { ref: "ci/windows", sha: "d4e5f6a" }, base: { ref: "main", sha: "9f8e7d6" }, labels: [], comments: 1, additions: 48, deletions: 3, changedFiles: 2 },
    { number: 99, title: "release: extension 1.11.1", body: "", state: "closed", draft: false, htmlUrl: "", user: u(me), createdAt: ISO(50), updatedAt: ISO(44), head: { ref: "release/1.11.1", sha: "e5f6a7b" }, base: { ref: "main", sha: "9f8e7d6" }, labels: [], comments: 0, additions: 12, deletions: 4, changedFiles: 3, mergedAt: ISO(44), closedAt: ISO(44), mergedBy: u("mira-holt"), commits: 3, reviewComments: 1, authorAssociation: "OWNER" },
  ];

  const prConversation = {
    106: [
      // A plain comment carries everything an issue comment does — id, an edit
      // time, an association, reactions, a permalink — because it IS one, at
      // the same endpoint. Without these on the fixture, the parity is
      // unreachable from the harness and nothing can check it.
      { kind: "comment", id: 9001, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/pull/106#issuecomment-9001", author: "mira-holt", authorAssociation: "MEMBER", createdAt: ISO(2.5), updatedAt: ISO(2.4), reactions: { total: 3, plusOne: 2, minusOne: 0, laugh: 0, hooray: 0, confused: 0, heart: 1, rocket: 0, eyes: 0, mine: ["+1"] }, body: "Tried the branch — night and day. Full-width rows read like a real tracker now." },
      { kind: "review", state: "APPROVED", author: "s-ohta", createdAt: ISO(2), body: "Navigation history integration is clean. Ship it." },
      { kind: "review", state: "CHANGES_REQUESTED", author: "jparks", createdAt: ISO(1.8), body: "The Esc handler swallows the key while a menu is open — see the comment on issues.ts." },
      { kind: "comment", id: 9002, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/pull/106#issuecomment-9002", author: me, authorAssociation: "OWNER", createdAt: ISO(1.2), body: "PRs view converts next on this pattern, then Actions." },
    ],
  };
  // NINE files, because the PR says "Files (9)" — three made the count a lie and
  // hid every capped-list notice. Across three directories, and covering every
  // status GitHub sends: with all three "modified", the bug where "removed" and
  // "renamed" both rendered as an amber R was not expressible at all.
  const prFiles = {
    106: [
      { filename: "apps/desktop/src/renderer/views/issues.ts", status: "modified", additions: 402, deletions: 260 },
      { filename: "apps/desktop/src/renderer/views/common.ts", status: "modified", additions: 118, deletions: 30 },
      { filename: "apps/desktop/src/renderer/views/issueDetail.ts", status: "renamed", additions: 12, deletions: 4, previousFilename: "apps/desktop/src/renderer/issueDetail.ts" },
      { filename: "apps/desktop/src/renderer/legacySplit.ts", status: "removed", additions: 0, deletions: 231 },
      { filename: "apps/desktop/src/renderer/detailShell.ts", status: "added", additions: 188, deletions: 0 },
      { filename: "apps/desktop/src/renderer/styles/app.css", status: "modified", additions: 92, deletions: 58 },
      { filename: "apps/desktop/harness/checks.js", status: "modified", additions: 41, deletions: 0 },
      { filename: "packages/webview-ui/src/detail.css", status: "copied", additions: 22, deletions: 0 },
      { filename: "apps/desktop/assets/issue-empty.png", status: "added", additions: 0, deletions: 0 },
    ],
  };
  // `detailsUrl` on at least one row is load-bearing for the harness, not
  // decoration: without it `.gh-check-row.is-link` cannot exist in ANY scene, so
  // "leave a PR for its pipeline and press back" — a bug the owner hit — was
  // literally unreachable by the test suite. One GitHub-Actions URL (opens the
  // run in-app) and one external CI URL (opens a browser), because the two take
  // different code paths.
  const prChecks = {
    106: [
      {
        name: "build / desktop (macos)",
        status: "completed",
        conclusion: "success",
        detailsUrl: "https://github.com/GitStudioHQ/gitstudio/actions/runs/9100/job/1",
      },
      { name: "build / desktop (windows)", status: "completed", conclusion: "success" },
      { name: "test / renderer", status: "completed", conclusion: "success" },
      {
        name: "codecov/patch",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://app.circleci.com/pipelines/github/GitStudioHQ/gitstudio/4102",
      },
      { name: "lint", status: "in_progress", conclusion: "" },
    ],
    104: [
      {
        name: "build / desktop (macos)",
        status: "completed",
        conclusion: "failure",
        detailsUrl: "https://github.com/GitStudioHQ/gitstudio/actions/runs/9097/job/1",
      },
    ],
  };
  // FOURTEEN, because the tab says "Commits (14)". Two made the count a lie and
  // meant no capped-list notice was ever reachable. The third is the 420-file
  // merge, so the commit page can be driven at a real size from a real route.
  const prCommits = {
    106: [
      // The four states a commit row has to be able to draw: a plain one, one
      // with a BODY behind the disclosure, a MERGE, and a VERIFIED signature.
      { sha: "a1b2c3d4", shortSha: "a1b2c3d", message: "issues: full-page detail as a routed state", body: "The split view could not show a body, a timeline and a rail at once on a\n13\" screen, so all three were cropped.\n\nCloses #31.", author: me, login: me, date: ISO(3), verified: true },
      { sha: "b2c3d4e5", shortSha: "b2c3d4e", message: "common: sectionList + detailShell primitives", author: me, login: me, date: ISO(2.6) },
      { sha: "f00dbabe", shortSha: "f00dbab", message: "Merge the generated-module migration", author: me, login: me, date: ISO(2.4), isMerge: true },
      // Dated across two days, so the day grouping is a thing the screenshot
      // actually shows rather than a code path nobody looks at.
      ...Array.from({ length: 11 }, (_, i) => ({
        sha: `c${i}d4e5f6`,
        shortSha: `c${i}d4e5f`,
        message: [
          "css: list + detail tokens share one scale",
          "prs: files tab reads the diff from the engine",
          "actions: stream job logs with backpressure",
          "graph: keep the mount alive across routes",
          "settings: one measure for every card",
          "inbox: group by repository, not by hour",
          "compare: drop the either/or body",
          "code: middle-truncate paths in the crumb",
          "gists: a real empty state",
          "orgs: repositories before teams",
          "releases: latest is the shipping build",
        ][i],
        author: i % 3 === 0 ? "mira-holt" : i % 3 === 1 ? "s-ohta" : me,
        login: i % 3 === 0 ? "mira-holt" : i % 3 === 1 ? "s-ohta" : me,
        // The tail of the list falls on the PREVIOUS day, so the day grouping
        // is something a screenshot shows rather than a code path nobody sees.
        date: ISO(2.2 + i * 3),
        verified: i === 2,
      })),
    ],
  };

  const mkRun = (o) => Object.assign({
    runNumber: 0, runAttempt: 1, displayTitle: o.name, headSha: "9f8e7d6aa11", updatedAt: o.createdAt,
    runStartedAt: o.createdAt, actor: u(me), triggeringActor: null, workflowId: 1,
    workflowPath: ".github/workflows/desktop.yml", headCommitMessage: "release: extension 1.11.1",
    headCommitAuthor: "Anton Arnaudov", pullRequests: [],
  }, o);
  const runs = [
    mkRun({ id: 9101, runNumber: 412, name: "Desktop CI", workflowId: 1, displayTitle: "issues: full-page detail as a routed state", status: "in_progress", conclusion: "", branch: "redesign/issues-detail", event: "push", createdAt: ISO(0.4), updatedAt: ISO(0.1), runStartedAt: ISO(0.39), htmlUrl: "", actor: u(me) }),
    mkRun({ id: 9100, runNumber: 411, name: "Desktop CI", workflowId: 1, displayTitle: "release: extension 1.11.1", status: "completed", conclusion: "success", branch: "main", event: "push", createdAt: ISO(3), updatedAt: ISO(2.8), runStartedAt: ISO(2.99), htmlUrl: "", actor: u(me), pullRequests: [{ number: 106 }] }),
    mkRun({ id: 9099, runNumber: 233, name: "Extension CI", workflowId: 2, displayTitle: "test: drive update-refs end-to-end", status: "completed", conclusion: "success", branch: "main", event: "push", createdAt: ISO(5), updatedAt: ISO(4.9), htmlUrl: "", actor: u("mira-holt") }),
    mkRun({ id: 9097, runNumber: 410, runAttempt: 2, name: "Desktop CI", workflowId: 1, displayTitle: "actions: stream job logs over IPC", status: "completed", conclusion: "failure", branch: "fix/log-stream", event: "pull_request", createdAt: ISO(8), updatedAt: ISO(7.7), htmlUrl: "", actor: u("s-ohta"), triggeringActor: u(me), pullRequests: [{ number: 104 }] }),
    mkRun({ id: 9095, runNumber: 88, name: "Nightly release", workflowId: 3, displayTitle: "Nightly release", status: "completed", conclusion: "success", branch: "main", event: "schedule", createdAt: ISO(26), updatedAt: ISO(25.7), htmlUrl: "", actor: u("renderbot") }),
    // CANCELLED — somebody stopped it, which is not a failure and is a state
    // the fixture had none of, so the list's icon bucket for it was never seen.
    mkRun({ id: 9094, runNumber: 409, name: "Desktop CI", workflowId: 1, displayTitle: "spike: try CodeMirror instead of Monaco", status: "completed", conclusion: "cancelled", branch: "spike/monaco-swap", event: "push", createdAt: ISO(30), updatedAt: ISO(29.8), runStartedAt: ISO(29.9), htmlUrl: "", actor: u("s-ohta") }),
  ];

  const notifications = [
    { id: "n1", title: "Split views make Issues and PRs unreadable on a 13\" screen", type: "Issue", reason: "assign", repo: "GitStudioHQ/gitstudio", repoAvatarUrl: null, updatedAt: ISO(1), unread: true, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/issues/31", subjectKind: "issue", subjectNumber: 31 },
    { id: "n2", title: "desktop: full-page detail views for Issues (kills the split pane)", type: "PullRequest", reason: "review_requested", repo: "GitStudioHQ/gitstudio", repoAvatarUrl: null, updatedAt: ISO(2), unread: true, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/pull/106", subjectKind: "pull", subjectNumber: 106 },
    { id: "n3", title: "v6.2 breaks xterm addon-fit measurements", type: "Issue", reason: "subscribed", repo: "xtermjs/xterm.js", repoAvatarUrl: null, updatedAt: ISO(7), unread: true, htmlUrl: "https://github.com/xtermjs/xterm.js/issues/5120" },
    { id: "n4", title: "Nightly release failed: notarization timeout", type: "CheckSuite", reason: "ci_activity", repo: "GitStudioHQ/gitstudio", repoAvatarUrl: null, updatedAt: ISO(20), unread: false, htmlUrl: "", subjectKind: "other" },
    { id: "n6", title: "Extension 1.11.1", type: "Release", reason: "subscribed", repo: "GitStudioHQ/gitstudio", repoAvatarUrl: null, updatedAt: ISO(40), unread: true, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/releases/51", subjectKind: "release", subjectNumber: 51 },
    { id: "n7", title: "release: extension 1.11.1", type: "Commit", reason: "author", repo: "GitStudioHQ/gitstudio", repoAvatarUrl: null, updatedAt: ISO(41), unread: false, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/commit/9f8e7d6", subjectKind: "commit", subjectSha: "9f8e7d6" },
    { id: "n5", title: "engine: per-line staging groundwork (hunk splitting)", type: "PullRequest", reason: "mention", repo: "GitStudioHQ/gitstudio", repoAvatarUrl: null, updatedAt: ISO(30), unread: false, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/pull/103" },
  ];

  const releases = [
    // A PUBLISHED pre-release, newer than the newest stable — the ordinary shape
    // of a repo mid-release-cycle, and the one that exposes whether "Latest"
    // follows github.com's rule (newest published NON-pre-release) or just picks
    // the newest published thing. The only prerelease here used to also be a
    // draft, so the distinction was never exercised.
    { id: 52, tagName: "desktop-v1.7.0-rc.1", targetCommitish: "main", name: "Desktop 1.7.0 RC 1", draft: false, prerelease: true, htmlUrl: "", author: u(me), createdAt: ISO(8), publishedAt: ISO(8), assets: [], body: "Release candidate — please test." },
    { id: 51, tagName: "ext-v1.11.1", targetCommitish: "main", name: "Extension 1.11.1", draft: false, prerelease: false, htmlUrl: "", author: u(me), createdAt: ISO(40), publishedAt: ISO(40), assets: [ { id: 1, name: "gitstudio-1.11.1.vsix", label: null, contentType: "application/zip", size: 4830210, downloadCount: 1240, downloadUrl: "", createdAt: ISO(40), updatedAt: ISO(40) } ], body: "### Fixes\n- Drive the update-refs end-to-end through the shipping runner\n- Graph: keep-alive across view switches" },
    { id: 50, tagName: "desktop-v1.5.1", targetCommitish: "main", name: "Desktop 1.5.1", draft: false, prerelease: false, htmlUrl: "", author: u(me), createdAt: ISO(60), publishedAt: ISO(58), assets: [ { id: 2, name: "GitStudio-1.5.1-arm64.dmg", label: null, contentType: "application/x-apple-diskimage", size: 128400000, downloadCount: 356, downloadUrl: "", createdAt: ISO(58), updatedAt: ISO(58) }, { id: 3, name: "GitStudio-1.5.1-x64.dmg", label: null, contentType: "application/x-apple-diskimage", size: 131200000, downloadCount: 121, downloadUrl: "", createdAt: ISO(58), updatedAt: ISO(58) } ], body: "### Highlights\n- Drag a commit in the graph to reorder it\n- Rebase carries other branches when asked" },
    { id: 49, tagName: "desktop-v1.6.0-beta.1", targetCommitish: "main", name: "Desktop 1.6.0 beta 1", draft: true, prerelease: true, htmlUrl: "", author: u(me), createdAt: ISO(12), publishedAt: null, assets: [], body: "The redesign preview build." },
  ];

  let branches = [
    // As git ≥2.41 actually reports it: the default branch is "merged" into
    // itself (aheadDefault 0), and only isDefault says so. A cleanup counter
    // that ignores the flag offers to tidy away main, forever — the fixture
    // carries the trap so a check can prove the counter steps over it.
    { name: "main", current: true, isDefault: true, merged: true, aheadDefault: 0, behindDefault: 0, upstream: "origin/main", ahead: 2, behind: 0, subject: "release: extension 1.11.1", tipAuthor: { name: "Anton Arnaudov", email: "12345+antonarnaudov@users.noreply.github.com" }, date: S(40) },
    // aheadDefault/behindDefault are divergence from the DEFAULT branch, which
    // is a different question from the upstream pair — and `aheadDefault === 0`
    // is what "merged, safe to delete" means.
    { name: "redesign/issues-detail", current: false, aheadDefault: 5, behindDefault: 0, upstream: "origin/redesign/issues-detail", ahead: 0, behind: 0, subject: "issues: full-page detail as a routed state", tipAuthor: { name: "Mira Holt", email: "mira@example.com" }, date: S(1) },
    { name: "fix/log-stream", current: false, aheadDefault: 2, behindDefault: 12, upstream: undefined, ahead: 0, behind: 0, subject: "actions: stream job logs with backpressure", tipAuthor: { name: "Sora Ohta", email: "sora@example.com" }, date: S(8) },
    // The state every merged pull request leaves behind: the upstream is gone,
    // and without the flag the row reads "0 ahead, 0 behind" — in sync with a
    // remote that does not exist.
    { name: "redesign/wave-1", current: false, aheadDefault: 0, behindDefault: 40, merged: true, upstream: "origin/redesign/wave-1", ahead: 0, behind: 0, gone: true, subject: "issues: section pages land", tipAuthor: { name: "Anton Arnaudov", email: "12345+antonarnaudov@users.noreply.github.com" }, date: S(56) },
    { name: "feat/line-staging", current: false, aheadDefault: 18, behindDefault: 3, upstream: "origin/feat/line-staging", ahead: 3, behind: 5, subject: "engine: hunk splitting groundwork", tipAuthor: { name: "Mira Holt", email: "mira@example.com" }, date: S(20) },
    // STALE — past the 90-day line the Active/Stale cut is drawn at. Every
    // branch above is hours old, so before these two the Stale segment read
    // "(0)" and every check of that cut passed by testing an empty filter
    // against an empty result. One is merged (so it also lands in the sweep),
    // one is not (so "Stale" cannot be mistaken for "finished").
    { name: "spike/monaco-swap", current: false, aheadDefault: 4, behindDefault: 210, upstream: undefined, ahead: 0, behind: 0, subject: "spike: try CodeMirror instead of Monaco", date: S(24 * 140) },
    { name: "chore/deps-2024", current: false, aheadDefault: 0, behindDefault: 190, merged: true, upstream: "origin/chore/deps-2024", ahead: 0, behind: 0, subject: "chore: bump every dependency", date: S(24 * 200) },
  ];

  // ?onfeature=1 → HEAD is a feature branch, so the DEFAULT branch is in the
  // list without being current. That is the only state in which the sweep's
  // worst bug is reachable: `merged` means "zero commits ahead of the default
  // branch", which the default branch satisfies against itself, so main was
  // offered for deletion by name — and every other fixture here keeps main
  // checked out, where `!b.current` hides it.
  if (params.get("onfeature")) {
    for (const b of branches) b.current = b.name === "redesign/issues-detail";
    // And main then carries what the bridge really computes for it. `merged` is
    // `%(ahead-behind:<default>)`'s ahead === 0, and main measured against main
    // is 0/0 — so the flag is not a fixture convenience here, it is the value
    // the app receives. Without it this scene renders a main that no filter
    // could ever have swept, and the check passes on a broken build.
    const m = branches.find((b) => b.name === "main");
    if (m) { m.merged = true; m.aheadDefault = 0; m.behindDefault = 0; }
  }

  // ?dashbranch=1 → a branch named "-f", which porcelain never makes but
  // `git update-ref refs/heads/-f` does. Its checkout is refused (git would
  // read "-f" as an option) — and the refusal has to say THAT, and offer the
  // rename, rather than "That value isn't a valid git reference".
  if (params.get("dashbranch")) {
    branches.push({ name: "-f", current: false, aheadDefault: 1, behindDefault: 0, upstream: undefined, ahead: 0, behind: 0, subject: "made by update-ref", date: S(3) });
  }

  // ?collide=1 → git's SHORT names stop being names (issue #30's follow-up),
  // with the values git really prints: a tag "main" beside the default branch
  // (listed "heads/main"), a branch and a tag "release" ("heads/release" /
  // "tags/release"), and a LOCAL branch "origin/sl" beside the remote-tracking
  // origin/sl ("heads/origin/sl" / "remotes/origin/sl"), which a local "sl"
  // tracks. HEAD is on a feature branch, so main is the default and not the
  // current one. Every label must still be the ref's own name.
  if (params.get("collide")) {
    for (const b of branches) b.current = b.name === "redesign/issues-detail";
    const m = branches.find((b) => b.name === "main");
    if (m) Object.assign(m, { name: "heads/main", fullName: "refs/heads/main", upstreamRef: "refs/remotes/origin/main" });
    branches.push(
      { name: "heads/release", fullName: "refs/heads/release", current: false, aheadDefault: 1, behindDefault: 0, upstream: "origin/release", upstreamRef: "refs/remotes/origin/release", ahead: 0, behind: 0, subject: "release work", date: S(5) },
      { name: "sl", fullName: "refs/heads/sl", current: false, aheadDefault: 1, behindDefault: 0, upstream: "remotes/origin/sl", upstreamRef: "refs/remotes/origin/sl", ahead: 0, behind: 1, subject: "sl one", date: S(6) },
      { name: "heads/origin/sl", fullName: "refs/heads/origin/sl", current: false, aheadDefault: 2, behindDefault: 0, upstream: undefined, ahead: 0, behind: 0, subject: "a branch named like a remote one", date: S(7) },
    );
  }

  const workflows = [
    { id: 1, name: "Desktop CI", path: ".github/workflows/desktop.yml", state: "active", htmlUrl: "" },
    { id: 2, name: "Extension CI", path: ".github/workflows/extension.yml", state: "active", htmlUrl: "" },
    { id: 3, name: "Nightly release", path: ".github/workflows/nightly.yml", state: "active", htmlUrl: "" },
  ];

  const orgs = [
    { login: "GitStudioHQ", name: "GitStudio", avatarUrl: null, description: "The open-source Git workspace — desktop app + VS Code extension.", htmlUrl: "https://github.com/GitStudioHQ" },
  ];
  const orgRepos = [
    { name: "gitstudio", fullName: "GitStudioHQ/gitstudio", htmlUrl: "", description: "Monorepo: desktop app, VS Code extension, engine, git-service.", private: false, fork: false, archived: false, language: "TypeScript", stargazersCount: 2140, pushedAt: ISO(1) },
    { name: "gistudio.dev", fullName: "GitStudioHQ/gistudio.dev", htmlUrl: "", description: "Marketing site + error collector.", private: false, fork: false, archived: false, language: "TypeScript", stargazersCount: 84, pushedAt: ISO(60) },
    { name: "design", fullName: "GitStudioHQ/design", htmlUrl: "", description: "Brand + product design assets.", private: true, fork: false, archived: false, language: null, stargazersCount: 0, pushedAt: ISO(120) },
  ];

  const gists = [
    { id: "g1", description: "GitStudio release checklist", public: false, htmlUrl: "", owner: u(me), createdAt: ISO(300), updatedAt: ISO(48), fileCount: 1, comments: 0, files: [{ filename: "RELEASE.md", language: "Markdown", type: "text/markdown", size: 2400, rawUrl: "", content: "# Release checklist\n\n1. `npm run check-types`\n2. Tag + push\n3. Notarize", truncated: false }] },
    // Two files, so the gist detail's FILE TABS have something to render — the
    // single-file fixture never exercised that path at all.
    { id: "g2", description: "zsh: git aliases", public: true, htmlUrl: "", owner: u(me), createdAt: ISO(1000), updatedAt: ISO(700), fileCount: 2, comments: 2, files: [{ filename: "aliases.zsh", language: "Shell", type: "text/plain", size: 812, rawUrl: "", content: "alias gs='git status'\nalias gl='git log --oneline -20'", truncated: false }, { filename: "functions.zsh", language: "Shell", type: "text/plain", size: 460, rawUrl: "", content: "gco() { git checkout \"$@\"; }", truncated: false }] },
  ];

  const projects = [
    { id: "p1", number: 1, title: "Desktop redesign", shortDescription: "Linear-grade UX for every surface", url: "", itemCount: 14, closed: false, updatedAt: ISO(2) },
    { id: "p2", number: 2, title: "v2.0", shortDescription: "", url: "", itemCount: 32, closed: false, updatedAt: ISO(50) },
  ];
  const board = {
    field: { id: "f1", name: "Status", options: [ { id: "o1", name: "Todo", color: "GRAY" }, { id: "o2", name: "In progress", color: "YELLOW" }, { id: "o3", name: "Done", color: "GREEN" } ] },
    items: [
      { id: "i1", type: "ISSUE", title: "Split views make Issues and PRs unreadable", number: 31, state: "OPEN", url: null, author: "mira-holt", statusOptionId: "o2", statusName: "In progress", updatedAt: ISO(2) },
      { id: "i2", type: "PULL_REQUEST", title: "Full-page detail views for Issues", number: 106, state: "OPEN", url: null, author: me, statusOptionId: "o2", statusName: "In progress", updatedAt: ISO(1) },
      { id: "i3", type: "ISSUE", title: "Notifications keyboard triage", number: 29, state: "OPEN", url: null, author: "jparks", statusOptionId: "o1", statusName: "Todo", updatedAt: ISO(16) },
      { id: "i4", type: "ISSUE", title: "Graph avatars blur on 1x displays", number: 25, state: "OPEN", url: null, author: "jparks", statusOptionId: "o1", statusName: "Todo", updatedAt: ISO(70) },
      { id: "i5", type: "ISSUE", title: "Stash view untracked files", number: 21, state: "CLOSED", url: null, author: "s-ohta", statusOptionId: "o3", statusName: "Done", updatedAt: ISO(130) },
    ],
  };

  // ?longnames=1 gives the branch list the names real repositories actually
  // carry. Every fixture name here is short enough to fit whatever the row
  // gives it, so the one thing the owner reported — long names cut off — was
  // structurally unreachable in this harness.
  if (params.get("longnames")) {
    for (const b of branches) {
      if (b.current) continue;
      b.name = "feature/" + b.name + "-with-a-realistically-long-descriptive-name";
      if (b.upstream) b.upstream = "origin/" + b.name;
    }
  }

  // ?tworemotes=1 gives two branches upstreams on DIFFERENT remotes, which is
  // what makes the "Remote" filter a real choice. The default fixture has one
  // remote, where that menu can only offer the state the list is already in.
  if (params.get("tworemotes")) {
    const forked = branches.filter((b) => b.upstream)[0];
    if (forked) forked.upstream = "upstream/" + forked.name;
  }

  let changedFiles = [
    { path: "apps/desktop/src/renderer/views/issues.ts", status: "M", staged: true },
    { path: "apps/desktop/src/renderer/views/common.ts", status: "M", staged: true },
    { path: "apps/desktop/src/renderer/styles/app.css", status: "M", staged: false },
    { path: "apps/desktop/src/renderer/views/prs.ts", status: "M", staged: false },
    { path: "docs/redesign.md", status: "A", staged: false },
    // A PARTIALLY-staged file: git's `MM` — a staged edit plus a newer unstaged
    // one — which the parser correctly reports as two records for one path.
    // Without one in the fixture, the checkbox model's duplicate-row bug was
    // invisible to every check here.
    { path: "apps/desktop/src/renderer/renderer.ts", status: "M", staged: true },
    { path: "apps/desktop/src/renderer/renderer.ts", status: "M", staged: false },
  ];
  // ?ws=1 adds a file whose ONLY change is whitespace — one re-indented line
  // and one with trailing spaces. Split computes in-process and Inline computes
  // in Monaco's worker, so the whitespace toggle is the one setting the two
  // implementations can read differently, and nothing here could see them
  // disagree without such a file. It is behind a switch because every other
  // check counts the rows in this list.
  if (params.get("ws")) {
    changedFiles.push({ path: "packages/engine/src/spacing.ts", status: "M", staged: false });
    changedFiles.push({ path: "packages/engine/src/spacing-inner.ts", status: "M", staged: false });
  }

  /** Serial for the PTY ids `terminal:create` hands out. */
  let ptySeq = 0;

  /**
   * What ?diverged=1's pulls have done so far — read by `sync:pull`,
   * `sync:status`, `branches:list` and `git:opState`, which all describe the
   * same repository and must move together.
   */
  const pullState = {
    /** The first pull fetched: the remote is further ahead than the badge said. */
    fetched: false,
    /** A pull with a mode completed. */
    done: false,
    /** A pull with a mode stopped on conflicts (?pullconflict=1). */
    stopped: null,
    behind() {
      return this.fetched ? 5 : 3;
    },
  };

  const fixtures = {
    // ?norepo=1 → NO repository open, which is the welcome screen: the first
    // thing anyone sees, the only screen shown after closing a repo, and
    // unreachable in this harness until now — which is why nothing had ever
    // checked it.
    "repo:current": params.get("norepo")
      ? undefined
      : { root: "/Users/anton/Developer/GitStudioHQ/gitstudio", name: "gitstudio" },
    "repo:recent": [
      { root: "/Users/anton/Developer/GitStudioHQ/gitstudio", name: "gitstudio" },
      { root: "/Users/anton/Developer/GitStudioHQ/gistudio.dev", name: "gistudio.dev" },
    ],
    // `github:status` is DYNAMIC below, not here: a fixture that never changes
    // cannot express signing out, which is why nothing could see that the
    // top-bar chip kept naming the account you had just left.
    // `sync:status` is DYNAMIC below: with ?diverged=1 the pull itself moves
    // it (its fetch finds more of the remote), and a value captured here could
    // not show a badge going stale.
    // Every KIND of ref, because the Branches view has one screen per kind and
    // the fixture used to hold local heads ONLY — so the remote, tag and stash
    // row shapes were never once rendered, screenshotted or checked.
    "refs:list": [
      ...branches.map((b) => ({
        type: "head",
        name: b.name,
        // A branch git lists under a disambiguated short name (?collide=1)
        // carries its own full name; every other one is refs/heads/<name>.
        fullName: b.fullName ?? "refs/heads/" + b.name,
        sha: "abc123",
        isCurrent: b.current,
        upstream: b.upstream,
        gone: b.gone,
        date: b.date,
        subject: b.subject,
      })),
      // The remote's own HEAD: `%(refname:short)` of it is the bare remote NAME
      // ("origin"), which is why the old `endsWith("/HEAD")` guard never fired
      // and a phantom row called "origin" sat in the list offering to check out
      // nothing. Its symref names the DEFAULT branch, which IS worth keeping.
      { type: "remote", name: "origin", fullName: "refs/remotes/origin/HEAD", sha: "9f8e7d6", isCurrent: false, symref: "origin/main" },
      { type: "remote", name: "origin/main", fullName: "refs/remotes/origin/main", sha: "9f8e7d6", isCurrent: false, date: S(40), subject: "release: extension 1.11.1" },
      { type: "remote", name: "origin/redesign/issues-detail", fullName: "refs/remotes/origin/redesign/issues-detail", sha: "a1b2c3d", isCurrent: false, date: S(1), subject: "issues: full-page detail as a routed state", who: { name: "Mira Holt", email: "mira@example.com" } },
      { type: "remote", name: "origin/feat/line-staging", fullName: "refs/remotes/origin/feat/line-staging", sha: "18c9d0e", isCurrent: false, date: S(20), subject: "engine: hunk splitting groundwork", who: { name: "Sora Ohta", email: "sora@example.com" } },
      { type: "remote", name: "origin/chore/dependabot-bump", fullName: "refs/remotes/origin/chore/dependabot-bump", sha: "77aa88b", isCurrent: false, date: S(200), subject: "build(deps): bump electron to 33.4.11", who: { name: "dependabot[bot]", email: "49699333+dependabot[bot]@users.noreply.github.com" } },
      // Annotated and lightweight — the distinction nothing has ever carried.
      { type: "tag", name: "ext-v1.11.1", fullName: "refs/tags/ext-v1.11.1", sha: "e5f6a7b", isCurrent: false, objectType: "tag", date: S(40), subject: "Extension 1.11.1", who: { name: "Anton Arnaudov", email: "12345+antonarnaudov@users.noreply.github.com", tagger: true } },
      { type: "tag", name: "desktop-v1.5.1", fullName: "refs/tags/desktop-v1.5.1", sha: "d4e5f6a", isCurrent: false, objectType: "tag", date: S(58), subject: "Desktop 1.5.1", who: { name: "Anton Arnaudov", email: "12345+antonarnaudov@users.noreply.github.com", tagger: true } },
      { type: "tag", name: "nightly", fullName: "refs/tags/nightly", sha: "9f8e7d6", isCurrent: false, objectType: "commit", date: S(26), subject: "release: extension 1.11.1" , who: { name: "Sora Ohta", email: "sora@example.com" } },
    ],
    "head:get": { detached: false, branch: "main", sha: "9f8e7d6" },
    // More than one, so the Worktrees segment exists at all — the four
    // worktree channels have been in the IPC contract since it was written
    // with no caller in any view, and no fixture either.
    "worktree:list": [
      { path: "/Users/anton/Developer/GitStudioHQ/gitstudio", head: "9f8e7d6aa11", branch: "main", current: true },
      { path: "/Users/anton/Developer/GitStudioHQ/gitstudio-wave2", head: "a1b2c3d4e5f", branch: "redesign/issues-detail" },
      { path: "/Users/anton/Developer/GitStudioHQ/gitstudio-hotfix", head: "77aa88b9c0d", branch: "fix/log-stream", prunable: true },
    ],
    // NOTE: `branches:list` lives in `dynamic` — deleting one replaces the
    // array, and a value captured here would keep answering with the old list.
    // The Rebase view had no fixture, so every screenshot of it was its ERROR
    // state — the one surface nobody could actually look at.
    // Compare had no fixture either — every shot of it was "Couldn't compare
    // these refs".
    // Compare's file DIFF. Without it every file in a comparison rendered the
    // "nothing to show" state, so the pane the view exists for was never
    // exercised — and the state it fell into was a positive claim ("identical
    // content") the app had no basis for. A fixture the harness cannot express
    // is a defect the harness cannot catch.
    "compare:refs": {
      // 27 rows listed against 27 ahead — a count that is silently a cap is
      // worse than no count, so the two must agree unless the note says why.
      ahead: 27,
      behind: 2,
      commits: [
        { sha: "18c9d0e1f2736485a1b2", shortSha: "18c9d0e", subject: "engine: hunk splitting groundwork", author: "Mira Holt", date: S(20 * 60) },
        { sha: "27b8c9d0e1f263748596", shortSha: "27b8c9d", subject: "engine: split a hunk on a selection boundary", author: "Anton Arnaudov", date: S(18 * 60) },
        { sha: "36a7b8c9d0e152637485", shortSha: "36a7b8c", subject: "changes: stage the lines a selection touches", author: "Sora Ohta", date: S(9 * 60), body: "Translates the selection through the index\u2192working diff first, so the\nranges match the side git is being asked about.", isMerge: false },
        // Enough rows that the list OVERFLOWS its pane. Compare's scroller was
        // deleted with the old row styles and nothing noticed, because three
        // commits fit — the surface has to be taller than the box to prove it.
        ...Array.from({ length: 24 }, (_, i) => ({
          sha: `4${i}b7c8d9e0f1a2b3c4d5`,
          shortSha: `4${i}b7c8d`,
          subject: [
            "engine: fold adjacent hunks before scoring",
            "engine: keep the trailing newline out of the span",
            "changes: reuse the index text across ticks",
            "graph: lanes survive a reordered parent",
          ][i % 4],
          author: ["Mira Holt", "Anton Arnaudov", "Sora Ohta"][i % 3],
          date: S((8 - i * 0.25) * 60),
          isMerge: i % 8 === 7,
        })),
      ],
      files: [
        { path: "packages/engine/src/hunks.ts", status: "M" },
        { path: "packages/engine/src/hunkSplit.ts", status: "A" },
        { path: "apps/desktop/src/renderer/diffPanel.ts", status: "M" },
        { path: "apps/desktop/src/renderer/legacyHunks.ts", status: "D" },
        { path: "packages/engine/test/hunkSplit.test.ts", status: "A" },
      ],
    },
    "rebase:load": {
      ok: true,
      base: "origin/main",
      branch: "feat/line-staging",
      inProgress: false,
      baseCommit: { shortSha: "9f8e7d6", subject: "release: extension 1.11.1" },
      // NEWEST FIRST, the order `loadCommits` returns (`git log --topo-order`,
      // no --reverse) and the order the hint bar promises. Listed oldest-first
      // this fixture put every fold target on the wrong side: a `fixup!` row
      // said it folded into the commit ABOVE the one its own subject names, and
      // the "oldest commit has nothing below it" guard fired on the NEWEST
      // commit — while the screenshot ran 20h → 2h downward under a hint
      // reading "Newest first".
      commits: [
        { sha: "5485767869c930415263", shortSha: "5485767", author: "Anton Arnaudov", subject: "wip: notes to self", rel: "2h ago" },
        { sha: "45968797c9d041526374", shortSha: "4596879", author: "Sora Ohta", subject: "changes: stage the lines a selection touches", rel: "9h ago" },
        { sha: "36a7b8c9d0e152637485", shortSha: "36a7b8c", author: "Anton Arnaudov", subject: "fixup! engine: split a hunk on a selection boundary", rel: "16h ago" },
        { sha: "27b8c9d0e1f263748596", shortSha: "27b8c9d", author: "Anton Arnaudov", subject: "engine: split a hunk on a selection boundary", rel: "18h ago" },
        { sha: "18c9d0e1f2736485a1b2", shortSha: "18c9d0e", author: "Mira Holt", subject: "engine: hunk splitting groundwork", rel: "20h ago" },
      ],
    },
    // NOTE: `stash:list` lives in `dynamic` — dropping one replaces the array.
    // ?clean=1 → a CLEAN working tree. The app must handle it — it is the state
    // a repository spends most of its life in — and nothing else in this shim
    // can produce it, so the Changes view's empty state, its composer's enable
    // rule and its toolbar were all only ever exercised with work present.
    // NOTE: `status` lives in `dynamic` (below) rather than here, because a
    // discard replaces the array and a value captured at map-build time would
    // keep answering with the pre-discard list.
    // `?op=merge|rebase|cherry-pick|revert` puts the Changes banner on screen.
    // Without a fixture the banner NEVER rendered in the harness, which is why
    // no check could see that its Abort ran `git merge --abort` on every one of
    // the four operations it names.
    // `?op=merge|rebase|cherry-pick|revert|am` puts the Changes banner on
    // screen, `&conflicts=N` gives it conflicts, `&skip=1` puts it in the
    // "nothing left to commit" shape where Skip is the way out.
    //
    // The whole GitOpState shape, `kind`/`canContinue`/`canSkip` included: the
    // host decides those now, and a fixture that returns only the old booleans
    // makes the banner render NOTHING — which is exactly what this fixture's
    // own check caught when the banner was rewritten.
    "git:opState": (() => {
      const op = params.get("op") || "";
      const conflicts = Number(params.get("conflicts") || 0) || 0;
      const emptied = params.get("skip") === "1";
      // Mirrors gitBridge's own rules: there is no `merge --skip`, and a rebase
      // only offers Skip on the apply backend's emptied patch.
      const canSkip = emptied && (op === "cherry-pick" || op === "revert" || op === "am");
      return {
        merging: op === "merge",
        rebasing: op === "rebase",
        amApplying: op === "am",
        cherryPicking: op === "cherry-pick",
        reverting: op === "revert",
        conflicts,
        kind: op || null,
        canContinue: !!op && conflicts === 0 && !emptied,
        canSkip,
        nothingToCommit: emptied,
      };
    })(),
    "diff:files": changedFiles,
    "notifications:unreadCount": 3,
    "notifications:list": notifications,
    "issue:list": issues,
    "issue:labels": Object.values(L).map((l) => ({ ...l, description: null })),
    // The pull request's own label list. Missing entirely, so `doLabels` read
    // undefined off it and threw into the unhandled-rejection boundary — the
    // PR label picker could not be opened in the harness at all, which is why
    // nothing had ever checked it.
    "pr:labels": Object.values(L).map((l) => ({ ...l, description: null })),
    "issue:milestones": [
      { number: 5, title: "Desktop 1.6 — the redesign", state: "open", openIssues: 6, closedIssues: 3 },
      { number: 4, title: "Extension 1.12", state: "open", openIssues: 2, closedIssues: 1 },
    ],
    "pr:list": prs,
    "pr:reviewers": [u(me), u("mira-holt"), u("s-ohta"), u("dkovachev"), u("jparks")],
    "pr:branches": branches.map((b) => ({ name: b.name, isDefault: b.name === "main" })),
    "actions:runs": runs,
    "actions:workflows": workflows,
    "release:list": releases,
    "release:tags": [ { name: "ext-v1.11.1", sha: "e5f6a7b" }, { name: "desktop-v1.5.1", sha: "d4e5f6a" } ],
    "orgs:list": orgs,
    "gist:list": gists,
    // `?partial=1`: GitHub named one more project than it could return (one in
    // a repository the account can no longer see) — the list says so.
    "project:list": { projects, unreadable: params.get("partial") ? 1 : 0 },
    "git:identity": { name: "Anton Arnaudov", email: "anton@gitstudio.dev" },
    // NOTE: {scope:"all"} is answered by the dynamic handler below — the
    // cross-repo answer carries `repo` on every item and includes two items
    // sharing one number in different repos, which a number-only dedupe
    // silently collapses. This bare-payload fixture stays the repo-scoped one.
    "github:myWork": [
      { kind: "review-requested", type: "pr", number: 104, title: "actions: stream job logs over IPC with backpressure", state: "open", draft: false, updatedAt: ISO(2), comments: 2, author: "s-ohta" },
      { kind: "review-requested", type: "pr", number: 103, title: "engine: per-line staging groundwork (hunk splitting)", state: "open", draft: true, updatedAt: ISO(6), comments: 11, author: "dkovachev" },
      { kind: "assigned", type: "issue", number: 31, title: "Split views make Issues and PRs unreadable on a 13\" screen", state: "open", draft: false, updatedAt: ISO(2), comments: 6, author: "mira-holt" },
      { kind: "assigned", type: "issue", number: 28, title: "Rebase drag-to-reorder flickers when dropping on the last row", state: "open", draft: false, updatedAt: ISO(28), comments: 1, author: me },
      { kind: "my-prs", type: "pr", number: 106, title: "desktop: full-page detail views for Issues (kills the split pane)", state: "open", draft: false, updatedAt: ISO(1), comments: 4, author: me },
      { kind: "mentions", type: "issue", number: 27, title: "Support per-line staging, not just blocks", state: "open", draft: false, updatedAt: ISO(40), comments: 9, author: "dkovachev" },
    ],
    // `dockSwappable: true` is the majority case — Windows, Linux and macOS 11–25,
    // where dock.setIcon works and Settings offers the App icon control. macOS 26
    // answers false and the control is hidden; the `nodock` scene covers that.
    "app:info": { version: "1.5.1", platform: "darwin" },
    "github:userInfo": { login: "antonarnaudov", name: "Anton Arnaudov", avatarUrl: null, bio: "Building GitStudio — the open-source Git workspace.", company: "@GitStudioHQ", location: "Sofia, Bulgaria", blog: "gistudio.dev", htmlUrl: "https://github.com/antonarnaudov", followers: 412, following: 63, publicRepos: 24, createdAt: ISO(3000), type: "User", twitter: "antonarnaudov", email: null },
    // The graph is the app's centrepiece and was unreviewable with an empty
    // fixture. This is a realistic small history: a merged feature branch, a
    // second lane still open, ref chips on the tips, and a tagged release.
    "graph:load": (() => {
      const seg = (from, to, color) => ({ fromColumn: from, toColumn: to, color });
      // As wireRefs sends them: git's short name AND the full name.
      const ref = (name, kind) => ({
        name,
        kind,
        fullName: kind === "tag" ? "refs/tags/" + name : kind === "remoteHead" ? "refs/remotes/" + name : "refs/heads/" + name,
      });
      const row = (o) => ({
        sha: o.sha,
        shortSha: o.sha.slice(0, 7),
        column: o.column || 0,
        color: o.color || 0,
        isMerge: !!o.isMerge,
        segments: o.segments || [seg(o.column || 0, o.column || 0, o.color || 0)],
        subject: o.subject,
        author: o.author || "Anton Arnaudov",
        authorEmail: "anton@gitstudio.dev",
        authorDate: Math.floor(Date.now() / 1000) - (o.h || 1) * 3600,
        refs: o.refs || [],
      });
      const rows = [
        row({ sha: "9f8e7d6c5b4a39281706", subject: "release: extension 1.11.1", h: 1,
              refs: [ref("main", "currentHead"), ref("origin/main", "remoteHead"), ref("ext-v1.11.1", "tag")] }),
        row({ sha: "a1b2c3d4e5f60718293a", subject: "Merge pull request #106 from redesign/issues-detail", h: 3,
              isMerge: true, segments: [seg(0, 0, 0), seg(1, 0, 1)] }),
        row({ sha: "b2c3d4e5f6a71829304b", subject: "issues: full-page detail as a routed state", h: 5,
              column: 1, color: 1, segments: [seg(0, 0, 0), seg(1, 1, 1)],
              refs: [ref("redesign/issues-detail", "head")] }),
        row({ sha: "c3d4e5f6a7b829304c5d", subject: "common: sectionList + secRow primitives", h: 8,
              column: 1, color: 1, segments: [seg(0, 0, 0), seg(1, 1, 1)], author: "Mira Holt" }),
        row({ sha: "d4e5f6a7b8c930415d6e", subject: "actions: stream job logs with backpressure", h: 26,
              segments: [seg(0, 0, 0), seg(1, 1, 1)], author: "S. Ohta" }),
        row({ sha: "e5f6a7b8c9d041526e7f", subject: "engine: hunk splitting groundwork", h: 30,
              segments: [seg(0, 0, 0), seg(1, 1, 1)], author: "D. Kovachev" }),
        row({ sha: "f6a7b8c9d0e152637f80", subject: "release: extension 1.11.0, desktop 1.5.1", h: 48,
              refs: [ref("desktop-v1.5.1", "tag")] }),
        row({ sha: "07b8c9d0e1f263748091", subject: "feat(ext): drag a commit in the graph to reorder it", h: 52 }),
        row({ sha: "18c9d0e1f2736485a1b2", subject: "feat(git-service): let a rebase carry other branches with it", h: 70, author: "Mira Holt" }),
        // An old, unmerged remote branch forked from the oldest commit: the one
        // row that NO local branch reaches, so the branch filter (issue #30)
        // has a row to drop and not only chips. `reachOnly` below says so.
        row({ sha: "77aa88b9c0d1e2f3a4b5", subject: "build(deps): bump electron to 33.4.11", h: 90, author: "dependabot[bot]",
              column: 1, color: 2, segments: [seg(0, 0, 0), seg(1, 1, 2)],
              refs: [ref("origin/chore/dependabot-bump", "remoteHead")] }),
        row({ sha: "29d0e1f2837495b2c3d4", subject: "fix(graph): avatars blur on non-retina displays", h: 96, author: "J. Parks",
              segments: [seg(0, 0, 0), seg(1, 0, 2)] }),
      ];
      return { rows, head: "9f8e7d6c5b4a39281706", totalColumns: 2, hasMore: false, nextSkip: rows.length };
    })(),
    "repo:headCommit": { sha: "9f8e7d6", shortSha: "9f8e7d", author: "Anton Arnaudov", authorEmail: "anton@gitstudio.dev", date: S(40), subject: "release: extension 1.11.1", message: "release: extension 1.11.1", total: 512 },
    "repo:tree": [],
    "ssh:keys": [],
    // (the real fixture is above — an empty array here shadowed it)
  };

  // ?collide=1 (see the branches above): the refs git lists beside them, under
  // the short names git gives them — the tags "main" and "release", the
  // remote-tracking origin/release, and origin/sl beside a LOCAL "origin/sl".
  if (params.get("collide")) {
    fixtures["refs:list"].push(
      { type: "remote", name: "origin/release", fullName: "refs/remotes/origin/release", sha: "b1c2d3e", isCurrent: false, date: S(5), subject: "release work" },
      { type: "remote", name: "remotes/origin/sl", fullName: "refs/remotes/origin/sl", sha: "c2d3e4f", isCurrent: false, date: S(6), subject: "sl two" },
      { type: "tag", name: "tags/release", fullName: "refs/tags/release", sha: "9f8e7d6", isCurrent: false, objectType: "commit", date: S(50), subject: "an old release" },
      { type: "tag", name: "tags/main", fullName: "refs/tags/main", sha: "9f8e7d6", isCurrent: false, objectType: "commit", date: S(60), subject: "a tag named like the default branch" },
    );
  }

  // E1: mutable settings so the Repositories card + destination sheet are
  // exercisable in the harness (Change… picks a canned folder).
  const settingsState = { cloneDir: null, askWhereEveryTime: params.get("ask") === "1" };
  const SETTINGS_DEFAULT = "/Users/demo/GitStudio";
  const settingsView = () => {
    const dir = settingsState.cloneDir || SETTINGS_DEFAULT;
    return {
      cloneDir: dir,
      cloneDirDisplay: dir.startsWith("/Users/demo") ? "~" + dir.slice("/Users/demo".length) : dir,
      cloneDirIsDefault: !settingsState.cloneDir,
      askWhereEveryTime: settingsState.askWhereEveryTime,
    };
  };

  // "Open in <editor>": three editors found on the demo machine, none hidden,
  // no custom ones — every preference the Settings card can change is mutable
  // here so the card, the split button and the row menus are drivable.
  // `?noeditors=1` is the machine with nothing installed.
  const editorsState = {
    detected: params.get("noeditors")
      ? []
      : [
          // `icon` is what app.getFileIcon() hands back in the real app — the
          // OS's own mark for each editor, as a data URL.
          { id: "vscode", name: "VSCode", via: "app", location: "/Applications/Visual Studio Code.app", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23007ACC'/%3E%3C/svg%3E" },
          { id: "cursor", name: "Cursor", via: "app", location: "/Applications/Cursor.app", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23111827'/%3E%3C/svg%3E" },
          { id: "zed", name: "Zed", via: "cli", location: "/opt/homebrew/bin/zed", icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'%3E%3Crect width='16' height='16' rx='3' fill='%23084CCF'/%3E%3C/svg%3E" },
        ],
    hidden: [],
    defaultId: undefined,
    custom: [],
    customSeq: 0,
    /** Every editor id an `editors:open` asked for, in order. */
    opened: [],
  };
  window.__GS_EDITORS = editorsState;
  const editorsView = () => {
    const all = [
      ...editorsState.detected.map((d) => ({ ...d, shown: !editorsState.hidden.includes(d.id), isDefault: false })),
      ...editorsState.custom.map((c) => ({
        id: c.id, name: c.name, via: "custom", location: c.command,
        shown: !editorsState.hidden.includes(c.id), isDefault: false,
      })),
    ];
    const shown = all.filter((e) => e.shown);
    const chosen = shown.find((e) => e.id === editorsState.defaultId) || shown[0];
    if (chosen) chosen.isDefault = true;
    return { editors: all, defaultId: chosen && chosen.id };
  };

  // The Assistant's restored conversation (`?ai=1&chat=…`). One real-sized
  // answer, so a transcript with a second turn streaming under it scrolls —
  // the "Jump to latest" pill has nothing to do in a chat that fits.
  const CHAT1 = {
    id: "chat1",
    title: "Why did the build break?",
    connectionId: "c1",
    turns: [
      { role: "user", text: "Why did the build break?" },
      {
        role: "assistant",
        text:
          "The renderer bundle grew past the size limit the workflow enforces, so `check-bundle` failed before the tests ran.\n\n" +
          "**What grew**\n\n" +
          "- `src/renderer/renderer.ts` — the Settings view pulled in the whole Monaco languages set (+1.9 MB)\n" +
          "- `src/renderer/views/prs.ts` — the review composer imports the diff engine directly (+410 KB)\n" +
          "- `node_modules/@vscode/codicons` — now bundled twice, once from `ui.ts` and once from the harness copy (+180 KB)\n\n" +
          "**What to do**\n\n" +
          "1. Register only the languages the file viewer needs — `monaco.languages.register` for the twelve in `LANGS`.\n" +
          "2. Load the diff engine through the existing worker (`diffWorker.ts`) instead of importing it.\n" +
          "3. Drop the harness import from `ui.ts`; the harness page carries its own copy.\n\n" +
          "```sh\nnpm run build\nnode scripts/bundle-size.js   # should read 9.8 MB, under the 10 MB gate\n```\n\n" +
          "The first item is most of it. Want me to make that change and show you the diff?",
      },
    ],
  };
  // A streamed answer for `?chat=live` (never settles — the screenshot lands
  // mid-run) and `?chat=done` (settles after the stream).
  const LIVE_ANSWER =
    "Here is what your working tree changes, heaviest first:\n\n" +
    "1. **`assistant.ts`** — the composer sends on Enter and keeps Shift+Enter for a new line; the empty state grew six quick-action cards.\n" +
    "2. **`app.css`** — the transcript is a centred column; answers wear a sparkle and a copy button.\n" +
    "3. **`editors.test.ts`** (new) — detection, commands and the Settings view for *Open in <editor>*.\n\n" +
    "Nothing here touches Git behaviour. Two things worth a look before you commit:\n\n" +
    "- `runGoal` clears the composer before the turn is confirmed to have started — a failed start loses the draft.\n" +
    "- The copy button copies the Markdown source, not the rendered text. Right for code; say so in the tooltip.\n\n" +
    "```sh\ngit add -p apps/desktop/src/renderer/assistant.ts\ngit commit -m \"feat(assistant): Enter sends, quick-action cards, copy an answer\"\n```\n\n" +
    "Want me to draft the commit message for the whole set?";

  let localCopies = [
    {
      root: "/Users/demo/GitStudio/gitstudio",
      name: "gitstudio",
      origin: "GitStudioHQ/gitstudio",
      managed: true,
      recent: true,
      current: true,
      missing: false,
    },
    {
      root: "/Users/demo/GitStudio/gistudio.dev",
      name: "gistudio.dev",
      origin: "GitStudioHQ/gistudio.dev",
      managed: true,
      recent: true,
      current: false,
      missing: false,
    },
    {
      // A linked worktree of gitstudio — a checkout, not another repository.
      // The row must SAY so and the folder head must not count it.
      root: "/Users/demo/GitStudio/gitstudio-wt-design",
      name: "gitstudio-wt-design",
      origin: "GitStudioHQ/gitstudio",
      managed: true,
      recent: false,
      current: false,
      missing: false,
      worktreeOf: "/Users/demo/GitStudio/gitstudio",
    },
    {
      root: "/Users/demo/GitStudio/design",
      name: "design",
      origin: "GitStudioHQ/design",
      managed: true,
      recent: false,
      current: false,
      missing: false,
    },
    {
      root: "/Users/demo/Code/experiments",
      name: "experiments",
      origin: "antonarnaudov/experiments",
      managed: false,
      recent: true,
      current: false,
      missing: false,
    },
    {
      root: "/Users/demo/Code/old-prototype",
      name: "old-prototype",
      managed: false,
      recent: true,
      current: false,
      missing: true,
    },
  ];

  let stashes = [
    { sha: "77aa88", ref: "stash@{0}", message: "WIP: palette streaming groups", time: S(30) },
  ];

  /** Branches that were deleted, so undo can put them back where they were. */
  const deletedBranches = new Map();

  /** What a drop took away — the commit outlives the ref, so undo is real. */
  const dropped = new Map();

  /** Which issues are locked right now — mutated by issue:setLocked so a
   *  check can watch lock → reload → unlock actually round-trip. */
  const lockedIssues = new Map();
  if (params.get("locked") === "1") lockedIssues.set(31, { reason: "too heated" });

  /** What a discard took away, so its undo can put it back. */
  const discarded = new Map();

  /** What Forget and Move-to-Trash took away, so undo can put it back. */
  const forgotten = new Map();
  const trashed = new Map();

  // ── where a repository renders ─────────────────────────────────────────────
  // The same rule src/shared/repoGrouping.ts ships, restated here because the
  // shim IS the main process for the harness and main is where the real one
  // runs. test/repoGrouping.test.ts asserts the shipped function agrees with
  // these fixtures, so the two cannot drift apart quietly.
  const norm = (p) => p.replace(/\/+$/, "");
  const under = (parent, child) =>
    norm(child).length > norm(parent).length && norm(child).startsWith(norm(parent) + "/");
  /** A FOLDER's key inside another keeps its own name; a repository's does not. */
  const relPath = (outer, inner) =>
    under(outer, inner) ? norm(inner).slice(norm(outer).length + 1) : "";
  const relDir = (folder, root) => {
    if (!under(folder, root)) return "";
    const rest = norm(root).slice(norm(folder).length + 1);
    const cut = rest.lastIndexOf("/");
    return cut < 0 ? "" : rest.slice(0, cut);
  };
  /** Stamp band + group on every copy, from the SHALLOWEST folder holding it. */
  const claimed = (copies) => {
    const dirs = repoFolders.map((f) => f.path).sort((a, b) => norm(a).length - norm(b).length);
    return copies.map((c) => {
      const band = dirs.find((d) => under(d, c.root));
      return band ? { ...c, band, group: relDir(band, c.root) } : c;
    });
  };
  /** The two counts a head needs, derived rather than typed. */
  const counts = (folderPath) => {
    // Mirrors main.ts: repoCount and containedCount are REPOSITORIES (the
    // labels the heads print — a checkout is not another repository), while
    // containedAnyCount includes worktrees and guards deletion: a folder
    // holding only worktrees is not empty.
    const stamped = claimed(localCopies);
    const repos = stamped.filter((c) => !c.worktreeOf);
    return {
      repoCount: repos.filter((c) => c.band === folderPath && c.group === "").length,
      containedCount: repos.filter((c) => under(folderPath, c.root)).length,
      containedAnyCount: stamped.filter((c) => under(folderPath, c.root)).length,
    };
  };

  let repoFolders = [
    {
      path: "/Users/demo/GitStudio",
      display: "~/GitStudio",
      real: "/Users/demo/GitStudio",
      isCloneDir: true,
      isDefaultCloneDir: true,
      missing: false,
    },
    {
      path: "/Users/demo/Code",
      display: "~/Code",
      real: "/Users/demo/Code",
      isCloneDir: false,
      isDefaultCloneDir: false,
      missing: false,
    },
    {
      path: "/Users/demo/Archive",
      display: "~/Archive",
      real: "/Users/demo/Archive",
      isCloneDir: false,
      isDefaultCloneDir: false,
      missing: true,
    },
  ];

  // ?nested=1 — the shape the owner actually has, which no fixture had: ONE
  // tracked folder holding some repositories loose and the rest in project
  // folders, plus a second tracked folder INSIDE it. Every existing
  // repositories check keeps the flat fixture above and stays green.
  if (params.get("nested") === "1") {
    repoFolders = [
      {
        path: "/Users/demo/GitStudio",
        display: "~/GitStudio",
        real: "/Users/demo/GitStudio",
        isCloneDir: true,
        isDefaultCloneDir: true,
        missing: false,
      },
      {
        path: "/Users/demo/Developer",
        display: "~/Developer",
        real: "/Users/demo/Developer",
        isCloneDir: false,
        isDefaultCloneDir: false,
        missing: false,
      },
      // Tracked AND inside ~/Developer — the state opening a repository
      // creates on its own, because that tracks the repository's parent.
      {
        path: "/Users/demo/Developer/GitStudioHQ",
        display: "~/Developer/GitStudioHQ",
        real: "/Users/demo/Developer/GitStudioHQ",
        isCloneDir: false,
        isDefaultCloneDir: false,
        missing: false,
      },
    ];
    const at = (root, over) => ({
      root,
      name: root.split("/").pop(),
      origin: `antonarnaudov/${root.split("/").pop()}`,
      managed: false,
      recent: false,
      current: false,
      missing: false,
      ...over,
    });
    localCopies = [
      // loose in ~/Developer
      at("/Users/demo/Developer/antonarnaudov"),
      at("/Users/demo/Developer/gistudio.dev", { origin: "GitStudioHQ/gistudio.dev" }),
      at("/Users/demo/Developer/reshapedpdf"),
      at("/Users/demo/Developer/reshapedpdf-public"),
      at("/Users/demo/Developer/reshapedpdf-site"),
      at("/Users/demo/Developer/spool", { recent: true }),
      // the tracked folder nested inside it
      at("/Users/demo/Developer/GitStudioHQ/gitstudio", {
        origin: "GitStudioHQ/gitstudio",
        current: true,
        recent: true,
      }),
      at("/Users/demo/Developer/GitStudioHQ/merge-conflict-tests"),
      at("/Users/demo/Developer/GitStudioHQ/merge-studio", { origin: "GitStudioHQ/merge-studio" }),
      at("/Users/demo/Developer/GitStudioHQ/vscode-extension-starter"),
      // project folders the scan found
      at("/Users/demo/Developer/FlexiMeal/flexi-meal-ai"),
      at("/Users/demo/Developer/FlexiMeal/flexi-meal-api"),
      at("/Users/demo/Developer/FlexiMeal/v0-meal-planning-app"),
      at("/Users/demo/Developer/FlexiMeal/v0-meal-planning-app-design-lab", {
        origin: "antonarnaudov/v0-meal-planning-app",
      }),
      at("/Users/demo/Developer/FlexiMeal/wt-design", {
        origin: "antonarnaudov/v0-meal-planning-app",
      }),
      at("/Users/demo/Developer/Uncaged/getuncaged.dev", { origin: "getuncaged/getuncaged.dev" }),
      at("/Users/demo/Developer/Uncaged/homebrew-tap", { origin: "getuncaged/homebrew-tap" }),
      at("/Users/demo/Developer/Uncaged/uncaged", { origin: "getuncaged/uncaged" }),
      at("/Users/demo/Developer/Uncaged/uncaged-brand", { origin: "getuncaged/uncaged-brand" }),
      at("/Users/demo/Developer/Uncaged/warp"),
      at("/Users/demo/Developer/Yugo/backend", { origin: "YugoFinance/backend" }),
      at("/Users/demo/Developer/Yugo/real-finance-web", { origin: "YugoFinance/real-finance-web" }),
      at("/Users/demo/Developer/Yugo/yugo-telegram-bot", { origin: "YugoFinance/yugo-telegram-bot" }),
      at("/Users/demo/Developer/TrustGlobe/trust-globe"),
      at("/Users/demo/Developer/TrustGlobe/trust-globe copy", { origin: "antonarnaudov/trust-globe" }),
      at("/Users/demo/Developer/coding/price-models-testing-ui"),
      at("/Users/demo/Developer/coding/v0-ckd-cats-guide", { origin: "yoanaxst/v0-ckd-cats-guide" }),
      // and one that really is from somewhere else, so the heading that used
      // to hold everything can be seen holding only what belongs in it.
      at("/Users/demo/scratch/one-off", { recent: true }),
    ];
  }

  // `?manyrepos=1` — the scan's cap, hit. main stops at 300 entries, and a
  // capped list must SAY it is a prefix — the note under the list is the only
  // honest part of a truncation, and this switch is how a check sees it.
  if (params.get("manyrepos") === "1") {
    const pad = [];
    for (let i = localCopies.length; i < 300; i++) {
      pad.push({
        root: `/Users/demo/Code/fleet/repo-${String(i).padStart(3, "0")}`,
        name: `repo-${String(i).padStart(3, "0")}`,
        managed: false,
        recent: false,
        current: false,
        missing: false,
      });
    }
    localCopies = [...localCopies, ...pad];
  }

  // `?emptyclonedir=1` — the app made the clone folder, nothing ever landed in
  // it, and it can go. Said by REMOVING what is in it rather than by overriding
  // the count, so the derived numbers and the rows cannot contradict each other
  // (they did: the head printed 0 while three copies sat inside, and the
  // delete refused over a folder the screen called empty).
  if (params.get("emptyclonedir") === "1") {
    localCopies = localCopies.filter((c) => !under("/Users/demo/GitStudio", c.root));
  }

  /** A folder row as main sends it: counts derived, nesting resolved. */
  const folderRow = (f) => {
    const outer = repoFolders
      .map((o) => o.real)
      .find((r) => r !== f.real && under(r, f.real));
    return {
      ...f,
      ...counts(f.path),
      // `?emptyclonedir=1` is the one case a count cannot express: the app made
      // the clone folder, nothing ever landed in it, and it can be deleted.
      ...(outer ? { nestedIn: outer, group: relPath(outer, f.real) } : {}),
    };
  };

  // What the signed-in account can reach: own repos, one collaborated on, and
  // two through an organisation — including one ALREADY cloned locally, which
  // is the row that must offer Open rather than Clone.
  const ghRepos = [
    { fullName: "GitStudioHQ/gitstudio", name: "gitstudio", owner: "GitStudioHQ", ownerType: "Organization", mine: false, description: "GitStudio \u2014 a JetBrains-grade Git experience for VS Code & Cursor, with a real merge tool", private: false, fork: false, cloneUrl: "https://github.com/GitStudioHQ/gitstudio.git", sshUrl: "git@github.com:GitStudioHQ/gitstudio.git", defaultBranch: "main", stars: 1284, language: "TypeScript", updatedAt: ISO(1) },
    { fullName: "GitStudioHQ/gistudio.dev", name: "gistudio.dev", owner: "GitStudioHQ", ownerType: "Organization", mine: false, description: "gitstudio.dev \u2014 the GitStudio site & blog (Astro), plus the anonymous crash-report collector", private: false, fork: false, cloneUrl: "https://github.com/GitStudioHQ/gistudio.dev.git", sshUrl: "git@github.com:GitStudioHQ/gistudio.dev.git", defaultBranch: "main", stars: 12, language: "TypeScript", updatedAt: ISO(30) },
    { fullName: "antonarnaudov/merge-studio-conflict-tests", name: "merge-studio-conflict-tests", owner: "antonarnaudov", ownerType: "User", mine: true, description: null, private: true, fork: false, cloneUrl: "https://github.com/antonarnaudov/dotfiles.git", sshUrl: "git@github.com:antonarnaudov/dotfiles.git", defaultBranch: "main", stars: 0, language: "Shell", updatedAt: ISO(80) },
    { fullName: "vercel/next.js", name: "next.js", owner: "vercel", ownerType: "Organization", mine: false, description: "The React framework.", private: false, fork: true, cloneUrl: "https://github.com/vercel/next.js.git", sshUrl: "git@github.com:vercel/next.js.git", defaultBranch: "canary", stars: 121000, language: "JavaScript", updatedAt: ISO(4) },
    { fullName: "acme-corp/platform", name: "platform", owner: "acme-corp", ownerType: "Organization", mine: false, description: "Every PDF is just material. Reshape it \u2014 a local-first PDF editor for macOS, Windows and Linux", private: true, fork: false, cloneUrl: "https://github.com/acme-corp/platform.git", sshUrl: "git@github.com:acme-corp/platform.git", defaultBranch: "main", stars: 3, language: "Go", updatedAt: ISO(12) },
  ];

  // ?emptyrepo=1 — a GitHub repository nobody has pushed to yet.
  //
  // This state is UNREACHABLE by answering an empty list: GitHub fails every
  // read of an empty repository instead (the contents API 404s, /commits and
  // /git/trees 409), all saying "This repository is empty.", which the main
  // process normalises to that one sentence. So the fixture has to THROW, and
  // until it did, the surfaces that meet an empty repository had never been
  // rendered by anything — which is how crash report #13 came to be filed for
  // a page that simply had nothing to show.
  const emptyRepo = params.get("emptyrepo") === "1";
  const ifEmpty = (fn) => (req) => {
    if (emptyRepo) throw new Error("This repository is empty.");
    return fn(req);
  };

  // ── Uncommitted work in a command's way (crash report #18) ──────────────
  // ?intheway=1 → every door that applies commits — commit:action's checkout,
  // checkout-ref, cherry-pick and revert; stash:apply / stash:pop;
  // branch:merge / branch:rebase; branch:create with a switch from elsewhere;
  // pr:checkout; sync:pull — answers its FIRST request as the bridge answers a
  // refusal over the user's uncommitted work (main/inTheWay.ts): ok:false,
  // expected, the engine's sentence, and `inTheWay` naming the file and the
  // repository. The renderer then asks Stash & Retry or Cancel (bridge.ts),
  // and the retry comes back carrying `stashFirst`, answered as the door's
  // success. Without these the doors had no fixture at all (stash:apply,
  // branch:merge and pr:checkout fell through to the mutation fallback's
  // {ok:true}), so no refusal could happen in a scene.
  //   intheway=note  → the retry succeeds, and says where the stashed changes
  //                    are (they could not simply come back)
  //   intheway=still → the retry is STILL refused over uncommitted work
  //                    (something the stash could not cover)
  //   intheway=fail  → the first request fails for a reason that is NOT the
  //                    user's work — a genuine failure, which stays red
  const inTheWayScene = params.get("intheway");
  const WAY_FILE = "docs/notes.md";
  const THE_WAY = {
    revert: "the revert",
    "cherry-pick": "the cherry-pick",
    merge: "the merge",
    rebase: "the rebase",
    checkout: "switching to it",
    stash: "applying the stash",
    pull: "the pull",
  };
  function throughTheDoor(req, kind, succeed) {
    if (!inTheWayScene) return succeed(req);
    const retry = !!(req && typeof req === "object" && typeof req.stashFirst === "string");
    if (inTheWayScene === "fail" && !retry) {
      return { ok: false, changed: false, message: "fatal: unable to read tree 1a2b3c4d5e6f" };
    }
    if (!retry || inTheWayScene === "still") {
      return {
        ok: false,
        changed: false,
        expected: true,
        message:
          kind === "rebase"
            ? `A rebase needs a clean working tree, and your uncommitted changes to ${WAY_FILE} are in the way. ` +
              "Stash it and try again, or commit it first."
            : `Your uncommitted changes to ${WAY_FILE} are in the way of ${THE_WAY[kind]} — git won't overwrite them. ` +
              "Stash it and try again, or commit it first.",
        inTheWay: { kind, files: [WAY_FILE], root: (fixtures["repo:current"] || {}).root },
      };
    }
    const done = succeed(req);
    return inTheWayScene === "note"
      ? {
          ...done,
          stashNote:
            `Your changes to ${WAY_FILE} are kept in the stash "GitStudio: before ${kind === "pull" ? "pulling" : kind}" — ` +
            "git won't put them back over the changes that just came in. Apply it when you're ready.",
        }
      : done;
  }

  const dynamic = {
    // A READ that the fallback used to answer with a mutation shape. Present so
    // the AI-gating path is exercised instead of silently failing open.
    // ?ai=1 → a CONNECTED model. Without this the Assistant is permanently
    // behind its "Connect a model" gate, which means the composer, the quick
    // actions, the transcript, the tool steps and the whole streaming path have
    // never been reachable from a scene — six real defects lived there through
    // four sweeps because nothing could drive them.
    // A real PTY id, so `terminal:exit` and `terminal:data` can be aimed at a
    // specific shell. Without this, `terminal:create` fell into the mutation
    // fallback and answered `{ok:true}` — the panel stored `session.id` as
    // undefined, so no push event could ever be matched to it and the whole
    // terminal surface was half-driveable at best.
    "terminal:create": () => ({ id: `pty-${++ptySeq}`, cols: 80, rows: 24 }),
    // Void, fire-and-forget, and called on EVERY route — so with no fixture it
    // appeared in the "asked for with no fixture" report of every single check.
    // That report's whole value is that it only lists real gaps; one entry on
    // every line trains you to skip it.
    "terminal:resize": () => undefined,
    // Pull. A MUTATION, so the fallback answered {ok:true} and the diverged
    // branch — git's "you have divergent branches" refusal, report #12 — could
    // not happen in a scene at all. With ?diverged=1 the first (mode-less) call
    // answers the way the bridge does: ok:false, expected, nothing changed, and
    // a `diverged` fact to ask about. Naming a mode succeeds, and the mode that
    // was asked for is readable as `window.__gsPulledWith` so a check can prove
    // the pick reached the REQUEST, not merely that the dialog closed.
    //
    // Every git pull FETCHES first, so the first call moves the remote: the
    // badge was painted from an older fetch (3 behind) and the pull finds 5.
    // That gap is the only way a check can tell a badge refreshed after the
    // question was dismissed from one still showing the count before it.
    //
    // ?pullconflict=1 → the merge or rebase the user then picks STOPS on
    // conflicts, answered the way the bridge answers it: ok:false, changed,
    // expected, and a `stopped` fact with the count. From then on `git:opState`
    // reports the paused operation, as the real repository would.
    //
    // And every one of those pulls WRITES REFS — the fetch moves
    // refs/remotes/origin/main, a merge or rebase moves the branch — which the
    // real app's repository watcher reports DEBOUNCE_MS (250 ms) later as
    // `repo:filesChanged {gitDir: true}`. That refresh re-routes the view, and
    // a re-route tears every floating layer down. The fixture used to leave it
    // out, so the divergence question could be answered here at leisure while
    // in the real app the watcher answered "Cancel" for the user ~200 ms after
    // the question appeared. Modelled here so no pull check can pass without it.
    "sync:pull": (opts) => {
      const mode = (opts && opts.mode) || null;
      window.__gsPulledWith = mode;
      // ?intheway=1 → a branch that is only behind, with an edit to a file the
      // incoming commits change: refused over it (see throughTheDoor). The
      // pull FETCHED before it was refused, so the watcher reports the moved
      // remote-tracking ref 250 ms later — while the question is on screen.
      if (inTheWayScene) {
        const answer = throughTheDoor(opts, "pull", () => {
          pullState.done = true;
          return { ok: true, changed: true };
        });
        if (!(opts && opts.stashFirst)) {
          pullState.fetched = true;
          setTimeout(() => window.__gsEmit("repo:filesChanged", { gitDir: true }), 250);
        }
        return answer.inTheWay ? { ...answer, dirty: { files: answer.inTheWay.files.length } } : answer;
      }
      if (!params.get("diverged")) return { ok: true, changed: true };
      // Pull pressed AGAIN over the merge or rebase that stopped: the branch is
      // still ahead and behind, so Pull is still on offer, and git refuses it
      // before running anything — answered as the bridge answers it. Nothing
      // is written, so nothing wakes the watcher.
      if (pullState.stopped) {
        const op = pullState.stopped.operation;
        return {
          ok: false,
          changed: false,
          expected: true,
          message:
            `A ${op} is still in progress, with 2 files still conflicted. Resolve them and ` +
            `${op === "rebase" ? "continue" : "commit"} the ${op} — or abort it — before pulling again.`,
          blocked: { operation: op, conflicts: 2 },
        };
      }
      setTimeout(() => window.__gsEmit("repo:filesChanged", { gitDir: true }), 250);
      pullState.fetched = true;
      if (mode && params.get("pullconflict")) {
        pullState.stopped = { operation: mode, conflicts: 2 };
        return {
          ok: false,
          changed: true,
          expected: true,
          message:
            "The pull stopped on conflicts in 2 files. Resolve them, then " +
            (mode === "rebase" ? "continue the rebase" : "commit the merge") +
            " — or abort to go back to where you were.",
          stopped: pullState.stopped,
        };
      }
      if (mode) {
        pullState.done = true;
        return { ok: true, changed: true };
      }
      return {
        ok: false,
        changed: false,
        expected: true,
        message:
          `'main' and origin/main have both moved on — 2 commits here, ${pullState.behind()} commits there. ` +
          "Choose how to combine them.",
        diverged: { branch: "main", upstream: "origin/main", ahead: 2, behind: pullState.behind() },
      };
    },
    // A commit, answered as the bridge answers one that worked. There was no
    // fixture, so `host.invoke("commit")` answered undefined and every Commit
    // press in a scene ended in the catch's "Commit failed." — nothing after
    // a commit (the push, what Commit & Push says) could be reached.
    "commit": () => ({ ok: true, changed: true }),
    // Push. A MUTATION, so the fallback answered {ok:true} and no refusal could
    // happen in a scene. ?forcerefused=1 → the branch was rewritten while the
    // remote has somebody else's version too: a plain push is refused
    // non-fast-forward (git's words, as the bridge passes them on), and the
    // force the app then offers is refused by the bridge — `expected`, with
    // `pullFirst` — as it refuses one that would delete commits this branch
    // never had. The request is readable as `window.__gsPushedWith`.
    "sync:push": (opts) => {
      window.__gsPushedWith = (window.__gsPushedWith || []).concat([opts || null]);
      if (!params.get("forcerefused")) return { ok: true, changed: true };
      if (!(opts && opts.force)) {
        return {
          ok: false,
          changed: false,
          message: " ! [rejected]        main -> main (non-fast-forward)\nerror: failed to push some refs",
        };
      }
      return {
        ok: false,
        changed: false,
        expected: true,
        pullFirst: true,
        message:
          "The remote branch has commits this branch has never had — fetched in the background, " +
          "from another machine or someone else — and a force push would delete them. " +
          "Pull them in first, then push.",
      };
    },
    // ?diverged=1 → the branch and its upstream have BOTH moved, which is the
    // one sync state the widget could not be driven into: with behind: 0 the
    // top-bar action is Push, so Pull — and the question it now asks — was
    // unreachable from every scene.
    "sync:status": () =>
      // ?intheway=1 → only behind, so the top bar's action is Pull.
      inTheWayScene
        ? { branch: "main", upstream: "origin/main", ahead: 0, behind: pullState.done ? 0 : 3, noUpstream: false }
        : params.get("diverged")
        ? {
            branch: "main",
            upstream: "origin/main",
            ahead: pullState.done ? 3 : 2,
            behind: pullState.done ? 0 : pullState.behind(),
            noUpstream: false,
          }
        : { branch: "main", upstream: "origin/main", ahead: 2, behind: 0, noUpstream: false },
    // The paused operation a stopped pull leaves behind, so landing in Changes
    // shows the banner the real app would; otherwise the ?op= fixture.
    "git:opState": () =>
      pullState.stopped
        ? {
            merging: pullState.stopped.operation === "merge",
            rebasing: pullState.stopped.operation === "rebase",
            amApplying: false,
            cherryPicking: false,
            reverting: false,
            conflicts: pullState.stopped.conflicts,
            kind: pullState.stopped.operation,
            canContinue: false,
            canSkip: false,
            nothingToCommit: false,
          }
        : fixtures["git:opState"],
    "appearance:dockIcon": () => undefined,
    // A REAL gap: the run page's Artifacts section read undefined and rendered
    // whatever that produced, unchecked, for as long as this harness has run.
    "actions:artifacts": (runId) =>
      runId === 9097
        ? [
            { id: 1, name: "desktop-macos-arm64", sizeBytes: 84_213_760, expired: false, createdAt: ISO(1) },
            { id: 2, name: "renderer-coverage", sizeBytes: 1_240_400, expired: false, createdAt: ISO(1) },
            { id: 3, name: "old-build-logs", sizeBytes: 402_100, expired: true, createdAt: ISO(40) },
          ]
        : [],
    "ai:settings": () =>
      params.get("ai")
        ? {
            enabled: true,
            connections: [{ id: "c1", label: "Claude (BYOK)", usable: true }],
            defaultId: "c1",
            agent: { permission: "write", thinking: "medium", modelId: "claude-opus-5" },
          }
        : { enabled: false, connections: [], defaultId: null },
    "ai:models": () =>
      params.get("ai")
        ? [
            { id: "claude-opus-5", label: "Claude Opus 5" },
            { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
          ]
        : [],
    "ai:chatCurrent": () => (params.get("ai") && params.get("chat") ? CHAT1 : null),
    // The agent turn. Without `?chat=live|done` it is the old no-op — the
    // request succeeds with nothing in it, so a check about the composer is
    // not also a check about streaming. With it, the main process's push
    // events arrive the way they do in the app: a status, two tool steps with
    // their results, then the answer in chunks.
    "ai:chatSend": ({ requestId }) => {
      const mode = params.get("chat");
      if (mode !== "live" && mode !== "done") return { ok: true, changed: false };
      const emit = (kind, extra) => window.__gsEmit("ai:agentEvent", { requestId, kind, ...extra });
      const delta = (t) => window.__gsEmit("ai:delta", { requestId, delta: t });
      return new Promise((resolve) => {
        setTimeout(() => emit("status", { text: "Reading the repository" }), 80);
        setTimeout(() => emit("tool_call", { tool: "git_status", callId: "c1", args: {} }), 260);
        setTimeout(
          () =>
            emit("tool_result", {
              callId: "c1",
              text: " M apps/desktop/src/renderer/assistant.ts\n M apps/desktop/src/renderer/styles/app.css\n?? apps/desktop/test/editors.test.ts",
            }),
          520,
        );
        setTimeout(() => emit("tool_call", { tool: "git_diff", callId: "c2", args: { paths: ["apps/desktop/src/renderer/assistant.ts"] } }), 680);
        setTimeout(() => emit("tool_result", { callId: "c2", text: "+212 −48 across 2 files" }), 940);
        const chunks = LIVE_ANSWER.match(/[\s\S]{1,28}/g);
        chunks.forEach((c, i) => setTimeout(() => delta(c), 1000 + i * 40));
        const end = 1000 + chunks.length * 40 + 120;
        if (mode === "done") {
          setTimeout(() => {
            emit("assistant", { text: LIVE_ANSWER });
            resolve({ ok: true, text: LIVE_ANSWER });
          }, end);
        } else {
          setTimeout(() => resolve({ ok: true, text: LIVE_ANSWER }), 120000);
        }
      });
    },
    "ai:chatList": () =>
      params.get("ai")
        ? [
            { id: "chat1", title: "Why did the build break?", updatedAt: Date.now() - 6e5 },
            { id: "chat2", title: "Rename the staging helpers", updatedAt: Date.now() - 9e6 },
          ]
        : [],
    "ai:chatNew": () => ({ id: "chat-new", title: "New chat", connectionId: "c1", turns: [] }),
    "ai:chatGet": ({ id }) => (id === "chat1" ? CHAT1 : { id, title: "Earlier chat", connectionId: "c1", turns: [{ role: "user", text: "hello" }] }),
    "ai:chatSetCurrent": () => ({ ok: true }),
    "editors:list": () => editorsView(),
    "editors:refresh": () => editorsView(),
    "editors:open": ({ id }) => {
      editorsState.opened.push(id);
      return { ok: true };
    },
    "editors:setShown": ({ id, shown }) => {
      editorsState.hidden = editorsState.hidden.filter((h) => h !== id);
      if (!shown) editorsState.hidden.push(id);
      return editorsView();
    },
    "editors:setDefault": ({ id }) => {
      editorsState.defaultId = id || undefined;
      return editorsView();
    },
    "editors:addCustom": ({ name, command }) => {
      editorsState.custom.push({ id: `custom-${++editorsState.customSeq}`, name, command });
      return editorsView();
    },
    "editors:removeCustom": ({ id }) => {
      editorsState.custom = editorsState.custom.filter((c) => c.id !== id);
      return editorsView();
    },
    "editors:reveal": () => undefined,
    "settings:get": () => settingsView(),
    "settings:update": (patch) => {
      if (patch && patch.cloneDir === null) settingsState.cloneDir = null;
      else if (patch && typeof patch.cloneDir === "string") settingsState.cloneDir = patch.cloneDir;
      if (patch && typeof patch.askWhereEveryTime === "boolean") settingsState.askWhereEveryTime = patch.askWhereEveryTime;
      return settingsView();
    },
    "settings:pickCloneDir": () => {
      settingsState.cloneDir = "/Volumes/Work/src";
      return settingsView();
    },
    "clone:pickDir": () => "/Volumes/Work/src",
    "orgs:repoDetail": (fullName) => ({
      fullName,
      description: "The open-source Git workspace — desktop app + VS Code extension.",
      htmlUrl: "https://github.com/" + fullName,
      cloneUrl: "https://github.com/" + fullName + ".git",
      sshUrl: "git@github.com:" + fullName + ".git",
      defaultBranch: "main",
      openIssuesCount: 31,
      forksCount: 96,
      stargazersCount: 2140,
      topics: ["git", "electron", "typescript", "vscode-extension"],
      license: "MIT",
      language: "TypeScript",
      private: false,
      archived: false,
      fork: false,
      pushedAt: ISO(1),
      createdAt: ISO(900),
      homepage: "https://gistudio.dev",
    }),
    // Opening a repository you already have. Like a clone, main emits
    // repo:changed from inside the handler, so the shell has rebuilt by the
    // time the invoke resolves.
    "repo:openPath": (root) => {
      const name = String(root).split("/").filter(Boolean).pop();
      window.__gsEmit("repo:changed", { root, name });
      return { root, name, branch: "main" };
    },
    // The clone the browse page starts. Main emits repo:changed from INSIDE the
    // handler, before the invoke resolves — mirror that, or the renderer's
    // landing hook is never exercised and a check passes over the bug.
    "ghrepo:open": ({ fullName }) => {
      const name = String(fullName).split("/")[1];
      const root = `/Users/demo/GitStudio/${name}`;
      window.__gsEmit("repo:changed", { root, name });
      return { ok: true, root, cloned: true };
    },
    // E4: entity pages — remote tree/file/readme at a ref, branches, paths.
    "ghrepo:commits": ifEmpty(({ ref }) =>
      [
        { sha: "9f8e7d6c5b4a39281706", shortSha: "9f8e7d6", subject: "release: extension 1.11.1", author: "Anton Arnaudov", login: "antonarnaudov", date: ISO(1) },
        { sha: "18c9d0e7f6a5b4c3d2e1", shortSha: "18c9d0e", subject: "engine: hunk splitting groundwork", author: "Mira Holt", login: "mira-holt", date: ISO(3) },
        { sha: "c3d4e5f60718293a4b5c", shortSha: "c3d4e5f", subject: `actions: stream job logs (${ref ?? "default"})`, author: "Sora Ohta", date: ISO(8) },
      ]),
    // Settings ▸ Agent Access. Missing entirely: twelve checks rendered
    // Settings over a card whose read answered undefined and threw, so the one
    // card that installs something into another app had never been looked at.
    // The shape is main/mcpConfig.ts's — the launch is the app's own executable
    // as Node — and ?mcpmissing=1 is a shipped build without its server.
    "ai:mcpInfo": () => {
      const bin = "/Applications/GitStudio.app/Contents/Resources/mcp/gitstudio-mcp.js";
      const command = "/Applications/GitStudio.app/Contents/MacOS/GitStudio";
      const env = { ELECTRON_RUN_AS_NODE: "1" };
      const repoRoot = "/Users/anton/Developer/GitStudioHQ/gitstudio";
      const args = [bin, "--repo", repoRoot];
      // ?mcptransloc=1: the app is running from a Gatekeeper-translocated copy,
      // whose path vanishes on quit. ?mcpmoved=1: Cursor was set up with a
      // GitStudio that has since been moved.
      const transloc = params.get("mcptransloc") === "1";
      const moved = params.get("mcpmoved") === "1";
      const missing = params.get("mcpmissing") === "1" || transloc;
      const unavailable = transloc
        ? "GitStudio is running from a temporary copy macOS made because the app hasn't been moved to Applications yet, and that copy disappears when GitStudio quits — an agent set up now would stop working. Move GitStudio to your Applications folder, open it from there, then add it again."
        : "This build of GitStudio is missing its MCP server, so Agent Access can't be set up. Reinstalling the app restores it.";
      return {
        binPath: bin,
        command,
        args,
        env,
        configSnippet: JSON.stringify({ mcpServers: { gitstudio: { command, args, env } } }, null, 2),
        clients: [
          { id: "claude", label: "Claude Desktop", installed: false, configPath: "~/Library/Application Support/Claude/claude_desktop_config.json" },
          { id: "cursor", label: "Cursor", installed: true, configPath: "~/.cursor/mcp.json",
            ...(moved ? { stale: true, staleReason: "The GitStudio this was set up with is no longer at /Users/anton/Downloads/GitStudio.app/Contents/MacOS/GitStudio." } : {}) },
          { id: "windsurf", label: "Windsurf", installed: false, configPath: "~/.codeium/windsurf/mcp_config.json" },
          { id: "vscode", label: "VS Code (Copilot)", installed: false, configPath: "~/Library/Application Support/Code/User/mcp.json" },
        ],
        repoRoot,
        available: !missing,
        ...(missing ? { missing: unavailable } : {}),
      };
    },
    // Add / Update / Re-add, answered as installMcp answers a success.
    "ai:mcpInstall": (req) => ({
      ok: true,
      message: `Added GitStudio (read-only) to ${req && req.client}. Restart it to pick it up.`,
    }),
    // NOT ifEmpty: GitHub's `/branches` answers an empty repository with an
    // empty LIST (200, `[]`) — only the content endpoints refuse. Throwing here
    // made the ref switcher reachable only as a failure toast, so a check of
    // it could pass over the throw instead of the state it was written for.
    "ghrepo:branches": () =>
      emptyRepo
        ? []
        : [
            { name: "main", sha: "9f8e7d6", protected: true },
            { name: "redesign/issues-detail", sha: "a1b2c3d", protected: false },
            { name: "fix/log-stream", sha: "b2c3d4e", protected: false },
          ],
    "ghrepo:paths": ifEmpty(() => ({
      paths: [
        "README.md",
        "package.json",
        "apps/desktop/src/main/main.ts",
        "apps/desktop/src/renderer/renderer.ts",
        "apps/desktop/src/renderer/logView.ts",
        "apps/desktop/src/renderer/views/explore.ts",
        "packages/engine/src/lane.ts",
      ],
      truncated: false,
      total: 7,
    })),
    "ghrepo:tree": ifEmpty((req) => {
      if (!req.path) {
        return [
          { name: "apps", path: "apps", type: "dir" },
          { name: "packages", path: "packages", type: "dir" },
          { name: "docs", path: "docs", type: "dir" },
          { name: "README.md", path: "README.md", type: "file", size: 8214 },
          { name: "package.json", path: "package.json", type: "file", size: 1620 },
        ];
      }
      if (req.path === "apps") return [{ name: "desktop", path: "apps/desktop", type: "dir" }];
      return [{ name: "index.ts", path: req.path + "/index.ts", type: "file", size: 420 }];
    }),
    "ghrepo:file": ifEmpty((req) => ({
      path: req.path,
      text: "export function createLogPane(o: LogPaneOpts): LogPane {\n  const el = document.createElement(\"div\");\n  el.className = \"log-pane\";\n  return { el, append, reset, finish };\n}\n",
      truncated: false,
      binary: false,
      size: 420,
    })),
    "ghrepo:readme": () => (emptyRepo ? undefined : {
      name: "README.md",
      // The shapes a real README carries: a RELATIVE image (must be rewritten
      // to raw.githubusercontent.com or it 404s against the app's own origin)
      // and a third-party badge (must survive as-is).
      text: "# GitStudio\n\n<img alt=\"GitStudio\" src=\"brand/gitstudio-icon.svg\" width=\"116\">\n\n![CI](https://img.shields.io/badge/ci-passing-brightgreen)\n\nThe open-source Git workspace — a desktop app and a VS Code extension that share one engine.\n\n## Why\n\nBecause a Git client should let you *read* a repository, not just launch a browser.\n\n- Full-page sections, no split panes\n- Everything GitHub does, in the app\n- Works when GitHub doesn't\n",
    }),
    "users:repos": () => [
      { name: "gitstudio", fullName: "GitStudioHQ/gitstudio", htmlUrl: "", description: "The open-source Git workspace — desktop app + VS Code extension.", private: false, fork: false, archived: false, language: "TypeScript", stargazersCount: 2140, pushedAt: ISO(1) },
      { name: "gistudio.dev", fullName: "GitStudioHQ/gistudio.dev", htmlUrl: "", description: "Marketing site and the error-report collector.", private: false, fork: false, archived: false, language: "TypeScript", stargazersCount: 84, pushedAt: ISO(5) },
      { name: "dotfiles", fullName: "antonarnaudov/dotfiles", htmlUrl: "", description: null, private: false, fork: false, archived: false, language: "Shell", stargazersCount: 3, pushedAt: ISO(200) },
    ],
    "users:orgs": () => [
      { login: "GitStudioHQ", name: "GitStudio", avatarUrl: null, description: "The open-source Git workspace.", htmlUrl: "https://github.com/GitStudioHQ" },
    ],
    // E3: global search. Returns a canned page shaped by the query so the
    // Explore surfaces (results, sort, load-more footer) are exercisable.
    "search:repos": (req) => {
      const q = (req.query || "").toLowerCase();
      const all = [
        { id: 1, fullName: "GitStudioHQ/gitstudio", owner: "GitStudioHQ", ownerType: "Organization", mine: false, ownerAvatarUrl: null, description: "The open-source Git workspace — desktop app + VS Code extension.", language: "TypeScript", stars: 2140, forks: 96, openIssues: 31, updatedAt: ISO(2), pushedAt: ISO(1), private: false, fork: false, archived: false, topics: ["git", "electron"], license: "MIT", htmlUrl: "https://github.com/GitStudioHQ/gitstudio", defaultBranch: "main" },
        { id: 2, fullName: "libgit2/libgit2", owner: "libgit2", ownerAvatarUrl: null, description: "A cross-platform, linkable library implementation of Git.", language: "C", stars: 9800, forks: 2400, openIssues: 380, updatedAt: ISO(20), pushedAt: ISO(6), private: false, fork: false, archived: false, topics: ["git"], license: "GPL-2.0", htmlUrl: "https://github.com/libgit2/libgit2", defaultBranch: "main" },
        { id: 3, fullName: "desktop/desktop", owner: "desktop", ownerAvatarUrl: null, description: "Focus on what matters instead of fighting with Git.", language: "TypeScript", stars: 12400, forks: 9600, openIssues: 1200, updatedAt: ISO(30), pushedAt: ISO(12), private: false, fork: false, archived: false, topics: ["git", "electron"], license: "MIT", htmlUrl: "https://github.com/desktop/desktop", defaultBranch: "development" },
        { id: 4, fullName: "jesseduffield/lazygit", owner: "jesseduffield", ownerAvatarUrl: null, description: "Simple terminal UI for git commands.", language: "Go", stars: 48200, forks: 1700, openIssues: 420, updatedAt: ISO(9), pushedAt: ISO(3), private: false, fork: false, archived: false, topics: ["git", "tui"], license: "MIT", htmlUrl: "https://github.com/jesseduffield/lazygit", defaultBranch: "master" },
        { id: 5, fullName: "old/archived-git-tool", owner: "old", ownerAvatarUrl: null, description: "No longer maintained.", language: "Ruby", stars: 12, forks: 3, openIssues: 0, updatedAt: ISO(900), pushedAt: ISO(900), private: false, fork: false, archived: true, htmlUrl: "https://github.com/old/archived-git-tool", topics: [], license: null, defaultBranch: "master" },
      ].filter((r) => !q || (r.fullName + " " + (r.description || "")).toLowerCase().includes(q.split(" ")[0]));
      return { items: all, totalCount: 1284, incomplete: false, hasMore: true };
    },
    "search:users": (req) => {
      const org = req.kind === "orgs";
      const items = org
        ? [
            { login: "GitStudioHQ", avatarUrl: null, htmlUrl: "https://github.com/GitStudioHQ", type: "Organization" },
            { login: "github", avatarUrl: null, htmlUrl: "https://github.com/github", type: "Organization" },
            { login: "libgit2", avatarUrl: null, htmlUrl: "https://github.com/libgit2", type: "Organization" },
          ]
        : [
            { login: "antonarnaudov", avatarUrl: null, htmlUrl: "https://github.com/antonarnaudov", type: "User" },
            { login: "mira-holt", avatarUrl: null, htmlUrl: "https://github.com/mira-holt", type: "User" },
            { login: "s-ohta", avatarUrl: null, htmlUrl: "https://github.com/s-ohta", type: "User" },
          ];
      return { items, totalCount: items.length, incomplete: false, hasMore: false };
    },
    "search:code": (req) => ({
      items: [
        // Fragments carry the match OFFSETS, exactly as GitHub's
        // text-match+json returns them — the row marks those ranges.
        { name: "logView.ts", path: "apps/desktop/src/renderer/logView.ts", repoFullName: "GitStudioHQ/gitstudio", htmlUrl: "https://github.com/GitStudioHQ/gitstudio", fragments: [{ text: "export function createLogPane(o: LogPaneOpts): LogPane {", ranges: [[16, 19]] }, { text: "  const el = document.createElement(\"div\");", ranges: [[24, 27]] }] },
        { name: "index.ts", path: "src/git/index.ts", repoFullName: "libgit2/libgit2", htmlUrl: "https://github.com/libgit2/libgit2", fragments: [{ text: "int git_repository_open(git_repository **out, const char *path)", ranges: [[4, 7]] }] },
      ],
      totalCount: 2,
      incomplete: false,
      hasMore: false,
    }),
    // E2: the local-copies manager. Mutable so Remove/Delete are exercisable.
    // Stamped the way main stamps them — the renderer buckets by band, and an
    // unstamped answer empties every band on the screen.
    "repos:local": () => claimed(localCopies),
    // The scan-cap truth. The dedupe pass in main pulls the list length back
    // under the cap even when truncation happened, so the note reads THIS.
    "repos:scanTruncated": () => params.get("manyrepos") === "1",
    // Home-row working-tree signals. gistudio.dev has unpushed work, design
    // is stale, everything else is clean and must show NOTHING.
    "repos:localStatus": (roots) =>
      Object.fromEntries(
        (roots || []).map((r) => [
          r,
          r.endsWith("/gistudio.dev")
            ? { branch: "main", dirty: 3, ahead: 1, behind: 0 }
            : r.endsWith("/design")
              ? { branch: "main", dirty: 0, ahead: 0, behind: 2 }
              : { branch: "main", dirty: 0, ahead: 0, behind: 0 },
        ]),
      ),
    // The folders the Repositories view groups by. The clone folder leads and
    // cannot be untracked; ~/Code is the "I keep work here too" case; the last
    // is the one that has gone missing, which the row has to say out loud.
    // With the full name the real read carries (%(refname)): every checkout
    // door goes by it, and the main process refuses a checkout without one.
    // ?diverged=1 → main's row carries the same counts as the top bar, and
    // moves with them when a pull's fetch finds more (see `sync:pull`).
    "branches:list": () =>
      branches
        .map((b) => ({ fullName: "refs/heads/" + b.name, ...b }))
        .map((b) =>
          params.get("diverged") && b.current
            ? {
                ...b,
                ahead: pullState.done ? 3 : 2,
                behind: pullState.done ? 0 : pullState.behind(),
              }
            : b,
        ),
    // The per-branch log walk's answer. feat/line-staging is the interesting
    // one: created by one person, carried by three — a number-only "last
    // commit by" could never say that.
    "branches:people": () => ({
      "redesign/issues-detail": {
        creator: { name: "Mira Holt", email: "mira@example.com" },
        contributors: [
          { name: "Mira Holt", email: "mira@example.com", count: 4 },
          { name: "Anton Arnaudov", email: "12345+antonarnaudov@users.noreply.github.com", count: 1 },
        ],
      },
      "feat/line-staging": {
        creator: { name: "Sora Ohta", email: "sora@example.com" },
        contributors: [
          { name: "Mira Holt", email: "mira@example.com", count: 9 },
          { name: "Sora Ohta", email: "sora@example.com", count: 6 },
          { name: "Anton Arnaudov", email: "12345+antonarnaudov@users.noreply.github.com", count: 2 },
          { name: "J. Parks", email: "jparks@example.com", count: 1 },
        ],
      },
      "fix/log-stream": {
        creator: { name: "Sora Ohta", email: "sora@example.com" },
        contributors: [{ name: "Sora Ohta", email: "sora@example.com", count: 2 }],
      },
      // Remote branches are walked too — same question, same answer shape.
      "origin/redesign/issues-detail": {
        creator: { name: "Mira Holt", email: "mira@example.com" },
        contributors: [
          { name: "Mira Holt", email: "mira@example.com", count: 4 },
          { name: "Anton Arnaudov", email: "12345+antonarnaudov@users.noreply.github.com", count: 1 },
        ],
      },
    }),
    // Branch delete returns the tip it deleted, which is the whole reason the
    // delete can be undone — `?nowas=1` is the case where the tip could not be
    // read and no undo may be offered.
    // Branch ops take the branch by its FULL name (issue #30's follow-up), as
    // the main process does — and refuse one without it, as it does.
    "branch:delete": ({ fullName }) => {
      const name = typeof fullName === "string" && fullName.startsWith("refs/heads/") ? fullName.slice(11) : undefined;
      if (!name) return { ok: false, changed: false, message: "Couldn't tell which branch to delete — refresh and try again." };
      const hit = branches.find((b) => b.name === name);
      if (!hit) return { ok: false, changed: false, message: "no such branch" };
      deletedBranches.set(name, hit);
      branches = branches.filter((b) => b.name !== name);
      return params.get("nowas") === "1"
        ? { ok: true, changed: true }
        : { ok: true, changed: true, was: "b1a5ded", upstream: hit.upstream };
    },
    "branch:create": (req) => {
      const create = ({ name, startPoint }) => {
        const was = deletedBranches.get(name);
        if (was && startPoint) {
          deletedBranches.delete(name);
          branches = [...branches, was];
          return { ok: true, changed: true };
        }
        if (branches.some((b) => b.name === name)) {
          return { ok: false, changed: false, message: "a branch of that name already exists" };
        }
        branches = [...branches, { name, current: false, ahead: 0, behind: 0, subject: "new", date: S(0) }];
        return { ok: true, changed: true };
      };
      // Create AND switch from somewhere else is a checkout — through the door.
      return req && req.checkout && req.startPoint ? throughTheDoor(req, "checkout", create) : create(req);
    },
    // A merge or a rebase from the Branches view. MUTATIONS with no fixture,
    // so both answered the fallback's {ok:true} and no refusal could happen.
    // By FULL name, as main takes them — anything else is refused as main
    // refuses it — and through the door.
    "branch:merge": (req) =>
      typeof req?.fullName === "string" && /^refs\/(heads|remotes)\/./.test(req.fullName)
        ? throughTheDoor(req, "merge", () => ({ ok: true, changed: true }))
        : { ok: false, changed: false, message: "Couldn't tell which branch to merge — refresh and try again." },
    "branch:rebase": (req) =>
      typeof req?.fullName === "string" && /^refs\/(heads|remotes|tags)\/./.test(req.fullName)
        ? throughTheDoor(req, "rebase", () => ({ ok: true, changed: true }))
        : { ok: false, changed: false, message: "Couldn't tell which branch to rebase onto — refresh and try again." },
    // Apply / pop from the stash list or a stash's page: the ref, or — sent
    // again after Stash & Retry — `{ ref, stashFirst }`.
    "stash:apply": (req) => throughTheDoor(req, "stash", () => ({ ok: true, changed: true })),
    "stash:pop": (req) => throughTheDoor(req, "stash", () => ({ ok: true, changed: true })),
    // A pull request fetched and checked out: the number, or `{ number, stashFirst }`.
    "pr:checkout": (req) => throughTheDoor(req, "checkout", () => ({ ok: true, changed: true })),
    // A rename carries the tracking over UNCHANGED, exactly as `git branch -m`
    // does — which is the whole reason the reconcile question exists.
    "branch:rename": ({ fullName, to }) => {
      const from = typeof fullName === "string" && fullName.startsWith("refs/heads/") ? fullName.slice(11) : undefined;
      if (!from) return { ok: false, changed: false, message: "Couldn't tell which branch to rename — refresh and try again." };
      const hit = branches.find((b) => b.name === from);
      if (!hit) return { ok: false, changed: false, message: "no such branch" };
      if (branches.some((b) => b.name === to)) {
        return { ok: false, changed: false, message: "a branch of that name already exists" };
      }
      branches = branches.map((b) => (b.name === from ? { ...b, name: to } : b));
      return { ok: true, changed: true };
    },
    "branch:publish": ({ name, remote }) => {
      if (params.get("publishfails")) {
        return { ok: false, changed: false, message: "failed to push some refs" };
      }
      branches = branches.map((b) => (b.name === name ? { ...b, upstream: `${remote}/${name}` } : b));
      return { ok: true, changed: true };
    },
    // Push / pull (merge and rebase are above, at the door): nothing to model
    // beyond the contract — a full name is taken, anything else is refused as
    // main refuses it.
    "branch:push": ({ fullName }) =>
      typeof fullName === "string" && fullName.startsWith("refs/heads/")
        ? { ok: true, changed: true }
        : { ok: false, changed: false, message: "Couldn't tell which branch to push — refresh and try again." },
    "branch:pullFf": ({ fullName }) =>
      typeof fullName === "string" && fullName.startsWith("refs/heads/")
        ? { ok: true, changed: true }
        : { ok: false, changed: false, message: "Couldn't tell which branch to pull into — refresh and try again." },
    "branch:setUpstream": ({ fullName, upstream }) => {
      const name = typeof fullName === "string" && fullName.startsWith("refs/heads/") ? fullName.slice(11) : undefined;
      if (!name) return { ok: false, changed: false, message: "Couldn't tell which branch to set the upstream of — refresh and try again." };
      branches = branches.map((b) => (b.name === name ? { ...b, upstream } : b));
      return { ok: true, changed: true };
    },
    "branch:deleteRemote": ({ name }) =>
      params.get("noremotewas") === "1"
        ? { ok: true, changed: true }
        : { ok: true, changed: true, was: "18c9d0e" },
    "branch:restoreRemote": () => ({ ok: true, changed: true }),
    "status": () => (params.get("clean") ? [] : changedFiles),
    // The little external card that opens for an item living in ANOTHER
    // repository — Inbox and the cross-repo My Work rows both use it.
    "github:externalItem": ({ owner, repo, number, kind }) => ({
      kind,
      number,
      repo: `${owner}/${repo}`,
      title: repo === "trust-globe" ? "Globe tiles blank on Apple Silicon" : `Item #${number}`,
      state: "open",
      body: "Reported from the field: tiles render black above zoom 9 on M-series GPUs.",
      htmlUrl: `https://github.com/${owner}/${repo}/${kind === "pull" ? "pull" : "issues"}/${number}`,
      author: "mira-holt",
      createdAt: ISO(12),
      comments: [{ author: "s-ohta", body: "Reproduced on an M2 Air.", createdAt: ISO(5) }],
    }),
    "github:myWork": (req) => {
      if (!req || req.scope !== "all") return fixtures["github:myWork"];
      const at = (kind, type, number, repo, title, over) => ({
        kind, type, number, title, state: "open", draft: false,
        updatedAt: ISO(3), comments: 2, author: "s-ohta",
        repo: { owner: "GitStudioHQ", name: repo },
        ...over,
      });
      return [
        at("review-requested", "pr", 104, "gitstudio", "actions: stream job logs over IPC with backpressure"),
        // The SAME number in two different repositories — both must render.
        at("assigned", "issue", 31, "gitstudio", "Split views make Issues and PRs unreadable"),
        at("assigned", "issue", 31, "trust-globe", "Globe tiles blank on Apple Silicon", { repo: { owner: "antonarnaudov", name: "trust-globe" } }),
        at("mentions", "issue", 28, "gitstudio", "Rebase drag-to-reorder flickers"),
        // Work in progress, NOT waiting on you — Home must not list it.
        at("my-prs", "pr", 106, "gitstudio", "desktop: full-page detail views"),
      ];
    },
    // Stash drop, and the restore that undoes it. Mutating, for the same
    // reason the discard fixtures are.
    "stash:list": () => stashes,
    "stash:drop": (ref) => {
      const hit = stashes.find((s) => s.ref === ref);
      if (!hit) return { ok: false, changed: false, message: "no such stash" };
      dropped.set(hit.sha, hit);
      stashes = stashes.filter((s) => s.ref !== ref);
      return { ok: true, changed: true };
    },
    "stash:restore": ({ sha }) => {
      const was = dropped.get(sha);
      if (!was) return { ok: false, changed: false, message: "That stash is no longer in the repository." };
      dropped.delete(sha);
      stashes = [was, ...stashes];
      return { ok: true, changed: true };
    },
    // Discard, and the restore point that makes it undoable. Mutating for
    // real: a check that watched a row vanish and come back against a fixture
    // that returned a bare {ok:true} would be watching the harness, not the
    // app. `?nosnap=1` is the case where git has nothing to record — no
    // restore point, and therefore no undo may be offered.
    discard: (path) => {
      const had = changedFiles.filter((f) => f.path === path);
      if (!had.length) return { ok: false, changed: false, message: "no such path" };
      discarded.set(path, had);
      changedFiles = changedFiles.filter((f) => f.path !== path);
      return { ok: true, changed: true };
    },
    "discard:snapshot": () => (params.get("nosnap") === "1" ? {} : { sha: "5na9sh0t" }),
    "discard:undo": ({ sha, paths }) => {
      if (sha !== "5na9sh0t") return { ok: false, message: "unknown restore point" };
      let any = false;
      for (const p of paths || []) {
        const was = discarded.get(p);
        if (!was) continue;
        discarded.delete(p);
        changedFiles = [...changedFiles, ...was];
        any = true;
      }
      return any ? { ok: true } : { ok: false, message: "nothing to restore" };
    },
    "repos:folders": () => repoFolders.map(folderRow),
    "settings:update": (patch) => {
      if (patch && typeof patch.cloneDir === "string") {
        for (const f of repoFolders) f.isCloneDir = f.path === patch.cloneDir;
      }
      if (patch && patch.cloneDir === null) {
        for (const f of repoFolders) {
          f.isCloneDir = f.path === "/Users/demo/GitStudio";
          f.isDefaultCloneDir = f.isCloneDir;
        }
      } else if (patch && typeof patch.cloneDir === "string") {
        for (const f of repoFolders) f.isDefaultCloneDir = false;
      }
      const cur = repoFolders.find((f) => f.isCloneDir) || repoFolders[0];
      return {
        cloneDir: cur.path,
        cloneDirDisplay: cur.display,
        cloneDirIsDefault: !!cur.isDefaultCloneDir,
        askWhereEveryTime: false,
        repoFolders: repoFolders.filter((f) => !f.isCloneDir).map((f) => f.path),
      };
    },
    "repos:addFolder": () => {
      if (!repoFolders.some((f) => f.path === "/Users/demo/Sites")) {
        repoFolders.push({
          path: "/Users/demo/Sites",
          display: "~/Sites",
          real: "/Users/demo/Sites",
          isCloneDir: false,
          isDefaultCloneDir: false,
          missing: false,
        });
      }
      return repoFolders.map(folderRow);
    },
    "repos:removeFolder": (dir) => {
      repoFolders = repoFolders.filter((f) => f.path !== dir || f.isCloneDir);
      return repoFolders.map(folderRow);
    },
    // Undo's half of the two above. These are not decoration: an unfixtured
    // channel answers `undefined`, so an undo check would PASS over an undo
    // that never ran.
    "repos:addFolderPath": (dir) => {
      if (!repoFolders.some((f) => f.path === dir)) {
        const home = "/Users/demo/";
        repoFolders.push({
          path: dir,
          display: dir.startsWith(home) ? `~/${dir.slice(home.length)}` : dir,
          // `real` is not optional: containment is decided on real paths, and a
          // row without one makes every folder read answer with a throw.
          real: dir,
          isCloneDir: false,
          isDefaultCloneDir: false,
          missing: false,
        });
      }
      return repoFolders.map(folderRow);
    },
    "repos:deleteEmptyFolder": (dir) => {
      const hit = repoFolders.find((f) => f.path === dir);
      const held = hit ? counts(hit.path).containedCount : 0;
      if (held) return { ok: false, message: "That folder isn't empty." };
      repoFolders = repoFolders.filter((f) => f.path !== dir);
      return { ok: true };
    },
    "github:repos": () => ghRepos,
    "clone:pickDir": () => "/Users/demo/Code",
    "clone:start": (req) => ({
      ok: true,
      root: `${req.parentDir}/${req.name}`,
    }),
    "repos:reveal": () => true,
    "repos:removeRecent": (root) => {
      const hit = localCopies.find((c) => c.root === root);
      if (hit) hit.recent = false;
      forgotten.set(root, hit);
      localCopies = localCopies.filter((c) => c.recent || c.managed);
      return claimed(localCopies);
    },
    "repos:restoreRecent": (root) => {
      const was = forgotten.get(root);
      if (was && !localCopies.some((c) => c.root === root)) {
        localCopies = [{ ...was, recent: true }, ...localCopies];
      }
      return claimed(localCopies);
    },
    "repos:trash": (root) => {
      const gone = localCopies.find((c) => c.root === root);
      trashed.set(`/Users/demo/.Trash/${root.split("/").pop()}`, gone);
      localCopies = localCopies.filter((c) => c.root !== root);
      // `trashed` is what makes undo possible, and the app must not offer one
      // without it — `?notrashpath=1` is that case.
      return params.get("notrashpath") === "1"
        ? { ok: true, changed: true }
        : { ok: true, changed: true, trashed: `/Users/demo/.Trash/${root.split("/").pop()}` };
    },
    "repos:untrash": ({ from, to }) => {
      const was = trashed.get(from);
      if (!was) return { ok: false, message: "It is no longer in the Trash." };
      trashed.delete(from);
      localCopies = [{ ...was, root: to }, ...localCopies];
      return { ok: true };
    },
    // Server-side issue search. Deliberately returns something the LOCAL filter
    // cannot: a qualifier reaches an issue outside the loaded page, so a check
    // can tell the two paths apart rather than watching the same rows survive
    // either one.
    "issue:react": () => ({ ok: true, changed: true }),
    "issue:editComment": () => ({ ok: true, changed: true }),
    "issue:deleteComment": () => ({ ok: true, changed: true }),
    "issue:search": (req) => {
      const raw = String((req && req.query) || "");
      const words = raw.replace(/\b[a-z]+:\S+/gi, "").trim().toLowerCase();
      const hits = issues
        .filter((i) =>
          !words ||
          `${i.title} ${i.user} ${(i.labels || []).map((l) => l.name).join(" ")}`
            .toLowerCase()
            .includes(words),
        )
        .map(iss);
      if (/\b[a-z]+:\S+/i.test(raw)) {
        hits.push(
          iss({
            number: 7,
            title: "Ancient issue only reachable by qualifier",
            state: "open",
            h: 9000,
            user: me,
            comments: 0,
            labels: [],
            assignees: [],
          }),
        );
      }
      return { items: hits, totalCount: hits.length, incomplete: false };
    },
    // A review submit. The generic mutation fallback would answer {ok:true}
    // anyway — this exists so the fixture-gap report stays clean AND so the
    // payload shape is asserted where it is produced: a submit carrying
    // queued comments must name a file and a line for each.
    "pr:review": (req) => {
      for (const cm of req?.comments ?? []) {
        if (!cm.path || !cm.line || !cm.body) {
          throw new Error(`pr:review comment missing path/line/body: ${JSON.stringify(cm)}`);
        }
      }
      return { ok: true };
    },
    "issue:setLocked": ({ number, locked, reason }) => {
      lockedIssues.set(number, locked ? { reason: reason ?? null } : undefined);
      if (!locked) lockedIssues.delete(number);
      return { ok: true, changed: true };
    },
    "issue:detail": (n) => {
      const it = issues.find((i) => i.number === n);
      if (!it) return undefined;
      const lock = lockedIssues.get(n);
      return {
        issue: { ...iss(it), locked: !!lock, activeLockReason: lock?.reason ?? null },
        comments: issueComments[n] || [],
        assignees: it.assignees.map((a) => a.login),
        // Interleaved with the comments by time, so a check can prove the two
        // are merged rather than appended in two blocks.
        events: issueEvents[n] || [],
      };
    },
    "pr:detail": (n) => {
      const pr = prs.find((p) => p.number === n);
      if (!pr) return undefined;
      return { pr, files: prFiles[n] || [], checks: n === 106 ? "pending" : "success" };
    },
    "pr:conversation": (n) => prConversation[n] || [],
    "pr:files": (n) => prFiles[n] || [],
    "pr:checks": (n) => prChecks[n] || [],
    "pr:commits": (n) => prCommits[n] || [],
    // Per-run job sets. Every run used to return the same two jobs, so the
    // success path, the failure path and a many-job matrix were all
    // unreviewable — the fixture answered every question the same way.
    "actions:runDetail": (id) => {
      const run = runs.find((r) => r.id === id) || runs[0];
      const step = (name, n, concl, from, to) => ({
        name, number: n, status: concl === "in_progress" ? "in_progress" : "completed",
        conclusion: concl === "in_progress" ? "" : concl,
        startedAt: ISO(from), completedAt: concl === "in_progress" ? "" : ISO(to),
      });
      const job = (o) => ({
        id: o.id, runId: id, runAttempt: run.runAttempt || 1, name: o.name,
        status: o.status, conclusion: o.conclusion, htmlUrl: "",
        createdAt: ISO(0.42), startedAt: ISO(o.from), completedAt: o.to ? ISO(o.to) : "",
        runnerName: o.runner ?? "GitHub Actions 8", runnerGroupName: "Default",
        labels: o.labels, workflowName: run.name, headBranch: run.branch, steps: o.steps,
      });
      // A FAILED run: one job green, one red with a failing step.
      if (run.conclusion === "failure") {
        return { run, jobs: [
          job({ id: 21, name: "lint", status: "completed", conclusion: "success", from: 0.4, to: 0.36,
            labels: ["ubuntu-latest"], steps: [
              step("Checkout", 1, "success", 0.4, 0.397),
              step("npm ci", 2, "success", 0.397, 0.37),
              step("eslint", 3, "success", 0.37, 0.36),
            ] }),
          job({ id: 22, name: "test (ubuntu-latest)", status: "completed", conclusion: "failure", from: 0.4, to: 0.2,
            labels: ["ubuntu-latest"], steps: [
              step("Checkout", 1, "success", 0.4, 0.397),
              step("npm ci", 2, "success", 0.397, 0.33),
              step("Renderer tests", 3, "failure", 0.33, 0.2),
              step("Upload artifacts", 4, "skipped", 0.2, 0.2),
            ] }),
        ] };
      }
      // A SCHEDULED run: a single job, all green — the quiet happy path.
      if (run.event === "schedule") {
        return { run, jobs: [
          job({ id: 31, name: "nightly", status: "completed", conclusion: "success", from: 0.5, to: 0.2,
            labels: ["ubuntu-latest"], runner: "GitHub Actions 3", steps: [
              step("Checkout", 1, "success", 0.5, 0.497),
              step("Build", 2, "success", 0.497, 0.31),
              step("Notarize", 3, "success", 0.31, 0.2),
            ] }),
        ] };
      }
      return { run, jobs: [
        { id: 1, runId: id, runAttempt: 1, name: "build (macos-latest)", status: "completed", conclusion: "success", htmlUrl: "", createdAt: ISO(0.42), startedAt: ISO(0.4), completedAt: ISO(0.2), runnerName: "GitHub Actions 8", runnerGroupName: "Default", labels: ["macos-latest"], workflowName: "Desktop CI", headBranch: "main", steps: [
          { name: "Checkout", status: "completed", conclusion: "success", number: 1, startedAt: ISO(0.4), completedAt: ISO(0.395) },
          { name: "npm ci", status: "completed", conclusion: "success", number: 2, startedAt: ISO(0.395), completedAt: ISO(0.33) },
          { name: "Build bundles", status: "completed", conclusion: "success", number: 3, startedAt: ISO(0.33), completedAt: ISO(0.25) },
          { name: "Renderer tests", status: "completed", conclusion: "success", number: 4, startedAt: ISO(0.25), completedAt: ISO(0.2) },
        ] },
        { id: 2, runId: id, runAttempt: 1, name: "build (windows-latest)", status: "in_progress", conclusion: "", htmlUrl: "", createdAt: ISO(0.42), startedAt: ISO(0.3), completedAt: "", runnerName: "", runnerGroupName: "", labels: ["windows-latest"], workflowName: "Desktop CI", headBranch: "main", steps: [
          { name: "Checkout", status: "completed", conclusion: "success", number: 1, startedAt: ISO(0.3), completedAt: ISO(0.29) },
          { name: "npm ci", status: "in_progress", conclusion: "", number: 2, startedAt: ISO(0.29), completedAt: "" },
        ] },
        // QUEUED — no runner has picked it up. A third state the fixture had
        // none of, and one the log pane must not describe as either finished or
        // producing: Follow has nothing to follow YET, which is a different
        // sentence from having nothing left to follow.
        { id: 3, runId: id, runAttempt: 1, name: "build (ubuntu-latest)", status: "queued", conclusion: "", htmlUrl: "", createdAt: ISO(0.42), startedAt: "", completedAt: "", runnerName: "", runnerGroupName: "", labels: ["ubuntu-latest"], workflowName: "Desktop CI", headBranch: "main", steps: [] },
      ],
      };
    },
    // The OAuth Device Flow. Absent, so "Sign in with GitHub" — and the
    // "Switch account" that now starts it — could only ever render "Couldn't
    // start sign-in", and the whole flow was untestable.
    "github:deviceStart": () => ({
      ok: true,
      userCode: "WDJB-MJHT",
      verificationUri: "https://github.com/login/device",
      verificationUriComplete: "https://github.com/login/device?user_code=WDJB-MJHT",
      deviceCode: "fixture-device-code",
      interval: 5,
      expiresIn: 900,
    }),
    "github:devicePoll": () => ({ state: "pending" }),
    "orgs:repos": () => orgRepos,
    "orgs:teams": () => [ { name: "Core", slug: "core", description: "Maintainers", privacy: "closed", htmlUrl: "" } ],
    "orgs:members": () => [u(me), u("mira-holt"), u("s-ohta"), u("dkovachev"), u("jparks")].map((p) => ({ ...p, htmlUrl: "" })),
    // Spread, not copied: a move mutates `board.items`, and this must see it.
    "project:board": () => ({ ...board, unreadable: params.get("partial") ? 1 : 0 }),
    // HONOURS maxCount, as `refLog` does (it clamps to 1..100). Ignoring it hid
    // the fact that a stash's page asked for the whole ancestry of stash@{0} —
    // git's internal "index on …" commit included — under a heading reading
    // "The commit it holds", singular.
    "ref:log": (req) => {
      const all = [
        { sha: "a1", shortSha: "a1b2c3d", subject: "issues: full-page detail as a routed state", author: "Anton Arnaudov", date: S(1) },
        { sha: "b2", shortSha: "b2c3d4e", subject: "common: sectionList + detailShell primitives", author: "Anton Arnaudov", date: S(3) },
        { sha: "c3", shortSha: "c3d4e5f", subject: "css: list + detail tokens", author: "Mira Holt", date: S(6) },
      ];
      return all.slice(0, Math.min(Math.max((req && req.maxCount) || 25, 1), 100));
    },
    "gist:detail": (id) => gists.find((g) => g.id === id),
    "release:detail": (id) => releases.find((r) => r.id === id),
    // GitHub's own changelog, as the composer's "Generate release notes" asks
    // for it. Echoes the tag so a check can prove the answer landed in the
    // editor rather than some other text happening to be there.
    // Creating a release answers with the new release's ID, so the composer
    // can land ON it rather than on a list of every release.
    "release:create": () => ({ ok: true, changed: true, id: 53 }),
    "release:generateNotes": (req) => ({
      name: `Release ${req.tagName}`,
      body: `## What's Changed\n* Reorder commits by dragging in the graph by @antonarnaudov in #18\n* Carry other branches through a rebase by @mira-holt in #21\n\n**Full Changelog**: https://github.com/GitStudioHQ/gitstudio/compare/ext-v1.11.1...${req.tagName}`,
    }),
    // `{threads, unreadable}` — `?partial=1` names one thread GitHub could not return.
    "pr:reviewThreads": () => ({ threads: [
      { id: "t1", path: "apps/desktop/src/renderer/views/issues.ts", line: 42, isResolved: false, isOutdated: false,
        comments: [
          { id: "c1", author: u("mira-holt"), body: "Could this reuse `secRow` from common.ts instead of building the row by hand?", createdAt: ISO(1.4) },
          { id: "c2", author: u(me), body: "Good catch — switched to `secRow` in the next push.", createdAt: ISO(1.1) },
        ] },
      { id: "t2", path: "apps/desktop/src/renderer/views/issues.ts", line: 118, isResolved: true, isOutdated: false,
        comments: [ { id: "c3", author: u("s-ohta"), body: "This `replaceChildren` runs twice on refresh.", createdAt: ISO(2) } ] },
    ], unreadable: params.get("partial") ? 1 : 0 }),
    "actions:jobLogChunk": (req) => {
      const TS = "2026-08-25T10:00:42.1234567Z ";
      const lines = [];
      // Every job used to return the same failing log, so a green job's log
      // ended in "exit code 1" and the success path could not be reviewed.
      const failing = req.jobId === 22;
      lines.push(TS + "##[group]Run actions/checkout@v4");
      lines.push(TS + "Syncing repository: GitStudioHQ/gitstudio");
      lines.push(TS + "\u001b[36;1mgit version 2.47.0\u001b[0m");
      lines.push(TS + "##[endgroup]");
      lines.push(TS + "##[group]Run npm ci");
      for (let i = 0; i < 40; i++) lines.push(TS + "npm \u001b[2mtiming\u001b[0m package " + i + " fetched in \u001b[32m" + (20 + i) + "ms\u001b[0m");
      lines.push(TS + "npm \u001b[33mWARN\u001b[0m deprecated example@1.0.0");
      lines.push(TS + "##[endgroup]");
      lines.push(TS + "##[group]Build bundles");
      lines.push(TS + "\u001b[1m[build]\u001b[0m started");
      for (let i = 0; i < 60; i++) lines.push(TS + "  bundling module " + i + "/60 …");
      lines.push(TS + "\u001b[32m[build] finished\u001b[0m");
      lines.push(TS + "##[endgroup]");
      if (failing) {
        lines.push(TS + "##[group]Renderer tests");
        lines.push(TS + "  \u001b[31m✗\u001b[0m issues › list renders every row");
        lines.push(TS + "    expected 8 rows, got 2");
        lines.push(TS + "##[endgroup]");
        lines.push(TS + "##[error]Process completed with exit code 1.");
      } else {
        lines.push(TS + "\u001b[32mAll checks passed\u001b[0m");
        lines.push(TS + "Job completed in 11m 24s");
      }
      const full = lines.join("\n") + "\n";
      const off = Math.max(0, req.offset || 0);
      return { text: full.slice(off), totalLength: full.length, reset: off > full.length, truncated: false };
    },
    // The graph's CHANGES column asks for these lazily, per visible row. With
    // no fixture the column header sat over five empty cells — a labelled
    // column promising data that never came.
    "commit:rowStats": (shas) =>
      (shas || []).map((sha, i) => ({
        sha,
        files: [3, 1, 11, 6, 2, 8, 4, 17, 5, 1][i % 10],
        additions: [64, 9, 402, 121, 18, 233, 77, 918, 145, 4][i % 10],
        deletions: [12, 0, 96, 340, 3, 41, 512, 77, 22, 1][i % 10],
      })),
    // Every graph/branch mutation funnels through here (checkout, cherry-pick,
    // revert, reset, branch, tag). Without it `commit:action` fell through to
    // the missing-channel path and returned undefined, so the caller's
    // `result.ok` threw and the click looked inert — which is exactly how the
    // branch switcher's checkout hid while it was being tested.
    //
    // A checkout, a cherry-pick or a revert goes through the door (see
    // throughTheDoor): ?intheway=1 refuses it over uncommitted work first.
    "commit:action": (req) => {
      // What the main process answers for a branch named like an option
      // (gitBridge.checkoutRef, via git-service's optionLikeCheckout) — before
      // anything runs, so before the door too.
      if (req?.action === "checkout-ref" && typeof req.fullName === "string" && /^refs\/heads\/-/.test(req.fullName)) {
        const name = req.fullName.slice(11);
        return {
          ok: false,
          changed: false,
          expected: true,
          message: `Git can't safely check out a branch whose name starts with "-": "${name}" would be read as an option. Rename it, then check it out.`,
          optionLike: { fullName: req.fullName, name, local: true },
        };
      }
      const done = () => ({ ok: true, changed: true, message: `${req?.action ?? "action"} ok` });
      const kind = { checkout: "checkout", "checkout-ref": "checkout", "cherry-pick": "cherry-pick", revert: "revert" }[
        req?.action
      ];
      return kind ? throughTheDoor(req, kind, done) : done();
    },
    "pr:fileDiff": (req) => (/\.(png|jpe?g|gif|ico|pdf|zip|dmg|vsix|woff2?)$/i.test(req.path)
      ? {
          // A binary in a pull request used to come back as the SAME
          // placeholder string on both sides, which is two identical texts —
          // and the unified view collapses a zero-change diff to a single
          // "N hidden lines" band, so it rendered completely empty while the
          // side-by-side view showed the placeholder twice.
          path: req.path,
          leftLabel: "main",
          rightLabel: "redesign/issues-detail",
          leftText: "",
          rightText: "",
          conflicted: false,
          binary: true,
        }
      : {
      path: req.path,
      leftLabel: "main",
      rightLabel: "redesign/issues-detail",
      leftText: 'const view = ghTwoPane();\nconst listEl = view.listEl;\nconst detail = view.detailEl;\n\nfunction select(it, row) {\n  row.classList.add("active");\n  showDetail(detail, it.number);\n}\n',
      rightText: 'const { view, listEl } = sectionList();\n\nfunction open(it) {\n  nav("issues", { number: it.number });\n}\n',
      conflicted: false,
        }),
  };

  // IssueInfo body normalizer (fixtures store a trimmed shape).
  function iss(it) {
    return { number: it.number, title: it.title, body: it.body || "", state: it.state, htmlUrl: "https://github.com/GitStudioHQ/gitstudio/issues/" + it.number, user: it.user, createdAt: ISO(it.h), updatedAt: ISO(it.h / 2), comments: it.comments, labels: it.labels, assignees: it.assignees, milestone: it.milestone || null,
      closedAt: it.state === "closed" ? ISO(it.h / 3) : null,
      closedBy: it.state === "closed" ? u(me) : null,
      stateReason: it.stateReason || (it.state === "closed" ? "completed" : null),
      authorAssociation: it.assoc || "CONTRIBUTOR",
      reactions: it.reactions };
  }
  // The list handler must return IssueInfo shapes too.
  fixtures["issue:list"] = issues.map(iss);
  // ?many=1 → synthesize a capped-size list (300) to exercise the cap notice.
  if (params.get("many")) {
    const synth = [];
    for (let i = 0; i < 300; i++) {
      synth.push(iss({ number: 400 + i, title: `Synthetic issue #${400 + i} for pagination testing`, state: "open", user: u("renderbot"), labels: i % 3 ? [L.bug] : [L.ux], assignees: [], comments: i % 7, h: i + 1 }));
    }
    fixtures["issue:list"] = synth;
  }

  // ── Code browser: a real tree, so the file viewer is reachable ─────────────
  //
  // Without these two the Code view painted "Empty repository" in every run,
  // and no check could reach the file viewer at all — which is exactly why its
  // Back button spent months bypassing the navigation history unnoticed.
  const TREE = {
    "": [
      { name: "apps", path: "apps", type: "tree" },
      { name: "packages", path: "packages", type: "tree" },
      { name: "README.md", path: "README.md", type: "blob", size: 4213 },
      { name: "package.json", path: "package.json", type: "blob", size: 1187 },
      { name: "tsconfig.json", path: "tsconfig.json", type: "blob", size: 642 },
    ],
    apps: [
      { name: "desktop", path: "apps/desktop", type: "tree" },
      { name: "extension", path: "apps/extension", type: "tree" },
    ],
    "apps/desktop": [
      { name: "src", path: "apps/desktop/src", type: "tree" },
      { name: "esbuild.js", path: "apps/desktop/esbuild.js", type: "blob", size: 3902 },
    ],
    packages: [
      { name: "git-service", path: "packages/git-service", type: "tree" },
      { name: "webview-ui", path: "packages/webview-ui", type: "tree" },
    ],
  };
  const FILES = {
    "README.md": "# GitStudio\n\nA Git client that shows you what is about to happen.\n\n## Building\n\n    npm install\n    npm run build\n",
    "package.json": '{\n  "name": "gitstudio",\n  "private": true,\n  "workspaces": ["apps/*", "packages/*"]\n}\n',
    "tsconfig.json": '{\n  "compilerOptions": {\n    "target": "ES2022",\n    "strict": true\n  }\n}\n',
    "apps/desktop/esbuild.js": 'const esbuild = require("esbuild");\n\nesbuild.build({ entryPoints: ["src/main/main.ts"] });\n',
  };
  dynamic["repo:tree"] = (req) => TREE[(req && req.path) || ""] || [];
  dynamic["repo:file"] = (req) => {
    const path = (req && req.path) || "";
    return path in FILES ? { path, text: FILES[path] } : undefined;
  };

  // ── commit:details — so the commit PAGE is reachable at all ──────────────
  //
  // Three shapes, because the page branches on all three: an ordinary commit
  // whose committer differs from its author (a cherry-pick — the case a single
  // "author" line hides), a MERGE with two parents, and a sha the repository
  // does not have, which is the honest dead-end for a fork's commit.
  const commitFiles = (spec) =>
    spec.map(([status, path, additions, deletions, oldPath]) => ({
      path,
      status,
      additions,
      deletions,
      ...(oldPath ? { oldPath } : {}),
    }));
  const commits = {
    // The compare view's own commits, so "open a commit from Compare" is a
    // scene that lands on a real page rather than the honest-but-untestable
    // "this commit isn't in your clone".
    "18c9d0e1": {
      kind: "commit",
      sha: "18c9d0e1f2736485a1b2c3d4e5f60718293a4b5c",
      shortSha: "18c9d0e",
      parents: ["29d0e1f2736485a1b2c3d4e5f60718293a4b5c6d"],
      author: "mira-holt",
      authorEmail: "mira@gitstudio.dev",
      authorDate: Math.floor(Date.now() / 1000) - 20 * 3600,
      committer: "mira-holt",
      committerEmail: "mira@gitstudio.dev",
      committerDate: Math.floor(Date.now() / 1000) - 20 * 3600,
      subject: "engine: hunk splitting groundwork",
      body: "Extracts the split point search so the selection path can reuse it.",
      refs: [],
      files: commitFiles([
        ["M", "packages/engine/src/hunks.ts", 84, 12],
        ["A", "packages/engine/test/hunks.test.ts", 121, 0],
      ]),
      hasRemote: true,
    },
    a1b2c3d4: {
      kind: "commit",
      sha: "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678",
      shortSha: "a1b2c3d",
      parents: ["b2c3d4e5f60718293a4b5c6d7e8f901234567890"],
      author: me,
      authorEmail: "anton@gitstudio.dev",
      authorDate: Math.floor(Date.now() / 1000) - 3 * 3600,
      // Committer differs: this was cherry-picked by someone else.
      committer: "mira-holt",
      committerEmail: "mira@gitstudio.dev",
      committerDate: Math.floor(Date.now() / 1000) - 2 * 3600,
      subject: "issues: full-page detail as a routed state",
      body:
        "The split view could not show a body, a timeline and a rail at once on\n" +
        "a 13\" screen, so all three were cropped.\n\nCloses #31.",
      refs: [{ name: "redesign/wave-2", fullName: "refs/heads/redesign/wave-2", kind: "currentHead" }],
      files: commitFiles([
        ["M", "apps/desktop/src/renderer/views/issues.ts", 402, 260],
        ["A", "apps/desktop/src/renderer/views/common.ts", 188, 0],
        ["R", "apps/desktop/src/renderer/views/issueDetail.ts", 12, 4, "apps/desktop/src/renderer/issueDetail.ts"],
        ["D", "apps/desktop/src/renderer/legacySplit.ts", 0, 231],
        ["M", "apps/desktop/src/renderer/styles/app.css", 96, 31],
        ["M", "apps/desktop/harness/checks.js", 41, 0],
        ["A", "apps/desktop/assets/issue-empty.png", -1, -1],
      ]),
      hasRemote: true,
    },
    b2c3d4e5: {
      kind: "commit",
      sha: "b2c3d4e5f60718293a4b5c6d7e8f901234567890",
      shortSha: "b2c3d4e",
      // A MERGE — two parents, so the page's parent chips have to handle plural.
      parents: [
        "c3d4e5f60718293a4b5c6d7e8f90123456789012",
        "d4e5f60718293a4b5c6d7e8f9012345678901234",
      ],
      author: me,
      authorEmail: "anton@gitstudio.dev",
      authorDate: Math.floor(Date.now() / 1000) - 26 * 3600,
      committer: me,
      committerEmail: "anton@gitstudio.dev",
      committerDate: Math.floor(Date.now() / 1000) - 26 * 3600,
      subject: "Merge branch 'main' into redesign/wave-2",
      body: "",
      refs: [
        { name: "main", fullName: "refs/heads/main", kind: "head" },
        { name: "origin/main", fullName: "refs/remotes/origin/main", kind: "remoteHead" },
        { name: "desktop-v1.6.0", fullName: "refs/tags/desktop-v1.6.0", kind: "tag" },
      ],
      files: commitFiles([["M", "apps/desktop/src/renderer/renderer.ts", 14, 2]]),
      hasRemote: true,
    },
  };
  // A commit the size of a real merge. The page had only ever been driven
  // against seven files, and "it works at seven" says nothing about the column
  // width, the scrolling, or the cost of building every row up front.
  const bigFiles = [];
  const AREAS = ["src/main", "src/renderer/views", "src/renderer/styles", "packages/engine/src", "test"];
  for (let i = 0; i < 420; i++) {
    const area = AREAS[i % AREAS.length];
    const st = ["M", "M", "M", "A", "D", "R"][i % 6];
    bigFiles.push({
      path: `apps/desktop/${area}/generated/module-${String(i).padStart(3, "0")}.ts`,
      status: st,
      additions: st === "D" ? 0 : (i * 7) % 340,
      deletions: st === "A" ? 0 : (i * 3) % 180,
      ...(st === "R" ? { oldPath: `apps/desktop/${area}/old/module-${i}.ts` } : {}),
    });
  }
  commits.f00dbabe = {
    kind: "commit",
    sha: "f00dbabe1234567890abcdef1234567890abcdef",
    shortSha: "f00dbab",
    parents: ["a1b2c3d4e5f60718293a4b5c6d7e8f9012345678", "b2c3d4e5f60718293a4b5c6d7e8f901234567890"],
    author: me,
    authorEmail: "anton@gitstudio.dev",
    authorDate: Math.floor(Date.now() / 1000) - 7200,
    committer: me,
    committerEmail: "anton@gitstudio.dev",
    committerDate: Math.floor(Date.now() / 1000) - 7200,
    subject: "Merge the generated-module migration",
    body: "420 files, which is an ordinary size for a codemod or a lockfile bump.",
    refs: [],
    files: bigFiles,
    hasRemote: true,
  };

  // The graph's branch filter (issue #30). `graph:load` takes `refs` — the
  // fully-qualified refs to build the graph around, or a preset's symbols
  // ("@current" …, which follow HEAD), null for all, omitted for "whatever is
  // remembered" — and answers with the filter it applied RESOLVED to full
  // names, the preset it is (refPreset), plus the FULL ref list, filtered-out
  // refs included, or the picker could never tick one back in. The walk is
  // what git does with `git log --stdin <refs>`: HEAD joins only when detached
  // (it is attached here, on main), a row no ticked ref reaches is gone, and
  // chips follow exactly the ticked refs — the current branch's included.
  // Without this the picker was a control with no fixture behind it: every
  // tick would have answered the same ten rows and a check could pass over a
  // dead filter.
  const graphBase = fixtures["graph:load"];
  /** sha → the refs that ALONE reach it; every other row is on main's line. */
  const reachOnly = { "77aa88b9c0d1e2f3a4b5": ["refs/remotes/origin/chore/dependabot-bump"] };
  const mainLine = new Set(graphBase.rows.map((r) => r.sha).filter((sha) => !reachOnly[sha]));
  /** What a ref reaches when it is not on main's line: the unmerged remote
   *  reaches its own commit and the one it forked from; the feature branch its
   *  lane and the trunk below its fork (featureLane, below). */
  const reachOf = (full) =>
    full === "refs/remotes/origin/chore/dependabot-bump"
      ? new Set(["77aa88b9c0d1e2f3a4b5", "29d0e1f2837495b2c3d4"])
      : full === "refs/heads/redesign/issues-detail" || full === "refs/remotes/origin/redesign/issues-detail"
        ? featureLane
        : mainLine;
  const PRESETS = { current: ["@current"], currentUpstream: ["@current", "@upstream"], local: ["@local"] };
  const SYMBOLS = new Set(["@current", "@upstream", "@local"]);
  /** host-bridge's resolveRefFilter, over the picker's list. */
  const resolveFilter = (filter, list) => {
    if (!filter) return null;
    const cur = list.find((e) => e.kind === "head" && e.isCurrent);
    const out = [];
    const add = (f) => { if (f && !out.includes(f)) out.push(f); };
    for (const f of filter) {
      if (f === "@current") add(cur && cur.fullName);
      else if (f === "@upstream") add(cur && cur.upstream);
      else if (f === "@local") list.filter((e) => e.kind === "head").forEach((e) => add(e.fullName));
      else add(f);
    }
    return out;
  };
  const presetOf = (filter) => {
    if (!filter) return undefined;
    const key = [...filter].sort().join(",");
    return Object.keys(PRESETS).find((id) => [...PRESETS[id]].sort().join(",") === key);
  };
  const chipFullName = (chip) =>
    chip.kind === "tag" ? "refs/tags/" + chip.name
    : chip.kind === "remoteHead" ? "refs/remotes/" + chip.name
    : "refs/heads/" + chip.name;
  const graphRefList = () => {
    const refs = fixtures["refs:list"];
    const bySh = new Map(refs.filter((r) => r.type === "remote" && !r.symref).map((r) => [r.name, r.fullName]));
    return refs
      .filter((r) => r.type !== "stash" && !(r.type === "remote" && r.symref))
      .map((r) => {
        const e = { fullName: r.fullName, name: r.name, kind: r.type === "tag" ? "tag" : r.type === "remote" ? "remoteHead" : "head" };
        if (r.type === "head" && r.isCurrent) e.isCurrent = true;
        if (r.type === "head" && r.upstream && bySh.get(r.upstream)) e.upstream = bySh.get(r.upstream);
        return e;
      });
  };
  /** Remembered for the session, like the app's per-repo setting — as
   *  STORED: a preset stays its symbols, and is resolved per load. */
  let graphRefFilter = null;
  /** The walk of the last load (resolved), which graph:reaches answers from. */
  let graphWalk = null;
  window.__GS_GRAPH_LOADS = [];
  dynamic["graph:load"] = (req) => {
    const list = graphRefList();
    const known = new Set(list.map((e) => e.fullName));
    if (req && req.refs !== undefined) {
      const kept = Array.isArray(req.refs) ? req.refs.filter((r) => known.has(r) || SYMBOLS.has(r)) : [];
      graphRefFilter = kept.length ? kept : null;
    }
    const walk = resolveFilter(graphRefFilter, list);
    graphWalk = walk;
    const refPreset = presetOf(graphRefFilter);
    // The list rides along only when the caller does not already hold it, the
    // way the main process does it (refListFor): the renderer says which list
    // it has in `refListSig`. Any stable fingerprint will do here — the real
    // one is refListSignature's hash; what matters is the comparison.
    const sig = "shim:" + JSON.stringify(list);
    const sendList = !req || req.refListSig !== sig;
    window.__GS_GRAPH_LOADS.push({
      skip: req && req.skip,
      refs: req && req.refs,
      applied: graphRefFilter,
      walked: walk,
      sentRefList: sendList,
    });
    const ticked = new Set(walk || []);
    const reached = new Set();
    for (const f of walk || []) for (const sha of reachOf(f)) reached.add(sha);
    const rows = graphBase.rows
      .filter((r) => !walk || reached.has(r.sha))
      .map((r) => ({
        ...r,
        refs: walk ? r.refs.filter((c) => ticked.has(chipFullName(c))) : r.refs,
      }));
    const out = { ...graphBase, rows, nextSkip: rows.length, refFilter: walk, refListSig: sig };
    if (refPreset) out.refPreset = refPreset;
    if (sendList) out.refList = list;
    else delete out.refList;
    return out;
  };
  // A reveal that finds no row under a filter asks whether the walk reaches
  // the commit at all, before saying why (issue #30) — the same reach model
  // as graph:load above, so the two cannot disagree about a row.
  dynamic["graph:reaches"] = (req) => {
    if (!graphWalk) return { reached: true };
    return { reached: graphWalk.some((f) => reachOf(f).has(req && req.sha)) };
  };
  // The details pane's "in N branches" row — the same reach model again, so
  // the row cannot disagree with the graph it sits beside. A row only the
  // unmerged remote reaches is in that branch alone; every other row is on
  // main and its upstream, and the rows below the merged feature lane's tip
  // (the lane's own two, then the trunk from where it forked) are on that
  // branch too. Locals first, then remotes, as the real read sorts them.
  // Without this the row answered undefined and the pane showed nothing.
  const featureLane = new Set([
    "b2c3d4e5f6a71829304b", "c3d4e5f6a7b829304c5d", "f6a7b8c9d0e152637f80",
    "07b8c9d0e1f263748091", "18c9d0e1f2736485a1b2", "29d0e1f2837495b2c3d4",
  ]);
  dynamic["refs:contains"] = (req) => {
    // The pane asks with the details fixture's 40-char sha; the rows carry
    // the same commits as 20-char prefixes.
    const sha = String((req && req.sha) || "").slice(0, 20);
    const only = reachOnly[sha];
    // `refs`: the same branches by full name, as RefProvider answers.
    if (only) return { branches: only.map((f) => f.replace(/^refs\/(heads|remotes)\//, "")), refs: [...only], truncated: false };
    if (!graphBase.rows.some((r) => r.sha === sha)) return { branches: [], refs: [], truncated: false };
    const onLane = featureLane.has(sha);
    const branches = [
      "main", ...(onLane ? ["redesign/issues-detail"] : []),
      "origin/main", ...(onLane ? ["origin/redesign/issues-detail"] : []),
    ];
    return {
      branches,
      refs: branches.map((b) => (b.startsWith("origin/") ? "refs/remotes/" : "refs/heads/") + b),
      truncated: false,
    };
  };

  dynamic["commit:details"] = (sha) => commits[String(sha).slice(0, 8)];
  // "did this come from the branch I am on, or was it merged in" — the first
  // question a reader has about a commit, which the page could not answer.
  dynamic["commit:branches"] = (sha) => {
    const key = String(sha).slice(0, 8);
    if (key === "b2c3d4e5") return { branches: ["main", "redesign/wave-2"], onCurrent: true, current: "main" };
    if (key === "f00dbabe") return { branches: ["redesign/wave-2"], onCurrent: false, current: "main" };
    return { branches: ["redesign/wave-2", "main"], onCurrent: true, current: "redesign/wave-2" };
  };

  // The diff pane's header must name the file that was ASKED for. A fixed path
  // here showed one file's name over another file's diff, which reads as a bug
  // in the page rather than in the fixture — and it hid the fact that the
  // commit page was requesting the right path all along.
  // The CHANGES view's diff — the most-used diff surface in the app, and it had
  // no fixture at all, so every scene that clicked a changed file landed on the
  // empty state and nothing about it was ever checked.
  dynamic["file:diff"] = (req) => {
    const path = (req && req.path) || "apps/desktop/src/renderer/views/issues.ts";
    const name = path.split("/").pop() || path;
    // Whitespace-ONLY: line 2 is re-indented, line 3 gains trailing spaces.
    // With the toggle off both views must show two changed lines; with it on
    // both must show none. Any other combination means the split view and the
    // unified view are running different rules over the same file.
    // The DISCRIMINATING file: its only change is a doubled space INSIDE a
    // line. Monaco cannot ignore that — `ignoreTrimWhitespace` reaches only the
    // ends of a line — so a split view that hides it is a split view that
    // disagrees with the unified view about the same file. This is the fixture
    // that fails if the toggle ever sends the engine's "all" mode again.
    if (/spacing-inner\.ts$/.test(path)) {
      const left = "export function pad(n: number): string {\n  return \" \".repeat(n);\n}\n";
      const right = "export function pad(n: number): string {\n  return  \" \".repeat(n);\n}\n";
      return {
        path,
        leftLabel: `HEAD ${path}`,
        rightLabel: `Working Tree ${path}`,
        leftText: left,
        rightText: right,
        conflicted: false,
        indexText: left,
      };
    }
    if (/spacing\.ts$/.test(path)) {
      const left = "export function pad(n: number): string {\n  return \" \".repeat(n);\n}\n";
      const right = "export function pad(n: number): string {\n      return \" \".repeat(n);\n}   \n";
      return {
        path,
        leftLabel: `HEAD ${path}`,
        rightLabel: `Working Tree ${path}`,
        leftText: left,
        rightText: right,
        conflicted: false,
        indexText: left,
      };
    }
    if (/\.(png|jpe?g|gif|ico|pdf|zip|dmg|vsix|woff2?)$/i.test(path)) {
      return {
        path,
        leftLabel: `HEAD ${path}`,
        rightLabel: `Working Tree ${path}`,
        leftText: "",
        rightText: "",
        conflicted: false,
        binary: true,
      };
    }
    return {
      path,
      leftLabel: `HEAD ${path}`,
      rightLabel: `Working Tree ${path}`,
      leftText: `// ${name}\nexport function render(list) {\n  return list.map(row);\n}\n`,
      rightText: `// ${name}\nexport function render(list, opts) {\n  // keep the selection across a repaint\n  return list.map((r) => row(r, opts));\n}\n`,
      conflicted: false,
      // A working-tree diff carries the INDEX text too — it is the third text
      // the staging ticks need to say whether each change is already staged.
      indexText: `// ${name}\nexport function render(list) {\n  return list.map(row);\n}\n`,
    };
  };

  dynamic["compare:fileDiff"] = (req) => {
    const path = (req && req.path) || "packages/engine/src/hunks.ts";
    const name = path.split("/").pop() || path;
    // A BINARY file has no text diff. Mounting an editor over two empty strings
    // is what "the diff doesn't show" looked like; the panel says so now, and
    // this is the fixture that exercises it.
    if (/\.(png|jpe?g|gif|ico|pdf|zip|dmg|vsix|woff2?)$/i.test(path)) {
      return {
        path,
        leftLabel: `${(req && req.base) || "main"} ${path}`,
        rightLabel: `${(req && req.head) || "HEAD"} ${path}`,
        leftText: "",
        rightText: "",
        conflicted: false,
        binary: true,
      };
    }
    return {
      path,
      leftLabel: `${(req && req.base) || "main"} ${path}`,
      rightLabel: `${(req && req.head) || "HEAD"} ${path}`,
      leftText: `// ${name}\nexport function computeHunks(a: string, b: string): Hunk[] {\n  return diff(a, b);\n}\n`,
      rightText: `// ${name}\nexport function computeHunks(a: string, b: string): Hunk[] {\n  // split on a selection boundary (issue #20)\n  return diff(a, b).flatMap(splitOnSelection);\n}\n`,
      conflicted: false,
    };
  };

  // Auth is a state, not a constant. `github:disconnect` flips it, so a check
  // can drive Sign out / Switch account and see what the app does about it.
  let connected = params.get("signedout") !== "1";
  // `?unlocked=0` is the state a real launch starts in: the token FILE exists,
  // so you are connected, but it has not been decrypted yet (decrypting raises
  // the OS keychain prompt), so the login name is not known. The chip used to
  // render that as "Sign in".
  const nameKnown = params.get("unlocked") !== "0";
  dynamic["github:status"] = () =>
    connected
      ? {
          connected: true,
          ...(nameKnown ? { login: me } : {}),
          repo: { owner: "GitStudioHQ", ownerType: "Organization", mine: false, repo: "gitstudio" },
        }
      : { connected: false };
  dynamic["github:disconnect"] = () => {
    connected = false;
    return { ok: true, changed: true };
  };

  // Every routeView the app performs, in order. Created HERE so production
  // never has it — the renderer only pushes when the array exists.
  window.__GS_ROUTES = [];

  const missing = new Set();

  // ── What the app SENT, and what it sent WITH ────────────────────────────
  //
  // This recorded channel NAMES only, so no check could ever assert a payload
  // — "did Take theirs ask about the right path", "did the composer send the
  // body it was showing", "was this refetched or served from cache". Records
  // are `{channel, payload}` now, `calls` counts per channel for the caching
  // assertions, and both are exposed for checks to read.
  const invoked = [];
  const calls = Object.create(null);
  window.__GS_INVOKED = invoked;
  window.__GS_CALLS = calls;
  /** Channel names in order — what the old array was, for a name-only check. */
  window.__gsSent = (re) =>
    invoked.map((r) => r.channel).filter((c) => (re ? re.test(c) : true));

  // `?fail=a:b,c:d` makes those channels REJECT. Every error path in the app —
  // the errorState-with-Retry branches, the toasts, the empty-vs-failed
  // distinction — was unreachable from the harness, which is why several
  // surfaces launder a read failure into a confident empty state and no check
  // noticed.
  const failing = new Set((params.get("fail") || "").split(",").filter(Boolean));

  /** channel → listeners, for `on()` / `__gsEmit()`. */
  const listeners = {};

  window.gitstudio = {
    invoke(channel, payload) {
      invoked.push({ channel, payload });
      calls[channel] = (calls[channel] || 0) + 1;
      if (failing.has(channel)) {
        return Promise.reject(new Error(`${channel} failed (harness ?fail=)`));
      }
      if (channel in dynamic) {
        try { return Promise.resolve(dynamic[channel](payload)); } catch (e) { return Promise.reject(e); }
      }
      if (channel in fixtures) {
        // issue:list respects the state filter so Open/Closed/All work.
        if (channel === "issue:list" && payload && payload.state && payload.state !== "all") {
          return Promise.resolve(fixtures[channel].filter((i) => i.state === payload.state));
        }
        return Promise.resolve(fixtures[channel]);
      }
      missing.add(channel);
      console.error("[shim missing]", channel, JSON.stringify(payload));
      // Mutations: pretend success so flows continue; reads: undefined.
      // Anchored at the END of the channel name (or before a capitalised word),
      // because a plain substring test matched ":set" inside "ai:settings" — a
      // READ answered with `{ ok: true }`, which is why aiEnabled() memoised
      // `undefined` and re-asked over IPC on every route for months.
      if (
        /:(set|create|edit|comment|merge|rerun|cancel|dispatch|markRead|markAllRead|apply|update|upload|delete|approve|review)(?=$|[A-Z])/.test(
          channel,
        ) ||
        // The rest of the app's MUTATION verbs. Everything not listed here fell
        // through to `undefined`, so the caller's `r.ok` threw and the control
        // looked inert — the shim's own note on `commit:action` records that
        // this is how the branch switcher's checkout hid while being tested.
        // A mutation with no fixture should still let the flow continue; a READ
        // with no fixture should not be invented, and still answers undefined.
        /:(push|pull|pullFf|fetch|pop|drop|save|stage|abort|continue|skip|checkout|rename|resolve|takeSide|add|remove|open|openPath|close|kill|resize|write|install|download|check|connect|addItem|moveItem|start|test|rebase|markReady|replyThread|requestReviewers|agentRun|agentConfirm|chatSend|chatNew|chatDelete|chatSetCurrent|mcpInstall|devicePoll|deviceStart)(?=$|[A-Z])/.test(
          channel,
        ) ||
        // The one mutation whose VERB is the domain rather than the action.
        channel === "stage:lines"
      ) {
        return Promise.resolve({ ok: true, changed: false });
      }
      return Promise.resolve(undefined);
    },
    // A REAL subscription registry. This returned a no-op unsubscribe and threw
    // the listener away, so every push-driven path in the app — streamed agent
    // deltas and tool steps, log tails, file-change notices, the unread badge —
    // was unreachable from a scene. A probe or check drives them with
    // `__gsEmit(channel, payload)`.
    on(channel, fn) {
      (listeners[channel] || (listeners[channel] = [])).push(fn);
      return () => {
        const a = listeners[channel] || [];
        const i = a.indexOf(fn);
        if (i >= 0) a.splice(i, 1);
      };
    },
  };

  /** Deliver a main-process push event to everything listening for it.
   *  Returns how many listeners saw it, so a probe can tell "nothing happened"
   *  from "nothing was listening". */
  window.__gsEmit = (channel, payload) => {
    const a = (listeners[channel] || []).slice();
    for (const fn of a) {
      try { fn(payload); } catch (e) { console.error("[shim emit]", channel, e); }
    }
    return a.length;
  };

  // ── scene driver ──
  /**
   * Scene selectors pierce ONE level of shadow DOM.
   *
   * The commit graph is a Lit element, so its ref chips live in a shadow root
   * and `document.querySelector` cannot see them. That made the graph's
   * richest interaction — clicking a branch chip — unreachable from any scene,
   * which is exactly why the deep-link landing shipped broken and unscreenshot.
   */
  const q = (sel) => {
    const direct = document.querySelector(sel);
    if (direct) return direct;
    for (const host of document.querySelectorAll("*")) {
      if (!host.shadowRoot) continue;
      const hit = host.shadowRoot.querySelector(sel);
      if (hit) return hit;
    }
    return null;
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  async function until(fn, timeout = 8000) {
    const t0 = Date.now();
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() - t0 > timeout) throw new Error("timeout: " + fn);
      await wait(60);
    }
  }
  async function drive() {
    // Either screen. With ?norepo=1 the app boots to the WELCOME screen and
  // `.screen.repo` never appears, so the driver timed out and every probe
  // against that scene came back with no result at all — which is why the
  // first thing anyone sees had never been driven here.
  await until(() => q(".screen.repo") || q(".welcome-recent") || q(".screen.welcome"));
    // Some views are NOT in the app's TABS list — Settings lives in the rail's
    // footer — and `prefs.currentView` is validated against TABS, so seeding it
    // silently fell back to "changes". The `settings` scene therefore screenshot
    // and checked the CHANGES view for as long as this harness has existed, and
    // Settings had no coverage at all. Click the rail item when the seed did not
    // take, so a scene name always means the view it names.
    // …except on a first run, where the whole point is to see where the app
    // takes you when nothing has chosen for it. Driving to the scene's view
    // here would answer the question with its own input, which is exactly what
    // the landing check used to do.
    const rail = firstRun ? null : q(`[data-view="${view}"]`);
    if (rail && rail.getAttribute("aria-current") !== "page" && !rail.classList.contains("active")) {
      rail.click();
      await wait(250);
    }
    for (const step of steps) {
      await wait(250);
      if (step === "bell") {
        const bell = q('[aria-label*="otification"], .topbar-bell, [title*="otification"]');
        if (bell) bell.click();
      } else if (step.startsWith("open")) {
        const num = step.slice(4);
        const row = await until(() => q(`[data-num="${num}"]`));
        row.click();
      } else if (step.startsWith("click:")) {
        const sel = decodeURIComponent(step.slice(6));
        const elx = await until(() => q(sel));
        elx.click();
      } else if (step.startsWith("scroll:")) {
        const sel = decodeURIComponent(step.slice(7));
        const target = await until(() => q(sel));
        target.scrollIntoView({ block: "center" });
      } else if (step.startsWith("type:")) {
        // Type into the focused input (palette, search fields).
        const val = decodeURIComponent(step.slice(5));
        const editable = (n) => n && (n.tagName === "INPUT" || n.tagName === "TEXTAREA");
        const inp = editable(document.activeElement)
          ? document.activeElement
          : await until(() =>
              q("input:focus") || q("textarea:focus") || q(".cmdk-card input") || q("input") || q("textarea"),
            );
        inp.value = val;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (step.startsWith("text:")) {
        // Click the first button/row whose visible text contains the needle,
        // PREFERRING one inside the view over one in the navigation rail.
        //
        // Document order put the rail first, so `text:Commits` inside a pull
        // request clicked the rail's Commits item and navigated to the graph —
        // a scene that reads as "open the PR's Commits tab" and silently did
        // the opposite. Any needle that names both a section and a sub-tab hits
        // this: Commits, Files, Checks, Releases, Issues.
        const needle = decodeURIComponent(step.slice(5)).toLowerCase();
        const SEL = "button, [role=option], [role=tab], .list-row, .cmdk-row";
        const matches = (root) =>
          Array.from(root.querySelectorAll(SEL)).find((b) =>
            (b.textContent || "").toLowerCase().includes(needle),
          );
        const hit = await until(() => {
          const host = document.querySelector("#view-host, .view-host, main") || document;
          return matches(host) || matches(document);
        });
        hit.click();
      } else if (step === "palette") {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      } else if (step === "esc") {
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      } else if (step.startsWith("key:")) {
        const key = decodeURIComponent(step.slice(4));
        // Dispatch on the FOCUSED element when there is one: a real keypress
        // goes to what has focus and bubbles up, which is what handlers on an
        // input (Enter-to-search) actually listen for.
        const target = document.activeElement && document.activeElement !== document.body
          ? document.activeElement
          : window;
        target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
      }
      await wait(350);
    }
    await wait(600);
    // Functional mode: run the named assertion and publish the verdict in the
    // title, which is the one channel --dump-dom always carries back.
    // Probe mode: evaluate an arbitrary expression against the driven scene and
    // publish the result in the title. This is how an investigator inspects a
    // surface — geometry, computed styles, aria, focus — without having to add
    // a named case to the shared checks file first.
    const probe = params.get("probe");
    if (probe) {
      let out;
      try {
        // eslint-disable-next-line no-new-func
        out = await new Function(`"use strict"; return (async () => { ${probe} })()`)();
      } catch (e) {
        out = { error: String((e && e.stack) || e) };
      }
      let text;
      try {
        text = JSON.stringify(out === undefined ? null : out);
      } catch {
        text = JSON.stringify(String(out));
      }
      document.title = "PROBE " + (text.length > 60000 ? text.slice(0, 60000) + "…" : text);
      return;
    }

    const checkId = params.get("check");
    if (checkId) {
      // A case may be parameterised (?arg=...): one assertion, several shapes.
      window.__GS_ARG = params.get("arg") || undefined;
      const suite = window.__GS_CHECKS || {};
      const fn = suite[checkId];
      if (!fn) {
        document.title = "CHECK " + JSON.stringify({ id: checkId, fails: ["no such check"] });
        return;
      }
      const fails = [];
      // `repaints=1`: the frames a LOADED machine delivers, on demand.
      //
      // Headless Chrome runs the page on a virtual clock but produces frames on
      // the real one, and a frame is when ResizeObserver callbacks are
      // delivered. Idle, a whole check finishes between two frames; under load
      // one lands inside a check's `settle()`, and the log pane's observer
      // repaints its virtual window (`win.replaceChildren()`) — removing any
      // row the check had put there. Two Actions-log checks failed that way
      // about one run in forty under parallel load and never alone. A `resize`
      // on the window runs the same repaint, so firing it every 40ms makes the
      // loaded machine's worst case the ordinary one: a check that races a
      // repaint fails every time here instead of once in a while in CI.
      const repaints = params.get("repaints") === "1"
        ? setInterval(() => window.dispatchEvent(new Event("resize")), 40)
        : 0;
      try {
        // A check may return a promise: some assertions have to CLICK something
        // and wait, and several of the views re-render behind an await (a
        // ghGate, a fetch), so a synchronous measurement right after a click
        // reads the OLD dom and passes for the wrong reason.
        await fn(fails);
      } catch (e) {
        fails.push("threw: " + (e && e.message ? e.message : String(e)));
      }
      if (repaints) clearInterval(repaints);
      // Report the channels this scene asked for and the shim could not answer.
      // NOT as failures — most are legitimately absent — but as a note the
      // runner prints once at the end. A read with no fixture returns undefined
      // and the caller's `.ok`/`.length` throws, so a check can pass while
      // silently exercising a throw instead of the path it was written for.
      // That is exactly how the pull request's label picker went unchecked.
      document.title =
        "CHECK " + JSON.stringify({ id: checkId, fails, miss: [...missing].sort() });
      return;
    }
    document.title = "SCENE-READY";
  }
  window.addEventListener("DOMContentLoaded", () => { drive().catch((e) => console.error("[driver]", e)); });
})();
