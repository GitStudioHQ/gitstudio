import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// A file row at sidebar width keeps what identifies the file: its NAME whole
// while the directory can still give way, and the directory's TAIL (the
// folder the file is in) when the directory is cut, in the path's own order.
//
// At 300 px the name was cut first ("use…" beside "src/lib/very/deeply/…"),
// and when the directory was cut it lost its tail: an inline direction:ltr
// cancelled the right-to-left clip that keeps it. Measured in the real page.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: ChangesPage | undefined;
after(async () => {
  await page?.close();
});

const LONG_DIR = "src/lib/very/deeply/nested/folders/components";
const DOT_DIR = ".github/workflows/reusable";

test("the name stays whole, and the directory keeps its tail in the path's order", { skip }, async () => {
  page = await ChangesPage.open("dark", { width: 300, height: 480 });
  await page.send({
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    unstaged: [
      { path: `${LONG_DIR}/useThing.ts`, status: "M" },
      { path: `${DOT_DIR}/release.yml`, status: "M" },
    ],
  });
  const rows = await page.eval<{ name: string; nameCut: boolean; dirWidth: number; tail: string; firstIsDot: boolean | null }[]>(`(function () {
    return Array.prototype.map.call(document.querySelectorAll(".row.is-file"), function (row) {
      var name = row.querySelector(".name"), dir = row.querySelector(".dir");
      var d = dir.getBoundingClientRect();
      // Which characters of the directory are on screen: the last one visible
      // is the one whose box ends at (or before) the clip's right edge.
      var text = dir.textContent, node = dir.querySelector("bdi") ? dir.querySelector("bdi").firstChild : dir.firstChild;
      var range = document.createRange();
      var shown = "";
      for (var i = 0; i < text.length; i++) {
        range.setStart(node, i); range.setEnd(node, i + 1);
        var r = range.getBoundingClientRect();
        if (r.left >= d.left - 0.5 && r.right <= d.right + 0.5) shown += text[i];
      }
      range.setStart(node, 0); range.setEnd(node, 1);
      var dot = range.getBoundingClientRect();
      range.setStart(node, 1); range.setEnd(node, 2);
      var next = range.getBoundingClientRect();
      return {
        name: name.textContent,
        nameCut: name.scrollWidth > name.clientWidth + 0.5,
        dirWidth: Math.round(d.width),
        tail: shown,
        firstIsDot: text[0] === "." ? dot.left < next.left : null,
      };
    });
  })()`);
  for (const r of rows) {
    assert.equal(r.nameCut, false, `${r.name} is whole while its directory has ${r.dirWidth}px`);
    assert.ok(r.dirWidth > 0, `${r.name}: the directory still shows`);
  }
  const deep = rows.find((r) => r.name === "useThing.ts")!;
  assert.ok(LONG_DIR.endsWith(deep.tail) && deep.tail.length >= 6, `the tail of the directory is shown: "${deep.tail}"`);
  const dot = rows.find((r) => r.name === "release.yml")!;
  assert.ok(DOT_DIR.endsWith(dot.tail), `the tail, in order: "${dot.tail}"`);
  assert.equal(dot.firstIsDot, true, "a leading '.' stays at the start (it is not moved to the end by the right-to-left clip)");
});
