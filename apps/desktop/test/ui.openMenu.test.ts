// `openMenu` — the app's one dropdown (29 menus build on it): what a row
// looks like, where the keyboard goes, how it closes and what it hands back to
// the trigger, its type-to-filter field, its per-row submenus, and where it is
// placed on screen. Rendered into helpers/miniDom.ts and driven with real
// clicks and keydowns on the focused element.

import { test, before, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import { installMiniDom, fire, press, settle, setRect, text, type MiniElement } from "./helpers/miniDom";

const dom = installMiniDom();
type UI = typeof import("../src/renderer/ui");
type MenuItem = import("../src/renderer/ui").MenuItem;
let ui!: UI;
let overlays!: typeof import("../src/renderer/overlays");
before(async () => {
  ui = (await import("../src/renderer/ui")) as UI;
  overlays = await import("../src/renderer/overlays");
});

const E = (x: unknown): MiniElement => x as MiniElement;
const doc = dom.document;

let anchor!: MiniElement;
beforeEach(() => {
  mock.timers.enable({ apis: ["setTimeout"] });
  doc.body.replaceChildren();
  dom.window.innerWidth = 1200;
  dom.window.innerHeight = 800;
  doc.sizer = (el) => (el.classList.contains("dropdown") ? { width: 200, height: 150 } : undefined);
  anchor = doc.createElement("button");
  anchor.textContent = "Branch";
  setRect(anchor, { left: 100, top: 50, width: 80, height: 20 });
  doc.body.appendChild(anchor);
  anchor.focus();
});
afterEach(() => {
  ui.closeMenu();
  mock.timers.reset();
});

/** Open, then let the deferred focus + outside-click wiring run. */
function open(items: MenuItem[], opts?: Parameters<UI["openMenu"]>[2]): MiniElement {
  ui.openMenu(anchor as never, items, opts);
  mock.timers.tick(0);
  return menuEl()!;
}
const menuEl = (): MiniElement | null => doc.querySelector(".dropdown:not(.dropdown-submenu)");
const subEl = (): MiniElement | null => doc.querySelector(".dropdown-submenu");
const rowsOf = (m: MiniElement | null): MiniElement[] => (m ? m.querySelectorAll(".dropdown-item") : []);
const labelOf = (r: MiniElement): string => text(r.querySelector(".dropdown-label"));
const focusedLabel = (): string => labelOf(doc.activeElement);

// ── what a row is ────────────────────────────────────────────────────────────

test("rows carry their role, state, label, sub-label, icon and tooltip", () => {
  const av = doc.createElement("span");
  av.className = "av";
  const m = open([
    { label: "main", sub: "origin/main", icon: "git-branch", current: true, onClick: () => {} },
    { label: "old", disabled: true, onClick: () => {} },
    { separator: true, label: "Danger zone" },
    { label: "Delete", danger: true, title: "Delete feat/x", iconEl: av as never, onClick: () => {} },
  ]);
  assert.equal(m.getAttribute("role"), "menu");
  assert.equal(anchor.getAttribute("aria-haspopup"), "true");
  assert.equal(anchor.getAttribute("aria-expanded"), "true");
  const [main, old, del] = rowsOf(m);
  assert.equal(main.getAttribute("role"), "menuitem");
  assert.ok(main.classList.contains("is-current"));
  assert.equal(main.getAttribute("aria-current"), "true");
  assert.equal(text(main.querySelector(".dropdown-sub")), "origin/main");
  assert.ok(main.querySelector(".codicon-git-branch"));
  assert.ok(main.querySelector(".dropdown-trail.codicon-check"), "the current row is ticked");
  assert.ok(old.classList.contains("is-disabled"));
  assert.equal(old.getAttribute("aria-disabled"), "true");
  assert.ok(del.classList.contains("is-danger"));
  assert.equal(del.title, "Delete feat/x");
  assert.ok(del.contains(av), "a pre-built leading element stands in for the icon");
  const sep = m.querySelector(".dropdown-sep")!;
  assert.equal(sep.getAttribute("role"), "separator");
  assert.equal(sep.textContent, "Danger zone");
  assert.equal(doc.activeElement, main, "the keyboard lands on the current row");
});

test("choosing a row closes the menu and hands focus back to the trigger BEFORE the action runs", () => {
  const reasons: string[] = [];
  let focusDuringAction: unknown;
  const m = open(
    [
      { label: "One", onClick: () => {} },
      { label: "Two", onClick: () => (focusDuringAction = doc.activeElement) },
    ],
    { onClose: (r) => reasons.push(r) },
  );
  rowsOf(m)[1].click();
  assert.equal(focusDuringAction, anchor, "a dialog the action opens returns the keyboard to the trigger");
  assert.equal(menuEl(), null);
  assert.equal(anchor.getAttribute("aria-expanded"), "false");
  assert.deepEqual(reasons, ["action"]);
  assert.equal(overlays.isMenuOpen(), false, "the layer registry no longer lists it");
});

test("a disabled row runs nothing and the keyboard skips it", () => {
  let ran = 0;
  const m = open([
    { label: "A", onClick: () => ran++ },
    { label: "B", disabled: true, onClick: () => ran++ },
    { label: "C", onClick: () => ran++ },
  ]);
  rowsOf(m)[1].click();
  assert.equal(ran, 0);
  assert.ok(menuEl(), "still open");
  assert.equal(focusedLabel(), "A");
  press("ArrowDown");
  assert.equal(focusedLabel(), "C");
});

// ── keyboard ─────────────────────────────────────────────────────────────────

test("arrows wrap, Home and End jump, Enter and Space run the focused row", () => {
  const ran: string[] = [];
  const items = ["a", "b", "c"].map((l) => ({ label: l, onClick: () => ran.push(l) }));
  open(items);
  assert.equal(focusedLabel(), "a");
  press("ArrowUp");
  assert.equal(focusedLabel(), "c", "Up from the first wraps to the last");
  press("ArrowDown");
  assert.equal(focusedLabel(), "a");
  press("End");
  assert.equal(focusedLabel(), "c");
  press("Home");
  assert.equal(focusedLabel(), "a");
  press("ArrowDown");
  const enter = press("Enter");
  assert.equal(enter.defaultPrevented, true);
  assert.deepEqual(ran, ["b"]);
  assert.equal(doc.activeElement, anchor);

  open(items);
  press(" ");
  assert.deepEqual(ran, ["b", "a"]);
});

test("a held key's repeat runs nothing", () => {
  let ran = 0;
  open([{ label: "Checkout", onClick: () => ran++ }]);
  const e = press("Enter", { repeat: true });
  assert.equal(e.defaultPrevented, true);
  assert.equal(ran, 0);
  assert.ok(menuEl());
});

test("Escape closes with reason 'escape', restores the trigger and keeps the key from the layers beneath", (t) => {
  const after = (fn: () => void): void => t.after(fn);
  const reasons: string[] = [];
  let pageSawEscape = 0;
  const page = (e: { key: string }): void => {
    if (e.key === "Escape") pageSawEscape++;
  };
  doc.addEventListener("keydown", page as never);
  after(() => doc.removeEventListener("keydown", page as never));
  open([{ label: "x", onClick: () => {} }], { onClose: (r) => reasons.push(r) });
  press("Escape");
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, anchor);
  assert.deepEqual(reasons, ["escape"]);
  assert.equal(pageSawEscape, 0, "the page's bubbling Escape handler never hears it");
});

