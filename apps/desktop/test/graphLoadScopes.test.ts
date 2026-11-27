import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { GitBridge, type GraphRefFilterStore } from "../src/main/gitBridge";
import { CURRENT_BRANCH, CURRENT_UPSTREAM, LOCAL_BRANCHES } from "@gitstudio/host-bridge/graphRefFilter";
import type { GraphRefFilter } from "@gitstudio/host-bridge/graphProtocol";
import type { RepoStore } from "../src/main/repoStore";
import { initRepo, type BridgeRepo } from "./gitBridgeFixture";

// graph:load under every "Show branches" scope, on the desktop host, against
// real repositories:
//
//   · #159 — a tag on a commit the scope draws is drawn as a chip in every
//     scope. Every preset ticks branches only, and chips used to be kept for
//     ticked refs only, so no preset ever drew a tag.
//   · crash report #97 — an UNBORN HEAD (fresh init, orphan branch, init +
//     fetch) threw "ambiguous argument 'HEAD'" out of graph:load whenever any
//     ref existed, and the graph showed an error instead of the other branches.

const SCOPES: Array<[string, GraphRefFilter]> = [
  ["All", null],
  ["Current branch", [CURRENT_BRANCH]],
  ["Current + upstream", [CURRENT_BRANCH, CURRENT_UPSTREAM]],
  ["Local only", [LOCAL_BRANCHES]],
];

const live: BridgeRepo[] = [];
afterEach(() => {
  while (live.length) live.pop()!.cleanup();
});

function repoWithBridge(prefix: string): { r: BridgeRepo; bridge: GitBridge } {
  const r = initRepo(prefix);
  live.push(r);
  const stored = new Map<string, GraphRefFilter>();
  const store: GraphRefFilterStore = {
    get: (root) => stored.get(root) ?? null,
    set: (root, refs) => void stored.set(root, refs),
  };
  const bridge = new GitBridge({ getContext: () => r.ctx } as unknown as RepoStore, store);
  return { r, bridge };
}

type Page = Awaited<ReturnType<GitBridge["graphLoad"]>>;
const chipsAt = (p: Page, sha: string): string[] =>
  p.rows.find((row) => row.sha === sha)?.refs.map((x) => x.fullName ?? x.name) ?? [];
const allChips = (p: Page): string[] => p.rows.flatMap((row) => row.refs.map((x) => x.fullName ?? x.name));

// ── #159: tags in every scope ────────────────────────────────────────────────

/** main: c0 ← rel (v1.0.0, and a branch + tag both named "release") ← c2 ← tip,
 *  tracking origin/main at c2; `side` forks at c0 with a tag of its own. */
function tagged() {
  const { r, bridge } = repoWithBridge("scopes-tags");
  r.write("a.txt", "0\n");
  const c0 = r.commitAll("c0");
  r.write("a.txt", "1\n");
  const rel = r.commitAll("release 1.0.0");
  r.git("tag", "-a", "-m", "1.0.0", "v1.0.0");
  r.git("tag", "release");
  r.git("branch", "release");
  r.write("a.txt", "2\n");
  const c2 = r.commitAll("c2");
  // A remote is only configured here (nothing is fetched): its fetch refspec
  // is what maps main's merge ref onto refs/remotes/origin/main.
  r.git("remote", "add", "origin", "https://git.acme.example/widgets.git");
  r.git("update-ref", "refs/remotes/origin/main", c2);
  r.git("branch", "--set-upstream-to=origin/main", "main");
  r.write("a.txt", "3\n");
  const tip = r.commitAll("tip");
  r.git("checkout", "-q", "-b", "side", c0);
  r.write("s.txt", "s\n");
  const sideTip = r.commitAll("on side");
  r.git("tag", "side-only");
  r.git("checkout", "-q", "main");
  return { r, bridge, c0, rel, c2, tip, sideTip };
}

