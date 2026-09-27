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
    { sha: A, text: "WIP on “Initial layout”", branch: "main", auto: true, message: "WIP on main: 1a2b3c4 Initial layout", time: now - 2 * 3600, files: [{ path: "src/app.ts", status: "M" }] },
    { sha: B, text: "Fix login redirect", branch: "main", message: "On main: Fix login redirect", time: now - 4 * 3600, files: FILES_B },
    { sha: C, text: "Release notes", message: "Release notes", time: now - 30 * 86400, files: [{ path: "README.md", status: "M" }, { path: "CHANGELOG.md", status: "M" }] },
  ];
}

function state(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
}

const row = (sha: string) => `document.querySelector('#stashes [data-focus-key="stash:${sha}"]')`;
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
  page.eval<string>("(document.activeElement && (document.activeElement.dataset.focusKey || document.activeElement.className)) || ''");

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
        "WIP on “Initial layout” | main · 2h ago · 1 file | false",
        "Fix login redirect | main · 4h ago · 6 files | false",
        "Release notes | 1mo ago · 2 files | false",
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
        "Array.from(document.querySelectorAll('#stashes [data-focus-key^=\"stashfolder:\"] .name')).map((n) => n.textContent)",
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
      await page.eval(`${row(B)}.querySelectorAll(".row-actions .icon-btn")[1].click()`);
      assert.deepEqual(await posted(page, "stashAct"), [{ type: "stashAct", sha: B, action: "pop" }]);
      assert.equal((await shown(page)).rows.length, 2, "gone at the click");
      // A state from before the pop (the firehose) does not bring it back.
      await page.send(state());
      assert.equal((await shown(page)).rows.length, 2);
      // Cancelled at a question: back.
      await page.send({ type: "stashDone", sha: B, action: "pop", outcome: { kind: "kept" } });
      assert.equal((await shown(page)).rows.length, 3, "back when nothing happened");
      // Popped: gone, and the list read after it agrees.
      await page.eval(`${row(B)}.querySelectorAll(".row-actions .icon-btn")[1].click()`);
      await page.send({ type: "stashDone", sha: B, action: "pop", outcome: { kind: "done" } });
      const after = stashes().filter((s) => s.sha !== B);
      await page.send(state({ stashes: after }));
      assert.deepEqual((await shown(page)).rows.map((r) => r.split(" | ")[0]), ["WIP on “Initial layout”", "Release notes"]);
    } finally {
      await page.close();
    }
  });

  test(`${theme}: Apply keeps the row, busy until it is over; Drop asks first and the row leaves once answered`, { skip }, async () => {
    const page = await ChangesPage.open(theme, { width: 300, height: 900 });
    try {
      await page.send(state());
      await page.eval(`${row(A)}.querySelectorAll(".row-actions .icon-btn")[0].click()`);
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
      await page.eval(`${fileRow(B, "src/auth/login.ts")}.querySelector(".row-actions .icon-btn").click()`);
      assert.deepEqual(await posted(page, "stashFiles"), [{ type: "stashFiles", sha: B, action: "move", paths: ["src/auth/login.ts"] }]);
      assert.equal((await shown(page)).files.includes("login.ts M partly staged"), false, "gone at the click");
      assert.match((await shown(page)).rows[1], /5 files/);
      // Moved: the host's list has what is left, under a new sha, in the same place.
      await page.send({ type: "stashDone", sha: B, action: "move", paths: ["src/auth/login.ts"], outcome: { kind: "done", rest: R } });
      const list = stashes();
      list[1] = { ...list[1], sha: R, files: FILES_B.filter((f) => f.path !== "src/auth/login.ts") };
      await page.send(state({ stashes: list }));
      const s = await shown(page);
      assert.equal(s.rows[1], "Fix login redirect | main · 4h ago · 5 files | true", "still open");
      assert.equal(await page.eval<boolean>(`!!${fileRow(R, "src/routes.ts")}`), true);
      // A move that did not happen puts the file back.
      await page.eval(`${fileRow(R, "src/routes.ts")}.querySelector(".row-actions .icon-btn").click()`);
      assert.equal((await shown(page)).files.length, 4);
      await page.send({ type: "stashDone", sha: R, action: "move", outcome: { kind: "kept" } });
      assert.equal((await shown(page)).files.length, 5);
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
        };
      })()`);
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