test("Tab out of a menu gives the keyboard back to the trigger", () => {
  open([{ label: "x", onClick: () => {} }]);
  press("Tab");
  assert.equal(menuEl(), null);
  assert.equal(doc.activeElement, anchor);
});

test("pressing the trigger of an open menu closes it; opening another closes the first cleanly", () => {
  const baseKeydown = doc.listenerCount("keydown");
  open([{ label: "x", onClick: () => {} }]);
  assert.equal(doc.listenerCount("keydown"), baseKeydown + 1);
  ui.openMenu(anchor as never, [{ label: "x", onClick: () => {} }]);
  assert.equal(menuEl(), null, "re-clicking the trigger means close");
  assert.equal(anchor.getAttribute("aria-expanded"), "false");
  assert.equal(doc.listenerCount("keydown"), baseKeydown, "its document listeners went with it");

  const other = doc.createElement("button");
  doc.body.appendChild(other);
  open([{ label: "first", onClick: () => {} }]);
  ui.openMenu(other as never, [{ label: "second", onClick: () => {} }]);
  mock.timers.tick(0);
  assert.equal(doc.querySelectorAll(".dropdown").length, 1);
  assert.equal(labelOf(rowsOf(menuEl())[0]), "second");
  assert.equal(anchor.getAttribute("aria-expanded"), "false", "the first trigger is not left claiming an open menu");
  assert.equal(doc.listenerCount("keydown"), baseKeydown + 1);
});

