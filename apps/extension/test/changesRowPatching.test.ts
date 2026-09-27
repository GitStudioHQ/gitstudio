import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// One click, one row: the Changes list is patched, not rebuilt.
//
// Every Stage, Unstage or tick cleared the list and built every row again —
// 55,000 elements for 5,000 files, 59 ms of script before layout, and the
// focused row, its hover and its tooltip timer thrown away each time; the
// host's answer then did it all again. Rows are now kept by key and rebuilt
// only when something they were built from changed.
//
// Counted with a MutationObserver on the list — elements the render ADDED —
// and by marking row nodes and checking the same nodes are still there. Both
// are exact, where a timing budget would be a flaky guess.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const many = (n: number) => Array.from({ length: n }, (_, i) => ({ path: `src/m${i % 20}/file${i}.ts`, status: "M" }));

function base(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...stateMessage({ local: [{ name: "main", current: true }] }), staged: [], unstaged: [], ...over };
}

/** Count element nodes added under #groups while `action` runs. */
async function added(page: ChangesPage, action: string): Promise<number> {
  return page.eval<number>(`new Promise(function (resolve) {
    var n = 0;
    var mo = new MutationObserver(function (records) {
      records.forEach(function (r) {
        r.addedNodes.forEach(function (node) {
          if (node.nodeType !== 1) return;
          // A kept row moved to another group is re-inserted, not created.
          if (node.__probe) return;
          n += 1 + node.querySelectorAll("*").length;
        });
      });
    });
    mo.observe(document.getElementById("groups"), { childList: true, subtree: true });
    ${action};
    setTimeout(function () { mo.disconnect(); resolve(n); }, 50);
  })`);
}

/** Mark every row now in the list, so a later check can tell kept nodes from new ones. */
async function mark(page: ChangesPage): Promise<number> {
  return page.eval<number>(`(function () {
    var rows = document.querySelectorAll("#groups .row, #groups .group-header");
    rows.forEach(function (r, i) { r.__probe = i + 1; });
    return rows.length;
  })()`);
}
const keptCount = (page: ChangesPage) =>
  page.eval<number>(`Array.prototype.filter.call(document.querySelectorAll("#groups .row, #groups .group-header"), function (r) { return !!r.__probe; }).length`);

for (const layout of ["list", "tree"]) {
  test(`staging one of 2,000 files builds one row, not 2,000 (${layout} layout)`, { skip }, async () => {
    const page = await ChangesPage.open("dark", { width: 460, height: 720 });
    opened.push(page);
    const files = many(2000);
    await page.send(base({ unstaged: files, layout }));
    const total = await mark(page);
    assert.ok(total > 2000, `${total} rows`);
    // The optimistic move, as the row's + does it…
    const n = await added(
      page,
      `document.querySelector('[data-key="unstaged:src/m7/file7.ts"] .row-actions .icon-btn').click()`,
    );
    assert.ok(n <= 40, `one click added ${n} elements to the list`);
    // …and the host's answer, which says the same thing.
    const m = await added(
      page,
      `window.__send(${JSON.stringify(
        base({ staged: [files[7]], unstaged: files.filter((_, i) => i !== 7), layout }),
      )})`,
    );
    assert.ok(m <= 40, `the host's matching state added ${m} elements`);
    const kept = await keptCount(page);
    assert.ok(kept >= total - 3, `${kept} of ${total} rows are the same nodes as before`);
    assert.equal(await page.eval<number>(`document.querySelectorAll('.group--staged .row.is-file').length`), 1);
    assert.equal(await page.eval<string>(`document.querySelector(".group--unstaged .gcount").textContent`), "1999");
  });
}

test("the checkbox model: a tick's answer rebuilds that row alone, and keeps the keyboard on it", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  const files = many(300);
  await page.send(base({ unstaged: files, stagingModel: "checkboxes" }));
  const total = await mark(page);
  await page.eval(`document.querySelector('[data-tkey="f:ck:src/m3/file3.ts"]').focus()`);
  const n = await added(
    page,
    `window.__send(${JSON.stringify(base({ staged: [files[3]], unstaged: files.filter((_, i) => i !== 3), stagingModel: "checkboxes" }))})`,
  );
  assert.ok(n <= 25, `a tick added ${n} elements`);
  assert.ok((await keptCount(page)) >= total - 2);
  const row = await page.eval<{ focused: boolean; checked: string | null; header: string | null }>(`(function () {
    var r = document.querySelector('[data-tkey="f:ck:src/m3/file3.ts"]');
    return {
      focused: document.activeElement === r,
      checked: r.getAttribute("aria-checked"),
      header: document.querySelector('[data-tkey="g:all"]').getAttribute("aria-checked"),
    };
  })()`);
  assert.deepEqual(row, { focused: true, checked: "true", header: "mixed" });
});

