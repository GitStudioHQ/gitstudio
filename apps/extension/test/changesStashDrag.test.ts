// Drag and drop between the working tree and the Stashes group, in the real
// page commitView.ts serves (a windowless Chrome, dragstart / dragenter /
// dragover / drop / dragend dispatched with a DataTransfer on the elements),
// and — for the doors behind it — the real host against real git.
//
// The owner: "since stashes and commits share the same window I want the
// ability to drag and drop directly". One mechanism, both ways:
//   a stash             → Staged / Changes / the clean tree: Apply (Alt: Pop)
//   its files, a folder → the same places: Move (Alt: Copy)
//   working-tree files  → the Stashes header: stash exactly those
// and nowhere else — a stash row never takes a drop (git cannot add to a
// stash), a stash never lands on the Stashes group, nor the working tree's
// files on the working tree. The place under the pointer is lit (a tint, no
// line) and says what a drop does, and how Alt/Option picks the other verb.
//
// The state table:
//   source   stash row · a stash file · a stash's selected files · a stash
//            file outside that selection · a stash folder · a working-tree
//            file · a working-tree selection (staged and unstaged) · a
//            working-tree folder · a conflicted file · a busy stash
//   target   Changes (header or row) · Staged · the checkbox model's Changes ·
//            the clean tree's note · the Stashes header · a stash row · a
//            stash file · the merge group · the commit box
//   modifier none · Alt, changed mid-drag
//   end      a drop · a cancelled drag · a repaint from the host mid-drag
//   state    stashes · none (the header comes for a working-tree drag)
//   door     (real git) apply · pop · move · copy · a conflict · uncommitted
//            work in the way, cancelled · a scoped stash of the dropped files
//   theme    Dark+, Light+, both high contrast (the lit place's look)

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { answerWith, asked, changesHost, scratchRepo } from "./changesHost";
import { ChangesPage, type VsCodeTheme } from "./changesPage";
import { LOOK_PROBE } from "./litLook";
import { relativeTime } from "../src/util/relativeTime";

/* eslint-disable @typescript-eslint/no-require-imports -- after changesHost put the vscode stand-in in place */
const stashesView = require("../src/views/stashesView") as typeof import("../src/views/stashesView");
const { GitContext } = require("@gitstudio/git-service/GitContext") as typeof import("@gitstudio/git-service/GitContext");
/* eslint-enable @typescript-eslint/no-require-imports */

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const cleanups: (() => void | Promise<void>)[] = [];
after(async () => {
  for (const f of cleanups.reverse()) await f();
});

const A = "a".repeat(40);
const B = "b".repeat(40);
const now = Math.floor(Date.now() / 1000);

function stashes(): Record<string, unknown>[] {
  return [
    { sha: A, text: "WIP: Initial layout", branch: "main", auto: true, message: "WIP on main: 1a2b3c4 Initial layout", time: now - 7200, files: [{ path: "src/app.ts", status: "M" }] },
    {
      sha: B, text: "Fix login redirect", branch: "main", message: "On main: Fix login redirect", time: now - 14400,
      files: [
        { path: "src/auth/callback.ts", status: "A", staged: "all" },
        { path: "src/auth/login.ts", status: "M" },
        { path: "README.md", status: "M" },
      ],
    },
  ].map((s) => ({ ...s, rel: relativeTime(s.time as number), count: (s.files as unknown[]).length }));
}

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "state", hasRepo: true, merge: [],
    staged: [{ path: "src/index.ts", status: "M" }],
    unstaged: [{ path: "src/app.ts", status: "M" }, { path: "src/routes.ts", status: "M" }, { path: "docs/guide.md", status: "A" }],
    stagedCount: 1, stagingModel: "split", branch: "main", upstream: "origin/main", ahead: 0, behind: 0, unpushed: 0,
    canPublish: true, repoName: "web-app", repoCount: 1, signoffDefault: false, aiEnabled: false, layout: "list", busy: false,
    branches: { local: [{ name: "main", current: true, favorite: false }], remote: [], recent: [], tags: [] },
    stashes: stashes(),
    ...over,
  };
}

/**
 * Synthetic drags, as a person's would arrive: dragstart on the row, then
 * dragenter / dragover / drop on what is under the pointer, dragend on the
 * row. Each event carries ONE DataTransfer for the whole drag — a recording
 * one, laid over the event's own: Chrome ignores a dropEffect set on a
 * DataTransfer it did not make for a real drag, and what the page sets it to
 * (copy or move: what the pointer shows) is part of what is tested.
 */
