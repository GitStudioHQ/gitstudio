// The Stashes view's REAL document, in headless Chrome, in Dark+ and Light+.
//
// Its script is a template literal in stashesWebview.ts that no compiler looks
// inside, so the only honest check of what it does is to run it: the template
// is lifted out of the source verbatim (it holds no escapes, so the text in
// the file IS the text the webview gets), its four holes filled,
// acquireVsCodeApi stubbed to record what the page posts.
//
// What the stashes audit found, and this pins:
//   · rows posted `stash@{n}` — a position that renumbers — for every action;
//     now the full sha;
//   · every re-post (every file save) rebuilt every row, so the keyboard fell
//     to <body>; now an identical list touches nothing, and a changed one
//     patches only its rows;
//   · a Drop froze EVERY row's buttons for 6 s — even when the user cancelled
//     — while the right-click menu went around that latch; now only the
//     pressed row is busy, from its buttons and its menu alike, until the host
//     says the action is over;
//   · a double-click previewed the stash twice; the arrows did nothing; Delete
//     did nothing; Apply and Pop wore look-alike icons (arrow-down, inbox) and
//     the empty state said "Shelve", a different feature's name.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
import { findChrome, runChangesView, screenshotChangesView, THEMES, type ThemeName } from "./changesViewPage";

const ROOT = join(__dirname, "..", "..", "..");
const CHROME = findChrome();
const skip = !CHROME && "no headless Chrome on this machine (set GS_CHROME)";

/** The Stashes view's document template, exactly as stashesWebview.ts holds it. */
function template(): string {
  const src = readFileSync(join(__dirname, "..", "src", "views", "stashesWebview.ts"), "utf8");
  const open = "return `<!DOCTYPE html>";
  const start = src.indexOf(open);
  const end = src.indexOf("</html>`;", start);
  if (start < 0 || end < 0) throw new Error("the Stashes view's HTML template was not found");
  const text = src.slice(start + "return `".length, end + "</html>".length);
  // Lifted verbatim only while it holds no escapes for the compiler to cook.
  if (text.includes("\\")) throw new Error("the Stashes template holds a backslash; lift it cooked");
  return text;
}

function stashesPage(theme: ThemeName, harness: string, width = 300): string {
  const t = THEMES[theme];
  const codicons = pathToFileURL(join(ROOT, "node_modules", "@vscode", "codicons", "dist", "codicon.css")).href;
  const tokens = readFileSync(join(ROOT, "packages", "webview-ui", "src", "styles", "tokens.css"), "utf8");
  const vars = Object.entries(t.vars).map(([k, v]) => `${k}:${v};`).join("");
  const prelude = `<style>:root{${vars}} html{background:${t.vars["--vscode-sideBar-background"]}} body{width:${width}px;min-height:100vh}</style>
<script>
  window.posted = [];
  window.acquireVsCodeApi = () => ({
    postMessage: (m) => window.posted.push(JSON.parse(JSON.stringify(m === undefined ? null : m))),
    getState: () => undefined,
    setState: () => undefined,
  });
</script>`;
  const run = `<script>
(async () => {
  const fails = [];
  const notes = {};
  const expect = (cond, what) => { if (!cond) fails.push(what); };
  const post = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
  const tick = () => new Promise((r) => setTimeout(r, 0));
  try {
    ${harness}
  } catch (err) {
    fails.push("threw: " + (err && err.stack || err));
  }
  document.title = "CHECK " + JSON.stringify({ fails, notes });
})();
</script>`;
  const holes = ["${csp}", "${codiconUri}", "${tokensCss}"];
  let page = template();
  for (const h of holes) if (!page.includes(h)) throw new Error(`hole ${h} not found`);
  page = page
    .replace("${csp}", "default-src * 'unsafe-inline' file: data:")
    .replace("${codiconUri}", () => codicons)
    .replace("${tokensCss}", () => tokens)
    .split("${nonce}").join("harness");
  if (page.includes("${")) throw new Error("an unfilled hole is left in the Stashes template");
  return page
    .replace("<body>", () => `<body class="${t.bodyClass}">`)
    .replace("</head>", () => `${prelude}\n</head>`)
    .replace("</body></html>", () => `${run}\n</body></html>`);
}

