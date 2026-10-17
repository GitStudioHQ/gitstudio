// Changelists in the Changes view (#122), in the real page commitView.ts
// serves (windowless Chrome; real mouse events through the DevTools
// protocol, synthetic drags as changesStashDrag.test.ts makes them).
//
// A parked file sits in its changelist's group — out of Unstaged in the split
// model, out of the Changes list in the checkbox model — and every
// "everything" control leaves it alone: Stage All (moved at the click, and
// disabled when only parked files are left), Check all, and the Commit
// button's "Commit all N". It is moved by its row's menu, a selection's menu,
// or a drag onto a changelist; a changelist's own header stages, renames and
// deletes it.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const NOCOMMIT = { id: "lnc1", name: "nocommit" };
const EMPTY = { id: "lem2", name: "later" };

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    staged: [],
    unstaged: [
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "M" },
      { path: "src/config.local.json", status: "M" },
      { path: "debug.log", status: "U" },
    ],
    changelists: [NOCOMMIT, EMPTY],
    parked: { "src/config.local.json": NOCOMMIT.id, "debug.log": NOCOMMIT.id },
    ...over,
  };
}

async function open(over: Record<string, unknown> = {}): Promise<ChangesPage> {
  const p = await ChangesPage.open("dark", { width: 420, height: 760 });
  opened.push(p);
  await p.send(state(over));
  await p.eval("window.__posted.length = 0");
  return p;
}

/** The groups on screen, each with the files it shows. */
function groups(p: ChangesPage): Promise<{ label: string; count: string; files: string[] }[]> {
  return p.eval(`Array.prototype.filter.call(document.querySelectorAll("#groups > .group"), function (g) {
      return getComputedStyle(g).display !== "none";
    }).map(function (g) {
      return {
        label: g.querySelector(".glabel").textContent,
        count: g.querySelector(".gcount").textContent,
        files: Array.prototype.map.call(g.querySelectorAll(".row.is-file"), function (r) { return r.dataset.path; }),
      };
    })`);
}

const listHeader = (id: string) =>
  `Array.prototype.find.call(document.querySelectorAll("#groups > .group--changelist"), function (g) { return g.dataset.list === ${JSON.stringify(id)}; }).firstChild`;
const fileRow = (path: string) => `document.querySelector('#groups .row.is-file[data-path="${path}"]')`;

async function centre(p: ChangesPage, expr: string): Promise<{ x: number; y: number }> {
  return p.eval(`(function () {
    var n = ${expr};
    if (!n) throw new Error("not on the page: " + ${JSON.stringify(expr)});
    var t = n.querySelector(".name, .glabel") || n;
    var b = t.getBoundingClientRect();
    return { x: Math.round(b.left + Math.min(b.width / 2, 30)), y: Math.round(b.top + b.height / 2) };
  })()`);
}

