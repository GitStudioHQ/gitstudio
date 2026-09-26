import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// The Changes view says nothing about the working tree before it has read it.
//
// Its first paint, before the host's first state, said "Working tree clean —
// No changes to commit." over a tree it had not looked at; and while
// repositories were still being discovered it said "No repository open". It
// now shows a reading state until it knows, in the real page.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

async function open(): Promise<ChangesPage> {
  const page = await ChangesPage.open("dark", { width: 360, height: 560 });
  opened.push(page);
  return page;
}

/** Which of the three states is on screen, and what the reading one says. */
function screen(page: ChangesPage): Promise<{ loading: boolean; clean: boolean; noRepo: boolean; text: string }> {
  return page.eval(`(function () {
    var shown = function (id) {
      var el = document.getElementById(id);
      return !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0;
    };
    return {
      loading: shown("loading-state"),
      clean: shown("empty-state"),
      noRepo: shown("no-repo"),
      text: document.getElementById("loading-text").textContent.trim(),
    };
  })()`);
}

const CLEAN = { ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: [] };

test("before the first state: reading, not 'Working tree clean'", { skip }, async () => {
  const page = await open();
  assert.deepEqual(await screen(page), { loading: true, clean: false, noRepo: false, text: "Reading changes…" });
  await page.send(CLEAN);
  const after = await screen(page);
  assert.equal(after.loading, false);
  assert.equal(after.clean, true, "a clean tree, once it has been read, says so");
});

test("a first state with files: the list, and neither message", { skip }, async () => {
  const page = await open();
  await page.send({ ...CLEAN, unstaged: [{ path: "a.ts", status: "M" }] });
  const s = await screen(page);
  assert.equal(s.loading, false);
  assert.equal(s.clean, false);
  assert.equal(await page.eval(`document.querySelectorAll(".row.is-file").length`), 1);
});

test("no repository while discovery runs: looking; once it settles: none", { skip }, async () => {
  const page = await open();
  const noRepo = { ...CLEAN, hasRepo: false, branches: undefined };
  await page.send({ ...noRepo, discovering: true });
  assert.deepEqual(await screen(page), { loading: true, clean: false, noRepo: false, text: "Looking for a repository…" });
  await page.send({ ...noRepo, discovering: false });
  const settled = await screen(page);
  assert.equal(settled.loading, false);
  assert.equal(settled.noRepo, true);
  assert.equal(settled.clean, false);
});
