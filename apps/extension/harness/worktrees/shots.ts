// Screenshots of the Worktrees view — per theme (Dark+, Light+, Dark High
// Contrast, Light High Contrast), in the bundle the extension ships, in a
// windowless Chrome (test/worktreesPage.ts), at a sidebar's width.
//
//   GS_CHROME=… npx tsx apps/extension/harness/worktrees/shots.ts [outDir]
//
// Writes to <repo>/out/worktrees by default: the list (every row state), an
// open row (its uncommitted files, its commits not pushed, one commit open to
// its files), a row's More menu, the menu of a folder that isn't a worktree
// any more, rows busy with an action, the "only the main worktree"
// explainer, a filtered list of many — and, in the Changes view, the push
// review for another worktree, the Remove question and the Forget question.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WorktreesPage, type VsCodeTheme } from "../../test/worktreesPage";
import { fixtureDetails, fixtureRows, row } from "../../test/worktreesFixtures";
import { ChangesPage, stateMessage } from "../../test/changesPage";
import { worktreeRemovalAsk } from "@gitstudio/host-bridge/worktreeRemoval";

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

    // The menu of a folder that isn't a worktree any more: Reveal, Forget.
    await page.clickOn('.wt-row[data-path="/code/app/.claude/worktrees/agent-7f3e"] .wt-more');
    await snap("menu-unlinked");
    await page.key("Escape");

    // Rows busy with an action say what they are doing, at full ink.
    await page.send({ type: "busy", path: "/code/app-checkout", busy: true, label: "Removing…" });
    await page.send({ type: "busy", path: "/code/app-login", busy: true, label: "Pulling…" });
    await snap("busy");
    await page.send({ type: "busy", path: "/code/app-checkout", busy: false });
    await page.send({ type: "busy", path: "/code/app-login", busy: false });

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

/**
 * What Worktrees opens in the Changes view: the push review for another
 * worktree (a commit open to its files), and the Remove question — Stash &
 * Remove first, "Also delete the branch" — in the words host-bridge builds.
 */
async function shootChanges(theme: VsCodeTheme): Promise<string[]> {
  const files: string[] = [];
  const page = await ChangesPage.open(theme, { width: 360, height: 640, scale: 2 });
  // The review pops in over 170ms: a picture caught mid-way is see-through.
  await page.eval(`(function () { var s = document.createElement("style");
    s.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
    document.head.appendChild(s); })()`);
  const snap = async (name: string): Promise<void> => {
    const file = join(OUT, `${name}-${theme}.png`);
    await page.eval(`new Promise(function (r) { setTimeout(r, 60); })`);
    await page.screenshot(file);
    files.push(file);
  };
  try {
    await page.send(stateMessage({ local: [{ name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true }] }));
    const now = Math.floor(Date.now() / 1000);
    const a = "9b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c";
    const p = "4f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39";
    await page.send({
      type: "pushPreview", hasUpstream: true, target: "origin/feature/login", branch: "feature/login", base: p,
      canPush: true, ahead: 2, behind: 0, needsForce: false, additions: 66, deletions: 3,
      commits: [
        { sha: a, parents: [p], subject: "Remember the session across restarts", author: "Ada", date: now - 1800 },
        { sha: "8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f0a9b", parents: [p], subject: "Validate the login form before sending", author: "Ada", date: now - 3 * 3600 },
      ],
      files: [
        { path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 },
        { path: "src/auth/store.ts", status: "A", additions: 41, deletions: 0 },
        { path: "src/auth/form.tsx", status: "M", additions: 1, deletions: 0 },
      ],
      worktree: { name: "app-login", shownPath: "~/code/app-login" },
    });
    await page.eval(`document.querySelector(".push-modal .cr-commit").click()`);
    await page.send({
      type: "pushCommitFiles",
      sha: a,
      files: [
        { path: "src/auth/session.ts", status: "M", additions: 24, deletions: 3 },
        { path: "src/auth/store.ts", status: "A", additions: 41, deletions: 0 },
      ],
    });
    await snap("push-review-worktree");
    await page.key("Escape");
    await page.key("Escape");
    // Forget, for a folder whose .git is gone: nothing on disk changes.
    const forget = worktreeRemovalAsk({
      kind: "stale",
      label: "agent-7f3e",
      shownPath: "~/code/app/.claude/worktrees/agent-7f3e",
      branch: "worktree-agent-7f3e",
      head: p,
      locked: false,
      staleWhy: "gitdir file points to non-existent location",
    });
    await page.send({
      type: "dialog",
      dialogId: "forget",
      spec: {
        kind: "confirm",
        title: forget.title,
        message: forget.message,
        confirmLabel: forget.choices[0].label,
        danger: forget.choices[0].danger,
      },
    });
    await page.page.waitFor(`!!document.querySelector(".rp-panel")`);
    await snap("forget-question");
    await page.key("Escape");
    const ask = worktreeRemovalAsk({
      kind: "present",
      label: "app-login",
      shownPath: "~/code/app-login",
      branch: "feature/login",
      head: p,
      locked: false,
      changes: ["src/auth/login.ts", "src/auth/session.ts", "docs/login-flow.md"],
      mergedInto: "origin/main",
    });
    await page.send({
      type: "dialog",
      dialogId: "shot",
      spec: {
        kind: "pick",
        title: ask.title,
        message: ask.message,
        filter: false,
        choices: ask.choices.map((c) => ({ id: c.id, label: c.label, description: c.description, danger: c.danger, icon: c.id === "stash" ? "git-stash" : "trash" })),
        options: ask.deleteBranch ? [{ id: "deleteBranch", label: ask.deleteBranch.label, description: ask.deleteBranch.description }] : [],
      },
    });
    await page.page.waitFor(`!!document.querySelector(".rp-panel")`);
    await snap("remove-question");
    if (page.page.errors.length) throw new Error(`page errors: ${page.page.errors.join("\n")}`);
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
    for (const f of await shootChanges(theme)) console.log(f);
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
