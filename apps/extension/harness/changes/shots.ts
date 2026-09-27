// Screenshots of the Changes view in the states people meet it in — per
// theme, in the real page commitView.ts serves, in a windowless Chrome
// (test/changesPage.ts, which never drives the desktop Chrome).
//
//   npx tsx apps/extension/harness/changes/shots.ts [outDir]
//
//   THEMES=dark,light,hc-dark,hc-light   which themes (default: all four)
//   ONLY=10,19                           scenes whose name starts with these
//
// Writes <scene>-<theme>.png to <repo>/out/changes by default. Each scene is a
// host message (or a few), exactly as the extension posts them.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ChangesPage, stateMessage, type VsCodeTheme } from "../../test/changesPage";

const OUT = process.argv[2] ?? fileURLToPath(new URL("../../../../out/changes/", import.meta.url));
mkdirSync(OUT, { recursive: true });

const BRANCHES = {
  local: [
    {
      name: "feature/checkout-flow",
      current: true,
      upstream: "origin/feature/checkout-flow",
      upstreamOnRemote: true,
      ahead: 2,
      behind: 3,
    },
    { name: "main", upstream: "origin/main", upstreamOnRemote: true, favorite: true },
    { name: "release/2.1", upstream: "origin/release/2.1", upstreamOnRemote: true, behind: 4 },
  ],
  remote: ["origin/main", "origin/feature/checkout-flow", "origin/release/2.1"],
  recent: ["main"],
  tags: ["v2.1.0"],
};

/** A working tree with something in every group, on a branch that is ahead and behind. */
export function base(): Record<string, unknown> {
  return {
    ...stateMessage(BRANCHES),
    repoCount: 1,
    staged: [
      { path: "src/checkout/CheckoutForm.tsx", status: "M" },
      { path: "src/checkout/api.ts", status: "A" },
    ],
    unstaged: [
      { path: "src/checkout/CheckoutForm.tsx", status: "M" },
      { path: "src/lib/very/deeply/nested/folder/structure/useCart.ts", status: "M" },
      { path: "README.md", status: "M" },
      { path: "docs/notes-on-the-migration.md", status: "U" },
      { path: "src/old/legacy.ts", status: "D" },
    ],
    stagedCount: 2,
    ahead: 2,
    behind: 3,
    unpushed: 2,
    upstream: "origin/feature/checkout-flow",
  };
}

const REBASE_CONFLICTS = {
  kind: "rebase",
  title: "Rebasing feature/checkout-flow onto main · commit 2 of 5: Add the payment step",
  note: "2 files have conflicts to resolve.",
  conflicts: 2,
  continueLabel: "Continue Rebase",
  canContinue: false,
  continueBlocked: "Resolve the 2 conflicted files first.",
  skipLabel: "Skip This Commit",
  abortLabel: "Abort Rebase",
};

const MERGE_RESOLVED = {
  kind: "merge",
  title: "Merging main into feature/checkout-flow",
  note: "Every conflict is resolved.",
  conflicts: 0,
  continueLabel: "Commit Merge",
  canContinue: true,
  abortLabel: "Abort Merge",
};

const REBASE_PAUSED = {
  kind: "rebase",
  title: "Rebasing feature/checkout-flow onto main · commit 3 of 5: Validate the card number",
  note: "Paused to edit 1a2b3c4 Validate the card number. Amend it, then continue.",
  conflicts: 0,
  continueLabel: "Continue Rebase",
  canContinue: true,
  abortLabel: "Abort Rebase",
};

const PUSH_PREVIEW = {
  type: "pushPreview",
  hasUpstream: true,
  target: "origin/feature/checkout-flow",
  branch: "feature/checkout-flow",
  base: "abc",
  canPush: true,
  ahead: 2,
  behind: 0,
  needsForce: false,
  additions: 120,
  deletions: 14,
  commits: [
    {
      sha: "1234567890abcdef1234567890abcdef12345678",
      subject: "Add the payment step to the checkout flow",
      author: "Dev One",
      date: 1_700_000_000,
    },
    { sha: "abcdef1234567890abcdef1234567890abcdef12", subject: "Validate the card number", author: "Dev One", date: 1_699_990_000 },
  ],
  files: [
    { path: "src/checkout/CheckoutForm.tsx", status: "M", additions: 80, deletions: 10 },
    { path: "src/checkout/api.ts", status: "A", additions: 40, deletions: 0 },
    { path: "src/checkout/old.ts", status: "R", oldPath: "src/checkout/older.ts", additions: 0, deletions: 4 },
  ],
};

type Scene = { name: string; width?: number; height?: number; steps: (p: ChangesPage) => Promise<void> };

const settle = (p: ChangesPage, ms = 80) => p.eval(`new Promise(r => setTimeout(r, ${ms}))`);

/** Focus a tree row by its tkey and walk the keyboard from there, as a person would. */
async function focusRow(p: ChangesPage, tkey: string): Promise<void> {
  await p.eval(`document.querySelector('[data-tkey="${tkey}"]').focus()`);
}

