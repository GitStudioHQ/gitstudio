import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type Modifier } from "./changesPage";

// A row's menu is the keyboard's way to the row's buttons.
//
// The Changes list is one tab stop, and the buttons on its rows — Stage,
// Unstage, Discard, on files, folders and group headers — are the pointer's,
// out of the tab order. The row's menu (Shift+F10, the menu key, a right-click)
// was said to carry the same actions. It did for files only: a folder and a
// group header had no menu at all, so Stage Folder, Unstage All and Discard
// All had no keyboard route. And the menu dropped the keyboard on the page
// when it closed — after Stage, after Escape — so the row it had just staged
// could not hand the keyboard to the next one, and the arrows did nothing.
//
// The tables: {split, checkbox model} × {list, tree layout} × every row that
// has buttons × each of its buttons — the menu offers it, and choosing it
// from the keyboard posts exactly what the button posts; and where the
// keyboard is after each way a menu closes. Keys are real key events.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

type Entry = { path: string; status: string };
const MERGE: Entry[] = [{ path: "src/m.ts", status: "!" }];
const STAGED: Entry[] = [{ path: "src/a.ts", status: "M" }];
const UNSTAGED: Entry[] = [
  { path: "README.md", status: "M" },
  { path: "src/lib/b.ts", status: "M" },
  { path: "src/lib/c.ts", status: "U" },
];
type Model = "split" | "checkboxes";
type Layout = "list" | "tree";

/**
 * What each row button is called in the row's menu. A button this table does
 * not know is a failure: every button needs its keyboard route written down.
 */
const MENU_LABEL: Record<string, string> = {
  "Stage file": "Stage",
  "Unstage file": "Unstage",
  "Discard changes": "Discard Changes",
  "Stage folder": "Stage Folder",
  "Unstage folder": "Unstage Folder",
  "Discard folder": "Discard Folder",
  "Stage All": "Stage All",
  "Unstage All": "Unstage All",
  "Discard All": "Discard All",
};

function stateOf(model: Model, layout: Layout, lists = { merge: MERGE, staged: STAGED, unstaged: UNSTAGED }) {
  return {
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    ...lists,
    stagingModel: model,
    layout,
  };
}

async function fresh(page: ChangesPage, model: Model, layout: Layout, lists?: Parameters<typeof stateOf>[2]): Promise<void> {
  await page.reload();
  await page.send(stateOf(model, layout, lists));
  await page.eval("window.__posted = []");
}

/** The rows a person can see, with the names of the buttons on each. */
async function rowsWithButtons(page: ChangesPage): Promise<{ tkey: string; buttons: string[] }[]> {
  return page.eval(`Array.prototype.filter.call(
    document.querySelectorAll('#groups [role="treeitem"]'),
    function (n) { return n.offsetParent !== null; }
  ).map(function (n) {
    var own = n.classList.contains("group-header") ? n.querySelectorAll(".group-actions button") : n.querySelectorAll(".row-actions button");
    return { tkey: n.dataset.tkey, buttons: Array.prototype.map.call(own, function (b) { return b.getAttribute("aria-label"); }) };
  }).filter(function (r) { return r.buttons.length > 0; })`);
}

const focusRow = (page: ChangesPage, tkey: string) =>
  page.eval(`document.querySelector('[data-tkey="${tkey}"]').focus()`);

async function openMenu(page: ChangesPage, how: "Shift+F10" | "ContextMenu"): Promise<void> {
  if (how === "Shift+F10") await page.key("F10", { with: ["shift"] as Modifier[] });
  else await page.key("ContextMenu");
}

const menuState = (page: ChangesPage) =>
  page.eval<{ open: boolean; focusInMenu: boolean; focused: string | null; items: string[] }>(`(function () {
    var m = document.querySelector(".action-menu");
    var a = document.activeElement;
    return {
      open: !!m,
      focusInMenu: !!m && m.contains(a),
      focused: m && m.contains(a) ? a.textContent.trim() : null,
      items: m ? Array.prototype.map.call(m.querySelectorAll(".bm-subaction"), function (b) { return b.textContent.trim(); }) : [],
    };
  })()`);

