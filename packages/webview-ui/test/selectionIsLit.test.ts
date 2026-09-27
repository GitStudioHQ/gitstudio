import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";
import { applyThemeScript, sweepScript, themeVars, type SweepTheme } from "./selectionProbe";

/**
 * The owner's rule for both products, swept over the shared components:
 * nothing selected, active, current or matched is marked with a LINE. That
 * means no bar down an edge, no rule on top, no underline, and no accent
 * outline or border the unselected sibling lacks. What marks the state is a
 * tinted fill, plus a soft glow on a pill, a tab or a button.
 *
 * Each surface is mounted in headless Chrome in VS Code's Dark+, Light+ and
 * both High Contrast themes, and driven into every state it can show:
 * several commits selected with the cursor on one, the cursor on a row it
 * deselected, a search's matches, the branch picker's preset, a rebase's
 * selection and the action they are all set to, the PR list's checked-out
 * row and applied filter, the PR page's tab in front, a chosen verdict and
 * merge method, and the branch checked out here. selectionProbe.js then
 * judges every state element on the page. A named target must be filled
 * plainly differently from its unselected sibling, and text on a tint must
 * measure AA. In a High Contrast theme, which paints no fills, VS Code's
 * whole ring is the mark, and it is asserted to be there.
 */
const CHROME = findChrome();
const skip = CHROME ? false : "no windowless Chrome on this machine (set GS_CHROME)";
const THEMES: SweepTheme[] = ["dark", "light", "hc-dark", "hc-light"];

const rootCss = (theme: SweepTheme, size: string): string =>
  `html{${Object.entries(themeVars(theme)).map(([k, v]) => `${k}:${v}`).join(";")}} #root{${size}}`;

async function run(
  entry: string,
  theme: SweepTheme,
  script: string,
  opts: { width?: number; height?: number; size?: string; prelude?: string; ground?: "editor" | "sidebar" } = {},
): Promise<void> {
  const ground = opts.ground === "editor" ? `document.body.style.background = ${JSON.stringify(themeVars(theme)["--vscode-editor-background"])};` : "";
  const v = await runInChrome(CHROME!, entry, applyThemeScript(theme) + ground + sweepScript(theme) + script, {
    width: opts.width ?? 1000,
    height: opts.height ?? 760,
    css: rootCss(theme, opts.size ?? "height:700px;display:flex;flex-direction:column"),
    prelude: opts.prelude,
  });
  assert.equal(v.fails.length, 0, v.fails.slice(0, 30).join("\n") + "\n" + JSON.stringify(v.notes ?? {}).slice(0, 1500));
}

// ── The commit graph and the sidebar's Commits list ─────────────────────────

const LIST_COMMON = `
  const sha = (i) => (i === 0 ? "0".repeat(40) : i.toString(16).padStart(4, "0").repeat(10));
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: i === 0 ? "" : "commit " + i, author: "Ada Lovelace", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600,
    // Every other commit carries refs, more than fit: its chips and its "+N"
    // count sit on the selection's fill and are measured there (a fixture
    // with no refs never measured them, and "+1" read 4.29:1 on the lit row).
    refs: i > 0 && i % 2 === 0
      ? [
          { name: "feature/topic-" + i, fullName: "refs/heads/feature/topic-" + i, kind: "head" },
          { name: "origin/feature/topic-" + i, fullName: "refs/remotes/origin/feature/topic-" + i, kind: "remoteHead" },
          { name: "v1." + i + ".0", fullName: "refs/tags/v1." + i + ".0", kind: "tag" },
          { name: "v1." + i + ".0-rc.1", fullName: "refs/tags/v1." + i + ".0-rc.1", kind: "tag" },
          { name: "v1." + i + ".0-rc.2", fullName: "refs/tags/v1." + i + ".0-rc.2", kind: "tag" },
        ]
      : [],
  });
  const rows = Array.from({ length: 30 }, (_, i) => row(i));
  const tick = () => new Promise((r) => setTimeout(r, 40));
  const settle = async (el) => { await el.updateComplete; await tick(); await el.updateComplete; };
  const R = (el, i) => el.shadowRoot.querySelector('.row[data-sha="' + sha(i) + '"]');
  const click = async (el, i, mods = {}) => {
    const target = R(el, i).querySelector(".subject") || R(el, i);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ...mods }));
    await settle(el);
  };
  const fill = (e) => window.gsSelectionProbe.fillOf(e);
  const apart = (a, b) => window.gsSelectionProbe.dist(fill(a), fill(b));
`;