const scenes: Scene[] = [
  { name: "01-normal", steps: async (p) => p.send(base()) },
  { name: "02-normal-narrow", width: 300, steps: async (p) => p.send(base()) },
  { name: "03-tree", steps: async (p) => p.send({ ...base(), layout: "tree" }) },
  { name: "04-checkboxes", steps: async (p) => p.send({ ...base(), stagingModel: "checkboxes" }) },
  {
    name: "05-keyboard-focus",
    steps: async (p) => {
      await p.send(base());
      await focusRow(p, "g:unstaged");
      await p.key("ArrowDown");
      await p.key("ArrowDown");
      await p.key("ArrowDown", { with: ["shift"] });
    },
  },
  {
    name: "06-checkboxes-hunks-keyboard",
    steps: async (p) => {
      await p.send({ ...base(), stagingModel: "checkboxes" });
      await focusRow(p, "f:ck:README.md");
      await p.key("ArrowRight");
      await p.send({
        type: "hunks",
        path: "README.md",
        hunks: [
          { index: 0, start: 2, end: 6, lineCount: 5, preview: "## Install the extension", state: "staged" },
          { index: 1, start: 40, end: 40, lineCount: 1, preview: "See CONTRIBUTING.md for the rest.", state: "unstaged" },
        ],
      });
      await p.key("ArrowDown");
      await p.key("ArrowDown");
    },
  },
  { name: "07-clean", steps: async (p) => p.send({ ...base(), staged: [], unstaged: [], stagedCount: 0, ahead: 0, behind: 0, unpushed: 0 }) },
  {
    name: "10-rebase-conflicts",
    steps: async (p) =>
      p.send({
        ...base(),
        merge: [
          { path: "src/checkout/CheckoutForm.tsx", status: "!" },
          { path: "src/checkout/api.ts", status: "!" },
        ],
        staged: [{ path: "src/lib/cart.ts", status: "M" }],
        unstaged: [],
        detached: true,
        operation: REBASE_CONFLICTS,
      }),
  },
  {
    name: "11-merge-resolved",
    steps: async (p) =>
      p.send({ ...base(), staged: [{ path: "src/lib/cart.ts", status: "M" }], unstaged: [], operation: MERGE_RESOLVED }),
  },
  {
    name: "12-rebase-paused",
    steps: async (p) =>
      p.send({ ...base(), staged: [], unstaged: [], detached: true, operation: REBASE_PAUSED }),
  },
  {
    name: "19-rebase-narrow",
    width: 300,
    steps: async (p) =>
      p.send({
        ...base(),
        merge: [{ path: "src/checkout/CheckoutForm.tsx", status: "!" }],
        staged: [],
        unstaged: [],
        detached: true,
        operation: { ...REBASE_CONFLICTS, conflicts: 1, note: "1 file has conflicts to resolve." },
      }),
  },
  {
    name: "20-merge-resolved-narrow",
    width: 300,
    steps: async (p) =>
      p.send({ ...base(), staged: [{ path: "src/lib/cart.ts", status: "M" }], unstaged: [], operation: MERGE_RESOLVED }),
  },
  {
    name: "21-push-modal",
    height: 760,
    steps: async (p) => {
      await p.send(base());
      await p.send(PUSH_PREVIEW);
      // Tab from the Push button goes round to the file rows.
      await p.key("Tab");
      await p.key("Tab");
    },
  },
  {
    name: "22-dialog-confirm",
    steps: async (p) => {
      await p.send(base());
      await p.send({
        type: "dialog",
        dialogId: "d1",
        spec: {
          kind: "confirm",
          title: "Discard changes in useCart.ts?",
          message: "It loses its unstaged edits. They were never committed, so nothing — not even Undo — can bring them back.",
          confirmLabel: "Discard",
          danger: true,
        },
      });
    },
  },
  {
    name: "23-multirepo-narrow",
    width: 300,
    steps: async (p) =>
      p.send({ ...base(), repoCount: 3, repoName: "gitstudio-monorepo-with-a-long-name", repoPath: "code/gitstudio-monorepo-with-a-long-name" }),
  },
];

(async () => {
  const themes: VsCodeTheme[] = process.env.THEMES
    ? (process.env.THEMES.split(",") as VsCodeTheme[])
    : ["dark", "light", "hc-dark", "hc-light"];
  const only = process.env.ONLY;
  for (const theme of themes) {
    for (const s of scenes) {
      if (only && !only.split(",").some((o) => s.name.startsWith(o))) continue;
      const page = await ChangesPage.open(theme, { width: s.width ?? 420, height: s.height ?? 640, scale: 2 });
      try {
        await s.steps(page);
        await settle(page, 250);
        const file = join(OUT, `${s.name}-${theme}.png`);
        await page.screenshot(file);
        const errs = page.page.errors;
        console.log(file, errs.length ? "ERRORS: " + errs.join(" | ") : "");
      } finally {
        await page.close();
      }
    }
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
