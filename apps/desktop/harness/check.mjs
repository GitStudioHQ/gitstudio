#!/usr/bin/env node
// The functional half of the harness.
//
// Screenshots prove a surface renders; they cannot prove the count badge
// tracks the filter, that a disabled button is disabled, that a menu is
// dismissed on navigation, or that two columns share an x. This drives each
// scene in headless Chrome, runs the matching assertion from harness/checks.js
// INSIDE the page, and reports pass/fail.
//
//   node harness/check.mjs                 # everything
//   node harness/check.mjs count palette   # only cases matching these substrings
//
// Exit code is non-zero if any case fails, so it can gate a commit.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PAGE = process.env.GS_HARNESS_PAGE
  ? resolve(process.env.GS_HARNESS_PAGE, "harness.html")
  : resolve(HERE, "page/harness.html");
// GS_CHROME points the harness at another Chrome (a Chrome for Testing build,
// when there is no /Applications copy); the app bundle is the default.
const CHROME = process.env.GS_CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** id → the scene that sets up the state the assertion needs. */
const CASES = [
  ["count-badge-filtered", "issues~text:Author~text:@mira-holt"],
  ["count-badge-unfiltered", "issues"],
  ["menu-dismissed-on-route", "notifications~text:Type~text:Releases"],
  ["menu-closes-siblings", "issues~text:Author~text:Label"],
  ["palette-selects-first", "code~palette~type:gitstudio"],
  ["palette-selection-visible", "code~palette~type:gitstudio"],
  ["palette-min-chars", "code~palette~type:gi"],
  ["facet-labels-humanized", "notifications~text:Reason"],
  ["facet-labels-aligned", "notifications~text:Reason"],
  ["issues-closed-facet-hidden-on-open", "issues"],
  ["issues-closed-facet-shown-on-closed", "issues~text:Closed"],
  ["commit-disabled-when-empty", "changes"],
  ["commit-enabled-after-typing", "changes~click:.dc-message~type:fix%3A%20a%20thing"],
  ["changes-rows-share-left-edge", "changes"],
  ["changes-toolbar-stable", "changes"],
  ["a-clone-goes-somewhere-real-and-says-it-is-working", "repositories~text:On%20GitHub"],
  ["a-pr-comment-is-a-comment", "prs~open106"],
  ["the-thread-records-what-happened", "issues~open31"],
  ["reactions-can-be-left-and-taken-back", "issues~open31"],
  ["reacting-does-not-reload-the-page", "issues~open31"],
  // The top bar, with room and without it.
  ["the-top-bar-never-sacrifices-the-branch", "code", { width: 1600 }],
  ["the-top-bar-never-sacrifices-the-branch", "code", { width: 820 }],
  // Creating and editing a branch.
  ["a-new-branch-says-where-it-starts", "branches"],
  ["a-branch-name-git-would-refuse-is-caught-before-git", "branches"],
  ["a-rename-refuses-a-name-git-would-refuse", "branches"],
  ["renaming-a-published-branch-offers-to-rename-it-on-the-remote", "branches"],
  ["the-rename-question-outlives-the-refresh-the-rename-causes", "branches"],
  ["renaming-an-unpublished-branch-asks-nothing", "branches"],
  ["a-prompt-that-does-not-validate-still-submits", "actions"],
  // Reading a repository — yours or anyone's.
  ["the-code-page-opens-its-commits", "code"],
  ["the-code-page-counts-its-commits-once", "code"],
  ["a-github-repo-opens-without-cloning", "repositories~click:.gh-seg-btn:nth-child(2)"],
  ["a-cloned-repo-with-changes-asks-what-to-open", "repositories~click:.gh-seg-btn:nth-child(2)"],
  ["a-browsed-repo-shows-its-commits", "repositories~click:.gh-seg-btn:nth-child(2)"],
  ["the-details-panel-folds-away", "issues~open31"],
  ["the-details-panel-folds-away", "prs~open106"],
  ["the-open-split-button-works-from-the-keyboard", "repositories~click:.gh-seg-btn:nth-child(2)"],
  // Which repository am I looking at, and what may I do to it.
  ["a-browsed-repo-says-it-is-not-on-this-machine", "explore~type:git~key:Enter~text:libgit2/libgit2"],
  ["a-browsed-repo-you-have-says-where-it-is", "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio"],
  ["the-top-bar-names-both-repositories-while-browsing", "explore~type:git~key:Enter~text:libgit2/libgit2"],
  ["opening-the-repo-you-have-open-goes-to-it-and-clones-nothing", "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio"],
  ["a-clone-lands-in-the-repository-it-cloned", "explore~type:git~key:Enter~text:libgit2/libgit2"],
  ["the-browse-page-never-pushes-someone-elses-repo", "explore~type:git~key:Enter~text:libgit2/libgit2"],
  ["the-rail-names-the-clone-it-acts-on", "dashboard"],
  ["one-vocabulary-for-where-a-repository-lives", "repositories~click:.gh-seg-btn:nth-child(2)"],
  ["one-vocabulary-for-where-a-repository-lives", "repositories~click:.gh-seg-btn:nth-child(2)", { theme: "light" }],
  // The search rows are the surface that drew this same fact in plain grey.
  ["one-vocabulary-for-where-a-repository-lives", "explore~type:git~key:Enter"],
  ["a-comment-can-be-acted-on", "issues~open31"],
  ["issue-search-reaches-past-what-is-loaded", "issues"],
  ["home-is-made-of-doors", "dashboard"],
  ["repositories-groups-by-folder-and-knows-what-you-have", "repositories"],
  ["a-worktree-is-a-checkout-not-a-repository", "repositories"],
  ["a-capped-scan-says-so", "repositories", { arg: "capped", extra: "manyrepos=1" }],
  ["a-capped-scan-says-so", "repositories"],
  ["a-branch-list-shows-whole-branch-names", "branches", { extra: "longnames=1" }],
  ["a-real-choice-of-remote-is-offered", "branches", { extra: "tworemotes=1" }],
  // …and at the width where the squeeze actually bit. At 1600px there is slack
  // enough to hide a bad rule; 1150px is where the row has to choose.
  ["a-branch-list-shows-whole-branch-names", "branches", { extra: "longnames=1", width: 1150 }],
  ["an-opened-file-fills-its-pane", "code~text:README.md"],
  ["a-lap-of-the-app-does-not-re-measure-every-node", "changes", { extra: "perf=1&many=1" }],
  ["whitespace-toggle-agrees-across-diff-views", "changes~text:spacing.ts", { extra: "ws=1" }],
  ["ignoring-whitespace-keeps-real-changes", "changes~text:prs.ts", { extra: "ws=1" }],
  ["ignoring-whitespace-stops-at-the-ends-of-a-line", "changes~text:spacing-inner.ts", { extra: "ws=1" }],
  ["compare-no-self-compare", "compare"],
  ["changes-status-column", "changes"],
  ["log-no-blank-endgroup-rows", "actions~open9100~click:.gh-job-log"],
  ["log-pane-has-its-own-ground", "actions~open9100~click:.gh-job-log"],
  ["log-follow-survives-expand", "actions~open9100~click:.gh-job-log"],
  ["highlighted-code-copies-as-real-spaces", "issues~open27"],
  ["move-to-is-a-label-not-a-command", "projects"],
  ["graph-search-count-is-not-a-fake-position", "graph"],
  ["a-graph-ref-chip-lands-on-that-branch-and-says-so", "graph"],
  ["refs-behind-the-overflow-pill-are-reachable", "graph"],
  ["the-connect-gate-holds-every-control", "assistant~click:.topbar-assistant"],
  ["send-needs-something-to-send", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["a-quick-action-keeps-your-draft", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["a-streaming-reply-never-moves-the-reader", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["a-queued-job-that-starts-stops-saying-it-has-not", "actions~open9100~click:.gh-job-log"],
  ["an-expired-artifact-cannot-be-downloaded", "actions~open9097"],
  ["no-surface-scrolls-the-app-sideways", "prs~open106", { width: 880 }],
  ["no-surface-scrolls-the-app-sideways", "branches", { width: 880 }],
  ["no-surface-scrolls-the-app-sideways", "changes", { width: 880 }],
  ["no-surface-scrolls-the-app-sideways", "actions~open9100", { width: 880 }],
  ["a-tick-is-named-for-its-file", "changes", { extra: "staging=checkboxes" }],
  ["create-pull-request-comes-back", "compare"],
  ["a-plan-that-keeps-nothing-cannot-be-started", "rebase"],
  ["a-dragged-commit-lands-where-the-line-says", "rebase"],
  ["a-background-refresh-does-not-kill-forward", "changes"],
  ["a-kept-view-comes-back-where-you-left-it", "issues", { extra: "many=1" }],
  ["a-refresh-keeps-you-on-the-job-you-were-reading", "actions~open9100~click:.gh-job-log"],
  ["line-controls-need-a-line-editor", "changes"],
  ["the-dock-hands-the-keyboard-back", "changes"],
  ["closing-the-dock-from-inside-it-still-lands-somewhere", "changes"],
  ["an-open-dock-does-not-bury-a-footer", "rebase"],
  ["a-conflict-with-no-text-is-not-offered-a-text-merge", "changes"],
  ["the-output-filter-owns-its-consequences", "changes"],
  ["a-dead-shell-says-it-is-dead", "changes"],
  ["a-dead-shell-says-it-is-dead", "changes", { theme: "light" }],
  ["the-agents-own-commit-does-not-erase-the-chat", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["a-failed-turn-stops-looking-like-it-is-typing", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["a-refresh-keeps-the-file-you-were-reading", "prs~open106~text:Commits~text:issues%3A%20full-page%20detail"],
  ["one-notch-up-stops-the-tail", "actions~open9100~click:.gh-job-log"],
  ["every-ansi-block-can-be-read", "actions~open9100~click:.gh-job-log"],
  ["every-ansi-block-can-be-read", "actions~open9100~click:.gh-job-log", { theme: "light" }],
  ["switch-account-starts-a-sign-in", "settings"],
  ["a-half-filled-dialog-survives-a-file-save", "changes~click:.topbar-switch~text:Clone"],
  ["a-nested-control-keeps-its-own-enter", "projects"],
  ["the-gate-closes-as-well-as-it-opens", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["stopping-a-run-closes-what-it-was-asking", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["folding-a-log-group-keeps-the-keyboard", "actions~open9100~click:.gh-job-log"],
  ["a-sparkle-action-does-not-destroy-a-running-turn", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["quick-actions-close-while-the-agent-works", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["a-declined-action-is-not-an-error", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["two-fast-sends-start-one-turn", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["every-undrawable-diff-says-which-nothing-it-is", "changes"],
  ["run-detail-one-identity", "actions~open9100"],
  ["run-detail-hides-dead-actions", "actions~open9100"],
  ["run-detail-steps-visible", "actions~open9100"],
  ["row-meta-columns-align", "explore~type:git~key:Enter"],
  ["the-dock-reserve-tracks-the-dock", "changes~click:.dock-chevron"],
  ["changing-the-theme-keeps-what-you-typed", "settings"],
  ["a-compare-diff-that-fails-says-so", "compare~text:Changed%20files"],
  ["placeholders-fit-their-field", "orgs"],
  ["placeholders-fit-their-field", "branches"],
  ["placeholders-fit-their-field", "issues"],
  // The three shapes: file rows, branch rows, and repo rows in an org.
  ["row-actions-name-their-object", "changes"],
  ["row-actions-name-their-object", "branches"],
  ["row-actions-name-their-object", "orgs~text:Repositories"],
  ["row-actions-name-their-object", "notifications"],
  // Explore was the one list of rows whose hover verbs carried no name at all:
  // four buttons per row, each announcing "Open", "Clone…", "GitHub" with no
  // idea which of thirty repositories they belonged to.
  ["row-actions-name-their-object", "explore~type:git~key:Enter"],
  ["coming-back-to-a-search-costs-no-requests", "explore~type:git~key:Enter"],
  // Both shapes: a dialog, and a peek (whose card is focused with tabindex=-1).
  ["a-modal-surface-holds-the-page-behind-it", "branches~text:New%20branch"],
  // A branch row opens its PAGE now, not a peek — so the second Branches
  // scene points at a surface that is still modal.
  ["a-modal-surface-holds-the-page-behind-it", "branches~click:.gh-seg-btn:nth-child(3)~text:New%20tag"],
  ["a-toast-is-reachable-over-a-dialog", "branches~text:Push~palette"],
  [
    // Leave for PRs, come back with the TOPBAR back button — the one path that
    // legitimately restores a parked detail now that a rail click shows the list.
    "escape-still-works-after-coming-back",
    "issues~open31~click:%5Bdata-view%3D%22prs%22%5D~click:.topbar-nav",
  ],
  ["code-hits-show-what-matched", "explore~click:.explore-tab:nth-child(4)~type:git~key:Enter"],
  [
    "collapsing-one-job-leaves-the-others-alone",
    "actions~open9100~click:.gh-job-head~click:.det-back~open9100",
  ],
  ["run-detail-no-duplicate-status", "actions~open9100"],
  ["run-detail-failed-shows-rerun", "actions~open9097"],
  ["step-bars-share-one-scale", "actions~open9097"],
  ["workflow-rows-carry-state", "actions~text:Workflows"],
  ["inbox-search-filters", "notifications~click:.gh-search-input~type:xterm"],
  ["inbox-rows-share-left-edge", "notifications"],
  ["inbox-state-segment", "notifications"],
  ["row-meta-columns-align", "issues"],
  ["row-meta-columns-align", "prs"],
  ["row-meta-columns-align", "gists"],
  ["row-meta-columns-align", "releases"],
  ["row-meta-columns-align", "notifications"],
  ["row-meta-columns-align", "actions"],
  ["prs-state-segment", "prs"],
  ["prs-author-avatar-labelled", "prs"],
  ["explore-search-results", "explore~type:git~key:Enter"],
  ["explore-numbers-formatted", "explore~type:git~key:Enter"],
  ["explore-repo-page", "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio"],
  ["readme-images-are-anchored-at-their-repository", "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio"],
  [
    "an-empty-repository-reads-as-empty-not-broken",
    "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio",
    { extra: "emptyrepo=1" },
  ],
  [
    "go-to-file-on-an-empty-repository-is-empty-not-broken",
    "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio",
    { extra: "emptyrepo=1" },
  ],
  [
    "the-ref-switcher-on-an-empty-repository-says-there-are-no-branches",
    "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio",
    { extra: "emptyrepo=1" },
  ],
  ["browsing-an-empty-repository-in-the-peek-is-empty-not-broken", "orgs", { extra: "emptyrepo=1" }],
  ["orgs-cards-not-clipped", "orgs"],
  ["orgs-header-order", "orgs"],
  ["actions-segment-does-not-slide", "actions"],
  ["facets-do-not-shunt-their-neighbours", "issues"],
  ["log-toolbar-toggles-are-labelled", "actions~open9100~click:.gh-job-log"],
  ["toolbar-no-overflow", "actions", { width: 1150 }],
  ["branch-divergence-paired", "branches"],
  ["the-ref-manager-shows-one-kind-at-a-time", "branches", { arg: "local" }],
  ["the-ref-manager-shows-one-kind-at-a-time", "branches", { arg: "remote" }],
  ["the-ref-manager-shows-one-kind-at-a-time", "branches", { arg: "tags" }],
  ["the-ref-manager-shows-one-kind-at-a-time", "branches", { arg: "stashes" }],
  ["the-remote-list-has-no-phantom-origin-row", "branches"],
  ["a-ref-opens-its-own-page", "branches"],
  ["finished-branches-can-be-swept", "branches"],
  ["the-ref-list-can-be-narrowed", "branches"],
  ["branches-can-be-cut-by-how-recently-they-moved", "branches"],
  ["worktrees-are-reachable", "branches"],
  ["the-ref-list-answers-the-keyboard", "branches"],
  ["branch-pull-is-an-action", "branches"],
  ["org-members-are-people", "orgs~text:Members"],
  ["org-people-are-chips", "orgs~text:Members"],
  ["org-cards-fill-their-row", "orgs~text:Teams"],
  ["dock-tabs-share-a-content-origin", "code~click:.term-tab.is-output"],
  ["dock-empty-log-offers-nothing-inert", "code~click:.term-tab.is-output"],
  ["rail-icons-are-distinguishable", "code"],
  ["clone-form-one-field-shape", "code~palette~type:clone~text:Clone%20repository%E2%80%A6"],
  ["search-empty-sits-with-the-search", "explore~type:zzzznotathing~key:Enter"],
  ["menu-focus-ring-is-not-clipped", "code~click:.topbar-branch"],
  ["rebase-rows-share-their-columns", "rebase"],
  ["rebase-legend-does-not-wrap", "rebase"],
  ["rebase-names-its-action-once", "rebase"],
  ["compare-file-rows-name-first", "compare"],
  ["compare-counts-are-filled", "compare"],
  ["board-empty-column-yields-its-width", "projects"],
  ["explore-people-are-a-directory", "explore~type:git~key:Enter~text:People"],
  ["explore-code-hit-is-one-block", "explore~type:git~key:Enter~click:.explore-tab%3Anth-of-type(4)"],
  ["graph-change-bars-share-a-left-edge", "graph"],
  ["row-meta-columns-align", "mywork"],
  ["my-work-looks-everywhere-and-routes-by-repo", "mywork"],
  ["home-rows-say-what-needs-pushing", "dashboard"],
  ["a-door-lands-on-what-it-counted", "dashboard"],
  ["drawer-holds-the-board-behind-it", "projects"],
  ["rebase-actions-do-not-move-the-list", "rebase"],
  ["file-rows-show-the-whole-name", "changes"],
  ["file-rows-show-the-whole-name", "changes", { extra: "staging=checkboxes" }],
  ["one-row-per-file-in-checkbox-mode", "changes", { extra: "staging=checkboxes" }],
  ["segment-flip-keeps-the-keyboard", "releases"],
  ["reviewers-rail-says-who-answered", "prs~open106"],
  ["approve-opens-the-composer", "prs~open106"],
  ["label-picker-stays-open", "issues~open31"],
  ["mark-read-keeps-its-slot", "inbox"],
  ["danger-dialogs-start-on-cancel", "branches"],
  ["go-to-file-has-a-cursor", "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio"],
  ["detail-subtabs-are-a-tablist", "prs~open106"],
  ["detail-subtabs-are-a-tablist", "gists~click:.sec-row:nth-of-type(2)"],
  ["inbox-rows-are-controls", "inbox"],
  ["the-focus-ring-can-be-seen", "issues~click:.gh-facet-btn"],
  ["the-focus-ring-can-be-seen", "issues~click:.gh-facet-btn", { theme: "light" }],
  ["a-dead-comparison-shows-nothing-not-the-last-one", "compare"],
  ["latest-is-the-shipping-build-not-the-rc", "releases"],
  ["squash-is-refused-only-where-git-would-refuse-it", "rebase"],
  ["a-failed-submit-gives-the-form-back", "issues"],
  ["amend-withdraws-its-prefill-after-a-repaint", "changes"],
  ["a-failed-git-read-is-not-an-empty-repo", "changes"],
  ["the-rail-always-has-a-tab-stop", "assistant"],
  ["the-rail-always-has-a-tab-stop", "prs~open106"],
  ["detail-pages-answer-back-keys", "prs~open106"],
  ["an-abandoned-load-is-not-cached", "changes"],
  ["a-code-hit-opens-its-file", "explore~type:git~key:Enter"],
  ["clicking-a-repo-browses-it", "orgs"],
  ["alt-tab-does-not-rebuild-the-app", "prs~open106"],
  ["revisiting-a-view-costs-nothing", "changes"],
  ["graph-ref-column-shows-a-name", "graph", { width: 1280 }],
  ["graph-ref-column-shows-a-name", "graph", { width: 1300 }],
  ["graph-ref-column-shows-a-name", "graph", { width: 1440 }],
  ["graph-ref-column-shows-a-name", "graph", { width: 1512 }],
  ["graph-ref-column-shows-a-name", "graph", { width: 1600 }],
  ["graph-ref-column-shows-a-name", "graph", { width: 1920 }],
  ["graph-ref-chips-are-painted", "graph"],
  ["graph-ref-chips-are-painted", "graph", { theme: "light" }],
  ["settings-controls-fit-their-content", "code~text:Settings"],
  ["settings-has-a-rhythm", "code~text:Settings"],
  ["rail-groups-survive-collapse", "code~click:.topbar-sidebar"],
  ["status-facet-shows-its-states", "actions~text:Status"],
  ["palette-hints-are-not-echoes", "code~palette~type:br"],
  ["peek-identity-gets-room", "orgs~text:Members~click:.gh-org-member"],
  ["amend-prefill-enables-committing", "changes~text:Amend%20last%20commit"],
  ["amend-off-restores-the-composer", "changes"],
  ["amend-survives-a-repaint", "changes~text:Amend%20last%20commit~text:Stage%20all"],
  ["no-inline-event-handlers-anywhere", "issues~open31"],
  ["route-churn-leaks-nothing", "code"],
  ["nothing-runs-off-the-window", "changes", { width: 1000 }],
  ["nothing-runs-off-the-window", "notifications", { width: 1000 }],
  ["nothing-runs-off-the-window", "issues", { width: 1000 }],
  ["nothing-runs-off-the-window", "actions", { width: 1000 }],
  ["segmented-controls-never-clip", "notifications", { width: 1000 }],
  ["segmented-controls-never-clip", "compare", { width: 1000 }],
  ["segmented-controls-never-clip", "prs", { width: 1280 }],
  ["a-row-keeps-its-name-before-its-badges", "releases", { width: 1000 }],
  ["status-pills-never-wrap", "actions", { width: 1000 }],
  ["status-pills-never-wrap", "releases", { width: 1000 }],
  ["graph-details-opens-at-its-intended-width", "graph"],
  ["focus-follows-you-into-a-detail-and-back", "issues"],
  ["focus-follows-you-into-a-detail-and-back", "prs"],
  ["no-nested-interactive-elements", "releases~open50"],
  ["no-nested-interactive-elements", "issues"],
  ["no-nested-interactive-elements", "code"],
  ["pr-files-fits-the-window", "prs~open106~click:.gh-subtab%3Anth-of-type(4)"],
  ["native-controls-follow-the-theme", "releases~text:New release"],
  ["hover-actions-are-reachable", "explore~type:git~key:Enter~text:People~click:.explore-person-row"],
  ["count-badge-tracks-the-filter", "actions~click:.gh-search-input~type:zzzz"],
  ["count-badge-tracks-the-filter", "releases~click:.gh-search-input~type:zzzz"],
  ["count-badge-tracks-the-filter", "issues"],
  ["count-badge-tracks-the-filter", "prs"],
  ["identity-chips-are-not-dead", "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio"],
  ["branch-switcher-checks-out", "code~click:.topbar-branch"],
  ["staging-keeps-the-open-file", "changes~text:app.css"],
  [
    "checkbox-tick-keeps-the-open-file",
    "changes~text:app.css",
    { extra: "staging=checkboxes" },
  ],
  ["staging-does-not-blank-the-list", "changes~text:app.css"],
  ["repo-manager-opens-from-the-repo-chip", "code~click:.topbar-switch~text:All%20repositories"],
  ["settings-holds-preferences-not-repositories", "code~text:Settings"],
  ["landing-answers-what-you-arrive-with", "changes"],
  // …and the real first run, where nothing has chosen a view yet.
  ["landing-answers-what-you-arrive-with", "changes", { extra: "firstrun=1" }],
  ["assistant-has-no-phantom-skeleton", "code~click:.topbar-assistant"],
  ["menu-toggles-on-its-own-trigger", "orgs"],
  ["pr-commit-rows-are-real-controls", "prs~open106~click:.gh-subtab%5Bdata-sub%3Dcommits%5D"],
  ["a-failing-check-can-be-opened-from-the-keyboard", "prs~open106~click:.gh-subtab%5Bdata-sub%3Dchecks%5D"],
  ["dragging-the-changes-divider-resizes-the-file-list", "changes~click:.dc-file"],
  ["palette-selection-reaches-the-a11y-tree", "code~palette"],
  ["graph-selection-reaches-the-a11y-tree", "graph"],
  ["graph-columns-keep-their-tracks", "graph"],
  ["back-returns-to-the-list-you-opened-from", "mywork~open104"],
  ["focus-survives-a-rebuild", "issues", { arg: ".gh-refresh" }],
  ["focus-survives-a-rebuild", "releases", { arg: ".gh-seg-btn:not(.active)" }],
  ["settings-checkbox-styled", "code~text:Settings"],
  // These two moved with the list they assert about: the clone manager is its
  // own surface now, not a card in Settings.
  ["settings-local-copies", "repositories"],
  ["settings-copy-actions-one-shape", "repositories"],
  ["settings-icon-preview-is-not-a-control", "code~text:Settings"],
  ["the-app-icon-can-be-picked", "code~text:Settings"],
  ["an-operation-is-ended-by-its-own-command", "changes", { extra: "op=merge" }],
  ["an-operation-is-ended-by-its-own-command", "changes", { extra: "op=rebase" }],
  ["an-operation-is-ended-by-its-own-command", "changes", { extra: "op=cherry-pick" }],
  ["an-operation-is-ended-by-its-own-command", "changes", { extra: "op=revert" }],
  ["the-banner-offers-only-what-git-would-accept", "changes", { extra: "op=cherry-pick", arg: "continue" }],
  ["the-banner-offers-only-what-git-would-accept", "changes", { extra: "op=cherry-pick&skip=1", arg: "skip" }],
  ["the-banner-offers-only-what-git-would-accept", "changes", { extra: "op=am&skip=1", arg: "skip" }],
  ["a-banner-button-cannot-be-fired-twice", "changes", { extra: "op=merge" }],
  ["the-composer-keeps-your-place-through-a-repaint", "changes"],
  ["escape-closes-one-layer-at-a-time", "branches"],
  ["arrow-left-does-not-navigate-out-from-under-a-peek", "prs~open106"],
  ["a-detail-page-back-pops-the-history", "prs~open106"],
  ["leaving-a-pr-for-its-pipeline-comes-back-to-the-pr", "prs~open106~text:Checks"],
  ["a-detail-page-back-pops-the-history", "issues~open31"],
  ["a-deleted-file-does-not-look-like-a-renamed-one", "prs~open106~text:Files"],
  ["a-locked-token-still-reads-as-signed-in", "changes", { extra: "unlocked=0" }],
  ["a-locked-token-still-reads-as-signed-in", "changes"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "changes"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "issues"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "prs"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "actions"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "releases"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "orgs"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "projects"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "gists"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "notifications"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "mywork"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "explore"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "branches"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "compare"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "code"],
  ["no-view-hides-its-own-content-or-locks-out-the-keyboard", "graph"],
  ["a-truncated-path-is-still-recoverable", "prs~open106~text:Files"],
  ["a-large-commit-can-be-navigated", "prs~open106~text:Commits"],
  ["creating-a-release-names-what-the-button-will-do", "releases"],
  ["a-composer-does-not-lose-what-you-typed", "issues", { arg: "new issue" }],
  ["a-composer-does-not-lose-what-you-typed", "releases", { arg: "new release" }],
  ["the-editor-previews-with-the-real-renderer", "issues"],
  ["hovering-a-repo-row-does-not-cover-its-description", "orgs"],
  ["the-log-is-navigable-without-a-trackpad", "actions~open9100~click:.gh-job-log"],
  ["the-log-can-jump-between-failures", "actions~open9097"],
  ["a-failed-read-says-so-instead-of-showing-nothing", "prs~open106~text:Commits", { extra: "fail=pr:commits" }],
  ["a-failed-read-says-so-instead-of-showing-nothing", "prs~open106~text:Checks", { extra: "fail=pr:checks" }],
  ["a-failed-read-says-so-instead-of-showing-nothing", "prs~open106", { extra: "fail=pr:conversation" }],
  ["the-commit-page-shows-what-changed", "prs~open106~text:Commits~text:issues%3A%20full-page%20detail"],
  ["a-commit-opens-the-commit-not-the-graph", "prs~open106~text:Commits"],
  ["a-commit-opens-the-commit-not-the-graph", "compare~text:Commits"],
  ["a-surface-under-a-dialog-keeps-its-escape", "projects~click:.gh-card.clickable", { arg: "drawer" }],
  ["a-surface-under-a-dialog-keeps-its-escape", "changes~bell", { arg: "popover" }],
  ["the-code-viewer-back-is-a-navigation", "code"],
  ["a-resizer-moves-the-way-you-press-it", "changes~bell"],
  ["a-resizer-moves-the-way-you-press-it", "compare"],
  ["a-resizer-moves-the-way-you-press-it", "graph"],
  ["a-resizer-moves-the-way-you-press-it", "branches"],
  ["a-resizer-moves-the-way-you-press-it", "changes~click:.dock-chevron"],
  ["signing-out-does-not-leave-the-old-account-on-screen", "code~text:Settings", { arg: "Sign out" }],
  ["signing-out-does-not-leave-the-old-account-on-screen", "code~text:Settings", { arg: "Switch account" }],

  // The log, the release and the issue — each of the three composers/readers
  // the owner called out, now a routed page rather than a box inside one.
  ["the-log-gets-the-window", "actions~open9100~click:.gh-job-log"],
  ["the-log-page-names-the-job", "actions~open9100~click:.gh-job-log"],
  ["picking-another-job-swaps-the-log", "actions~open9100~click:.gh-job-log"],
  ["the-run-page-sends-logs-to-their-page", "actions~open9100"],
  ["a-long-log-can-be-navigated-by-eye", "actions~open9097~click:.gh-job-log"],
  ["the-log-never-scrolls-instead-of-you", "actions~open9100~click:.gh-job-log", { arg: "finished" }],
  ["the-log-never-scrolls-instead-of-you", "actions~open9100~click:.gh-job-log", { arg: "live" }],
  ["the-log-damps-the-wheel", "actions~open9100~click:.gh-job-log"],
  ["searching-a-log-highlights-before-it-travels", "actions~open9100~click:.gh-job-log"],
  ["a-diff-that-cannot-be-shown-says-why", "prs~open106~text:Commits~text:issues%3A%20full-page%20detail"],
  ["a-diff-never-renders-as-an-unmarked-file", "prs~open106~text:Commits~text:issues%3A%20full-page%20detail"],
  ["a-diff-never-renders-as-an-unmarked-file", "compare~text:Changed%20files"],
  ["a-diff-that-cannot-be-shown-says-why", "prs~open106~text:Files", { arg: "prfiles" }],
  ["a-diff-never-renders-as-an-unmarked-file", "changes~click:.dc-file"],
  ["compare-has-the-same-diff-switch-as-everywhere-else", "compare~text:Changed%20files"],
  ["a-commit-list-reads-like-a-list-of-commits", "prs~open106~text:Commits", { arg: "pr" }],
  ["a-commit-list-reads-like-a-list-of-commits", "compare~click:.cmp-seg-btn", { arg: "compare" }],
  ["a-commit-list-can-be-scrolled", "prs~open106~text:Commits"],
  ["a-commit-list-can-be-scrolled", "compare~click:.cmp-seg-btn"],
  ["a-draft-release-leads-with-publishing-it", "releases~open49", { arg: "draft" }],
  ["a-draft-release-leads-with-publishing-it", "releases~open51", { arg: "published" }],
  ["the-release-notes-get-the-window", "releases~text:New%20release"],
  ["the-composer-says-when-it-will-create-a-tag", "releases~text:New%20release"],
  ["generating-notes-keeps-what-you-wrote", "releases~text:New%20release"],
  ["the-issue-body-gets-the-window", "issues~text:New%20issue"],
  ["composing-an-issue-can-decide-who-it-is-for", "issues~text:New%20issue"],
  ["the-commit-page-says-who-when-and-where", "prs~open106~text:Commits~text:issues%3A%20full-page%20detail"],
  ["a-detail-page-clears-the-dock", "prs~open106"],
  ["a-detail-page-clears-the-dock", "issues~open31"],
  ["a-running-clone-can-always-be-left", "changes", { extra: "norepo=1" }],
  ["a-graph-selection-never-outlives-its-rows", "graph"],
  ["code-refresh-rereads-the-listing", "code"],
  ["a-person-peeks-primary-action-is-not-dead", "prs~open106"],
  ["a-recent-repository-can-be-forgotten", "repositories"],
  ["destructive-repository-actions-can-be-undone", "repositories"],
  ["branch-rows-form-columns-and-show-their-people", "branches"],
  ["an-open-compare-diff-survives-every-refresh-path", "compare~text:Changed%20files"],
  ["the-rail-click-returns-to-the-list-you-name", "issues~open31"],
  ["a-completed-issue-is-not-painted-as-a-failure", "issues~text:Closed~open19"],
  ["list-headers-keep-refresh-on-the-title-line", "issues"],
  ["list-headers-keep-refresh-on-the-title-line", "issues~text:Closed", { width: 1440 }],
  ["list-headers-keep-refresh-on-the-title-line", "issues~text:Closed", { width: 1281 }],
  ["list-headers-keep-refresh-on-the-title-line", "prs"],
  ["list-headers-keep-refresh-on-the-title-line", "prs", { width: 1440 }],
  ["list-headers-keep-refresh-on-the-title-line", "prs~text:Merged", { width: 1281 }],
  ["the-files-tab-strip-and-threads-hold-their-shape", "prs~open106~text:Files"],
  ["the-files-tab-strip-and-threads-hold-their-shape", "prs~open106~text:Files", { width: 1000, height: 800 }],
  ["add-a-comment-is-offered-on-a-bare-file", "prs~open106~text:Files~click:.pr-files-list%20.file-row:nth-child(2)"],
  ["the-detail-rail-is-a-constant-width", "issues~open31"],
  ["the-detail-rail-is-a-constant-width", "prs~open106"],
  ["check-rows-and-the-checks-pill-tell-one-story", "prs~open106~text:Checks"],
  ["menus-hang-from-their-trigger", "prs~open106"],
  ["the-review-composer-hands-focus-back", "prs~open106"],
  ["avatar-stacks-and-chips-stay-legible", "prs", { width: 1000 }],
  ["avatar-stacks-and-chips-stay-legible", "issues", { width: 1000 }],
  ["list-headers-keep-refresh-on-the-title-line", "notifications"],
  ["list-headers-keep-refresh-on-the-title-line", "notifications", { width: 1281 }],
  ["list-headers-keep-refresh-on-the-title-line", "mywork"],
  ["list-headers-keep-refresh-on-the-title-line", "actions"],
  ["list-headers-keep-refresh-on-the-title-line", "prs", { width: 1000 }],
  ["single-verb-headers-stay-on-one-line", "gists"],
  ["single-verb-headers-stay-on-one-line", "releases"],
  ["single-verb-headers-stay-on-one-line", "branches"],
  ["comment-menus-hang-over-the-card", "issues~open31"],
  ["comment-menus-hang-over-the-card", "prs~open106"],
    ["the-pr-list-answers-like-the-issues-list", "prs"],
  ["branch-people-yield-at-narrow-widths", "branches", { width: 1000 }],
  ["worktree-rows-share-the-table", "branches~click:.gh-seg-btn:nth-child(5)"],
  ["the-tag-tooltip-survives-the-fallback-tile", "branches~click:.gh-seg-btn:nth-child(3)"],
  ["home-offers-sign-in-when-signed-out", "dashboard", { extra: "signedout=1" }],
  ["the-back-arrow-goes-where-it-says", "issues"],
  ["the-keyboard-works-before-a-repository-does", "changes", { extra: "norepo=1" }],
  ["home-is-a-workbench", "dashboard"],
  ["the-cleanup-line-never-counts-the-default-branch", "dashboard", { extra: "onfeature=1" }],
  ["needs-you-reaches-across-repositories", "dashboard"],
  ["the-issue-rail-says-who-is-fixing-it", "issues~open31"],
  ["a-mention-from-another-project-says-so", "issues~open31"],
  ["a-qualified-reference-in-prose-is-a-link-to-its-own-project", "issues~open31"],
  ["an-issue-can-be-locked-and-the-thread-says-so", "issues~open31"],
  ["the-issues-list-can-be-sorted-and-shows-milestones", "issues"],
  ["a-folder-of-folders-reads-as-folders", "repositories", { extra: "nested=1" }],
  ["a-banded-row-still-says-which-repository-it-is", "repositories", { extra: "nested=1", width: 1280 }],
  ["a-tracked-folder-inside-one-keeps-its-place", "repositories", { extra: "nested=1" }],
  ["a-project-folder-folds-without-losing-your-place", "repositories", { extra: "nested=1" }],
  ["filtering-finds-a-repository-by-its-folder", "repositories", { extra: "nested=1" }],
  ["discarding-changes-can-be-undone", "changes"],
  ["a-deleted-branch-can-be-restored", "branches"],
  ["a-state-pill-sits-on-the-line-it-labels", "repositories"],
  ["a-chip-you-can-click-is-still-readable", "repositories"],
  ["a-chip-you-can-click-is-still-readable", "repositories", { theme: "light" }],
  ["a-state-pill-sits-on-the-line-it-labels", "repositories~text:On%20GitHub"],
  ["a-dropped-stash-can-be-put-back", "branches~click:.gh-seg-btn:nth-child(4)"],
  ["a-discard-with-no-restore-point-offers-no-undo", "changes", { extra: "nosnap=1" }],
  ["a-description-is-never-cut-mid-word", "repositories~text:On%20GitHub"],
  ["every-repository-row-offers-the-same-controls", "repositories~text:On%20GitHub"],
  ["the-clone-folder-can-be-managed", "repositories", { extra: "emptyclonedir=1" }],
  ["an-undo-that-cannot-work-is-not-offered", "repositories", { extra: "notrashpath=1" }],
  ["switch-account-starts-the-new-sign-in", "settings"],
  ["the-graph-search-paints-before-it-travels", "graph"],
  ["the-branch-picker-narrows-the-graph-and-all-restores-it", "graph"],
  ["a-commit-the-filter-hides-says-so-and-offers-every-branch", "graph"],
  ["the-branch-picker-clears-the-dock", "graph~click:.dock-chevron", { height: 700 }],
  ["clearing-a-search-clears-the-results", "explore~type:git"],
  ["a-branch-deep-link-shows-the-branch", "actions~open9094~click:.gh-branch-chip"],
  ["the-logs-states-each-say-the-right-thing", "actions~open9097~click:.gh-job-log"],
  ["the-logs-live-states-each-say-the-right-thing", "actions~open9101~click:.gh-job-log"],
  ["a-stash-page-holds-one-commit", "branches~click:.gh-seg-btn:nth-child(4)~click:.sec-row"],
  ["the-palette-keeps-your-place-when-results-arrive", "branches~palette"],
  ["one-key-press-closes-one-layer", "branches"],
  ["one-key-press-closes-one-layer", "issues"],
  ["a-label-picker-batches-and-escape-discards", "issues~open31"],
  ["a-label-picker-batches-and-escape-discards", "prs~open106"],
  ["log-colours-survive-both-themes", "actions~open9097~click:.gh-job-log"],
  ["log-colours-survive-both-themes", "actions~open9097~click:.gh-job-log", { theme: "light" }],
  // …and with the log repainting under the check the way it does on a loaded
  // machine (see `repaints` in shim.js): these two failed about one parallel
  // run in forty, and never alone, because a frame landed inside their wait.
  ["log-colours-survive-both-themes", "actions~open9097~click:.gh-job-log", { extra: "repaints=1" }],
  ["log-colours-survive-both-themes", "actions~open9097~click:.gh-job-log", { theme: "light", extra: "repaints=1" }],
  ["an-emptied-branch-list-blames-the-right-thing", "branches"],
  ["the-branch-control-bar-stays-on-screen", "branches", { width: 820 }],
  ["the-branch-control-bar-stays-on-screen", "branches", { width: 1000 }],
  ["a-cancelled-run-is-not-drawn-as-a-failure", "actions"],
  ["commit-is-dead-on-a-clean-tree", "changes", { extra: "clean=1" }],
  ["a-segment-is-not-a-filter", "prs"],
  ["clear-clears-the-filters-it-cannot-see", "issues"],
  ["picking-a-filter-keeps-the-keyboard-where-it-was", "issues"],
  ["picking-a-filter-keeps-the-keyboard-where-it-was", "prs"],
  ["picking-a-filter-keeps-the-keyboard-where-it-was", "notifications"],
  ["editing-a-release-leaves-the-latest-badge-alone", "releases~open50~text:Edit"],
  ["a-diff-path-reads-forwards-and-cuts-from-the-left", "changes~click:.dc-file"],
  ["growing-the-log-pane-fills-it", "actions~open9097~click:.gh-job-log"],
  ["the-sort-offers-only-what-the-segment-can-do", "branches"],
  ["a-long-log-line-scrolls-the-log-not-the-page", "actions~open9097~click:.gh-job-log"],
  ["a-long-log-line-scrolls-the-log-not-the-page", "actions~open9097~click:.gh-job-log", { extra: "repaints=1" }],
  ["a-long-log-can-be-navigated-by-eye", "actions~open9097~click:.gh-job-log", { extra: "repaints=1" }],
  ["finished-branches-can-be-swept", "branches", { extra: "onfeature=1" }],
  [
    "the-commit-page-actually-runs-its-verbs",
    "prs~open106~text:Commits~text:issues%3A%20full-page%20detail",
  ],
  ["editing-a-pull-request-is-a-page-that-keeps-your-text", "prs~open106"],
  ["the-files-tab-gives-the-diff-the-room", "prs~open106~text:Files", { arg: "open" }],
  ["a-review-queues-and-posts-as-one", "prs~open106~text:Files"],
  [
    "the-files-tab-gives-the-diff-the-room",
    "prs~open106~text:Files~click:.pr-files-list%20.file-row:nth-child(5)",
    { arg: "quiet" },
  ],
  // "Open in <editor>" — the Code page, Home, a repository's menu, and Settings.
  ["the-code-page-opens-the-repo-in-your-editor", "code"],
  ["with-no-editor-the-button-still-helps", "code", { extra: "noeditors=1" }],
  ["home-offers-your-editor", "dashboard"],
  ["a-repository-row-opens-in-an-editor", "repositories"],
  ["editors-are-configurable-in-settings", "settings"],
  ["agent-access-offers-an-add-that-works", "settings"],
  ["agent-access-without-a-server-offers-no-dead-button", "settings", { extra: "mcpmissing=1" }],
  ["agent-access-refuses-a-translocated-app", "settings", { extra: "mcptransloc=1" }],
  ["agent-access-notices-a-moved-app", "settings", { extra: "mcpmoved=1" }],
  ["agent-access-notices-a-moved-app", "settings", { extra: "mcpmoved=1", theme: "light" }],
  // The composer is one field with the action in its corner.
  ["the-send-button-lives-inside-the-composer-field", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["an-empty-composer-does-not-offer-a-lit-send", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["an-empty-composer-does-not-offer-a-lit-send", "assistant~click:.topbar-assistant", { extra: "ai=1", theme: "light" }],
  // Folders and repositories are different kinds of object.
  ["a-folder-is-not-the-same-kind-of-thing-as-a-repository", "repositories", { extra: "nested=1" }],
  ["a-folder-is-not-the-same-kind-of-thing-as-a-repository", "repositories", { extra: "nested=1", theme: "light" }],
  ["a-repository-row-reads-left-to-right", "repositories", { extra: "nested=1", width: 1280 }],
  ["a-project-folder-reads-as-a-container-not-a-row", "repositories", { extra: "nested=1" }],
  // On GitHub: owner sections fold, and a pinned head says it is pinned.
  ["an-owner-section-folds", "repositories~click:.gh-seg-btn:nth-child(2)"],
  ["a-pinned-section-head-says-it-is-pinned", "repositories~click:.gh-seg-btn:nth-child(2)"],
  // The Assistant — composer, header, answers, a turn in flight, a failed one.
  ["enter-sends-and-shift-enter-breaks-a-line", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["the-header-names-the-chat", "assistant~click:.topbar-assistant", { extra: "ai=1&chat=1" }],
  ["an-answer-can-be-copied", "assistant~click:.topbar-assistant", { extra: "ai=1&chat=1" }],
  ["the-empty-assistant-offers-real-work", "assistant~click:.topbar-assistant", { extra: "ai=1" }],
  ["a-live-turn-shows-its-steps", "assistant~click:.topbar-assistant~click:.assistant-chip", { extra: "ai=1&chat=live" }],
  ["jump-to-latest-appears-when-you-scroll-up", "assistant~click:.topbar-assistant~click:.assistant-chip", { extra: "ai=1&chat=live" }],
  ["a-failed-turn-offers-a-retry", "assistant~click:.topbar-assistant", { extra: "ai=1&fail=ai:chatSend" }],
  // Pull on a branch that has diverged from its upstream (report #12).
  ["a-diverged-pull-asks-instead-of-quoting-git", "code", { extra: "diverged=1" }],
  ["picking-how-to-reconcile-actually-pulls-that-way", "code", { extra: "diverged=1" }],
  ["cancelling-the-question-pulls-nothing-and-reports-nothing", "code", { extra: "diverged=1" }],
  // …and the answer to that question stopping on conflicts, from both doors.
  ["a-pull-that-stops-on-conflicts-lands-in-changes", "code", { extra: "diverged=1&pullconflict=1" }],
  ["the-branches-pull-pill-asks-and-refreshes-on-cancel", "branches", { extra: "diverged=1" }],
  ["the-branches-pull-pill-lands-in-changes-when-it-stops", "branches", { extra: "diverged=1&pullconflict=1" }],
  // …and the question survives the watcher refresh its own fetch sets off.
  ["the-pull-question-outlives-the-refresh-its-own-fetch-causes", "code", { extra: "diverged=1" }],
  ["the-branches-pull-question-outlives-the-refresh-its-own-fetch-causes", "branches", { extra: "diverged=1" }],
  ["the-pull-question-does-not-follow-you-to-another-repository", "code", { extra: "diverged=1" }],
  ["pulling-again-over-the-stopped-merge-says-what-is-paused", "code", { extra: "diverged=1&pullconflict=1" }],
  // A list GitHub named more of than it could return says so, in both themes;
  // a complete one says nothing.
  ["a-list-github-could-not-fully-return-says-so", "projects", { extra: "partial=1" }],
  ["a-list-github-could-not-fully-return-says-so", "projects", { extra: "partial=1", theme: "light" }],
  ["a-list-github-could-not-fully-return-says-so", "projects"],
  ["a-review-thread-github-could-not-return-is-said", "prs~open106~text:Files", { extra: "partial=1" }],
  ["a-folder-that-will-not-open-is-not-painted-as-a-failure", "code"],
  // Commit & Push whose force the bridge refuses: the neutral tone, and Pull.
  ["a-refused-force-push-after-commit-says-so-and-offers-pull", "changes", { extra: "forcerefused=1" }],
  ["a-refused-force-push-after-commit-says-so-and-offers-pull", "changes", { extra: "forcerefused=1", theme: "light" }],
];

function run(scene, checkId, opts = {}) {
  const width = opts.width ?? 1600;
  // The window's height, for the surfaces that meet the bottom of it: the
  // dock, a footer, a popover sized to the pane. It was fixed at 1000 and a
  // case's `height` went unread.
  const height = opts.height ?? 1000;
  const theme = opts.theme ?? "dark";
  const arg = opts.arg ? `&arg=${encodeURIComponent(opts.arg)}` : "";
  // The shim's own scene switches (staging=checkboxes, many=1, ask=1) — a mode
  // reachable only through a pref still has to be assertable.
  const extra = opts.extra ? `&${opts.extra}` : "";
  const url = `file://${PAGE}?scene=${scene}&theme=${theme}&check=${checkId}${arg}${extra}`;
  return new Promise((res) => {
    execFile(
      CHROME,
      [
        "--headless",
        "--disable-gpu",
        "--hide-scrollbars",
        `--window-size=${width},${height}`,
        "--virtual-time-budget=12000",
        "--dump-dom",
        url,
      ],
      // A page that never lets virtual time run out (an unbounded animation, a
      // self-rescheduling timer) hangs headless Chrome forever, and without a
      // timeout that hangs the WHOLE suite with no clue which case did it.
      { maxBuffer: 64 * 1024 * 1024, timeout: 90_000, killSignal: "SIGKILL" },
      (err, stdout) => {
        if (err?.killed && !stdout) return res({ fails: ["timed out after 90s — the page never settled"] });
        if (err && !stdout) return res({ fails: [`chrome failed: ${err.message}`] });
        const m = /<title>CHECK ([\s\S]*?)<\/title>/.exec(stdout);
        if (!m) {
          const t = /<title>([\s\S]*?)<\/title>/.exec(stdout);
          return res({ fails: [`no verdict (title was ${JSON.stringify(t?.[1] ?? "")})`] });
        }
        try {
          const decoded = m[1]
            .replace(/&quot;/g, '"')
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&#39;/g, "'");
          res(JSON.parse(decoded));
        } catch (e) {
          res({ fails: [`unparseable verdict: ${m[1].slice(0, 160)}`] });
        }
      },
    );
  });
}

const filters = process.argv.slice(2);
const selected = filters.length
  ? CASES.filter(([id]) => filters.some((f) => id.includes(f)))
  : CASES;

if (!existsSync(PAGE)) {
  console.error("harness/page is not built — run: node esbuild.js && harness/gen.sh");
  process.exit(2);
}

console.log(`running ${selected.length} functional checks\n`);
let failed = 0;
let pending = 0;
let fixed = 0;
/**
 * Channels a scene asked for that the shim has no fixture for.
 *
 * A read with no fixture answers `undefined`, so the caller's `.ok` or
 * `.length` throws and the control looks inert — a check can then PASS while
 * silently exercising a throw instead of the path it was written for. The
 * shim's own note on `commit:action` records this hiding the branch switcher's
 * checkout; it also hid the pull request's label picker entirely.
 *
 * Collected across the run and printed once, as a note rather than a failure:
 * most absences are legitimate, and turning them red would say nothing about
 * which ones matter.
 */
const missedChannels = new Map();
// Serial: each case is its own browser, and parallel Chromes fight over the GPU
// lock and produce flaky geometry.
for (const [id, scene, opts] of selected) {
  const r = await run(scene, id, opts);
  const fails = r.fails ?? [];
  for (const ch of r.miss ?? []) {
    if (!missedChannels.has(ch)) missedChannels.set(ch, new Set());
    missedChannels.get(ch).add(id);
  }
  // A check written BEFORE the thing it checks. `pending: true` says "this
  // describes work that is not done yet" — so a spec can be committed as a
  // failing check without turning the suite red and hiding real breakage.
  //
  // It is not a way to park an inconvenient failure: a pending check that
  // starts PASSING is reported as such and must have its flag removed, so the
  // list can only shrink.
  const isPending = opts?.pending === true;
  if (fails.length === 0) {
    if (isPending) {
      fixed++;
      console.log(`  \x1b[33mFIXED\x1b[0m ${id}   — passing now; drop \`pending\` from check.mjs`);
    } else {
      console.log(`  \x1b[32mPASS\x1b[0m  ${id}`);
    }
  } else if (isPending) {
    pending++;
    console.log(`  \x1b[36mTODO\x1b[0m  ${id}   (scene: ${scene})`);
    for (const f of fails) console.log(`         ${f}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${id}   (scene: ${scene})`);
    for (const f of fails) console.log(`         ${f}`);
  }
}
if (missedChannels.size) {
  console.log(
    `\n\x1b[33m${missedChannels.size} channel(s) were asked for with no fixture\x1b[0m` +
      ` — a read answers undefined there, so a check touching one may be passing over a throw:`,
  );
  for (const [ch, ids] of [...missedChannels].sort()) {
    const who = [...ids].slice(0, 3).join(", ");
    console.log(`   ${ch}   (${ids.size} check${ids.size === 1 ? "" : "s"}: ${who}${ids.size > 3 ? ", …" : ""})`);
  }
}

const passed = selected.length - failed - pending - fixed;
const bits = [`${passed} passed`, `${failed} failed`];
if (pending) bits.push(`${pending} pending`);
if (fixed) bits.push(`${fixed} newly passing`);
console.log(`\n${bits.join(", ")}`);
// A pending check that now passes is a FAILURE of the suite's bookkeeping, not
// of the app — but it must still be loud, or the pending list never shrinks.
process.exit(failed || fixed ? 1 : 0);
