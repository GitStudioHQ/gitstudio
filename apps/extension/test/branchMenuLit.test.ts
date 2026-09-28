import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type VsCodeTheme } from "./changesPage";
import { LOOK_PROBE } from "./litLook";
import { jsLiteral } from "../../../scripts/test/js-literal.mjs";

// The branch window's highlight, and its rows' tooltips, in the real page
// commitView.ts serves (a windowless Chrome, real keys and a real pointer).
//
// The owner, on a submenu item under the pointer: a grey fill inside a blue
// outline, its words faded to low contrast, and a tooltip repeating the label
// ("Copy Branch Name" over Copy Branch Name) — "looking bad". The rule now:
//   · the highlighted row is a tint of the accent: no outline, border, inset
//     shadow, underline or strip in the light and dark themes (the high
//     contrast themes keep VS Code's whole contrast ring, their own language);
//   · its words and icon keep full contrast on the tint (text 4.5:1, icon 3:1);
//   · the fill stands apart from the menu it sits on;
//   · the arrows and the pointer light a row the SAME way, and only one row
//     is ever lit — the row a resting pointer is over goes dark when the
//     arrows move on;
//   · a tooltip only where it adds something: never a label that is shown in
//     full; the whole label where it is cut; an explanation where there is one.
//
// State table: theme {dark, light, hc-dark, hc-light} × row {top action,
// branch, current branch, submenu item, submenu danger item, the drilled-in
// back row, a row menu's item, a row menu's danger item} × how {arrows,
// pointer}.

