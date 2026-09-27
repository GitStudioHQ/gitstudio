// Screenshots of the Changes view's branch menu ("Search for branches and
// actions") — its search, a branch's actions in the menu and beside it, the
// remotes by remote, a detached HEAD — and of the questions "Reset to
// 'origin/feature'…" asks (issue #32), per theme, in the real page
// commitView.ts serves, in a windowless Chrome (test/changesPage.ts).
//
//   npx tsx apps/extension/harness/branch-menu/shots.ts [outDir]
//
// Writes to <repo>/out/branch-menu by default. The dialogs' words are not
// typed here: a scratch repository is put in the state the picture shows,
// and the extension's real doors are run against it with a dialog host that
// records the question and backs out — so the picture is what the door says.

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
const { resetBranchTo, askOverLocalBranch } = require("../../src/views/branchReset") as typeof import("../../src/views/branchReset");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
const { ChangesPage, stateMessage } = require("../../test/changesPage") as typeof import("../../test/changesPage");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { DialogSpec } from "../../src/ui/dialogs";
import type { ChangesPage as Page, VsCodeTheme } from "../../test/changesPage";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/branch-menu/", import.meta.url));

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

const at =
  (cwd: string) =>
  (...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * The report's "messy branch": feature has seven commits of its own that
 * origin/feature doesn't, origin/feature has two it doesn't, and there are
 * uncommitted edits to three files.
 */
async function realQuestions(): Promise<{ confirm: DialogSpec; pick: DialogSpec }> {
  const base = mkdtempSync(join(tmpdir(), "gs-shots-"));
  try {
    const remote = join(base, "remote.git");
    execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
    const seed = join(base, "seed");
    execFileSync("git", ["clone", "-q", remote, seed], { stdio: "ignore" });
    const s = at(seed);
    s("config", "user.email", "dev@example.com");
    s("config", "user.name", "Dev");
    for (const f of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(seed, f), `${f}\n`);
    s("add", ".");
    s("commit", "-qm", "Initial layout");
    s("push", "-q", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/feature");
    s("checkout", "-q", "-b", "feature", "origin/feature");
    s("commit", "-q", "--allow-empty", "-m", "Review fixes from the team");
    s("commit", "-q", "--allow-empty", "-m", "Bump the API client");
    s("push", "-q", "origin", "feature");

    const dir = join(base, "work");
    execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
    const git = at(dir);
    git("config", "user.email", "dev@example.com");
    git("config", "user.name", "Dev");
    git("checkout", "-q", "-b", "feature", "--track", "refs/remotes/origin/main");
    git("branch", "-q", "--set-upstream-to", "refs/remotes/origin/feature", "feature");
    git("reset", "-q", "--hard", "refs/remotes/origin/main");
    for (const m of [
      "WIP: try the new cache",
      "Revert \"WIP: try the new cache\"",
      "Merge main into feature (conflicts)",
      "Fix the merge",
      "Fix the fix",
      "Temporary logging",
      "Rename everything to camelCase",
    ]) {
      git("commit", "-q", "--allow-empty", "-m", m);
    }
    for (const f of ["a.ts", "b.ts", "c.ts"]) writeFileSync(join(dir, f), `${f} edited\n`);

    const ctx = new GitContext({ root: dir });
    try {
      captured = [];
      await resetBranchTo(ctx, "refs/heads/feature", undefined, undefined);
      const confirm = captured.find((d) => d.kind === "confirm");
      if (!confirm) throw new Error("the reset door asked no question");
      captured = [];
      git("stash", "-q");
      git("checkout", "-q", "main");
      await askOverLocalBranch(ctx, "refs/remotes/origin/feature");
      const pick = captured.find((d) => d.kind === "pick");
      if (!pick) throw new Error("the checkout door asked no question");
      return { confirm, pick };
    } finally {
      ctx.dispose();
    }
  } finally {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

const STATE = stateMessage({
  local: [
    { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
    { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, ahead: 7, behind: 2, favorite: true },
    { name: "release/2.1", upstream: "origin/release/2.1", upstreamOnRemote: true },
    { name: "spike/cache" },
  ],
  recent: ["feature"],
  remote: ["origin/main", "origin/feature", "origin/release/2.1"],
  tags: ["v2.1.0", "v2.0.0"],
});

// The window as a sidebar shows it: long names, a gone upstream, a branch
// tracking a fork's remote, counts past 999, and remotes by the dozen.
const LONG = "feature/checkout-flow/billing-address-validation-for-international-customers-v2";
const SIDEBAR = stateMessage({
  local: [
    { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
    { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, ahead: 7, behind: 2, favorite: true },
    { name: "release/2.1", upstream: "origin/release/2.1", upstreamOnRemote: true },
    { name: "spike/cache" },
    { name: "merged-pr", upstream: "origin/merged-pr", gone: true },
    { name: LONG, upstream: "origin/" + LONG, upstreamOnRemote: true, ahead: 1204, behind: 37 },
    { name: "fix/login-redirect", upstream: "upstream/fix/login-redirect", upstreamOnRemote: true },
  ],
  recent: ["release/2.1"],
  remote: [
    "origin/main", "origin/feature", "origin/release/2.1", "origin/" + LONG,
    ...Array.from({ length: 55 }, (_, i) => `origin/topic/item-${String(i).padStart(2, "0")}`),
    "upstream/main", "upstream/fix/login-redirect", "upstream/release/2.0",
  ],
  tags: ["v2.1.0", "v2.0.0", "v1.9.3"],
});
(SIDEBAR.branches as Record<string, unknown>).remoteNames = ["origin", "upstream"];

/** The search window's own scenes, in a sidebar-sized view. */
async function shootWindow(theme: VsCodeTheme): Promise<string[]> {
  const files: string[] = [];
  const scene = async (name: string, width: number, height: number, run: (p: Page) => Promise<void>, state: unknown = SIDEBAR): Promise<void> => {
    const page = await ChangesPage.open(theme, { width, height, scale: 2 });
    try {
      await page.send(state);
      await page.send({ type: "openBranchMenu" });
      await page.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
      await page.eval(`new Promise(function (r) { setTimeout(r, 30); })`);
      await run(page);
      const file = join(OUT, `${name}-${theme}.png`);
      await page.screenshot(file);
      files.push(file);
      if (page.page.errors.length) throw new Error(`${name}: page errors: ${page.page.errors.join("\n")}`);
    } finally {
      await page.close();
    }
  };
  await scene("window", 320, 640, async () => {});
  // "fe": the branch, not Fetch; "rel21": scattered letters; "billing": a
  // long name cut in the middle around its match; "zzzq": the offers.
  await scene("search-fe", 320, 480, async (p) => { await p.type("fe"); });
  await scene("search-rel21", 320, 400, async (p) => { await p.type("rel21"); });
  await scene("search-billing", 300, 400, async (p) => { await p.type("billing"); });
  // Scattered letters in a long name: its start kept, the rest cut around them.
  await scene("search-fval", 300, 400, async (p) => { await p.type("fval"); });
  await scene("search-none", 320, 360, async (p) => { await p.type("zzzq"); });
  // A branch's actions: in the menu in a sidebar, beside it where there is room.
  await scene("actions-drilled", 320, 640, async (p) => { await p.type("feature"); await p.key("ArrowRight"); await p.key("ArrowDown"); });
  await scene("actions-beside", 900, 640, async (p) => { await p.type("feature"); await p.key("ArrowRight"); });
  await scene("actions-gone", 320, 640, async (p) => { await p.type("merged-pr"); await p.key("ArrowRight"); });
  // Remote branches by remote, the heading pinned as they scroll.
  await scene("remotes-pinned", 320, 520, async (p) => {
    await p.eval(`document.querySelector(".bm-list").scrollTop = 520`);
    await p.eval(`new Promise(function (r) { setTimeout(r, 30); })`);
  });
  // The star the row under the pointer offers.
  await scene("star-hover", 320, 520, async (p) => {
    const c = await p.eval<{ x: number; y: number }>(`(function () { var r = document.querySelector('.bm-branch[data-bname="spike/cache"]').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await p.mouseMove(c.x, c.y);
  });
  // A detached HEAD: no Pull or Push, and the line that says why.
  const branches = SIDEBAR.branches as { local: { name: string; current?: boolean }[] };
  // The branch you're on tracks nothing: no Pull, and why, when looked for.
  await scene("no-pull", 320, 360, async (p) => { await p.type("pull"); }, {
    ...SIDEBAR, upstream: undefined,
    branches: { ...branches, local: branches.local.map((b) => (b.name === "main" ? { name: "main", current: true, favorite: false } : b)) },
  });
  await scene("detached", 320, 480, async () => {}, {
    ...SIDEBAR, branch: "a1b2c3d", detached: true, upstream: undefined,
    branches: { ...branches, local: branches.local.map((b) => ({ ...b, current: false })) },
  });
  return files;
}

async function shoot(theme: VsCodeTheme, questions: { confirm: DialogSpec; pick: DialogSpec }): Promise<string[]> {
  // Wide enough for a branch's actions to open beside the menu.
  const page = await ChangesPage.open(theme, { width: 620, height: 560, scale: 2 });
  const files: string[] = [];
  const snap = async (name: string): Promise<void> => {
    const file = join(OUT, `${name}-${theme}.png`);
    await page.screenshot(file);
    files.push(file);
  };
  try {
    await page.send(STATE);
    await page.send({ type: "openBranchMenu" });
    await page.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
    await page.eval(`new Promise(function (r) { setTimeout(r, 30); })`);
    // Search: "fe" puts the highlight on the branch (it ties Fetch, and a
    // branch wins a tie).
    await page.type("fe");
    await snap("menu-highlight");
    // Right: the branch's actions, the highlight on the first; then down one.
    await page.key("ArrowRight");
    await page.key("ArrowDown");
    await snap("submenu-highlight");
    const labels = await page.eval<string[]>(
      `Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`,
    );
    const to = labels.indexOf("Reset to 'origin/feature'…");
    if (to < 0) throw new Error(`no reset item: ${labels.join(" | ")}`);
    for (let i = 1; i < to; i++) await page.key("ArrowDown");
    await snap("submenu-reset");
    const errors = page.page.errors.slice();
    await page.key("Escape");
    await page.key("Escape");
    await page.send({ type: "dialog", dialogId: "shot-1", spec: questions.confirm });
    await page.page.waitFor(`!!document.querySelector(".rp-panel")`);
    await snap("reset-confirm");
    await page.key("Escape");
    await page.send({ type: "dialog", dialogId: "shot-2", spec: questions.pick });
    await page.page.waitFor(`!!document.querySelector(".rp-panel")`);
    await snap("checkout-over-local");
    if (errors.length || page.page.errors.length) throw new Error(`page errors: ${[...errors, ...page.page.errors].join("\n")}`);
  } finally {
    await page.close();
  }
  return files;
}

(async () => {
  if (!ChangesPage.chrome()) throw new Error("no windowless Chrome on this machine (set GS_CHROME)");
  mkdirSync(OUT, { recursive: true });
  const questions = await realQuestions();
  for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
    for (const f of await shootWindow(theme)) console.log(f);
    for (const f of await shoot(theme, questions)) console.log(f);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
