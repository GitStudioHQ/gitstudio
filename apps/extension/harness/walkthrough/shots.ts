// The Get Started walkthrough's step images, rendered from the real surfaces
// each step leads to — one per step and per theme (Dark+, Light+, and both
// high-contrast themes) — never a logo, never a mock.
//
//   (cd apps/extension && node esbuild.js)        # the graph bundle it mounts
//   npx tsx apps/extension/harness/walkthrough/shots.ts <outDir>
//   python3 apps/extension/harness/walkthrough/pack.py <outDir> apps/extension/media/walkthrough
//
// Every step's content is real:
//   graph, blame   the production graph bundle (dist/webview/graph.js), fed a
//                  graphInit built from a scratch repository by the engine,
//                  host-bridge and git-service code the host runs; blame's
//                  image is the commit a clicked annotation opens, with its
//                  details beside the graph;
//   stage          the Changes view's page (test/changesPage.ts), with one
//                  file's changes open in the checkbox model;
//   history        the same page answering Line History's own pick (the
//                  commits `git log -L` finds for two lines of that repository);
//   merge          scripts/merge-e2e/render.ts — the merge editor stopped on a
//                  real conflict;
//   connect        the AI settings panel's page (test/aiSettingsPage.ts).
// The browser is Playwright's windowless chrome-headless-shell (GS_CHROME),
// never the desktop Chrome.

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GitContext } from "@gitstudio/git-service/GitContext";
import { computeGraphLayout } from "@gitstudio/engine/graph/layout";
import { buildWireRows, wireRefs } from "@gitstudio/host-bridge/graphWire";
import { chipRefsUnderFilter, refEntries } from "@gitstudio/host-bridge/graphRefFilter";
import { Browser } from "../../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../../scripts/merge-e2e/themes";
import { ChangesPage, stateMessage } from "../../test/changesPage";
import { AiSettingsPage, aiStatus } from "../../test/aiSettingsPage";

const HERE = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const EXT = HERE("../../");
const REPO = HERE("../../../../");
const OUT = process.argv[2] ?? join(tmpdir(), "gs-walkthrough-shots");
mkdirSync(OUT, { recursive: true });
const THEMES: VsCodeTheme[] = process.env.THEMES
  ? (process.env.THEMES.split(",") as VsCodeTheme[])
  : ["dark", "light", "hc-dark", "hc-light"];
const ONLY = process.env.ONLY?.split(",");
const want = (step: string) => !ONLY || ONLY.includes(step);

const cfg = join(mkdtempSync(join(tmpdir(), "gs-walkthrough-cfg-")), "config");
writeFileSync(cfg, "");
process.env.GIT_CONFIG_GLOBAL = cfg;
process.env.GIT_CONFIG_SYSTEM = cfg;
process.env.GIT_CONFIG_NOSYSTEM = "1";

