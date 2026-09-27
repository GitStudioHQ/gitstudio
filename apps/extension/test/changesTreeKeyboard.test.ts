import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// The Changes list from the keyboard, as a tree — the whole state table.
//
// Every row, tick and row button was its own tab stop (46 of them for six
// files), a row was a button whose name was every button inside it read
// together, and no arrow key did anything. The list is now one tree with one
// tab stop (a roving tabindex): Up/Down/Home/End move through what is
// showing, Right/Left open and close a group, a folder or a file's changes
// and step in and out of them, Enter opens, Space ticks in the checkbox model.
//
// The table: {split, checkbox model} × {list, tree layout} × every kind of row
// the layout shows (group header, folder, file, a file's change, the checkbox
// model's header) × {Down, Up, Home, End, Right, Left, Enter, Space}. The
// expectation for each cell is worked out HERE from the rows the page shows
// before the key — which item, its level, whether it is open — never read back
// from the page's own bookkeeping; the keys are real key events from DevTools.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const STAGED = [{ path: "src/a.ts", status: "M" }];
const UNSTAGED = [
  { path: "README.md", status: "M" },
  { path: "src/lib/b.ts", status: "M" },
  { path: "src/lib/c.ts", status: "U" },
];
const HUNKS = [
  { index: 0, start: 2, end: 6, lineCount: 5, preview: "## Install", state: "staged" },
  { index: 1, start: 40, end: 40, lineCount: 1, preview: "See CONTRIBUTING.md", state: "unstaged" },
];

type Model = "split" | "checkboxes";
type Layout = "list" | "tree";
type Kind = "group" | "checkhead" | "folder" | "file" | "hunk";

interface Item {
  tkey: string;
  level: number;
  expanded: string | null;
  checked: string | null;
  kind: Kind;
  path: string | null;
  staged: boolean;
}

function kindOf(tkey: string): Kind {
  if (tkey === "g:all") return "checkhead";
  if (tkey.startsWith("g:")) return "group";
  if (tkey.startsWith("d:")) return "folder";
  if (tkey.startsWith("h:")) return "hunk";
  return "file";
}

/** The treeitems a person can see, top to bottom — by layout, not by the page's own list. */
async function visible(page: ChangesPage): Promise<Item[]> {
  const raw = await page.eval<Omit<Item, "kind">[]>(`Array.prototype.filter.call(
    document.querySelectorAll('#groups [role="treeitem"]'),
    function (n) { return n.offsetParent !== null; }
  ).map(function (n) {
    return {
      tkey: n.dataset.tkey,
      level: Number(n.getAttribute("aria-level")),
      expanded: n.getAttribute("aria-expanded"),
      checked: n.getAttribute("aria-checked"),
      path: n.dataset.path || null,
      staged: n.dataset.kind === "staged",
    };
  })`);
  return raw.map((r) => ({ ...r, kind: kindOf(r.tkey) }));
}

async function setUp(page: ChangesPage, model: Model, layout: Layout): Promise<void> {
  await page.send({
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    staged: STAGED,
    unstaged: UNSTAGED,
    stagingModel: model,
    layout,
  });
  if (model === "checkboxes") {
    // README.md's changes open (by the pointer: the twisty), with the host's answer.
    await page.eval(`document.querySelector('[data-tkey="f:ck:README.md"] .hunk-twisty').click()`);
    await page.send({ type: "hunks", path: "README.md", hunks: HUNKS });
  }
  await page.eval("window.__posted = []");
}

const fingerprint = (items: Item[]) => JSON.stringify(items.map((i) => [i.tkey, i.expanded, i.checked]));

type Outcome = { focus: string | null; expandedOf?: { tkey: string; value: string | null }; posted: unknown[] };

