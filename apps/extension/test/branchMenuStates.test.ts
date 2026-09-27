import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ChangesPage, stateMessage, type LocalBranch } from "./changesPage";

// The Changes view's branch menu before its branches arrive, and on a HEAD
// that is no branch — in the real page commitView.ts serves, in a windowless
// Chrome:
//   · until the host has listed the branches (the first state for a
//     repository carries none), the menu says they are loading — it never
//     shows a repository with no branches — and the rows replace that as
//     soon as they arrive, even when there are none;
//   · a submenu names what it acts on: the current branch, or on a detached
//     HEAD the commit HEAD is at, never a branch called "current branch";
//   · a branch whose upstream is gone offers no pull from it, and its
//     actions start with Set Tracked Branch…;
//   · the words say what happens — "Push…" asks more, a count has its unit —
//     and every glyph is a codicon this build ships, none of them the check
//     that marks the checked-out branch or the view's tree/list toggle.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: ChangesPage;
before(async () => {
  if (chrome) page = await ChangesPage.open("dark", { width: 560, height: 640 });
});
after(async () => {
  if (page) await page.close();
});

const LOCAL: LocalBranch[] = [
  { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
  { name: "feature", upstream: "origin/feature", upstreamOnRemote: true },
];

/** A state push as the host's first one for a repository sends it: no branches yet. */
function withoutBranches(): Record<string, unknown> {
  const s = stateMessage({ local: LOCAL });
  delete s.branches;
  return s;
}

async function openMenu(): Promise<void> {
  await page.eval(`(function () { if (document.querySelector(".branch-menu")) document.getElementById("branch-pill").click(); })()`);
  await page.send({ type: "openBranchMenu" });
  await page.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
}
const menuText = (): Promise<{ loading: boolean; loadingText: string; branches: string[]; noMatches: boolean }> =>
  page.eval(`(function () {
    var l = document.querySelector(".bm-list .bm-loading");
    return {
      loading: !!l,
      loadingText: l ? l.textContent.trim() : "",
      branches: Array.prototype.map.call(document.querySelectorAll(".bm-list .bm-branch"), function (r) { return r.dataset.bmkey; }),
      noMatches: /No matches/.test(document.querySelector(".bm-list").textContent),
    };
  })()`);

test("before the branches arrive the menu says they are loading, and the rows replace it", { skip }, async () => {
  await page.send(withoutBranches());
  await openMenu();
  let m = await menuText();
  assert.ok(m.loading, "a loading row");
  assert.equal(m.loadingText, "Loading branches…");
  assert.deepEqual(m.branches, []);
  await page.type("zzzq");
  m = await menuText();
  assert.ok(m.loading && !m.noMatches, "a search while loading does not claim there is nothing");

  // The slow post lands with the menu open.
  await page.send(stateMessage({ local: LOCAL }));
  await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  m = await menuText();
  assert.ok(!m.loading, "the loading row is gone");
  assert.deepEqual(m.branches, ["b:local:main", "b:local:feature"]);

  // A later push without branches for the same repo (the host sends the
  // last-known list then, but a switch to another repository does not).
  await page.send(withoutBranches());
  m = await menuText();
  assert.ok(m.loading, "another repository's first push: loading, not the old rows");
  assert.deepEqual(m.branches, []);

  // A repository that really has no branches yet (an unborn HEAD): no rows, and not loading.
  await page.send(stateMessage({ local: [] }));
  m = await menuText();
  assert.ok(!m.loading, "an empty list that arrived is not loading");
});

test("a submenu names what it acts on: the current branch, or the commit a detached HEAD is at", { skip }, async () => {
  const labelsFor = async (q: string): Promise<string[]> => {
    await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
    await page.type(q);
    await page.key("ArrowRight");
    const labels = await page.eval<string[]>(
      `Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`,
    );
    await page.key("ArrowLeft");
    return labels;
  };

  await page.send(stateMessage({ local: LOCAL, remote: ["origin/main"], tags: ["v1.0"] }));
  await openMenu();
  let labels = await labelsFor("origin/main");
  assert.ok(labels.includes("Merge 'origin/main' into 'main'"), labels.join(" | "));

  // Detached at a1b2c3d: no local branch is current.
  const detached = {
    ...stateMessage({ local: LOCAL.map((b) => ({ ...b, current: false })), remote: ["origin/main"], tags: ["v1.0"] }),
    branch: "a1b2c3d",
    detached: true,
    upstream: undefined,
  };
  await page.send(detached);
  await openMenu();
  for (const q of ["origin/main", "feature", "v1.0"]) {
    labels = await labelsFor(q);
    assert.ok(!labels.some((l) => /current branch/.test(l)), `${q}: ${labels.join(" | ")}`);
    const name = q;
    assert.ok(labels.includes(`Compare with HEAD (a1b2c3d)`), `${q}: ${labels.join(" | ")}`);
    assert.ok(labels.includes(`Merge '${name}' into HEAD (a1b2c3d)`), `${q}: ${labels.join(" | ")}`);
    if (q !== "v1.0") assert.ok(labels.includes(`Rebase HEAD (a1b2c3d) onto '${name}'`), `${q}: ${labels.join(" | ")}`);
  }

  // An unborn branch: git lists no ref for it yet, but HEAD is on 'main'.
  await page.send({ ...stateMessage({ local: [], remote: ["origin/main"] }), branch: "main" });
  await openMenu();
  labels = await labelsFor("origin/main");
  assert.ok(labels.includes("Merge 'origin/main' into 'main'"), labels.join(" | "));
});

/** Every glyph the codicon stylesheet this build ships can draw. */
const SHIPPED = new Set(
  [...readFileSync(fileURLToPath(new URL("../../../node_modules/@vscode/codicons/dist/codicon.css", import.meta.url)), "utf8")
    .matchAll(/\.codicon-([a-z0-9-]+):before/g)].map((m) => m[1]),
);

test("the menu's words say what happens, and its glyphs are real and mean one thing", { skip }, async () => {
  const local: LocalBranch[] = [
    { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
    { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, behind: 2 },
    { name: "hotfix", upstream: "origin/hotfix", upstreamOnRemote: true, behind: 1 },
    { name: "synced", upstream: "origin/synced", upstreamOnRemote: true },
  ];
  await page.send(stateMessage({ local, remote: ["origin/main", "origin/feature"], tags: ["v1.0"] }));
  await openMenu();
  const glyphs = (sel: string): Promise<{ label: string; icons: string[] }[]> =>
    page.eval(`Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(sel)}), function (n) {
      return {
        label: n.textContent.trim(),
        icons: Array.prototype.concat.apply([], Array.prototype.map.call(n.querySelectorAll(".codicon"), function (i) {
          return Array.prototype.filter.call(i.classList, function (c) { return /^codicon-/.test(c) && !/^codicon-modifier-/.test(c); })
            .map(function (c) { return c.slice(8); });
        })),
      };
    })`);
  const top = await glyphs(".bm-list .bm-action");
  assert.ok(top.some((a) => a.label === "Push…"), `the top Push asks more before it pushes: ${top.map((a) => a.label).join(" | ")}`);
  const seen = [...top, ...(await glyphs(".bm-list .bm-branch"))];

  const subs: Record<string, { label: string; icons: string[] }[]> = {};
  for (const q of ["main", "feature", "hotfix", "synced", "origin/feature", "v1.0"]) {
    await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
    await page.type(q);
    await page.key("ArrowRight");
    subs[q] = await glyphs(".branch-submenu .bm-subaction");
    await page.key("ArrowLeft");
  }
  const labels = (q: string) => subs[q].map((i) => i.label);
  assert.ok(labels("feature").includes("Pull 2 Commits into 'feature'"), labels("feature").join(" | "));
  assert.ok(labels("hotfix").includes("Pull 1 Commit into 'hotfix'"), labels("hotfix").join(" | "));
  assert.ok(labels("synced").includes("Pull into 'synced'"), labels("synced").join(" | "));

  for (const [q, items] of Object.entries(subs)) {
    for (const it of items) {
      assert.ok(!it.icons.includes("check"), `${q}: '${it.label}' does not wear the checked-out branch's check`);
      assert.ok(!it.icons.includes("list-tree"), `${q}: '${it.label}' does not wear the view's tree/list toggle`);
    }
    seen.push(...items);
  }
  for (const it of seen) {
    for (const g of it.icons) assert.ok(SHIPPED.has(g), `'${it.label}': codicon-${g} is not in the codicons this build ships`);
  }
});

// The row says its upstream is gone; its actions must not offer to pull from
// it. "Pull into 'merged-pr'" ran a fetch of a remote branch that no longer
// exists, so it could only fail, and the current branch's two pulls the same.
test("a branch whose upstream is gone offers no pull from it, and Set Tracked Branch… first", { skip }, async () => {
  const local: LocalBranch[] = [
    { name: "main", upstream: "origin/main", upstreamOnRemote: true, behind: 2 },
    { name: "merged-pr", upstream: "origin/merged-pr", gone: true },
    { name: "done", current: true, upstream: "origin/done", gone: true },
  ];
  await page.send(stateMessage({ local, remote: ["origin/main"] }));
  await openMenu();
  const labelsFor = async (q: string): Promise<string[]> => {
    await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
    await page.type(q);
    await page.key("ArrowRight");
    const labels = await page.eval<string[]>(
      `Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`,
    );
    await page.key("ArrowLeft");
    return labels;
  };
  const gone = await labelsFor("merged-pr");
  assert.ok(!gone.some((l) => /^Pull/.test(l)), `no pull: ${gone.join(" | ")}`);
  // What it needs first: another branch to track. Not a second item naming
  // the gone one as if it could be kept.
  assert.equal(gone[0], "Set Tracked Branch…", `choosing a new upstream comes first: ${gone.join(" | ")}`);
  assert.equal(gone.filter((l) => /Tracked Branch/.test(l)).length, 1, gone.join(" | "));
  assert.ok(gone.includes("Checkout") && gone.includes("Delete"), "the rest is still there");

  const current = await labelsFor("done");
  assert.ok(!current.some((l) => /^Pull/.test(l)), `the current branch: no pull either: ${current.join(" | ")}`);
  assert.equal(current[0], "Set Tracked Branch…", `nor for the current branch: ${current.join(" | ")}`);
  assert.ok(current.includes("Push…"), `but Push… is: ${current.join(" | ")}`);

  // A live upstream keeps them.
  assert.ok((await labelsFor("main")).includes("Pull 2 Commits into 'main'"));
  await page.send(stateMessage({ local: local.map((b) => (b.name === "done" ? { ...b, gone: undefined } : b)), remote: ["origin/main"] }));
  const live = await labelsFor("done");
  assert.ok(live.includes("Pull using Rebase") && live.includes("Pull using Merge"), live.join(" | "));
});
