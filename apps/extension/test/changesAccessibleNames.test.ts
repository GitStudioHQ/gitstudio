import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage } from "./changesPage";

// What a screen reader hears in the Changes view, read from Chrome's own
// accessibility tree over DevTools.
//
// Every tick and icon-only button was named only by its `title`, and the
// view's tooltip upgrade (upgradeTips) moves each title into data-tip and
// deletes it — taking the accessible name with it: the checkbox names were
// ["Amend", "Sign-off", "", "", …] and six buttons had none. A file's tick is
// named by its file; a group header says whether it is expanded; the push
// review's close is the codicon every other close is, not a "×" glyph.

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

interface AXNode {
  ignored?: boolean;
  role?: { value?: string };
  name?: { value?: string };
}

async function named(page: ChangesPage, role: string): Promise<string[]> {
  await page.page.send("Accessibility.enable");
  const { nodes } = await page.page.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");
  return nodes.filter((n) => !n.ignored && n.role?.value === role).map((n) => (n.name?.value ?? "").trim());
}

const FILES = [
  { path: "README.md", status: "M" },
  { path: "src/app.ts", status: "M" },
];

test("the checkbox model: every tick and every button has a name, and a file's tick names its file", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 640 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: FILES, stagingModel: "checkboxes" });
  const boxes = await named(page, "checkbox");
  assert.ok(boxes.length >= 4, `the ticks are in the tree: ${JSON.stringify(boxes)}`);
  assert.deepEqual(boxes.filter((n) => n === ""), [], `unnamed ticks among ${JSON.stringify(boxes)}`);
  assert.ok(boxes.includes("Include README.md in the commit"), JSON.stringify(boxes));
  assert.ok(boxes.includes("Include src/app.ts in the commit"), JSON.stringify(boxes));
  const buttons = await named(page, "button");
  assert.deepEqual(buttons.filter((n) => n === ""), [], `unnamed buttons among ${JSON.stringify(buttons)}`);
});

test("the split model: every button has a name, and a group header says whether it is open", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 640 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: FILES });
  const buttons = await named(page, "button");
  assert.deepEqual(buttons.filter((n) => n === ""), [], `unnamed buttons among ${JSON.stringify(buttons)}`);
  const expanded = () => page.eval<string | null>(`document.querySelector(".group--unstaged .group-header").getAttribute("aria-expanded")`);
  assert.equal(await expanded(), "true");
  await page.eval(`document.querySelector(".group--unstaged .group-header").click()`);
  assert.equal(await expanded(), "false");
});

// A folder row in the tree layout collapses like a group header, and said
// nothing about it: no role, no expanded state. It says both now, as the
// header does (until rows become a tree of treeitems).
test("the tree layout: a folder row is a button that says whether it is open", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 640 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: FILES, layout: "tree" });
  const folder = () =>
    page.eval<{ role: string | null; expanded: string | null; name: string } | null>(`(function () {
      var rows = document.querySelectorAll(".group--unstaged .row:not(.is-file)");
      for (var i = 0; i < rows.length; i++) {
        var n = rows[i].querySelector(".name");
        if (n && n.textContent === "src") {
          return { role: rows[i].getAttribute("role"), expanded: rows[i].getAttribute("aria-expanded"), name: n.textContent };
        }
      }
      return null;
    })()`);
  assert.deepEqual(await folder(), { role: "button", expanded: "true", name: "src" });
  await page.eval(`(function () {
    var rows = document.querySelectorAll(".group--unstaged .row:not(.is-file)");
    for (var i = 0; i < rows.length; i++) if (rows[i].querySelector(".name").textContent === "src") rows[i].click();
  })()`);
  assert.deepEqual(await folder(), { role: "button", expanded: "false", name: "src" });
  const buttons = await named(page, "button");
  assert.deepEqual(buttons.filter((n) => n === ""), [], `unnamed buttons among ${JSON.stringify(buttons)}`);
});

test("the push review's close is the close codicon, named Close", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 640 });
  opened.push(page);
  await page.send(stateMessage({ local: [{ name: "main", current: true }] }));
  await page.send({
    type: "pushPreview", hasUpstream: true, target: "origin/main", branch: "main", base: "b".repeat(40),
    canPush: true, ahead: 1, behind: 0, needsForce: false, additions: 0, deletions: 0,
    commits: [{ sha: "a".repeat(40), subject: "One", author: "Ada", date: 1700000000 }], files: [],
  });
  const close = await page.eval<{ glyph: boolean; text: string; label: string | null }>(`(function () {
    var b = document.querySelector(".pm-close");
    return { glyph: !!b.querySelector(".codicon-close"), text: b.textContent.trim(), label: b.getAttribute("aria-label") };
  })()`);
  assert.deepEqual(close, { glyph: true, text: "", label: "Close" });
});
