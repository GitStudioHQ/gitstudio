// The Changes view keeps the keyboard where it was across a repaint — on the
// control inside a row that had it, not only on the row.
//
// Every host push rebuilds the file list from scratch (render()), and
// captureFocus / restoreFocus put the keyboard back by each row's
// data-focus-key. They put it back on the ROW even when a control inside the
// row had it: tick a file in the checkbox model with Space, the host answers
// with the file staged, and the keyboard was on the row — so the next Space
// opened nothing and the next Tab went to the row's twisty.
//
// The cells:
//   model    checkboxes (the tick; the file's key changes when it is staged)
//            · split (a row's button; its row keeps its key)
//   repaint  the file's own change · a change elsewhere in the list

import { test } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

const skip = ChangesPage.chrome() ? false : "no windowless Chrome here (set GS_CHROME)";

const FILES = [
  { path: "a.ts", status: "M" },
  { path: "b.ts", status: "M" },
  { path: "c.ts", status: "M" },
];

function state(model: "split" | "checkboxes", unstaged: typeof FILES, staged: typeof FILES = []): Record<string, unknown> {
  return {
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    stagingModel: model,
    unstaged,
    staged,
    stagedCount: staged.length,
    stashes: [],
  };
}

/** What has the keyboard: the element, and the row it is in. */
const where = (page: ChangesPage) =>
  page.eval<string>(`(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "BODY";
    const r = a.closest("[data-focus-key]");
    const what = a === r ? "row" : a.tagName.toLowerCase() + (a.getAttribute("aria-label") ? "[" + a.getAttribute("aria-label") + "]" : "");
    return what + " in " + (r ? r.dataset.path || r.dataset.focusKey : "-");
  })()`);

test("checkbox model: Space on a file's tick, the host stages it — the keyboard is still on that tick", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 320, height: 700 });
  try {
    await page.send(state("checkboxes", FILES));
    await page.eval(`document.querySelector('#groups input.ck[aria-label*="a.ts"]').focus()`);
    assert.equal(await where(page), "input[Include a.ts in the commit] in a.ts");
    await page.key(" ");
    assert.deepEqual((await page.posted()).filter((m) => m.type === "stage"), [{ type: "stage", path: "a.ts" }]);
    await page.send(state("checkboxes", FILES.slice(1), FILES.slice(0, 1)));
    assert.equal(await page.eval<boolean>(`document.querySelector('#groups input.ck[aria-label*="a.ts"]').checked`), true);
    assert.equal(await where(page), "input[Include a.ts in the commit] in a.ts", "the tick, not the row");
    // …and Space again unticks it, as it would have without the repaint.
    await page.key(" ");
    assert.deepEqual((await page.posted()).filter((m) => m.type === "unstage"), [{ type: "unstage", path: "a.ts" }]);
  } finally {
    await page.close();
  }
});

test("split model: a row's button keeps the keyboard when the list repaints around it", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 320, height: 700 });
  try {
    await page.send(state("split", FILES));
    await page.eval(`document.querySelector('#groups .row[data-path="b.ts"] .icon-btn[aria-label="Discard changes"]').focus()`);
    assert.equal(await where(page), "button[Discard changes] in b.ts");
    // Another file changes: the whole list is rebuilt.
    await page.send(state("split", [...FILES, { path: "d.ts", status: "A" }]));
    assert.equal(await where(page), "button[Discard changes] in b.ts");
  } finally {
    await page.close();
  }
});