const DND = String.raw`
window.__dnd = {
  dt: null, src: null,
  point: function (t) {
    var r = t.getBoundingClientRect();
    return { x: r.left + Math.min(20, r.width / 2), y: r.top + Math.min(12, r.height / 2) };
  },
  fire: function (t, type, alt) {
    var p = this.point(t);
    var e = new DragEvent(type, { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, altKey: !!alt });
    Object.defineProperty(e, "dataTransfer", { value: this.dt });
    t.dispatchEvent(e);
    return e;
  },
  start: function (src) {
    var data = {};
    this.dt = {
      dropEffect: "none", effectAllowed: "uninitialized", types: [],
      setData: function (k, v) { data[k] = v; if (this.types.indexOf(k) < 0) this.types.push(k); },
      getData: function (k) { return data[k] || ""; },
      setDragImage: function () {},
    };
    this.src = src;
    return !this.fire(src, "dragstart").defaultPrevented;
  },
  over: function (t, alt) {
    this.fire(t, "dragenter", alt);
    this.dt.dropEffect = "none";
    var e = this.fire(t, "dragover", alt);
    var lit = document.querySelectorAll(".is-drop-over");
    var hint = lit.length === 1 ? lit[0].querySelector(".drop-hint") : null;
    return {
      allowed: e.defaultPrevented,
      effect: this.dt.dropEffect,
      lit: Array.prototype.map.call(lit, function (n) { return n.id || n.className.split(" ").filter(function (c) { return /^group--|^group-header$/.test(c); }).join(" ") || n.className; }),
      words: hint ? Array.prototype.map.call(hint.children, function (c) { return c.hidden ? "" : c.textContent; }).filter(Boolean) : [],
      ready: document.querySelectorAll(".is-drop-ready").length,
    };
  },
  drop: function (t, alt) {
    this.fire(t, "drop", alt);
    this.end();
  },
  end: function () {
    if (this.src) this.fire(this.src, "dragend");
    this.src = null;
  },
  /** What the drag carries for a drop outside the view: its plain text, and what it allows. */
  carries: function () { return { text: this.dt.getData("text/plain"), allowed: this.dt.effectAllowed }; },
  /** Nothing of a drag is left on the page. */
  clean: function () {
    return document.querySelectorAll(".is-drop-over, .is-drop-ready, .row.is-dragged").length === 0 &&
      !document.body.classList.contains("is-dragging");
  },
};
`;

type Over = { allowed: boolean; effect: string; lit: string[]; words: string[]; ready: number };

async function open(theme: VsCodeTheme = "dark", width = 360): Promise<ChangesPage> {
  const p = await ChangesPage.open(theme, { width, height: 900 });
  cleanups.push(() => p.close());
  await p.eval(`(function () {
    var s = document.createElement("style");
    s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(s);
  })()`);
  await p.eval(DND);
  await p.eval(LOOK_PROBE);
  return p;
}

const Q = {
  stash: (sha: string) => `document.querySelector('#stashes [data-tkey="stash:${sha}"]')`,
  stashFile: (sha: string, path: string) => `document.querySelector('#stashes [data-key="stash:${sha}:${path}"]')`,
  stashFolder: (sha: string, path: string) => `document.querySelector('#stashes [data-tkey="stashfolder:${sha}:${path}"]')`,
  stashesHeader: `document.querySelector('#stashes .group--stashes > .group-header')`,
  group: (kind: string) => `document.querySelector('#groups .group--${kind}')`,
  groupHeader: (kind: string) => `document.querySelector('#groups .group--${kind} > .group-header')`,
  file: (kind: string, path: string) => `document.querySelector('#groups .row.is-file[data-key="${kind}:${path}"]')`,
  folder: (kind: string, path: string) => `document.querySelector('#groups [data-tkey="d:split:${kind}:${path}"]')`,
  empty: `document.getElementById("empty-state")`,
  commitBox: `document.querySelector(".composer")`,
};

const start = (p: ChangesPage, src: string) => p.eval<boolean>(`window.__dnd.start(${src})`);
const over = (p: ChangesPage, t: string, alt = false) => p.eval<Over>(`window.__dnd.over(${t}, ${alt})`);
const drop = (p: ChangesPage, t: string, alt = false) => p.eval(`window.__dnd.drop(${t}, ${alt})`);
const end = (p: ChangesPage) => p.eval(`window.__dnd.end()`);
const clean = (p: ChangesPage) => p.eval<boolean>(`window.__dnd.clean()`);
const posted = async (p: ChangesPage) =>
  (await p.posted()).filter((m) => /^stash/.test(String(m.type)) && m.type !== "stashReadFiles");
const clearPosted = (p: ChangesPage) => p.eval("window.__posted.length = 0");
const cmdClick = (p: ChangesPage, el: string) =>
  p.eval(`${el}.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, detail: 1 }))`);
const openStash = (p: ChangesPage, sha: string) => p.eval(`${Q.stash(sha)}.click()`);

// ── Where a drag can go, and what the place says ────────────────────────────

