import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// The Changes view's expand/collapse chevrons point the way every tree in the
// editor does: DOWN when open, RIGHT when closed — for a group header, a
// folder in the tree layout, and a file's "show individual changes" twisty
// in the checkbox model.
//
// The glyph is codicon-chevron-right, and the CSS was written for a
// down-pointing one: an open group showed ">" and a closed one "^" (rotated
// -90deg), and in the checkbox model every closed file showed "^". Measured
// here as the direction the rendered glyph points: the glyph's own direction
// through the element's computed transform.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const FILES = ["src/a.ts", "src/lib/b.ts", "README.md"];
const STATE = {
  ...stateMessage({ local: [{ name: "main", current: true }] }),
  staged: [{ path: "docs/guide.md", status: "M" }],
  unstaged: FILES.map((path) => ({ path, status: "M" })),
  stagedCount: 1,
};

async function open(extra: Record<string, unknown>): Promise<ChangesPage> {
  const page = await ChangesPage.open("dark", { width: 520, height: 640 });
  opened.push(page);
  // The end state of each transition, not a frame in the middle of it.
  await page.eval(`(function () {
    var s = document.createElement("style");
    s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(s);
  })()`);
  await page.send({ ...STATE, ...extra });
  return page;
}

/**
 * Where each matching twisty's glyph points: its glyph's direction ("right"
 * for chevron-right, "down" for chevron-down) turned by its computed transform.
 */
async function directions(page: ChangesPage, selector: string): Promise<string[]> {
  return page.eval<string[]>(`(function () {
    return Array.prototype.map.call(document.querySelectorAll(${JSON.stringify(selector)}), function (t) {
      var glyph = t.querySelector(".codicon");
      var v = glyph.classList.contains("codicon-chevron-down") ? [0, 1]
        : glyph.classList.contains("codicon-chevron-right") ? [1, 0] : null;
      if (!v) return "glyph " + glyph.className;
      var m = new DOMMatrixReadOnly(getComputedStyle(t).transform === "none" ? undefined : getComputedStyle(t).transform);
      var x = m.a * v[0] + m.c * v[1], y = m.b * v[0] + m.d * v[1];
      if (Math.abs(x) > Math.abs(y)) return x > 0 ? "right" : "left";
      return y > 0 ? "down" : "up";
    });
  })()`);
}

async function clickCentre(page: ChangesPage, selector: string): Promise<void> {
  const at = await page.eval<{ x: number; y: number }>(`(function () {
    var b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await page.click(at.x, at.y);
}

test("group headers: down while open, right once collapsed", { skip }, async () => {
  const page = await open({ layout: "list" });
  assert.deepEqual(await directions(page, ".group:not(.empty) .group-header .twisty"), ["down", "down"]);
  await clickCentre(page, ".group--unstaged .group-header .glabel");
  assert.equal(await page.eval(`document.querySelector(".group--unstaged").classList.contains("collapsed")`), true);
  assert.deepEqual(await directions(page, ".group--unstaged .group-header .twisty"), ["right"]);
  assert.deepEqual(await directions(page, ".group--staged .group-header .twisty"), ["down"], "the other one stays open");
});

test("folders in the tree layout: down while open, right once collapsed", { skip }, async () => {
  const page = await open({ layout: "tree" });
  const folders = ".group--unstaged .row:not(.is-file) .twisty";
  const before = await directions(page, folders);
  assert.ok(before.length >= 1, "the tree has folders");
  assert.deepEqual(before, before.map(() => "down"));
  await clickCentre(page, ".group--unstaged .row:not(.is-file) .name");
  assert.equal(await directions(page, folders).then((d) => d[0]), "right");
});

test("a file's changes twisty in the checkbox model: right while closed, down once open", { skip }, async () => {
  const page = await open({ layout: "list", stagingModel: "checkboxes" });
  const twisties = await directions(page, ".hunk-twisty");
  assert.ok(twisties.length >= 3, `one per file: ${twisties.length}`);
  assert.deepEqual(twisties, twisties.map(() => "right"));
  await clickCentre(page, ".hunk-twisty");
  assert.equal(await page.eval(`document.querySelector(".hunk-twisty").getAttribute("aria-expanded")`), "true");
  assert.equal(await directions(page, ".hunk-twisty").then((d) => d[0]), "down");
});

test("the branch menu's category chevrons already pointed right: down while open, right when collapsed", { skip }, async () => {
  // A control for the measure: .bm-sep uses chevron-down, rotated -90deg when
  // collapsed, which was right all along.
  const page = await open({ layout: "list" });
  const dirs = await page.eval<string[]>(`(function () {
    var s = document.createElement("div");
    s.className = "bm-sep collapsed";
    s.innerHTML = '<i class="codicon codicon-chevron-down"></i>';
    document.body.appendChild(s);
    var o = document.createElement("div");
    o.className = "bm-sep";
    o.innerHTML = '<i class="codicon codicon-chevron-down"></i>';
    document.body.appendChild(o);
    return [s, o].map(function (el) {
      var m = new DOMMatrixReadOnly(getComputedStyle(el.firstChild).transform === "none" ? undefined : getComputedStyle(el.firstChild).transform);
      var x = m.c, y = m.d;
      if (Math.abs(x) > Math.abs(y)) return x > 0 ? "right" : "left";
      return y > 0 ? "down" : "up";
    });
  })()`);
  assert.deepEqual(dirs, ["right", "down"]);
});
