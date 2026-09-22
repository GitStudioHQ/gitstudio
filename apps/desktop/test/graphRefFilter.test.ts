import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitContext } from "@gitstudio/git-service/index";
import { GitBridge, type GraphRefFilterStore } from "../src/main/gitBridge";
import { CURRENT_BRANCH, CURRENT_UPSTREAM, LOCAL_BRANCHES } from "@gitstudio/host-bridge/graphRefFilter";
import type { RepoStore } from "../src/main/repoStore";
import { AppSettings } from "../src/main/appSettings";
import { removeTempRepo } from "./tmpRepo";

// The Commit Graph's branch filter (issue #30) on the desktop host. graph:load
// is a stateful, skip-paged accumulator; a filter change has to reset it, be
// remembered per repository, prune refs that are gone, and re-decorate the
// chips so only the ticked refs draw one. An attached HEAD is a branch like
// any other: walked, and chipped, only when ticked (a preset or by hand).

let repo: string;
let ctx: GitContext;
let bridge: GitBridge;
/** The injected store: what production backs with AppSettings. */
let stored: Map<string, string[] | null>;
let store: GraphRefFilterStore;
let mainTip = "";
let sideTip = "";
let tagged = "";

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

function commit(file: string, msg: string): string {
  writeFileSync(join(repo, file), `${msg}\n`);
  git("add", ".");
  git("commit", "-q", "-m", msg);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "gitstudio-graphfilter-"));
  execFileSync("git", ["-c", "init.defaultBranch=main", "init", repo], {
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  git("config", "gc.auto", "0");
  git("config", "core.autocrlf", "false");
  for (let i = 0; i < 6; i++) commit(`f${i}.txt`, `main ${i}`);
  tagged = git("rev-parse", "HEAD");
  git("tag", "v1");
  git("checkout", "-q", "-b", "side");
  for (let i = 0; i < 4; i++) commit(`s${i}.txt`, `side ${i}`);
  sideTip = git("rev-parse", "HEAD");
  git("checkout", "-q", "main");
  mainTip = commit("last.txt", "main last");
  ctx = new GitContext({ root: repo });
  stored = new Map();
  store = {
    get: (root) => stored.get(root) ?? null,
    set: (root, refs) => void stored.set(root, refs),
  };
  bridge = new GitBridge({ getContext: () => ctx } as unknown as RepoStore, store);
});

afterEach(() => {
  ctx?.dispose?.();
  removeTempRepo(repo);
});

const shasOf = (p: { rows: Array<{ sha: string }> }): string[] => p.rows.map((r) => r.sha);

test("THE RESET: a request that sets the filter is page 0, whatever skip it carries", async () => {
  const first = await bridge.graphLoad({ skip: 0, maxCount: 4 });
  assert.equal(first.rows.length, 4);
  // Mid-scroll, the picker ticks `side` only. The cursor still says skip:4 —
  // the renderer resets it, but the accumulator must not depend on that.
  const filtered = await bridge.graphLoad({ skip: first.nextSkip, maxCount: 50, refs: ["refs/heads/side"] });
  assert.deepEqual(filtered.refFilter, ["refs/heads/side"]);
  assert.equal(filtered.nextSkip, filtered.rows.length, "the cursor restarted from zero");
  const shas = shasOf(filtered);
  assert.equal(new Set(shas).size, shas.length, "no page-0 rows spliced in twice");
  assert.ok(shas.includes(sideTip), "the ticked branch is walked");
  assert.ok(!shas.includes(mainTip), "HEAD is attached to main, which nobody ticked");
  // The whole filtered history, from its top: exactly what a fresh bridge
  // walks for the same filter from skip 0 — not four rows short of it.
  const fresh = new GitBridge({ getContext: () => ctx } as unknown as RepoStore, store);
  const truth = await fresh.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/heads/side"] });
  assert.deepEqual(shas, shasOf(truth));
});

test("a filtered walk excludes history only the unticked refs reach", async () => {
  git("checkout", "-q", "side");
  const page = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/tags/v1"] });
  const shas = shasOf(page);
  assert.ok(shas.includes(tagged));
  assert.ok(!shas.includes(sideTip), "HEAD is on side, and side is not ticked");
  assert.ok(!shas.includes(mainTip), "main's last commit is reachable from neither v1 nor HEAD");
});

