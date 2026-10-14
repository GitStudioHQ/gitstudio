// Screenshots for the marketing site (gitstudio.dev), from real VS Code:
// GitStudio's extension and Merge Studio, dark (Default Dark Modern), 2x.
// The same method as shots.ts (apps/extension/SHOTS.md): an isolated VS Code,
// launched in the background and never focused, quit and its profile deleted
// at the end; every capture checked by DOM before and after it is taken.
//
//   (cd apps/extension && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/gs-vsix/)
//   (cd apps/merge-studio && npm run package && npx @vscode/vsce package --no-dependencies -o /tmp/ms-vsix/)
//   npx tsx scripts/extension-shots/site-shots.ts --gs-vsix /tmp/gs-vsix --ms-vsix /tmp/ms-vsix --out <dir> [--only a,b]
//
// Windows are 1280x820 CSS px (2560x1640 PNGs); the two side-bar shots are
// 340x620 CSS crops of the side bar; the dashboard is cropped to its tab.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cdp, Workbench, jsLiteral, launchVsCode, sleep, type Rect, type Webview } from "./vscode";
import { REST, changesView, editorLine, onlyPane, openFile, openGraph, reset, rowBySubject, setBlame, showSidebar } from "./ui";

const REPO = resolve(__dirname, "../..");
const WIN = { w: 1280, h: 820 };
const SIDE = { w: 340, h: 620 };
/** Never on screen in a site shot (besides vscode.ts's FORBIDDEN). */
const BAD = /Screenshot pending|Accept Left|Changes from server|Your version|Get Started with|Welcome/;

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Scene {
  name: string;
  expect: string[];
  run(wb: Workbench): Promise<Rect | void>;
}

/** The side bar alone, from the top of its view's webview, SIDE.w x SIDE.h. */
async function sideCrop(wb: Workbench, view: Webview): Promise<Rect> {
  const sb = await wb.rect(".part.sidebar");
  const f = await view.frame();
  if (!sb) throw new Error("no side bar");
  return { x: Math.round(sb.x), y: Math.round(f.y), w: SIDE.w, h: SIDE.h };
}

async function typeMessage(wb: Workbench, ch: Webview, msg: string): Promise<void> {
  const box = `Q('textarea').find((t) => t.getBoundingClientRect().height > 0)`;
  await ch.click(box, { dx: 40, dy: 12 });
  await sleep(200);
  await wb.typeKeys(msg);
  await ch.waitFor(`${box}.value === ${jsLiteral(msg)}`, 5_000, "the commit message");
}

