import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";
import { relativeTime } from "../src/util/relativeTime";

// The Changes view's rows and their tooltips, in the real page commitView.ts
// serves (a windowless Chrome, a real pointer). The rule: a tooltip only
// where it adds something — never the words already on the row, shown in
// full. A file at the repository's root showed its own name over its name
// ("README.md" over README.md); a file in a folder, shown as its name and
// its folder both whole, showed the two joined with a slash.
//
// State table: row {a changed file at the root, one in a folder (list: the
// folder on the row), the same with its folder cut at a narrow width, one in
// the tree layout (the folder is not on the row), a stash's file at the root,
// one in a folder, one renamed, a stash, a file's status letter, a word
// button} × width {360, 250}. And a tip too wide for the view wraps: a
// sentence between its words ("as it w / as stashed" read as broken), a
// name anywhere, each line filled.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const B = "b".repeat(40);
const now = Math.floor(Date.now() / 1000);
const DEEP = "packages/webview-ui/src/components/settings/advanced";

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    staged: [{ path: "src/index.ts", status: "M" }],
    unstaged: [
      { path: "package.json", status: "M" },
      { path: "src/routes.ts", status: "M" },
      { path: `${DEEP}/panel.ts`, status: "M" },
    ],
    stagedCount: 1,
    stashes: [{
      sha: B, text: "Fix login redirect", branch: "main", message: "On main: Fix login redirect", time: now - 14400,
      files: [
        { path: "README.md", status: "M" },
        { path: "src/auth/login.ts", status: "M" },
        { path: "src/auth/session.ts", oldPath: "src/auth/old-session.ts", status: "R" },
      ],
    }].map((s) => ({ ...s, rel: relativeTime(s.time), count: s.files.length })),
    ...over,
  };
}

async function open(width: number): Promise<ChangesPage> {
  const p = await ChangesPage.open("dark", { width, height: 700 });
  opened.push(p);
  await p.eval(`(function () {
    var s = document.createElement("style");
    s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(s);
  })()`);
  return p;
}

/** Hover el (near its left end, over its name) long enough for a tip; what the tip says, or null. */
async function hoverTip(p: ChangesPage, el: string, dx = 30): Promise<string | null> {
  const at = await p.eval<{ x: number; y: number }>(`(function () {
    var e = ${el}; if (!e) throw new Error("nothing at ${el.replace(/"/g, "'")}");
    var b = e.getBoundingClientRect(); return { x: Math.round(b.left + Math.min(${dx}, b.width / 2)), y: Math.round(b.top + b.height / 2) };
  })()`);
  await p.mouseMove(at.x, at.y + 1);
  await p.mouseMove(at.x, at.y);
  await sleep(600); // the tip's delay is 350ms
  const t = await p.eval<string | null>(`(function () { var t = document.querySelector(".gs-tip.show"); return t ? t.textContent : null; })()`);
  await p.mouseMove(2, 2);
  await sleep(20);
  return t;
}

const file = (kind: string, path: string) => `document.querySelector('#groups .row.is-file[data-key="${kind}:${path}"]')`;
const stashFile = (path: string) => `document.querySelector('#stashes [data-key="stash:${B}:${path}"]')`;
const stash = `document.querySelector('#stashes [data-tkey="stash:${B}"]')`;
const cut = (row: string, part: string) =>
  `(function () { var n = ${row}.querySelector("${part}"); return !!n && n.scrollWidth > n.clientWidth + 1; })()`;

