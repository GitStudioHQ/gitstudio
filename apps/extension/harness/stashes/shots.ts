// Screenshots of the Changes view's Stashes group — per theme, in the real
// page commitView.ts serves, in a windowless Chrome (test/changesPage.ts).
//
//   npx tsx apps/extension/harness/stashes/shots.ts [outDir]
//
// Writes to <repo>/out/stashes by default. Nothing on screen is typed here:
// a scratch repository gets real stashes (every kind of file, and one too big
// to carry — a dependency folder stashed with -u), the rows are built from
// it the way the host builds them (StashProvider.files + stashRows), and the
// questions are the ones the real doors ask, recorded by a dialog host that
// backs out.

import Module from "node:module";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
const STUB = fileURLToPath(new URL("../../test/vscodeStub.cjs", import.meta.url));
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? STUB : resolve.call(this, request, ...rest);
};

/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { registerDialogHost } = require("../../src/ui/dialogs") as typeof import("../../src/ui/dialogs");
const stashesView = require("../../src/views/stashesView") as typeof import("../../src/views/stashesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
const { stashRows } = require("../../src/changes/stashRows") as typeof import("../../src/changes/stashRows");
const { ChangesPage } = require("../../test/changesPage") as typeof import("../../test/changesPage");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../../src/ui/dialogs";
import type { VsCodeTheme } from "../../test/changesPage";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/stashes/", import.meta.url));

const cfg = join(mkdtempSync(join(tmpdir(), "gs-shots-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

let captured: DialogSpec[] = [];
registerDialogHost({
  show: async (spec) => {
    captured.push(spec);
    return undefined; // back out: nothing is changed
  },
});

/** A repository with four stashes: the second holds every kind of file, the oldest 260 of them. */
async function realStashes(): Promise<{
  rows: unknown[];
  big: { sha: string; files: unknown[] };
  drop: DialogSpec;
  staging: DialogSpec | undefined;
  dir: string;
}> {
  const dir = mkdtempSync(join(tmpdir(), "gs-shots-stash-"));
  const git = (...args: string[]): string =>
    execFileSync("git", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const write = (f: string, s: string | Buffer): void => {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), s);
  };
  git("init", "-q", "-b", "main");
  git("config", "user.email", "dev@example.com");
  git("config", "user.name", "Dev");
  for (const f of ["src/auth/login.ts", "src/auth/session.ts", "src/app.ts", "src/routes.ts", "docs/guide.md", "assets/logo.png", "README.md"]) {
    write(f, f.endsWith(".png") ? Buffer.from([0, 1, 2, 3]) : `${f}\nline 2\nline 3\n`);
  }
  git("add", ".");
  git("commit", "-q", "-m", "Initial layout");
  // The oldest: an accident — a dependency folder stashed with -u.
  for (let i = 0; i < 260; i++) write(`vendor/lib/part-${String(i).padStart(3, "0")}.js`, `module.exports = ${i};\n`);
  git("stash", "push", "-q", "-u", "-m", "Try the new bundler");
  // Then: a message typed with it.
  write("README.md", "README.md\nnotes for the release\n");
  git("stash", "push", "-q", "-m", "Release notes draft");
  // The middle one: every kind of file, staged and not, new and gone.
  write("src/auth/login.ts", "src/auth/login.ts\nredirect after sign-in\n");
  git("add", "src/auth/login.ts");
  write("src/auth/login.ts", "src/auth/login.ts\nredirect after sign-in\nand remember the page\n");
  write("src/auth/session.ts", "src/auth/session.ts\nrefresh the token\n");
  write("src/auth/callback.ts", "export const callback = 1;\n");
  git("add", "src/auth/callback.ts");
  write("src/auth/oauth.test.ts", "test('oauth')\n");
  git("rm", "-q", "src/routes.ts");
  git("mv", "docs/guide.md", "docs/sign-in.md");
  write("assets/logo.png", Buffer.from([0, 9, 9, 9]));
  git("stash", "push", "-q", "-u", "-m", "Fix login redirect");
  // The newest: no message, so git wrote one.
  write("src/app.ts", "src/app.ts\nwork in progress\n");
  git("stash", "push", "-q");
  // And the working tree has edits of its own.
  write("src/app.ts", "src/app.ts\ntoday's edit\n");
  write("src/routes.ts", "src/routes.ts\nline 2\nchanged\n");

  const ctx = new GitContext({ root: dir });
  try {
    const list = await ctx.stashes.list();
    // Made hours apart, as a real list is.
    const dated = list.map((e, i) => ({ ...e, time: e.time - 2 * 3600 * (i + 1) }));
    const files = await Promise.all(list.map((e) => ctx.stashes.files(e.sha)));
    const rows = stashRows(dated, files);
    const oldest = list[list.length - 1];
    const big = { sha: oldest.sha, files: files[files.length - 1] ?? [] };
    // The questions the real doors ask, backed out of.
    const entry = { ctx, root: dir };
    const repos = { getActive: () => entry, getAll: () => [entry], getUndoLedger: () => undefined } as never;
    captured = [];
    await stashesView.dropStash(repos, list[1].sha, () => {});
    const drop = captured[0];
    // Move a staged file over a staged change of the user's: the staging question.
    write("src/app.ts", "src/app.ts\nstaged today\n");
    git("add", "src/app.ts");
    captured = [];
    await stashesView.moveStashFiles(repos, list[1].sha, ["src/auth/login.ts"], () => {});
    const staging = captured[0];
    git("reset", "-q", "src/app.ts");
    return { rows, big, drop, staging, dir };
  } finally {
    ctx.dispose();
  }
}

function state(stashes: unknown[], over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "state",
    hasRepo: true,
    merge: [],
    staged: [],
    unstaged: [
      { path: "src/app.ts", status: "M" },
      { path: "src/routes.ts", status: "M" },
    ],
    stagedCount: 0,
    stagingModel: "split",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    unpushed: 0,
    canPublish: true,
    repoName: "web-app",
    repoCount: 1,
    signoffDefault: false,
    aiEnabled: false,
    layout: "list",
    busy: false,
    branches: { local: [{ name: "main", current: true, favorite: false }], remote: [], recent: [], tags: [] },
    stashes,
    ...over,
  };
}

async function shoot(theme: VsCodeTheme, data: Awaited<ReturnType<typeof realStashes>>): Promise<string[]> {
  const files: string[] = [];
  const middle = (data.rows[1] as { sha: string }).sha;
  const page = await ChangesPage.open(theme, { width: 300, height: 760, scale: 2 });
  const snap = async (name: string): Promise<void> => {
    const file = join(OUT, `stashes-${name}-${theme}.png`);
    await page.screenshot(file);
    files.push(file);
  };
  const openStash = async (sha: string): Promise<void> => {
    await page.eval(`document.querySelector('[data-tkey="stash:${sha}"]').click()`);
  };
  try {
    // 1. The group, one stash opened to all its files; the pointer on a file.
    await page.send(state(data.rows));
    await openStash(middle);
    const r = await page.eval<{ x: number; y: number }>(
      `(() => { const b = document.querySelector('#stashes .row.is-file[data-path="src/auth/session.ts"]').getBoundingClientRect(); return { x: b.left + 60, y: b.top + b.height / 2 }; })()`,
    );
    await page.mouseMove(r.x, r.y);
    await page.eval("new Promise((r) => setTimeout(r, 400))");
    await snap("open-list");
    await page.mouseMove(1, 1);
    await page.eval("new Promise((r) => setTimeout(r, 400))");
    // 2. The tree layout.
    await page.send(state(data.rows, { layout: "tree" }));
    await snap("open-tree");
    await page.send(state(data.rows, { layout: "list" }));
    // 3. Two files selected: the bar says where they are from and what it can do.
    await page.eval(`(() => {
      const rows = document.querySelectorAll('#stashes .row.is-file');
      rows[0].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }));
      rows[2].dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true, detail: 1 }));
    })()`);
    await snap("selected");
    await page.key("Escape");
    // 4. A stash's menu, from the keyboard.
    await page.eval(`document.querySelector('[data-tkey="stash:${middle}"]').focus()`);
    await page.key("F10", { with: ["shift"] });
    await snap("menu");
    await page.key("Escape");
    // 5. A clean working tree: the stashes under "Working tree clean".
    await page.send(state(data.rows, { unstaged: [] }));
    await snap("clean");
    // 5b. The narrowest sidebar: nothing overlaps, the words give way first.
    await page.resize(240, 760, 2);
    await snap("narrow");
    await page.resize(300, 760, 2);
    // 6. The questions the doors ask.
    await page.send(state(data.rows));
    await page.send({ type: "dialog", dialogId: "shot-1", spec: data.drop });
    await snap("drop");
    if (data.staging) {
      await page.send({ type: "dialog", dialogId: "shot-2", spec: data.staging });
      await snap("staging");
      await page.key("Escape");
    }
    // 7. A stash too big to carry: opened, its files being read…
    await page.send(state(data.rows, { unstaged: [] }));
    await page.eval(`document.querySelector('[data-tkey="stash:${middle}"]').click()`);
    await openStash(data.big.sha);
    await page.eval("window.scrollTo(0, document.body.scrollHeight)");
    await snap("big-reading");
    // 8. …and read: its first page, and the row that shows the next.
    await page.send({ type: "stashFilesRead", sha: data.big.sha, files: data.big.files });
    await page.eval("window.scrollTo(0, document.body.scrollHeight)");
    await snap("big-more");
  } finally {
    await page.close();
  }
  return files;
}

async function main(): Promise<void> {
  if (!ChangesPage.chrome()) {
    console.error("No windowless Chrome here (set GS_CHROME).");
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  const data = await realStashes();
  try {
    for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
      for (const f of await shoot(theme, data)) console.log(f);
    }
  } finally {
    rmSync(data.dir, { recursive: true, force: true });
  }
}

void main();
