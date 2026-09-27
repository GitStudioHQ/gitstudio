import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type PageTheme } from "./changesPage";
import { LOOK_PROBE } from "./litLook";
import { relativeTime } from "../src/util/relativeTime";

// What a file row looks like under the pointer and selected, in the real
// page commitView.ts serves. The owner's rule: nothing hovered or selected
// wears a line — no bar down its edge, no rail — it is lit. A hovered file
// row grew a 2px status-coloured rail down its left edge, and a selected one
// a 2px focus-blue bar; the selection's own fill (the list's inactive grey)
// stood 1.12:1 from the view in Light+ and not at all in high contrast,
// where the bar was all there was.
//
// State table: theme {dark, light, hc-dark, hc-light} × row {a changed file,
// a stash's file} × state {hovered, selected, selected and hovered}.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const B = "b".repeat(40);
const now = Math.floor(Date.now() / 1000);
const STATE = {
  ...stateMessage({ local: [{ name: "main", current: true }] }),
  unstaged: [{ path: "src/app.ts", status: "M" }, { path: "src/routes.ts", status: "A" }],
  stashes: [{
    sha: B, text: "Fix login redirect", branch: "main", message: "On main: Fix login redirect", time: now - 3600,
    files: [{ path: "src/auth/login.ts", status: "M" }, { path: "README.md", status: "M" }],
  }].map((s) => ({ ...s, rel: relativeTime(s.time), count: s.files.length })),
};

type Look = { fill: string; apart: number; text: number; lines: string[] };

// cursor-dark: Cursor's default theme, whose focus colour is 15% white — a
// selected row there was 3% white until the accent was made solid.
for (const theme of ["dark", "light", "hc-dark", "hc-light", "cursor-dark"] as PageTheme[]) {
  test(`${theme}: a file row, hovered or selected, is lit and never wears a line`, { skip }, async () => {
    const p = await ChangesPage.open(theme, { width: 360, height: 640 });
    opened.push(p);
    await p.eval(`(function () {
      var s = document.createElement("style");
      s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
      document.head.appendChild(s);
    })()`);
    await p.eval(LOOK_PROBE);
    await p.send(STATE);
    if (theme === "cursor-dark") {
      // The theme's own button colour, not its 15% white — nor Dark+'s blue from the base under the fixture.
      const accent = await p.eval<string>(`(function () { var i = document.createElement("i"); i.style.color = "var(--gs-accent)"; document.body.appendChild(i); var c = getComputedStyle(i).color; i.remove(); return c; })()`);
      assert.equal(accent, "rgb(129, 161, 193)", "Cursor Dark's accent is its button colour, #81a1c1");
    }
    await p.eval(`document.querySelector('#stashes [data-tkey="stash:${B}"]').click()`);
    await p.page.waitFor(`!!document.querySelector('#stashes [data-key="stash:${B}:README.md"]')`);
    const hc = theme.startsWith("hc");
    const look = (row: string) => p.eval<Look>(`window.__look(${row}, { surface: document.body, text: ${row}.querySelector(".name") })`);
    const pointAt = async (row: string) => {
      const c = await p.eval<{ x: number; y: number }>(`(function () { var b = ${row}.getBoundingClientRect(); return { x: Math.round(b.left + 40), y: Math.round(b.top + b.height / 2) }; })()`);
      await p.mouseMove(c.x, c.y + 1);
      await p.mouseMove(c.x, c.y);
    };
    for (const [what, row, other] of [
      ["a changed file", `document.querySelector('#groups .row.is-file[data-key="unstaged:src/app.ts"]')`, `document.querySelector('#groups .row.is-file[data-key="unstaged:src/routes.ts"]')`],
      ["a stash's file", `document.querySelector('#stashes [data-key="stash:${B}:src/auth/login.ts"]')`, `document.querySelector('#stashes [data-key="stash:${B}:README.md"]')`],
    ] as const) {
      await pointAt(row);
      const hovered = await look(row);
      assert.deepEqual(hovered.lines, [], `${what}, hovered: no rail, no line (${JSON.stringify(hovered)})`);

      await p.eval(`${row}.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, detail: 1 }))`);
      await p.eval(`${other}.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true, detail: 1 }))`);
      await p.mouseMove(2, 2);
      const selected = await look(row);
      await pointAt(row);
      const both = await look(row);
      for (const [when, l] of [["selected", selected], ["selected and hovered", both]] as const) {
        if (hc) assert.ok(l.lines.length === 1 && /^outline dashed/.test(l.lines[0]), `${what}, ${when}: high contrast rings it (${JSON.stringify(l)})`);
        else assert.deepEqual(l.lines, [], `${what}, ${when}: lit, no bar (${JSON.stringify(l)})`);
        assert.ok(l.apart >= 1.15, `${what}, ${when}: its fill stands ${l.apart}:1 apart from the view (${JSON.stringify(l)})`);
        assert.ok(l.text >= 4.5, `${what}, ${when}: its name reads ${l.text}:1 (${JSON.stringify(l)})`);
      }
      assert.notEqual(both.fill, selected.fill, `${what}: the pointer on a selected row still shows`);
      await p.eval(`document.getElementById("selbar-clear").click()`);
    }
    assert.deepEqual(p.page.errors, []);
  });
}
