// perTab (issue #32): a section module's state is one copy per repository tab.
//
// The failure it exists for: Issues, Pull Requests, Actions and Releases kept
// their search, segment, sort and router at module scope, so the last tab to
// mount a section left them behind for every other tab's kept-alive page.

import { test, before } from "node:test";
import assert from "node:assert/strict";

(globalThis as unknown as { window: unknown }).window = {
  gitstudio: { invoke: async () => undefined, on: () => () => {} },
};

let setCacheScope: typeof import("../src/renderer/cache").setCacheScope;
let perTab: typeof import("../src/renderer/tabState").perTab;
let dropTabState: typeof import("../src/renderer/tabState").dropTabState;

before(async () => {
  // cache.ts reads `window.gitstudio` at import time — after the stub above.
  ({ setCacheScope } = await import("../src/renderer/cache"));
  ({ perTab, dropTabState } = await import("../src/renderer/tabState"));
});

test("each tab gets its own copy, made on first use", () => {
  let made = 0;
  const state = perTab(() => {
    made++;
    return { query: "" };
  });
  setCacheScope("/r/a");
  state().query = "graph";
  setCacheScope("/r/b");
  assert.equal(state().query, "", "tab B does not see tab A's search");
  state().query = "rebase";
  setCacheScope("/r/a");
  assert.equal(state().query, "graph", "tab A's search is where it left it");
  assert.equal(made, 2);
});

test("the same object for the same tab, so a view can keep it in its closures", () => {
  const state = perTab(() => ({ n: 0 }));
  setCacheScope("/r/a");
  const held = state();
  setCacheScope("/r/b");
  state().n = 5;
  setCacheScope("/r/a");
  assert.equal(state(), held);
  assert.equal(held.n, 0, "a closure holding tab A's state is never written by tab B");
});

test("a closed tab's state goes, so the repository opened again starts clean", () => {
  const one = perTab(() => ({ query: "" }));
  const two = perTab(() => ({ sort: "updated" }));
  setCacheScope("/r/a");
  one().query = "graph";
  two().sort = "newest";
  setCacheScope("/r/b");
  one().query = "kept";
  dropTabState("/r/a");
  assert.equal(one().query, "kept", "another tab's state is untouched");
  setCacheScope("/r/a");
  assert.equal(one().query, "");
  assert.equal(two().sort, "updated", "every module forgets it, not just one");
});

test("the window with no repository open has its own copy too", () => {
  const state = perTab(() => ({ query: "" }));
  setCacheScope(undefined);
  state().query = "home";
  setCacheScope("/r/a");
  assert.equal(state().query, "");
  setCacheScope(undefined);
  assert.equal(state().query, "home");
});
