// Drag and drop between the working tree and the Stashes group, in the real
// page commitView.ts serves (a windowless Chrome, dragstart / dragenter /
// dragover / drop / dragend dispatched with a DataTransfer on the elements),
// and — for the doors behind it — the real host against real git.
//
// The owner: "since stashes and commits share the same window I want the
// ability to drag and drop directly". One mechanism, both ways:
//   a stash             → the working tree / the clean tree: Apply (Alt: Pop)
//   its files, a folder → the same place: Move (Alt: Copy)
//   working-tree files  → the Stashes group: stash exactly those
// and nowhere else — the group is lit whole wherever in it they are let go,
// never one stash row as if they joined it (git cannot add to a stash); a
// stash never lands on the Stashes group, nor the working tree's
// files on the working tree. The working tree is ONE place, whatever groups
// it shows: what comes back comes back as it was stashed, so no group of it
// (Staged, say) is lit on its own as if it decided where. The place under
// the pointer is lit (a tint, no line) and says what a drop does, and how
// Alt/Option picks the other verb — never cut, however narrow the sidebar.
// The drop works whatever the OS allows while a modifier is held: a Mac
// narrows a drag to copy alone while Option is held (real drags, below).
//
// The state table:
//   source   stash row · a stash file · a stash's selected files · a stash
//            file outside that selection · a stash folder · a working-tree
//            file · a working-tree selection (staged and unstaged) · a
//            working-tree folder · a conflicted file · a busy stash
//   target   Unstaged (header or row) · Staged · the checkbox model's Changes ·
//            the clean tree's note · the Stashes header · a stash row · a
//            stash file · the merge group · the commit box
//   modifier none · Alt, changed mid-drag · Option on a Mac (copy only)
//   width    360 · 300 · 280 · 250 (the words, whole)
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
import { ChangesPage, type PageTheme, type VsCodeTheme } from "./changesPage";
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
    // The lit PLACES: a lit element inside another (the Stashes group's
    // header, which carries its words) is part of it, not a second place.
    var lit = Array.prototype.filter.call(document.querySelectorAll(".is-drop-over"), function (n) { return !n.parentElement.closest(".is-drop-over"); });
    var hint = lit.length === 1 ? lit[0].querySelector(".drop-hint") : null;
    return {
      allowed: e.defaultPrevented,
      effect: this.dt.dropEffect,
      lit: Array.prototype.map.call(lit, function (n) { return n.id || n.className.split(" ").filter(function (c) { return /^group--|^group-header$/.test(c); }).join(" ") || n.className; }),
      words: hint ? Array.prototype.map.call(hint.querySelectorAll(".drop-verb, .drop-alt"), function (c) { return c.hidden ? "" : c.textContent; }).filter(Boolean) : [],
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
  carries: function () { return { text: this.dt.getData("text/plain"), stash: this.dt.getData("application/x-gitstudio-stash") || undefined, allowed: this.dt.effectAllowed }; },
  /** Nothing of a drag is left on the page. */
  clean: function () {
    return document.querySelectorAll(".is-drop-over, .is-drop-ready, .row.is-dragged").length === 0 &&
      !document.body.classList.contains("is-dragging");
  },
};
`;

type Over = { allowed: boolean; effect: string; lit: string[]; words: string[]; ready: number };

async function open(theme: PageTheme = "dark", width = 360): Promise<ChangesPage> {
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

test("a stash: the working tree is the one place — Staged and Unstaged lit together, never apart — and it says Apply, and Alt says Pop", { skip }, async () => {
  const p = await open();
  await p.send(state());
  assert.equal(await p.eval<boolean>(`!!document.getElementById("stash-drop")`), false, "one mechanism: the old drop box is gone");
  assert.ok(await start(p, Q.stash(B)), "a stash row can be dragged");
  assert.deepEqual(await p.eval(`window.__dnd.carries()`), { text: "", stash: B, allowed: "copyMove" },
    "it carries no text an editor would paste — only its sha, in a type of its own; apply (copy) or pop (move)");
  assert.equal(await p.eval<string>(`${Q.stash(B)}.classList.contains("is-dragged") ? "dim" : ""`), "dim", "what is dragged is dimmed");

  let o = await over(p, Q.file("unstaged", "src/routes.ts"));
  assert.deepEqual(
    { allowed: o.allowed, effect: o.effect, lit: o.lit, words: o.words, ready: o.ready },
    { allowed: true, effect: "copy", lit: ["groups"], words: ["Drop to apply", `Hold ${await altName(p)} to pop`], ready: 0 },
    "over a row of Unstaged: the whole working tree is the place (the stash is kept: copy)",
  );
  o = await over(p, Q.groupHeader("unstaged"), true);
  assert.deepEqual([o.allowed, o.effect, o.lit, o.words], [true, "move", ["groups"], ["Drop to pop", `Release ${await altName(p)} to apply`]], "Alt held: Pop (the stash goes: move)");
  for (const t of [Q.group("staged"), Q.groupHeader("staged"), Q.file("staged", "src/index.ts")]) {
    o = await over(p, t);
    assert.deepEqual([o.allowed, o.lit, o.words[0]], [true, ["groups"], "Drop to apply"], "over Staged: the same one place, the same words — not a place of its own");
  }
  const groupsLit = await p.eval<string[]>(`Array.from(document.querySelectorAll("#groups .group.is-drop-over, #groups .group.is-drop-ready, #groups .group-header.is-drop-over")).map(function (n) { return n.className; })`);
  assert.deepEqual(groupsLit, [], "no group of it is lit on its own");
  const band = await p.eval<{ top: number; groupsTop: number; left: number; right: number; gl: number; gr: number }>(`(function () {
    var w = document.querySelector("#groups > .drop-hint > .drop-words").getBoundingClientRect();
    var g = document.getElementById("groups").getBoundingClientRect();
    return { top: w.top, groupsTop: g.top, left: w.left, right: w.right, gl: g.left, gr: g.right };
  })()`);
  assert.deepEqual([band.top, band.left, band.right], [band.groupsTop, band.gl, band.gr], "its words head the whole of it, edge to edge, in a band of their own");

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

test("the working tree's files: onto the Stashes group, its header or any stash in it — one, a selection (staged and unstaged, once each), a folder; never a conflicted file", { skip }, async () => {
  const p = await open();
  await p.send(state({
    merge: [{ path: "src/conflict.ts", status: "U" }],
    unstaged: [{ path: "src/app.ts", status: "M" }, { path: "src/routes.ts", status: "M" }, { path: "src/index.ts", status: "M" }, { path: "docs/guide.md", status: "A" }],
  }));
  assert.ok(await start(p, Q.file("unstaged", "src/app.ts")));
  assert.equal((await p.eval<{ text: string }>(`window.__dnd.carries()`)).text, "src/app.ts", "outside the view: its path");
  let o = await over(p, Q.stashesHeader);
  assert.deepEqual([o.allowed, o.effect, o.lit, o.words, o.ready], [true, "move", ["group--stashes"], ["Drop to stash 1 file"], 0]);
  // Over a stash: still the group, lit whole, and the same words — no row of
  // it lights as if the files were joining that stash.
  o = await over(p, Q.stash(B));
  assert.deepEqual([o.allowed, o.effect, o.lit, o.words], [true, "move", ["group--stashes"], ["Drop to stash 1 file"]]);
  assert.equal(await p.eval<number>(`document.querySelectorAll("#stashes .row.is-drop-over, #stashes .row.is-drop-ready").length`), 0, "no stash row is lit");
  for (const [what, t] of [
    ["Changes", Q.group("unstaged")],
    ["Staged", Q.group("staged")],
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
  // Let go over a stash rather than the header: the same new stash.
  await drop(p, Q.stash(B));
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

test("a long stash list: over a stash far down it, the Stashes header's words are held in sight", { skip }, async () => {
  const p = await open("dark", 320);
  await p.resize(320, 360);
  const many = Array.from({ length: 30 }, (_, i) => ({
    sha: String(i).padStart(2, "0").repeat(20), text: `Stash ${i + 1}`, branch: "main", message: `On main: Stash ${i + 1}`,
    time: now - 600 * (i + 1), rel: relativeTime(now - 600 * (i + 1)), count: 1, files: [{ path: `src/f${i}.ts`, status: "M" }],
  }));
  await p.send(state({ stashes: many }));
  assert.ok(await start(p, Q.file("unstaged", "src/app.ts")));
  const far = `document.querySelector('#stashes [data-tkey="stash:${"29".repeat(20)}"]')`;
  await p.eval(`${far}.scrollIntoView({ block: "end" })`);
  const o = await over(p, far);
  assert.deepEqual([o.allowed, o.lit, o.words], [true, ["group--stashes"], ["Drop to stash 1 file"]]);
  const hint = await p.eval<{ top: number; bottom: number; h: number; header: number }>(`(function () {
    var r = document.querySelector("#stashes .drop-hint").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, h: innerHeight, header: document.querySelector("#stashes .group--stashes > .group-header").getBoundingClientRect().top };
  })()`);
  assert.ok(hint.top >= 0 && hint.bottom <= hint.h, `the words are on screen: ${JSON.stringify(hint)}`);
  assert.ok(Math.abs(hint.header) <= 1, `held at the top of the view: ${JSON.stringify(hint)}`);
  await end(p);
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
  assert.equal(await p.eval<boolean>(`!!document.querySelector("#groups > .drop-hint")`), false, "the clean tree has no band: the note says it");
  await drop(p, Q.empty);
  assert.deepEqual(await posted(p), [{ type: "stashAct", sha: A, action: "apply" }]);
  await p.send({ type: "stashDone", sha: A, action: "apply", outcome: { kind: "done" } });

  await clearPosted(p);
  await p.send(state({ stagingModel: "checkboxes" }));
  await start(p, Q.stash(B));
  o = await over(p, `document.querySelector('#groups .group--all .row.is-file')`, true);
  assert.deepEqual([o.allowed, o.lit, o.words[0]], [true, ["groups"], "Drop to pop"]);
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
  const lit = await p.eval<string[]>(`Array.from(document.querySelectorAll(".is-drop-over")).map(function (n) { return n.id; })`);
  assert.deepEqual(lit, ["groups"], `still lit after the repaint: ${JSON.stringify(lit)}`);
  assert.deepEqual(
    await p.eval<string[]>(`Array.from(document.querySelectorAll("#groups > .drop-hint .drop-verb, #groups > .drop-hint .drop-alt")).map(function (n) { return n.textContent; })`),
    ["Drop to apply", `Hold ${await altName(p)} to pop`],
    "and its band is back, first in it, with its words",
  );
  assert.equal(await p.eval<boolean>(`document.getElementById("groups").firstElementChild.classList.contains("drop-hint")`), true);
  await end(p);
  assert.ok(await clean(p));
  assert.equal(await p.eval<boolean>(`!!document.querySelector("#groups > .drop-hint")`), false, "the drag over: no band left in the list");
});

// ── Real drags, as the OS delivers them ─────────────────────────────────────
//
// The drags above are synthetic: their DataTransfer is a stand-in, so the
// browser never checks the effect the page asks for against what the drag
// allows. These go through Chrome's own drag code (Input.setInterceptDrags,
// then Input.dispatchDragEvent), where it does: a drop that asks for an
// effect the drag no longer allows is refused, and no drop event fires. A Mac
// narrows a drag to copy alone while Option is held — Option-dropping a stash
// to Pop it lit the place, said "Drop to pop", and did nothing.

const COPY = 1;
const MOVE = 16;

/** A real drag from src onto dst, the OS allowing `mask`, Alt/Option held or not. */
async function realDrag(p: ChangesPage, src: string, dst: string, alt: boolean, mask: number) {
  const page = p.page as ChangesPage["page"] & { __drag?: { data: Record<string, unknown> | null } };
  if (!page.__drag) {
    const box: { data: Record<string, unknown> | null } = { data: null };
    page.__drag = box;
    page.on("Input.dragIntercepted", (params) => { box.data = (params as { data: Record<string, unknown> }).data; });
    // What the page asked the pointer to show, read after its own handler (window hears it last).
    await p.eval(`window.addEventListener("dragover", function (e) { window.__effect = e.dataTransfer.dropEffect; })`);
  }
  const box = page.__drag;
  box.data = null;
  const centre = (el: string) => p.eval<{ x: number; y: number }>(`(function () { var b = ${el}.getBoundingClientRect(); return { x: Math.round(b.left + Math.min(40, b.width / 2)), y: Math.round(b.top + b.height / 2) }; })()`);
  await page.send("Input.setInterceptDrags", { enabled: true });
  try {
    const s = await centre(src);
    await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x, y: s.y });
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: s.x, y: s.y, button: "left", clickCount: 1 });
    for (let i = 1; i <= 6; i++) {
      await page.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: s.x + i * 3, y: s.y + i * 3, button: "left", buttons: 1 });
    }
    for (let i = 0; i < 40 && !box.data; i++) await new Promise((r) => setTimeout(r, 25));
    // (Set by the listener meanwhile: not the null assigned above.)
    const started = box.data as Record<string, unknown> | null;
    assert.ok(started, "the drag started");
    const data = { ...started, dragOperationsMask: mask };
    const d = await centre(dst);
    const modifiers = alt ? 1 : 0;
    await p.eval("window.__effect = null");
    await page.send("Input.dispatchDragEvent", { type: "dragEnter", x: d.x, y: d.y, data, modifiers });
    await page.send("Input.dispatchDragEvent", { type: "dragOver", x: d.x, y: d.y, data, modifiers });
    const effect = await p.eval<string | null>("window.__effect");
    await page.send("Input.dispatchDragEvent", { type: "drop", x: d.x, y: d.y, data, modifiers });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: d.x, y: d.y, button: "left", clickCount: 1 });
    await p.page.waitFor(`!document.body.classList.contains("is-dragging")`);
    const sent = await posted(p);
    await clearPosted(p);
    return { effect, posted: sent };
  } finally {
    await page.send("Input.setInterceptDrags", { enabled: false });
  }
}

test("real drags: every drop does what its words said, whatever the OS lets the drag do while Option is held", { skip }, async () => {
  const tree = Q.file("unstaged", "src/routes.ts");
  // source × what the OS allows × Alt: [what the drop posts, the pointer's badge]
  const cells: [string, string, string, boolean, number, Record<string, unknown>, string][] = [
    ["a stash, Option held on a Mac (copy only)", Q.stash(A), tree, true, COPY, { type: "stashAct", sha: A, action: "pop" }, "copy"],
    ["a stash, Alt held elsewhere (copy or move)", Q.stash(A), tree, true, COPY | MOVE, { type: "stashAct", sha: A, action: "pop" }, "move"],
    ["a stash, no modifier", Q.stash(A), tree, false, COPY | MOVE, { type: "stashAct", sha: A, action: "apply" }, "copy"],
    ["a stash's file, Option held on a Mac", Q.stashFile(B, "README.md"), tree, true, COPY, { type: "stashFiles", sha: B, action: "copy", paths: ["README.md"] }, "copy"],
    ["a stash's file, no modifier", Q.stashFile(B, "README.md"), tree, false, COPY | MOVE, { type: "stashFiles", sha: B, action: "move", paths: ["README.md"] }, "move"],
    ["a changed file onto Stashes, Option held on a Mac", Q.file("unstaged", "src/app.ts"), Q.stashesHeader, true, COPY, { type: "stashPaths", paths: ["src/app.ts"] }, "copy"],
    ["a changed file onto Stashes, no modifier", Q.file("unstaged", "src/app.ts"), Q.stashesHeader, false, COPY | MOVE, { type: "stashPaths", paths: ["src/app.ts"] }, "move"],
  ];
  for (const [what, src, dst, alt, mask, want, badge] of cells) {
    // Each from the same view: a stash's own list, one open.
    const p = await open("dark");
    await p.send(state({ layout: "tree" }));
    await openStash(p, B);
    assert.ok(await p.eval<boolean>(`!!${src} && !!${dst}`), `${what}: the rows are there`);
    const r = await realDrag(p, src, dst, alt, mask);
    assert.deepEqual(r.posted, [want], `${what}: the drop happens (the page asked for ${r.effect})`);
    assert.equal(r.effect, badge, `${what}: the pointer shows ${badge}`);
    assert.ok(await clean(p), `${what}: nothing of the drag is left`);
    assert.deepEqual(p.page.errors, []);
  }
});

// ── What the lit place looks like ───────────────────────────────────────────

async function altName(p: ChangesPage): Promise<string> {
  return p.eval<string>(`/Mac|iPhone|iPad/.test(navigator.platform || "") ? "Option" : "Alt"`);
}

for (const theme of ["dark", "light", "hc-dark", "hc-light", "cursor-dark"] as PageTheme[]) {
  test(`${theme}: the lit place is a tint that stands apart, its words read, and it wears no line`, { skip }, async () => {
    const p = await open(theme);
    await p.send(state());
    await start(p, Q.stash(B));
    const hc = theme.startsWith("hc");
    type Look = { apart: number; text: number; lines: string[] };
    const view = `document.body`;
    // Dragging, not yet over it: the working tree faintly tinted, no line.
    const ready = await p.eval<Look>(`window.__look(document.getElementById("groups"), { surface: ${view} })`);
    assert.deepEqual(ready.lines, [], `the place it can go, faintly tinted, wears no line (${JSON.stringify(ready)})`);
    await over(p, Q.group("unstaged"));
    const tree = await p.eval<Look>(`window.__look(document.getElementById("groups"), { surface: ${view}, text: document.querySelector("#groups .drop-verb") })`);
    const band = await p.eval<Look>(`window.__look(document.querySelector("#groups .drop-words"), { surface: ${view}, text: document.querySelector("#groups .drop-alt") })`);
    if (hc) assert.ok(tree.lines.length === 1 && /^outline dashed/.test(tree.lines[0]), `high contrast rings it, whole: ${JSON.stringify(tree)}`);
    else assert.deepEqual(tree.lines, [], `no line: ${JSON.stringify(tree)}`);
    assert.deepEqual(band.lines, [], `its band of words wears none either: ${JSON.stringify(band)}`);
    assert.ok(tree.apart >= 1.15, `the place stands apart from the view (${tree.apart}:1)`);
    assert.ok(tree.text >= 4.5, `"Drop to apply" reads at 4.5:1 or more (${tree.text}:1)`);
    assert.ok(band.text >= 4.5, `"Hold Option to pop" too (${band.text}:1)`);
    const rgb = (c: string) => (c.match(/\d+/g) ?? []).map(Number);
    const bandFill = rgb(await p.eval<string>(`window.__look(document.querySelector("#groups .drop-words")).fill`));
    const placeFill = rgb(await p.eval<string>(`window.__look(document.querySelector("#groups .group--unstaged .row.is-file")).fill`));
    assert.ok(bandFill.every((c, i) => Math.abs(c - placeFill[i]) <= 1),
      `the band is the lit tint itself, no seam between it and the rest of the place (${bandFill} / ${placeFill})`);
    await end(p);

    await start(p, Q.file("unstaged", "src/app.ts"));
    await over(p, Q.stashesHeader);
    const header = await p.eval<Look>(`window.__look(${Q.stashesHeader}, { surface: document.getElementById("stashes"), text: document.querySelector(".is-drop-over .drop-verb") })`);
    if (!hc) assert.deepEqual(header.lines, [], `the Stashes header, lit: no line (${JSON.stringify(header)})`);
    assert.ok(header.apart >= 1.15 && header.text >= 4.5, `lit and legible: ${JSON.stringify(header)}`);
    await end(p);
  });
}

// ── The words, whole at any sidebar width ───────────────────────────────────

test("the words are never cut: too narrow for both on one line, the Option line goes under the verb, and the band ends on a row's edge", { skip }, async () => {
  for (const width of [360, 300, 280, 250]) {
    const p = await open("light", width);
    await p.send(state({ layout: "tree" }));
    await openStash(p, B);
    const cases: [string, string, boolean][] = [
      ["a stash", Q.stash(A), false],
      ["a stash, Alt", Q.stash(A), true],
      ["a folder of 2 files", Q.stashFolder(B, "src/auth"), false],
      ["a folder of 2 files, Alt", Q.stashFolder(B, "src/auth"), true],
    ];
    for (const [what, src, alt] of cases) {
      await start(p, src);
      await over(p, Q.group("unstaged"), alt);
      const m = await p.eval<{ words: { text: string; cut: boolean; shown: boolean }[]; bandBottom: number; edges: number[] }>(`(function () {
        var top = document.getElementById("groups").getBoundingClientRect().top;
        var w = document.querySelector("#groups > .drop-hint > .drop-words");
        return {
          words: Array.prototype.map.call(w.children, function (n) {
            return { text: n.textContent, cut: n.scrollWidth > n.clientWidth + 1, shown: n.getClientRects().length > 0 && !n.hidden };
          }),
          bandBottom: Math.round(w.getBoundingClientRect().bottom - top),
          edges: Array.prototype.map.call(document.querySelectorAll("#groups > .group > .group-header, #groups > .group .row"), function (n) {
            return Math.round(n.getBoundingClientRect().bottom - top);
          }),
        };
      })()`);
      const at = `${width}px, ${what}`;
      assert.equal(m.words.length, 2, at);
      for (const w of m.words) {
        assert.ok(w.shown && !w.cut, `${at}: "${w.text}" is shown whole (${JSON.stringify(m.words)})`);
      }
      assert.ok(m.edges.includes(m.bandBottom), `${at}: the band ends on a row's edge, not across a row (${m.bandBottom} of ${JSON.stringify(m.edges)})`);
      await end(p);
    }
    // The clean tree's note: its words stacked, whole too.
    await p.send(state({ layout: "tree", staged: [], unstaged: [], stagedCount: 0 }));
    await start(p, Q.stash(A));
    await over(p, Q.empty, true);
    const note = await p.eval<{ text: string; cut: boolean }[]>(`Array.prototype.map.call(document.querySelectorAll("#empty-state .drop-verb, #empty-state .drop-alt"), function (n) { return { text: n.textContent, cut: n.scrollWidth > n.clientWidth + 1 }; })`);
    assert.ok(note.length === 2 && note.every((n) => !n.cut), `${width}px, the clean tree's note: ${JSON.stringify(note)}`);
    await end(p);
  }
});

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
  // Move and Copy say where a file comes back, as the groups on screen are
  // named — as it was stashed: a staged one into Staged.
  assert.deepEqual(await words(Q.stashFile(B, "README.md")), [
    { text: "Move", tip: "Move: take this file out of the stash, back into Unstaged" },
    { text: "Copy", tip: "Copy: bring this file back into Unstaged, and keep it in the stash" },
  ]);
  assert.deepEqual(await words(Q.stashFile(B, "src/auth/callback.ts")), [
    { text: "Move", tip: "Move: take this file out of the stash, back into Staged as it was stashed" },
    { text: "Copy", tip: "Copy: bring this file back into Staged as it was stashed, and keep it in the stash" },
  ]);
  assert.deepEqual(await words(Q.stashFolder(B, "src/auth")), [
    { text: "Move", tip: "Move: take these 2 files out of the stash, back into Staged and Unstaged as they were stashed" },
    { text: "Copy", tip: "Copy: bring these 2 files back into Staged and Unstaged as they were stashed, and keep them in the stash" },
  ]);
  // The checkbox model has one group, Changes; a staged file comes back ticked.
  await p.send(state({ layout: "tree", stagingModel: "checkboxes" }));
  assert.equal((await words(Q.stashFile(B, "README.md")))[0].tip, "Move: take this file out of the stash, back into Changes");
  assert.equal((await words(Q.stashFile(B, "src/auth/callback.ts")))[1].tip,
    "Copy: bring this file back into Changes, staged as it was stashed, and keep it in the stash");
  // The selection bar's Move and Copy say the same of the files selected.
  await cmdClick(p, Q.stashFile(B, "README.md"));
  await cmdClick(p, Q.stashFile(B, "src/auth/login.ts"));
  assert.equal(await p.eval<string>(`document.getElementById("selbar-move").dataset.tip`),
    "Move: take these 2 files out of the stash, back into Changes");
  await p.eval(`document.getElementById("selbar-clear").click()`);
  await p.send(state({ layout: "tree" }));
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

