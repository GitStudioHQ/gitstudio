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
const PAGE = resolve(HERE, "page/harness.html");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** id → the scene that sets up the state the assertion needs. */
const CASES = [
  ["count-badge-filtered", "issues~text:Author~text:@mira-holt"],
  ["count-badge-unfiltered", "issues"],
  ["menu-dismissed-on-route", "notifications~text:Type~text:Releases"],
  ["menu-closes-siblings", "issues~text:Author~text:Label"],
  ["palette-selects-first", "code~palette~type:gitstudio"],
  ["palette-min-chars", "code~palette~type:gi"],
  ["facet-labels-humanized", "notifications~text:Reason"],
  ["facet-labels-aligned", "notifications~text:Reason"],
  ["issues-closed-facet-hidden-on-open", "issues"],
  ["issues-closed-facet-shown-on-closed", "issues~text:Closed"],
  ["commit-disabled-when-empty", "changes"],
  ["commit-enabled-after-typing", "changes~click:.dc-message~type:fix%3A%20a%20thing"],
  ["compare-no-self-compare", "compare"],
  ["changes-status-column", "changes"],
  ["log-no-blank-endgroup-rows", "actions~open9100~click:.gh-job-log"],
  ["log-pane-has-its-own-ground", "actions~open9100~click:.gh-job-log"],
  ["log-follow-survives-expand", "actions~open9100~click:.gh-job-log~click:.log-tool%5Btitle%3D%22Expand%20the%20pane%22%5D"],
  ["run-detail-one-identity", "actions~open9100"],
  ["run-detail-hides-dead-actions", "actions~open9100"],
  ["run-detail-steps-visible", "actions~open9100"],
  ["run-detail-no-duplicate-status", "actions~open9100"],
  ["run-detail-failed-shows-rerun", "actions~open9097"],
  ["step-bars-share-one-scale", "actions~open9097"],
  ["inbox-search-filters", "notifications~click:.gh-search-input~type:xterm"],
  ["inbox-rows-share-left-edge", "notifications"],
  ["inbox-state-segment", "notifications"],
  ["prs-state-segment", "prs"],
  ["prs-author-avatar-labelled", "prs"],
  ["explore-search-results", "explore~type:git~key:Enter"],
  ["explore-numbers-formatted", "explore~type:git~key:Enter"],
  ["explore-repo-page", "explore~type:git~key:Enter~text:GitStudioHQ/gitstudio"],
  ["orgs-cards-not-clipped", "orgs"],
  ["orgs-header-order", "orgs"],
  ["toolbar-no-overflow", "actions", { width: 1150 }],
  ["settings-checkbox-styled", "code~text:Settings"],
  ["settings-local-copies", "code~text:Settings~scroll:.settings-copies"],
];

function run(scene, checkId, opts = {}) {
  const width = opts.width ?? 1600;
  const theme = opts.theme ?? "dark";
  const url = `file://${PAGE}?scene=${scene}&theme=${theme}&check=${checkId}`;
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
      { maxBuffer: 64 * 1024 * 1024 },
      (err, stdout) => {
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