test("a stash: Changes, Staged and nothing else are places; the place under the pointer says Apply, and Alt says Pop", { skip }, async () => {
  const p = await open();
  await p.send(state());
  assert.equal(await p.eval<boolean>(`!!document.getElementById("stash-drop")`), false, "one mechanism: the old drop box is gone");
  assert.ok(await start(p, Q.stash(B)), "a stash row can be dragged");
  assert.deepEqual(await p.eval(`window.__dnd.carries()`), { text: "On main: Fix login redirect", allowed: "copyMove" },
    "dropped outside the view, it is its message; inside, apply (copy) or pop (move)");
  assert.equal(await p.eval<string>(`${Q.stash(B)}.classList.contains("is-dragged") ? "dim" : ""`), "dim", "what is dragged is dimmed");

  let o = await over(p, Q.file("unstaged", "src/routes.ts"));
  assert.deepEqual(
    { allowed: o.allowed, effect: o.effect, lit: o.lit, words: o.words, ready: o.ready },
    { allowed: true, effect: "copy", lit: ["group--unstaged"], words: ["Drop to apply", `Hold ${await altName(p)} to pop`], ready: 1 },
    "over a row of Changes: the whole group is the place (the stash is kept: copy)",
  );
  o = await over(p, Q.groupHeader("unstaged"), true);
  assert.deepEqual([o.allowed, o.effect, o.words], [true, "move", ["Drop to pop", `Release ${await altName(p)} to apply`]], "Alt held: Pop (the stash goes: move)");
  o = await over(p, Q.group("staged"));
  assert.deepEqual([o.allowed, o.lit, o.words[0]], [true, ["group--staged"], "Drop to apply"], "Staged is a place too");

  for (const [what, t] of [
    ["the stash's own row", Q.stash(B)],
    ["another stash", Q.stash(A)],
    ["the Stashes header", Q.stashesHeader],
    ["the commit box", Q.commitBox],
  ] as const) {
    o = await over(p, t);
    assert.deepEqual([o.allowed, o.lit], [false, []], `${what}: no place — nothing lit, the browser refuses the drop`);
  }
  await drop(p, Q.stash(A));
  assert.deepEqual(await posted(p), [], "dropped on another stash: nothing happens");
  assert.ok(await clean(p), "and nothing of the drag is left");
});

test("a stash dropped: Apply keeps its row (busy until git answers), Alt-drop Pops it away at once; a conflict brings it back", { skip }, async () => {
  const p = await open();
  await p.send(state());
  await start(p, Q.stash(B));
  await over(p, Q.group("unstaged"));
  await drop(p, Q.group("unstaged"));
  assert.deepEqual(await posted(p), [{ type: "stashAct", sha: B, action: "apply" }], "the menu's Apply, by sha");
  assert.ok(await clean(p));
  assert.equal(await p.eval<boolean>(`${Q.stash(B)}.classList.contains("is-busy")`), true, "Apply: the row stays, busy");
  await p.send({ type: "stashDone", sha: B, action: "apply", outcome: { kind: "done" } });
  assert.equal(await p.eval<boolean>(`${Q.stash(B)}.classList.contains("is-busy")`), false, "done: the row is itself again");

  await clearPosted(p);
  await start(p, Q.stash(A));
  await over(p, Q.group("staged"), true);
  await drop(p, Q.group("staged"), true);
  assert.deepEqual(await posted(p), [{ type: "stashAct", sha: A, action: "pop" }], "Alt: the menu's Pop");
  assert.equal(await p.eval<boolean>(`!!${Q.stash(A)}`), false, "Pop: the row leaves at once");
  // Git stopped on conflicts: the stash is kept, and so is its row.
  await p.send({ type: "stashDone", sha: A, action: "pop", outcome: { kind: "paused" } });
  assert.equal(await p.eval<boolean>(`!!${Q.stash(A)}`), true, "a conflict: the stash (and its row) come back");
});

