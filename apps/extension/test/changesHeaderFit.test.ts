import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// The Changes view's header at every sidebar width: what gives way, in what
// order, so the branch keeps as much of its name as there is room for.
//
// With several repositories at 300px the repository control was down to its
// icon and the branch to "fea…", while "Push 2" and "Pull 3" kept their full
// width. The repository's name still folds first (as #32 decided); then the
// pills let their verbs go and keep an arrow and a count, named in full for
// a screen reader.
//
// The table: widths × one or several repositories × a short or long branch ×
// with or without commits to sync. Per cell, from layout: nothing leaves the
// header, the order holds (verbs only after the name), everything that could
// give way has when the branch is still clipped, and nothing is folded where
// everything fits.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

interface Cell {
  compact: boolean;
  folded: boolean;
  repoShown: boolean;
  clipped: boolean;
  overflow: boolean;
  aheadLabel: string | null;
}

const measure = (page: ChangesPage) =>
  page.eval<Cell>(`(function () {
    var name = document.getElementById("branch-name");
    var bar = document.querySelector(".repo-bar").getBoundingClientRect();
    var overflow = false;
    document.querySelectorAll(".repo-bar > *, .sync > *").forEach(function (n) {
      if (getComputedStyle(n).display === "none") return;
      var r = n.getBoundingClientRect();
      if (r.width && (r.right > bar.right + 0.5 || r.left < bar.left - 0.5)) overflow = true;
    });
    var repo = document.getElementById("repo-pill");
    return {
      compact: document.getElementById("sync").classList.contains("compact"),
      folded: repo.classList.contains("folded"),
      repoShown: !repo.hidden,
      clipped: name.scrollWidth > name.clientWidth + 0.5,
      overflow: overflow,
      aheadLabel: document.getElementById("ahead").getAttribute("aria-label"),
    };
  })()`);

test("the header's state table: nothing leaves it, the repository's name goes first, then the verbs, and a wide one gives both back", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 520, height: 400 });
  opened.push(page);
  const failures: string[] = [];
  let cells = 0;
  for (const repos of [1, 3]) {
    for (const branch of ["main", "feature/checkout-flow-with-a-long-name"]) {
      for (const sync of [{ ahead: 2, behind: 3 }, { ahead: 0, behind: 0 }]) {
        await page.send({
          ...stateMessage({ local: [{ name: branch, current: true, upstream: `origin/${branch}`, ...sync }] }),
          repoCount: repos,
          repoName: "gitstudio-monorepo",
          repoPath: "code/gitstudio-monorepo",
        });
        for (const width of [240, 300, 340, 420, 520, 700]) {
          await page.resize(width, 400);
          const c = await measure(page);
          cells++;
          const at = `${repos} repo(s), ${branch}, ${sync.ahead}/${sync.behind} @ ${width}px`;
          if (c.overflow) failures.push(`${at}: something leaves the header`);
          if (c.compact && c.repoShown && !c.folded) failures.push(`${at}: the verbs went before the repository's name`);
          if (c.clipped && (!c.compact || (c.repoShown && !c.folded))) failures.push(`${at}: the branch is clipped with room left to give`);
          if (sync.ahead && c.aheadLabel !== "Push 2 commits") failures.push(`${at}: the pill is named ${c.aheadLabel}`);
        }
        // Wide again: everything back.
        await page.resize(900, 400);
        const wide = await measure(page);
        if (branch === "main" && (wide.compact || wide.folded)) failures.push(`${repos} repo(s), ${branch}: still folded at 900px`);
      }
    }
  }
  assert.equal(cells, 48);
  assert.deepEqual(failures, []);
});

test("at 300px with three repositories, the branch shows more than the pills' verbs did", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 300, height: 400 });
  opened.push(page);
  await page.send({
    ...stateMessage({
      local: [{ name: "feature/checkout-flow", current: true, upstream: "origin/feature/checkout-flow", ahead: 2, behind: 3 }],
    }),
    repoCount: 3,
    repoName: "gitstudio-monorepo-with-a-long-name",
  });
  const c = await measure(page);
  assert.equal(c.folded, true);
  assert.equal(c.compact, true);
  const shown = await page.eval<{ branch: number; verbs: string[] }>(`({
    branch: document.getElementById("branch-name").clientWidth,
    verbs: Array.prototype.map.call(document.querySelectorAll(".sync-verb"), function (v) { return getComputedStyle(v).display; }),
  })`);
  assert.ok(shown.branch >= 90, `the branch has ${shown.branch}px`);
  assert.deepEqual(shown.verbs, ["none", "none"]);
});