test("the filter is remembered per repository and applied to a plain reload", async () => {
  await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/heads/side"] });
  assert.deepEqual(stored.get(repo), ["refs/heads/side"], "remembered under the repo root");
  // A new bridge (a new session) with the same store applies it without being told.
  const again = new GitBridge({ getContext: () => ctx } as unknown as RepoStore, store);
  const page = await again.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(page.refFilter, ["refs/heads/side"]);
  // Choosing All forgets it.
  await again.graphLoad({ skip: 0, maxCount: 50, refs: null });
  assert.equal(stored.get(repo), null);
});

test("a remembered ref that no longer exists is dropped silently, and the walk is the pruned one", async () => {
  stored.set(repo, ["refs/heads/deleted-elsewhere", "refs/heads/side"]);
  const page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(page.refFilter, ["refs/heads/side"]);
  assert.deepEqual(stored.get(repo), ["refs/heads/side"], "the stored selection was pruned too");
  assert.ok(shasOf(page).includes(sideTip));
});

test("a remembered selection that is entirely gone falls back to All, and says so", async () => {
  stored.set(repo, ["refs/heads/deleted-elsewhere"]);
  const page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.equal(page.refFilter, null);
  assert.equal(stored.get(repo), null);
  assert.ok(shasOf(page).includes(sideTip), "…and every branch is walked");
});

test("chips follow the filter: unticked refs draw none — the current branch included", async () => {
  const all = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  const chipsAt = (p: typeof all, sha: string) => p.rows.find((r) => r.sha === sha)?.refs.map((r) => r.name) ?? [];
  assert.deepEqual(chipsAt(all, sideTip), ["side"]);
  assert.deepEqual(chipsAt(all, tagged), ["v1"]);

  const only = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/tags/v1"] });
  assert.equal(only.rows.some((r) => r.sha === mainTip), false, "main (HEAD's branch, unticked) is not walked");
  assert.deepEqual(chipsAt(only, tagged), ["v1"], "the ticked tag keeps its chip");
  const withMain = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/tags/v1", "refs/heads/main"] });
  assert.deepEqual(chipsAt(withMain, mainTip), ["main"], "ticked, the current branch has its chip");
  assert.equal(only.rows.some((r) => r.sha === sideTip), false, "side is not even in the walk");

  // The picker still lists everything — a filtered-out ref must be tickable.
  assert.deepEqual(
    only.refList.map((r) => r.fullName).sort(),
    ["refs/heads/main", "refs/heads/side", "refs/tags/v1"],
  );
  assert.equal(only.refList.find((r) => r.name === "main")?.isCurrent, true);
});

test("the ref list crosses IPC only when the caller does not already hold it", async () => {
  // It is every branch and tag — a megabyte on a repository with ten thousand
  // tags — and it rode on every page of every load. The renderer says which
  // list it holds; an unchanged one stays in this process.
  const first = await bridge.graphLoad({ skip: 0, maxCount: 3 });
  assert.ok(first.refList && first.refList.length === 3, "a caller that holds nothing gets the list");
  const sig = first.refListSig;
  assert.equal(typeof sig, "string");

  const refresh = await bridge.graphLoad({ skip: 0, maxCount: 3, refListSig: sig });
  assert.equal("refList" in refresh, false, "a refresh over the same refs leaves it out");
  assert.equal(refresh.refListSig, sig);

  const append = await bridge.graphLoad({ skip: refresh.nextSkip, maxCount: 3, refListSig: sig });
  assert.equal("refList" in append, false, "so does a later page");

  const filtered = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/tags/v1"], refListSig: sig });
  assert.deepEqual(filtered.refFilter, ["refs/tags/v1"], "a filter change is applied…");
  assert.equal("refList" in filtered, false, "…and the unchanged list, filtered-out refs and all, stays where it is");
  assert.equal(filtered.rows.some((r) => r.sha === sideTip), false, "(side really is filtered out)");

  // A branch appears: the list moved, so it is sent, whatever the caller holds.
  git("branch", "fresh", tagged);
  const grown = await bridge.graphLoad({ skip: 0, maxCount: 50, refListSig: sig });
  assert.ok(grown.refList?.some((r) => r.fullName === "refs/heads/fresh"), "the new branch reaches the picker");
  assert.notEqual(grown.refListSig, sig);

  // A renderer that reloaded holds nothing and says so: it gets the list,
  // whatever this process sent before.
  const reloaded = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.ok(reloaded.refList && reloaded.refList.length === 4);
  // …and one holding a list this process never sent (another repository's).
  const other = await bridge.graphLoad({ skip: 0, maxCount: 50, refListSig: "3:not-this-list" });
  assert.ok(other.refList);
});

