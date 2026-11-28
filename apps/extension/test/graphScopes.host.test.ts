// The graph host (graphPanel.ts) under every "Show branches" scope, against
// real repositories — the extension's half of what
// apps/desktop/test/graphLoadScopes.test.ts pins for the desktop:
//
//   · #159 — a tag on a commit the scope draws is drawn as a chip in every
//     scope. Every preset ticks branches only, and chips were kept for ticked
//     refs only, so "Current branch", "Current + upstream" and "Local only"
//     drew no tag at all.
//   · crash report #97's twin — an UNBORN HEAD made the unfiltered walk throw
//     "ambiguous argument 'HEAD'". The host read that as an empty repository,
//     so an orphan branch beside a whole history said "No commits yet".

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as kit from "./graphPanel.kit";

/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/no-explicit-any */
const { CommitGraphPanel } = require("../src/graph/graphPanel") as typeof import("../src/graph/graphPanel");
const { CURRENT_BRANCH, CURRENT_UPSTREAM, LOCAL_BRANCHES } =
  require("@gitstudio/host-bridge/graphRefFilter") as typeof import("@gitstudio/host-bridge/graphRefFilter");

const EXT = kit.Uri.file("/ext");

const SCOPES: Array<[string, string[] | null]> = [
  ["All", null],
  ["Current branch", [CURRENT_BRANCH]],
  ["Current + upstream", [CURRENT_BRANCH, CURRENT_UPSTREAM]],
  ["Local only", [LOCAL_BRANCHES]],
];

const live: { dispose(): void }[] = [];
afterEach(() => {
  while (live.length) {
    try {
      live.pop()!.dispose();
    } catch {
      /* a failed cleanup must not leak into the next test */
    }
  }
  kit.resetRecords();
});

/** A graph host over `repo`, told the page is ready. */
function open(repo: kit.Repo) {
  const w = kit.fakeWebview();
  const entry = { root: repo.dir, ctx: repo.ctx };
  const repos = {
    onDidChange: () => ({ dispose() {} }),
    getActive: () => entry,
    getAll: () => [entry],
    isDiscovering: () => false,
    getUndoLedger: () => undefined,
    findByPath: () => entry,
  };
  const host = CommitGraphPanel.forView(w as never, repos as never, EXT as never, {});
  live.push(host);
  w.send({ type: "ready" });
  const of = (type: string) => w.posted.filter((m) => m.type === type);
  return {
    w,
    errors: () => of("graphError"),
    nth: (type: string, n: number) =>
      kit.until(() => of(type)[n - 1], `${type} #${n} (posted: ${w.posted.map((m) => m.type).join(", ")})`),
  };
}

/** The first graphInit under `refs` — set from the picker exactly as the page sets it. */
async function initUnder(repo: kit.Repo, refs: string[] | null): Promise<{ init: Record<string, any>; errors: unknown[] }> {
  const g = open(repo);
  let init = await g.nth("graphInit", 1);
  if (refs !== null) {
    g.w.send({ type: "setRefFilter", refs });
    init = await g.nth("graphInit", 2);
  }
  return { init, errors: g.errors() };
}

const chipsAt = (init: Record<string, any>, sha: string): string[] =>
  init.rows.find((r: { sha: string }) => r.sha === sha)?.refs.map((x: { fullName: string }) => x.fullName) ?? [];

function mkRepo(): kit.Repo {
  const r = kit.mkRepo();
  live.push(r);
  return r;
}

// ── #159 ─────────────────────────────────────────────────────────────────────

for (const [scope, refs] of SCOPES) {
  test(`#159 ${scope}: a tag on a drawn commit keeps its chip — annotated, lightweight, and beside a branch of its name`, async () => {
    const r = mkRepo();
    r.commit("base");
    const rel = r.commit("release");
    r.git("tag", "-a", "-m", "1.0.0", "v1.0.0");
    r.git("tag", "release");
    r.git("branch", "release");
    r.git("remote", "add", "origin", "https://git.acme.example/widgets.git");
    r.git("update-ref", "refs/remotes/origin/main", rel);
    r.git("branch", "--set-upstream-to=origin/main", "main");
    const tip = r.commit("tip");
    const { init, errors } = await initUnder(r, refs);
    assert.deepEqual(errors, []);
    assert.ok(init.rows.some((x: { sha: string }) => x.sha === tip), "sanity: the scope draws main");
    const at = chipsAt(init, rel);
    assert.ok(at.includes("refs/tags/v1.0.0"), `${scope}: ${at.join(", ")}`);
    assert.ok(at.includes("refs/tags/release"), `${scope}: the tag named like a branch`);
    const branchWalked = refs === null || refs.includes(LOCAL_BRANCHES);
    assert.equal(at.includes("refs/heads/release"), branchWalked, `${scope}: the branch named release follows the scope`);
    const upstreamWalked = refs === null || refs.includes(CURRENT_UPSTREAM);
    assert.equal(at.includes("refs/remotes/origin/main"), upstreamWalked, `${scope}: origin/main follows the scope`);
  });
}

test("#159: a tag on history the scope does not walk pulls none of it in", async () => {
  const r = mkRepo();
  const base = r.commit("base");
  r.commit("main work");
  r.git("checkout", "-q", "-b", "side", base);
  const sideTip = r.commit("side work");
  r.git("tag", "side-only");
  r.git("checkout", "-q", "main");
  const { init } = await initUnder(r, [CURRENT_BRANCH]);
  assert.equal(init.rows.some((x: { sha: string }) => x.sha === sideTip), false);
  const chips = init.rows.flatMap((x: { refs: { fullName: string }[] }) => x.refs.map((c) => c.fullName));
  assert.equal(chips.includes("refs/tags/side-only"), false);
});

// ── #97's twin ───────────────────────────────────────────────────────────────

for (const [scope, refs] of SCOPES) {
  test(`#97 ${scope}: a freshly initialised repository is the empty graph, not an error`, async () => {
    const r = mkRepo();
    const { init, errors } = await initUnder(r, refs);
    assert.deepEqual(errors, []);
    assert.deepEqual(init.rows, []);
    assert.equal(init.head, "");
  });

  test(`#97 ${scope}: on an orphan branch the other branches are still drawn where the scope walks them`, async () => {
    const r = mkRepo();
    const one = r.commit("one");
    r.git("tag", "v1");
    const two = r.commit("two");
    r.git("switch", "-q", "--orphan", "lone");
    const { init, errors } = await initUnder(r, refs);
    assert.deepEqual(errors, [], `${scope}: no error`);
    assert.equal(init.head, "");
    const walksMain = refs === null || refs.includes(LOCAL_BRANCHES);
    assert.deepEqual(
      init.rows.map((x: { sha: string }) => x.sha),
      walksMain ? [two, one] : [],
      `${scope}: main is ${walksMain ? "walked" : "not ticked"}`,
    );
    if (walksMain) assert.deepEqual(chipsAt(init, one), ["refs/tags/v1"]);
  });
}
