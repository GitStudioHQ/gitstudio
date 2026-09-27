// The Worktrees view at a sidebar's narrowest (180px), a narrow one (240px)
// and a wide one (520px), dark — for a look at how rows give way: a branch
// keeps a few letters or goes whole before the folder's name is cut, the
// state is never cut (at the narrowest it goes whole, into the tooltip). Agents' rows (long folder AND long
// branch) are added, as those are the ones that squeeze.
//
//   GS_CHROME=… npx tsx apps/extension/harness/worktrees/narrow.ts [outDir]

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreesPage } from "../../test/worktreesPage";
import { fixtureDetails, fixtureRows, row } from "../../test/worktreesFixtures";

const AGENTS = [
  row({ path: "/code/app/.claude/worktrees/agent-a2c9ae276dde4d3da", name: "agent-a2c9ae276dde4d3da", relPath: "app/.claude/worktrees/agent-a2c9ae276dde4d3da", branch: "worktree-agent-a2c9ae276dde4d3da", upstream: undefined, status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, unpublished: 2 } }),
  row({ path: "/code/app/.claude/worktrees/agent-a6ca5aacb06de1cf0", name: "agent-a6ca5aacb06de1cf0", relPath: "app/.claude/worktrees/agent-a6ca5aacb06de1cf0", branch: "ci/desktop-portability", upstream: "origin/ci/desktop-portability", ahead: 3, behind: 1, status: { changed: 7, staged: 2, unstaged: 5, untracked: 0, conflicted: 0 } }),
];

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/worktrees/", import.meta.url));

(async () => {
  mkdirSync(OUT, { recursive: true });
  for (const width of [180, 240, 520]) {
    const page = await WorktreesPage.open("dark", { width, height: 760, scale: 2 });
    try {
      await page.send({ type: "rows", rows: [...fixtureRows(), ...AGENTS], state: "ok", labels: { reveal: "Reveal in Finder" } });
      await page.clickOn('.wt-row[data-path="/code/app-login"] .wt-name');
      await page.send({ type: "details", path: "/code/app-login", details: fixtureDetails() });
      await page.settle(80);
      const file = join(OUT, `width-${width}-dark.png`);
      await page.screenshot(file);
      console.log(file);
    } finally {
      await page.close();
    }
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