test("a stash's files: one, its selected ones, one outside the selection, a folder — Move, and Alt Copy", { skip }, async () => {
  const p = await open();
  await p.send(state({ layout: "tree" }));
  await openStash(p, B);
  // One file, nothing selected.
  assert.ok(await start(p, Q.stashFile(B, "README.md")));
  let o = await over(p, Q.group("unstaged"));
  assert.deepEqual([o.allowed, o.effect, o.words], [true, "move", ["Drop to move 1 file", `Hold ${await altName(p)} to copy`]]);
  o = await over(p, Q.stashFile(B, "src/auth/login.ts"));
  assert.deepEqual([o.allowed, o.lit], [false, []], "a stash's own file is no place");
  await drop(p, Q.group("unstaged"));
  assert.deepEqual(await posted(p), [{ type: "stashFiles", sha: B, action: "move", paths: ["README.md"] }]);
  await p.send({ type: "stashDone", sha: B, action: "move", paths: ["README.md"], outcome: { kind: "kept" } });

  // Two selected; the drag starts on one of them: both go, Alt copies.
  await clearPosted(p);
  await cmdClick(p, Q.stashFile(B, "src/auth/login.ts"));
  await cmdClick(p, Q.stashFile(B, "src/auth/callback.ts"));
  assert.ok(await start(p, Q.stashFile(B, "src/auth/login.ts")));
  assert.equal(await p.eval<number>(`document.querySelectorAll("#stashes .row.is-dragged").length`), 2, "both selected rows are dimmed");
  o = await over(p, Q.group("unstaged"), true);
  assert.deepEqual([o.effect, o.words[0]], ["copy", "Drop to copy 2 files"]);
  await drop(p, Q.group("unstaged"), true);
  const copy = (await posted(p))[0] as { paths: string[] };
  assert.deepEqual({ ...copy, paths: copy.paths.slice().sort() }, { type: "stashFiles", sha: B, action: "copy", paths: ["src/auth/callback.ts", "src/auth/login.ts"] });
  await p.send({ type: "stashDone", sha: B, action: "copy", paths: copy.paths, outcome: { kind: "done" } });

  // A file OUTSIDE a selection goes alone — never the files selected
  // elsewhere. (A move then ends the selection, as the menu's does: what is
  // left of the stash is a new stash.)
  await clearPosted(p);
  await cmdClick(p, Q.stashFile(B, "src/auth/login.ts"));
  assert.ok(await start(p, Q.stashFile(B, "README.md")));
  assert.equal(await p.eval<number>(`document.querySelectorAll("#stashes .row.is-dragged").length`), 1, "only it is dimmed");
  await drop(p, Q.group("unstaged"));
  assert.deepEqual(await posted(p), [{ type: "stashFiles", sha: B, action: "move", paths: ["README.md"] }]);
  await p.send({ type: "stashDone", sha: B, action: "move", paths: ["README.md"], outcome: { kind: "kept" } });

  // A folder: every file in it (not only those on screen).
  await clearPosted(p);
  // (src holds only auth: the tree shows them as one folder, "src/auth".)
  assert.ok(await start(p, Q.stashFolder(B, "src/auth")));
  o = await over(p, Q.group("staged"));
  assert.equal(o.words[0], "Drop to move 2 files");
  await drop(p, Q.group("staged"));
  const moved = (await posted(p))[0] as { paths: string[] };
  assert.deepEqual({ ...moved, paths: moved.paths.slice().sort() }, { type: "stashFiles", sha: B, action: "move", paths: ["src/auth/callback.ts", "src/auth/login.ts"] });
});

test("the working tree's files: onto the Stashes header only — one, a selection (staged and unstaged, once each), a folder; never a conflicted file", { skip }, async () => {
  const p = await open();
  await p.send(state({
    merge: [{ path: "src/conflict.ts", status: "U" }],
    unstaged: [{ path: "src/app.ts", status: "M" }, { path: "src/routes.ts", status: "M" }, { path: "src/index.ts", status: "M" }, { path: "docs/guide.md", status: "A" }],
  }));
  assert.ok(await start(p, Q.file("unstaged", "src/app.ts")));
  assert.equal((await p.eval<{ text: string }>(`window.__dnd.carries()`)).text, "src/app.ts", "outside the view: its path");
  let o = await over(p, Q.stashesHeader);
  assert.deepEqual([o.allowed, o.effect, o.lit, o.words, o.ready], [true, "move", ["group-header"], ["Drop to stash 1 file"], 0]);
  for (const [what, t] of [
    ["Changes", Q.group("unstaged")],
    ["Staged", Q.group("staged")],
    ["a stash row", Q.stash(B)],
    ["the merge group", Q.group("merge")],
  ] as const) {
    o = await over(p, t);
    assert.deepEqual([o.allowed, o.lit], [false, []], `${what}: no place for the working tree's own files`);
  }
  await end(p);
  assert.deepEqual(await posted(p), [], "a cancelled drag posts nothing");
  assert.ok(await clean(p));

  // A selection across Staged and Changes: every file once, in screen order.
  await cmdClick(p, Q.file("staged", "src/index.ts"));
  await cmdClick(p, Q.file("unstaged", "src/index.ts"));
  await cmdClick(p, Q.file("unstaged", "docs/guide.md"));
  assert.ok(await start(p, Q.file("unstaged", "docs/guide.md")));
  o = await over(p, Q.stashesHeader);
  assert.deepEqual(o.words, ["Drop to stash 2 files"]);
  await drop(p, Q.stashesHeader);
  assert.deepEqual(await posted(p), [{ type: "stashPaths", paths: ["src/index.ts", "docs/guide.md"] }]);
  assert.equal(await p.eval<number>(`document.querySelectorAll(".row.is-selected").length`), 0, "the stashed selection is over");

  // An unselected row, with a selection elsewhere: it goes alone; the selection stays.
  await clearPosted(p);
  await cmdClick(p, Q.file("unstaged", "src/app.ts"));
  assert.ok(await start(p, Q.file("unstaged", "src/routes.ts")));
  await drop(p, Q.stashesHeader);
  assert.deepEqual(await posted(p), [{ type: "stashPaths", paths: ["src/routes.ts"] }]);
  assert.equal(await p.eval<number>(`document.querySelectorAll(".row.is-selected").length`), 1);

  // A conflicted file: nowhere to go.
  await clearPosted(p);
  await start(p, Q.file("merge", "src/conflict.ts"));
  o = await over(p, Q.stashesHeader);
  assert.deepEqual([o.allowed, o.lit], [false, []], "git cannot stash a conflicted file");
  await drop(p, Q.stashesHeader);
  assert.deepEqual(await posted(p), []);

  // A folder, in the tree layout.
  await p.send(state({ layout: "tree", unstaged: [{ path: "src/app.ts", status: "M" }, { path: "src/routes.ts", status: "M" }, { path: "docs/guide.md", status: "A" }] }));
  assert.ok(await start(p, Q.folder("unstaged", "src")));
  o = await over(p, Q.stashesHeader);
  assert.deepEqual(o.words, ["Drop to stash 2 files"]);
  await drop(p, Q.stashesHeader);
  const sent = (await posted(p))[0] as { paths: string[] };
  assert.deepEqual(sent.paths.slice().sort(), ["src/app.ts", "src/routes.ts"]);
});

