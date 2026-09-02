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
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

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
  ["compare-no-self-compare", "compare"],
  ["changes-status-column", "changes"],
  ["log-no-blank-endgroup-rows", "actions~open9100~click:.gh-job-log"],
  ["log-pane-has-its-own-ground", "actions~open9100~click:.gh-job-log"],
  ["log-follow-survives-expand", "actions~open9100~click:.gh-job-log"],
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
  ["coming-back-to-a-search-costs-no-requests", "explore~type:git~key:Enter"],
  // Both shapes: a dialog, and a peek (whose card is focused with tabindex=-1).
  ["a-modal-surface-holds-the-page-behind-it", "branches~text:New%20branch"],
  // A branch row opens its PAGE now, not a peek — so the second Branches
  // scene points at a surface that is still modal.
  ["a-modal-surface-holds-the-page-behind-it", "branches~click:.gh-seg-btn:nth-child(3)~text:New%20tag"],
  ["a-toast-is-reachable-over-a-dialog", "branches~text:Push~palette"],
  [
    "escape-still-works-after-coming-back",
    "issues~open31~click:%5Bdata-view%3D%22prs%22%5D~click:%5Bdata-view%3D%22issues%22%5D",
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
  ["repo-manager-opens-from-the-repo-chip", "code~click:.topbar-switch~text:Manage%20repositories"],
  ["settings-holds-preferences-not-repositories", "code~text:Settings"],
  ["landing-is-the-working-tree", "changes"],
  ["assistant-has-no-phantom-skeleton", "code~click:.topbar-assistant"],
  ["menu-toggles-on-its-own-trigger", "orgs"],
  ["pr-commit-rows-are-real-controls", "prs~open106~click:.gh-subtab%5Bdata-sub%3Dcommits%5D"],
  ["palette-selection-reaches-the-a11y-tree", "code~palette"],
  ["graph-selection-reaches-the-a11y-tree", "graph"],
  ["graph-columns-keep-their-tracks", "graph"],
  ["back-returns-to-the-list-you-opened-from", "mywork~open104"],
  ["focus-survives-a-rebuild", "issues", { arg: ".gh-refresh" }],
  ["focus-survives-a-rebuild", "releases", { arg: ".gh-seg-btn:not(.active)" }],
  ["settings-checkbox-styled", "code~text:Settings"],
  // These two moved with the list they assert about: the clone manager is its
  // own surface now, not a card in Settings.
  ["settings-local-copies", "code~click:.topbar-switch~text:Manage%20repositories"],
  ["settings-copy-actions-one-shape", "code~click:.topbar-switch~text:Manage%20repositories"],
  ["settings-icon-preview-is-not-a-control", "code~text:Settings"],
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
  ["a-stash-page-holds-one-commit", "branches~click:.gh-seg-btn:nth-child(4)~click:.sec-row"],
  ["the-palette-keeps-your-place-when-results-arrive", "branches~palette"],
  ["one-key-press-closes-one-layer", "branches"],
  ["one-key-press-closes-one-layer", "issues"],
  ["a-label-picker-batches-and-escape-discards", "issues~open31"],
  ["a-label-picker-batches-and-escape-discards", "prs~open106"],
  ["log-colours-survive-both-themes", "actions~open9097~click:.gh-job-log"],
  ["log-colours-survive-both-themes", "actions~open9097~click:.gh-job-log", { theme: "light" }],
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
  ["finished-branches-can-be-swept", "branches", { extra: "onfeature=1" }],
  [
    "the-commit-page-actually-runs-its-verbs",
    "prs~open106~text:Commits~text:issues%3A%20full-page%20detail",
  ],
  ["editing-a-pull-request-is-a-page-that-keeps-your-text", "prs~open106"],
  ["the-files-tab-gives-the-diff-the-room", "prs~open106~text:Files", { arg: "open" }],
  [
    "the-files-tab-gives-the-diff-the-room",
    "prs~open106~text:Files~click:.pr-files-list%20.file-row:nth-child(5)",
    { arg: "quiet" },
  ],
];

function run(scene, checkId, opts = {}) {
  const width = opts.width ?? 1600;
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
        `--window-size=${width},1000`,
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
// Serial: each case is its own browser, and parallel Chromes fight over the GPU
// lock and produce flaky geometry.
for (const [id, scene, opts] of selected) {
  const r = await run(scene, id, opts);
  const fails = r.fails ?? [];
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
const passed = selected.length - failed - pending - fixed;
const bits = [`${passed} passed`, `${failed} failed`];
if (pending) bits.push(`${pending} pending`);
if (fixed) bits.push(`${fixed} newly passing`);
console.log(`\n${bits.join(", ")}`);
// A pending check that now passes is a FAILURE of the suite's bookkeeping, not
// of the app — but it must still be loud, or the pending list never shrinks.
process.exit(failed || fixed ? 1 : 0);
