// The owner's rule for both products, swept over the extension's webviews:
// nothing selected, active, current or matched is marked with a LINE. That
// means no bar down an edge, no rule on top, no underline, and no accent
// outline or border the unselected sibling lacks. What marks the state is a
// tinted fill, plus a soft glow on a pill, a tab or a button.
//
// Each webview is the real page its panel or view serves, in a windowless
// Chrome, in VS Code's Dark+, Light+ and both High Contrast themes. It is
// driven into the states it can show: files selected in the Changes view and
// in a stash, the branch menu's highlighted row and its submenu's, a
// question's keyboard row and its focused checkbox, the Compare panel's tab,
// mode and layout, the rebase workspace's selection and the action it is
// set to, the picked AI provider's form, and the worktree this window has
// open (its bold name, judged for lines and contrast but not for a fill).
// The shared probe (packages/webview-ui/test/selectionProbe.js) then judges
// every state element on the page. Outside High Contrast each one's
// fill must plainly differ from its unselected sibling's, and text on every
// tint must measure AA. In High Contrast, which paints no fills, VS Code's
// whole ring is the mark, and it is asserted to be there.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import Module from "node:module";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { SELECTION_PROBE, type ProbeOptions, type ProbeResult } from "../../../packages/webview-ui/test/selectionProbe";
import { findChrome } from "../../../packages/webview-ui/test/headless";
import { Browser, type Page } from "../../../scripts/merge-e2e/cdp";
import { BODY_CLASS, VSCODE_THEMES, type VsCodeTheme } from "../../../scripts/merge-e2e/themes";
import { ChangesPage, stateMessage } from "./changesPage";
import { RebasePanelPage } from "./rebasePanelPage";
import { AiSettingsPage, aiStatus } from "./aiSettingsPage";
import { WorktreesPage } from "./worktreesPage";
import { fixtureRows } from "./worktreesFixtures";
import { relativeTime } from "../src/util/relativeTime";

type Resolver = { _resolveFilename: (request: unknown, ...rest: unknown[]) => string };
const resolver = Module as unknown as Resolver;
const resolve = resolver._resolveFilename;
resolver._resolveFilename = function (request: unknown, ...rest: unknown[]) {
  return request === "vscode" ? join(__dirname, "vscodeStub.cjs") : resolve.call(this, request, ...rest);
};
// comparePanel.ts imports the shared tokens.css as text (esbuild's "text" loader).
const loaders = (Module as unknown as { _extensions: Record<string, (m: { exports: unknown }, f: string) => void> })._extensions;
loaders[".css"] = (m, f) => {
  m.exports = readFileSync(f, "utf8");
};
/* eslint-disable @typescript-eslint/no-require-imports -- loaded after the stand-in is in place */
const { ComparePanel } = require("../src/compare/comparePanel") as typeof import("../src/compare/comparePanel");
/* eslint-enable @typescript-eslint/no-require-imports */
import type { CompareResult } from "../src/compare/refCompare";

const skip = findChrome() ? false : "no windowless Chrome on this machine (set GS_CHROME)";
const THEMES: VsCodeTheme[] = ["dark", "light", "hc-dark", "hc-light"];
const cleanups: (() => Promise<void> | void)[] = [];
after(async () => {
  for (const c of cleanups) await c();
});

interface Evaluates {
  eval<T = unknown>(expression: string): Promise<T>;
}

/**
 * Run the probe on the page as it stands: every transition finished at once
 * (a colour caught mid-ease is one nobody sees), then judged. Returns the
 * failures, each named by `label`.
 */
async function sweep(page: Evaluates, theme: VsCodeTheme, label: string, opts: ProbeOptions = {}): Promise<string[]> {
  await page.eval(`(function () {
    if (!window.gsSelectionProbe) { ${SELECTION_PROBE} }
    if (!document.getElementById("gs-still")) {
      var s = document.createElement("style");
      s.id = "gs-still";
      s.textContent = "*,*::before,*::after{transition:none!important;animation:none!important}";
      document.head.appendChild(s);
    }
  })()`);
  const hc = theme.startsWith("hc");
  const r = await page.eval<ProbeResult>(`window.gsSelectionProbe(${JSON.stringify({ hc, fillAll: !hc, ...opts })})`);
  return [
    ...r.lines.map((l) => `${label}: ${l}`),
    ...r.fills.map((f) => `${label}: ${f}`),
    ...r.contrast.map((c) => `${label}: text on the tint ${c}`),
  ];
}