test("no stash yet: a working-tree drag brings the Stashes header to drop on, and takes it away after", { skip }, async () => {
  const p = await open();
  await p.send(state({ stashes: [] }));
  assert.equal(await p.eval<boolean>(`document.getElementById("stashes").hidden`), true, "no stashes, no group");
  await start(p, Q.file("unstaged", "src/app.ts"));
  assert.equal(await p.eval<boolean>(`document.getElementById("stashes").hidden`), false, "mid-drag the header is there");
  assert.equal(await p.eval<string>(`${Q.stashesHeader}.textContent.trim()`), "Stashes", "named, with no count");
  const o = await over(p, Q.stashesHeader);
  assert.deepEqual([o.allowed, o.words], [true, ["Drop to stash 1 file"]]);
  await end(p);
  assert.equal(await p.eval<boolean>(`document.getElementById("stashes").hidden`), true, "cancelled: gone again");
  await start(p, Q.file("unstaged", "src/app.ts"));
  await drop(p, Q.stashesHeader);
  assert.deepEqual(await posted(p), [{ type: "stashPaths", paths: ["src/app.ts"] }]);
  assert.equal(await p.eval<boolean>(`document.getElementById("stashes").hidden`), true, "dropped: the host's list decides from here");
});

test("the clean tree and the checkbox model: the note, and the one Changes group, are the places", { skip }, async () => {
  const p = await open();
  await p.send(state({ staged: [], unstaged: [], stagedCount: 0 }));
  await start(p, Q.stash(A));
  let o = await over(p, Q.empty);
  assert.deepEqual([o.allowed, o.lit, o.words[0]], [true, ["empty-state"], "Drop to apply"]);
  await drop(p, Q.empty);
  assert.deepEqual(await posted(p), [{ type: "stashAct", sha: A, action: "apply" }]);
  await p.send({ type: "stashDone", sha: A, action: "apply", outcome: { kind: "done" } });

  await clearPosted(p);
  await p.send(state({ stagingModel: "checkboxes" }));
  await start(p, Q.stash(B));
  o = await over(p, `document.querySelector('#groups .group--all .row.is-file')`, true);
  assert.deepEqual([o.allowed, o.lit, o.words[0]], [true, ["group--all"], "Drop to pop"]);
  await drop(p, `document.querySelector('#groups .group--all .row.is-file')`, true);
  assert.deepEqual(await posted(p), [{ type: "stashAct", sha: B, action: "pop" }]);
});