test("paging under a filter walks the same set page after page", async () => {
  const truth = shasOf(await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/heads/side"] }));
  const fresh = new GitBridge({ getContext: () => ctx } as unknown as RepoStore, store);
  const p1 = await fresh.graphLoad({ skip: 0, maxCount: 3 });
  const p2 = await fresh.graphLoad({ skip: p1.nextSkip, maxCount: 3 });
  const p3 = await fresh.graphLoad({ skip: p2.nextSkip, maxCount: 50 });
  assert.deepEqual([...shasOf(p1), ...shasOf(p2), ...shasOf(p3)], truth);
});

test("graph:reaches says whether the graph's walk reaches a commit — the reveal asks before saying why", async () => {
  // Under no filter every commit is reached: the old "further back" sentence
  // is the true one. Under a filter it is git's answer, without a walk.
  await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(await bridge.graphReaches(sideTip), { reached: true });
  git("checkout", "-q", "side");
  await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/tags/v1"] });
  assert.deepEqual(await bridge.graphReaches(mainTip), { reached: false }, "main's last commit is hidden by the filter");
  assert.deepEqual(await bridge.graphReaches(tagged), { reached: true }, "the ticked tag's commit is in the walk");
  assert.deepEqual(await bridge.graphReaches(sideTip), { reached: false }, "HEAD's is not: side is attached and unticked");
  // Detached, HEAD is walked by name, and reached.
  git("checkout", "-q", "--detach", "side");
  await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/tags/v1"] });
  assert.deepEqual(await bridge.graphReaches(sideTip), { reached: true }, "a detached HEAD is in the walk");
});

// ── Found on the released 1.13.0 ────────────────────────────────────────────

test("Show only another branch shows that branch — not the current branch's history beside it", async () => {
  // The report: on main (374 commits), "Show only origin/claude/ai-mcp-desktop"
  // listed 463 rows, 372 of them main's, under a trigger naming the one branch.
  const page = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/heads/side"] });
  const shas = shasOf(page);
  const truth = git("rev-list", "refs/heads/side").split("\n");
  assert.deepEqual([...shas].sort(), [...truth].sort(), "exactly `git rev-list side`");
  assert.equal(page.head, mainTip, "the header still knows where HEAD is");
  assert.deepEqual(page.refFilter, ["refs/heads/side"]);
  assert.equal(page.refPreset, undefined, "a hand-picked selection is no preset");
});

test("Current branch follows HEAD: stored as the preset, resolved on every load", async () => {
  await bridge.graphLoad({ skip: 0, maxCount: 50, refs: [CURRENT_BRANCH] });
  assert.deepEqual(stored.get(repo), [CURRENT_BRANCH], "stored as what it means, not as main");
  let page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(page.refFilter, ["refs/heads/main"], "resolved: the picker ticks main");
  assert.equal(page.refPreset, "current", "…and lights the preset");
  assert.ok(shasOf(page).includes(mainTip) && !shasOf(page).includes(sideTip));
  // The report: switch branch, and the filter went on naming the old one.
  git("checkout", "-q", "side");
  page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(page.refFilter, ["refs/heads/side"], "the same stored filter now means side");
  assert.equal(page.refPreset, "current");
  assert.deepEqual([...shasOf(page)].sort(), git("rev-list", "side").split("\n").sort());
  assert.deepEqual(stored.get(repo), [CURRENT_BRANCH], "nothing was rewritten to a branch name");
  // A reload that re-sends the same preset is not a filter change (no reset
  // of a skip-paged load): the stored symbol is what it compares with.
  const p1 = await bridge.graphLoad({ skip: 0, maxCount: 2 });
  const p2 = await bridge.graphLoad({ skip: p1.nextSkip, maxCount: 2, refs: [CURRENT_BRANCH] });
  assert.equal(p2.nextSkip, 4, "the same preset appended the next page");
  // Detached: there is no current branch, so the preset walks HEAD alone.
  git("checkout", "-q", "--detach", "HEAD~1");
  page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(page.refFilter, [], "no branch to tick");
  assert.equal(page.refPreset, "current");
  assert.deepEqual([...shasOf(page)].sort(), git("rev-list", "HEAD").split("\n").sort());
});

test("Local only follows the branches that exist, and Current + upstream the upstream", async () => {
  await bridge.graphLoad({ skip: 0, maxCount: 50, refs: [LOCAL_BRANCHES] });
  git("branch", "late", tagged);
  const page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual([...(page.refFilter ?? [])].sort(), ["refs/heads/late", "refs/heads/main", "refs/heads/side"]);
  assert.equal(page.refPreset, "local");
  // A tracked branch brings its upstream; the preset reads back as itself.
  git("update-ref", "refs/remotes/origin/main", tagged);
  git("config", "remote.origin.url", repo);
  git("config", "remote.origin.fetch", "+refs/heads/*:refs/remotes/origin/*");
  git("config", "branch.main.remote", "origin");
  git("config", "branch.main.merge", "refs/heads/main");
  const up = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: [CURRENT_BRANCH, CURRENT_UPSTREAM] });
  assert.deepEqual(up.refFilter, ["refs/heads/main", "refs/remotes/origin/main"]);
  assert.equal(up.refPreset, "currentUpstream");
});

