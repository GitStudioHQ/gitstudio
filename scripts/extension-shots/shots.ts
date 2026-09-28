// The GitStudio extension's README screenshots, from real VS Code
// (apps/extension/SHOTS.md says what each one shows and how to retake it).
//
//   (cd apps/extension && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/gs-vsix/)
//   npx tsx scripts/extension-shots/shots.ts --vsix /tmp/gs-vsix [--only graph-panel,blame] [--themes dark,light]
//
// Each theme gets a fresh demo repository (make-demo-repo.sh) and a fresh,
// isolated VS Code (vscode.ts): launched in the background, never focused,
// quit and its profile deleted at the end. Every capture is checked by DOM
// before it is kept — what it must show, and that nothing personal is on
// screen — then optimised with oxipng.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp, Workbench, launchVsCode, sleep, jsLiteral, type Rect } from "./vscode";
import { REST, changesView, contentBottom, editorLine, maximizePanel, onlyPane, openFile, openGraph, reset, rowBySubject, scmSettled, setBlame, showSidebar, sidebarClip } from "./ui";

const REPO = resolve(__dirname, "../..");

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(`--${name}`);

const THEMES = { dark: "Default Dark Modern", light: "Default Light Modern" } as const;
type ThemeKey = keyof typeof THEMES;

/** The window every shot is taken in (CSS px; the PNGs are 2x). */
const WIN = { w: 1440, h: 900 };
/** The side bar's width in the shots that show it. */
const SIDEBAR = 392;

interface Scene {
  name: string;
  themes: ThemeKey[];
  /** Sets the screen up; returns the part to keep (default: the whole window). */
  run(wb: Workbench): Promise<Rect | void>;
  /** Text that must be on screen for the capture to be right. */
  expect: string[];
}