test("a busy stash is not dragged; a repaint from the host mid-drag keeps the place lit", { skip }, async () => {
  const p = await open();
  await p.send(state());
  await p.eval(`${Q.stash(B)}.querySelector('[data-act="apply"]').click()`);
  assert.equal(await p.eval<boolean>(`${Q.stash(B)}.draggable`), false, "busy: not draggable");
  assert.equal(await start(p, Q.stash(B)), false, "and a drag of it is refused");
  await end(p);
  await p.send({ type: "stashDone", sha: B, action: "apply", outcome: { kind: "done" } });

  await start(p, Q.stash(B));
  await over(p, Q.group("unstaged"));
  // The firehose: a state post while the pointer is over Changes.
  await p.send(state({ unstaged: [{ path: "src/app.ts", status: "M" }, { path: "src/routes.ts", status: "M" }] }));
  const lit = await p.eval<string[]>(`Array.from(document.querySelectorAll(".is-drop-over")).map(function (n) { return n.className; })`);
  assert.equal(lit.length, 1, `still lit after the repaint: ${JSON.stringify(lit)}`);
  assert.match(lit[0], /group--unstaged/);
  await end(p);
  assert.ok(await clean(p));
});

// ── What the lit place looks like ───────────────────────────────────────────

async function altName(p: ChangesPage): Promise<string> {
  return p.eval<string>(`/Mac|iPhone|iPad/.test(navigator.platform || "") ? "Option" : "Alt"`);
}