const LONG = "feature/a-branch-name-long-enough-to-be-cut-in-any-sidebar";
const STATE = {
  ...stateMessage({
    local: [
      { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
      { name: "topic" },
      { name: LONG },
    ],
    remote: ["origin/main"],
    tags: ["v1.0"],
  }),
  unstaged: [{ path: "src/app.ts", status: "M" }, { path: "src/routes.ts", status: "M" }],
};

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const opened: ChangesPage[] = [];
after(async () => {
  for (const p of opened) await p.close();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function open(theme: VsCodeTheme, width = 520): Promise<ChangesPage> {
  const p = await ChangesPage.open(theme, { width, height: 700 });
  opened.push(p);
  await p.eval(`(function () {
    var s = document.createElement("style");
    s.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(s);
  })()`);
  await p.eval(LOOK_PROBE);
  await p.send(STATE);
  return p;
}

async function openMenu(p: ChangesPage): Promise<void> {
  await p.send({ type: "openBranchMenu" });
  await p.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
  await sleep(30);
}

type Look = { fill: string; apart: number; text: number; icon: number | null; color: string; lines: string[] };

const look = (p: ChangesPage, el: string, text?: string, icon?: string): Promise<Look> =>
  p.eval<Look>(`window.__look(${el}, { text: ${text ?? "null"} || undefined, icon: ${icon ?? "null"} || undefined })`);

/** A pointer move onto the element's middle — from beside it first, so the page sees the pointer MOVE. */
async function pointTo(p: ChangesPage, el: string): Promise<void> {
  const at = await p.eval<{ x: number; y: number }>(`(function () {
    var e = ${el}; if (!e) throw new Error("nothing at ${el.replace(/"/g, "'")}");
    var b = e.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await p.mouseMove(at.x, at.y + 1);
  await p.mouseMove(at.x, at.y);
}

const mainRow = (key: string) => `document.querySelector('.bm-list [data-bmkey="${key}"]')`;
const subItem = (label: string) =>
  `Array.prototype.find.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim() === ${jsLiteral(label)}; })`;
const menuItem = (label: string) =>
  `Array.prototype.find.call(document.querySelectorAll(".action-menu .bm-subaction"), function (b) { return b.textContent.trim() === ${jsLiteral(label)}; })`;

/** The arrows, up or down, until the highlight is on the row keyed `key`. */
async function keyToMain(p: ChangesPage, key: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    const where = await p.eval<number>(`(function () {
      var rows = Array.prototype.filter.call(document.querySelectorAll(".bm-list [data-bmkey]"), function (n) { return n.getClientRects().length > 0; });
      var keys = rows.map(function (n) { return n.dataset.bmkey; });
      var a = document.querySelector(".bm-list .is-active");
      var at = a ? keys.indexOf(a.dataset.bmkey) : -1;
      return keys.indexOf(${jsLiteral(key)}) - at;
    })()`);
    if (where === 0) return;
    await p.key(where > 0 ? "ArrowDown" : "ArrowUp");
  }
  throw new Error(`the arrows never reached ${key}`);
}
async function keyToSub(p: ChangesPage, label: string): Promise<void> {
  for (let i = 0; i < 30; i++) {
    if (await p.eval<boolean>(`(function () { var a = document.querySelector(".branch-submenu .is-active"); return !!a && a.textContent.trim() === ${jsLiteral(label)}; })()`)) return;
    await p.key("ArrowDown");
  }
  throw new Error(`the arrows never reached ${label}`);
}

const lined = (theme: VsCodeTheme) => theme === "hc-dark" || theme === "hc-light";

/** What every lit row must be, in words the failure can show. */
function assertLit(theme: VsCodeTheme, what: string, l: Look): void {
  if (lined(theme)) {
    assert.ok(l.lines.length === 1 && /^outline solid 1px/.test(l.lines[0]), `${what}: high contrast keeps its one whole ring (${JSON.stringify(l)})`);
  } else {
    assert.deepEqual(l.lines, [], `${what}: lit, never lined (${JSON.stringify(l)})`);
  }
  assert.ok(l.apart >= 1.15, `${what}: the fill stands apart from the menu (${l.apart}:1, ${JSON.stringify(l)})`);
  assert.ok(l.text >= 4.5, `${what}: its words read at 4.5:1 or more on the fill (${l.text}:1, ${JSON.stringify(l)})`);
  if (l.icon !== null) assert.ok(l.icon >= 3, `${what}: its icon at 3:1 or more (${l.icon}:1)`);
}
function assertSame(what: string, keys: Look, pointer: Look): void {
  assert.deepEqual(
    { fill: pointer.fill, color: pointer.color, lines: pointer.lines },
    { fill: keys.fill, color: keys.color, lines: keys.lines },
    `${what}: the pointer lights it exactly as the arrows do`,
  );
}
async function assertDark(p: ChangesPage, what: string, el: string): Promise<void> {
  const l = await look(p, el);
  assert.ok(l.apart < 1.02 && l.lines.length === 0, `${what}: the row the pointer rests on goes dark when the arrows move on (${JSON.stringify(l)})`);
}

for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: every kind of row is lit the same by the arrows and the pointer — a tint, full-strength words, no line`, { skip }, async () => {
    const p = await open(theme);
    await openMenu(p);

    // Rows of the list: a top action, a branch, the current branch.
    for (const [what, key, label] of [
      ["top action", "a:fetch", `${mainRow("a:fetch")}.querySelector("span")`],
      ["branch", "b:local:topic", `${mainRow("b:local:topic")}.querySelector(".bm-bname")`],
      ["current branch", "b:local:main", `${mainRow("b:local:main")}.querySelector(".bm-bname")`],
    ] as const) {
      const icon = `${mainRow(key)}.querySelector(".codicon:not(.bm-bmore)")`;
      await keyToMain(p, key);
      const keys = await look(p, mainRow(key), label, icon);
      assertLit(theme, what, keys);
      await p.key("ArrowDown");
      await pointTo(p, mainRow(key));
      const pointer = await look(p, mainRow(key), label, icon);
      assertSame(what, keys, pointer);
      // The arrows go on from it (the pointer made it the highlight); the
      // pointer stays where it is.
      await p.key("ArrowDown");
      await assertDark(p, what, mainRow(key));
    }

    // A branch's actions: an item, and the danger item.
    await keyToMain(p, "b:local:topic");
    await p.key("ArrowRight");
    for (const [what, label] of [["submenu item", "Copy Branch Name"], ["submenu danger item", "Delete"]] as const) {
      await keyToSub(p, label);
      const text = `${subItem(label)}.querySelector("span")`;
      const icon = `${subItem(label)}.querySelector(".codicon")`;
      const keys = await look(p, subItem(label), text, icon);
      assertLit(theme, what, keys);
      await p.key("ArrowUp");
      await pointTo(p, subItem(label));
      const pointer = await look(p, subItem(label), text, icon);
      assertSame(what, keys, pointer);
      await p.key("ArrowUp");
      await assertDark(p, what, subItem(label));
    }

    // Drilled in, the back row ('‹ topic') is a row too: the pointer lights
    // it with the items' own tint — no hover colour of its own, no rule under
    // it — and the item the arrows had goes dark: one row lit.
    const back = `document.querySelector(".branch-submenu.is-drilled .bm-subhead")`;
    assert.ok(await p.eval<boolean>(`!!${back}`), "drilled in at this width");
    await pointTo(p, subItem("Copy Branch Name"));
    const item = await look(p, subItem("Copy Branch Name"));
    await pointTo(p, back);
    const b = await look(p, back, `${back}.querySelector(".bm-subhead-name")`, `${back}.querySelector(".bm-back")`);
    assertLit(theme, "the back row", b);
    assert.equal(b.fill, item.fill, `the back row is lit with the items' tint (${b.fill} / ${item.fill})`);
    assert.deepEqual(
      await p.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".branch-menu .is-active, .branch-submenu .is-active"), function (n) { return n.textContent.trim(); })`),
      ["topic"], "the back row is the one row lit",
    );
    await assertDark(p, "the item the pointer left for the back row", subItem("Copy Branch Name"));
    // Down goes into the actions from their top; the back row goes dark.
    await p.key("ArrowDown");
    const first = await p.eval<string>(`document.querySelector(".branch-submenu .bm-subaction.is-active").textContent.trim()`);
    assert.equal(first, await p.eval<string>(`document.querySelector(".branch-submenu .bm-subaction").textContent.trim()`), "Down: the first action");
    assert.equal(await p.eval<boolean>(`${back}.classList.contains("is-active")`), false, "and the back row is not lit");
    assert.notEqual((await look(p, back)).fill, b.fill, "nor looks it");
    // Lit, Enter goes back, as a press on it does.
    await pointTo(p, `${subItem("Copy Branch Name")}`);
    await pointTo(p, back);
    await p.key("Enter");
    assert.equal(await p.eval<boolean>(`!!document.querySelector(".branch-submenu")`), false, "Enter on the lit back row goes back");
    assert.equal(await p.eval<string>(`document.querySelector(".bm-list .is-active").dataset.bmkey`), "b:local:topic", "to its branch");
    await p.key("Escape");

    // A file row's own menu (right-click): the item the keyboard is on is its highlight.
    const row = await p.eval<{ x: number; y: number }>(`(function () {
      var b = document.querySelector('.row.is-file[data-key="unstaged:src/app.ts"] .name').getBoundingClientRect();
      return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
    })()`);
    await p.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: row.x, y: row.y, button: "right", clickCount: 1 });
    await p.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: row.x, y: row.y, button: "right", clickCount: 1 });
    await p.page.waitFor(`!!document.querySelector(".action-menu .bm-subaction")`);
    for (const [what, label] of [["row menu item", "Open Changes"], ["row menu danger item", "Discard Changes"]] as const) {
      // To the item by the keys.
      for (let i = 0; i < 10 && !(await p.eval<boolean>(`document.activeElement === ${menuItem(label)}`)); i++) await p.key("ArrowDown");
      const text = `${menuItem(label)}.querySelector("span")`;
      const icon = `${menuItem(label)}.querySelector(".codicon")`;
      const keys = await look(p, menuItem(label), text, icon);
      assertLit(theme, what, keys);
      await p.key("ArrowUp");
      await pointTo(p, menuItem(label));
      assert.ok(await p.eval<boolean>(`document.activeElement === ${menuItem(label)}`), `${what}: the pointer moves the keyboard's item`);
      const pointer = await look(p, menuItem(label), text, icon);
      assertSame(what, keys, pointer);
      await p.key("ArrowDown");
      await assertDark(p, what, menuItem(label));
    }
    await p.key("Escape");
  });
}