/** What the key must do to `it`, worked out from the rows on screen before it. */
function expected(items: Item[], it: Item, key: string): Outcome {
  const i = items.indexOf(it);
  const at = (j: number) => items[Math.max(0, Math.min(items.length - 1, j))].tkey;
  const none: Outcome = { focus: it.tkey, posted: [] };
  const toggle = (): Outcome => ({
    focus: it.tkey,
    expandedOf: { tkey: it.tkey, value: it.expanded === "true" ? "false" : "true" },
    posted: it.kind === "file" && it.expanded === "false" ? [{ type: "requestHunks", path: it.path }] : [],
  });
  switch (key) {
    case "ArrowDown":
      return { focus: at(i + 1), posted: [] };
    case "ArrowUp":
      return { focus: at(i - 1), posted: [] };
    case "Home":
      return { focus: items[0].tkey, posted: [] };
    case "End":
      return { focus: items[items.length - 1].tkey, posted: [] };
    case "ArrowRight": {
      if (it.expanded === "false") return toggle();
      if (it.expanded === "true") {
        const child = items[i + 1];
        return { focus: child && child.level > it.level ? child.tkey : it.tkey, posted: [] };
      }
      return none;
    }
    case "ArrowLeft": {
      // The checkbox model's header holds every file and never closes.
      if (it.expanded === "true" && it.kind !== "checkhead") return toggle();
      for (let j = i - 1; j >= 0; j--) if (items[j].level < it.level) return { focus: items[j].tkey, posted: [] };
      return none;
    }
    case "Enter":
    case " ": {
      const space = key === " ";
      if (it.kind === "group" || it.kind === "folder") return toggle();
      if (it.kind === "checkhead") {
        if (!space) return none;
        return { focus: it.tkey, posted: [{ type: it.checked === "true" ? "unstageAll" : "stageAllForCommit" }] };
      }
      if (it.kind === "hunk") {
        const [, , index] = /^h:(.*):(\d+)$/.exec(it.tkey)!;
        return space
          ? { focus: it.tkey, posted: [{ type: "stageHunk", path: "README.md", hunkIndex: Number(index) }] }
          : { focus: it.tkey, posted: [{ type: "openDiff", path: "README.md", staged: false, line: HUNKS[Number(index)].start }] };
      }
      // A file: Space ticks it in the checkbox model; otherwise it opens, as Enter does.
      if (space && it.checked !== null) {
        return { focus: it.tkey, posted: [{ type: it.checked === "true" ? "unstage" : "stage", path: it.path }] };
      }
      return { focus: it.tkey, posted: [{ type: "openDiff", path: it.path, staged: it.staged }] };
    }
  }
  throw new Error(key);
}

const KEYS = ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft", "Enter", " "];

for (const model of ["split", "checkboxes"] as Model[]) {
  for (const layout of ["list", "tree"] as Layout[]) {
    test(`the keyboard table: ${model} model, ${layout} layout — every row kind × every key`, { skip }, async () => {
      const page = await ChangesPage.open("dark", { width: 460, height: 720 });
      opened.push(page);
      await setUp(page, model, layout);
      const start = await visible(page);
      const kinds = new Set(start.map((i) => i.kind));
      // The table covers what this layout can show — and each one is there.
      const want: Kind[] =
        model === "split"
          ? layout === "tree" ? ["group", "folder", "file"] : ["group", "file"]
          : layout === "tree" ? ["checkhead", "folder", "file", "hunk"] : ["checkhead", "file", "hunk"];
      assert.deepEqual([...kinds].sort(), [...want].sort(), `row kinds shown: ${[...kinds]}`);
      const failures: string[] = [];
      let cells = 0;
      for (const target of start) {
        for (const key of KEYS) {
          const items = await visible(page);
          if (fingerprint(items) !== fingerprint(start)) {
            await page.reload();
            await setUp(page, model, layout);
          }
          const now = await visible(page);
          const it = now.find((x) => x.tkey === target.tkey)!;
          await page.eval(`window.__posted = []; document.querySelector('[data-tkey="${it.tkey}"]').focus()`);
          await page.key(key === " " ? " " : key);
          const exp = expected(now, it, key);
          const got = await page.eval<{ focus: string | null; posted: unknown[]; expanded: string | null }>(`(function () {
            var a = document.activeElement;
            var t = document.querySelector('[data-tkey="${(exp.expandedOf ?? { tkey: it.tkey }).tkey}"]');
            return {
              focus: a && a.dataset ? a.dataset.tkey || null : null,
              posted: window.__posted,
              expanded: t ? t.getAttribute("aria-expanded") : null,
            };
          })()`);
          cells++;
          const where = `${it.tkey} + ${JSON.stringify(key)}`;
          if (got.focus !== exp.focus) failures.push(`${where}: focus ${got.focus}, expected ${exp.focus}`);
          if (JSON.stringify(got.posted) !== JSON.stringify(exp.posted)) {
            failures.push(`${where}: posted ${JSON.stringify(got.posted)}, expected ${JSON.stringify(exp.posted)}`);
          }
          if (exp.expandedOf && got.expanded !== exp.expandedOf.value) {
            failures.push(`${where}: aria-expanded ${got.expanded}, expected ${exp.expandedOf.value}`);
          }
        }
      }
      assert.ok(cells >= start.length * KEYS.length);
      assert.deepEqual(failures, [], `${failures.length} of ${cells} cells wrong`);
    });
  }
}