const GS_SCENES: Scene[] = [
  {
    name: "ext-graph-panel",
    expect: ["Commit Graph", "Uncommitted changes", "hotfix/cache-errors", "feature/search-filters", "feature/dark-mode", "release/1.0.x", "v1.0.0", "v1.1.0-beta.1", "origin/main", "Merge branch 'release/1.0.x'"],
    async run(wb) {
      await showSidebar(wb, false);
      const g = await openGraph(wb);
      await sleep(800);
      await g.leave(REST);
    },
  },
  {
    name: "changes-view",
    expect: ["README.md", "sitemap.test.ts", "cli.ts", "sitemap.ts", "deploying.md", "Commit 2", "Push 2", "Pull 1", "Staged", "Unstaged"],
    async run(wb) {
      await wb.setSidebarWidth(SIDE.w);
      await onlyPane(wb, "Changes");
      const ch = await changesView(wb);
      await typeMessage(wb, ch, "feat(sitemap): escape URLs");
      await ch.eval(`D.activeElement && D.activeElement.blur()`);
      await sleep(500);
      await ch.leave(REST);
      return sideCrop(wb, ch);
    },
  },
  {
    name: "branch-dialog",
    expect: ["Fetch", "New Branch", "Checkout Tag or Revision", "feature/search-filters", "release/1.0.x", "hotfix/cache-errors", "v1.1.0-beta.1", "v1.0.0"],
    async run(wb) {
      await wb.setSidebarWidth(SIDE.w);
      await onlyPane(wb, "Changes");
      const ch = await changesView(wb);
      await ch.click(`Q1('.branch')`);
      await ch.waitFor(`Q('.bm-branch').length >= 5`, 10_000, "the branch menu");
      await sleep(400);
      // Remote folded, so the menu ends inside the crop (Local, then Tags).
      const remote = `Q('.bm-sep').find((h) => /^Remote/.test(h.getAttribute('aria-label') || ''))`;
      await ch.click(remote);
      await ch.waitFor(`${remote}.getAttribute('aria-expanded') === 'false'`, 5_000, "Remote folded");
      await sleep(600);
      await ch.leave(REST);
      await sleep(300);
      return sideCrop(wb, ch);
    },
  },
  {
    name: "ext-blame",
    expect: ["Jonas Weber", "Leo Okafor", "Priya Raman", "Maya Chen", "fix(cache): cached pages keep their titles"],
    async run(wb) {
      await showSidebar(wb, false);
      await openFile(wb, "src/build.ts");
      await setBlame(wb, true);
      // Line 21 by Go to Line (a click there can land on its annotation, which opens the commit).
      await editorLine(wb, "const title = /<h1>");
      await wb.key("g", "KeyG", 71, 2);
      await sleep(400);
      await wb.type("21");
      await sleep(300);
      await wb.key("Enter", "Enter", 13);
      await sleep(300);
      await wb.key("End", "End", 35);
      await sleep(1500);
      await wb.move(REST.x, REST.y);
    },
  },
  {
    name: "ext-line-history",
    expect: ["Line History", "build.ts", "fix(cache): key entries by path and content", "fix(cache): cached pages keep their titles", "feat(build): skip pages whose source did not change"],
    async run(wb) {
      await wb.setSidebarWidth(SIDE.w);
      await onlyPane(wb, "Changes");
      await openFile(wb, "src/build.ts");
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
    // 1.19.0: a commit's Files changed as a folder tree (#81).
    name: "ext-files-tree",
    expect: ["Merge branch 'feature/offline-cache'", "Files changed", "docs", "src", "test", "caching.md", "cache.ts", "build.ts", "cache.test.ts"],
    async run(wb) {
      await showSidebar(wb, false);
      const g = await openGraph(wb);
      const row = rowBySubject("Merge branch 'feature/offline-cache'");
      await g.eval(`${row}.scrollIntoView({ block: 'center' })`);
      await sleep(600);
      await g.click(`${row}.querySelector('.subject')`);
      await g.waitFor(`Q1('.files-layout') && H('caching.md')`, 15_000, "the commit's files");
      await sleep(500);
      if ((await g.eval<string>(`Q1('.files-layout').getAttribute('aria-label')`)) === "View as Tree") {
        await g.click(`Q1('.files-layout')`);
      }
      await g.waitFor(`Q1('.files-layout').getAttribute('aria-label') === 'View as List'`, 10_000, "the tree layout");
      await sleep(900);
      await g.leave(REST);
    },
  },
];

const MS_SCENES: Scene[] = [
  {
    name: "ms-dashboard",
    expect: ["Continue Rebase", "Accept Yours", "Accept Theirs", "f.txt", "test", "master"],
    async run(wb) {
      await showSidebar(wb, false).catch(() => undefined);
      await wb.command("Merge Studio: Resolve Conflicts");
      const d = await wb.webview(`H('Continue Rebase') && H('Accept Theirs')`, 30_000);
      await wb.command("View: Close Other Editors in Group").catch(() => undefined);
      await sleep(1500);
      await d.leave(REST);
      const ed = await wb.rect(".part.editor");
      const f = await d.frame();
      const bottom = await d.eval<number>(
        `Math.max(...[...D.body.querySelectorAll('button, a, h1, h2, li, [role=row], .row, footer, p, span')].filter((e) => e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().height < innerHeight * 0.8).map((e) => e.getBoundingClientRect().bottom))`,
      );
      if (!ed) throw new Error("no editor part");
      return { x: Math.round(ed.x), y: Math.round(ed.y), w: Math.round(ed.w), h: Math.round(Math.min(ed.y + ed.h, f.y + bottom + 28) - ed.y) };
    },
  },
  {
    name: "ms-merge-editor",
    expect: ["Sample: authorizeRequest.ts", "Accept Yours", "Accept Theirs", "Apply", "Conflict"],
    async run(wb) {
      await showSidebar(wb, false).catch(() => undefined);
      await wb.command("Merge Studio: Open Sample Merge");
      const m = await wb.webview(`H('Accept Theirs') && D.querySelector('.monaco-editor') && Q('.jb-change-actions').length > 0`, 30_000);
      await sleep(2500);
      // One conflict half taken (Yours in, Theirs still open), one change settled.
      const press = (sel: string) =>
        m.eval<boolean>(`(() => { const b = D.querySelector(${jsLiteral(sel)}); if (!b) return false; b.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, button: 0 })); return true; })()`);
      if (!(await press('.jb-gutter-a .jb-change-actions[data-category="conflict"] .jb-btn-accept'))) throw new Error("no conflict to half take");
      await sleep(800);
      if (!(await press('.jb-gutter-b .jb-change-actions[data-category="theirs-only"] .jb-btn-accept')))
        await press('.jb-gutter-a .jb-change-actions[data-category="yours-only"] .jb-btn-accept');
      await sleep(1500);
      await m.leave(REST);
    },
  },
  {
    name: "ms-diff",
    expect: [],
    async run(wb) {
      await showSidebar(wb, false).catch(() => undefined);
      await wb.command("Merge Studio: Open Sample Diff");
      const m = await wb.webview(`D.querySelectorAll('.monaco-editor').length >= 2`, 30_000);
      await sleep(2500);
      await m.leave(REST);
    },
  },
];

async function check(wb: Workbench, name: string, expect: string[]): Promise<void> {
  await wb.verify(name, expect);
  const text = await wb.allText();
  const bad = BAD.exec(text);
  if (bad) throw new Error(`${name}: "${bad[0]}" on screen`);
  const toasts = await wb.eval<number>(`[...document.querySelectorAll('.notification-toast')].filter((t) => t.getBoundingClientRect().height > 0).length`);
  if (toasts) throw new Error(`${name}: ${toasts} notification(s) on screen`);
}

async function session(label: string, vsixDir: string, folder: string, port: number, scenes: Scene[], out: string, win = WIN): Promise<void> {
  const vs = launchVsCode({
    vsixDir,
    folder,
    profile: join(tmpdir(), `gs-site-shots-${port}`),
    port,
    width: win.w,
    height: win.h,
    theme: "Default Dark Modern",
  });
  let c: Cdp | undefined;
  try {
    c = await Cdp.connect(port);
    const wb = await Workbench.attach(c);
    const size = await wb.size();
    if (size.w !== win.w || size.h !== win.h) throw new Error(`the window is ${size.w}x${size.h}, not ${win.w}x${win.h}`);
    await sleep(6000);
    for (const s of scenes) {
      const file = join(out, `${s.name}.png`);
      process.stdout.write(`${label} ${s.name} … `);
      try {
        await reset(wb).catch(async () => {
          await wb.command("View: Close All Editors");
          await wb.command("Notifications: Clear All Notifications");
        });
        const clip = (await s.run(wb)) ?? undefined;
        await wb.move(REST.x, REST.y);
        await sleep(600);
        await check(wb, s.name, s.expect);
        const png = await wb.screenshot(clip);
        await check(wb, s.name, s.expect);
        writeFileSync(file, png);
        execFileSync("oxipng", ["-o", "4", "--strip", "safe", "-q", file]);
        console.log("ok");
      } catch (e) {
        const dbg = join(out, `.debug-${s.name}.png`);
        writeFileSync(dbg, await wb.screenshot().catch(() => Buffer.alloc(0)));
        console.log(`FAILED: ${e instanceof Error ? e.message : e} (screen: ${dbg})`);
        process.exitCode = 1;
      }
    }
  } finally {
    c?.close();
    vs.stop();
  }
}

async function main(): Promise<void> {
  const gsVsix = resolve(flag("gs-vsix") ?? "/tmp/gs-vsix");
  const msVsix = resolve(flag("ms-vsix") ?? "/tmp/ms-vsix");
  const out = resolve(flag("out") ?? "/tmp/site-shots");
  mkdirSync(out, { recursive: true });
  const only = (flag("only") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const pick = (ss: Scene[]) => ss.filter((s) => !only.length || only.includes(s.name));

  const port = Number(flag("port") ?? 9893);
  // The side-bar crops come from a taller window, so the 620 px under the
  // Changes view's top are all its own (no collapsed pane headers in frame).
  const SIDE_NAMES = ["changes-view", "branch-dialog"];
  const gsWin = pick(GS_SCENES.filter((s) => !SIDE_NAMES.includes(s.name)));
  const gsSide = pick(GS_SCENES.filter((s) => SIDE_NAMES.includes(s.name)));
  for (const [label, scenes, win] of [["gitstudio", gsWin, WIN], ["gitstudio-side", gsSide, { w: WIN.w, h: 900 }]] as const) {
    if (!scenes.length) continue;
    if (!existsSync(gsVsix)) throw new Error(`no ${gsVsix}`);
    execFileSync("bash", [join(REPO, "scripts/extension-shots/make-demo-repo.sh"), "/tmp/gs-demo"], { stdio: "pipe" });
    await session(label, gsVsix, "/tmp/gs-demo/lumen", port, [...scenes], out, win);
  }
  const msSample = pick(MS_SCENES.filter((s) => s.name !== "ms-dashboard"));
  if (msSample.length) {
    execFileSync("bash", [join(REPO, "scripts/extension-shots/make-demo-repo.sh"), "/tmp/gs-demo"], { stdio: "pipe" });
    await session("merge-studio", msVsix, "/tmp/gs-demo/lumen", port + 1, msSample, out);
  }
  const msDash = pick(MS_SCENES.filter((s) => s.name === "ms-dashboard"));
  if (msDash.length) {
    if (!existsSync(msVsix)) throw new Error(`no ${msVsix}`);
    // issue12-exact, stopped mid-rebase, from the merge matrix (no network).
    rmSync("/tmp/ms-matrix", { recursive: true, force: true });
    rmSync("/tmp/ms-demo", { recursive: true, force: true });
    execFileSync("bash", [join(REPO, "scripts/merge-e2e/fixtures.sh"), "/tmp/ms-matrix", "--ops", "issue12-exact", "--styles", "diff3"], { stdio: "pipe" });
    mkdirSync("/tmp/ms-demo", { recursive: true });
    execFileSync("cp", ["-R", "/tmp/ms-matrix/issue12-exact/diff3", "/tmp/ms-demo/playground"]);
    await session("merge-studio-dash", msVsix, "/tmp/ms-demo/playground", port + 1, msDash, out);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
