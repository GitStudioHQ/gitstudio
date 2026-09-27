// The Worktrees view as a person meets it — one, three and ten worktrees in
// mixed states, and this repository's own agents' worktrees — per theme, at a
// sidebar's width: the list as it opens, a row hovered, a row busy and
// hovered, a row open, a row open with nothing to say, and a row's More menu.
// For looking at, side by side with an earlier build's pictures.
//
//   GS_CHROME=… npx tsx apps/extension/harness/worktrees/scenes.ts [outDir]
//   THEMES=light-modern SCENES=ten,real … (a subset)

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { WorktreeDetails, WorktreeRow } from "@gitstudio/host-bridge/worktreesProtocol";
import { WorktreesPage, type VsCodeTheme } from "../../test/worktreesPage";
import { agentRows, fixtureDetails, fixtureRows, row } from "../../test/worktreesFixtures";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/worktrees-scenes/", import.meta.url));
const LABELS = { reveal: "Reveal in Finder" };
const THEMES = (process.env.THEMES?.split(",") ?? ["dark", "light", "dark-modern", "light-modern", "hc-dark", "hc-light"]) as VsCodeTheme[];
const ONLY = process.env.SCENES?.split(",");
const now = Math.floor(Date.now() / 1000);

/** The owner's own repository, as the screenshot showed it: no remote, two worktrees and a third. */
const three: WorktreeRow[] = [
  row({
    path: "/code/quick-rebase",
    name: "quick-rebase",
    kind: "main",
    branch: "test",
    upstream: undefined,
    hasRemotes: false,
    defaultBranch: "master",
    current: true,
    status: { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, unpublished: 1 },
  }),
  row({
    path: "/code/quick-rebase-tester",
    name: "quick-rebase-tester",
    branch: "tester",
    upstream: undefined,
    hasRemotes: false,
    defaultBranch: "master",
    status: { changed: 3, staged: 1, unstaged: 2, untracked: 0, conflicted: 0, unpublished: 1 },
  }),
  row({
    path: "/code/quick-rebase-master",
    name: "quick-rebase-master",
    branch: "master",
    upstream: undefined,
    hasRemotes: false,
    defaultBranch: "master",
    onDefaultBranch: true,
  }),
];

const notOnMaster: WorktreeDetails = {
  files: [],
  filesTotal: 0,
  unpushed: {
    title: "Not on master",
    more: false,
    commits: [{ sha: "51d376f0a1b2c3d4e5f60718293a4b5c6d7e8f90", parents: ["4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39"], subject: "test: rework the sample", author: "Anton", date: now - 41 * 60 }],
  },
};

const testerDetails: WorktreeDetails = {
  files: [
    { path: "src/rebase/plan.ts", status: "M", area: "staged" },
    { path: "src/rebase/todo.ts", status: "M", area: "unstaged" },
    { path: "README.md", status: "M", area: "unstaged" },
  ],
  filesTotal: 3,
  unpushed: notOnMaster.unpushed,
};

const nothing: WorktreeDetails = { files: [], filesTotal: 0, unpushed: { title: "Not on master", more: false, commits: [] } };

interface Scene {
  name: string;
  rows: WorktreeRow[];
  open?: { path: string; details: WorktreeDetails }[];
  hover?: string;
  /** Rows busy with an action, and what each says. */
  busy?: { path: string; label: string }[];
  /** Hold the pointer on the hovered row until its tooltip shows. */
  tip?: boolean;
  menu?: string;
  height?: number;
}