async function mouse(p: ChangesPage, at: { x: number; y: number }, button: "left" | "right", modifiers = 0): Promise<void> {
  const base = { x: at.x, y: at.y, button, clickCount: 1, modifiers };
  await p.page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await p.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

/** The labels of the open action menu. */
function menuLabels(p: ChangesPage): Promise<string[]> {
  return p.eval(`Array.prototype.map.call(document.querySelectorAll(".action-menu .bm-subaction"), function (b) { return b.textContent.trim(); })`);
}

async function clickMenuItem(p: ChangesPage, label: string): Promise<void> {
  const at = await p.eval<{ x: number; y: number }>(`(function () {
    var it = Array.prototype.find.call(document.querySelectorAll(".action-menu .bm-subaction"), function (b) { return b.textContent.trim() === ${JSON.stringify(label)}; });
    if (!it) throw new Error("no menu item " + ${JSON.stringify(label)});
    var b = it.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await p.click(at.x, at.y);
}

const sent = async (p: ChangesPage, types: RegExp) => (await p.posted()).filter((m) => types.test(String(m.type)));

test("split model: a parked file is in its changelist, not in Unstaged; an empty changelist still shows", { skip }, async () => {
  const p = await open();
  assert.deepEqual(await groups(p), [
    { label: "Unstaged", count: "2", files: ["src/a.ts", "src/b.ts"] },
    { label: "nocommit", count: "2", files: ["src/config.local.json", "debug.log"] },
    { label: "later", count: "0", files: [] },
  ]);
  const name = await p.accessibleName(listHeader(NOCOMMIT.id));
  assert.equal(name, "nocommit, changelist, 2 files");
});

test("over a clean tree there is only “Working tree clean”, no empty changelist", { skip }, async () => {
  const p = await open({ unstaged: [], parked: {} });
  assert.deepEqual(await groups(p), []);
});

test("Stage All leaves the parked files where they are, at the click and at the host", { skip }, async () => {
  const p = await open();
  await p.eval(`document.getElementById("stage-all-top").click()`);
  assert.deepEqual(await sent(p, /^stage/), [{ type: "stageAll" }]);
  const g = await groups(p);
  assert.deepEqual(g.find((x) => x.label === "Staged")?.files, ["src/a.ts", "src/b.ts"]);
  assert.deepEqual(g.find((x) => x.label === "nocommit")?.files, ["src/config.local.json", "debug.log"], "not moved");
});

test("with only parked files left, Stage All is off and Commit offers nothing", { skip }, async () => {
  const p = await open({
    unstaged: [{ path: "src/config.local.json", status: "M" }],
    parked: { "src/config.local.json": NOCOMMIT.id },
  });
  assert.equal(await p.eval<boolean>(`document.getElementById("stage-all-top").disabled`), true);
  assert.equal(await p.eval<boolean>(`document.getElementById("commit").disabled`), true, "nothing to commit all of");
});

test("the Commit button's “Commit all N” counts what the host will stage — not the parked files", { skip }, async () => {
  const p = await open();
  assert.equal(await p.eval<string>(`document.getElementById("commit-label").textContent`), "Commit all 2");
});

test("a row's menu moves it to a changelist; a selection's menu moves them all", { skip }, async () => {
  const p = await open();
  await mouse(p, await centre(p, fileRow("src/a.ts")), "right");
  assert.ok((await menuLabels(p)).includes("Move to Changelist…"));
  await clickMenuItem(p, "Move to Changelist…");
  assert.deepEqual(await sent(p, /Changelist/), [{ type: "moveToChangelist", paths: ["src/a.ts"] }]);

  await p.eval("window.__posted.length = 0");
  for (const f of ["src/a.ts", "src/b.ts"]) await mouse(p, await centre(p, fileRow(f)), "left", 4);
  await mouse(p, await centre(p, fileRow("src/b.ts")), "right");
  await clickMenuItem(p, "Move 2 Files to Changelist…");
  assert.deepEqual(await sent(p, /Changelist/), [{ type: "moveToChangelist", paths: ["src/a.ts", "src/b.ts"] }]);
});

test("a changelist's header: its Stage All stages its files only; Rename and Delete are in its menu", { skip }, async () => {
  const staging = await open();
  await staging.eval(`${listHeader(NOCOMMIT.id)}.querySelector(".group-actions .icon-btn").click()`);
  assert.deepEqual(await sent(staging, /^stage/), [{ type: "stagePaths", paths: ["src/config.local.json", "debug.log"] }]);
  assert.deepEqual((await groups(staging)).find((g) => g.label === "Staged")?.files, ["src/config.local.json", "debug.log"],
    "staged at the click");
  const p = await open();
  await mouse(p, await centre(p, listHeader(NOCOMMIT.id)), "right");
  assert.deepEqual(await menuLabels(p), [
    "Stage All in This Changelist", "Rename Changelist…", "Delete Changelist", "Select All (2)", "Stash These Files",
  ]);
  await clickMenuItem(p, "Rename Changelist…");
  await mouse(p, await centre(p, listHeader(NOCOMMIT.id)), "right");
  await clickMenuItem(p, "Delete Changelist");
  assert.deepEqual(await sent(p, /Changelist/), [
    { type: "renameChangelist", list: NOCOMMIT.id },
    { type: "deleteChangelist", list: NOCOMMIT.id },
  ]);
  await mouse(p, await centre(p, listHeader(EMPTY.id)), "right");
  assert.deepEqual(await menuLabels(p), ["Rename Changelist…", "Delete Changelist"], "an empty one has nothing to stage or select");
});

test("Unstaged's menu makes a new changelist", { skip }, async () => {
  const p = await open();
  await mouse(p, await centre(p, `document.querySelector("#groups .group--unstaged > .group-header")`), "right");
  await clickMenuItem(p, "New Changelist…");
  assert.deepEqual(await sent(p, /Changelist/), [{ type: "newChangelist", paths: [] }]);
});

test("checkbox model: Check all takes the Changes list only, a parked file keeps its own tick", { skip }, async () => {
  const p = await open({
    stagingModel: "checkboxes",
    staged: [{ path: "debug.log", status: "A" }],
    unstaged: [
      { path: "src/a.ts", status: "M" },
      { path: "src/b.ts", status: "M" },
      { path: "src/config.local.json", status: "M" },
    ],
  });
  assert.deepEqual(await groups(p), [
    { label: "Changes", count: "2", files: ["src/a.ts", "src/b.ts"] },
    { label: "nocommit", count: "2", files: ["debug.log", "src/config.local.json"] },
    { label: "later", count: "0", files: [] },
  ], "a ticked parked file stays in its changelist, ticked");
  const ticks = await p.eval<Record<string, boolean>>(`(function () {
    var out = {};
    document.querySelectorAll("#groups .row.is-file").forEach(function (r) { out[r.dataset.path] = r.querySelector(".ck").checked; });
    return out;
  })()`);
  assert.deepEqual(ticks, { "src/a.ts": false, "src/b.ts": false, "debug.log": true, "src/config.local.json": false });
  assert.equal(await p.eval<boolean>(`document.querySelector(".group--all .ck-master").indeterminate`), false,
    "the Changes list's master tick does not count the parked file that is ticked");
  await p.eval(`document.querySelector(".group--all .ck-master").click()`);
  assert.deepEqual(await sent(p, /^(stage|unstage)/), [{ type: "stageAllForCommit" }]);
  const after1 = await p.eval<Record<string, boolean>>(`(function () {
    var out = {};
    document.querySelectorAll("#groups .row.is-file").forEach(function (r) { out[r.dataset.path] = r.querySelector(".ck").checked; });
    return out;
  })()`);
  assert.equal(after1["src/config.local.json"], false, "not ticked at the click");
  assert.equal(after1["src/a.ts"], true);
});

test("tree layout: the same folder in Unstaged and in a changelist is two folders", { skip }, async () => {
  const p = await open({ layout: "tree" });
  const folders = await p.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll("#groups .row:not(.is-file)"), function (r) { return r.dataset.tkey; })`);
  assert.deepEqual(folders, ["d:split:unstaged:src", "d:split:cl-lnc1:src"]);
  // Folding one leaves the other open.
  await mouse(p, await centre(p, `document.querySelector('[data-tkey="d:split:cl-lnc1:src"]')`), "left");
  assert.deepEqual((await groups(p)).map((g) => g.files), [["src/a.ts", "src/b.ts"], ["debug.log"], []]);
});