const SHA = (c: string): string => c.repeat(40);
const item = (c: string, n: number, message: string): Record<string, string> => ({
  sha: SHA(c),
  short: SHA(c).slice(0, 7),
  ref: `stash@{${n}}`,
  message,
  timeRel: "2m",
  timeAbs: "today",
});
const LIST = [item("a", 0, "On main: tracked edit"), item("b", 1, "On main: staged + unstaged"), item("c", 2, "WIP on main: 3f97dc4 initial")];
const stashes = (items: unknown[]): string => JSON.stringify({ type: "stashes", items, hasRepo: true, ok: true });

const HELPERS = `
  const rowsNow = () => Array.from(document.querySelectorAll("#list .row"));
  const rowOf = (c) => document.querySelector('#list .row[data-sha="' + c.repeat(40) + '"]');
  const ACTION = { apply: 0, pop: 1, branch: 2, drop: 3 };
  const btn = (row, action) => row.querySelectorAll(".row-actions button")[ACTION[action]];
  const key = (k, opts) => document.activeElement.dispatchEvent(new KeyboardEvent("keydown", Object.assign({ key: k, bubbles: true, cancelable: true }, opts || {})));
  const lastPost = () => window.posted[window.posted.length - 1];
  const since = (n) => window.posted.slice(n);
`;