/** What the page says about an element, computed. */
const outlineOf = (page: Evaluates, sel: string): Promise<string> =>
  page.eval<string>(`(function () { var e = document.querySelector(${JSON.stringify(sel)}); return e ? getComputedStyle(e).outlineStyle : "missing"; })()`);

const settle = (page: Evaluates, ms = 80) => page.eval(`new Promise(function (r) { setTimeout(r, ${ms}); })`);

// ── The Changes view: files, a stash's files, the branch menu, a question ──

const now = Math.floor(Date.now() / 1000);
const STASH = "b".repeat(40);

function changesState(): Record<string, unknown> {
  return {
    ...stateMessage({
      local: [
        { name: "feature/checkout-flow", current: true, upstream: "origin/feature/checkout-flow", upstreamOnRemote: true, ahead: 2, behind: 1 },
        { name: "main", upstream: "origin/main", upstreamOnRemote: true, favorite: true },
        { name: "feature/login", upstream: "origin/feature/login", upstreamOnRemote: true },
      ],
      remote: ["origin/main", "origin/feature/checkout-flow", "origin/feature/login"],
      tags: ["v2.1.0"],
    }),
    repoCount: 1,
    staged: [{ path: "src/checkout/api.ts", status: "A" }],
    unstaged: [
      { path: "src/checkout/CheckoutForm.tsx", status: "M" },
      { path: "src/lib/useCart.ts", status: "M" },
      { path: "README.md", status: "M" },
      { path: "src/old/legacy.ts", status: "D" },
    ],
    stagedCount: 1,
    stashes: [
      {
        sha: STASH,
        text: "Fix login redirect",
        branch: "main",
        message: "On main: Fix login redirect",
        time: now - 4 * 3600,
        rel: relativeTime(now - 4 * 3600),
        files: [
          { path: "src/auth/callback.ts", status: "A" },
          { path: "src/auth/login.ts", status: "M" },
          { path: "src/routes.ts", status: "D" },
        ],
      },
    ],
  };
}