// ── Drag and drop ────────────────────────────────────────────────────────────

const DND = String.raw`
window.__dnd = {
  dt: null, src: null,
  fire: function (t, type) {
    var r = t.getBoundingClientRect();
    var e = new DragEvent(type, { bubbles: true, cancelable: true, clientX: r.left + 10, clientY: r.top + Math.min(10, r.height / 2) });
    Object.defineProperty(e, "dataTransfer", { value: this.dt });
    t.dispatchEvent(e);
    return e;
  },
  start: function (src) {
    var data = {};
    this.dt = { dropEffect: "none", effectAllowed: "uninitialized", types: [],
      setData: function (k, v) { data[k] = v; }, getData: function (k) { return data[k] || ""; }, setDragImage: function () {} };
    this.src = src;
    this.fire(src, "dragstart");
  },
  over: function (t) {
    this.fire(t, "dragenter");
    var e = this.fire(t, "dragover");
    var lit = Array.prototype.filter.call(document.querySelectorAll(".is-drop-over"), function (n) { return !n.parentElement.closest(".is-drop-over"); });
    var hint = lit.length === 1 ? lit[0].querySelector(".drop-hint .drop-verb") : null;
    return { allowed: e.defaultPrevented, words: hint ? hint.textContent : "", shown: getComputedStyle(t.closest(".group") || t).display !== "none" };
  },
  drop: function (t) { this.fire(t, "drop"); if (this.src) this.fire(this.src, "dragend"); this.src = null; },
};
`;

test("a file dragged onto a changelist moves there at once; onto Unstaged, back; never onto its own", { skip }, async () => {
  const p = await open();
  await p.eval(DND);
  await p.eval(`window.__dnd.start(${fileRow("src/a.ts")})`);
  const own = await p.eval<{ allowed: boolean }>(`window.__dnd.over(document.querySelector("#groups .group--unstaged > .group-header"))`);
  assert.equal(own.allowed, false, "not onto Unstaged, where it is");
  const o = await p.eval<{ allowed: boolean; words: string; shown: boolean }>(`window.__dnd.over(${listHeader(EMPTY.id)})`);
  assert.deepEqual(o, { allowed: true, words: "Drop to move 1 file to “later”", shown: true }, "an empty changelist takes it");
  await p.eval(`window.__dnd.drop(${listHeader(EMPTY.id)})`);
  assert.deepEqual(await sent(p, /Changelist/), [{ type: "moveToChangelist", paths: ["src/a.ts"], list: EMPTY.id }]);
  assert.deepEqual((await groups(p)).find((g) => g.label === "later")?.files, ["src/a.ts"], "moved at the drop");

  // And back: Unstaged is a place for it now, even with nothing left in it.
  await p.eval("window.__posted.length = 0");
  await p.send(state({
    unstaged: [{ path: "src/config.local.json", status: "M" }],
    parked: { "src/config.local.json": NOCOMMIT.id },
  }));
  await p.eval(`window.__dnd.start(${fileRow("src/config.local.json")})`);
  const back = await p.eval<{ allowed: boolean; words: string; shown: boolean }>(
    `window.__dnd.over(document.querySelector("#groups .group--unstaged > .group-header"))`,
  );
  assert.deepEqual(back, { allowed: true, words: "Drop to move 1 file to “Changes”", shown: true });
  await p.eval(`window.__dnd.drop(document.querySelector("#groups .group--unstaged > .group-header"))`);
  assert.deepEqual(await sent(p, /Changelist/), [{ type: "moveToChangelist", paths: ["src/config.local.json"], list: "" }]);
});

test("without changelists the view is as it was: no group, no menu item to drop onto", { skip }, async () => {
  const p = await open({ changelists: [], parked: {} });
  assert.deepEqual((await groups(p)).map((g) => g.label), ["Unstaged"]);
  assert.equal(await p.eval<string>(`document.getElementById("commit-label").textContent`), "Commit all 4");
});
