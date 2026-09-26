// Screenshots of the Interactive Rebase workspace with a selection (issue
// #32) — per theme, in the real page the panel serves, in a windowless Chrome
// (test/rebasePanelPage.ts), driven with real keys.
//
//   npx tsx apps/extension/harness/rebase-panel/shots.ts [outDir]
//
// Writes to <repo>/out/rebase-panel by default:
//   selection-<theme>.png  three fixups set at once from the keyboard, the
//                          toolbar showing what they are set to
//   squash-all-<theme>.png every commit squashed at once, the oldest kept,
//                          and the footer saying so
//   paused-<theme>.png     a paused rebase's banner (Continue, Skip, Abort),
//                          handed back after a refused squash borrowed it

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { MOD, RebasePanelPage, type VsCodeTheme } from "../../test/rebasePanelPage";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/rebase-panel/", import.meta.url));

async function main(): Promise<void> {
  if (!RebasePanelPage.chrome()) {
    console.error("no windowless Chrome on this machine (set GS_CHROME)");
    process.exit(2);
  }
  mkdirSync(OUT, { recursive: true });
  for (const theme of ["dark", "light"] as VsCodeTheme[]) {
    const page = await RebasePanelPage.open(theme, { width: 1100, height: 760, scale: 2 });
    try {
      await page.clickRow(0);
      await page.key("ArrowDown", { shift: true });
      await page.key("ArrowDown", { shift: true });
      await page.key("f");
      await page.settle(200);
      await page.screenshot(join(OUT, `selection-${theme}.png`));

      await page.key("a", MOD);
      await page.key("s");
      await page.settle(200);
      await page.screenshot(join(OUT, `squash-all-${theme}.png`));

      await page.eval(`window.__send({ type: "result", outcome: { status: "stopped", reason: "conflict", message: "" }, stop: { conflicts: 1, canSkip: true } })`);
      await page.clickRow(11);
      await page.key("s");
      await page.settle(4300); // the refusal's flash, over
      await page.screenshot(join(OUT, `paused-${theme}.png`));
      console.log(`wrote ${theme}`);
    } finally {
      await page.close();
    }
  }
}

void main();