test("a mousedown outside dismisses without stealing focus; inside, or on the trigger, it does not", () => {
  const reasons: string[] = [];
  const m = open([{ label: "x", onClick: () => {} }], { onClose: (r) => reasons.push(r) });
  fire(rowsOf(m)[0], "mousedown");
  fire(anchor, "mousedown");
  assert.ok(menuEl(), "clicks on the menu or its own trigger are not 'outside'");
  const elsewhere = doc.createElement("div");
  doc.body.appendChild(elsewhere);
  fire(elsewhere, "mousedown");
  assert.equal(menuEl(), null);
  assert.deepEqual(reasons, ["dismiss"]);
  assert.notEqual(doc.activeElement, anchor, "a click away does not yank the keyboard back");
});

test("closeMenu() and a route change both close the open menu", () => {
  open([{ label: "x", onClick: () => {} }]);
  ui.closeMenu();
  assert.equal(menuEl(), null);
  open([{ label: "x", onClick: () => {} }]);
  overlays.dismissLayers();
  assert.equal(menuEl(), null);
  assert.equal(anchor.getAttribute("aria-expanded"), "false");
});

// ── ticks and in-place actions ───────────────────────────────────────────────

test("a checkable row flips its own tick, stays open, and reports the new state", () => {
  const got: string[] = [];
  const m = open([
    { label: "bug", checkable: true, current: true, onClick: (r) => got.push(r.getAttribute("aria-checked")!) },
    { label: "docs", checkable: true, onClick: (r) => got.push(r.getAttribute("aria-checked")!) },
  ]);
  const [bug, docs] = rowsOf(m);
  assert.equal(bug.getAttribute("role"), "menuitemcheckbox");
  assert.equal(bug.getAttribute("aria-checked"), "true");
  assert.equal(E(bug.querySelector(".dropdown-tick")).style.visibility, "visible");
  assert.equal(E(docs.querySelector(".dropdown-tick")).style.visibility, "hidden");
  docs.click();
  bug.click();
  assert.deepEqual(got, ["true", "false"]);
  assert.ok(docs.classList.contains("is-current"));
  assert.equal(bug.classList.contains("is-current"), false);
  assert.equal(E(bug.querySelector(".dropdown-tick")).style.visibility, "hidden");
  assert.ok(menuEl(), "picking three labels is one open menu, not three");
});

test("a keepOpen action runs in place, and not again while it is busy", () => {
  let runs = 0;
  const m = open([
    {
      label: "Fetch",
      keepOpen: true,
      onClick: (row) => {
        runs++;
        row.classList.add("is-busy-item");
      },
    },
  ]);
  const row = rowsOf(m)[0];
  row.click();
  row.click();
  assert.equal(runs, 1);
  assert.ok(menuEl());
  row.classList.remove("is-busy-item");
  row.click();
  assert.equal(runs, 2);
});

