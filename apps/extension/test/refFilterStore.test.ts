import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { RefFilterStore, type RefFilterMemento } from "../src/graph/refFilterStore";

// The Commit Graph's branch filter (issue #30) in the extension: one selection
// per repository in workspaceState, shared by the bottom panel, the Commits
// sidebar view and the editor tab. The graph host itself imports `vscode`, so
// the store — the part that decides what is remembered and who is told — is
// driven directly, and the host's wiring to it is pinned at source level.

/** A workspaceState stand-in: the two Memento methods the store uses. */
function memento(initial: Record<string, unknown> = {}): RefFilterMemento & { data: Record<string, unknown>; writes: number } {
  const data = { ...initial };
  return {
    data,
    writes: 0,
    get<T>(key: string): T | undefined {
      return data[key] as T | undefined;
    },
    update(key: string, value: unknown) {
      data[key] = value;
      this.writes++;
      return Promise.resolve();
    },
  };
}

test("a repository with nothing remembered is All", () => {
  const s = new RefFilterStore(memento());
  assert.equal(s.get("/repo/a"), null);
});

test("set remembers per repository, and null forgets only that repository", async () => {
  const m = memento();
  const s = new RefFilterStore(m);
  await s.set("/repo/a", ["refs/heads/main", "refs/remotes/origin/main"]);
  await s.set("/repo/b", ["refs/tags/v1"]);
  assert.deepEqual(s.get("/repo/a"), ["refs/heads/main", "refs/remotes/origin/main"]);
  assert.deepEqual(s.get("/repo/b"), ["refs/tags/v1"]);
  await s.set("/repo/a", null);
  assert.equal(s.get("/repo/a"), null);
  assert.deepEqual(s.get("/repo/b"), ["refs/tags/v1"]);
  // What is on disk is one record under one key — a stale root costs a line,
  // not a key namespace.
  assert.deepEqual(m.data, { "gitstudio.graph.refFilter": { "/repo/b": ["refs/tags/v1"] } });
});

test("an empty list is the same as forgetting: a filter of nothing never exists", async () => {
  const s = new RefFilterStore(memento());
  await s.set("/repo/a", ["refs/heads/x"]);
  await s.set("/repo/a", []);
  assert.equal(s.get("/repo/a"), null);
});

test("garbage in workspaceState reads as All rather than throwing", () => {
  assert.equal(new RefFilterStore(memento({ "gitstudio.graph.refFilter": "nope" })).get("/r"), null);
  assert.equal(new RefFilterStore(memento({ "gitstudio.graph.refFilter": { "/r": "main" } })).get("/r"), null);
  assert.deepEqual(
    new RefFilterStore(memento({ "gitstudio.graph.refFilter": { "/r": ["refs/heads/main", 3, null] } })).get("/r"),
    ["refs/heads/main"],
  );
});

test("every listener is told which repository moved — the setter's own surface included", async () => {
  const s = new RefFilterStore(memento());
  const heard: string[][] = [[], []];
  s.onDidChange((root) => heard[0].push(root));
  const off = s.onDidChange((root) => heard[1].push(root));
  await s.set("/repo/a", ["refs/heads/main"]);
  assert.deepEqual(heard, [["/repo/a"], ["/repo/a"]]);
  off();
  await s.set("/repo/b", null);
  assert.deepEqual(heard, [["/repo/a", "/repo/b"], ["/repo/a"]], "an unsubscribed listener hears nothing more");
});

test("a silent set is remembered but announced to nobody", async () => {
  // The host prunes a remembered ref that no longer exists while it is already
  // reloading; announcing that would reload it again for the same history.
  const m = memento();
  const s = new RefFilterStore(m);
  let told = 0;
  s.onDidChange(() => told++);
  await s.set("/repo/a", ["refs/heads/main"], { silent: true });
  assert.equal(told, 0);
  assert.equal(m.writes, 1);
  assert.deepEqual(s.get("/repo/a"), ["refs/heads/main"]);
});

const SRC = fileURLToPath(new URL("../src", import.meta.url));

