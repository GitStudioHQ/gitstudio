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
import type { OperationView } from "@gitstudio/host-bridge/conflictsProtocol";
import { operationBanner } from "../../src/changes/operationBanner";
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

/** A stopped operation as OperationProvider describes it; the banner is built by the real operationBanner(). */
function view(over: Partial<OperationView>): OperationView {
  return {
    kind: "rebase",
    episode: "rebase:1a2b3c4",
    title: "Rebasing feature/checkout-flow onto main · commit 2 of 5: 1a2b3c4 Add the payment step",
    yours: { role: "yours", stage: 3, name: "feature/checkout-flow", paneTitle: "", description: "" },
    theirs: { role: "theirs", stage: 2, name: "main", paneTitle: "", description: "" },
    direction: { from: "yours", verb: "onto", to: "theirs" },
    verbs: { continue: "Continue Rebase", skip: "Skip This Commit", abort: "Abort Rebase" },
    canContinue: false,
    canSkip: true,
    ...over,
  } as OperationView;
}

const REBASE_CONFLICTS = (unmerged: number) =>
  operationBanner(view({ continueBlocked: "Resolve the conflicted files first." }), { kind: "rebase", unmerged });

const MERGE_RESOLVED = operationBanner(
  view({
    kind: "merge",
    title: "Merging main into feature/checkout-flow",
    yours: { role: "yours", stage: 2, name: "feature/checkout-flow", paneTitle: "", description: "" },
    theirs: { role: "theirs", stage: 3, name: "main", paneTitle: "", description: "" },
    direction: { from: "theirs", verb: "into", to: "yours" },
    verbs: { continue: "Commit Merge", abort: "Abort Merge" },
    canContinue: true,
    canSkip: false,
  }),
  { kind: "merge", unmerged: 0 },
);

const REBASE_PAUSED = operationBanner(
  view({
    title: "Rebasing feature/checkout-flow onto main · commit 3 of 5: 9f8e7d6 Validate the card number",
    pause: { detail: "Paused to edit 9f8e7d6 Validate the card number. Amend it, then continue." },
    canContinue: true,
    canSkip: false,
  }),
  { kind: "rebase", unmerged: 0 },
);

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
      rel: "2h",
    },
    { sha: "abcdef1234567890abcdef1234567890abcdef12", subject: "Validate the card number", author: "Dev One", date: 1_699_990_000, rel: "5h" },
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
  {
    // A folder's menu, from the keyboard: its buttons' actions (Shift+F10).
    name: "08-folder-menu",
    steps: async (p) => {
      await p.send({ ...base(), layout: "tree" });
      await p.eval(`document.querySelector('[data-tkey^="d:split:unstaged:"]').focus()`);
      await p.key("F10", { with: ["shift"] });
      await p.key("ArrowDown");
    },
  },
  {
    // A group header's menu: Stage All, Discard All, Select All, Stash.
    name: "09-group-menu",
    steps: async (p) => {
      await p.send(base());
      await focusRow(p, "g:unstaged");
      await p.key("F10", { with: ["shift"] });
    },
  },
  {
    // Nothing staged: Tab from the toolbar lands on the Unstaged header, the
    // first row that is drawn (it was the hidden Staged header).
    name: "13-nothing-staged-tab",
    steps: async (p) => {
      await p.send({ ...base(), staged: [], stagedCount: 0 });
      await p.eval(`document.getElementById("refresh").focus()`);
      await p.key("Tab");
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
        operation: REBASE_CONFLICTS(2),
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
        operation: REBASE_CONFLICTS(1),
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
