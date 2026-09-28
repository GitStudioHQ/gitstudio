// The Changes view's Stashes group, rendered for real: the page commitView.ts
// serves, in a windowless Chrome, driven with real keys and clicks
// (changesPage.ts). The stash doors behind it are stashesInChanges.test.ts;
// git's half is packages/git-service/test/stashFiles.test.ts.
//
// The state table:
//   list     none (no group) · several · one gone · one replaced by what is
//            left of it (a move) · re-posted identical · not carried (kept)
//   row      closed · open (every file: M A D R U, staged, partly staged) ·
//            busy · gone at the click and back when it did not happen
//   select   files of one stash · then the working tree's · then another
//            stash's · the bar's verbs
//   keys     Enter / Space open, Shift+F10 the menu, Delete asks Drop, Escape
//            gives the row the keyboard back, a popped row hands it on
//   view     split and checkboxes models · list and tree layouts · Dark+,
//            Light+ and both High Contrast themes (computed styles)
//   memory   what was opened survives a reload (the webview's state)

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, type VsCodeTheme } from "./changesPage";
import { relativeTime } from "../src/util/relativeTime";

const skip = ChangesPage.chrome() ? false : "no windowless Chrome here (set GS_CHROME)";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const R = "d".repeat(40);
const now = Math.floor(Date.now() / 1000);

const FILES_B = [
  { path: "assets/logo.png", status: "M", binary: true },
  { path: "docs/sign-in.md", oldPath: "docs/guide.md", status: "R", staged: "all" },
  { path: "src/auth/callback.ts", status: "A", staged: "all" },
  { path: "src/auth/login.ts", status: "M", staged: "part" },
  { path: "src/auth/oauth.test.ts", status: "U" },
  { path: "src/routes.ts", status: "D", staged: "all" },
];

function stashes(): Record<string, unknown>[] {
  return [
    { sha: A, text: "WIP: Initial layout", branch: "main", auto: true, message: "WIP on main: 1a2b3c4 Initial layout", time: now - 2 * 3600, files: [{ path: "src/app.ts", status: "M" }] },
    { sha: B, text: "Fix login redirect", branch: "main", message: "On main: Fix login redirect", time: now - 4 * 3600, files: FILES_B },
    { sha: C, text: "Release notes", message: "Release notes", time: now - 30 * 86400, files: [{ path: "README.md", status: "M" }, { path: "CHANGELOG.md", status: "M" }] },
  ];
}

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: "state",
    hasRepo: true,
    merge: [],
    staged: [],
    unstaged: [
      { path: "src/app.ts", status: "M" },
      { path: "src/routes.ts", status: "M" },
    ],
    stagedCount: 0,
    stagingModel: "split",
    branch: "main",
    upstream: "origin/main",
    ahead: 0,
    behind: 0,
    unpushed: 0,
    canPublish: true,
    repoName: "web-app",
    repoCount: 1,
    signoffDefault: false,
    aiEnabled: false,
    layout: "list",
    busy: false,
    branches: { local: [{ name: "main", current: true, favorite: false }], remote: [], recent: [], tags: [] },
    stashes: stashes(),
    ...over,
  };
  // Each row's age comes from the host (stashRows: relativeTime), as it would.
  const list = out.stashes as Record<string, unknown>[] | undefined;
  if (list) out.stashes = list.map((s) => ("rel" in s ? s : { ...s, rel: relativeTime(s.time as number) }));
  return out;
}

const row = (sha: string) => `document.querySelector('#stashes [data-tkey="stash:${sha}"]')`;
const fileRow = (sha: string, path: string) => `document.querySelector('#stashes [data-key="stash:${sha}:${path}"]')`;

/** What the group shows: each stash's words, meta, open state, and its files' letters. */
async function shown(page: ChangesPage): Promise<{ header: string | null; rows: string[]; files: string[] }> {
  return page.eval(`(() => {
    const el = document.getElementById("stashes");
    if (el.hidden) return { header: null, rows: [], files: [] };
    const h = el.querySelector(".group-header");
    return {
      header: h ? h.querySelector(".glabel").textContent + " " + h.querySelector(".gcount").textContent : null,
      rows: Array.from(el.querySelectorAll(".stash-row")).map((r) =>
        r.querySelector(".stash-msg").textContent + " | " + r.querySelector(".stash-meta").textContent + " | " + r.getAttribute("aria-expanded")),
      files: Array.from(el.querySelectorAll(".row.is-file")).map((r) =>
        r.querySelector(".name").textContent + " " + r.querySelector(".status").textContent +
        (r.querySelector(".stash-staged") ? " " + r.querySelector(".stash-staged").textContent : "")),
    };
  })()`);
}

const posted = async (page: ChangesPage, type: string) =>
  (await page.posted()).filter((m) => m.type === type);
const clearPosted = (page: ChangesPage) => page.eval("window.__posted.length = 0");
const active = (page: ChangesPage) =>
  page.eval<string>("(document.activeElement && (document.activeElement.dataset.tkey || document.activeElement.className)) || ''");