/** Walk the open menu with Down until `label` has the keyboard; false if it is not there. */
async function downTo(page: ChangesPage, label: string): Promise<boolean> {
  for (let i = 0; i < 16; i++) {
    const s = await menuState(page);
    if (s.focused === label) return true;
    await page.key("ArrowDown");
  }
  return false;
}

const withoutReady = (m: Record<string, unknown>[]) => m.filter((x) => x.type !== "ready");

for (const model of ["split", "checkboxes"] as Model[]) {
  for (const layout of ["list", "tree"] as Layout[]) {
    test(`every row button has a keyboard route: ${model} model, ${layout} layout — its row's menu offers it and posts what it posts`, { skip }, async () => {
      const page = await ChangesPage.open("dark", { width: 460, height: 720 });
      opened.push(page);
      await fresh(page, model, layout);
      const rows = await rowsWithButtons(page);
      // Each kind of row with buttons is in the table.
      const kinds = new Set(rows.map((r) => r.tkey.slice(0, 2)));
      assert.deepEqual([...kinds].sort(), (layout === "tree" ? ["d:", "f:", "g:"] : ["f:", "g:"]).sort(), `row kinds: ${[...kinds]}`);
      const failures: string[] = [];
      let cells = 0;
      for (const row of rows) {
        for (const button of row.buttons) {
          cells++;
          const where = `${row.tkey} / ${button}`;
          const label = MENU_LABEL[button];
          if (!label) {
            failures.push(`${where}: a button the table has no menu item for`);
            continue;
          }
          // The pointer: the button itself.
          await fresh(page, model, layout);
          await page.eval(`(function () {
            var n = document.querySelector('[data-tkey="${row.tkey}"]');
            var own = n.classList.contains("group-header") ? n.querySelectorAll(".group-actions button") : n.querySelectorAll(".row-actions button");
            Array.prototype.filter.call(own, function (b) { return b.getAttribute("aria-label") === ${JSON.stringify(button)}; })[0].click();
          })()`);
          const byPointer = withoutReady(await page.posted());
          // The keyboard: the row, its menu, Down to the item, Enter.
          await fresh(page, model, layout);
          await focusRow(page, row.tkey);
          await openMenu(page, cells % 2 ? "Shift+F10" : "ContextMenu");
          const s = await menuState(page);
          if (!s.open || !s.focusInMenu) {
            failures.push(`${where}: no menu (open ${s.open}, keyboard in it ${s.focusInMenu})`);
            continue;
          }
          if (!(await downTo(page, label))) {
            failures.push(`${where}: Down never reaches "${label}" in the menu (${JSON.stringify(s.items)})`);
            continue;
          }
          await page.eval("window.__posted = []");
          await page.key("Enter", { typed: true });
          const byKeyboard = withoutReady(await page.posted());
          if (byPointer.length === 0) failures.push(`${where}: the button posted nothing`);
          if (JSON.stringify(byKeyboard) !== JSON.stringify(byPointer)) {
            failures.push(`${where}: the menu posted ${JSON.stringify(byKeyboard)}, the button ${JSON.stringify(byPointer)}`);
          }
        }
      }
      assert.ok(cells >= 8, `${cells} cells`);
      assert.deepEqual(failures, [], `${failures.length} of ${cells} cells wrong`);
    });
  }
}

// ── Where the keyboard is after the menu closes ─────────────────────────────

type Focus = { tkey: string | null; shown: boolean; tag: string };
const focusNow = (page: ChangesPage) =>
  page.eval<Focus>(`(function () {
    var a = document.activeElement;
    var t = a && a.dataset ? a.dataset.tkey || null : null;
    return { tkey: t, shown: !!t && a.offsetParent !== null, tag: a ? a.tagName : "none" };
  })()`);

const visibleKeys = (page: ChangesPage) =>
  page.eval<string[]>(`Array.prototype.filter.call(
    document.querySelectorAll('#groups [role="treeitem"]'),
    function (n) { return n.offsetParent !== null; }
  ).map(function (n) { return n.dataset.tkey; })`);

/** The row the keyboard should go to when `from` leaves the list: the next one still shown, else the one before. */
function handoff(before: string[], after: string[], from: string): string | null {
  const i = before.indexOf(from);
  for (let j = i + 1; j < before.length; j++) if (after.includes(before[j])) return before[j];
  for (let j = i - 1; j >= 0; j--) if (after.includes(before[j])) return before[j];
  return after[0] ?? null;
}

