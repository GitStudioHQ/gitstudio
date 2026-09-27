import { test } from "node:test";
import assert from "node:assert/strict";
import { linesUnder, selectionLines, WEBVIEW } from "./selectionStatic";

/**
 * THE OWNER'S RULE, read off the shared components' stylesheets: nothing
 * selected, active, current, open or matched is drawn as a line (a bar down
 * an edge, a rule, an underline, a ring or an accent outline). It is lit
 * instead, with a tinted fill and, on a pill or a tab, a soft glow.
 *
 * test/selectionIsLit.test.ts sweeps what its scenes reach, in four themes.
 * This reads every sheet, css`` template and <style> block in this package
 * and in packages/merge-vscode, so a state no scene reaches cannot grow a
 * line back unseen. The analyser is selectionStatic.ts (the desktop's guard
 * and the extension's use it too); its fixtures below must keep being seen.
 *
 * In a High Contrast rule VS Code's whole ring (an outline, a border all
 * round) is the mark, since those themes paint no fills. A knockout ring in
 * the row's own fill (an avatar's hole, a node's halo) is not a mark.
 */
test("no selected, active, current, open or matched state in the shared components is drawn as a line", () => {
  const found = linesUnder(["packages/webview-ui/src", "packages/merge-vscode/src"]);
  assert.deepEqual(found, [], `selected states drawn as lines:\n  ${found.join("\n  ")}`);
});

test("the guard sees every shape a line can take in a webview, and not what is none", () => {
  const TOKENS = `:root { --gs-accent: #7c5cf0; --gs-brand: #7c5cf0; --gs-sel-fill: color-mix(in srgb, var(--gs-accent) 18%, transparent); }\n`;
  const shapes: [string, string][] = [
    ["an underline on a tab", ".prp-tab.is-on { text-decoration: underline; text-decoration-color: var(--gs-brand); }"],
    ["a full-size ::after carrying a border side", ".prl-row.is-checked-out::after { content: \"\"; position: absolute; inset: 0; border-left: 2px solid var(--gs-brand); }"],
    ["a full-size ::after carrying an inset bar", ".row.is-file.is-selected::after { content: \"\"; position: absolute; inset: 0; box-shadow: inset 2px 0 0 var(--vscode-focusBorder); }"],
    ["a child word's border", ".prp-tab.is-on .prp-tab-word { border-bottom: 2px solid var(--gs-brand); }"],
    ["a child's inset underline", ".rp-row.sel .rp-name { box-shadow: inset 0 -2px 0 var(--gs-accent); }"],
    ["a ::before held at scaleY(0) and switched on", ".wt-row::before { content: \"\"; position: absolute; left: 0; width: 2px; background: var(--gs-accent); transform: scaleY(0); }\n.wt-row.is-current::before { transform: none; }"],
    ["a blurred inset bar", ".row.is-file.is-selected { box-shadow: inset 3px 0 2px 0 var(--vscode-focusBorder); }"],
    ["a drop-shadow filter underline", ".cmp-seg button.on { filter: drop-shadow(0 2px 0 var(--gs-brand)); }"],
    ["an open row's inset bar", ".bm-branch.is-open { box-shadow: inset 2px 0 0 var(--gs-accent); }"],
    ["a match's inset bar", ".row.is-match { box-shadow: inset 2px 0 0 var(--vscode-charts-yellow, #e2c08d); }"],
    ["a bar the base rule draws from a property the state sets", ".row { box-shadow: inset var(--bar, 0px) 0 0 var(--gs-accent); }\n.row.selected { --bar: 2px; }"],
    ["one side in High Contrast", ":host-context(body.vscode-high-contrast) .row.selected { border-left: 2px solid var(--vscode-contrastActiveBorder); }"],
    ["an accent outline outside High Contrast", ".gh-preset.active { outline: 1px solid var(--gs-accent); }"],
    ["the checked-out row's edge", ".prl-row.is-checked-out::before { content: \"\"; position: absolute; left: 0; top: 0; bottom: 0; width: 2px; background: var(--gs-brand); }"],
  ];
  for (const [what, css] of shapes) {
    assert.ok(selectionLines(TOKENS + css, WEBVIEW).length > 0, `not seen: ${what}\n  ${css}`);
  }
  const fine: [string, string][] = [
    ["VS Code's whole ring in High Contrast", ":host-context(body.vscode-high-contrast) .row.selected { outline: 1px dashed var(--vscode-contrastActiveBorder); outline-offset: -1px; }"],
    ["a whole border in High Contrast", "body.vscode-high-contrast .prp-tab.is-on { border: 1px solid var(--vscode-contrastActiveBorder); }"],
    ["an avatar's hole ring in the row's fill", ".row.selected .avatar { box-shadow: 0 0 0 1.5px var(--gs-av-ring, var(--vscode-focusBorder)), 0 0 0 3px var(--gs-graph-node-hole); }\n.avatar { box-shadow: 0 0 0 1.5px var(--gs-av-ring, var(--vscode-focusBorder)), 0 0 0 3px var(--gs-graph-node-hole); }"],
    ["a tint and a glow", ".prp-tab.is-on { background: var(--gs-sel-fill); box-shadow: 0 0 16px -4px color-mix(in srgb, var(--gs-accent) 70%, transparent); }"],
    ["a soft inset glow", ".rb-set.is-current { box-shadow: inset 0 0 10px -3px color-mix(in srgb, var(--gs-accent) 55%, transparent); }"],
    ["a keyboard focus ring", ".row.selected:focus-visible { outline: 1px solid var(--vscode-focusBorder); }"],
    ["a drop marker", ".row.over-before { box-shadow: inset 0 2px 0 var(--gs-accent); }"],
    ["an outline only High Contrast gives a colour", ".bm-branch.is-open { outline: 1px dashed var(--vscode-contrastActiveBorder, transparent); }"],
    ["the row fill a state sets for its parts", ".row { background: var(--gs-row-fill, transparent); }\n.row.selected { --gs-row-fill: var(--vscode-list-activeSelectionBackground); }"],
  ];
  for (const [what, css] of fine) {
    assert.deepEqual(selectionLines(TOKENS + css, WEBVIEW), [], `flagged, but ${what} is not a selection line\n  ${css}`);
  }
});
