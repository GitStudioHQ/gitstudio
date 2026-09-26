import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * The extension's Commit Graph webview (graph/main.ts) with several commits
 * selected (issue #32): what it posts to the host — `selectCommits` for the
 * summary, `contextMenu` and `commitMenuAction` with `shas` — and what it does
 * with the host's answers: the "N commits selected" summary in the details
 * dock, its actions once `commitsSummary` lands (and not for a selection that
 * has since changed), and the menu for several. The real entry, with
 * acquireVsCodeApi stubbed the way the webview host provides it.
 */
const CHROME = findChrome();

const PRELUDE = `
  window.__posted = [];
  window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState() {}, setState() {} });
`;

const SCRIPT = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    sha: sha(i + 1), shortSha: sha(i + 1).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + (i + 1), author: i % 2 ? "Mira Holt" : "Ada Lovelace", authorEmail: "a@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  }));
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = (m) => window.dispatchEvent(new MessageEvent("message", { data: m }));
  host({ type: "graphInit", rows, head: sha(1), totalColumns: 1, hasMore: false, refFilter: null, refList: [] });
  await wait(300);
  const graph = document.querySelector("gitstudio-graph");
  const details = document.querySelector("gitstudio-commit-details");
  const sr = graph.shadowRoot;
  const R = (i) => sr.querySelector('.row[data-sha="' + sha(i) + '"]');
  const click = async (i, mods = {}) => { R(i).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ...mods })); await wait(200); };
  const posted = (type) => window.__posted.filter((m) => m.type === type);
  const shell = document.querySelector(".gs-shell");

  await click(2);
  expect(posted("selectCommit").at(-1)?.sha === sha(2), "one commit: selectCommit, as before");
  await click(4, { shiftKey: true });
  const sel = posted("selectCommits").at(-1);
  expect(sel && JSON.stringify(sel.shas) === JSON.stringify([sha(2), sha(3), sha(4)]), "several: selectCommits, newest first: " + JSON.stringify(sel));
  await details.updateComplete;
  const dsr = details.shadowRoot;
  expect((dsr.querySelector(".sum-title")?.textContent || "").trim() === "3 commits selected", "the dock says how many");
  expect(shell.dataset.detailsOpen === "true", "and is open");
  expect(dsr.querySelectorAll(".actions .act").length === 0, "no actions until the host says which apply");

  // A late answer for a DIFFERENT selection is dropped.
  host({ type: "commitsSummary", shas: [sha(2), sha(3)], items: [{ id: "copyShas", label: "Copy SHAs", icon: "copy" }] });
  await wait(50); await details.updateComplete;
  expect(dsr.querySelectorAll(".actions .act").length === 0, "an answer for another selection is not shown");
  host({ type: "commitsSummary", shas: [sha(2), sha(3), sha(4)], items: [
    { id: "cherryPickMany", label: "Cherry-Pick 3 Commits", icon: "git-pull-request" },
    { id: "", label: "", sep: true },
    { id: "copyShas", label: "Copy SHAs", icon: "copy" },
  ] });
  await wait(50); await details.updateComplete;
  const acts = [...dsr.querySelectorAll(".actions .act")];
  expect(acts.map((b) => b.textContent.trim()).join(" | ") === "Cherry-Pick 3 Commits | Copy SHAs", "the host's items: " + acts.map((b) => b.textContent.trim()).join(" | "));
  window.__posted.length = 0;
  acts[0]?.click();
  await wait(50);
  const run = posted("commitMenuAction").at(-1);
  expect(run && run.id === "cherryPickMany" && JSON.stringify(run.shas) === JSON.stringify([sha(2), sha(3), sha(4)]), "a summary action runs for all of them: " + JSON.stringify(run));

  // Right-click inside: the menu is asked for, with every commit.
  const b = R(3).getBoundingClientRect();
  R(3).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: b.left + 60, clientY: b.top + 10 }));
  await wait(100);
  const ctx = posted("contextMenu").at(-1);
  expect(ctx && JSON.stringify(ctx.shas) === JSON.stringify([sha(2), sha(3), sha(4)]), "contextMenu carries the selection: " + JSON.stringify(ctx));
  host({ type: "commitMenu", sha: sha(2), shas: ctx?.shas, x: 40, y: 40, title: "3 commits selected", items: [{ id: "revertMany", label: "Revert 3 Commits" }] });
  await wait(100);
  const item = [...sr.querySelectorAll('[role="menuitem"]')].find((x) => x.textContent.includes("Revert 3 Commits"));
  expect(!!item, "the menu for several renders");
  window.__posted.length = 0;
  item?.click();
  await wait(50);
  const pick = posted("commitMenuAction").at(-1);
  expect(pick && pick.id === "revertMany" && pick.shas?.length === 3, "its pick carries the commits: " + JSON.stringify(pick));

  // A row of the summary keeps just that commit — the dock shows it again.
  await details.updateComplete;
  window.__posted.length = 0;
  dsr.querySelectorAll(".sum-row")[2]?.click();
  await wait(100); await details.updateComplete;
  expect(!dsr.querySelector(".sum-title"), "the summary gives way");
  expect(posted("selectCommit").at(-1)?.sha === sha(4), "and that commit's details are asked for");
  expect([...sr.querySelectorAll('.row[aria-selected="true"]')].map((r) => r.dataset.sha).join() === sha(4), "the graph selects just it");

  // Cmd-click the last one off: nothing selected, the dock's empty state.
  window.__posted.length = 0;
  await click(4, { metaKey: true });
  expect(JSON.stringify(posted("selectCommits").at(-1)?.shas) === "[]", "none selected is said as such");
  await details.updateComplete;
  expect(!!dsr.querySelector(".empty"), "and the dock shows its empty state");