/** A small shop with a feature merged, a release branch, tags, a remote and a dirty tree. */
function makeRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "gs-walkthrough-repo-"));
  const remote = join(base, "origin.git");
  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  const dir = join(base, "work");
  execFileSync("git", ["clone", "-q", remote, dir], { stdio: "ignore" });
  // Ages a person recognises: the last commits a few hours old.
  let t = Math.floor(Date.now() / 1000) - 3600 * 7 * 80; // g() steps 7h per call
  const g = (...a: string[]) => {
    t += 3600 * 7;
    return execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_DATE: `${t} +0000`, GIT_COMMITTER_DATE: `${t} +0000` },
    }).trim();
  };
  const who = (name: string, email: string) => {
    g("config", "user.name", name);
    g("config", "user.email", email);
  };
  const write = (f: string, s: string) => {
    mkdirSync(join(dir, f, ".."), { recursive: true });
    writeFileSync(join(dir, f), s);
  };
  g("config", "gc.auto", "0");
  who("Ada Lovelace", "ada@example.com");
  write("README.md", "# Shop\n");
  write("src/app.ts", "export const app = 1;\n");
  g("add", ".");
  g("commit", "-qm", "Initial commit");
  write("src/cart.ts", "export const cart = [];\n".repeat(12));
  g("add", ".");
  g("commit", "-qm", "feat(cart): add the cart store");
  g("tag", "v1.0.0");
  g("push", "-q", "origin", "main", "--tags");
  g("checkout", "-q", "-b", "feature/checkout-flow");
  who("Maya Chen", "maya@example.com");
  write("src/checkout.ts", "export function checkout(cart) {\n  return post(cart);\n}\n");
  g("add", ".");
  g("commit", "-qm", "feat(checkout): the checkout form");
  write("src/checkout.ts", "export function checkout(cart) {\n  validate(cart.card);\n  return post(cart);\n}\n");
  g("add", ".");
  g("commit", "-qm", "feat(checkout): validate the card before posting it");
  g("push", "-q", "-u", "origin", "feature/checkout-flow");
  g("checkout", "-q", "main");
  who("Jonas Weber", "jonas@example.com");
  write("docs/guide.md", "guide\n");
  g("add", ".");
  g("commit", "-qm", "docs: the user guide");
  write("src/app.ts", "export const app = 2;\n");
  g("add", ".");
  g("commit", "-qm", "fix(app): crash on an empty cart");
  g("merge", "-q", "--no-ff", "feature/checkout-flow", "-m", "Merge branch 'feature/checkout-flow'");
  g("tag", "v1.1.0");
  g("push", "-q", "origin", "main", "--tags");
  g("checkout", "-q", "-b", "release/1.x", "v1.0.0");
  who("Sofia Marino", "sofia@example.com");
  write("src/app.ts", "export const app = 11;\n");
  g("add", ".");
  g("commit", "-qm", "fix: backport the empty-cart fix");
  g("push", "-q", "-u", "origin", "release/1.x");
  g("checkout", "-q", "main");
  who("Ada Lovelace", "ada@example.com");
  write("src/checkout.ts", "export function checkout(cart) {\n  validate(cart.card, { strict: true });\n  return post(cart);\n}\n");
  g("add", ".");
  g("commit", "-qm", "fix(checkout): strict card validation");
  for (let i = 0; i < 4; i++) {
    write(`src/mod${i}.ts`, `export const m${i} = ${i};\n`);
    g("add", ".");
    g("commit", "-qm", `feat(mod${i}): module ${i}`);
  }
  write("src/app.ts", "export const app = 3; // dirty\n");
  return dir;
}

const UNCOMMITTED = "0000000000000000000000000000000000000000";

/** graphInit, stats and details exactly as the host builds them. */
async function graphData(dir: string) {
  const ctx = new GitContext({ root: dir });
  type Rec = { sha: string; parents: string[]; author: string; authorEmail: string; authorDate: number; committer: string; committerEmail: string; committerDate: number; subject: string; body: string };
  const records = new Map<string, Rec>();
  const loaded: { sha: string; parents: string[] }[] = [];
  for await (const c of ctx.log.streamCommits({ revRange: "--all", maxCount: 150, skip: 0 })) {
    records.set(c.sha, c as Rec);
    loaded.push({ sha: c.sha, parents: c.parents });
  }
  const refs = await ctx.refs.listRefs();
  const refsBySha = new Map<string, typeof refs>();
  let head = "";
  for (const r of refs) {
    if (r.type === "stash") continue;
    refsBySha.set(r.sha, [...(refsBySha.get(r.sha) ?? []), r]);
    if (r.type === "head" && r.isCurrent) head = r.sha;
  }
  const now = Math.floor(Date.now() / 1000);
  records.set(UNCOMMITTED, {
    sha: UNCOMMITTED, parents: [head], author: "Uncommitted changes", authorEmail: "", authorDate: now,
    committer: "", committerEmail: "", committerDate: now, subject: "Uncommitted changes", body: "",
  });
  loaded.unshift({ sha: UNCOMMITTED, parents: [head] });
  const layout = computeGraphLayout(loaded, { colorCount: 8 });
  const rows = buildWireRows({ rows: layout.rows, records, refsBySha: chipRefsUnderFilter(refsBySha, null) });
  const init = { type: "graphInit", rows, head, totalColumns: layout.totalColumns, hasMore: false, refFilter: null, refList: refEntries(refs) };
  const stats = await ctx.commitDetails.getCommitStats(loaded.filter((c) => c.sha !== UNCOMMITTED).map((c) => c.sha));
  const details: Record<string, unknown> = {};
  for (const c of loaded) {
    if (c.sha === UNCOMMITTED) continue;
    const r = records.get(c.sha)!;
    const files = await ctx.commitDetails.getCommitFiles(c.sha, r.parents[0]);
    details[c.sha] = {
      kind: "commit", sha: r.sha, shortSha: r.sha.slice(0, 7), parents: r.parents, author: r.author,
      authorEmail: r.authorEmail, authorDate: r.authorDate, committer: r.committer, committerEmail: r.committerEmail,
      committerDate: r.committerDate, subject: r.subject, body: r.body, refs: wireRefs(refsBySha.get(c.sha)), files,
      hasRemote: true,
    };
  }
  const lines = await ctx.history.lineHistory("src/checkout.ts", 2, 3, { maxCount: 20 });
  ctx.dispose();
  return { init, stats, details, rows, lines };
}

