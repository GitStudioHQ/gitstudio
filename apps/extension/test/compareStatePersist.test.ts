import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Issue #24's second half: surviving the repaints that MUST happen. When the
// comparison really changed, the webview's html is replaced and every module
// variable resets — so the open diffs, the filter, the layout all ride
// `vscode.setState`/`getState`, which also survives the panel being hidden
// and restored across an editor restart.
//
// The state block lives inside the webview's template-literal script, where
// tsc cannot see it. These tests extract the REAL block (from `const SAVED`
// through the last `SAVED.`-seeded declaration) and execute it against a
// stubbed `vscode`, pinning both directions: a saved shape is adopted, and
// interacting writes back exactly the shape a later boot expects.

const src = readFileSync(join(__dirname, "../src/compare/comparePanel.ts"), "utf8");

interface Bag {
  openPaths: Set<string>;
  diffMode: string;
  showTree: boolean;
  filter: string;
  saveViewState: () => void;
}

function boot(state: unknown): { bag: Bag; written: unknown[] } {
  const start = src.indexOf("const SAVED = (function ()");
  assert.ok(start > 0, "the SAVED block exists");
  const endAnchor = 'let filter = typeof SAVED.filter === "string" ? SAVED.filter : "";';
  const end = src.indexOf(endAnchor);
  assert.ok(end > start, "and ends where it always has");
  const body =
    src.slice(start, end + endAnchor.length) +
    "\nreturn { openPaths, diffMode, showTree, filter, saveViewState };";
  const written: unknown[] = [];
  const vscode = {
    getState: () => state,
    setState: (s: unknown) => written.push(s),
  };
  const bag = new Function("vscode", body)(vscode) as Bag;
  return { bag, written };
}

test("a saved state is adopted wholesale on boot", () => {
  const { bag } = boot({
    open: ["src/a.ts", "src/b.ts"],
    filter: "render",
    diffMode: "split",
    showTree: false,
  });
  assert.deepEqual([...bag.openPaths], ["src/a.ts", "src/b.ts"], "the expanded diffs come back");
  assert.equal(bag.filter, "render", "the filter comes back");
  assert.equal(bag.diffMode, "split");
  assert.equal(bag.showTree, false);
});

test("a first boot (no state) starts clean without throwing", () => {
  const { bag } = boot(undefined);
  assert.equal(bag.openPaths.size, 0);
  assert.equal(bag.diffMode, "unified", "unified is the default");
  assert.equal(bag.showTree, true, "the tree starts visible");
  assert.equal(bag.filter, "");
});

test("garbage state degrades to defaults rather than a broken panel", () => {
  const { bag } = boot({ open: "not-an-array", diffMode: 7, showTree: "maybe", filter: null });
  assert.equal(bag.openPaths.size, 0);
  assert.equal(bag.diffMode, "unified");
  assert.equal(bag.filter, "");
});

test("saveViewState writes exactly the shape the next boot reads", () => {
  const { bag, written } = boot({ open: ["x.ts"], filter: "q", diffMode: "split", showTree: true });
  bag.saveViewState();
  assert.equal(written.length, 1);
  // Round-trip: feed the written state to a fresh boot and get the same bag.
  const again = boot(written[0]).bag;
  assert.deepEqual([...again.openPaths], [...bag.openPaths]);
  assert.equal(again.filter, bag.filter);
  assert.equal(again.diffMode, bag.diffMode);
  assert.equal(again.showTree, bag.showTree);
});

test("a getState that THROWS (restored serialized panel) still boots", () => {
  const start = src.indexOf("const SAVED = (function ()");
  const endAnchor = 'let filter = typeof SAVED.filter === "string" ? SAVED.filter : "";';
  const end = src.indexOf(endAnchor);
  const body =
    src.slice(start, end + endAnchor.length) +
    "\nreturn { openPaths, diffMode, showTree, filter };";
  const vscode = {
    getState: () => {
      throw new Error("acquireVsCodeApi state unavailable");
    },
    setState: () => {},
  };
  const bag = new Function("vscode", body)(vscode) as Bag;
  assert.equal(bag.diffMode, "unified", "the try/catch seed holds");
});
