// Screenshots of the Worktrees view — per theme (Dark+, Light+, Dark High
// Contrast, Light High Contrast), in the bundle the extension ships, in a
// windowless Chrome (test/worktreesPage.ts), at a sidebar's width.
//
//   GS_CHROME=… npx tsx apps/extension/harness/worktrees/shots.ts [outDir]
//
// Writes to <repo>/out/worktrees by default: the list (every row state), an
// open row (its uncommitted files, its commits not pushed, one commit open to
// its files), a row's More menu, the "only the main worktree" explainer, and
// a filtered list of many.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreesPage, type VsCodeTheme } from "../../test/worktreesPage";
import { fixtureDetails, fixtureRows, row } from "../../test/worktreesFixtures";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/worktrees/", import.meta.url));
const LABELS = { reveal: "Reveal in Finder" };

async function shoot(theme: VsCodeTheme): Promise<string[]> {
  const files: string[] = [];
  const page = await WorktreesPage.open(theme, { width: 320, height: 620, scale: 2 });
  const snap = async (name: string): Promise<void> => {
    const file = join(OUT, `${name}-${theme}.png`);
    await page.settle();
    await page.screenshot(file);
    files.push(file);
  };
  try {
    const rows = fixtureRows();
    await page.send({ type: "rows", rows, state: "ok", labels: LABELS });
    await snap("list");

    // An open row: this window's worktree, with a commit open to its files.
    await page.clickOn('.wt-row[data-path="/code/app-login"] .wt-name');
    await page.send({ type: "details", path: "/code/app-login", details: fixtureDetails() });
    await page.clickOn('.wt-item[data-path="/code/app-login"] .cr-commit');
    const sha = fixtureDetails().unpushed!.commits[0].sha;
    await page.send({
      type: "commitFiles",
      path: "/code/app-login",
      sha,
      files: [
        { path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 },
        { path: "src/auth/store.ts", status: "A", additions: 41, deletions: 0 },
      ],
    });
    await snap("open-row");

    // The More menu of the agent's locked worktree.
    await page.clickOn('.wt-row[data-path="/code/app-login"] .wt-name'); // close it again
    await page.clickOn('.wt-row[data-path="/code/app/.claude/worktrees/agent-a2c9ae27"] .wt-more');
    await snap("menu");
    await page.key("Escape");

    // Only the main worktree: the explainer and New Worktree….
    await page.send({ type: "rows", rows: [rows[0]], state: "ok", labels: LABELS });
    await snap("only-main");

    // Many: the filter.
    const many = Array.from({ length: 24 }, (_, i) =>
      row({ path: `/code/app/.claude/worktrees/agent-${i}`, name: `agent-${String(i).padStart(2, "0")}`, relPath: `app/.claude/worktrees/agent-${i}`, branch: `worktree-agent-${i}`, upstream: undefined }),
    );
    await page.send({ type: "rows", rows: [rows[0], ...many], state: "ok", labels: LABELS });
    await page.clickOn(".wt-filter-input");
    await page.type("agent-1");
    await snap("filter");
    if (page.errors().length) throw new Error(`page errors: ${page.errors().join("\n")}`);
  } finally {
    await page.close();
  }
  return files;
}

(async () => {
  if (!WorktreesPage.chrome()) throw new Error("no windowless Chrome on this machine (set GS_CHROME)");
  mkdirSync(OUT, { recursive: true });
  const themes = (process.env.THEMES?.split(",") ?? ["dark", "light", "hc-dark", "hc-light"]) as VsCodeTheme[];
  for (const theme of themes) {
    for (const f of await shoot(theme)) console.log(f);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