const SCENES: Scene[] = [
  {
    name: "graph-panel",
    themes: ["dark", "light"],
    expect: ["Commit Graph", "Uncommitted changes", "hotfix/cache-errors", "feature/search-filters", "feature/dark-mode", "release/1.0.x", "v1.0.0", "v1.1.0-beta.1", "origin/main", "Merge branch 'release/1.0.x'"],
    async run(wb) {
      await showSidebar(wb, false);
      const g = await openGraph(wb);
      await sleep(600);
      await g.leave(REST);
    },
  },
  {
    name: "graph-multi-select",
    themes: ["dark"],
    expect: ["3 commits selected", "Squash 3 Commits", "Cherry-Pick 3 Commits", "Drop 3 Commits"],
    async run(wb) {
      await showSidebar(wb, false);
      const g = await openGraph(wb);
      await g.click(rowBySubject("feat(build): write sitemap.xml next to the pages"));
      await sleep(400);
      await g.click(rowBySubject("feat(config): turn the sitemap off with sitemap: false"), { modifiers: 4 });
      await sleep(300);
      await g.click(rowBySubject("feat: sitemap.xml"), { modifiers: 4 });
      await g.waitFor(`H('3 commits selected')`, 10_000, "the three commits' pane");
      await sleep(700);
      await g.leave(REST);
    },
  },
  {
    name: "commits-rail",
    themes: ["dark"],
    expect: ["Uncommitted changes", "hotfix/cache-errors", "feature/search-filters", "Search commits", "v1.1.0-beta.1"],
    async run(wb) {
      await wb.setSidebarWidth(SIDEBAR);
      await onlyPane(wb, "Commits");
      const rail = await wb.webview(`D.querySelector('gitstudio-commit-rail') && Q('.row').length > 8`);
      await sleep(800);
      await rail.leave(REST);
      return sidebarClip(wb);
    },
  },
  {
    name: "changes-view",
    themes: ["dark"],
    expect: ["README.md", "sitemap.test.ts", "cli.ts", "sitemap.ts", "deploying.md", "WIP: retry cache writes with backoff", "cache.ts", "retry.ts", "spike: Markdown tables", "Commit 2", "Push 2", "Pull 1"],
    async run(wb) {
      await wb.setSidebarWidth(SIDEBAR);
      await onlyPane(wb, "Changes");
      const ch = await changesView(wb);
      const stash = `Q('.stash-row').find((r) => r.textContent.includes('WIP: retry cache writes'))`;
      if ((await ch.eval<string>(`${stash}.getAttribute('aria-expanded')`)) !== "true") {
        await ch.click(`${stash}.querySelector('.twisty')`);
      }
      await ch.waitFor(`Q('.stash-file').length >= 2`, 10_000, "the stash's files");
      await sleep(500);
      await ch.leave(REST);
      return sidebarClip(wb, await contentBottom(ch, `Q('.row, .group-header, .stash-row')`));
    },
  },
  {
    name: "branch-dialog",
    themes: ["dark"],
    expect: ["Fetch", "New Branch", "Checkout Tag or Revision", "feature/search-filters", "release/1.0.x", "hotfix/cache-errors", "v1.1.0-beta.1"],
    async run(wb) {
      await wb.setSidebarWidth(SIDEBAR);
      await onlyPane(wb, "Changes");
      const ch = await changesView(wb);
      await ch.click(`Q1('.branch')`);
      await ch.waitFor(`Q('.bm-branch').length >= 5`, 10_000, "the branch menu");
      await sleep(600);
      await ch.leave(REST);
      await sleep(300);
      // (.branch-menu lays out no box of its own: its list's does)
      return sidebarClip(wb, await contentBottom(ch, `Q('.bm-list, .bm-search')`, 18));
    },
  },
  {
    name: "worktrees-view",
    themes: ["dark"],
    expect: ["lumen", "lumen-hotfix", "hotfix/cache-errors", "CHANGELOG.md", "fix(cache): only a missing entry counts", "sitemap.ts", "feat(build): write sitemap.xml next to the pages"],
    async run(wb) {
      await wb.setSidebarWidth(SIDEBAR);
      await onlyPane(wb, "Worktrees");
      const wt = await wb.webview(`D.querySelector('.wt-view') && H('lumen-hotfix')`);
      for (const name of ["lumen", "lumen-hotfix"]) {
        const row = `Q('.wt-row').find((r) => (r.querySelector('.wt-name')?.textContent || '').trim() === ${jsLiteral(name)})`;
        if ((await wt.eval<string | null>(`${row}.getAttribute('aria-expanded')`)) !== "true") await wt.click(`${row}.querySelector('.wt-name')`);
        await sleep(1200);
      }
      await wt.waitFor(`H('CHANGELOG.md') && H('deploying.md')`, 15_000, "the worktrees' files");
      // The hotfix's commit to push, opened to its files.
      const commit = `Q('.cr-commit').find((r) => r.textContent.includes('only a missing entry'))`;
      if (await wt.eval<boolean>(`!!${commit} && !H('+2')`)) {
        await wt.click(commit);
        await sleep(1200);
      }
      await wt.leave(REST);
      return sidebarClip(wb, await contentBottom(wt, `Q('.wt-item')`));
    },
  },
  {
    name: "interactive-rebase",
    themes: ["dark"],
    expect: ["Interactive Rebase", "Start Rebase", "Squash", "Reword", "Edit", "feat(sitemap): write sitemap.xml", "Folds down into", "6 → 5 commits"],
    async run(wb) {
      await onlyPane(wb, "Changes");
      await wb.command("GitStudio: Start Interactive Rebase…");
      const ch = await changesView(wb);
      await ch.waitFor(`H('Rebase onto which commit')`, 10_000, "the rebase picker");
      await wb.type("HEAD~6");
      await sleep(400);
      await wb.key("Enter", "Enter", 13);
      const rb = await wb.webview(`D.body && H('Start Rebase')`, 20_000);
      await showSidebar(wb, false);
      await sleep(800);
      const subject = (s: string) => `[...D.querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === ${jsLiteral(s)})[0]`;
      const setAction = async (s: string, key: string, code: string, keyCode: number) => {
        await rb.click(subject(s));
        await sleep(250);
        await wb.key(key, code, keyCode);
        await sleep(400);
      };
      await setAction("feat(build): write sitemap.xml next to the pages", "s", "KeyS", 83);
      await setAction("feat: sitemap.xml", "r", "KeyR", 82);
      // The new message, typed where Reword put it.
      // (a triple click selects the line: CDP's Cmd+A is no editing command)
      const box = `[...D.querySelectorAll('textarea')].find((t) => t.getBoundingClientRect().height > 0)`;
      await rb.click(box, { dx: 40, dy: 12, count: 3 });
      await sleep(150);
      await wb.typeKeys("feat(sitemap): write sitemap.xml");
      await rb.waitFor(`${box}.value === 'feat(sitemap): write sitemap.xml'`, 5_000, "the new message");
      await sleep(300);
      await setAction("fix(build): build pages in a stable order", "e", "KeyE", 69);
      await rb.click(subject("feat(build): write sitemap.xml next to the pages"));
      await sleep(500);
      await rb.leave(REST);
    },
  },
  {
    name: "blame",
    themes: ["dark"],
    expect: ["Jonas Weber", "Leo Okafor", "Priya Raman", "Maya Chen", "fix(cache): cached pages keep their titles"],
    async run(wb) {
      await showSidebar(wb, false);
      await openFile(wb, "src/build.ts");
      await setBlame(wb, true);
      const l = await editorLine(wb, "const title = /<h1>");
      await wb.click(l.x + l.w - 20, l.y + l.h / 2);
      await sleep(1200);
      await wb.move(REST.x, REST.y);
    },
  },
  {
    name: "line-history",
    themes: ["dark"],
    expect: ["Line History", "build.ts", "fix(cache): key entries by path and content", "fix(cache): cached pages keep their titles", "feat(build): skip pages whose source did not change"],
    async run(wb) {
      await wb.setSidebarWidth(SIDEBAR);
      await onlyPane(wb, "Changes");
      await openFile(wb, "src/build.ts");
      // Annotations off (the blame shot leaves them on, and a click on one opens its commit).
      await setBlame(wb, false);
      const l = await editorLine(wb, "const k = cache.key(");
      await wb.click(l.x + 30, l.y + l.h / 2);
      await sleep(200);
      await wb.key("Home", "Home", 36);
      for (let i = 0; i < 4; i++) {
        await wb.key("ArrowDown", "ArrowDown", 40, 8);
        await sleep(60);
      }
      await wb.key("End", "End", 35, 8);
      await sleep(300);
      // GitStudio's chord: Cmd+Alt+G, then H.
      await wb.key("g", "KeyG", 71, 4 | 1);
      await sleep(200);
      await wb.key("h", "KeyH", 72);
      const ch = await changesView(wb);
      await ch.waitFor(`H('Line History')`, 15_000, "the line history");
      await sleep(900);
      await wb.move(REST.x, REST.y);
    },
  },
  {
    name: "diff-ticks",
    themes: ["dark"],
    expect: ["Diff: sitemap.ts", "sitemap.ts (HEAD)", "sitemap.ts (Working Tree)", "Commit 3"],
    async run(wb) {
      await wb.setSidebarWidth(SIDEBAR);
      await onlyPane(wb, "Changes");
      await openFile(wb, "src/sitemap.ts");
      await wb.clickAction(".editor-actions", "Stage Changes with Ticks");
      const d = await wb.webview(`Q('.jb-stage-tick').length >= 2`, 20_000);
      await wb.command("View: Close Other Editors in Group");
      await sleep(1200);
      await d.click(`Q('.jb-stage-tick')[0]`);
      const ch = await changesView(wb);
      await ch.waitFor(`Q('.group--staged .row.is-file').some((r) => r.dataset.path === 'src/sitemap.ts')`, 10_000, "sitemap.ts partly staged");
      await sleep(600);
      await scmSettled(wb);
      await d.leave(REST);
    },
  },
  {
    name: "changes-checkboxes",
    themes: ["dark"],
    expect: ["sitemap.ts", "const escape", "const urls", "Commit 3"],
    async run(wb) {
      await wb.setSidebarWidth(SIDEBAR);
      await onlyPane(wb, "Changes");
      const ch = await changesView(wb);
      await ch.click(`Q1('#model-toggle')`);
      await ch.waitFor(`Q('.hunk-twisty').length > 0`, 10_000, "the checkbox model");
      await sleep(500);
      await ch.click(`Q('.row.is-file').find((r) => r.dataset.path === 'src/sitemap.ts').querySelector('.hunk-twisty')`);
      await ch.waitFor(`H('const urls') && Q('.hunk-row').length >= 2`, 10_000, "sitemap.ts's changes");
      await sleep(300);
      // One of sitemap.ts's two changes ticked (diff-ticks, taken before
      // this, already did; alone, this scene does it with the tick itself).
      if (!(await ch.eval<boolean>(`Q('.hunk-row')[0].getAttribute('aria-checked') === 'true'`))) {
        await ch.click(`Q('.hunk-row')[0].querySelector('.ck')`);
        await ch.waitFor(`Q('.hunk-row')[0] && Q('.hunk-row')[0].getAttribute('aria-checked') === 'true' && !Q('.hunk-row')[0].classList.contains('is-busy')`, 10_000, "the first change ticked");
        await sleep(500);
      }
      await scmSettled(wb);
      await ch.leave(REST);
      return sidebarClip(wb, await contentBottom(ch, `Q('.row, .group-header, .stash-row, .hunk-row')`));
    },
  },
  {
    name: "merge-editor",
    themes: ["dark"],
    expect: ["Sample: authorizeRequest.ts", "Accept Yours", "Accept Theirs", "Apply", "Conflict"],
    async run(wb) {
      await showSidebar(wb, false);
      await wb.command("GitStudio: Open Sample Merge");
      await wb.webview(`H('Accept Theirs') && D.querySelector('.monaco-editor')`, 20_000);
      await sleep(2500);
      await wb.move(REST.x, REST.y);
    },
  },
];

