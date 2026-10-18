import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { findChrome, runInChrome } from "./headless";

/**
 * A column the user has on is on screen, or the Columns menu says why not
 * (issue #124).
 *
 * The report: the Columns menu showed SHA ticked and the graph had no SHA
 * column. Two things did that. The bottom panel's compact layout had no SHA
 * track at all, whatever the menu said; and the editor tab dropped Date and
 * SHA below an 860px host whether or not they would have fitted — a
 * maximised laptop window with the details pane open is under that. The menu
 * counted only the columns the user had unticked, so it said "1 hidden" about
 * Date and nothing about SHA.
 *
 * Driven through the real webview entry in headless Chrome: what is on screen
 * is grid tracks, container queries and shadow DOM. Widths are changed in the
 * page and the graph is asked to update, because a ResizeObserver never runs
 * under the headless shell's virtual time; the observer calls the same
 * applyColumnStyles an update does.
 */
const ENTRY = fileURLToPath(new URL("../src/graph/main.ts", import.meta.url));
const CHROME = findChrome();
const skip = !CHROME && "no Chrome on this machine";

const prelude = (hidden: string[] = []) => `
  window.acquireVsCodeApi = () => ({ postMessage: () => {}, getState: () => undefined, setState: () => {} });
  try {
    localStorage.removeItem("gitstudio.graph.cols.widths");
    localStorage.setItem("gitstudio.graph.cols.hidden", ${JSON.stringify(JSON.stringify(hidden))});
  } catch {}
`;

const MOUNT = `
  const sha = (i) => (i + 1).toString(16).padStart(4, "0").repeat(10);
  const row = (i, refs) => ({
    sha: sha(i), shortSha: sha(i).slice(0, 7), column: 0, color: 0, isMerge: false,
    segments: [{ fromColumn: 0, toColumn: 0, color: 0 }],
    subject: "fix(shots): site shots splice page code through jsLiteral " + i,
    author: "Anton Arnaudov", authorEmail: "a@example.com",
    authorDate: 1700000000 - i * 3600, refs: refs || [],
  });
  const rows = [row(0, [{ name: "main", fullName: "refs/heads/main", kind: "currentHead" }])];
  for (let i = 1; i < 30; i++) rows.push(row(i));
  const root = document.getElementById("root");
  const graph = () => document.querySelector("gitstudio-graph");
  const sr = () => graph().shadowRoot;
  // A poll for a condition, not a fixed wait: it returns as soon as it holds.
  const until = async (probe, ms = 4000) => {
    const t0 = Date.now();
    while (!probe() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 10));
    return probe();
  };
  window.postMessage({ type: "graphInit", rows, head: sha(0), totalColumns: 1, hasMore: false, refFilter: null }, "*");
  await until(() => graph() && sr() && sr().querySelector('.row[data-sha="' + sha(0) + '"]'));
  const settle = async () => {
    window.dispatchEvent(new Event("resize"));
    graph().requestUpdate();
    await graph().updateComplete;
    // A second pass: the first may have moved the fit, which re-renders.
    graph().requestUpdate();
    await graph().updateComplete;
  };
  const resize = async (w) => { root.style.width = w + "px"; await settle(); };
  const CELL = { refs: ".refs", changes: ".changes", author: ".meta.author", date: ".meta.date", sha: ".meta.sha" };
  const HEAD = { refs: ".ch-refs", changes: ".ch-changes", author: ".ch-author", date: ".ch-date", sha: ".ch-sha" };
  const firstRow = () => sr().querySelector('.row[data-sha="' + sha(0) + '"]');
  const box = (el) => {
    if (!el) return null;
    const cs = getComputedStyle(el);
    if (cs.display === "none" || cs.visibility === "hidden") return null;
    const r = el.getBoundingClientRect();
    return r.width >= 1 ? r : null;
  };
  /** Is this column's cell on screen in the first row? */
  const cellBox = (id) => box(firstRow().querySelector(CELL[id]));
  /** The sha text's own extent, so a cell that clips its text is caught. */
  const shaTextFits = () => {
    const cell = firstRow().querySelector(CELL.sha);
    const r = box(cell);
    if (!r) return false;
    const text = [...cell.childNodes].find((n) => n.nodeType === 3);
    const range = document.createRange();
    range.selectNodeContents(text);
    const t = range.getBoundingClientRect();
    return t.width > 20 && t.right <= r.right + 0.5 && t.left >= r.left - 0.5;
  };
  const openMenu = async () => {
    if (!sr().querySelector(".gh-pop[role=menu]")) sr().querySelector(".gh-columns-btn").click();
    await graph().updateComplete;
    return sr().querySelector(".gh-pop[role=menu]");
  };
  /** What the Columns menu claims about each column. */
  const menuState = async () => {
    const pop = await openMenu();
    const items = [...pop.querySelectorAll("[role=menuitemcheckbox]")];
    return {
      items: items.map((it) => ({
        label: it.querySelector(".lbl").textContent.trim(),
        on: it.getAttribute("aria-checked") === "true",
        squeezed: !!it.querySelector(".gh-menu-note"),
      })),
      hint: (pop.querySelector(".gh-pop-hint")?.textContent || "").replace(/\\s+/g, " ").trim(),
    };
  };
  /** The current branch's chip shows its whole name, not "m…". */
  const chipWhole = () => {
    const nm = firstRow().querySelector(".chip .nm");
    return !!nm && nm.scrollWidth <= nm.clientWidth;
  };
  const LABEL = { refs: "Branch / Tag", changes: "Changes", author: "Author", date: "Date", sha: "SHA" };
`;