// What a kept row's handlers act on must be today's, not the list it was
// built from: a folder's Stage takes the files under it NOW, and a group
// header's Ctrl/Cmd-click selects the files in it NOW.
test("a kept folder row stages the files under it now; a kept header selects the files in it now", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  const two = [
    { path: "src/lib/a.ts", status: "M" },
    { path: "src/lib/b.ts", status: "M" },
  ];
  await page.send(base({ unstaged: two, layout: "tree" }));
  await mark(page);
  await page.send(base({ unstaged: [...two, { path: "src/lib/c.ts", status: "U" }], layout: "tree" }));
  const folderKept = await page.eval<boolean>(`!!document.querySelector('[data-tkey="d:split:unstaged:src/lib"]').__probe`);
  assert.equal(folderKept, true, "the folder row is the same node");
  await page.eval(`window.__posted = []; document.querySelector('[data-tkey="d:split:unstaged:src/lib"] .row-actions .icon-btn').click()`);
  const posted = (await page.posted()).filter((m) => m.type === "stageFolder");
  assert.deepEqual(posted, [{ type: "stageFolder", paths: ["src/lib/a.ts", "src/lib/b.ts", "src/lib/c.ts"] }]);

  // (The folder's Stage moved its files optimistically; start again for the header.)
  await page.reload();
  await page.send(base({ unstaged: two }));
  await mark(page);
  await page.send(base({ unstaged: [...two, { path: "src/lib/c.ts", status: "U" }, { path: "z.ts", status: "M" }] }));
  assert.equal(await page.eval<boolean>(`!!document.querySelector('[data-tkey="g:unstaged"]').__probe`), true, "the header is the same node");
  const header = await page.eval<{ x: number; y: number }>(`(function () {
    var b = document.querySelector(".group--unstaged .glabel").getBoundingClientRect();
    return { x: b.x + 4, y: b.y + b.height / 2 };
  })()`);
  await page.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: header.x, y: header.y, button: "left", clickCount: 1, modifiers: 4 });
  await page.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: header.x, y: header.y, button: "left", clickCount: 1, modifiers: 4 });
  assert.equal(await page.eval<string>(`document.getElementById("selbar-count").textContent`), "4 files selected");
  // …and leaves the group open: the click folded it away over its own selection.
  assert.equal(await page.eval<string>(`document.querySelector('[data-tkey="g:unstaged"]').getAttribute("aria-expanded")`), "true");
});

// A kept row is only kept while what it shows is true: a status that changes
// (M → D) or a file renamed into another folder is a new row.
test("a row whose status changes is rebuilt with the new status; selection survives on kept rows", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 460, height: 720 });
  opened.push(page);
  const files = [
    { path: "a.ts", status: "M" },
    { path: "b.ts", status: "M" },
  ];
  await page.send(base({ unstaged: files }));
  await page.eval(`document.querySelector('[data-key="unstaged:b.ts"]').focus()`);
  await page.key("ArrowDown", { with: ["shift"] });
  await page.key("ArrowUp", { with: ["shift"] });
  await page.key("ArrowUp", { with: ["shift"] });
  await page.send(base({ unstaged: [{ path: "a.ts", status: "D" }, files[1]] }));
  const got = await page.eval<{ status: string; deleted: boolean; label: string | null; selected: string[] }>(`(function () {
    var a = document.querySelector('[data-key="unstaged:a.ts"]');
    return {
      status: a.querySelector(".status").textContent,
      deleted: a.classList.contains("is-deleted"),
      label: a.getAttribute("aria-label"),
      selected: Array.prototype.map.call(document.querySelectorAll('#groups [aria-selected="true"]'), function (n) { return n.dataset.key; }),
    };
  })()`);
  assert.deepEqual(got, {
    status: "D",
    deleted: true,
    label: "a.ts, Deleted",
    selected: ["unstaged:a.ts", "unstaged:b.ts"],
  });
});
