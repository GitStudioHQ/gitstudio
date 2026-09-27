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

interface AXFull extends AXNode {
  properties?: { name: string; value: { value?: unknown } }[];
}

/** Every tree row Chrome exposes: its name, and whether it is checked. */
async function treeRows(page: ChangesPage): Promise<{ name: string; checked: string | null }[]> {
  await page.page.send("Accessibility.enable");
  const { nodes } = await page.page.send<{ nodes: AXFull[] }>("Accessibility.getFullAXTree");
  return nodes
    .filter((n) => !n.ignored && n.role?.value === "treeitem")
    .map((n) => {
      const c = (n.properties ?? []).find((p) => p.name === "checked");
      return { name: (n.name?.value ?? "").trim(), checked: c ? String(c.value.value) : null };
    });
}

// The checkbox model: the ROW is the tick — a treeitem that is checked, not
// checked or mixed, toggled with Space — so a screen reader hears the file
// and its state in one place. The drawn box beside it is the pointer's.
test("the checkbox model: each file row is named by its file and says whether it is included; every button has a name", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 640 });
  opened.push(page);
  await page.send({
    ...stateMessage({ local: [{ name: "main", current: true }] }),
    staged: [{ path: "src/app.ts", status: "M" }],
    unstaged: FILES,
    stagingModel: "checkboxes",
  });
  const rows = await treeRows(page);
  assert.deepEqual(rows.filter((r) => r.name === ""), [], `unnamed rows among ${JSON.stringify(rows)}`);
  const byName = new Map(rows.map((r) => [r.name, r.checked]));
  assert.equal(byName.get("README.md, Modified"), "false", JSON.stringify(rows));
  // Staged AND unstaged: some of it is included.
  assert.equal(byName.get("app.ts, Modified"), "mixed", JSON.stringify(rows));
  assert.equal(byName.get("Changes, 2 files"), "mixed", "the header ticks them all");
  // The only checkboxes left in the tree are the composer's own.
  assert.deepEqual(await named(page, "checkbox"), ["Amend", "Sign-off"]);
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
// nothing about it: no role, no expanded state. It is a treeitem one level
// below its group now, named by the folder, and says whether it is open.
test("the tree layout: a folder row is a treeitem that says whether it is open", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 640 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: FILES, layout: "tree" });
  const folder = () =>
    page.eval<{ role: string | null; expanded: string | null; level: string | null; name: string | null } | null>(`(function () {
      var rows = document.querySelectorAll(".group--unstaged .row:not(.is-file)");
      for (var i = 0; i < rows.length; i++) {
        var n = rows[i].querySelector(".name");
        if (n && n.textContent === "src") {
          return {
            role: rows[i].getAttribute("role"),
            expanded: rows[i].getAttribute("aria-expanded"),
            level: rows[i].getAttribute("aria-level"),
            name: rows[i].getAttribute("aria-label"),
          };
        }
      }
      return null;
    })()`);
  assert.deepEqual(await folder(), { role: "treeitem", expanded: "true", level: "2", name: "src, folder, 1 file" });
  await page.eval(`(function () {
    var rows = document.querySelectorAll(".group--unstaged .row:not(.is-file)");
    for (var i = 0; i < rows.length; i++) if (rows[i].querySelector(".name").textContent === "src") rows[i].click();
  })()`);
  assert.deepEqual(await folder(), { role: "treeitem", expanded: "false", level: "2", name: "src, folder, 1 file" });
  const rows = await treeRows(page);
  assert.ok(rows.some((r) => r.name === "README.md, Modified"), JSON.stringify(rows));
  const buttons = await named(page, "button");
  assert.deepEqual(buttons.filter((n) => n === ""), [], `unnamed buttons among ${JSON.stringify(buttons)}`);
});

// A row was a button, and a button's content is read as one name: the row
// was heard as "README.md Stage file Discard changes M".
test("the split model: a file row is a treeitem named by its file and what happened to it — not its buttons", { skip }, async () => {
  const page = await ChangesPage.open("dark", { width: 420, height: 640 });
  opened.push(page);
  await page.send({ ...stateMessage({ local: [{ name: "main", current: true }] }), unstaged: FILES });
  const rows = await treeRows(page);
  assert.deepEqual(
    rows.map((r) => r.name),
    ["Unstaged, 2 files", "README.md, Modified", "app.ts, Modified"],
  );
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
