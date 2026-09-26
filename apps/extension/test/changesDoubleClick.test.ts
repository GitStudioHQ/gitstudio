import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// A real double-click on a file row: its first click opens the diff; the
// second click of the pair must not open it again. It did — the page posted
// [openDiff, openDiff] for one gesture. (What a double-click shows besides —
// today the row's action menu — is the owner's call, not changed here.)

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: ChangesPage | undefined;
after(async () => {
  await page?.close();
});

test("a double-click opens the file's diff once", { skip }, async () => {
  page = await ChangesPage.open("dark", { width: 420, height: 560 });
  await page.send({
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    unstaged: [{ path: "README.md", status: "M" }],
  });
  const at = await page.eval<{ x: number; y: number }>(`(function () {
    var b = document.querySelector('.row.is-file .name').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  for (const clickCount of [1, 2]) {
    const base = { x: at.x, y: at.y, button: "left", clickCount };
    await page.page.send("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
    await page.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
  }
  const opens = (await page.posted()).filter((m) => m.type === "openDiff");
  assert.equal(opens.length, 1, JSON.stringify(opens));
});