`;

test("the extension's graph webview posts and shows a selection of several", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, fileURLToPath(new URL("../src/graph/main.ts", import.meta.url)), SCRIPT, {
    prelude: PRELUDE,
    rootAttrs: 'data-layout="dock"',
    width: 1100,
    height: 900,
    css: "#root{height:860px}",
  });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * The ways out of a selection of several that do not go through a click on a
 * row: the host revealing ONE commit (the Commits list's "Open in Commit
 * Graph", a blame click), Enter on the focused row, and the keyboard's menu
 * key. Each has to leave the dock describing what the graph shows.
 */
const EXITS = `
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    sha: sha(i + 1), shortSha: sha(i + 1).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "commit " + (i + 1), author: "Ada", authorEmail: "a@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  }));
  const details = (i) => ({ kind: "commit", sha: sha(i), shortSha: sha(i).slice(0, 7), parents: [], author: "Ada", authorEmail: "a@example.com", authorDate: 1700000000, committer: "Ada", committerEmail: "a@example.com", committerDate: 1700000000, subject: "commit " + i, body: "", refs: [], files: [], hasRemote: false });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const host = (m) => window.dispatchEvent(new MessageEvent("message", { data: m }));
  host({ type: "graphInit", rows, head: sha(1), totalColumns: 1, hasMore: false, refFilter: null, refList: [] });
  await wait(300);
  const graph = document.querySelector("gitstudio-graph");
  const dock = document.querySelector("gitstudio-commit-details");
  const sr = graph.shadowRoot;
  const dsr = dock.shadowRoot;
  const R = (i) => sr.querySelector('.row[data-sha="' + sha(i) + '"]');
  const click = async (i, mods = {}) => { R(i).dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ...mods })); await wait(200); };
  const posted = (type) => window.__posted.filter((m) => m.type === type);
  const selected = () => [...sr.querySelectorAll('.row[aria-selected="true"]')].map((r) => r.dataset.sha);
  const title = () => (dsr.querySelector(".sum-title")?.textContent || "").trim();
  const sc = sr.querySelector(".scroller");
  /** A key where a person's lands: the element that has focus in the graph. */
  const key = async (k, o = {}) => {
    (sr.activeElement || sc).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true, ...o }));
    await wait(150);
  };
  const three = [sha(2), sha(3), sha(4)];

  // ── The host reveals one commit while three are selected ──
  await click(2);
  await click(4, { shiftKey: true });
  await dock.updateComplete;
  expect(title() === "3 commits selected", "set-up: three selected");
  host({ type: "revealCommit", sha: sha(7) });
  host({ type: "commitDetails", details: details(7) });
  await wait(100); await dock.updateComplete;
  expect(selected().join() === sha(7), "the graph selects the revealed commit: " + selected().join());
  expect(!dsr.querySelector(".sum-title"), "the dock shows it, not the old summary: " + title());
  expect((dsr.querySelector(".subject")?.textContent || "").trim() === "commit 7", "…its details");
  // The summary's answer for the three, arriving late, is for a selection that is gone.
  host({ type: "commitsSummary", shas: three, items: [{ id: "dropMany", label: "Drop 3 Commits…", icon: "trash", danger: true }] });
  await wait(50); await dock.updateComplete;
  expect(!dsr.querySelector(".sum-title") && ![...dsr.querySelectorAll(".act")].some((b) => /Drop 3/.test(b.textContent)), "a late answer for the three does not bring their actions back");

  // ── Enter with three selected opens the focused one, alone ──
  await click(2);
  await click(4, { shiftKey: true });
  sc.focus();
  window.__posted.length = 0;
  await key("Enter");
  await dock.updateComplete;
  expect(selected().join() === sha(4), "Enter keeps only the focused row: " + selected().join());
  expect(!dsr.querySelector(".sum-title"), "and the dock is no longer the summary: " + title());
  expect(posted("selectCommit").map((m) => m.sha).join() === sha(4), "its details are asked for, once: " + JSON.stringify(posted("selectCommit")));

  // ── The keyboard's menu key, with three selected ──
  await click(2);
  await click(4, { shiftKey: true });
  sc.focus();
  window.__posted.length = 0;
  await key("F10", { shiftKey: true });
  const ctx = posted("contextMenu").at(-1);
  expect(ctx && JSON.stringify(ctx.shas) === JSON.stringify(three), "Shift+F10 asks for the menu for all three: " + JSON.stringify(ctx));
  // The host answers with the position the webview sent, as graphPanel does.
  host({ type: "commitMenu", sha: ctx.sha, shas: ctx.shas, x: ctx.x, y: ctx.y, title: "3 commits selected", items: [
    { id: "cherryPickMany", label: "Cherry-Pick 3 Commits" },
    { id: "revertMany", label: "Revert 3 Commits" },
  ] });
  await wait(150);
  const items = [...sr.querySelectorAll('.gh-pop [role="menuitem"]')];
  expect(items.length === 2, "the menu opens: " + items.length);
  expect(sr.activeElement === items[0], "opened from the keyboard, it takes focus: " + (sr.activeElement?.className || document.activeElement?.tagName));
  await key("ArrowDown");
  expect(sr.activeElement === items[1], "↓ walks the menu: " + (sr.activeElement?.textContent || "").trim());
  expect(selected().join() === three.join(), "…not the list under it: " + selected().join());
  await key("Escape");
  expect(!sr.querySelector(".gh-pop.gh-ctx"), "Escape closes it");
  expect(sr.activeElement === sc, "and hands the keyboard back to the list: " + (sr.activeElement?.className || ""));
  expect(selected().join() === three.join() && title() === "3 commits selected", "with the selection as it was");
  // A right-click's menu stays where the pointer is, and leaves focus alone.
  const b = R(3).getBoundingClientRect();
  R(3).dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, composed: true, cancelable: true, clientX: b.left + 60, clientY: b.top + 10 }));
  await wait(100);
  const mctx = posted("contextMenu").at(-1);
  host({ type: "commitMenu", sha: mctx.sha, shas: mctx.shas, x: mctx.x, y: mctx.y, title: "3 commits selected", items: [{ id: "revertMany", label: "Revert 3 Commits" }] });
  await wait(150);
  expect(!!sr.querySelector(".gh-pop.gh-ctx") && !sr.activeElement?.matches?.('[role="menuitem"]'), "a pointer's menu does not pull focus: " + (sr.activeElement?.className || ""));
`;

test("the extension's graph webview: a reveal, Enter and the menu key out of a selection of several", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(CHROME!, fileURLToPath(new URL("../src/graph/main.ts", import.meta.url)), EXITS, {
    prelude: PRELUDE,
    rootAttrs: 'data-layout="dock"',
    width: 1100,
    height: 900,
    css: "#root{height:860px}",
  });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});