function graphPage(theme: VsCodeTheme, data: unknown): string {
  const js = readFileSync(join(EXT, "dist/webview/graph.js"), "utf8");
  const css = readFileSync(join(EXT, "dist/webview/graph.css"), "utf8");
  const vars = Object.entries(VSCODE_THEMES[theme]).map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`).join(";");
  const stub = `
window.__data = ${JSON.stringify(data).replace(/</g, "\\u003c")};
window.acquireVsCodeApi = function () { return {
  postMessage: function (m) {
    var d = window.__data;
    setTimeout(function () {
      if (m.type === "ready") window.postMessage(d.init, "*");
      if (m.type === "requestStats") window.postMessage({ type: "rowStats", stats: m.shas.map(function (s) {
        return d.stats.find(function (x) { return x.sha === s; }) || { sha: s, files: 0, additions: 0, deletions: 0 }; }) }, "*");
      if (m.type === "selectCommit" || m.type === "openCommit") window.postMessage({ type: "commitDetails", details: d.details[m.sha] || null }, "*");
      if (m.type === "requestContains") window.postMessage({ type: "commitContains", sha: m.sha, branches: ["main"], truncated: false }, "*");
    }, 5);
  },
  getState: function () { return undefined; }, setState: function () {} }; };`;
  return `<!DOCTYPE html><html lang="en" style="${vars}"><head><meta charset="utf-8">
<link rel="stylesheet" href="${pathToFileURL(join(EXT, "dist/codicons/codicon.css")).href}">
<style>${css}</style><script>${stub}</script></head>
<body class="${BODY_CLASS[theme]}" style="margin:0;background:var(--vscode-editor-background);color:var(--vscode-foreground)">
<div id="root" data-layout="side"><div id="boot">Loading history…</div></div>
<script>${js}</script></body></html>`;
}

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function graphShots(data: Awaited<ReturnType<typeof graphData>>): Promise<void> {
  const browser = await Browser.launch({ width: 960, height: 600 });
  const tmp = mkdtempSync(join(tmpdir(), "gs-walkthrough-graph-"));
  // The feature's "validate the card" commit: what a blamed line opens.
  const pick = data.rows.findIndex((r: { sha: string }) => /validate the card/.test(String((data.details[r.sha] as { subject?: string } | undefined)?.subject ?? "")));
  try {
    for (const theme of THEMES) {
      for (const step of ["graph", "blame"] as const) {
        if (!want(step)) continue;
        const p = await browser.newPage(960, 600, 1);
        const file = join(tmp, `${step}-${theme}.html`);
        writeFileSync(file, graphPage(theme, data));
        await browser.goto(p, pathToFileURL(file).href);
        await settle(1200);
        if (step === "blame" && pick >= 0) {
          const sha = data.rows[pick].sha;
          await p.eval(`window.postMessage({ type: "revealCommit", sha: ${JSON.stringify(sha)} }, "*");
            window.postMessage({ type: "commitDetails", details: window.__data.details[${JSON.stringify(sha)}] }, "*");`);
          await settle(800);
        }
        writeFileSync(join(OUT, `${step}-${theme}.png`), await p.screenshot());
        console.log(step, theme, p.errors.length ? "ERRORS " + p.errors.join(" | ") : "");
        await browser.closePage(p);
      }
    }
  } finally {
    await browser.close();
  }
}

async function changesShots(lines: { sha: string; shortSha: string; subject: string; author: string; authorDate: number }[]): Promise<void> {
  const { relativeTime } = await import("../../src/util/relativeTime");
  const branches = {
    local: [{ name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true, ahead: 5 }],
    remote: ["origin/main"],
  };
  const state = {
    ...stateMessage(branches),
    staged: [{ path: "src/checkout.ts", status: "M" }],
    unstaged: [
      { path: "src/app.ts", status: "M" },
      { path: "src/checkout.ts", status: "M" },
      { path: "docs/guide.md", status: "M" },
    ],
    ahead: 5,
    unpushed: 5,
    stagingModel: "checkboxes",
  };
  for (const theme of THEMES) {
    if (want("stage")) {
      const page = await ChangesPage.open(theme, { width: 400, height: 600, scale: 2 });
      try {
        await page.send(state);
        await page.eval(`document.querySelector('[data-tkey="f:ck:src/checkout.ts"] .hunk-twisty').click()`);
        await page.send({
          type: "hunks",
          path: "src/checkout.ts",
          hunks: [
            { index: 0, start: 1, end: 1, lineCount: 1, preview: "validate(cart.card, { strict: true });", state: "staged" },
            { index: 1, start: 5, end: 7, lineCount: 3, preview: "export function refund(order) {", state: "unstaged" },
          ],
        });
        await page.eval(`document.getElementById("message").value = "fix(checkout): strict card validation";
          document.getElementById("message").dispatchEvent(new Event("input"))`);
        await settle(200);
        await page.screenshot(join(OUT, `stage-${theme}.png`));
        console.log("stage", theme, page.page.errors.join(" | "));
      } finally {
        await page.close();
      }
    }
    if (want("history")) {
      const page = await ChangesPage.open(theme, { width: 400, height: 600, scale: 2 });
      try {
        await page.send({ ...state, stagingModel: "split" });
        // Line History's own question (lineHistory.ts pickCommit), for two real lines.
        await page.send({
          type: "dialog",
          dialogId: "walkthrough",
          spec: {
            kind: "pick",
            title: "Line History — checkout.ts · lines 2–3",
            hint: "Pick a commit to diff it against its parent.",
            choices: lines.map((e, i) => ({
              id: String(i),
              label: e.subject,
              icon: "git-commit",
              detail: e.shortSha,
              description: `${e.author} · ${relativeTime(e.authorDate)}`,
            })),
          },
        });
        await settle(250);
        await page.screenshot(join(OUT, `history-${theme}.png`));
        console.log("history", theme, page.page.errors.join(" | "));
      } finally {
        await page.close();
      }
    }
    if (want("connect")) {
      const page = await AiSettingsPage.open(theme, { width: 720, height: 600, scale: 1 });
      try {
        await page.send({ type: "status", status: aiStatus({ ready: true, activeId: "vscode-lm", copilotAvailable: true }) });
        await settle(200);
        await page.screenshot(join(OUT, `connect-${theme}.png`));
        console.log("connect", theme, page.page.errors.join(" | "));
      } finally {
        await page.close();
      }
    }
  }
}

function mergeShots(): void {
  if (!want("merge")) return;
  const out = mkdtempSync(join(tmpdir(), "gs-walkthrough-merge-"));
  execFileSync(
    "npx",
    [
      "tsx", "scripts/merge-e2e/render.ts", "--scenario", "merge.diff3", "--file", "stress/userService.js",
      "--host", "ext", "--theme", THEMES.join(","), "--width", "960", "--height", "600", "--scale", "1", "--out-dir", out,
    ],
    { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] },
  );
  for (const theme of THEMES) {
    // render.ts names a shot <host>-<scenario>-<theme>-<file>.png. Matched by
    // the whole prefix: "-light-" is also inside "-hc-light-", which sorts
    // first, so Light+ shipped the high-contrast render.
    const shot = readdirSync(out).find((f) => f.startsWith(`ext-merge.diff3-${theme}-`));
    if (shot) {
      copyFileSync(join(out, shot), join(OUT, `merge-${theme}.png`));
      console.log("merge", theme);
    }
  }
}

(async () => {
  const dir = makeRepo();
  const data = await graphData(dir);
  if (want("graph") || want("blame")) await graphShots(data);
  await changesShots(data.lines);
  mergeShots();
  console.log("wrote", OUT);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