const LIST_BODY = (tag: string, searchInput: string, branchesButton: string, presetActive: string, scopeButton: string) => `
  const el = document.createElement("${tag}");
  el.onAction = () => {};
  el.status = "loading";
  document.getElementById("root").replaceChildren(el);
  await settle(el);
  el.rows = rows; el.totalColumns = 1; el.hasMore = false; el.status = "ready";
  await settle(el);

  // Three selected, the keyboard's cursor on the last of them.
  await click(el, 2);
  await click(el, 4, { metaKey: true });
  await click(el, 6, { metaKey: true });
  const cursor = R(el, 6), other = R(el, 4);
  expect(cursor.classList.contains("focused") && cursor.classList.contains("selected") && other.classList.contains("selected"), "three selected, the cursor on one");
  if (HC) {
    const ring = (e) => getComputedStyle(e).outlineStyle;
    expect(ring(other) === "dashed" && ring(cursor) === "solid", "high contrast: a selection is a whole dashed ring, the cursor a solid one (" + ring(other) + " / " + ring(cursor) + ")");
    sweep("three selected");
  } else {
    sweep("three selected", { targets: [".row.selected.focused", ".row.selected:not(.focused)"] });
    expect(apart(cursor, other) >= 12, "the cursor's fill stands apart from the other selected rows' (" + apart(cursor, other).toFixed(0) + ")");
  }

  // A Cmd-click deselects the row under the cursor: the cursor stays on it.
  await click(el, 6, { metaKey: true });
  expect(R(el, 6).classList.contains("focused") && !R(el, 6).classList.contains("selected"), "the cursor on a row it deselected");
  sweep("the cursor on a deselected row", HC ? {} : { targets: [".row.focused:not(.selected)"] });

  // A search: the matches are washed, the rest recede.
  await click(el, 25);
  const input = el.shadowRoot.querySelector("${searchInput}");
  input.value = "commit 1";
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settle(el);
  expect(el.shadowRoot.querySelectorAll(".row.is-match").length > 1, "the search matches rows");
  // (A search box holding a query is a field with words in it, not a chosen thing.)
  sweep("a search's matches", HC ? {} : { targets: ${JSON.stringify(tag === "gitstudio-graph" ? [".row.is-match:not(.selected)"] : [".row.is-match:not(.selected):not(.is-cursor)", ".row.is-cursor"])}, fillSkip: ".gh-search" });

  // Results clicked: a selected match stays SELECTED. Its fill is the
  // selection's with a little of the match's yellow in it, never the match
  // wash in its place (the rail's wash was declared after .row.selected and
  // won: white words on pale yellow, 1.29:1 in Light+). Row 25 (selected
  // before the search, no match) is the plain selection to hold it to.
  await click(el, 12, { metaKey: true });
  await click(el, 14, { metaKey: true });
  const selMatch = R(el, 12), cursorMatch = R(el, 14), selPlain = R(el, 25), washed = R(el, 13);
  expect(
    selMatch.classList.contains("selected") && selMatch.classList.contains("is-match") && !selMatch.classList.contains("focused") &&
      cursorMatch.classList.contains("focused") && cursorMatch.classList.contains("is-match") &&
      selPlain.classList.contains("selected") && !selPlain.classList.contains("is-match") &&
      washed.classList.contains("is-match") && !washed.classList.contains("selected"),
    "two results selected, the cursor on one, beside a plain selection and an unselected result",
  );
  if (HC) {
    const ring = (e) => getComputedStyle(e).outlineStyle;
    expect(ring(selMatch) === "dashed" && ring(cursorMatch) === "solid", "high contrast: a selected result is ringed as any selection is (" + ring(selMatch) + " / " + ring(cursorMatch) + ")");
    sweep("selected results");
  } else {
    sweep("selected results", { targets: [".row.selected.is-match"], fillSkip: ".gh-search" });
    expect(apart(selMatch, washed) >= 40, "a selected result is not the match wash (" + apart(selMatch, washed).toFixed(0) + " from an unselected result)");
    expect(
      apart(selMatch, selPlain) >= 6 && apart(selMatch, selPlain) < 0.8 * apart(selMatch, washed),
      "it keeps the selection's fill (nearer it than the wash), with a match cue that is no line (" + apart(selMatch, selPlain).toFixed(0) + " from the plain selection, " + apart(selMatch, washed).toFixed(0) + " from the wash)",
    );
    expect(apart(cursorMatch, selMatch) >= 12, "and the cursor among the results is lit as the cursor (" + apart(cursorMatch, selMatch).toFixed(0) + ")");
  }
  // The rows the search does not match recede, but not the one you picked.
  const faded = (e) => { let o = 1; for (let n = e; n && n !== el.shadowRoot; n = n.parentElement) o *= parseFloat(getComputedStyle(n).opacity); return o; };
  const plainSubject = selPlain.querySelector(".subject");
  expect(faded(plainSubject) > 0.99, "a selected commit the search does not match is not faded with the rest (" + faded(plainSubject).toFixed(2) + ")");
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
  await settle(el);

  // The branch picker, its preset in force.
  el.shadowRoot.querySelector("${branchesButton}").click();
  await settle(el);
  expect(!!el.shadowRoot.querySelector("${presetActive}"), "the picker shows its preset in force");
  sweep("the branch picker", HC ? {} : { targets: ["${presetActive}"] });
  el.shadowRoot.querySelector("${branchesButton}").click();
  await settle(el);

  // The search's scope menu: the scope in force is ticked, as a checklist's
  // item is (its tick is the mark, not a fill), and wears no line.
  el.shadowRoot.querySelector("${scopeButton}").click();
  await settle(el);
  expect(!!el.shadowRoot.querySelector('[role="menuitemradio"][aria-checked="true"], [aria-checked="true"]'), "the scope menu ticks the scope in force");
  sweep("the scope menu", HC ? {} : { fillSkip: '[aria-checked="true"]' });
`;