for (const theme of ["dark", "light"] as ThemeName[]) {
  test(`${theme}: every action names the stash by its full sha`, { skip }, async () => {
    const r = await runChangesView(CHROME!, stashesPage(theme, `${HELPERS}
      post(${stashes(LIST)});
      await tick();
      const b = rowsNow()[1];
      expect(rowsNow().length === 3, "three rows");
      expect(b === rowOf("b"), "each row carries its stash's sha");
      for (const type of ["apply", "pop", "branch", "drop"]) {
        const n = window.posted.length;
        btn(b, type).click();
        const p = since(n);
        expect(p.length === 1 && p[0].type === type && p[0].sha === "${SHA("b")}" && !("ref" in p[0]),
          type + " posts the sha: " + JSON.stringify(p));
        post({ type: "done", sha: "${SHA("b")}" });
        await tick();
      }
    `));
    assert.deepEqual(r.fails, []);
  });

  test(`${theme}: re-posting the same list touches nothing; a changed one patches only its rows`, { skip }, async () => {
    const r = await runChangesView(CHROME!, stashesPage(theme, `${HELPERS}
      post(${stashes(LIST)});
      await tick();
      const [a, b, c] = rowsNow();
      b.focus();
      post(${stashes(LIST)});
      await tick();
      expect(rowsNow()[1] === b, "an identical re-post keeps the row node");
      expect(document.activeElement === b, "and the keyboard on it: " + (document.activeElement && document.activeElement.className));

      // b is popped: its row goes, the keyboard moves to the row that takes its place.
      post(${stashes([item("a", 0, "On main: tracked edit"), item("c", 1, "WIP on main: 3f97dc4 initial")])});
      await tick();
      const now = rowsNow();
      expect(now.length === 2 && now[0] === a && now[1] === c, "the other rows are the same nodes");
      expect(!b.isConnected, "the popped row is gone");
      expect(document.activeElement === c, "the keyboard moved to the next row, not to <body>: " + document.activeElement.tagName);
      expect(c.querySelector(".meta").textContent.indexOf("stash@{1}") === 0, "its number patched in place");

      // A new stash on top is inserted; nothing else moves.
      post(${stashes([item("d", 0, "On main: new"), item("a", 1, "On main: tracked edit"), item("c", 2, "WIP on main: 3f97dc4 initial")])});
      await tick();
      const after = rowsNow();
      expect(after.length === 3 && after[1] === a && after[2] === c, "new row on top, the rest untouched");
      expect(document.activeElement === c, "the keyboard stays put");
    `));
    assert.deepEqual(r.fails, []);
  });

  test(`${theme}: a pressed row alone goes busy, its menu included, until the host says it is over`, { skip }, async () => {
    const r = await runChangesView(CHROME!, stashesPage(theme, `${HELPERS}
      post(${stashes(LIST)});
      await tick();
      const [a, b] = rowsNow();
      btn(b, "drop").click();
      expect(lastPost().type === "drop", "Drop posted");
      expect(b.classList.contains("busy") && btn(b, "apply").disabled, "the pressed row is busy");
      expect(!a.classList.contains("busy") && !btn(a, "apply").disabled, "the other rows are not");
      // What the user SEES, not the class name: a rule renamed or shadowed
      // would leave the class on a row that looks like every other.
      const look = (row) => getComputedStyle(row);
      expect(Number(look(b).opacity) < 1 && look(b).cursor === "progress",
        "the busy row is dimmed, with the progress cursor: " + look(b).opacity + " " + look(b).cursor);
      expect(Number(look(a).opacity) === 1 && look(a).cursor !== "progress",
        "the others are not: " + look(a).opacity + " " + look(a).cursor);
      let n = window.posted.length;
      btn(a, "apply").click();
      expect(since(n).length === 1 && since(n)[0].sha === "${SHA("a")}", "another row still acts");
      post({ type: "done", sha: "${SHA("a")}" });

      // The menu of the busy row goes through the same latch.
      n = window.posted.length;
      b.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
      const pop = Array.from(document.querySelectorAll(".gs-menu-item")).find((x) => /Pop/.test(x.textContent));
      expect(!!pop, "the menu opened");
      if (pop) pop.click();
      expect(since(n).length === 0, "a busy row's menu posts nothing: " + JSON.stringify(since(n)));

      // The user cancels the Drop: the host says so at once, no timer.
      post({ type: "done", sha: "${SHA("b")}" });
      await tick();
      expect(!b.classList.contains("busy") && !btn(b, "drop").disabled, "released by the host's answer");
      n = window.posted.length;
      btn(b, "pop").click();
      expect(since(n).length === 1 && since(n)[0].type === "pop", "and usable again at once");
    `));
    assert.deepEqual(r.fails, []);
  });

  test(`${theme}: a click previews once, a double-click opens the menu, and the keys work`, { skip }, async () => {
    const r = await runChangesView(CHROME!, stashesPage(theme, `${HELPERS}
      post(${stashes(LIST)});
      await tick();
      const [a, b, c] = rowsNow();
      let n = window.posted.length;
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
      b.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
      b.dispatchEvent(new MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
      const shows = since(n).filter((p) => p.type === "show");
      expect(shows.length === 1, "one preview for a double-click: " + JSON.stringify(shows));
      expect(shows[0] && shows[0].sha === "${SHA("b")}" && shows[0].focus === false, "a click previews without taking the keyboard");
      const menu = document.querySelector(".gs-menu");
      expect(!!menu, "the double-click opened the menu");
      expect(menu && menu.contains(document.activeElement), "with the keyboard in it");
      key("Escape");
      expect(!document.querySelector(".gs-menu"), "Escape closes it");
      expect(document.activeElement === b, "and hands the keyboard back to the row");

      key("ArrowDown");
      expect(document.activeElement === c, "ArrowDown moves to the next row");
      key("ArrowDown");
      expect(document.activeElement === c, "clamped at the bottom");
      key("Home");
      expect(document.activeElement === a, "Home: the first row");
      key("End");
      expect(document.activeElement === c, "End: the last row");
      key("ArrowUp");
      expect(document.activeElement === b, "ArrowUp moves back");

      n = window.posted.length;
      key("Enter");
      expect(since(n).length === 1 && since(n)[0].type === "show" && since(n)[0].focus === true, "Enter opens it and takes the keyboard there");
      n = window.posted.length;
      key("Delete");
      expect(since(n).length === 1 && since(n)[0].type === "drop" && since(n)[0].sha === "${SHA("b")}", "Delete asks to drop it");
      post({ type: "done", sha: "${SHA("b")}" });
      // macOS: the delete key sends Backspace, and VS Code's lists delete with
      // Cmd+Backspace. Both ask to drop it (the question still comes first).
      for (const opts of [{}, { metaKey: true }]) {
        b.focus();
        n = window.posted.length;
        key("Backspace", opts);
        expect(since(n).length === 1 && since(n)[0].type === "drop" && since(n)[0].sha === "${SHA("b")}",
          "Backspace " + JSON.stringify(opts) + " asks to drop it: " + JSON.stringify(since(n)));
        post({ type: "done", sha: "${SHA("b")}" });
      }
      n = window.posted.length;
      key("Backspace", { altKey: true });
      expect(since(n).length === 0, "Alt+Backspace is not a delete");
    `));
    assert.deepEqual(r.fails, []);
  });

  // A press on a row's button focuses that button (a mouse press in Chrome,
  // or Tab and Enter), and the busy latch disables it: the keyboard fell to
  // <body> at once, and when the Pop removed the row there was no row with
  // the keyboard to hand it on from. The menu's item is removed as it is
  // chosen, with the same result.
  test(`${theme}: Pop by the row's button or its menu leaves the keyboard on the next row`, { skip }, async () => {
    const r = await runChangesView(CHROME!, stashesPage(theme, `${HELPERS}
      const withoutB = ${stashes([item("a", 0, "On main: tracked edit"), item("c", 1, "WIP on main: 3f97dc4 initial")])};
      const where = () => document.activeElement === document.body ? "BODY" : (document.activeElement.className + " " + (document.activeElement.dataset.sha || "").slice(0, 1));

      // The button.
      post(${stashes(LIST)});
      await tick();
      let [a, b, c] = rowsNow();
      btn(b, "pop").focus();
      btn(b, "pop").click();
      expect(lastPost().type === "pop", "Pop posted");
      expect(document.activeElement === b, "while it runs, the keyboard waits on its row: " + where());
      post(withoutB);
      post({ type: "done", sha: "${SHA("b")}" });
      await tick();
      expect(document.activeElement === c, "the row gone, the keyboard is on the next row: " + where());

      // The menu, from the keyboard (Shift+F10, then Pop).
      post(${stashes(LIST)});
      await tick();
      [a, b, c] = rowsNow();
      b.focus();
      key("F10", { shiftKey: true });
      const pop = Array.from(document.querySelectorAll(".gs-menu-item")).find((x) => /Pop/.test(x.textContent));
      const menuEl = document.querySelector(".gs-menu");
      expect(!!pop && !!menuEl && menuEl.contains(document.activeElement), "the menu has the keyboard");
      if (pop) { pop.focus(); pop.click(); }
      expect(!document.querySelector(".gs-menu"), "the menu closed");
      expect(document.activeElement === b, "the keyboard is back on the row: " + where());
      post(withoutB);
      post({ type: "done", sha: "${SHA("b")}" });
      await tick();
      expect(document.activeElement === c, "the row gone, the keyboard is on the next row: " + where());

      // Apply leaves the row where it is: the keyboard stays on it.
      c.querySelector(".row-actions button").focus();
      btn(c, "apply").click();
      post({ type: "done", sha: "${SHA("c")}" });
      await tick();
      expect(document.activeElement === c, "after an Apply the keyboard is on its row: " + where());
    `));
    assert.deepEqual(r.fails, []);
  });

  test(`${theme}: Apply and Pop wear their own icons, and the empty state says Stash`, { skip }, async () => {
    const r = await runChangesView(CHROME!, stashesPage(theme, `${HELPERS}
      post(${stashes([])});
      await tick();
      const empty = document.getElementById("empty");
      expect(!empty.hidden, "the empty state shows");
      expect(!/shelve/i.test(empty.textContent), "no Shelve: " + empty.textContent);
      post(${stashes(LIST)});
      await tick();
      const a = rowsNow()[0];
      expect(!!a.querySelector(".codicon-git-stash-apply") && !!a.querySelector(".codicon-git-stash-pop"), "git-stash-apply / git-stash-pop");
      expect(!a.querySelector(".codicon-arrow-down") && !a.querySelector(".codicon-inbox"), "not the look-alikes");
      // The glyphs exist in the shipped font (a missing one renders nothing).
      const w = (cls) => { const i = document.createElement("i"); i.className = "codicon " + cls; document.body.appendChild(i); const c = getComputedStyle(i, "::before").content; i.remove(); return c; };
      expect(w("codicon-git-stash-apply") !== "none" && w("codicon-git-stash-apply") !== w("codicon-git-stash-pop"), "two distinct glyphs");
    `));
    assert.deepEqual(r.fails, []);
  });
}

test("screenshots: the list in Dark+ and Light+ at 300px", { skip }, async () => {
  const out = process.env.GS_SHOTS;
  if (!out) return;
  for (const theme of ["dark", "light"] as ThemeName[]) {
    await screenshotChangesView(
      CHROME!,
      stashesPage(theme, `post(${stashes(LIST)}); await tick();`),
      join(out, `stashes-${theme}.png`),
      { width: 300, height: 260 },
    );
  }
});