for (const theme of ["dark", "light"] as VsCodeTheme[]) {
  test(`${theme}: no stashes, no group; several, a row each — its words, where and when, how many files, never stash@{n}`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state({ stashes: [] }));
      assert.equal((await shown(page)).header, null, "no stashes: no group, not an empty band");
      await page.send(state());
      const s = await shown(page);
      assert.equal(s.header, "Stashes 3");
      assert.deepEqual(s.rows, [
        "WIP: Initial layout | main · 2h · 1 file | false",
        "Fix login redirect | main · 4h · 6 files | false",
        "Release notes | 1mo · 2 files | false",
      ]);
      assert.deepEqual(s.files, [], "each stash starts closed");
      const text = await page.eval<string>("document.getElementById('stashes').textContent");
      assert.doesNotMatch(text, /stash@\{|On main:/);
      // Not carried in a post (right after a stash action): kept as shown.
      await page.send(state({ stashes: undefined }));
      assert.equal((await shown(page)).rows.length, 3);
      // No repository: gone.
      await page.send(state({ hasRepo: false, stashes: [] }));
      assert.equal((await shown(page)).header, null);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: a stash opens to ALL its files, as Changes rows; a click opens a file's diff by the stash's sha`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(B)}.click()`);
      const s = await shown(page);
      assert.equal(s.rows[1].endsWith("| true"), true);
      assert.deepEqual(s.files, [
        "logo.png M",
        "sign-in.md R staged",
        "callback.ts A staged",
        "login.ts M partly staged",
        "oauth.test.ts U",
        "routes.ts D staged",
      ]);
      await clearPosted(page);
      await page.eval(`${fileRow(B, "src/auth/login.ts")}.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }))`);
      assert.deepEqual(await posted(page, "stashOpenFile"), [{ type: "stashOpenFile", sha: B, path: "src/auth/login.ts" }]);
      // The menu offers the staged version only where there is one.
      await page.eval(`${fileRow(B, "src/auth/login.ts")}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))`);
      const items = await page.eval<string[]>("Array.from(document.querySelectorAll('.action-menu .bm-subaction')).map((b) => b.textContent.trim())");
      assert.deepEqual(items, ["Open Changes", "Open Staged Changes", "Move to Changes", "Copy to Changes"]);
      await page.key("Escape");
      await page.eval(`${fileRow(B, "src/auth/oauth.test.ts")}.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true }))`);
      const plain = await page.eval<string[]>("Array.from(document.querySelectorAll('.action-menu .bm-subaction')).map((b) => b.textContent.trim())");
      assert.deepEqual(plain, ["Open Changes", "Move to Changes", "Copy to Changes"]);
      await page.key("Escape");
      // The tree layout: the same files, under their folders.
      await page.send(state({ layout: "tree" }));
      const folders = await page.eval<string[]>(
        "Array.from(document.querySelectorAll('#stashes [data-tkey^=\"stashfolder:\"] .name')).map((n) => n.textContent)",
      );
      assert.deepEqual(folders, ["assets", "docs", "src", "auth"]);
      assert.equal((await shown(page)).files.length, 6);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: an identical re-post touches nothing — the same rows, the keyboard where it was, the stash still open`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(B)}.click()`);
      await page.eval(`window.__keep = ${fileRow(B, "src/auth/login.ts")}; window.__keep.focus()`);
      for (let i = 0; i < 3; i++) await page.send(state());
      assert.equal(await page.eval<boolean>(`window.__keep === ${fileRow(B, "src/auth/login.ts")} && window.__keep.isConnected`), true);
      assert.equal(await active(page), `stash:${B}:src/auth/login.ts`);
      // A change elsewhere in the list repaints — and the keyboard stays on the same file.
      const changed = stashes();
      changed.splice(2, 1);
      await page.send(state({ stashes: changed }));
      assert.equal(await active(page), `stash:${B}:src/auth/login.ts`);
      assert.equal((await shown(page)).rows.length, 2);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: Pop takes the row away at the click and puts it back when it did not happen`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await clearPosted(page);
      await page.eval(`${row(B)}.querySelector('.row-actions [data-act="pop"]').click()`);
      assert.deepEqual(await posted(page, "stashAct"), [{ type: "stashAct", sha: B, action: "pop" }]);
      assert.equal((await shown(page)).rows.length, 2, "gone at the click");
      // A state from before the pop (the firehose) does not bring it back.
      await page.send(state());
      assert.equal((await shown(page)).rows.length, 2);
      // Cancelled at a question: back.
      await page.send({ type: "stashDone", sha: B, action: "pop", outcome: { kind: "kept" } });
      assert.equal((await shown(page)).rows.length, 3, "back when nothing happened");
      // Popped: gone, and the list read after it agrees.
      await page.eval(`${row(B)}.querySelector('.row-actions [data-act="pop"]').click()`);
      await page.send({ type: "stashDone", sha: B, action: "pop", outcome: { kind: "done" } });
      const after = stashes().filter((s) => s.sha !== B);
      await page.send(state({ stashes: after }));
      assert.deepEqual((await shown(page)).rows.map((r) => r.split(" | ")[0]), ["WIP: Initial layout", "Release notes"]);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: Apply keeps the row, busy until it is over; Drop asks first and the row leaves once answered`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(A)}.querySelector('.row-actions [data-act="apply"]').click()`);
      assert.equal(await page.eval<string>(`${row(A)}.getAttribute("aria-busy")`), "true");
      assert.ok(Number(await page.eval<string>(`getComputedStyle(${row(A)}).opacity`)) < 1, "dimmed while it runs");
      await page.send({ type: "stashDone", sha: A, action: "apply", outcome: { kind: "done" } });
      assert.equal(await page.eval<string | null>(`${row(A)}.getAttribute("aria-busy")`), null);
      assert.equal((await shown(page)).rows.length, 3, "Apply keeps the stash");
      // Delete on a row asks to drop it; nothing leaves until the answer.
      await clearPosted(page);
      await page.eval(`${row(C)}.focus()`);
      await page.key("Delete");
      assert.deepEqual(await posted(page, "stashAct"), [{ type: "stashAct", sha: C, action: "drop" }]);
      assert.equal((await shown(page)).rows.length, 3, "the question is up; the row waits");
      await page.send({ type: "stashPending", sha: C, action: "drop" });
      assert.equal((await shown(page)).rows.length, 2, "answered: the row leaves");
      // …and a drop that failed brings it back.
      await page.send({ type: "stashDone", sha: C, action: "drop", outcome: { kind: "kept" } });
      assert.equal((await shown(page)).rows.length, 3);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: Move to Changes takes the files away at the click; what is left stays open under its new sha`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(B)}.click()`);
      await clearPosted(page);
      await page.eval(`${fileRow(B, "src/auth/login.ts")}.querySelector('.row-actions [data-act="move"]').click()`);
      assert.deepEqual(await posted(page, "stashFiles"), [{ type: "stashFiles", sha: B, action: "move", paths: ["src/auth/login.ts"] }]);
      assert.equal((await shown(page)).files.includes("login.ts M partly staged"), false, "gone at the click");
      assert.match((await shown(page)).rows[1], /5 files/);
      // Moved: the host's list has what is left, under a new sha, in the same place.
      await page.send({ type: "stashDone", sha: B, action: "move", paths: ["src/auth/login.ts"], outcome: { kind: "done", rest: R } });
      const list = stashes();
      list[1] = { ...list[1], sha: R, files: FILES_B.filter((f) => f.path !== "src/auth/login.ts") };
      await page.send(state({ stashes: list }));
      const s = await shown(page);
      assert.equal(s.rows[1], "Fix login redirect | main · 4h · 5 files | true", "still open");
      assert.equal(await page.eval<boolean>(`!!${fileRow(R, "src/routes.ts")}`), true);
      // A move that did not happen puts the file back.
      await page.eval(`${fileRow(R, "src/routes.ts")}.querySelector('.row-actions [data-act="move"]').click()`);
      assert.equal((await shown(page)).files.length, 4);
      await page.send({ type: "stashDone", sha: R, action: "move", outcome: { kind: "kept" } });
      assert.equal((await shown(page)).files.length, 5);
      // Moving a stash's last file takes the stash with it.
      await page.eval(`${row(A)}.click()`);
      await page.eval(`${fileRow(A, "src/app.ts")}.querySelector('.row-actions [data-act="move"]').click()`);
      assert.deepEqual((await shown(page)).rows.map((r) => r.split(" | ")[0]), ["Fix login redirect", "Release notes"]);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: a selection lives in one place — one stash's files, or the working tree's — and the bar offers its verbs`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(B)}.click()`);
      await page.eval(`${row(C)}.click()`);
      const ctrl = (sel: string) => page.eval(`${sel}.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, detail: 1 }))`);
      await ctrl(fileRow(B, "src/auth/login.ts"));
      await ctrl(fileRow(B, "src/routes.ts"));
      const bar = () =>
        page.eval<{ hidden: boolean; count: string; buttons: string[]; after: string }>(`(() => {
          const b = document.getElementById("selbar");
          return {
            hidden: b.hidden,
            count: document.getElementById("selbar-count").textContent,
            buttons: Array.from(b.querySelectorAll(".selbar-btn")).filter((x) => getComputedStyle(x).display !== "none").map((x) => x.textContent.trim()),
            after: b.previousElementSibling ? b.previousElementSibling.id : "",
          };
        })()`);
      assert.deepEqual(await bar(), {
        hidden: false,
        count: "2 files from “Fix login redirect”",
        buttons: ["Move to Changes", "Copy to Changes", "Clear"],
        after: "stashes",
      });
      await clearPosted(page);
      await page.eval(`document.getElementById("selbar-copy").click()`);
      assert.deepEqual(await posted(page, "stashFiles"), [
        { type: "stashFiles", sha: B, action: "copy", paths: ["src/auth/login.ts", "src/routes.ts"] },
      ]);
      // Select again, then Ctrl-click another stash's file: that one alone.
      await page.send({ type: "stashDone", sha: B, action: "copy", outcome: { kind: "done" } });
      await ctrl(fileRow(B, "src/auth/login.ts"));
      await ctrl(fileRow(C, "README.md"));
      assert.deepEqual(await page.eval<string[]>("Array.from(document.querySelectorAll('#stashes .row.is-selected')).map((r) => r.dataset.key)"), [`stash:${C}:README.md`]);
      // …then a working-tree file: the stash's selection is over, the bar is the tree's.
      await ctrl(`document.querySelector('#groups .row.is-file[data-path="src/app.ts"]')`);
      assert.equal(await page.eval<number>("document.querySelectorAll('#stashes .row.is-selected').length"), 0);
      const tree = await bar();
      assert.deepEqual([tree.count, tree.buttons, tree.after], ["1 file selected", ["Stash", "Stage", "Clear"], "groups"]);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: Shift after a plain click in another stash starts there — never a range over two stashes`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(B)}.click()`);
      await page.eval(`${row(C)}.click()`);
      const click = (sel: string, mods = "") =>
        page.eval(`${sel}.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1${mods} }))`);
      const selected = () =>
        page.eval<string[]>("Array.from(document.querySelectorAll('#stashes .row.is-file.is-selected')).map((r) => r.dataset.key)");
      // A plain click opens a file of one stash, with nothing selected…
      await click(fileRow(B, "src/routes.ts"));
      await clearPosted(page);
      // …and Shift-click in the next stash is a plain click there: its diff, no range.
      await click(fileRow(C, "README.md"), ", shiftKey: true");
      assert.deepEqual(await selected(), [], "nothing selected across two stashes");
      assert.deepEqual(await posted(page, "stashOpenFile"), [{ type: "stashOpenFile", sha: C, path: "README.md" }]);
      assert.equal(await page.eval<boolean>(`document.getElementById("selbar").hidden`), true);
      // The next Shift-click ranges from there, inside that stash only.
      await click(fileRow(C, "CHANGELOG.md"), ", shiftKey: true");
      assert.deepEqual(await selected(), [`stash:${C}:README.md`, `stash:${C}:CHANGELOG.md`]);
      assert.equal(await page.eval<string>(`document.getElementById("selbar-count").textContent`), "2 files from “Release notes”");
      await clearPosted(page);
      await page.eval(`document.getElementById("selbar-move").click()`);
      assert.deepEqual(await posted(page, "stashFiles"), [
        { type: "stashFiles", sha: C, action: "move", paths: ["README.md", "CHANGELOG.md"] },
      ]);
      // Every file of C moved: its row goes; B is untouched.
      assert.deepEqual((await shown(page)).rows.map((r) => r.split(" | ")[0]), ["WIP: Initial layout", "Fix login redirect"]);
      assert.equal((await shown(page)).files.length, FILES_B.length, "B keeps every file");
    } finally {
      await page.close();
    }
  });

  test(`${theme}: the keyboard — Enter and Space open, Shift+F10 the menu, Escape gives the row the keyboard back, a popped row hands it on`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(A)}.focus()`);
      await page.key("Enter");
      assert.equal(await page.eval<string>(`${row(A)}.getAttribute("aria-expanded")`), "true");
      assert.equal(await active(page), `stash:${A}`, "the keyboard stays on the row it opened");
      await page.key(" ");
      assert.equal(await page.eval<string>(`${row(A)}.getAttribute("aria-expanded")`), "false");
      await page.key("F10", { with: ["shift"] });
      const items = await page.eval<string[]>("Array.from(document.querySelectorAll('.action-menu .bm-subaction')).map((b) => b.textContent.trim())");
      assert.deepEqual(items, ["Open All Changes", "Apply", "Pop", "Create Branch…", "Drop…"]);
      await page.key("Escape");
      assert.equal(await page.eval<number>("document.querySelectorAll('.action-menu').length"), 0);
      assert.equal(await active(page), `stash:${A}`, "Escape hands the keyboard back to the row");
      // Pop from the menu: the row leaves, and the next one has the keyboard.
      await page.key("F10", { with: ["shift"] });
      await page.eval("Array.from(document.querySelectorAll('.action-menu .bm-subaction')).find((b) => b.textContent.trim() === 'Pop').click()");
      assert.equal(await active(page), `stash:${B}`);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: the Stashes group is part of the Changes tree — one tab stop, the arrows walk into it, Right and Left open and step`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      const items = () =>
        page.eval<{ tkey: string; level: string | null; tab: number }[]>(`Array.from(document.querySelectorAll('#stashes [role="treeitem"]')).map((n) => ({ tkey: n.dataset.tkey, level: n.getAttribute("aria-level"), tab: n.tabIndex }))`);
      // Treeitems of the list's tree, a level under their parent, none a tab stop of its own.
      assert.deepEqual((await items()).map((i) => [i.tkey, i.level, i.tab]), [
        ["group:stashes", "1", -1],
        [`stash:${A}`, "2", -1],
        [`stash:${B}`, "2", -1],
        [`stash:${C}`, "2", -1],
      ]);
      assert.equal(await page.eval<string | null>(`document.getElementById("groups").getAttribute("aria-owns")`), "stashes");
      assert.equal(await page.eval<number>(`document.querySelectorAll('#stashes button:not([tabindex="-1"])').length`), 0, "the rows' buttons are the pointer's");
      // From the working tree's last file, Down reaches the group, then a stash.
      await page.eval(`document.querySelector('#groups .row.is-file[data-path="src/routes.ts"]').focus()`);
      await page.key("ArrowDown");
      assert.equal(await active(page), "group:stashes");
      await page.key("ArrowDown");
      assert.equal(await active(page), `stash:${A}`);
      // Right opens the stash, Right again steps into its first file, Left back out.
      await page.key("ArrowRight");
      assert.equal(await page.eval<string>(`${row(A)}.getAttribute("aria-expanded")`), "true");
      assert.equal(await active(page), `stash:${A}`);
      await page.key("ArrowRight");
      assert.equal(await active(page), `stash:${A}:src/app.ts`);
      assert.equal(await page.eval<string | null>(`${fileRow(A, "src/app.ts")}.getAttribute("aria-level")`), "3");
      await clearPosted(page);
      await page.key("Enter");
      assert.deepEqual(await posted(page, "stashOpenFile"), [{ type: "stashOpenFile", sha: A, path: "src/app.ts" }]);
      await page.key("ArrowLeft");
      assert.equal(await active(page), `stash:${A}`);
      await page.key("ArrowLeft");
      assert.equal(await page.eval<string>(`${row(A)}.getAttribute("aria-expanded")`), "false");
      // Still one tab stop in the whole tree: the row the keyboard is on.
      const stops = await page.eval<string[]>(`Array.from(document.querySelectorAll('#groups [role="treeitem"], #stashes [role="treeitem"]')).filter((n) => n.tabIndex === 0).map((n) => n.dataset.tkey)`);
      assert.deepEqual(stops, [`stash:${A}`]);
      // Up from the group's header goes back to the working tree.
      await page.key("Home");
      assert.equal(await page.eval<boolean>(`!!document.activeElement.closest("#groups")`), true);
      await page.key("End");
      assert.equal(await active(page), `stash:${C}`);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: the last stash leaving hands the keyboard to the row above the group, never to the page`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      const one = () => stashes().slice(0, 1);
      const lastTreeRow = `stash-less: ${await (async () => {
        await page.send(state({ stashes: one() }));
        return page.eval<string>("Array.from(document.querySelectorAll('#groups [data-tkey]')).pop().dataset.tkey");
      })()}`;
      const where = () => page.eval<string>(`(() => {
        const a = document.activeElement;
        if (!a || a === document.body) return "BODY";
        return a.closest("#groups") ? "stash-less: " + a.dataset.tkey : (a.dataset.tkey || a.id || a.className);
      })()`);
      // Pop from its menu.
      await page.eval(`${row(A)}.focus()`);
      await page.key("F10", { with: ["shift"] });
      await page.eval("Array.from(document.querySelectorAll('.action-menu .bm-subaction')).find((b) => b.textContent.trim() === 'Pop').click()");
      assert.equal((await shown(page)).header, null, "the group is gone");
      assert.equal(await where(), lastTreeRow, "the working tree's last row has it");
      // Drop from the keyboard: Delete, the question, Enter.
      await page.send({ type: "stashDone", sha: A, action: "pop", outcome: { kind: "kept" } });
      await page.eval(`${row(A)}.focus()`);
      await page.key("Delete");
      await page.send({ type: "dialog", dialogId: "q1", spec: { kind: "confirm", title: "Drop “WIP: Initial layout”?", message: "…", confirmLabel: "Drop", danger: true } });
      await page.key("Enter");
      await page.send({ type: "stashPending", sha: A, action: "drop" });
      assert.equal((await shown(page)).header, null);
      assert.equal(await where(), lastTreeRow);
      // …and when the list the host reads next agrees, it stays there.
      await page.send({ type: "stashDone", sha: A, action: "drop", outcome: { kind: "done" } });
      await page.send(state({ stashes: [] }));
      assert.equal(await where(), lastTreeRow);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: what was opened, and a folded group, survive a reload`, { skip }, async () => {
    const first = await ChangesPage.open(theme, { width: 300, height: 900 });
    let kept: unknown;
    try {
      await first.send(state());
      await first.eval(`${row(C)}.click()`);
      kept = await first.eval("window.__gsState");
    } finally {
      await first.close();
    }
    const again = await ChangesPage.open(theme, { width: 300, height: 900, webviewState: kept });
    try {
      await again.send(state());
      assert.deepEqual((await shown(again)).rows.map((r) => r.endsWith("| true")), [false, false, true]);
      await again.eval(`document.querySelector("#stashes .group-header").click()`);
      assert.equal(await again.eval<string>(`document.querySelector("#stashes .group-header").getAttribute("aria-expanded")`), "false");
      assert.equal((await shown(again)).rows.length, 0, "folded: the rows are hidden");
      const folded = await again.eval("window.__gsState");
      assert.deepEqual((folded as { stashGroupCollapsed?: boolean }).stashGroupCollapsed, true);
    } finally {
      await again.close();
    }
  });

  test(`${theme}: the checkbox model shows the same group; a question open while the list changes stays open`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state({ stagingModel: "checkboxes" }));
      assert.equal((await shown(page)).header, "Stashes 3");
      await page.send({ type: "dialog", dialogId: "q1", spec: { kind: "confirm", title: "Drop “Fix login redirect”?", message: "…", confirmLabel: "Drop", danger: true } });
      const moved = stashes();
      moved.unshift({ sha: R, text: "pushed meanwhile", branch: "main", message: "On main: pushed meanwhile", time: now, files: [{ path: "x.ts", status: "M" }] });
      await page.send(state({ stagingModel: "checkboxes", stashes: moved }));
      assert.equal(await page.eval<number>("document.querySelectorAll('.rp-panel').length"), 1, "the question is still up");
      assert.equal((await shown(page)).header, "Stashes 4");
    } finally {
      await page.close();
    }
  });
}

// ── A stash too big to carry: its files read when it opens, shown a page at a time ──
//
// The host carries a stash's files in the list only while they are few
// (stashesPayload.test.ts); a bigger one comes as a count, and the page asks
// for its files when it is opened. It shows them a page at a time.

// The other direction: the working tree's last row leaving (staged or
// discarded, from its menu or from the host) keeps the keyboard in the
// working tree — the row above it — never on the Stashes header below, which
// is the next treeitem in the list but not a neighbour of the file that left.
test("the working tree's last row leaving hands the keyboard to the row above it, never down into the Stashes group", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 300, height: 900 });
  const routes = `document.querySelector('#groups .row.is-file[data-path="src/routes.ts"]')`;
  const APP = { path: "src/app.ts", status: "M" };
  const ROUTES = { path: "src/routes.ts", status: "M" };
  try {
    for (const [label, list] of [["one stash", stashes().slice(0, 1)], ["several", stashes()], ["none", []]] as const) {
      // From the host: staged elsewhere, then discarded elsewhere.
      for (const [how, next] of [
        ["staged", { unstaged: [APP], staged: [ROUTES], stagedCount: 1 }],
        ["discarded", { unstaged: [APP] }],
      ] as const) {
        await page.send(state({ stashes: list }));
        await page.eval(`${routes}.focus()`);
        await page.send(state({ stashes: list, ...next }));
        assert.equal(await active(page), "f:unstaged:src/app.ts", `${label}, ${how} by the host`);
      }
      // From its own menu: Stage, at once (the list patched) and once the host agrees.
      await page.reload();
      await page.send(state({ stashes: list }));
      await page.eval(`${routes}.focus()`);
      await page.key("F10", { with: ["shift"] });
      const items = await page.eval<string[]>("Array.from(document.querySelectorAll('.action-menu .bm-subaction')).map((b) => b.textContent.trim())");
      for (let k = 0; k < items.indexOf("Stage"); k++) await page.key("ArrowDown");
      await page.key("Enter", { typed: true });
      assert.equal(await active(page), "f:unstaged:src/app.ts", `${label}, Stage from the menu, at once`);
      await page.send(state({ stashes: list, unstaged: [APP], staged: [ROUTES], stagedCount: 1 }));
      assert.equal(await active(page), "f:unstaged:src/app.ts", `${label}, Stage from the menu, once the host agrees`);
    }
  } finally {
    await page.close();
  }
});

const BIG = "e".repeat(40);
const BIG_FILES =Array.from({ length: 450 }, (_, i) => ({ path: `deps/pkg${String(i).padStart(3, "0")}.js`, status: "U" }));
function bigState(over: Record<string, unknown> = {}): Record<string, unknown> {
  const list = stashes();
  // A minute before the page reads it — this moment's, not the file's load: a
  // slow runner is minutes into the file by now.
  list.unshift({ sha: BIG, text: "oops, deps too", branch: "main", message: "On main: oops, deps too", time: Math.floor(Date.now() / 1000) - 60, count: 450 });
  return state({ stashes: list, ...over });
}
const reads = async (page: ChangesPage) => (await posted(page, "stashReadFiles")).map((m) => m.sha);
const shownFiles = (page: ChangesPage, sha: string) =>
  page.eval<number>(`document.querySelectorAll('#stashes .row.is-file[data-sha="${sha}"]').length`);
const moreRow = (page: ChangesPage) =>
  page.eval<string | null>(`(() => { const m = document.querySelector('#stashes .stash-more'); return m ? m.textContent : null; })()`);

test("a stash sent as a count: its files are asked for once, when it opens — and shown 200 at a time", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 300, height: 900 });
  try {
    await page.send(bigState());
    assert.match((await shown(page)).rows[0], /^oops, deps too \| main · 1m · 450 files \| false$/);
    assert.deepEqual(await reads(page), [], "nothing asked for a closed stash");
    await page.eval(`${row(BIG)}.click()`);
    assert.deepEqual(await reads(page), [BIG]);
    const loading = await page.eval<{ text: string; busy: string | null }>(`(() => {
      const r = document.querySelector('#stashes .stash-note');
      return { text: r ? r.textContent : "", busy: r ? r.getAttribute("aria-busy") : null };
    })()`);
    assert.deepEqual(loading, { text: "Reading its files…", busy: "true" });
    // The firehose re-posts the list, and a stash pushed meanwhile repaints
    // the group: nothing is asked twice.
    await page.send(bigState());
    const pushed = (bigState().stashes as Record<string, unknown>[]).slice();
    pushed.unshift({ sha: R, text: "pushed meanwhile", branch: "main", message: "On main: pushed meanwhile", time: now, files: [{ path: "x.ts", status: "M" }] });
    await page.send(bigState({ stashes: pushed }));
    assert.equal((await shown(page)).header, "Stashes 5", "repainted");
    assert.deepEqual(await reads(page), [BIG]);
    await page.send({ type: "stashFilesRead", sha: BIG, files: BIG_FILES });
    assert.equal(await page.eval<number>("document.querySelectorAll('#stashes .stash-note').length"), 0);
    assert.equal(await shownFiles(page, BIG), 200);
    assert.equal(await moreRow(page), "Show 200 more of 250");
    await page.eval("document.querySelector('#stashes .stash-more').click()");
    assert.equal(await shownFiles(page, BIG), 400);
    assert.equal(await moreRow(page), "Show 50 more");
    // From the keyboard: Enter on the row, and the keyboard goes on to the files it showed.
    await page.eval("document.querySelector('#stashes .stash-more').focus()");
    await page.key("Enter");
    assert.equal(await shownFiles(page, BIG), 450);
    assert.equal(await moreRow(page), null);
    assert.equal(await active(page), `stash:${BIG}:deps/pkg400.js`);
    // Closed and opened again: read once, never again.
    await page.eval(`${row(BIG)}.click()`);
    await page.eval(`${row(BIG)}.click()`);
    assert.deepEqual(await reads(page), [BIG]);
    assert.equal(await shownFiles(page, BIG), 200, "a page again, from the top");
  } finally {
    await page.close();
  }
});

test("a stash whose files cannot be read says so, in the place its files would be", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 300, height: 900 });
  try {
    await page.send(bigState());
    await page.eval(`${row(BIG)}.click()`);
    await page.send({ type: "stashFilesRead", sha: BIG, files: null });
    assert.equal(await page.eval<string>("document.querySelector('#stashes .stash-note').textContent"), "Its files couldn't be read.");
    assert.equal(await page.eval<string | null>("document.querySelector('#stashes .stash-note').getAttribute('aria-busy')"), null);
  } finally {
    await page.close();
  }
});

test("the tree layout pages too; a folder's Move takes every file under it, shown or not", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 300, height: 900 });
  try {
    await page.send(bigState({ layout: "tree" }));
    await page.eval(`${row(BIG)}.click()`);
    await page.send({ type: "stashFilesRead", sha: BIG, files: BIG_FILES });
    assert.equal(await shownFiles(page, BIG), 200);
    assert.equal(await moreRow(page), "Show 200 more of 250");
    await clearPosted(page);
    await page.eval(`document.querySelector('#stashes [data-tkey="stashfolder:${BIG}:deps"] .row-actions [data-act="move"]').click()`);
    const moves = await posted(page, "stashFiles");
    assert.equal(moves.length, 1);
    assert.equal((moves[0].paths as string[]).length, 450, "all of the folder, not the page on screen");
    assert.equal((await shown(page)).rows.some((r) => r.startsWith("oops")), false, "every file: the stash goes");
  } finally {
    await page.close();
  }
});

test("Ctrl-click on a stash not read yet opens it, and selects its files once they arrive", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 300, height: 900 });
  try {
    await page.send(bigState());
    await page.eval(`${row(BIG)}.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true, detail: 1 }))`);
    assert.deepEqual(await reads(page), [BIG]);
    await page.send({ type: "stashFilesRead", sha: BIG, files: BIG_FILES.slice(0, 3) });
    assert.equal(await page.eval<number>("document.querySelectorAll('#stashes .row.is-selected').length"), 3);
    assert.equal(await page.eval<string>(`document.getElementById("selbar-count").textContent`), "3 files from “oops, deps too”");
  } finally {
    await page.close();
  }
});

test("what is left after a move shows at once — its files are the stash's, less the ones moved, never read again", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 300, height: 900 });
  try {
    await page.send(bigState());
    await page.eval(`${row(BIG)}.click()`);
    await page.send({ type: "stashFilesRead", sha: BIG, files: BIG_FILES });
    await clearPosted(page);
    await page.eval(`${fileRow(BIG, "deps/pkg000.js")}.querySelector('.row-actions [data-act="move"]').click()`);
    assert.match((await shown(page)).rows[0], /449 files/);
    await page.send({ type: "stashDone", sha: BIG, action: "move", paths: ["deps/pkg000.js"], outcome: { kind: "done", rest: R } });
    const list = stashes();
    list.unshift({ sha: R, text: "oops, deps too", branch: "main", message: "On main: oops, deps too", time: now - 60, count: 449 });
    await page.send(state({ stashes: list }));
    assert.deepEqual(await reads(page), [], "nothing to read: a stash never changes");
    assert.equal(await shownFiles(page, R), 200);
    assert.equal(await page.eval<boolean>(`!!${fileRow(R, "deps/pkg000.js")}`), false);
    assert.equal(await page.eval<boolean>(`!!${fileRow(R, "deps/pkg001.js")}`), true);
  } finally {
    await page.close();
  }
});

// ── What a screen reader hears ───────────────────────────────────────────────

test("a stash's file is named with its folder, its change and its staging — at 240px too, where the staged word leaves the row", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 240, height: 900 });
  try {
    await page.send(state());
    await page.eval(`${row(B)}.click()`);
    const name = (path: string) => page.accessibleName(fileRow(B, path));
    const wordShown = await page.eval<boolean>(
      `getComputedStyle(${fileRow(B, "src/auth/login.ts")}.querySelector(".stash-staged")).display !== "none"`,
    );
    assert.equal(wordShown, false, "the word gives way at 240px");
    assert.equal(await name("src/auth/login.ts"), "login.ts, src/auth, modified, partly staged");
    assert.equal(await name("src/routes.ts"), "routes.ts, src, deleted, staged");
    assert.equal(await name("src/auth/oauth.test.ts"), "oauth.test.ts, src/auth, untracked");
    assert.equal(await name("docs/sign-in.md"), "sign-in.md, docs, renamed from docs/guide.md, staged");
    // Wide enough for the word: the same name.
    await page.resize(420, 900);
    assert.equal(await name("src/auth/login.ts"), "login.ts, src/auth, modified, partly staged");
  } finally {
    await page.close();
  }
});

// ── How it looks, per theme: computed styles, never class names ─────────────

for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: the header is the Changes groups' header; rows are two lines; the twisty turns; nothing overflows at 240px`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 240, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(B)}.click()`);
      const m = await page.eval<Record<string, unknown>>(`(() => {
        const cs = (el) => getComputedStyle(el);
        const stashH = document.querySelector("#stashes .group-header");
        const fileH = document.querySelector("#groups .group-header");
        const dot = cs(stashH.querySelector(".gdot")).backgroundColor;
        const brand = (() => { const p = document.createElement("span"); p.style.color = "var(--gs-brand)"; document.body.appendChild(p); const c = cs(p).color; p.remove(); return c; })();
        const open = ${row(B)}, closed = ${row(A)};
        const over = Array.from(document.querySelectorAll("#stashes .row")).filter((r) => r.scrollWidth > r.clientWidth + 1).length;
        return {
          sameHeader: ["height", "fontSize", "paddingLeft"].every((k) => cs(stashH)[k] === cs(fileH)[k]) &&
            cs(stashH.querySelector(".glabel")).textTransform === cs(fileH.querySelector(".glabel")).textTransform,
          dotIsBrand: dot === brand,
          rowHeight: open.getBoundingClientRect().height,
          fileHeight: ${fileRow(B, "src/routes.ts")}.getBoundingClientRect().height,
          twistyOpen: cs(open.querySelector(".twisty")).transform,
          twistyClosed: cs(closed.querySelector(".twisty")).transform,
          metaMuted: cs(open.querySelector(".stash-meta")).color !== cs(open.querySelector(".stash-msg")).color,
          metaSmaller: parseFloat(cs(open.querySelector(".stash-meta")).fontSize) < parseFloat(cs(open.querySelector(".stash-msg")).fontSize),
          deletedStruck: cs(${fileRow(B, "src/routes.ts")}.querySelector(".name")).textDecorationLine,
          over,
          pageScroll: document.documentElement.scrollWidth > innerWidth,
          // At 240px the names keep their room: every file's name is whole,
          // Apply / Pop give way to More Actions, the staged word to its tip.
          namesCut: Array.from(document.querySelectorAll("#stashes .row.is-file .name"))
            .filter((n) => n.scrollWidth > n.clientWidth + 1).map((n) => n.textContent),
          // With the keyboard on the row, so its words would show if they fit.
          quick: (open.focus(), Array.from(open.querySelectorAll(".row-actions .word-btn, .row-actions .icon-btn")).map((b) => cs(b).display !== "none")),
          stagedShown: Array.from(document.querySelectorAll("#stashes .stash-staged")).some((w) => cs(w).display !== "none"),
          stagedTip: ${fileRow(B, "src/auth/login.ts")}.querySelector(".status").dataset.tip,
        };
      })()`);
      assert.deepEqual(m.namesCut, [], "no file name is cut at 240px");
      assert.deepEqual(m.quick, [false, false, true], "only More Actions at 240px");
      assert.equal(m.stagedShown, false);
      assert.equal(m.stagedTip, "Modified, partly staged");
      assert.equal(m.sameHeader, true, "the same header as Staged / Changes");
      assert.equal(m.dotIsBrand, true);
      assert.equal(m.rowHeight, 38, "a stash row is two lines");
      assert.equal(m.fileHeight, 24, "a file row is a Changes row");
      assert.equal(m.twistyOpen, "matrix(0, 1, -1, 0, 0, 0)", "open: the chevron points down");
      assert.equal(m.twistyClosed, "none", "closed: it points right");
      // The second line is the quieter one: smaller everywhere, and muted where
      // the theme has a muted colour (a high-contrast theme keeps one colour).
      assert.equal(m.metaSmaller, true);
      if (!theme.startsWith("hc-")) assert.equal(m.metaMuted, true);
      assert.equal(m.deletedStruck, "line-through");
      assert.equal(m.over, 0, "no row overflows its width");
      assert.equal(m.pageScroll, false);
    } finally {
      await page.close();
    }
  });
}