test("the graph host routes a filter change through the store, and reloads from its event", async () => {
  const text = await readFile(`${SRC}/graph/graphPanel.ts`, "utf8");
  // The webview's message lands in setRefFilter…
  assert.match(text, /case "setRefFilter":\s*void this\.setRefFilter\(msg\.refs\)/);
  // …which hands the selection to the store rather than reloading directly —
  // the store's event is the ONE path to a reload, for every surface.
  const fn = text.slice(text.indexOf("private async setRefFilter("), text.indexOf("private async loadRefs("));
  assert.match(fn, /await store\.set\(active\.root, refs\);\s*return;/);
  const ctor = text.slice(text.indexOf("private constructor("), text.indexOf("// ── Webview messages"));
  assert.match(ctor, /store\.onDidChange\(\(root\) => \{\s*if \(root === this\.repoRoot && this\.ready\) void this\.loadInitial\(\);/);
  // …and loadInitial is the paging reset: skip and the accumulated rows go.
  const load = text.slice(text.indexOf("private async loadInitial("), text.indexOf("private async loadMore("));
  assert.match(load, /this\.loaded = \[\];\s*this\.nextSkip = 0;/);
  assert.match(load, /refFilter: this\.refFilter,\s*refList: this\.refList,/);
});

test("the graph host never writes back a prune against a ref listing that failed", async () => {
  // loadRefs swallows a listRefs failure into an empty list. Pruning a stored
  // selection against THAT drops every ref, and persisting the result turned
  // one transient for-each-ref failure into a forgotten selection. The write
  // is gated on the listing having produced a list; a failed one applies the
  // selection as stored and leaves the store alone.
  const text = await readFile(`${SRC}/graph/graphPanel.ts`, "utf8");
  const refs = text.slice(text.indexOf("private async loadRefs("), text.indexOf("private buildRows("));
  assert.match(refs, /catch \{\s*refs = \[\];\s*\}\s*this\.refs = refs;\s*this\.refsListed = refs\.length > 0;/);
  const load = text.slice(text.indexOf("private async loadInitial("), text.indexOf("private async loadMore("));
  assert.match(
    load,
    /if \(this\.refsListed\) \{\s*this\.refFilter = normalizeRefFilter\(wanted, this\.refs\);\s*if \(store && !sameRefFilter\(this\.refFilter, wanted\)\) \{[\s\S]*?void store\.set\(active\.root, this\.refFilter, \{ silent: true \}\);\s*\}\s*\} else \{[\s\S]*?this\.refFilter = wanted;\s*\}/,
  );
  // No other write to the store in the load path — the silent one is the only one.
  assert.equal((load.match(/store\.set\(/g) ?? []).length, 1);
});

test("a reveal into a filtered graph asks git before paging, and says so when the filter hides the commit", async () => {
  // Revealing a commit the ticked refs cannot reach is the ordinary case once
  // the graph is filtered (a Branches-view click, a PR link, a parent chip).
  // Paging toward it walked up to 25 pages of the filtered history and then
  // posted a reveal the webview no-ops — details shown, no row, not a word.
  // walkReaches (git-service, real-git tested) is asked first; the hidden
  // case names the filter and offers the way out, which replays the reveal.
  const text = await readFile(`${SRC}/graph/graphPanel.ts`, "utf8");
  const reveal = text.slice(text.indexOf("  reveal(sha: string): void {"), text.indexOf("private async pageUntilLoaded("));
  assert.match(
    reveal,
    /if \(!this\.records\.has\(sha\)\) \{\s*void this\.revealUnloaded\(sha\);\s*return;\s*\}/,
    "a commit that is not loaded takes one path, whatever hasMore says",
  );
  const unloaded = reveal.slice(reveal.indexOf("private async revealUnloaded("));
  const ask = unloaded.indexOf("await active.ctx.log.walkReaches(sha, filter)");
  const page = unloaded.indexOf("await this.pageUntilLoaded(sha)");
  assert.ok(ask > 0 && page > ask, "git is asked whether the walk reaches the commit before any page is fetched");
  assert.match(unloaded, /this\.offerAllBranches\(sha, active\.root\);/, "the hidden case is said out loud");
  const offer = unloaded.slice(unloaded.indexOf("private offerAllBranches("));
  assert.match(offer, /"Show all branches"/);
  assert.match(
    offer,
    /this\.pendingReveal = sha;\s*void this\.setRefFilter\(null\);/,
    "taking it forgets the filter through the store's one reload path, and the reveal is replayed after the reload",
  );
});

test("the store is installed before the first graph host is built", async () => {
  const text = await readFile(`${SRC}/extension.ts`, "utf8");
  const installed = text.indexOf("setRefFilterStore(new RefFilterStore(context.workspaceState))");
  const firstHost = text.indexOf("new CommitPanelViewProvider(");
  assert.ok(installed > 0, "the store is installed from workspaceState");
  assert.ok(firstHost > installed, "…before any graph host exists to miss it");
});