/** Whether the page's tooltip is up, and what it says. */
const tipShown = (p: ChangesPage) =>
  p.eval<string | null>(`(function () { var t = document.querySelector(".gs-tip.show"); return t ? t.textContent : null; })()`);

async function hoverTip(p: ChangesPage, el: string): Promise<string | null> {
  await pointTo(p, el);
  await sleep(600); // the tip's delay is 350ms
  const t = await tipShown(p);
  await p.mouseMove(2, 2);
  await sleep(20);
  return t;
}

for (const theme of ["dark", "light"] as VsCodeTheme[]) {
  test(`${theme}: a tooltip only says what is not already on screen`, { skip }, async () => {
    const p = await open(theme, 300);
    await openMenu(p);
    assert.equal(await hoverTip(p, mainRow("a:fetch")), null, "Fetch: its words are all there, no tip");
    assert.equal(await hoverTip(p, mainRow("b:local:topic")), null, "a branch shown in full: no tip repeating its name");
    assert.equal(await hoverTip(p, mainRow(`b:local:${LONG}`)), LONG, "a branch whose name is cut: the whole name");
    assert.match(String(await hoverTip(p, mainRow("b:local:main"))), /origin\/main/, "a branch with an upstream: the tip says what it tracks");
    assert.equal(
      await hoverTip(p, `${mainRow("b:local:main")}.querySelector(".bm-star")`), "Add to favorites",
      "an icon-only button: its name",
    );

    // A branch's actions (drilled in at this width).
    await keyToMain(p, "b:local:topic");
    await p.key("ArrowRight");
    assert.equal(await hoverTip(p, subItem("Copy Branch Name")), null, "Copy Branch Name: no tip repeating it");
    assert.equal(await hoverTip(p, subItem("Rename…")), null);
    assert.equal(await hoverTip(p, subItem("Delete")), null, "the danger item neither");
    assert.match(String(await hoverTip(p, subItem("Set Tracked Branch…"))), /^Choose the remote branch 'topic'/, "an item with more to say says it");
    await p.key("Escape");

    // A long branch's actions: its labels quote the name, and are cut.
    await keyToMain(p, `b:local:${LONG}`);
    await p.key("ArrowRight");
    const label = `New Branch from '${LONG}'…`;
    const cut = await p.eval<boolean>(`(function () { var s = ${subItem(label)}.querySelector("span"); return s.scrollWidth > s.clientWidth; })()`);
    assert.ok(cut, "the label is cut at this width");
    assert.equal(await hoverTip(p, subItem(label)), label, "a cut label: its whole text");
  });
}