for (const theme of THEMES) {
  test(`the commit graph: nothing selected, current or matched wears a line (${theme})`, { skip }, async () => {
    await run(
      fileURLToPath(new URL("../src/graph/commit-graph.ts", import.meta.url)),
      theme,
      LIST_COMMON + LIST_BODY("gitstudio-graph", ".gh-search input", ".gh-branches", ".gh-preset.active", ".gh-search .gh-scope"),
      { width: 1000, height: 800, ground: "editor" },
    );
  });

  test(`the sidebar's Commits list: nothing selected, current or matched wears a line (${theme})`, { skip }, async () => {
    await run(
      fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url)),
      theme,
      LIST_COMMON + LIST_BODY("gitstudio-commit-rail", ".search input", ".ibtn.branches", ".pop .preset.active", ".search .ibtn.anchor"),
      { width: 360, height: 800 },
    );
  });
}

// ── The git-rebase-todo editor ──────────────────────────────────────────────

const REBASE = `
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const subjects = ["docs: the staging model", "engine: hunk splitting", "typo", "changes: a row per hunk", "wip", "fixup! wip", "fixup! wip", "staging: keep the selection"];
  const initRows = subjects.map((s, i) => ({ id: i * 2, action: "pick", sha: (i + 1).toString(16).padStart(4, "0").repeat(10), shortSha: (i + 1).toString(16).padStart(7, "0"), subject: s }));
  window.dispatchEvent(new MessageEvent("message", { data: { type: "rebaseInit", headerComment: null, rows: initRows } }));
  await tick();
  const el = document.querySelector("gitstudio-rebase");
  await el.updateComplete;
  await tick();
  const $$ = (sel) => [...el.shadowRoot.querySelectorAll(sel)];
  const settle = async () => { await el.updateComplete; await tick(); await el.updateComplete; };
  const rows = () => $$(".list .row");
  const click = async (i, mods) => {
    const at = rows()[i].querySelector(".subject");
    at.dispatchEvent(new MouseEvent("mousedown", Object.assign({ bubbles: true, composed: true, cancelable: true }, mods || {})));
    at.dispatchEvent(new MouseEvent("click", Object.assign({ bubbles: true, composed: true, cancelable: true }, mods || {})));
    await settle();
  };
  await click(4);
  await click(6, { shiftKey: true });
  $$("button.set").find((b) => b.textContent.trim() === "Fixup").click();
  await settle();
  expect(rows().filter((r) => r.getAttribute("aria-selected") === "true").length === 3, "three commits selected");
  expect(!!el.shadowRoot.querySelector("button.set.current"), "the toolbar shows what they are set to");
  if (HC) {
    expect(getComputedStyle(rows()[4]).outlineStyle !== "none", "high contrast: a selected card is ringed");
    expect(getComputedStyle(el.shadowRoot.querySelector("button.set.current")).outlineStyle === "solid", "…and the action they are set to");
    sweep("a rebase selection");
  } else {
    sweep("a rebase selection", { targets: [".row.selected", "button.set.current"] });
  }
`;