test("one tab stop: Tab reaches the list once, lands on a row, and leaves it on the next Tab", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), staged: STAGED, unstaged: UNSTAGED });
  const stops = await page.eval<number>(
    `Array.prototype.filter.call(document.querySelectorAll("#groups *"), function (n) { return n.tabIndex >= 0; }).length`,
  );
  assert.equal(stops, 1, "exactly one element of the list is in the tab order");
  // From the refresh button (the last of the toolbar), Tab enters the tree.
  await page.eval(`document.getElementById("refresh").focus()`);
  await page.key("Tab");
  const first = await page.eval<{ role: string | null; tkey: string }>(
    `({ role: document.activeElement.getAttribute("role"), tkey: document.activeElement.dataset.tkey })`,
  );
  assert.deepEqual(first, { role: "treeitem", tkey: "g:staged" });
  await page.key("ArrowDown");
  await page.key("ArrowDown");
  // Leaving and coming back returns to the row the keyboard was on.
  await page.key("Tab");
  const outside = await page.eval<boolean>(`!document.getElementById("groups").contains(document.activeElement)`);
  assert.ok(outside, "the next Tab leaves the list");
  await page.key("Tab", { with: ["shift"] });
  assert.equal(await page.eval<string>(`document.activeElement.dataset.tkey`), "g:unstaged");
});

test("Shift+Down and Shift+Up extend the selection from the keyboard; Ctrl/Cmd+A takes every file", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), staged: STAGED, unstaged: UNSTAGED });
  await page.eval(`document.querySelector('[data-tkey="f:unstaged:README.md"]').focus()`);
  await page.key("ArrowDown", { with: ["shift"] });
  await page.key("ArrowDown", { with: ["shift"] });
  const sel = () =>
    page.eval<string[]>(
      `Array.prototype.map.call(document.querySelectorAll('#groups [aria-selected="true"]'), function (n) { return n.dataset.key; })`,
    );
  assert.deepEqual(await sel(), ["unstaged:README.md", "unstaged:src/lib/b.ts", "unstaged:src/lib/c.ts"]);
  assert.equal(await page.eval<string>(`document.getElementById("selbar-count").textContent`), "3 files selected");
  await page.key("ArrowUp", { with: ["shift"] });
  assert.deepEqual(await sel(), ["unstaged:README.md", "unstaged:src/lib/b.ts"]);
  const unselected = await page.eval<string | null>(
    `document.querySelector('[data-key="unstaged:src/lib/c.ts"]').getAttribute("aria-selected")`,
  );
  assert.equal(unselected, "false", "a multi-select tree says an item is NOT selected, too");
  await page.key("a", { with: ["ctrl"] });
  assert.equal((await sel()).length, 4);
});

test("PageDown and PageUp move a view's height of rows, not to the ends of a long list", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 480 });
  opened.push(page);
  const files = Array.from({ length: 80 }, (_, i) => ({ path: `src/f${String(i).padStart(2, "0")}.ts`, status: "M" }));
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: files });
  await page.eval(`document.querySelector('[data-tkey="g:unstaged"]').focus()`);
  const at = () => page.eval<number>(`Array.prototype.indexOf.call(document.querySelectorAll('#groups [role="treeitem"]'), document.activeElement)`);
  await page.key("PageDown");
  const one = await at();
  assert.ok(one > 5 && one < 30, `one PageDown moved to row ${one} of 81`);
  const onScreen = await page.eval<boolean>(`(function () {
    var r = document.activeElement.getBoundingClientRect();
    return r.top >= 0 && r.bottom <= innerHeight;
  })()`);
  assert.ok(onScreen, "and the row it lands on is scrolled into view");
  await page.key("PageDown");
  assert.ok((await at()) > one, "a second goes further");
  await page.key("PageUp");
  assert.equal(await at(), one, "and PageUp comes back the same way");
});

test("a row that leaves the list hands the keyboard to the row after it", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  const state = { ...stateMessage({ local: [{ name: "main", current: true }] }), staged: STAGED, unstaged: UNSTAGED };
  await page.send(state);
  await page.eval(`document.querySelector('[data-tkey="f:unstaged:src/lib/b.ts"]').focus()`);
  // Staged elsewhere (the host's next state): b.ts moves to Staged.
  await page.send({
    ...state,
    staged: [...STAGED, { path: "src/lib/b.ts", status: "M" }],
    unstaged: UNSTAGED.filter((f) => f.path !== "src/lib/b.ts"),
  });
  assert.equal(await page.eval<string>(`document.activeElement.dataset.tkey`), "f:unstaged:src/lib/c.ts");
  // The last one goes: the keyboard takes the one before it.
  await page.send({ ...state, staged: [...STAGED, ...UNSTAGED.slice(1)], unstaged: [UNSTAGED[0]] });
  assert.equal(await page.eval<string>(`document.activeElement.dataset.tkey`), "f:unstaged:README.md");
  const stops = await page.eval<number>(
    `Array.prototype.filter.call(document.querySelectorAll("#groups *"), function (n) { return n.tabIndex >= 0; }).length`,
  );
  assert.equal(stops, 1);
});