for (const [scope, refs] of SCOPES) {
  test(`#159 ${scope}: a tag on a drawn commit is drawn — annotated, lightweight, and beside a branch of its name`, async () => {
    const { bridge, rel, tip } = tagged();
    const page = await bridge.graphLoad({ skip: 0, maxCount: 50, refs });
    assert.ok(page.rows.some((row) => row.sha === tip), "sanity: the scope draws main");
    const atRel = chipsAt(page, rel);
    assert.ok(atRel.includes("refs/tags/v1.0.0"), `${scope}: the annotated tag — got ${atRel.join(", ")}`);
    assert.ok(atRel.includes("refs/tags/release"), `${scope}: the lightweight tag that shares a branch's name`);
    // The branch "release" is chipped only where it is walked: under All and
    // Local only. Its tag twin never stands in for it, nor it for the tag.
    const branchWalked = refs === null || refs.includes(LOCAL_BRANCHES);
    assert.equal(atRel.includes("refs/heads/release"), branchWalked, `${scope}: the branch named release`);
  });
}

test("#159: the scope still chooses the history — a tag reaching only unwalked history pulls none of it in", async () => {
  const { bridge, sideTip } = tagged();
  for (const [scope, refs] of SCOPES.slice(1, 3)) {
    const page = await bridge.graphLoad({ skip: 0, maxCount: 50, refs });
    assert.equal(page.rows.some((row) => row.sha === sideTip), false, `${scope}: side's commit is not drawn`);
    assert.equal(allChips(page).includes("refs/tags/side-only"), false, `${scope}: so neither is its tag`);
  }
  const all = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: null });
  assert.deepEqual(chipsAt(all, sideTip), ["refs/heads/side", "refs/tags/side-only"], "under All it is both");
});

test("#159: branch chips still follow the scope — Current branch draws no origin/main chip, Current + upstream does", async () => {
  const { bridge, c2 } = tagged();
  const current = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: [CURRENT_BRANCH] });
  assert.deepEqual(chipsAt(current, c2), []);
  const upstream = await bridge.graphLoad({ skip: 0, maxCount: 50, refs: [CURRENT_BRANCH, CURRENT_UPSTREAM] });
  assert.deepEqual(chipsAt(upstream, c2), ["refs/remotes/origin/main"]);
});

// ── #97: an unborn HEAD ──────────────────────────────────────────────────────

for (const [scope, refs] of SCOPES) {
  test(`#97 ${scope}: a freshly initialised repository loads an empty graph, not an error`, async () => {
    const { bridge } = repoWithBridge("scopes-empty");
    const page = await bridge.graphLoad({ skip: 0, maxCount: 50, refs });
    assert.deepEqual(page.rows, []);
    assert.equal(page.head, "");
    assert.equal(page.hasMore, false);
  });

  test(`#97 ${scope}: on an orphan branch the graph loads — and still draws the other branches where the scope walks them`, async () => {
    const { r, bridge } = repoWithBridge("scopes-orphan");
    r.write("a.txt", "0\n");
    const one = r.commitAll("one");
    r.git("tag", "v1");
    r.write("a.txt", "1\n");
    const two = r.commitAll("two");
    r.git("switch", "-q", "--orphan", "lone");
    const page = await bridge.graphLoad({ skip: 0, maxCount: 50, refs });
    assert.equal(page.head, "", "HEAD names no commit");
    // The unborn branch is "current", and has nothing; main is another branch.
    const drawn = page.rows.map((row) => row.sha);
    const walksMain = refs === null || refs.includes(LOCAL_BRANCHES);
    assert.deepEqual(drawn, walksMain ? [two, one] : [], `${scope}: ${drawn.join(", ")}`);
    if (walksMain) assert.deepEqual(chipsAt(page, one), ["refs/tags/v1"]);
  });
}

test("#97: an init + fetch that never checked out draws the fetched history", async () => {
  const { r, bridge } = repoWithBridge("scopes-fetched");
  r.write("a.txt", "0\n");
  const one = r.commitAll("one");
  r.write("a.txt", "1\n");
  const two = r.commitAll("two");
  r.git("update-ref", "refs/remotes/origin/main", two);
  r.git("switch", "-q", "--orphan", "main-to-be");
  r.git("branch", "-D", "main");
  const page = await bridge.graphLoad({ skip: 0, maxCount: 50 });
  assert.deepEqual(page.rows.map((row) => row.sha), [two, one]);
  assert.deepEqual(chipsAt(page, two), ["refs/remotes/origin/main"]);
});