type Cell = {
  name: string;
  model: Model;
  layout: Layout;
  row: string;
  item: string;
  /** The host's next state, as git would report it after the action. */
  next?: { merge: Entry[]; staged: Entry[]; unstaged: Entry[] };
  /** "row": the keyboard stays on the row; "handoff": the row left, the keyboard moves on. */
  want: "row" | "handoff";
};

const moved = (from: "staged" | "unstaged", paths: string[]) => {
  const take = (l: Entry[]) => l.filter((e) => paths.includes(e.path));
  const keep = (l: Entry[]) => l.filter((e) => !paths.includes(e.path));
  return from === "unstaged"
    ? { merge: MERGE, staged: [...STAGED, ...take(UNSTAGED)], unstaged: keep(UNSTAGED) }
    : { merge: MERGE, staged: keep(STAGED), unstaged: [...UNSTAGED, ...take(STAGED)] };
};

const CELLS: Cell[] = [
  // A file staged from its menu leaves Unstaged: the keyboard goes to the next row.
  { name: "Stage a file", model: "split", layout: "list", row: "f:unstaged:src/lib/b.ts", item: "Stage", next: moved("unstaged", ["src/lib/b.ts"]), want: "handoff" },
  { name: "Stage the last unstaged file", model: "split", layout: "list", row: "f:unstaged:src/lib/c.ts", item: "Stage", next: moved("unstaged", ["src/lib/c.ts"]), want: "handoff" },
  { name: "Unstage the only staged file", model: "split", layout: "list", row: "f:staged:src/a.ts", item: "Unstage", next: moved("staged", ["src/a.ts"]), want: "handoff" },
  { name: "Stage a folder", model: "split", layout: "tree", row: "d:split:unstaged:src/lib", item: "Stage Folder", next: moved("unstaged", ["src/lib/b.ts", "src/lib/c.ts"]), want: "handoff" },
  { name: "Stage All", model: "split", layout: "list", row: "g:unstaged", item: "Stage All", next: moved("unstaged", UNSTAGED.map((e) => e.path)), want: "handoff" },
  { name: "Unstage All", model: "split", layout: "tree", row: "g:staged", item: "Unstage All", next: moved("staged", ["src/a.ts"]), want: "handoff" },
  // Discard asks first: the row stays until git says otherwise.
  { name: "Discard Changes (asks first)", model: "split", layout: "list", row: "f:unstaged:README.md", item: "Discard Changes", want: "row" },
  { name: "Discard All (asks first)", model: "split", layout: "list", row: "g:unstaged", item: "Discard All", want: "row" },
  { name: "Open Changes", model: "split", layout: "list", row: "f:unstaged:README.md", item: "Open Changes", want: "row" },
  // In the checkbox model a ticked file keeps its place, and the keyboard.
  { name: "Stage a file (checkboxes)", model: "checkboxes", layout: "list", row: "f:ck:src/lib/b.ts", item: "Stage", next: moved("unstaged", ["src/lib/b.ts"]), want: "row" },
  { name: "Stage a folder (checkboxes)", model: "checkboxes", layout: "tree", row: "d:checkboxes:unstaged:src/lib", item: "Stage Folder", next: moved("unstaged", ["src/lib/b.ts", "src/lib/c.ts"]), want: "row" },
];