test("a detached HEAD is still HEAD: every page names its commit", async () => {
  // The report: detached at main~3, the header read "no commits yet" over the
  // history, and the rail lost Jump to HEAD — `head` was "".
  git("checkout", "-q", "--detach", "HEAD~3");
  const at = git("rev-parse", "HEAD");
  const all = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.equal(all.head, at);
  const filtered = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/heads/side"] });
  assert.equal(filtered.head, at);
  assert.ok(shasOf(filtered).includes(at), "and a filter keeps the commit you are on");
});

test("a prune against a ref listing that failed is not written back", async () => {
  // One transient for-each-ref failure used to forget the selection for
  // good: the listing was swallowed into an empty list, every remembered ref
  // was pruned against it, and the resulting null was persisted.
  stored.set(repo, ["refs/heads/side"]);
  const listRefs = ctx.refs.listRefs.bind(ctx.refs);
  let mode: "throw" | "empty" | "ok" = "throw";
  (ctx.refs as { listRefs: () => Promise<unknown> }).listRefs = async () => {
    if (mode === "throw") throw new Error("fatal: unable to read refs");
    if (mode === "empty") return [];
    return listRefs();
  };
  let page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(stored.get(repo), ["refs/heads/side"], "the stored selection survives a listing that threw");
  assert.deepEqual(page.refFilter, ["refs/heads/side"], "…and is the filter this load applied, as stored");
  assert.ok(shasOf(page).includes(sideTip), "…and walked");

  mode = "empty";
  page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(stored.get(repo), ["refs/heads/side"], "a listing that found nothing is no list to prune against either");
  assert.deepEqual(page.refFilter, ["refs/heads/side"]);

  // A request that SETS the filter is still remembered, as asked.
  page = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: ["refs/tags/v1"] });
  assert.deepEqual(stored.get(repo), ["refs/tags/v1"]);
  assert.deepEqual(page.refFilter, ["refs/tags/v1"]);

  // Once the listing works again, a real prune does its job as before.
  mode = "ok";
  stored.set(repo, ["refs/heads/deleted-elsewhere", "refs/heads/side"]);
  page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(stored.get(repo), ["refs/heads/side"]);
  assert.deepEqual(page.refFilter, ["refs/heads/side"]);
});

test("AppSettings round-trips a per-repo filter through disk", async () => {
  const d = mkdtempSync(join(tmpdir(), "gitstudio-settings-graph-"));
  const s = await AppSettings.load(d, { defaultCloneDir: "/x", home: "/h" });
  assert.equal(s.graphRefFilter("/repo/a"), null);
  await s.setGraphRefFilter("/repo/a", ["refs/heads/main", "refs/remotes/origin/main"]);
  await s.setGraphRefFilter("/repo/b", ["refs/tags/v1"]);
  const s2 = await AppSettings.load(d, { defaultCloneDir: "/x", home: "/h" });
  assert.deepEqual(s2.graphRefFilter("/repo/a"), ["refs/heads/main", "refs/remotes/origin/main"]);
  assert.deepEqual(s2.graphRefFilter("/repo/b"), ["refs/tags/v1"]);
  await s2.setGraphRefFilter("/repo/a", null);
  const s3 = await AppSettings.load(d, { defaultCloneDir: "/x", home: "/h" });
  assert.equal(s3.graphRefFilter("/repo/a"), null, "null forgets");
  assert.deepEqual(s3.graphRefFilter("/repo/b"), ["refs/tags/v1"], "…only for that repo");
});
