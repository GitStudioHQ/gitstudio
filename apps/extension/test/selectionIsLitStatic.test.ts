import { test } from "node:test";
import assert from "node:assert/strict";
import { linesUnder } from "../../../packages/webview-ui/test/selectionStatic";

/**
 * THE OWNER'S RULE, read off the extension's own webviews (the inline
 * <style> blocks and the CSS constants of the Changes view, the branch
 * window, Compare, the rebase workspace, AI settings and the rest): nothing
 * selected, active, current, open or matched is drawn as a line. It is lit
 * instead. test/selectionIsLit.test.ts sweeps what its scenes reach; this
 * reads every sheet, so a state no scene reaches cannot grow a line back
 * unseen. The analyser and its fixtures are packages/webview-ui's
 * (selectionStatic.ts, selectionIsLitStatic.test.ts).
 */
test("no selected, active, current, open or matched state in the extension's webviews is drawn as a line", () => {
  const found = linesUnder(["apps/extension/src"]);
  assert.deepEqual(found, [], `selected states drawn as lines:\n  ${found.join("\n  ")}`);
});