for (const width of [360, 250]) {
  test(`${width}px: a row's tip only says what the row does not already show in full`, { skip }, async () => {
    const p = await open(width);
    await p.send(state());
    await p.eval(`${stash}.click()`);
    await p.page.waitFor(`!!${stashFile("README.md")}`);

    assert.equal(await hoverTip(p, file("unstaged", "package.json")), null, "a changed file at the root: its name is all there, no tip");
    assert.equal(await hoverTip(p, stashFile("README.md")), null, "a stash's file at the root: the same");
    for (const [what, row, path] of [
      ["a changed file", file("unstaged", "src/routes.ts"), "src/routes.ts"],
      ["a stash's file", stashFile("src/auth/login.ts"), "src/auth/login.ts"],
    ] as const) {
      const isCut = await p.eval<boolean>(`${cut(row, ".dir")} || ${cut(row, ".name")}`);
      assert.equal(await hoverTip(p, row), isCut ? path : null,
        isCut ? `${what}, its folder cut short: the whole path` : `${what} and its folder, both whole on the row: no tip joining them`);
    }
    assert.ok(await p.eval<boolean>(cut(file("unstaged", `${DEEP}/panel.ts`), ".dir")), "the deep folder is cut on the row");
    assert.equal(await hoverTip(p, file("unstaged", `${DEEP}/panel.ts`)), `${DEEP}/panel.ts`, "a folder cut short: the whole path");
    assert.equal(await hoverTip(p, stashFile("src/auth/session.ts")), "src/auth/session.ts (was src/auth/old-session.ts)", "a renamed file: what it was");
    assert.match(String(await hoverTip(p, stash, 60)), /^On main: Fix login redirect — /, "a stash: git's whole message, and when");
    assert.equal(await hoverTip(p, `${file("unstaged", "package.json")}.querySelector(".status")`, 4), "Modified", "a status letter: the word for it");

    // The tree layout: a file's row is its name alone, under its folder — the path adds the folder.
    await p.send(state({ layout: "tree" }));
    assert.equal(await hoverTip(p, file("unstaged", "src/routes.ts")), "src/routes.ts", "in the tree, the row has no folder: the tip does");
    assert.equal(await hoverTip(p, file("unstaged", "package.json")), null, "at the root, still nothing to add");
    assert.deepEqual(p.page.errors, []);
  });
}

/** The tip that is up: its text, and where its lines break ("ab|cd"), and how many break inside a word. */
const tipLines = (p: ChangesPage) => p.eval<{ text: string; breaks: string[]; inWord: number }>(`(function () {
  var t = document.querySelector(".gs-tip.show"); var node = t.firstChild; var text = node.textContent;
  var r = document.createRange(); var last = null; var at = [];
  for (var i = 0; i < text.length; i++) {
    r.setStart(node, i); r.setEnd(node, i + 1);
    var rects = r.getClientRects(); if (!rects.length) continue;
    var top = Math.round(rects[0].top);
    if (last !== null && top > last + 2) at.push(i);
    last = top;
  }
  return {
    text: text,
    breaks: at.map(function (i) { return text.slice(Math.max(0, i - 4), i) + "|" + text.slice(i, i + 4); }),
    inWord: at.filter(function (i) { return text[i - 1] !== " " && text[i] !== " "; }).length,
  };
})()`);

test("a tip too wide for the view wraps a sentence between its words, and a name anywhere", { skip }, async () => {
  const p = await open(300);
  await p.send(state({
    stashes: [{
      sha: B, text: "Fix login redirect", branch: "main", message: "On main: Fix login redirect", time: now - 14400, rel: relativeTime(now - 14400), count: 1,
      files: [{ path: "src/auth/callback.ts", status: "A", staged: "all" }],
    }],
  }));
  await p.eval(`${stash}.click()`);
  const row = stashFile("src/auth/callback.ts");
  await p.page.waitFor(`!!${row}`);
  // The row under the pointer shows its words; then the pointer on Move.
  const r = await p.eval<{ x: number; y: number }>(`(function () { var b = ${row}.getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()`);
  await p.mouseMove(r.x, r.y + 1);
  await p.mouseMove(r.x, r.y);
  const m = await p.eval<{ x: number; y: number }>(`(function () { var b = ${row}.querySelector('[data-act="move"]').getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) }; })()`);
  await p.mouseMove(m.x, m.y + 1);
  await p.mouseMove(m.x, m.y);
  await sleep(600);
  const sentence = await tipLines(p);
  assert.equal(sentence.text, "Move: take this file out of the stash, back into Staged as it was stashed");
  assert.ok(sentence.breaks.length > 0, `it wraps at this width: ${JSON.stringify(sentence)}`);
  assert.equal(sentence.inWord, 0, `never inside a word: ${JSON.stringify(sentence.breaks)}`);
  await p.mouseMove(2, 2);
  await sleep(20);

  await p.resize(250, 700);
  await p.send(state());
  const nameAt = await p.eval<{ x: number; y: number }>(`(function () { var b = ${file("unstaged", `${DEEP}/panel.ts`)}.getBoundingClientRect(); return { x: Math.round(b.left + 30), y: Math.round(b.top + b.height / 2) }; })()`);
  await p.mouseMove(nameAt.x, nameAt.y + 1);
  await p.mouseMove(nameAt.x, nameAt.y);
  await sleep(600);
  const name = await tipLines(p);
  assert.equal(name.text, `${DEEP}/panel.ts`);
  assert.ok(name.inWord > 0, `a path breaks anywhere, each line filled: ${JSON.stringify(name.breaks)}`);
});