const run = (script: string, o: { layout: "side" | "dock"; width: number; hidden?: string[] }) =>
  runInChrome(CHROME!, ENTRY, MOUNT + script, {
    css: `#root{height:640px;width:${o.width}px}`,
    prelude: prelude(o.hidden),
    rootAttrs: o.layout === "side" ? 'data-layout="side"' : "",
    width: 1600,
    height: 720,
  });

test("the bottom panel shows an SHA column the user left on — with Date off, as reported", { skip }, async () => {
  const v = await run(`
    for (const w of [1170, 900, 700]) {
      await resize(w);
      const shaBox = cellBox("sha");
      expect(!!shaBox, w + "px: the SHA cell is on screen");
      if (!shaBox) continue;
      expect(shaTextFits(), w + "px: the whole short sha shows, not clipped");
      const author = cellBox("author");
      expect(!author || shaBox.left >= author.right - 1, w + "px: SHA sits in its own track, right of Author (" + (author && author.right) + " / " + shaBox.left + ")");
      const head = box(sr().querySelector(HEAD.sha));
      expect(!!head && Math.abs(head.left - shaBox.left) <= 2, w + "px: the SHA header sits over the SHA cells (" + (head && head.left) + " / " + shaBox.left + ")");
      expect(!cellBox("date"), w + "px: Date stays off, as the user set it");
    }
  `, { layout: "side", width: 1170, hidden: ["date"] });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the bottom panel keeps both Date and SHA when both are on and there is room", { skip }, async () => {
  const v = await run(`
    await resize(1170);
    const dateBox = cellBox("date"), shaBox = cellBox("sha");
    expect(!!dateBox && !!shaBox, "both on screen (date " + !!dateBox + ", sha " + !!shaBox + ")");
    expect(!!dateBox && !!shaBox && shaBox.left >= dateBox.right - 1, "SHA follows Date");
    expect(shaTextFits(), "the whole short sha shows");
  `, { layout: "side", width: 1170 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

test("the editor tab keeps Date and SHA under 860px while they fit, and gives up Date before SHA", { skip }, async () => {
  const v = await run(`
    for (const w of [840, 780]) {
      await resize(w);
      expect(!!cellBox("sha") && !!cellBox("date"), w + "px: Date and SHA on screen (date " + !!cellBox("date") + ", sha " + !!cellBox("sha") + ")");
      const subject = box(firstRow().querySelector(".subject"));
      expect(!!subject && subject.width >= 200, w + "px: the message keeps its floor (" + (subject && subject.width) + ")");
      expect(chipWhole(), w + "px: the branch chip still reads main, whole");
      const last = cellBox("sha");
      expect(!!last && last.right <= firstRow().getBoundingClientRect().right + 0.5, w + "px: nothing runs off the row");
    }
    // Narrower: there is room for one of them, and it is SHA.
    await resize(690);
    expect(!!cellBox("sha"), "690px: SHA on screen");
    expect(shaTextFits(), "690px: the whole short sha shows");
    expect(!cellBox("date"), "690px: Date has given way");
    const m = await menuState();
    const date = m.items.find((i) => i.label === "Date");
    expect(!!date && date.on && date.squeezed, "690px: the menu keeps Date ticked and says it has no room (" + JSON.stringify(date) + ")");
    expect(/Date/.test(m.hint), "690px: the menu's footer names Date (" + m.hint + ")");
  `, { layout: "dock", width: 840 });
  assert.deepEqual(v.fails, [], v.fails.join("\n"));
});

/**
 * The state table: every width, both layouts, with and without a column the
 * user unticked. A ticked column is on screen, or its menu row says it has no
 * room — never both, never neither. An unticked one is neither. And the
 * footer names every column that has no room.
 */
for (const layout of ["dock", "side"] as const) {
  for (const hidden of [[], ["date"]]) {
    test(`the Columns menu never claims a column that is not on screen — ${layout}, hidden ${JSON.stringify(hidden)}`, { skip }, async () => {
      const v = await run(`
        const seen = [];
        // Where each column went while the pane narrowed: a column that has
        // gone must not come back at a NARROWER width — one that blinks out
        // and in as you drag reads as a bug, whatever the reason.
        const goneAt = {};
        for (let w = 1400; w >= 300; w -= 10) {
          await resize(w);
          const host = graph().clientWidth;
          const m = await menuState();
          const squeezedLabels = [];
          for (const [id, label] of Object.entries(LABEL)) {
            const item = m.items.find((i) => i.label === label);
            if (!item) { expect(false, host + "px: no menu row for " + label); continue; }
            const shown = !!cellBox(id);
            // Where both are drawn, the header sits over its own cells.
            const hb = box(sr().querySelector(".colhead " + HEAD[id])), cb = cellBox(id);
            if (hb && cb && id !== "refs") expect(Math.abs(hb.left - cb.left) <= 2, host + "px: the " + label + " header sits over its cells (" + Math.round(hb.left) + " / " + Math.round(cb.left) + ")");
            if (!shown && item.on && goneAt[id] === undefined) goneAt[id] = host;
            if (shown && goneAt[id] !== undefined) expect(false, label + " went at " + goneAt[id] + "px and came back at " + host + "px");
            if (!item.on) {
              expect(!shown, host + "px: " + label + " is unticked yet on screen");
              expect(!item.squeezed, host + "px: " + label + " is unticked, so it is not 'no room'");
            } else {
              expect(shown !== item.squeezed, host + "px: " + label + " ticked, on screen " + shown + ", menu says no room " + item.squeezed);
              if (item.squeezed) squeezedLabels.push(label);
            }
          }
          for (const label of squeezedLabels) {
            expect(m.hint.includes(label), host + "px: the footer names " + label + " (" + m.hint + ")");
          }
          seen.push(host + ":" + squeezedLabels.join("+"));
        }
        notes.seen = seen;
        notes.goneAt = goneAt;
        // SHA is the narrowest column and the one that names a commit: it
        // stays wherever the layout is still a table of columns.
        const floor = ${layout === "dock" ? 470 : 350};
        for (let w = 1400; w >= floor; w -= 10) {
          await resize(w);
          expect(!!cellBox("sha"), graph().clientWidth + "px: SHA on screen");
          // ...and not at the cost of the branch name it sits beside.
          expect(chipWhole(), graph().clientWidth + "px: the branch chip reads main, whole");
        }
      `, { layout, width: 1400, hidden });
      assert.deepEqual(v.fails, [], v.fails.join("\n"));
    });
  }
}
