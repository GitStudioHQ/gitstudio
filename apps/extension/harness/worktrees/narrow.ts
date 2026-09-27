// The Worktrees view at a narrow sidebar's width (240px) and a wide one
// (520px), dark — for a look at how rows give way: badges fold into
// "+N more", names and paths clip with an ellipsis, buttons stay put.
//
//   GS_CHROME=… npx tsx apps/extension/harness/worktrees/narrow.ts [outDir]

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreesPage } from "../../test/worktreesPage";
import { fixtureDetails, fixtureRows } from "../../test/worktreesFixtures";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/worktrees/", import.meta.url));

(async () => {
  mkdirSync(OUT, { recursive: true });
  for (const width of [240, 520]) {
    const page = await WorktreesPage.open("dark", { width, height: 760, scale: 2 });
    try {
      await page.send({ type: "rows", rows: fixtureRows(), state: "ok", labels: { reveal: "Reveal in Finder" } });
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