// A screen reader hears an item's words once: a tip that only repeats them is
// not made its description too.
test("an item's tip that repeats its label is not also its description", { skip }, async () => {
  const p = await open("dark");
  await openMenu(p);
  await keyToMain(p, "b:local:topic");
  await p.key("ArrowRight");
  const desc = await p.eval<string | null>(`${subItem("Copy Branch Name")}.getAttribute("aria-description")`);
  assert.equal(desc, null);
  const tracked = await p.eval<string | null>(`${subItem("Set Tracked Branch…")}.getAttribute("aria-description")`);
  assert.match(String(tracked), /^Choose the remote branch/, "an explanation still is");
});

// A row's own menu follows the pointer only when the pointer MOVES: a list
// scrolling under a still pointer (the arrows, in a short view) sends the page
// a mousemove at the same spot, and that must not take the item from the keys.
test("a row menu's item stays with the keys when the pointer has not moved", { skip }, async () => {
  const p = await open("dark");
  const row = await p.eval<{ x: number; y: number }>(`(function () {
    var b = document.querySelector('.row.is-file[data-key="unstaged:src/app.ts"] .name').getBoundingClientRect();
    return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await p.page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: row.x, y: row.y, button: "right", clickCount: 1 });
  await p.page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: row.x, y: row.y, button: "right", clickCount: 1 });
  await p.page.waitFor(`!!document.querySelector(".action-menu .bm-subaction")`);
  await pointTo(p, menuItem("Stage"));
  assert.ok(await p.eval<boolean>(`document.activeElement === ${menuItem("Stage")}`), "the pointer moved onto Stage: it has the keyboard");
  await p.key("ArrowDown");
  const keys = await p.eval<string>(`document.activeElement.textContent.trim()`);
  assert.notEqual(keys, "Stage");
  const at = await p.eval<{ x: number; y: number }>(`(function () {
    var b = ${menuItem("Stage")}.getBoundingClientRect(); return { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2) };
  })()`);
  await p.mouseMove(at.x, at.y); // the same spot: a still pointer
  assert.equal(await p.eval<string>(`document.activeElement.textContent.trim()`), keys, "the keys keep their item");
  await p.key("Escape");
});

// A search's matched letters on the lit row read too: they are words.
for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`${theme}: the letters a search matched read at 4.5:1 on the lit row, and still stand out from the rest`, { skip }, async () => {
    const p = await open(theme);
    await openMenu(p);
    await p.type("topic");
    await p.page.waitFor(`!!document.querySelector(".bm-list .is-active .bm-hl")`);
    const m = await p.eval<{ hl: Look; rest: Look; bold: string }>(`(function () {
      var row = document.querySelector(".bm-list .is-active");
      var hl = row.querySelector(".bm-hl");
      return { hl: window.__look(hl, { text: hl }), rest: window.__look(row, { text: row.querySelector(".bm-bname") }), bold: getComputedStyle(hl).fontWeight };
    })()`);
    assert.ok(m.hl.text >= 4.5, `the match reads ${m.hl.text}:1 (${JSON.stringify(m.hl)})`);
    assert.ok(m.hl.fill !== m.rest.fill || m.hl.color !== m.rest.color, `and is marked apart from the rest of the name: ${JSON.stringify(m)}`);
    assert.ok(Number(m.bold) >= 600, "in bold");
  });
}