// The words are buttons on a hovered row: a fill of the ink darkens a light
// ground and lightens a dark one — towards the ink — so each must be checked
// on its own fill, at rest and under the pointer, in every theme.
for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: Apply, Pop, Move and Copy read at 4.5:1 on their button, at rest and under the pointer, and each button stands apart from its row`, { skip }, async () => {
    const p = await open(theme, 360);
    await p.send(state({ layout: "tree" }));
    await openStash(p, B);
    type Look = { fill: string; apart: number; text: number; lines: string[] };
    const hc = theme.startsWith("hc");
    const centre = (el: string) => p.eval<{ x: number; y: number }>(`(function () { var b = ${el}.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
    const pointAt = async (el: string, dx = 0) => {
      const c = await centre(el);
      await p.mouseMove(c.x + dx, c.y + 1);
      await p.mouseMove(c.x + dx, c.y);
    };
    for (const [what, row, act] of [
      ["a stash's Apply", Q.stash(B), "apply"],
      ["a stash's Pop", Q.stash(B), "pop"],
      ["a file's Move", Q.stashFile(B, "src/auth/login.ts"), "move"],
      ["a file's Copy", Q.stashFile(B, "src/auth/login.ts"), "copy"],
      ["a folder's Move", Q.stashFolder(B, "src/auth"), "move"],
    ] as const) {
      const btn = `${row}.querySelector('[data-act="${act}"]')`;
      // The row under the pointer (its left end), the button at rest.
      const r = await p.eval<{ x: number; y: number }>(`(function () { var b = ${row}.getBoundingClientRect(); return { x: Math.round(b.left + 50), y: Math.round(b.top + b.height / 2) }; })()`);
      await p.mouseMove(r.x, r.y + 1);
      await p.mouseMove(r.x, r.y);
      const rest = await p.eval<Look>(`window.__look(${btn}, { surface: ${row} })`);
      await pointAt(btn);
      const hover = await p.eval<Look>(`window.__look(${btn}, { surface: ${row} })`);
      for (const [when, l] of [["at rest", rest], ["under the pointer", hover]] as const) {
        assert.ok(l.text >= 4.5, `${what}, ${when}: its word reads ${l.text}:1 on its button (${JSON.stringify(l)})`);
        assert.ok(l.apart >= 1.15, `${what}, ${when}: the button stands ${l.apart}:1 apart from its row (${JSON.stringify(l)})`);
        if (hc) assert.ok(l.lines.length === 1 && /^outline solid/.test(l.lines[0]), `${what}: high contrast keeps its border (${JSON.stringify(l)})`);
        else assert.deepEqual(l.lines, [], `${what}, ${when}: no line`);
      }
      assert.notEqual(hover.fill, rest.fill, `${what}: the pointer on it raises its fill`);
    }
  });
}

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