test("choosing from a row's menu gives the keyboard back — to the row, or to the next one when the row leaves", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  const failures: string[] = [];
  for (const c of CELLS) {
    await fresh(page, c.model, c.layout);
    const before = await visibleKeys(page);
    await focusRow(page, c.row);
    await openMenu(page, "Shift+F10");
    if (!(await downTo(page, c.item))) {
      failures.push(`${c.name}: Down never reaches "${c.item}" in ${c.row}'s menu`);
      continue;
    }
    await page.key("Enter", { typed: true });
    // Right after the action (the list patched optimistically), and after the host's state.
    for (const when of ["at once", "after the host's state"]) {
      if (when !== "at once" && c.next) await page.send(stateOf(c.model, c.layout, c.next));
      else if (when !== "at once") continue;
      const f = await focusNow(page);
      const after = await visibleKeys(page);
      const want = c.want === "row" && after.includes(c.row) ? c.row : handoff(before, after, c.row);
      if (f.tkey !== want || !f.shown) {
        failures.push(`${c.name}, ${when}: the keyboard is on ${f.tkey ?? f.tag}${f.tkey && !f.shown ? " (hidden)" : ""}, expected ${want}`);
      }
    }
    // And the arrows work from there.
    const f = await focusNow(page);
    if (f.tkey) {
      await page.key("ArrowUp");
      const g = await focusNow(page);
      if (!g.tkey) failures.push(`${c.name}: ArrowUp after the menu lost the keyboard (${g.tag})`);
    }
  }
  assert.deepEqual(failures, []);
});

test("Escape, a click on nothing and a click elsewhere: the menu closes, and the keyboard is where it should be", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  for (const [model, row] of [
    ["split", "f:unstaged:src/lib/b.ts"],
    ["split", "g:staged"],
    ["checkboxes", "g:all"],
  ] as [Model, string][]) {
    await fresh(page, model, "tree");
    // Escape: back to the row.
    await focusRow(page, row);
    await openMenu(page, "Shift+F10");
    assert.equal((await menuState(page)).focusInMenu, true, `${row}: the menu has the keyboard`);
    await page.key("Escape");
    assert.equal((await menuState(page)).open, false);
    assert.equal((await focusNow(page)).tkey, row, `${model} ${row}: Escape gives the keyboard back to the row`);
    // A click on an empty part of the view: back to the row.
    await openMenu(page, "Shift+F10");
    await page.click(230, 700);
    await page.eval("new Promise(function (r) { setTimeout(r, 30); })");
    assert.equal((await menuState(page)).open, false);
    assert.equal((await focusNow(page)).tkey, row, `${model} ${row}: a click on nothing gives the keyboard back to the row`);
    // A click on the message box: the keyboard goes there, as aimed.
    await focusRow(page, row);
    await openMenu(page, "Shift+F10");
    const box = await page.eval<{ x: number; y: number }>(`(function () {
      var r = document.getElementById("message").getBoundingClientRect();
      return { x: r.x + 10, y: r.y + r.height / 2 };
    })()`);
    await page.click(box.x, box.y);
    await page.eval("new Promise(function (r) { setTimeout(r, 30); })");
    assert.equal(await page.eval<string>(`document.activeElement.id`), "message", `${model} ${row}: a click elsewhere keeps its aim`);
  }
});

test("the menu's own keys: Up and Down go round, Home and End to the ends, Tab stays inside; it is a menu of menuitems", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  await fresh(page, "split", "list");
  await focusRow(page, "f:unstaged:src/lib/b.ts");
  await openMenu(page, "Shift+F10");
  const s = await menuState(page);
  const items = s.items;
  assert.ok(items.length >= 5, JSON.stringify(items));
  assert.equal(s.focused, items[0], "the first item has the keyboard");
  const seq: (string | null)[] = [];
  for (const key of ["ArrowDown", "ArrowDown", "ArrowUp", "End", "ArrowDown", "ArrowUp", "Home", "ArrowUp", "Tab"]) {
    await page.key(key);
    seq.push((await menuState(page)).focused);
  }
  const last = items[items.length - 1];
  assert.deepEqual(seq, [items[1], items[2], items[1], last, items[0], last, items[0], last, items[0]]);
  await page.key("Tab", { with: ["shift"] });
  assert.equal((await menuState(page)).focused, last, "Shift+Tab goes back round, and stays in the menu");
  const roles = await page.eval<{ menu: string | null; label: string | null; items: (string | null)[] }>(`(function () {
    var m = document.querySelector(".action-menu");
    return {
      menu: m.getAttribute("role"),
      label: m.getAttribute("aria-label"),
      items: Array.prototype.map.call(m.querySelectorAll(".bm-subaction"), function (b) { return b.getAttribute("role"); }),
    };
  })()`);
  assert.equal(roles.menu, "menu");
  assert.equal(roles.label, "b.ts");
  assert.ok(roles.items.every((r) => r === "menuitem"), JSON.stringify(roles.items));
});