for (const theme of THEMES) {
  test(`the git-rebase-todo editor: the selection and its action are lit, not lined (${theme})`, { skip }, async () => {
    await run(fileURLToPath(new URL("../src/rebase/main.ts", import.meta.url)), theme, REBASE, {
      size: "height:700px;width:1000px",
      ground: "editor",
      prelude: `window.acquireVsCodeApi = function () { return { postMessage: function () {}, getState: function () {}, setState: function () {} }; };`,
    });
  });
}

// ── The Pull Requests list and a pull request's page ────────────────────────

const PR_LIST = `
  const { PullRequestList, FakeClock, listScenes } = window.__prl;
  const S = listScenes();
  const root = document.getElementById("root");
  const list = new PullRequestList(root, { post: () => {}, timers: new FakeClock() });
  list.render({ ...S.filtered, seq: 11 });
  await new Promise((r) => setTimeout(r, 60));
  list.render({ ...S.open, filters: { label: "bug" }, seq: 12 });
  await new Promise((r) => setTimeout(r, 60));
  expect(!!root.querySelector(".prl-row.is-checked-out"), "a row is checked out here");
  expect(!!root.querySelector(".prl-filter-btn.is-active"), "a filter is applied");
  sweep("the pull requests list", HC ? {} : { targets: [".prl-row.is-checked-out", ".prl-filter-btn.is-active"] });
`;

const PR_PAGE = `
  const { PullRequestPage, pageScenes } = window.__prp;
  const S = pageScenes();
  const root = document.getElementById("root");
  const page = new PullRequestPage(root, { post: () => {}, preferredMethod: "squash" });
  const frame = () => new Promise((r) => setTimeout(r, 60));
  const $ = (sel) => root.querySelector(sel) || document.querySelector(".prp-layer " + sel);
  page.render({ ...S.ready, seq: 11 });
  await frame();
  expect(!!$(".prp-tab.is-on"), "a tab in front");
  expect(!!$(".prp-branch.is-current"), "the branch checked out here");
  if (HC) {
    expect(getComputedStyle($(".prp-tab.is-on")).outlineStyle === "solid", "high contrast: the tab in front is ringed whole");
    sweep("the page, the tab in front");
  } else {
    sweep("the page, the tab in front", { targets: [".prp-tab.is-on", ".prp-branch.is-current"] });
  }
  // The merge box: a method chosen.
  $(".prp-actions .gs-btn--primary").click();
  await frame();
  expect(!!$(".prp-method.is-on"), "a merge method chosen");
  sweep("the merge box", HC ? {} : { targets: [".prp-method.is-on"] });
  $(".prp-actions .gs-btn--primary").click();
  await frame();
  // The review box: a verdict chosen.
  page.render({ ...S.open, seq: 12 });
  await frame();
  $('[data-act="approve"]').click();
  await frame();
  expect(!!$(".prp-verdict.is-on"), "a verdict chosen");
  sweep("the review box", HC ? {} : { targets: [".prp-verdict.is-on"] });
`;

for (const theme of THEMES) {
  test(`the Pull Requests list: the checked-out row and an applied filter are lit, not lined (${theme})`, { skip }, async () => {
    await run(fileURLToPath(new URL("./fixtures/prListEntry.ts", import.meta.url)), theme, PR_LIST, { width: 340, height: 900, size: "" });
  });

  test(`a pull request's page: the tab in front, a verdict, a method and the branch here are lit, not lined (${theme})`, { skip }, async () => {
    await run(fileURLToPath(new URL("./fixtures/prPageEntry.ts", import.meta.url)), theme, PR_PAGE, { width: 1000, height: 900, size: "", ground: "editor" });
  });
}
