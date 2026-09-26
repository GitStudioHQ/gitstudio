import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The "N commits selected" summary asks git what applies only once the
// selection settles (issue #32): Shift+Down held over twenty rows would
// otherwise walk the branch three ways per row. The rule lives in
// host-bridge's SettleLatest, tested there for real; the desktop's pane is
// driven through it by the harness (a-held-shift-arrow-asks-main-once…). The
// extension's graph host imports `vscode` and cannot run here, so its half is
// pinned at source level — both hosts, so neither can drift back to asking
// per row.

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const DESKTOP = fileURLToPath(new URL("../../desktop/src", import.meta.url));

test("the graph panel's summary asks through SettleLatest, and a single commit cancels what is pending", async () => {
  const host = await readFile(`${SRC}/graph/graphPanel.ts`, "utf8");
  assert.match(host, /import \{ SettleLatest \} from "@gitstudio\/host-bridge\/settleLatest";/);
  assert.match(
    host,
    /private async pushCommitsSummary\([\s\S]*?await this\.summary\.run\(\(\) => multiCommitMenuItemsFor\(active\.ctx, shas\)\);\s*if \(items\) this\.post\(\{ type: "commitsSummary", shas, items \}\);/,
    "the summary's question goes through the settle, and a dropped answer posts nothing",
  );
  assert.match(
    host,
    /case "selectCommit":\s*case "openCommit":\s*this\.shown = msg\.sha;\s*(?:\/\/[^\n]*\n\s*)*this\.summary\.cancel\(\);\s*void this\.pushCommitDetails\(msg\.sha\);/,
    "one commit selected: the pending summary is for a selection that is gone",
  );
  assert.match(
    host,
    /\n  reveal\(sha: string\): void \{\s*(?:\/\/[^\n]*\n\s*)*this\.summary\.cancel\(\);/,
    "a reveal is one commit too — the Commits list's Open in Commit Graph, a blame click — and cancels what is pending, before anything else",
  );
  // The only other call is the right-click menu, which is one question per click.
  assert.equal((host.match(/multiCommitMenuItemsFor\(/g) ?? []).length, 2, "the menu and the summary ask, nothing else");
});

test("the desktop's pane asks through the same SettleLatest", async () => {
  const renderer = await readFile(`${DESKTOP}/renderer/renderer.ts`, "utf8");
  assert.match(renderer, /import \{ SettleLatest \} from "@gitstudio\/host-bridge\/settleLatest";/);
  assert.match(
    renderer,
    /private showSelection\([\s\S]*?this\.selectionSummary\s*\.run\(async \(\) => \{\s*await this\.whenInFront\(\);\s*return host\.invoke\("commits:menu", \{ shas \}\)/,
    "showSelection's question goes through the settle — and, a timer's, waits for its repository tab to be in front (a-selection-summary-asks-its-own-tab-once-it-is-back)",
  );
  assert.match(
    renderer,
    /private async selectCommit\(sha: string\)[\s\S]{0,200}this\.selectionSummary\.cancel\(\);/,
    "one commit selected cancels it",
  );
});