// ── type to filter ───────────────────────────────────────────────────────────

function branches(n: number, ran: string[] = []): MenuItem[] {
  const out: MenuItem[] = [{ separator: true, label: "Local" }];
  for (let i = 0; i < n; i++) {
    const label = i % 2 ? `fix/bug-${i}` : `feat/thing-${i}`;
    out.push({ label, onClick: () => ran.push(label) });
  }
  return out;
}
const visibleLabels = (): string[] => rowsOf(menuEl()).filter((r) => !r.hidden).map(labelOf);

test("a long menu grows a filter that takes the keyboard and narrows the rows", () => {
  const ran: string[] = [];
  const m = open(branches(12, ran));
  const search = m.querySelector("input.dropdown-search")!;
  assert.equal(m.firstElementChild!.classList.contains("dropdown-search-wrap"), true, "the filter sits at the top");
  assert.equal(search.getAttribute("aria-label"), "Filter menu");
  assert.equal(doc.activeElement, search);
  search.value = "FIX";
  fire(search, "input");
  assert.deepEqual(visibleLabels(), ["fix/bug-1", "fix/bug-3", "fix/bug-5", "fix/bug-7", "fix/bug-9", "fix/bug-11"]);
  assert.equal(m.querySelector(".dropdown-sep")!.hidden, true, "section headings hide while filtering");
  press("Enter");
  assert.deepEqual(ran, ["fix/bug-1"], "Enter in the filter acts on the first match");
});

test("Home and End belong to the filter's caret, not the rows", () => {
  const m = open(branches(12));
  const search = m.querySelector("input.dropdown-search")!;
  const e = press("Home");
  assert.equal(e.defaultPrevented, false);
  assert.equal(doc.activeElement, search);
  press("End");
  assert.equal(doc.activeElement, search);
});

test("typing on a row keeps filtering; Backspace edits the filter", () => {
  const m = open(branches(12));
  const search = m.querySelector("input.dropdown-search")!;
  press("ArrowDown");
  assert.equal(focusedLabel(), "feat/thing-0");
  press("f");
  assert.equal(doc.activeElement, search, "the letter went to the filter");
  assert.equal(search.value, "f");
  press("ArrowDown");
  press("i");
  assert.equal(search.value, "fi");
  assert.deepEqual(visibleLabels().slice(0, 2), ["fix/bug-1", "fix/bug-3"]);
  press("ArrowDown");
  press("x");
  assert.equal(search.value, "fix");
  press("ArrowDown");
  press("Backspace");
  assert.equal(search.value, "fi");
  press("ArrowDown");
  const ctrl = press("k", { ctrlKey: true });
  assert.equal(ctrl.defaultPrevented, false, "a shortcut is not typed into the filter");
  assert.equal(search.value, "fi");
});

test("searchable:false keeps a long menu plain; searchable:true adds the filter to a short one", () => {
  assert.equal(open(branches(12), { searchable: false }).querySelector(".dropdown-search"), null);
  ui.closeMenu();
  assert.ok(open([{ label: "a", onClick: () => {} }], { searchable: true }).querySelector(".dropdown-search"));
});

// ── submenus ─────────────────────────────────────────────────────────────────

function withActions(log: string[], sub?: () => MenuItem[] | Promise<MenuItem[]>): MenuItem[] {
  return [
    {
      label: "feat/x",
      onClick: () => log.push("row feat/x"),
      submenu:
        sub ??
        (() => [
          { label: "Checkout", onClick: () => log.push("checkout") },
          { separator: true },
          { label: "Rename…", onClick: () => log.push("rename") },
          { label: "Delete", danger: true, onClick: () => log.push("delete") },
        ]),
      submenuLabel: "Actions for feat/x",
    },
    { label: "main", onClick: () => log.push("row main") },
  ];
}