for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: the lit place is a tint that stands apart, its words read, and it wears no line`, { skip }, async () => {
    const p = await open(theme);
    await p.send(state());
    await start(p, Q.stash(B));
    await over(p, Q.group("unstaged"));
    const hc = theme.startsWith("hc");
    type Look = { apart: number; text: number; lines: string[] };
    const group = await p.eval<Look>(`window.__look(${Q.group("unstaged")}, { surface: document.getElementById("groups"), text: document.querySelector(".is-drop-over .drop-verb") })`);
    const alt = await p.eval<Look>(`window.__look(document.querySelector(".is-drop-over > .group-header"), { surface: document.getElementById("groups"), text: document.querySelector(".is-drop-over .drop-alt") })`);
    if (hc) assert.ok(group.lines.length === 1 && /^outline dashed/.test(group.lines[0]), `high contrast rings it, whole: ${JSON.stringify(group)}`);
    else assert.deepEqual(group.lines, [], `no line: ${JSON.stringify(group)}`);
    assert.ok(group.apart >= 1.15, `the place stands apart from the view (${group.apart}:1)`);
    assert.ok(group.text >= 4.5, `"Drop to apply" reads at 4.5:1 or more (${group.text}:1)`);
    assert.ok(alt.text >= 4.5, `"Hold Option to pop" too (${alt.text}:1)`);
    const ready = await p.eval<Look>(`window.__look(${Q.group("staged")}, { surface: document.getElementById("groups") })`);
    assert.deepEqual(ready.lines, [], "the other place, faintly tinted, wears no line either");
    await end(p);

    await start(p, Q.file("unstaged", "src/app.ts"));
    await over(p, Q.stashesHeader);
    const header = await p.eval<Look>(`window.__look(${Q.stashesHeader}, { surface: document.getElementById("stashes"), text: document.querySelector(".is-drop-over .drop-verb") })`);
    if (!hc) assert.deepEqual(header.lines, [], `the Stashes header, lit: no line (${JSON.stringify(header)})`);
    assert.ok(header.apart >= 1.15 && header.text >= 4.5, `lit and legible: ${JSON.stringify(header)}`);
    await end(p);
  });
}

// ── Words, not twin glyphs ──────────────────────────────────────────────────

test("a stash row says Apply and Pop in words, a stash's file and folder Move and Copy, and each tip says what happens", { skip }, async () => {
  const p = await open("dark", 360);
  await p.send(state({ layout: "tree" }));
  await openStash(p, B);
  const words = (el: string) =>
    p.eval<{ text: string; tip: string }[]>(`Array.from(${el}.querySelectorAll(".row-actions .word-btn")).map(function (b) { return { text: b.textContent, tip: b.dataset.tip }; })`);
  assert.deepEqual(await words(Q.stash(B)), [
    { text: "Apply", tip: "Apply: put these changes back and keep the stash" },
    { text: "Pop", tip: "Pop: put these changes back and delete the stash" },
  ]);
  assert.equal(await p.eval<number>(`${Q.stash(B)}.querySelectorAll(".codicon-git-stash-apply, .codicon-git-stash-pop").length`), 0, "no look-alike glyphs");
  assert.deepEqual(await words(Q.stashFile(B, "README.md")), [
    { text: "Move", tip: "Move: take this file out of the stash, into Changes" },
    { text: "Copy", tip: "Copy: bring this file into Changes and keep it in the stash" },
  ]);
  assert.deepEqual((await words(Q.stashFolder(B, "src/auth"))).map((w) => w.text), ["Move", "Copy"]);
  // Shown where the pointer (or the keyboard) is: the list at rest is calm.
  const shown = (el: string) => p.eval<boolean>(`getComputedStyle(${el}.querySelector(".word-btn")).display !== "none"`);
  await p.mouseMove(2, 2);
  assert.equal(await shown(Q.stash(B)), false, "at rest: no words on every row");
  const at = await p.eval<{ x: number; y: number }>(`(function () { var b = ${Q.stash(B)}.getBoundingClientRect(); return { x: b.left + 40, y: b.top + b.height / 2 }; })()`);
  await p.mouseMove(at.x, at.y);
  assert.equal(await shown(Q.stash(B)), true, "under the pointer: its words");
  // The tip shows (it adds what the word does).
  const pop = await p.eval<{ x: number; y: number }>(`(function () { var b = ${Q.stash(B)}.querySelector('[data-act="pop"]').getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 }; })()`);
  await p.mouseMove(pop.x, pop.y);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(await p.eval<string | null>(`(function () { var t = document.querySelector(".gs-tip.show"); return t ? t.textContent : null; })()`),
    "Pop: put these changes back and delete the stash");
  // Each word does what it says.
  await clearPosted(p);
  await p.eval(`${Q.stashFile(B, "README.md")}.querySelector('[data-act="copy"]').click()`);
  assert.deepEqual(await posted(p), [{ type: "stashFiles", sha: B, action: "copy", paths: ["README.md"] }]);
  await p.send({ type: "stashDone", sha: B, action: "copy", paths: ["README.md"], outcome: { kind: "done" } });
  await clearPosted(p);
  await p.eval(`${Q.stash(B)}.querySelector('[data-act="pop"]').click()`);
  assert.deepEqual(await posted(p), [{ type: "stashAct", sha: B, action: "pop" }]);
});

// ── The doors behind a drop, against real git ───────────────────────────────

/** A repository with one stash (a.ts edited, n.ts new) and three tracked files. */
function repoWithStash(prefix: string) {
  const repo = scratchRepo(prefix);
  cleanups.push(repo.done);
  const write = (f: string, s: string) => writeFileSync(join(repo.dir, f), s);
  for (const f of ["a.ts", "b.ts", "c.ts"]) write(f, `${f} base\n`);
  repo.git("add", ".");
  repo.git("commit", "-qm", "base");
  write("a.ts", "a.ts stashed\n");
  write("b.ts", "b.ts stashed\n");
  repo.git("stash", "push", "-q", "-m", "two files");
  return { ...repo, write, sha: repo.git("rev-parse", "stash@{0}").trim() };
}

/** The page, fed the host's own state post, and a relay for what each side says to the other. */
async function wire(dir: string) {
  const host = changesHost(dir);
  cleanups.push(host.dispose);
  const p = await open();
  const relayState = async () => {
    host.posted.length = 0;
    await host.send({ type: "ready" });
    await host.idle();
    const s = host.posted.filter((m) => m.type === "state" && Array.isArray(m.stashes)).at(-1);
    assert.ok(s, "the host posted its state");
    await p.send(s);
  };
  const relayDrop = async () => {
    const msgs = await posted(p);
    await clearPosted(p);
    host.posted.length = 0;
    for (const m of msgs) await host.send(m);
    await host.idle();
    for (const m of host.posted.filter((x) => x.type === "stashDone" || x.type === "stashPending")) await p.send(m);
    return msgs;
  };
  await relayState();
  return { host, p, relayState, relayDrop };
}

const status = (git: (...a: string[]) => string) => git("status", "--porcelain").trimEnd();

test("real git: a stash dropped on the clean tree is applied and kept; Alt-dropped, popped", { skip }, async () => {
  const r = repoWithStash("dnd-apply");
  const { p, relayState, relayDrop } = await wire(r.dir);
  answerWith(() => "ok");
  await start(p, Q.stash(r.sha));
  await drop(p, Q.empty);
  assert.deepEqual(await relayDrop(), [{ type: "stashAct", sha: r.sha, action: "apply" }]);
  assert.equal(status(r.git), " M a.ts\n M b.ts", "its changes are back");
  assert.equal(r.git("stash", "list", "--format=%H").trim(), r.sha, "and the stash is kept");
  assert.equal(await p.eval<boolean>(`${Q.stash(r.sha)}.classList.contains("is-busy")`), false, "the row is itself again");

  r.git("checkout", "--", ".");
  await relayState();
  await start(p, Q.stash(r.sha));
  await drop(p, Q.empty, true);
  assert.deepEqual(await relayDrop(), [{ type: "stashAct", sha: r.sha, action: "pop" }]);
  assert.equal(status(r.git), " M a.ts\n M b.ts");
  assert.equal(r.git("stash", "list").trim(), "", "popped: the stash is gone");
});

test("real git: a stash's file dropped on Changes is moved out of it; Alt-dropped, copied", { skip }, async () => {
  const r = repoWithStash("dnd-move");
  r.write("c.ts", "mine\n"); // Changes has a row to drop on
  const { p, relayState, relayDrop } = await wire(r.dir);
  await openStash(p, r.sha);
  await p.page.waitFor(`!!${Q.stashFile(r.sha, "a.ts")}`);
  await start(p, Q.stashFile(r.sha, "b.ts"));
  await drop(p, Q.group("unstaged"), true);
  assert.deepEqual(await relayDrop(), [{ type: "stashFiles", sha: r.sha, action: "copy", paths: ["b.ts"] }]);
  assert.equal(status(r.git), " M b.ts\n M c.ts", "copied: b.ts is back…");
  assert.equal(r.git("stash", "list", "--format=%H").trim(), r.sha, "…and the stash is as it was");

  r.git("checkout", "--", "b.ts");
  await relayState();
  await start(p, Q.stashFile(r.sha, "a.ts"));
  await drop(p, Q.group("unstaged"));
  assert.deepEqual(await relayDrop(), [{ type: "stashFiles", sha: r.sha, action: "move", paths: ["a.ts"] }]);
  assert.equal(status(r.git), " M a.ts\n M c.ts", "moved: a.ts is back");
  const rest = r.git("stash", "list", "--format=%H").trim();
  assert.notEqual(rest, r.sha, "what is left is a new stash");
  assert.equal(r.git("stash", "show", "--name-only", rest).trim(), "b.ts", "holding only b.ts");
});

test("real git: a drop that conflicts stops for the user and keeps the stash; one with an edit in the way asks, and Cancel changes nothing", { skip }, async () => {
  const r = repoWithStash("dnd-conflict");
  // HEAD moves on under the stash: its a.ts no longer applies cleanly.
  r.write("a.ts", "a.ts committed differently\n");
  r.git("commit", "-qam", "moved on");
  const { p, relayDrop } = await wire(r.dir);
  answerWith(() => "ok");
  await start(p, Q.stash(r.sha));
  await drop(p, Q.empty, true);
  await relayDrop();
  assert.match(status(r.git), /^UU a\.ts$/m, "git stopped on the conflict");
  assert.equal(r.git("stash", "list", "--format=%H").trim(), r.sha, "a pop that conflicts keeps the stash");
  assert.equal(await p.eval<boolean>(`!!${Q.stash(r.sha)}`), true, "and its row comes back");

  const q = repoWithStash("dnd-in-the-way");
  q.write("a.ts", "my own edit\n");
  const w = await wire(q.dir);
  asked.length = 0;
  answerWith((spec) => (spec.kind === "pick" ? "cancel" : undefined));
  await start(w.p, Q.stash(q.sha));
  await drop(w.p, Q.group("unstaged"), true);
  await w.relayDrop();
  assert.equal(asked[0]?.title, "Your uncommitted changes are in the way", "asked, with Stash & Retry");
  assert.equal(status(q.git), " M a.ts", "cancelled: nothing ran");
  assert.equal(readFileSync(join(q.dir, "a.ts"), "utf8"), "my own edit\n", "the user's edit is untouched");
  assert.equal(await w.p.eval<boolean>(`!!${Q.stash(q.sha)}`), true, "the popped row comes back");
});

test("real git: working-tree files dropped on the Stashes header are stashed — exactly those", { skip }, async () => {
  const r = scratchRepo("dnd-stash");
  cleanups.push(r.done);
  for (const f of ["x.ts", "y.ts", "z.ts"]) writeFileSync(join(r.dir, f), "base\n");
  r.git("add", ".");
  r.git("commit", "-qm", "base");
  for (const f of ["x.ts", "y.ts", "z.ts"]) writeFileSync(join(r.dir, f), "edited\n");
  const { p } = await wire(r.dir);
  await cmdClick(p, Q.file("unstaged", "x.ts"));
  await cmdClick(p, Q.file("unstaged", "z.ts"));
  await start(p, Q.file("unstaged", "z.ts"));
  await drop(p, Q.stashesHeader);
  const msgs = await posted(p);
  assert.deepEqual(msgs, [{ type: "stashPaths", paths: ["x.ts", "z.ts"] }]);
  // The host runs gitstudio.stash.paths with them: the scoped stash door.
  asked.length = 0;
  answerWith((spec) => (spec.kind === "multiPick" ? spec.choices.filter((c) => c.picked).map((c) => c.id) : undefined));
  const ctx = new GitContext({ root: r.dir });
  cleanups.push(() => ctx.dispose());
  await stashesView.saveStash({ getActive: () => ({ ctx, root: r.dir }) } as never, () => {}, { paths: (msgs[0] as { paths: string[] }).paths });
  assert.equal(asked[0]?.title, "Stash 2 files", "the door names what it takes");
  assert.equal(status(r.git), " M y.ts", "y.ts stays");
  assert.equal(r.git("stash", "show", "--name-only", "stash@{0}").trim(), "x.ts\nz.ts", "the stash holds exactly x.ts and z.ts");
});