test("a click on a row's own button acts and leaves the keyboard on the row, not on the button", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), staged: STAGED, unstaged: UNSTAGED });
  const box = await page.eval<{ x: number; y: number }>(`(function () {
    var b = document.querySelector('[data-tkey="f:unstaged:README.md"] .row-actions .icon-btn').getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
  })()`);
  await page.click(box.x, box.y);
  const posted = await page.posted();
  assert.deepEqual(posted.filter((m) => m.type === "stage"), [{ type: "stage", path: "README.md" }]);
  const focus = await page.eval<{ tag: string; role: string | null }>(
    `({ tag: document.activeElement.tagName, role: document.activeElement.getAttribute("role") })`,
  );
  assert.equal(focus.role, "treeitem", `focus is on ${JSON.stringify(focus)}`);
  const buttonStops = await page.eval<number>(
    `Array.prototype.filter.call(document.querySelectorAll("#groups button, #groups input"), function (n) { return n.tabIndex >= 0; }).length`,
  );
  assert.equal(buttonStops, 0, "no row button or tick is a tab stop");
});

test("the push review: its file rows are buttons Tab reaches, Enter opens one, and Tab stays inside the dialog", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  await page.send(stateMessage({ local: [{ name: "main", current: true }] }));
  await page.send({
    type: "pushPreview", hasUpstream: true, target: "origin/main", branch: "main", base: "b".repeat(40),
    canPush: true, ahead: 1, behind: 0, needsForce: false, additions: 3, deletions: 1,
    commits: [{ sha: "a".repeat(40), subject: "One", author: "Ada", date: 1700000000 }],
    files: [
      { path: "src/app.ts", status: "M", additions: 3, deletions: 1 },
      { path: "src/new.ts", status: "R", oldPath: "src/old.ts", additions: 0, deletions: 0 },
    ],
  });
  const seen: string[] = [];
  for (let i = 0; i < 8; i++) {
    await page.key("Tab");
    seen.push(
      await page.eval<string>(`(function () {
        var a = document.activeElement;
        if (!document.querySelector(".push-modal").contains(a)) return "OUTSIDE:" + a.tagName;
        return a.getAttribute("aria-label") || a.textContent.trim();
      })()`),
    );
  }
  assert.ok(!seen.some((s) => s.startsWith("OUTSIDE")), `Tab left the dialog: ${JSON.stringify(seen)}`);
  assert.ok(seen.includes("Open the diff of src/app.ts"), JSON.stringify(seen));
  assert.ok(seen.includes("Open the diff of src/new.ts, renamed from src/old.ts"), JSON.stringify(seen));
  // Round again to the first file and press Enter.
  for (let i = 0; i < 12; i++) {
    const at = await page.eval<string | null>(`document.activeElement.getAttribute("aria-label")`);
    if (at === "Open the diff of src/app.ts") break;
    await page.key("Tab");
  }
  await page.eval("window.__posted = []");
  await page.key("Enter", { typed: true });
  assert.deepEqual(await page.posted(), [{ type: "openPushFileDiff", path: "src/app.ts" }]);
});

test("a button reached with Tab shows its tip, as it does under the pointer", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), staged: STAGED, unstaged: UNSTAGED });
  await page.eval(`document.getElementById("layout-toggle").focus()`);
  await page.key("Tab");
  assert.equal(await page.eval<string>(`document.activeElement.id`), "model-toggle");
  await page.eval("new Promise(function (r) { setTimeout(r, 500); })");
  const tip = await page.eval<{ shown: boolean; text: string; opacity: string }>(`(function () {
    var t = document.querySelector(".gs-tip");
    return { shown: t.classList.contains("show"), text: t.textContent, opacity: getComputedStyle(t).opacity };
  })()`);
  assert.equal(tip.text, "Switch to checkboxes");
  assert.equal(tip.shown, true);
  assert.notEqual(tip.opacity, "0", "painted, not only flagged");
});