for (const theme of THEMES) {
  test(`the Changes view: selected files, a stash's, the branch menu's highlight and a question's row are lit, not lined (${theme})`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 420, height: 760 });
    cleanups.push(() => page.close());
    const hc = theme.startsWith("hc");
    const fails: string[] = [];
    await page.send(changesState());
    await settle(page);

    // Two working-tree files selected from the keyboard.
    await page.eval(`document.querySelector('[data-tkey="g:unstaged"]').focus()`);
    await page.key("ArrowDown");
    await page.key("ArrowDown", { with: ["shift"] });
    await page.mouseMove(2, 2);
    await settle(page);
    const selected = await page.eval<number>(`document.querySelectorAll("#groups .row.is-file.is-selected").length`);
    assert.equal(selected, 2, "two files selected");
    if (hc) assert.equal(await outlineOf(page, "#groups .row.is-file.is-selected:not(:focus)"), "dashed", "high contrast: a selected file is ringed whole");
    fails.push(...(await sweep(page, theme, "files selected", hc ? {} : { targets: ["#groups .row.is-file.is-selected"], fillSkip: ".bm-star" })));

    // A stash open, two of its files selected.
    await page.eval(`document.querySelector('#stashes [data-tkey="stash:${STASH}"]').click()`);
    await settle(page);
    const click = (path: string, mods = "") =>
      page.eval(`document.querySelector('#stashes [data-key="stash:${STASH}:${path}"]').dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1${mods} }))`);
    await click("src/auth/callback.ts");
    await click("src/routes.ts", ", shiftKey: true");
    await settle(page);
    assert.ok((await page.eval<number>(`document.querySelectorAll("#stashes .row.is-file.is-selected").length`)) >= 2, "a stash's files selected");
    fails.push(...(await sweep(page, theme, "a stash's files selected", hc ? {} : { targets: ["#stashes .row.is-file.is-selected"], fillSkip: ".bm-star" })));
    await page.key("Escape");

    // The branch menu: the highlighted row, then a branch's submenu.
    await page.send({ type: "openBranchMenu" });
    await page.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
    await settle(page, 30);
    await page.type("feature");
    await settle(page);
    const menuOpts: ProbeOptions = hc
      ? {}
      : {
          targets: [".bm-list .is-active"],
          // In a menu the one fill is the keyboard's highlight. The current
          // branch is named by its ink and its icon, and a favourite by its
          // filled star, never by a line.
          fillSkip: ".bm-branch.is-current, .bm-star",
        };
    if (hc) assert.equal(await outlineOf(page, ".bm-list .is-active"), "solid", "high contrast: the highlight is VS Code's whole focus ring");
    fails.push(...(await sweep(page, theme, "the branch menu's highlight", menuOpts)));
    await page.key("ArrowRight");
    await settle(page);
    fails.push(...(await sweep(page, theme, "a branch's submenu", hc ? {} : { ...menuOpts, targets: [".branch-submenu .is-active"] })));
    // The pointer moves the highlight: the row under it looks exactly as the
    // keyboard's highlight does (it once took the hover's grey, and the
    // highlight's white words on it read 1.39:1 in Light+).
    const lookOf = `(function () { var e = document.querySelector(".branch-submenu .is-active"); if (!e) return "none"; var c = getComputedStyle(e); return [c.backgroundColor, c.color, c.outlineStyle, c.outlineColor].join(" | "); })()`;
    const byKeyboard = await page.eval<string>(lookOf);
    const second = await page.eval<{ x: number; y: number } | null>(`(function () {
      var items = Array.prototype.slice.call(document.querySelectorAll(".branch-submenu .bm-subaction:not(.danger)"));
      var t = items.find(function (b) { return !b.classList.contains("is-active"); });
      if (!t) return null;
      var r = t.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    assert.ok(second, "the submenu has a second item");
    await page.mouseMove(second!.x, second!.y);
    await settle(page);
    const underPointer = await page.eval<boolean>(`document.querySelector(".branch-submenu .is-active") === document.elementFromPoint(${second!.x}, ${second!.y}).closest(".bm-subaction")`);
    assert.ok(underPointer, "the pointer moved the highlight");
    const byMouse = await page.eval<string>(lookOf);
    if (byMouse !== byKeyboard) fails.push(`a branch's submenu: the highlight under the pointer looks unlike the keyboard's (${byMouse} vs ${byKeyboard})`);
    await page.mouseMove(2, 2);
    await page.key("Escape");
    await page.key("Escape");
    await settle(page);

    // A question: its keyboard row, and a checkbox the keyboard is on.
    await page.send({
      type: "dialog",
      dialogId: "q1",
      spec: {
        kind: "pick",
        title: "Remove worktree feat?",
        message: "It has 1 uncommitted change.",
        filter: false,
        choices: [
          { id: "stash", label: "Stash & Remove", description: "Its 1 uncommitted change goes into a stash." },
          { id: "discard", label: "Discard Changes and Remove", danger: true },
        ],
        options: [{ id: "deleteBranch", label: "Also delete the branch feat", description: "It is fully merged into main.", checked: false }],
      },
    });
    await page.page.waitFor(`!!document.querySelector(".rp-panel .rp-row.sel")`);
    await settle(page);
    if (hc) assert.equal(await outlineOf(page, ".rp-panel .rp-row.sel"), "solid", "high contrast: the question's row is ringed whole");
    fails.push(...(await sweep(page, theme, "a question's row", hc ? {} : { targets: [".rp-panel .rp-row.sel"] })));
    await page.key("Tab");
    await page.eval(`document.querySelector(".rp-panel .rp-check").focus()`);
    const focused = await page.eval<boolean>(`document.querySelector(".rp-panel .rp-check").matches(":focus-visible")`);
    assert.ok(focused, "the checkbox has the keyboard");
    fails.push(
      ...(await sweep(page, theme, "a question's checkbox under the keyboard", {
        also: [[".rp-option:has(.rp-check:focus-visible)", ".rp-choice:not(.sel)"]],
        ...(hc ? {} : { targets: [".rp-option:has(.rp-check:focus-visible)"] }),
      })),
    );
    assert.deepEqual(fails, []);
  });
}

// ── The branch menu in a wide view: the row whose submenu is open ──────────

for (const theme of THEMES) {
  test(`the branch menu, wide enough for its submenu beside the list: the open row is lit and reads (${theme})`, { skip }, async () => {
    // At 420px the submenu takes the list's place and the open row is not
    // on screen; here it stays beside it, marked.
    const page = await ChangesPage.open(theme, { width: 900, height: 760 });
    cleanups.push(() => page.close());
    const hc = theme.startsWith("hc");
    await page.send(changesState());
    await settle(page);
    await page.send({ type: "openBranchMenu" });
    await page.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
    await settle(page, 30);
    await page.type("feature");
    await settle(page);
    await page.key("ArrowRight");
    await settle(page);
    const open = await page.eval<boolean>(`(function () { var r = document.querySelector(".bm-branch.is-open"); return !!r && r.getClientRects().length > 0 && !document.querySelector(".branch-submenu.is-drilled"); })()`);
    assert.ok(open, "the submenu opened beside the list, its row marked open");
    if (hc) assert.equal(await outlineOf(page, ".bm-branch.is-open"), "dashed", "high contrast: the open row is ringed whole");
    const fails = await sweep(
      page,
      theme,
      "the open row",
      hc ? {} : { targets: [".bm-branch.is-open", ".branch-submenu .is-active"], fillSkip: ".bm-branch.is-current:not(.is-open), .bm-star" },
    );
    assert.deepEqual(fails, []);
  });
}

// ── The Compare panel ───────────────────────────────────────────────────────

const RESULT = {
  commits: [
    { sha: "1".repeat(40), subject: "feat(checkout): validate the card before posting it", author: "Maya Chen", authorDate: now - 3600 * 5 },
    { sha: "2".repeat(40), subject: "feat(checkout): the checkout form", author: "Maya Chen", authorDate: now - 86400 * 2 },
  ],
  files: [
    { path: "src/checkout.ts", status: "M", additions: 12, deletions: 3 },
    { path: "src/checkout/api.ts", status: "A", additions: 40, deletions: 0 },
  ],
  additions: 52,
  deletions: 3,
  ahead: 2,
  behind: 1,
  filesLeftRef: "b".repeat(40),
  baseKind: "branch",
  headKind: "branch",
} as unknown as CompareResult;

const CODICONS = join(__dirname, "../../../node_modules/@vscode/codicons/dist/codicon.css");

function compareHtml(theme: VsCodeTheme): string {
  const self = {
    base: "main",
    head: "feature/checkout-flow",
    threeDot: true,
    extensionUri: {},
    panel: { webview: { asWebviewUri: () => pathToFileURL(CODICONS).href, cspSource: "file:" } },
  };
  const html = (ComparePanel.prototype as unknown as { render: (r: CompareResult) => string }).render.call(self, RESULT);
  const vars = Object.entries(VSCODE_THEMES[theme]).map(([k, v]) => `${k}:${v.replace(/"/g, "&quot;")}`).join(";");
  const stub = `window.acquireVsCodeApi = function () { return { postMessage: function () {}, getState: function () { return undefined; }, setState: function () {} }; };`;
  const out = html
    .replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace('<!DOCTYPE html><html lang="en"><head>', `<!DOCTYPE html><html lang="en" style="${vars}"><head><script>${stub}</script>`)
    .replace("</head>\n<body>", `</head>\n<body class="${BODY_CLASS[theme]}">`);
  if (out === html || !out.includes(BODY_CLASS[theme])) throw new Error("comparePanel render(): the page's head or body moved; update the swap");
  return out;
}

for (const theme of THEMES) {
  test(`the Compare panel: its tab, mode, layout and file in view are lit, not lined (${theme})`, { skip }, async () => {
    process.env.GS_CHROME = findChrome();
    const browser = await Browser.launch({ width: 1000, height: 640 });
    const dir = mkdtempSync(join(tmpdir(), "gs-compare-sweep-"));
    cleanups.push(async () => {
      await browser.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const page: Page = await browser.newPage(1000, 640, 1);
    const file = join(dir, `compare-${theme}.html`);
    writeFileSync(file, compareHtml(theme));
    await browser.goto(page, pathToFileURL(file).href);
    await page.waitFor(`!!document.querySelector(".cmp-seg button.on")`);
    await settle(page, 200);
    const hc = theme.startsWith("hc");
    const fails: string[] = [];
    // A file in the tree nav, as a click on it makes it.
    await page.eval(`(function () { var f = document.querySelector("#tree-nav .tnav-file"); if (f) f.click(); })()`);
    await settle(page, 120);
    if (hc) assert.equal(await outlineOf(page, ".cmp-seg button.on"), "solid", "high contrast: the tab in front is ringed whole");
    fails.push(
      ...(await sweep(page, theme, "the Files tab", hc ? {} : { targets: [".cmp-seg button.on", ".cmp-mode button.on", ".tb-seg.on", "#tree-nav .tnav-file.active"] })),
    );
    await page.eval(`document.getElementById("seg-commits").click()`);
    await settle(page, 120);
    fails.push(...(await sweep(page, theme, "the Commits tab", hc ? {} : { targets: [".cmp-seg button.on"] })));
    assert.deepEqual(fails, []);
  });
}

// ── The interactive rebase workspace ────────────────────────────────────────

for (const theme of THEMES) {
  test(`the rebase workspace: a selection and the action it is set to are lit, not lined (${theme})`, { skip }, async () => {
    const page = await RebasePanelPage.open(theme);
    cleanups.push(() => page.close());
    const hc = theme.startsWith("hc");
    await page.clickRow(8);
    await page.clickRow(10, { shift: true });
    const fixup = await page.centre(".rb-set.a-fixup");
    assert.ok(fixup, "the toolbar has Fixup");
    await page.clickAt(fixup!.x, fixup!.y);
    assert.ok((await page.eval<number>(`document.querySelectorAll(".rb-row.is-selected").length`)) >= 2, "several selected");
    assert.ok(await page.eval<boolean>(`!!document.querySelector(".rb-set.is-current")`), "the toolbar shows what they are set to");
    if (hc) assert.equal(await outlineOf(page, ".rb-set.is-current"), "solid", "high contrast: the action they are set to is ringed whole");
    const fails = await sweep(page, theme, "a rebase selection", hc ? {} : { targets: [".rb-row.is-selected", ".rb-set.is-current"] });
    // Every action's own hue, lit, at rest and under the pointer (the
    // segments' hover once replaced the tint: Squash read 3.69:1 on it).
    for (const action of ["pick", "reword", "edit", "squash", "drop"]) {
      const at = await page.centre(`.rb-set.a-${action}`);
      assert.ok(at, `the toolbar has ${action}`);
      await page.clickAt(at!.x, at!.y);
      assert.ok(await page.eval<boolean>(`!!document.querySelector(".rb-set.a-${action}.is-current")`), `the selection is set to ${action}`);
      fails.push(...(await sweep(page, theme, `set to ${action}`, hc ? {} : { targets: [".rb-set.is-current"] })));
    }
    assert.deepEqual(fails, []);
  });
}

// ── The AI settings: the picked provider's form ─────────────────────────────

for (const theme of THEMES) {
  test(`the AI settings: the picked provider's form glows, never ringed (${theme})`, { skip }, async () => {
    const page = await AiSettingsPage.open(theme);
    cleanups.push(() => page.close());
    await page.send({ type: "status", status: aiStatus() });
    await settle(page);
    await page.eval(`(function () {
      var cards = Array.prototype.slice.call(document.querySelectorAll(".ai-prov-card"));
      var c = cards.find(function (x) { return /Ollama/.test(x.textContent); }) || cards[0];
      c.click();
    })()`);
    await settle(page, 120);
    assert.ok(await page.eval<boolean>(`!!document.querySelector(".ai-editor-inline .ai-conn")`), "the picked provider's form is open");
    // A form is a container, not a list item: its mark is the glow alone,
    // and its edge is the same neutral edge as the provider cards.
    const fails = await sweep(page, theme, "the picked provider", {
      also: [[".ai-editor-inline .ai-conn", ".ai-prov-card"]],
      fillSkip: ".ai-editor-inline .ai-conn",
    });
    assert.deepEqual(fails, []);
  });
}

// Cursor's own theme gives a focus colour of 15% white; the panel's accent is
// its violet, but the glow was resolved on :root from the theme's colour —
// the open form had no mark at all there.
test("the AI settings in Cursor Dark: the picked provider's form glows in the panel's violet", { skip }, async () => {
  const over = JSON.parse(readFileSync(join(__dirname, "fixtures", "cursorDarkTheme.json"), "utf8")).vars;
  const page = await AiSettingsPage.open("dark", { over });
  cleanups.push(() => page.close());
  await page.send({ type: "status", status: aiStatus() });
  await settle(page);
  await page.eval(`(function () {
    var cards = Array.prototype.slice.call(document.querySelectorAll(".ai-prov-card"));
    var c = cards.find(function (x) { return /Ollama/.test(x.textContent); }) || cards[0];
    c.click();
  })()`);
  await settle(page, 120);
  const glow = await page.eval<string>(`getComputedStyle(document.querySelector(".ai-editor-inline .ai-conn")).boxShadow`);
  const m = /color\(srgb ([\d.]+) ([\d.]+) ([\d.]+)(?: \/ ([\d.]+))?\)|rgba?\((\d+), (\d+), (\d+)(?:, ([\d.]+))?\)/.exec(glow);
  assert.ok(m, `a glow: ${glow}`);
  const [r, g, b, a] = m![1] ? [+m![1] * 255, +m![2] * 255, +m![3] * 255, m![4] ? +m![4] : 1] : [+m![5], +m![6], +m![7], m![8] ? +m![8] : 1];
  assert.ok(a >= 0.5 && b > r + 60 && b > g + 60, `the glow is the violet, and solid enough to see: ${glow}`);
});

// ── The Worktrees view: this window's row ───────────────────────────────────

// The owner's minimal Worktrees view marks the worktree this window has open
// the way the branch menu marks the branch you're on: its name, bold. That is
// no line, and no tint either, so its row is judged for lines and for its
// words' contrast, at rest and under the pointer, and its mark is the weight.
for (const theme of THEMES) {
  test(`the Worktrees view: the worktree this window has open is its bold name, never lined (${theme})`, { skip }, async () => {
    const page = await WorktreesPage.open(theme, { width: 320, height: 620 });
    cleanups.push(() => page.close());
    await page.send({ type: "rows", rows: fixtureRows(), state: "ok", labels: { reveal: "Reveal in Finder" } });
    await page.settle(80);
    await page.mouseMove(2, 600);
    assert.ok(await page.eval<boolean>(`!!document.querySelector(".wt-row.is-current")`), "a row is this window's");
    const weights = await page.eval<{ here: number; other: number }>(`(function () {
      var w = function (sel) { return parseInt(getComputedStyle(document.querySelector(sel)).fontWeight, 10); };
      return { here: w(".wt-row.is-current .wt-name"), other: w(".wt-row:not(.is-current) .wt-name") };
    })()`);
    assert.ok(weights.here >= 600 && weights.other < 600, `its name is bold and the others' are not: ${JSON.stringify(weights)}`);
    const fails = await sweep(page, theme, "this window's worktree", { fillSkip: ".wt-row.is-current" });
    assert.deepEqual(fails, []);
  });
}
