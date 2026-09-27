import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * Selecting several commits with the mouse and the keyboard (issue #32), in the
 * real <gitstudio-graph> and <gitstudio-commit-rail>: what each gesture selects,
 * what it tells the host, what a screen reader is told, and — asserted from
 * COMPUTED styles, since a class with no rule fails silently — that selected
 * rows look selected and the focused row looks different, in a dark and a
 * light theme.
 *
 * Events are dispatched where a person's would land: a click on a row's
 * subject, keys on the focused scroller.
 */
const CHROME = findChrome();

/** VS Code's own values for the tokens these rules read, per theme. */
const THEMES = {
  dark: {
    "--vscode-list-activeSelectionBackground": "#04395e",
    "--vscode-list-activeSelectionForeground": "#ffffff",
    "--vscode-list-hoverBackground": "#2a2d2e",
    "--vscode-focusBorder": "#007fd4",
    "--vscode-editor-background": "#1e1e1e",
    "--vscode-foreground": "#cccccc",
    "--gs-accent": "#3794ff",
    "--gs-bg": "#1e1e1e",
    "--gs-fg": "#cccccc",
  },
  light: {
    "--vscode-list-activeSelectionBackground": "#0060c0",
    "--vscode-list-activeSelectionForeground": "#ffffff",
    "--vscode-list-hoverBackground": "#e8e8e8",
    "--vscode-focusBorder": "#0090f1",
    "--vscode-editor-background": "#ffffff",
    "--vscode-foreground": "#616161",
    "--gs-accent": "#005fb8",
    "--gs-bg": "#ffffff",
    "--gs-fg": "#3b3b3b",
  },
} as const;

const css = (tag: string, theme: keyof typeof THEMES) =>
  `:root{${Object.entries(THEMES[theme]).map(([k, v]) => `${k}:${v}`).join(";")}}` +
  `body{background:${THEMES[theme]["--vscode-editor-background"]}}` +
  `#root{height:700px;display:flex;flex-direction:column} ${tag}{flex:1;min-height:0}`;

const COMMON = `
  const sha = (i) => (i === 0 ? "0".repeat(40) : i.toString(16).padStart(4, "0").repeat(10));
  const row = (i) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: i === 0 ? "" : "commit " + i, author: "Ada Lovelace", authorEmail: "ada@example.com",
    authorDate: 1700000000 - i * 3600, refs: [],
  });
  const rows = Array.from({ length: 30 }, (_, i) => row(i)); // row 0 is the uncommitted-changes node
  const raf = () => new Promise((r) => { let done = false; const fin = () => { if (!done) { done = true; setTimeout(r, 0); } }; requestAnimationFrame(fin); setTimeout(fin, 50); });
  const settle = async (el) => { await el.updateComplete; await raf(); await el.updateComplete; };
  const actions = [];
  const R = (el, i) => el.shadowRoot.querySelector('.row[data-sha="' + sha(i) + '"]');
  const click = async (el, i, mods = {}) => {
    const target = R(el, i).querySelector(".subject") || R(el, i);
    target.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true, cancelable: true, ...mods }));
    await settle(el);
  };
  const rclick = async (el, i) => {
    const r = R(el, i);
    const b = r.getBoundingClientRect();
    (r.querySelector(".subject") || r).dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true, composed: true, cancelable: true, clientX: b.left + 60, clientY: b.top + b.height / 2 }));
    await settle(el);
  };
  const key = async (el, k, mods = {}) => {
    const sc = el.shadowRoot.querySelector(".scroller");
    sc.focus();
    const target = el.shadowRoot.activeElement || sc;
    target.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true, ...mods }));
    await settle(el);
  };
  /** Indices of the rows the DOM marks selected, and the focused one. */
  const selectedRows = (el) => [...el.shadowRoot.querySelectorAll('.row[aria-selected="true"]')].map((r) => rows.findIndex((x) => x.sha === r.dataset.sha)).sort((a, b) => a - b);
  const focusedRow = (el) => { const r = el.shadowRoot.querySelector(".row.focused"); return r ? rows.findIndex((x) => x.sha === r.dataset.sha) : -1; };
  const last = (type) => [...actions].reverse().find((a) => a.type === type);
  const idx = (shas) => (shas || []).map((s) => rows.findIndex((x) => x.sha === s));
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const escapesAtDocument = { n: 0 };
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") escapesAtDocument.n++; });
`;

/** The gestures both lists answer the same way; `extra` for what only one does. */
const BODY = (tag: string, ready: string, extra: string) => `
  const el = document.createElement("${tag}");
  el.onAction = (a) => actions.push(a);
  ${ready}
  document.getElementById("root").replaceChildren(el);
  await settle(el);
  el.rows = rows; el.totalColumns = 1; el.hasMore = false; el.status = "ready";
  await settle(el);
  const sc = el.shadowRoot.querySelector(".scroller");
  expect(sc.getAttribute("aria-multiselectable") === "true", "the list tells a screen reader it is multi-select");

  // ── The mouse ──
  await click(el, 2);
  expect(eq(selectedRows(el), [2]), "a click selects one row: " + selectedRows(el));
  await click(el, 4, { metaKey: true });
  expect(eq(selectedRows(el), [2, 4]), "Cmd+click adds a row: " + selectedRows(el));
  await click(el, 5, { ctrlKey: true });
  expect(eq(selectedRows(el), [2, 4, 5]), "Ctrl+click adds a row too: " + selectedRows(el));
  await click(el, 4, { metaKey: true });
  expect(eq(selectedRows(el), [2, 5]), "Cmd+click on a selected row removes it: " + selectedRows(el));
  expect(focusedRow(el) === 4, "…and leaves the cursor on it: " + focusedRow(el));
  await click(el, 7, { shiftKey: true });
  expect(eq(selectedRows(el), [4, 5, 6, 7]), "Shift+click selects from the anchor to the row: " + selectedRows(el));
  expect(focusedRow(el) === 7, "the cursor is on the Shift-clicked row");
  await click(el, 1, { shiftKey: true, metaKey: true });
  expect(eq(selectedRows(el), [1, 2, 3, 4, 5, 6, 7]), "Cmd+Shift+click adds the range: " + selectedRows(el));

  // ── Looks: every selected row filled, the focused one LIT (a stronger
  //    fill), never barred — in computed style (the owner's rule: nothing
  //    selected wears a line; selectionIsLit.test.ts sweeps the rest) ──
  const bg = (i) => getComputedStyle(R(el, i)).backgroundColor;
  const clear = (c) => c === "rgba(0, 0, 0, 0)" || c === "transparent" || c === "";
  expect(!clear(bg(2)) && bg(2) === bg(5), "selected rows share a fill (" + bg(2) + " / " + bg(5) + ")");
  expect(bg(9) !== bg(2), "an unselected row does not have it (" + bg(9) + ")");
  expect(!clear(bg(1)) && bg(1) !== bg(5), "the focused row is lit: a fill of its own (" + bg(1) + " / " + bg(5) + ")");
  const lines = (i) => {
    const s = getComputedStyle(R(el, i));
    const strip = (w) => { const p = getComputedStyle(R(el, i), w); return p.content !== "none" && p.content !== "normal" && !clear(p.backgroundColor); };
    return [
      clear(s.borderLeftColor) || parseFloat(s.borderLeftWidth) === 0 ? "" : "border-left " + s.borderLeftColor,
      s.boxShadow === "none" ? "" : "box-shadow " + s.boxShadow,
      s.outlineStyle === "none" ? "" : "outline " + s.outlineStyle,
      strip("::before") ? "::before strip" : "",
      strip("::after") ? "::after strip" : "",
    ].filter(Boolean).join(", ");
  };
  expect(lines(1) === "", "the focused row wears no line (" + lines(1) + ")");
  expect(lines(5) === "", "nor does a selected one (" + lines(5) + ")");

  // ── Right-click ──
  actions.length = 0;
  await rclick(el, 5);
  expect(eq(selectedRows(el), [1, 2, 3, 4, 5, 6, 7]), "right-click inside the selection keeps it");
  const ctx = last("context");
  expect(ctx && eq(idx(ctx.shas), [1, 2, 3, 4, 5, 6, 7]), "…and the menu is for all of them, newest first: " + JSON.stringify(ctx && idx(ctx.shas)));
  await rclick(el, 12);
  expect(eq(selectedRows(el), [12]), "right-click outside it selects just that row: " + selectedRows(el));
  const ctx2 = last("context");
  expect(ctx2 && ctx2.shas === undefined && ctx2.sha === sha(12), "…and the menu is that commit's own");

  // ── The keyboard ──
  await click(el, 3);
  await key(el, "ArrowDown", { shiftKey: true });
  await key(el, "ArrowDown", { shiftKey: true });
  expect(eq(selectedRows(el), [3, 4, 5]), "Shift+↓ extends from the anchor: " + selectedRows(el));
  await key(el, "ArrowUp", { shiftKey: true });
  expect(eq(selectedRows(el), [3, 4]), "Shift+↑ shrinks it back: " + selectedRows(el));
  expect(focusedRow(el) === 4, "the cursor moved with it");
  expect(sc.getAttribute("aria-activedescendant") === R(el, 4).id && !!R(el, 4).id, "aria-activedescendant names the focused row");
  actions.length = 0;
  await key(el, "F10", { shiftKey: true });
  const kctx = last("context");
  expect(kctx && eq(idx(kctx.shas), [3, 4]), "Shift+F10 opens the menu for the selection: " + JSON.stringify(kctx));
  escapesAtDocument.n = 0;
  await key(el, "Escape");
  expect(eq(selectedRows(el), [4]), "Escape keeps only the focused row: " + selectedRows(el));
  expect(escapesAtDocument.n === 0, "…and that Escape is spent there, not also closing the host's pane");
  await key(el, "ArrowDown");
  expect(eq(selectedRows(el), [5]), "a plain ↓ moves to one row");

  // ── Enter on several: the focused row, alone — never one commit's details
  //    beside a list that still shows several ──
  await click(el, 3);
  await key(el, "ArrowDown", { shiftKey: true });
  actions.length = 0;
  await key(el, "Enter");
  expect(eq(selectedRows(el), [4]), "Enter with several keeps only the focused row: " + selectedRows(el));
  ${tag === "gitstudio-graph"
    ? `expect(last("select") && last("select").sha === sha(4) && !last("open"), "…and tells the host one commit is selected, once: " + JSON.stringify(actions));`
    : `expect(last("open") && last("open").sha === sha(4), "…and opens it: " + JSON.stringify(actions));`}

  // ── The menu key's menu takes the keyboard, and gives it back ──
  /** A key on whatever has focus now — the menu's item, once it has it. */
  const press = async (k) => {
    (el.shadowRoot.activeElement || document.activeElement).dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, composed: true, cancelable: true }));
    await settle(el);
  };
  await click(el, 3);
  await key(el, "ArrowDown", { shiftKey: true });
  actions.length = 0;
  await key(el, "F10", { shiftKey: true });
  const kc = last("context");
  // The host answers with the position the list sent, as both hosts do.
  el.showCommitMenu(kc.sha, kc.x, kc.y, "2 commits selected", [
    { id: "cherryPickMany", label: "Cherry-Pick 2 Commits" },
    { id: "revertMany", label: "Revert 2 Commits" },
  ], kc.shas);
  await settle(el);
  const mi = [...el.shadowRoot.querySelectorAll('[role="menuitem"]')];
  expect(mi.length === 2 && el.shadowRoot.activeElement === mi[0], "opened from the keyboard, the menu has focus: " + (el.shadowRoot.activeElement && el.shadowRoot.activeElement.className));
  await press("ArrowDown");
  expect(el.shadowRoot.activeElement === mi[1], "↓ walks the menu");
  expect(eq(selectedRows(el), [3, 4]), "…and the selection under it stays: " + selectedRows(el));
  await press("Escape");
  expect(!el.shadowRoot.querySelector('[role="menuitem"]'), "Escape closes it");
  expect(el.shadowRoot.activeElement === sc, "…and the list has the keyboard again: " + (el.shadowRoot.activeElement && el.shadowRoot.activeElement.className));
  expect(eq(selectedRows(el), [3, 4]), "with both still selected: " + selectedRows(el));

  // ── The uncommitted-changes row never shares a selection ──
  await click(el, 2);
  await click(el, 0, { metaKey: true });
  expect(eq(selectedRows(el), [0]), "Cmd+click on the uncommitted row selects it alone: " + selectedRows(el));
  await click(el, 3);
  await click(el, 0, { shiftKey: true });
  expect(eq(selectedRows(el), [1, 2, 3]), "a range up to it leaves it out: " + selectedRows(el));

  // ── A menu for several hands its commits back with the pick ──
  el.showCommitMenu(sha(2), 40, 40, "3 commits", [{ id: "cherryPickMany", label: "Cherry-Pick 3 Commits" }], [sha(1), sha(2), sha(3)]);
  await settle(el);
  actions.length = 0;
  const item = [...el.shadowRoot.querySelectorAll('[role="menuitem"]')].find((b) => b.textContent.includes("Cherry-Pick 3 Commits"));
  expect(!!item, "the menu renders its item");
  if (item) { item.click(); await settle(el); }
  const picked = last("menuAction");
  expect(picked && picked.id === "cherryPickMany" && eq(idx(picked.shas), [1, 2, 3]), "the pick carries the commits: " + JSON.stringify(picked));

  ${extra}
`;

const GRAPH_EXTRA = `
  // What the graph tells its host: one commit is "select", several "selection".
  actions.length = 0;
  await click(el, 8);
  expect(last("select") && last("select").sha === sha(8), "one row: select");
  await click(el, 10, { shiftKey: true });
  const s = last("selection");
  expect(s && eq(idx(s.shas), [8, 9, 10]), "several: selection, newest first: " + JSON.stringify(s && idx(s.shas)));
  actions.length = 0;
  await click(el, 9);
  expect(last("select") && last("select").sha === sha(9) && !last("showDetails"), "a plain click on one of several selects just it");
  actions.length = 0;
  await click(el, 9);
  expect(last("showDetails") && !last("select"), "clicking the one selected row again only shows its details, as before");
  // A modified press is a selection gesture, never the start of a drag.
  // The rows changed under a selection of several: the host hears what is left.
  await click(el, 8);
  await click(el, 10, { shiftKey: true });
  actions.length = 0;
  el.rows = rows.filter((_, i) => i !== 9 && i !== 10);
  await settle(el);
  const after = last("select") || last("selection");
  expect(after && after.type === "select" && after.sha === sha(8), "two of three gone: the one left is selected, and said: " + JSON.stringify(after));
`;

/** The details pane with several commits selected: a summary, never one commit's details. */
const SUMMARY = `
  const el = document.createElement("gitstudio-commit-details");
  const events = [];
  for (const t of ["gs-selection-action", "gs-reveal", "gs-contains"]) el.addEventListener(t, (e) => events.push({ type: t, detail: e.detail }));
  document.getElementById("root").replaceChildren(el);
  const sha = (i) => i.toString(16).padStart(4, "0").repeat(10);
  const commits = [1, 2, 3].map((i) => ({ sha: sha(i), shortSha: sha(i).slice(0, 7), subject: "commit " + i, author: i === 2 ? "Mira Holt" : "Ada Lovelace", authorDate: 1700000000 - i * 3600 }));
  // A commit's details are on screen first; the selection replaces them.
  el.details = { kind: "commit", sha: sha(9), shortSha: sha(9).slice(0, 7), parents: [], author: "X", authorEmail: "", authorDate: 1, committer: "X", committerEmail: "", committerDate: 1, subject: "the ONE commit", body: "", refs: [], files: [], hasRemote: false };
  el.selection = { commits };
  await el.updateComplete;
  const sr = el.shadowRoot;
  const text = (sel) => (sr.querySelector(sel)?.textContent || "").trim().replace(/\\s+/g, " ");
  expect(text(".sum-title") === "3 commits selected", "the pane says how many: " + text(".sum-title"));
  expect(!sr.textContent.includes("the ONE commit"), "…and does not show one commit's details as if they were all");
  expect(/by Ada Lovelace and Mira Holt/.test(text(".sum-sub")), "who: " + text(".sum-sub"));
  const rowsEl = [...sr.querySelectorAll(".sum-row")];
  expect(rowsEl.length === 3, "every selected commit is listed: " + rowsEl.length);
  expect(rowsEl[0] && rowsEl[0].textContent.includes(sha(1).slice(0, 7)), "newest first, as the graph lists them");
  expect(rowsEl.every((r) => r.getAttribute("aria-label") && r.title === "Select only this commit"), "each row says what a click does");
  const actionsEl = sr.querySelector(".actions");
  const listTop = sr.querySelector(".sum-list").getBoundingClientRect().top;
  const hBefore = actionsEl.getBoundingClientRect().height;
  expect(hBefore >= 30, "the action row holds its height before the host answers (" + hBefore + "px)");
  expect(actionsEl.getAttribute("aria-busy") === "true", "…and says it is waiting");
  el.selection = { commits, actions: [
    { id: "cherryPickMany", label: "Cherry-Pick 3 Commits", icon: "git-pull-request" },
    { id: "", label: "", sep: true },
    { id: "dropMany", label: "Drop 3 Commits…", icon: "trash", danger: true },
  ] };
  await el.updateComplete;
  const hAfter = actionsEl.getBoundingClientRect().height;
  expect(Math.abs(hAfter - hBefore) < 1, "nothing moves when the actions land (" + hBefore + " → " + hAfter + ")");
  expect(sr.querySelector(".sum-list").getBoundingClientRect().top === listTop, "the list stays put");
  const btns = [...sr.querySelectorAll(".actions .act")];
  expect(btns.length === 2, "the host's items, separators skipped: " + btns.length);
  expect(btns.every((b) => b.getAttribute("aria-label") && b.title), "each action says what it does");
  expect(getComputedStyle(btns[0]).borderStyle !== "none" && getComputedStyle(btns[0]).cursor === "pointer", "the actions are styled as the pane's buttons (" + getComputedStyle(btns[0]).borderStyle + ")");
  btns[1].click();
  const a = events.find((e) => e.type === "gs-selection-action");
  expect(a && a.detail.id === "dropMany" && JSON.stringify(a.detail.shas) === JSON.stringify(commits.map((c) => c.sha)), "an action carries every commit: " + JSON.stringify(a));
  rowsEl[1].click();
  const r = events.find((e) => e.type === "gs-reveal");
  expect(r && r.detail.sha === sha(2), "a row keeps just that commit: " + JSON.stringify(r));
  expect(!events.some((e) => e.type === "gs-contains"), "a summary asks the host nothing");
  el.selection = null;
  await el.updateComplete;
  expect(text(".subject") === "the ONE commit", "cleared, the pane is one commit's details again");
`;

test("the details pane with several selected is a summary with their actions", { skip: !CHROME && "no Chrome on this machine" }, async () => {
  const v = await runInChrome(
    CHROME!,
    fileURLToPath(new URL("../src/commit-details.ts", import.meta.url)),
    SUMMARY,
    { css: css("gitstudio-commit-details", "dark"), width: 700, height: 700 },
  );
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

for (const theme of ["dark", "light"] as const) {
  test(`the commit graph: select several with the mouse and the keyboard (${theme})`, { skip: !CHROME && "no Chrome on this machine" }, async () => {
    const v = await runInChrome(
      CHROME!,
      fileURLToPath(new URL("../src/graph/commit-graph.ts", import.meta.url)),
      COMMON + BODY("gitstudio-graph", 'el.status = "loading";', GRAPH_EXTRA),
      { css: css("gitstudio-graph", theme), width: 1000, height: 800 },
    );
    assert.deepEqual(v.fails, [], v.fails.join("\n"));
  });

  test(`the Commits list: select several with the mouse and the keyboard (${theme})`, { skip: !CHROME && "no Chrome on this machine" }, async () => {
    const v = await runInChrome(
      CHROME!,
      fileURLToPath(new URL("../src/graph/commit-rail.ts", import.meta.url)),
      COMMON + BODY("gitstudio-commit-rail", 'el.status = "loading"; el.head = sha(1);', ""),
      { css: css("gitstudio-commit-rail", theme), width: 520, height: 800 },
    );
    assert.deepEqual(v.fails, [], v.fails.join("\n"));
  });
}