// ── main ────────────────────────────────────────────────────────────────────

async function session(theme: ThemeKey, scenes: Scene[], o: { vsix: string; out: string; port: number; demo: string; keep: boolean }): Promise<void> {
  execFileSync("bash", [join(REPO, "scripts/extension-shots/make-demo-repo.sh"), o.demo], { stdio: "pipe" });
  const vs = launchVsCode({
    vsixDir: o.vsix,
    folder: join(o.demo, "lumen"),
    profile: join(tmpdir(), `gs-shots-profile-${o.port}`),
    port: o.port,
    width: WIN.w,
    height: WIN.h,
    theme: THEMES[theme],
    keepProfile: o.keep,
  });
  let c: Cdp | undefined;
  try {
    c = await Cdp.connect(o.port);
    const wb = await Workbench.attach(c);
    const size = await wb.size();
    if (size.w !== WIN.w || size.h !== WIN.h) throw new Error(`the window is ${size.w}x${size.h}, not ${WIN.w}x${WIN.h}`);
    await sleep(4000); // the extension activates (onStartupFinished) and may open its welcome
    try {
      await reset(wb);
      await changesView(wb);
    } catch (e) {
      writeFileSync(join(o.out, `.debug-${theme}-start.png`), await wb.screenshot().catch(() => Buffer.alloc(0)));
      throw e;
    }
    await sleep(1500);
    for (const s of scenes) {
      const file = join(o.out, theme === "dark" ? `${s.name}.png` : `${s.name}-light.png`);
      process.stdout.write(`${theme} ${s.name} … `);
      try {
        await reset(wb);
        const clip = (await s.run(wb)) ?? undefined;
        await sleep(400);
        await wb.verify(s.name, s.expect);
        const png = await wb.screenshot(clip);
        // Nothing changed underneath the check.
        await wb.verify(s.name, s.expect);
        writeFileSync(file, png);
        execFileSync("oxipng", ["-o", "4", "--strip", "safe", "-q", file]);
        console.log("ok");
      } catch (e) {
        const dbg = join(o.out, `.debug-${theme}-${s.name}.png`);
        writeFileSync(dbg, await wb.screenshot().catch(() => Buffer.alloc(0)));
        console.log(`FAILED: ${e instanceof Error ? e.message : e} (screen: ${dbg})`);
        process.exitCode = 1;
      }
    }
    await maximizePanel(wb, false).catch(() => undefined);
  } finally {
    c?.close();
    vs.stop();
  }
}

async function main(): Promise<void> {
  const vsix = flag("vsix");
  if (!vsix) {
    console.error("usage: shots.ts --vsix <dir with the .vsix> [--out apps/extension/media/shots] [--only a,b] [--themes dark,light] [--port 9891] [--demo /tmp/gs-demo] [--keep-profile]");
    process.exit(2);
  }
  if (!existsSync(resolve(vsix))) throw new Error(`no ${vsix}`);
  const out = resolve(flag("out") ?? join(REPO, "apps/extension/media/shots"));
  mkdirSync(out, { recursive: true });
  const only = (flag("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const themes = (flag("themes") ?? "dark,light").split(",").map((s) => s.trim()) as ThemeKey[];
  for (const theme of themes) {
    const scenes = SCENES.filter((s) => s.themes.includes(theme) && (only.length === 0 || only.includes(s.name)));
    if (!scenes.length) continue;
    await session(theme, scenes, {
      vsix: resolve(vsix),
      out,
      port: Number(flag("port") ?? 9891),
      demo: flag("demo") ?? "/tmp/gs-demo",
      keep: has("keep-profile"),
    });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
