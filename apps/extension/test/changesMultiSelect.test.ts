import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// A multi-selection in the Changes view acts as ONE request, in the real page
// commitView.ts serves, driven with real mouse events.
//
// It used to post one "stage" (or "discard") per selected file. The host ran
// those together: every `git add` after the first found .git/index.lock taken
// and failed, so most of the files stayed where they were; and each "discard"
// opened its own confirm, which dismissed the one before it, so confirming
// "Discard" discarded only the LAST file of the selection.
//
// And a refusal the host reports ("opFailed") puts the moved rows back at
// once, instead of leaving them in Staged until the optimistic move times out.

const FILES = ["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"];
const STATE = {
  ...stateMessage({ local: [{ name: "main", current: true }] }),
  unstaged: FILES.map((path) => ({ path, status: "M" })),
};

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: ChangesPage;
const opened: ChangesPage[] = [];

after(async () => {
  for (const p of opened) await p.close();
});

/** The centre of the row for `path` in `kind`, on screen. */
async function rowAt(kind: string, path: string): Promise<{ x: number; y: number }> {
  return page.eval(`(function () {
    var r = document.querySelector('.row.is-file[data-key="${kind}:${path}"]');
    if (!r) throw new Error("no row ${kind}:${path}");
    var b = r.querySelector(".name").getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
}

/** A real click with the platform's add-to-selection modifier (Cmd). */
async function cmdClick(at: { x: number; y: number }): Promise<void> {
  const base = { x: at.x, y: at.y, button: "left", clickCount: 1, modifiers: 4 };
  await page.page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await page.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

async function rightClick(at: { x: number; y: number }): Promise<void> {
  const base = { x: at.x, y: at.y, button: "right", clickCount: 1 };
  await page.page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
  await page.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
}

/** Click the open action menu's item whose label is `label`. */
async function clickMenuItem(label: string): Promise<void> {
  const at = await page.eval<{ x: number; y: number }>(`(function () {
    var items = Array.prototype.slice.call(document.querySelectorAll(".action-menu .bm-subaction"));
    var it = items.find(function (b) { return b.textContent.trim() === ${JSON.stringify(label)}; });
    if (!it) throw new Error("no menu item " + ${JSON.stringify(label)} + " in " + items.map(function (b) { return b.textContent.trim(); }).join(" | "));
    var b = it.getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await page.click(at.x, at.y);
}

/** A fresh page for each test: an optimistic move from the last one must not leak in. */
async function reset(): Promise<void> {
  page = await ChangesPage.open("dark", { width: 520, height: 640 });
  opened.push(page);
  await page.send(STATE);
  await page.eval(`window.__posted.length = 0`);
}

async function selectThree(): Promise<void> {
  for (const p of FILES.slice(0, 3)) await cmdClick(await rowAt("unstaged", p));
  const n = await page.eval<number>(`document.querySelectorAll(".row.is-file.is-selected").length`);
  assert.equal(n, 3, "three rows are selected");
}

const staging = (posted: Record<string, unknown>[]) =>
  posted.filter((m) => /^(stage|unstage|discard)/.test(String(m.type)));

test("the context menu's 'Stage 3 Files' posts one request for all three", { skip }, async () => {
  await reset();
  await selectThree();
  await rightClick(await rowAt("unstaged", FILES[0]));
  await clickMenuItem("Stage 3 Files");
  assert.deepEqual(staging(await page.posted()), [{ type: "stagePaths", paths: FILES.slice(0, 3) }]);
  const staged = await page.eval<string[]>(
    `Array.prototype.map.call(document.querySelectorAll('.row.is-file[data-kind="staged"]'), function (r) { return r.dataset.path; })`,
  );
  assert.deepEqual(staged.sort(), FILES.slice(0, 3), "the three rows move at once");
});

test("a refusal from the host puts the rows back at once", { skip }, async () => {
  await reset();
  // Two rows staged by their own "+" buttons, optimistically.
  for (const p of FILES.slice(0, 2)) {
    await page.eval(`document.querySelector('.row.is-file[data-key="unstaged:${p}"] .row-actions .icon-btn').click()`);
  }
  const moved = await page.eval<number>(`document.querySelectorAll('.row.is-file[data-kind="staged"]').length`);
  assert.equal(moved, 2, "the rows moved before git answered");
  // The host says git refused.
  await page.send({ type: "opFailed", paths: FILES.slice(0, 2), error: "index.lock" });
  const staged = await page.eval<number>(`document.querySelectorAll('.row.is-file[data-kind="staged"]').length`);
  const unstaged = await page.eval<number>(`document.querySelectorAll('.row.is-file[data-kind="unstaged"]').length`);
  assert.equal(staged, 0);
  assert.equal(unstaged, 4);
});

test("the context menu's 'Discard 3 Files' posts one request, so the host asks once", { skip }, async () => {
  await reset();
  await selectThree();
  await rightClick(await rowAt("unstaged", FILES[1]));
  await clickMenuItem("Discard 3 Files");
  assert.deepEqual(staging(await page.posted()), [{ type: "discardPaths", paths: FILES.slice(0, 3) }]);
});

test("the selection bar's Stage posts one request", { skip }, async () => {
  await reset();
  await selectThree();
  const at = await page.eval<{ x: number; y: number }>(`(function () {
    var b = document.getElementById("selbar-stage").getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await page.click(at.x, at.y);
  assert.deepEqual(staging(await page.posted()), [{ type: "stagePaths", paths: FILES.slice(0, 3) }]);
});