const ten = fixtureRows().slice(0, 10);
const SCENES: Scene[] = [
  { name: "one", rows: [fixtureRows()[0]], height: 300 },
  { name: "three", rows: three, height: 320 },
  { name: "three-hover", rows: three, hover: "/code/quick-rebase-tester", height: 320 },
  { name: "three-tip", rows: three, hover: "/code/quick-rebase-tester", tip: true, height: 320 },
  { name: "ten-tip", rows: ten, hover: "/code/app/.claude/worktrees/agent-a2c9ae27", tip: true, height: 520 },
  {
    name: "three-open",
    rows: three,
    open: [
      { path: "/code/quick-rebase", details: notOnMaster },
      { path: "/code/quick-rebase-tester", details: testerDetails },
      { path: "/code/quick-rebase-master", details: nothing },
    ],
    height: 420,
  },
  { name: "three-menu", rows: three, menu: "/code/quick-rebase-tester", height: 420 },
  { name: "ten", rows: ten, height: 520 },
  { name: "ten-open", rows: ten, open: [{ path: "/code/app-login", details: fixtureDetails() }], height: 640 },
  { name: "ten-menu", rows: ten, menu: "/code/app/.claude/worktrees/agent-a2c9ae27", height: 640 },
  { name: "ten-busy-hover", rows: ten, busy: [{ path: "/code/app-checkout", label: "Removing…" }], hover: "/code/app-checkout", height: 520 },
  { name: "real", rows: agentRows(), height: 420 },
];

async function shoot(theme: VsCodeTheme, width: number): Promise<string[]> {
  const files: string[] = [];
  for (const scene of SCENES) {
    if (ONLY && !ONLY.includes(scene.name)) continue;
    // A tooltip is shot at 1x: at 2x the headless browser's own after-layout
    // mouse move lands on another row, which takes the tooltip away.
    const page = await WorktreesPage.open(theme, { width, height: scene.height ?? 560, scale: scene.tip ? 1 : 2 });
    try {
      await page.send({ type: "rows", rows: scene.rows, state: "ok", labels: LABELS });
      await page.settle(60);
      for (const o of scene.open ?? []) {
        await page.clickOn(`.wt-row[data-path="${o.path}"] .wt-name`);
        await page.send({ type: "details", path: o.path, details: o.details });
      }
      if (scene.open?.[0]?.details.unpushed?.commits[0]) {
        const first = scene.open.find((o) => o.details.unpushed?.commits.length && o.details.files.length) ?? scene.open[0];
        const sha = first.details.unpushed!.commits[0].sha;
        await page.clickOn(`.wt-item[data-path="${first.path}"] .cr-commit-item[data-sha="${sha}"] .cr-commit`);
        await page.send({
          type: "commitFiles",
          path: first.path,
          sha,
          files: [
            { path: "src/sample.ts", status: "M", additions: 12, deletions: 4 },
            { path: "test/sample.test.ts", status: "A", additions: 30, deletions: 0 },
          ],
        });
      }
      for (const b of scene.busy ?? []) await page.send({ type: "busy", path: b.path, busy: true, label: b.label });
      if (scene.menu) await page.clickOn(`.wt-row[data-path="${scene.menu}"] .wt-more`);
      await page.settle(60);
      if (scene.hover) {
        const r = await page.eval<{ x: number; y: number }>(`(function () { var b = document.querySelector('.wt-row[data-path="${scene.hover}"]').getBoundingClientRect(); return { x: b.left + 30, y: b.top + b.height / 2 }; })()`);
        await page.mouseMove(r.x, r.y);
        await page.settle(scene.tip ? 600 : 80);
      } else {
        await page.mouseMove(1, 1);
      }
      const file = join(OUT, `${scene.name}-${width}-${theme}.png`);
      await page.screenshot(file);
      files.push(file);
      if (page.errors().length) throw new Error(`${scene.name}: page errors: ${page.errors().join("\n")}`);
    } finally {
      await page.close();
    }
  }
  return files;
}

(async () => {
  mkdirSync(OUT, { recursive: true });
  for (const theme of THEMES) {
    for (const f of await shoot(theme, 300)) console.log(f);
  }
  // A sidebar dragged narrow.
  for (const theme of THEMES.filter((t) => t === "dark" || t === "light-modern")) {
    for (const width of [220, 260]) for (const f of await shoot(theme, width)) console.log(f);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