test("Right opens a row's actions with the first ready; Left comes back to the row", () => {
  const log: string[] = [];
  const m = open(withActions(log));
  const row = rowsOf(m)[0];
  assert.equal(row.getAttribute("aria-haspopup"), "menu");
  assert.equal(row.getAttribute("aria-expanded"), "false");
  assert.equal(row.querySelector(".dropdown-more")!.title, "Actions for feat/x");
  press("ArrowRight");
  const sub = subEl()!;
  assert.equal(sub.getAttribute("aria-label"), "Actions for feat/x");
  assert.equal(row.getAttribute("aria-expanded"), "true");
  assert.ok(row.classList.contains("is-open"));
  assert.equal(focusedLabel(), "Checkout");
  press("ArrowLeft");
  assert.equal(subEl(), null);
  assert.equal(doc.activeElement, row);
  assert.equal(row.getAttribute("aria-expanded"), "false");
  assert.ok(menuEl(), "one level back, not closed");
  assert.deepEqual(log, []);
});

test("inside a submenu: arrows clamp, Home/End jump, Enter runs the action and closes everything", () => {
  const log: string[] = [];
  open(withActions(log));
  press("ArrowRight");
  press("ArrowUp");
  assert.equal(focusedLabel(), "Checkout", "clamped at the top — a submenu does not wrap");
  press("End");
  assert.equal(focusedLabel(), "Delete");
  press("ArrowDown");
  assert.equal(focusedLabel(), "Delete");
  press("Home");
  press("ArrowDown");
  assert.equal(focusedLabel(), "Rename…");
  assert.equal(press("ArrowRight").defaultPrevented, true, "Right inside the submenu goes nowhere");
  press("Enter");
  assert.deepEqual(log, ["rename"]);
  assert.equal(menuEl(), null);
  assert.equal(subEl(), null);
  assert.equal(doc.activeElement, anchor);
});

test("Escape in a submenu steps back one level; a second Escape closes the menu", () => {
  const log: string[] = [];
  open(withActions(log));
  press("ArrowRight");
  press("Escape");
  assert.equal(subEl(), null);
  assert.ok(menuEl());
  press("Escape");
  assert.equal(menuEl(), null);
});

test("Tab from a submenu closes the whole menu back to the trigger", () => {
  open(withActions([]));
  press("ArrowRight");
  press("Tab");
  assert.equal(menuEl(), null);
  assert.equal(subEl(), null);
  assert.equal(doc.activeElement, anchor);
});

test("Enter on a row with actions opens them rather than running the row", () => {
  const log: string[] = [];
  open(withActions(log));
  press("Enter");
  assert.ok(subEl());
  assert.deepEqual(log, []);
  press(" ");
  assert.deepEqual(log, ["checkout"], "Space runs the focused action");
});

test("the pointer's door: the arrow opens the actions without moving focus; a plain click runs the row", () => {
  const log: string[] = [];
  const m = open(withActions(log));
  const row = rowsOf(m)[0];
  row.querySelector(".dropdown-more")!.click();
  assert.ok(subEl());
  assert.equal(doc.activeElement, row, "opened by pointer: nothing inside is focused");
  row.querySelector(".dropdown-more")!.click();
  assert.equal(doc.querySelectorAll(".dropdown-submenu").length, 1, "opening it again does not stack a second");
  row.click();
  assert.deepEqual(log, ["row feat/x"]);
  assert.equal(menuEl(), null);
});

test("a row with actions but no command of its own opens them on click", () => {
  const log: string[] = [];
  const m = open([{ label: "origin", submenu: () => [{ label: "Fetch", onClick: () => log.push("fetch") }] }]);
  rowsOf(m)[0].click();
  assert.ok(subEl());
  assert.equal(labelOf(rowsOf(subEl())[0]), "Fetch");
});

