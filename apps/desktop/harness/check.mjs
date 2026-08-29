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
  ["log-follow-survives-expand", "actions~open9100~click:.gh-job-log~click:.log-tool%5Btitle%3D%22Expand%20the%20pane%22%5D"],
  ["run-detail-one-identity", "actions~open9100"],
  ["run-detail-hides-dead-actions", "actions~open9100"],
  ["run-detail-steps-visible", "actions~open9100"],
  ["row-meta-columns-align", "explore~type:git~key:Enter"],
  ["coming-back-to-a-search-costs-no-requests", "explore~type:git~key:Enter"],
  // Both shapes: a dialog, and a peek (whose card is focused with tabindex=-1).
  ["a-modal-surface-holds-the-page-behind-it", "branches~text:New%20branch"],
  ["a-modal-surface-holds-the-page-behind-it", "branches~click:.branch-row"],
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
// Serial: each case is its own browser, and parallel Chromes fight over the GPU
// lock and produce flaky geometry.
for (const [id, scene, opts] of selected) {
  const r = await run(scene, id, opts);
  const fails = r.fails ?? [];
  if (fails.length === 0) {
    console.log(`  \x1b[32mPASS\x1b[0m  ${id}`);
  } else {
    failed++;
    console.log(`  \x1b[31mFAIL\x1b[0m  ${id}   (scene: ${scene})`);
    for (const f of fails) console.log(`         ${f}`);
  }
}
console.log(`\n${selected.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