test("an async submenu shows Loading… then its actions; a failed one says so", async () => {
  let resolve!: (v: MenuItem[]) => void;
  const m = open(withActions([], () => new Promise<MenuItem[]>((r) => (resolve = r))));
  press("ArrowRight");
  assert.equal(labelOf(rowsOf(subEl())[0]), "Loading…");
  assert.ok(rowsOf(subEl())[0].classList.contains("is-disabled"));
  resolve([{ label: "Push", onClick: () => {} }]);
  await settle();
  assert.equal(labelOf(rowsOf(subEl())[0]), "Push");
  assert.equal(focusedLabel(), "Push");
  press("ArrowLeft");
  ui.closeMenu();

  open(withActions([], () => Promise.reject(new Error("offline"))));
  press("ArrowRight");
  await settle();
  const only = rowsOf(subEl())[0];
  assert.equal(labelOf(only), "Couldn't load these actions");
  assert.ok(only.classList.contains("is-disabled"));
  void m;
});

test("a slow submenu that lands after the menu closed, or after another opened, is dropped", async () => {
  let resolveA!: (v: MenuItem[]) => void;
  const items: MenuItem[] = [
    { label: "a", submenu: () => new Promise<MenuItem[]>((r) => (resolveA = r)) },
    { label: "b", submenu: () => [{ label: "b-action", onClick: () => {} }] },
  ];
  const m = open(items);
  rowsOf(m)[0].querySelector(".dropdown-more")!.click();
  rowsOf(m)[1].querySelector(".dropdown-more")!.click();
  resolveA([{ label: "a-action", onClick: () => {} }]);
  await settle();
  assert.deepEqual(rowsOf(subEl()).map(labelOf), ["b-action"]);

  let resolveLate!: (v: MenuItem[]) => void;
  ui.closeMenu();
  open([{ label: "c", submenu: () => new Promise<MenuItem[]>((r) => (resolveLate = r)) }]);
  press("ArrowRight");
  assert.ok(subEl(), "Loading… is up");
  ui.closeMenu();
  resolveLate([{ label: "late", onClick: () => {} }]);
  await settle();
  assert.equal(doc.querySelector(".dropdown"), null, "no orphan submenu appears over the page");
});

test("typing in the filter closes a submenu that belonged to the old list", () => {
  const items: MenuItem[] = [...withActions([]), ...branches(10)];
  const m = open(items);
  rowsOf(m)[0].querySelector(".dropdown-more")!.click();
  assert.ok(subEl());
  const search = m.querySelector("input.dropdown-search")!;
  search.value = "feat";
  fire(search, "input");
  assert.equal(subEl(), null);
});

test("a disabled row with actions offers neither", () => {
  const m = open([{ label: "locked", disabled: true, submenu: () => [{ label: "x", onClick: () => {} }] }]);
  const row = rowsOf(m)[0];
  assert.equal(row.hasAttribute("aria-haspopup"), false);
  assert.equal(row.querySelector(".dropdown-more"), null);
  row.click();
  assert.equal(subEl(), null);
});

// ── placement ────────────────────────────────────────────────────────────────

const px = (v: unknown): number => Number(String(v).replace("px", ""));

test("the menu hangs below its trigger, capped to the window with an 8px margin", () => {
  const m = open([{ label: "x", onClick: () => {} }]);
  assert.equal(px(m.style.left), 100);
  assert.equal(px(m.style.top), 75, "5px under the trigger's bottom edge");
  assert.equal(m.style.maxWidth, "1184px");
  assert.equal(m.style.maxHeight, "784px");
});

test("a menu that would run off the right edge aligns its right edge to the trigger's", () => {
  setRect(anchor, { left: 1080, top: 50, width: 60, height: 20 });
  const m = open([{ label: "x", onClick: () => {} }]);
  assert.equal(px(m.style.left), 1140 - 200);
});

test("align:'end' hangs from the trigger's right edge from the start", () => {
  setRect(anchor, { left: 400, top: 50, width: 60, height: 20 });
  const m = open([{ label: "x", onClick: () => {} }], { align: "end" });
  assert.equal(px(m.style.left), 460 - 200);
});

test("a menu that would hang below the fold opens above its trigger — or clamps when neither fits", () => {
  setRect(anchor, { left: 100, top: 700, width: 60, height: 20 });
  const m = open([{ label: "x", onClick: () => {} }]);
  assert.equal(px(m.style.top), 700 - 150 - 5);
  ui.closeMenu();

  dom.window.innerHeight = 300;
  setRect(anchor, { left: 100, top: 100, width: 60, height: 20 });
  doc.sizer = () => ({ width: 200, height: 250 });
  const m2 = open([{ label: "x", onClick: () => {} }]);
  assert.equal(px(m2.style.top), 300 - 250 - 8, "no room above either: pinned inside the bottom margin");
});

test("a narrow window never pushes the menu past its left margin", () => {
  dom.window.innerWidth = 150;
  setRect(anchor, { left: 20, top: 50, width: 60, height: 20 });
  const m = open([{ label: "x", onClick: () => {} }]);
  assert.equal(px(m.style.left), 8);
  assert.equal(m.style.maxWidth, "160px", "never narrower than 160px");
});

test("a submenu sits beside the menu level with its row, or flips left at the window's edge", () => {
  const m = open(withActions([]));
  const row = rowsOf(m)[0];
  setRect(row, { top: 30 });
  row.querySelector(".dropdown-more")!.click();
  const sub = subEl()!;
  assert.equal(px(sub.style.left), 100 + 200 - 2);
  assert.equal(px(sub.style.top), 75 + 30 - 6);
  ui.closeMenu();

  setRect(anchor, { left: 900, top: 50, width: 60, height: 20 });
  const m2 = open(withActions([]));
  rowsOf(m2)[0].querySelector(".dropdown-more")!.click();
  assert.equal(px(subEl()!.style.left), 900 - 200 + 2, "no room on the right: it opens to the left");
});

test("resizing re-anchors to the trigger; scrolling it out of sight closes the menu", () => {
  const m = open(withActions([]));
  rowsOf(m)[0].querySelector(".dropdown-more")!.click();
  setRect(anchor, { left: 300, top: 120, width: 80, height: 20 });
  fire(dom.window, "resize", { bubbles: false });
  assert.equal(px(m.style.left), 300);
  assert.equal(px(m.style.top), 145);
  assert.equal(subEl(), null, "the submenu hung off a row that moved");

  // The menu's own overflow scroll is not the page moving.
  fire(m, "scroll", { bubbles: false });
  assert.ok(menuEl());
  assert.equal(px(m.style.top), 145);

  setRect(anchor, { left: 300, top: -100, width: 80, height: 20 });
  const list = doc.createElement("div");
  doc.body.appendChild(list);
  fire(list, "scroll", { bubbles: false });
  assert.equal(menuEl(), null, "its subject scrolled off screen, so it closed");
});

test("scrolling inside the menu keeps an open submenu level with its row", () => {
  const m = open(withActions([]));
  const row = rowsOf(m)[0];
  row.querySelector(".dropdown-more")!.click();
  const before = px(subEl()!.style.top);
  m.scrollTop = 20;
  fire(m, "scroll", { bubbles: false });
  assert.equal(px(subEl()!.style.top), before - 20);
  fire(subEl()!, "scroll", { bubbles: false });
  assert.ok(subEl(), "the submenu's own scroll moves nothing");
});

test("a trigger removed by a re-render closes its menu on the next resize", () => {
  open([{ label: "x", onClick: () => {} }]);
  anchor.remove();
  fire(dom.window, "resize", { bubbles: false });
  assert.equal(menuEl(), null);
});
