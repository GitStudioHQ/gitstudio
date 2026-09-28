import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type LocalBranch, type VsCodeTheme } from "./changesPage";
import { jsLiteral } from "../../../scripts/test/js-literal.mjs";

// The Changes view's branch menu from the keyboard (issue #32: "search a
// branch → arrow to select it → right arrow to show options for that branch,
// e.g. pull. IntelliJ IDEA has this."), in the real page commitView.ts
// serves, in a windowless Chrome, with real key and mouse events.
//
// The rules, per cell of: where the highlight is (none · top action ·
// branch · submenu item) × what happens (arrow · Right · Left · Enter ·
// held Enter · Escape · typing · the mouse · a repaint from the host):
//   · Up/Down move one visible row (never a group header), clamped;
//   · typing filters and puts the highlight on the first match;
//   · Right or Enter on a branch opens its submenu with its first item
//     highlighted; Up/Down move there; Enter runs it; Left and Escape go
//     back to the branch; Escape again closes the menu;
//   · Enter on a top action runs it;
//   · a held key's repeat runs nothing — not in the menu, and not in the
//     confirm a menu item raised;
//   · PageUp/PageDown move a page of rows, Ctrl/Cmd+Home/End go to either
//     end, and plain Home/End are left to the box's caret;
//   · the search box keeps focus throughout — Tab included, since nothing
//     else in the menu takes a Tab stop, and a press anywhere in the menu or
//     a submenu — and its aria-activedescendant names the highlighted option;
//   · a local branch's submenu has the star as an item, and starring — from
//     there or the star — moves the row at once, before the host answers;
//     a host post sent before the star does not move it back, and the
//     host's agreeing post rebuilds nothing;
//   · the pointer moves the highlight, but a list scrolling under a pointer
//     that did not move does not, and nor does crossing rows on the way to
//     an open submenu.
// And the reset item (the other half of #32): on a local branch whose
// upstream is a remote branch the repo has, current or not, in the danger
// style, named with the real upstream — and nowhere else.

const LOCAL: LocalBranch[] = [
  { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
  { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, ahead: 2, behind: 1 },
  { name: "topic" },
  { name: "tracks-local", upstream: "main", upstreamOnRemote: false },
  { name: "gone-upstream", upstream: "origin/gone-upstream", upstreamOnRemote: false },
];
const STATE = stateMessage({
  local: LOCAL,
  remote: ["origin/main", "origin/feature"],
  tags: ["v1.0"],
});

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

let page: ChangesPage;

async function openMenu(p: ChangesPage, state: unknown = STATE): Promise<void> {
  await p.eval(`(function () { var m = document.querySelector(".branch-menu"); if (m) document.getElementById("branch-pill").click(); window.__posted.length = 0; })()`);
  await p.send(state);
  await p.send({ type: "openBranchMenu" });
  await p.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
  // The menu registers its document listeners a tick after it opens.
  await p.eval(`new Promise(function (r) { setTimeout(r, 20); })`);
}

/** Where the highlight is, what the box says, and who has focus. */
interface Snap {
  main: string | null;
  sub: string | null;
  open: string | null;
  activeDescendant: string | null;
  activeDescendantIsHighlighted: boolean;
  focusIsSearch: boolean;
  subOpen: boolean;
  menuOpen: boolean;
}
async function snap(p: ChangesPage): Promise<Snap> {
  return p.eval<Snap>(`(function () {
    var input = document.querySelector(".branch-menu .bm-search input");
    var main = document.querySelector(".bm-list .is-active");
    var sub = document.querySelector(".branch-submenu .is-active");
    var open = document.querySelector(".bm-list .is-open");
    var ad = input ? input.getAttribute("aria-activedescendant") : null;
    var adEl = ad ? document.getElementById(ad) : null;
    return {
      main: main ? main.dataset.bmkey : null,
      sub: sub ? sub.textContent.trim() : null,
      open: open ? open.dataset.bmkey : null,
      activeDescendant: ad,
      activeDescendantIsHighlighted: !!adEl && adEl.classList.contains("is-active") && adEl.getAttribute("aria-selected") === "true",
      focusIsSearch: !!input && document.activeElement === input,
      subOpen: !!document.querySelector(".branch-submenu"),
      menuOpen: !!document.querySelector(".branch-menu"),
    };
  })()`);
}
const submenuLabels = (p: ChangesPage): Promise<string[]> =>
  p.eval(`Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`);

before(async () => {
  if (chrome) page = await ChangesPage.open("dark");
});
after(async () => {
  if (page) await page.close();
});

test("the arrows walk the visible rows — never a group header — clamped at both ends", { skip }, async () => {
  await openMenu(page);
  let s = await snap(page);
  assert.equal(s.main, null, "nothing is highlighted until a key says so");
  assert.equal(s.activeDescendant, null);
  assert.ok(s.focusIsSearch, "the search box has focus");

  await page.key("ArrowUp");
  assert.equal((await snap(page)).main, "a:fetch", "Up from nothing lands on the first row");
  await page.key("ArrowUp");
  assert.equal((await snap(page)).main, "a:fetch", "clamped at the top");

  const order = await page.eval<string[]>(
    `Array.prototype.map.call(document.querySelectorAll(".bm-list [data-bmkey]"), function (n) { return n.dataset.bmkey; })`,
  );
  const seen = ["a:fetch"];
  for (let i = 1; i < order.length + 2; i++) {
    await page.key("ArrowDown");
    s = await snap(page);
    if (seen[seen.length - 1] !== s.main) seen.push(s.main!);
    assert.ok(s.activeDescendantIsHighlighted, `aria-activedescendant names the highlighted row (${s.main})`);
    assert.ok(s.focusIsSearch, "focus never leaves the search box");
  }
  assert.deepEqual(seen, order, "every keyed row, in order, once — the headers have no key and are never visited");
  assert.equal(s.main, order[order.length - 1], "clamped at the bottom");

  // A collapsed group's rows are skipped.
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".bm-sep"), function (h) { return /remote/i.test(h.textContent); }).click()`);
  await page.key("ArrowUp");
  await page.key("ArrowUp");
  s = await snap(page);
  assert.ok(!String(s.main).startsWith("b:remote:"), `a collapsed group's row is not visited (${s.main})`);
  await page.eval(`Array.prototype.find.call(document.querySelectorAll(".bm-sep"), function (h) { return /remote/i.test(h.textContent); }).click()`);
});

test("typing filters and puts the highlight on the first match; an empty box has none", { skip }, async () => {
  await openMenu(page);
  await page.key("ArrowDown");
  await page.key("ArrowDown");
  await page.type("feat");
  let s = await snap(page);
  assert.equal(s.main, "b:local:feature", "the first match, not the row the arrows had reached");
  assert.ok(s.activeDescendantIsHighlighted);
  await page.type("ure");
  assert.equal((await snap(page)).main, "b:local:feature");
  await page.key("ArrowDown");
  assert.equal((await snap(page)).main, "b:remote:origin/feature", "the arrows walk the filtered rows");
  await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  s = await snap(page);
  assert.equal(s.main, null, "cleared: nothing highlighted, so Enter cannot run an unseen row");
  assert.equal(s.activeDescendant, null);
});

test("Right opens a branch's submenu on its first item; Up/Down move there; Left and Escape return to the branch", { skip }, async () => {
  await openMenu(page);
  await page.type("feature");
  await page.key("ArrowRight");
  let s = await snap(page);
  assert.ok(s.subOpen, "the submenu opened");
  assert.equal(s.sub, "Checkout", "its first item is highlighted");
  assert.equal(s.open, "b:local:feature", "the branch stays marked as the submenu's parent");
  assert.equal(s.main, null, "one highlight at a time");
  assert.equal(s.activeDescendant, "bm-sub-0");
  assert.ok(s.activeDescendantIsHighlighted);
  assert.equal(
    await page.eval(`document.querySelector(".bm-search input").getAttribute("aria-controls")`),
    "bm-list bm-sub",
    "the box controls the submenu while it is open",
  );
  await page.key("ArrowUp");
  assert.equal((await snap(page)).sub, "Checkout", "clamped at the submenu's top");
  await page.key("ArrowDown");
  assert.equal((await snap(page)).sub, "Pull 1 Commit into 'feature'");

  await page.key("ArrowLeft");
  s = await snap(page);
  assert.ok(!s.subOpen, "Left closes the submenu");
  assert.equal(s.main, "b:local:feature", "and the highlight is back on the branch");
  assert.ok(s.activeDescendantIsHighlighted);

  await page.key("ArrowRight");
  await page.key("ArrowDown");
  await page.key("Escape");
  s = await snap(page);
  assert.ok(!s.subOpen && s.menuOpen, "Escape closes only the submenu");
  assert.equal(s.main, "b:local:feature");
  await page.key("Escape");
  assert.ok(!(await snap(page)).menuOpen, "Escape again closes the menu");

  // Right on a top action moves the caret: nothing opens.
  await openMenu(page);
  await page.key("ArrowDown");
  await page.key("ArrowRight");
  s = await snap(page);
  assert.ok(!s.subOpen);
  assert.equal(s.main, "a:fetch");
});

test("Enter runs the highlighted row: a top action, a branch's submenu, a submenu item", { skip }, async () => {
  await openMenu(page);
  await page.type("fetch");
  await page.key("Enter");
  let posted = await page.posted();
  assert.deepEqual(posted.filter((m) => m.type === "branchAction"), [{ type: "branchAction", action: "fetch" }]);
  // Fetch runs in place: the menu stays, and the highlight survives the repaint.
  assert.equal((await snap(page)).main, "a:fetch");

  await openMenu(page);
  await page.type("topic");
  await page.key("Enter");
  let s = await snap(page);
  assert.ok(s.subOpen, "Enter on a branch opens its submenu, as a click does");
  assert.equal(s.sub, "Checkout");
  await page.key("Enter");
  posted = await page.posted();
  assert.deepEqual(posted.filter((m) => m.type === "branchRefCommand"), [
    { type: "branchRefCommand", command: "gitstudio.branch.checkout", ref: "topic", refType: "head" },
  ]);
  s = await snap(page);
  assert.ok(!s.menuOpen, "a submenu item that hands off closes the menu, as a click does");
});

test("a held Enter's repeat runs nothing — in the menu, or in the confirm a menu item raised", { skip }, async () => {
  await openMenu(page);
  await page.type("topic");
  await page.key("Enter", { repeat: true });
  assert.ok(!(await snap(page)).subOpen, "a repeat does not open the submenu");
  await page.key("Enter");
  await page.key("Enter", { repeat: true });
  assert.deepEqual(
    (await page.posted()).filter((m) => m.type === "branchRefCommand"),
    [],
    "nor run its first item",
  );
  await page.key("Escape");
  await page.key("Escape");

  // The host's confirm for a destructive item: a repeat must not answer it.
  await page.send({
    type: "dialog",
    dialogId: "d1",
    spec: { kind: "confirm", title: "Reset 'feature' to 'origin/feature'?", message: "…", confirmLabel: "Reset", danger: true },
  });
  await page.page.waitFor(`!!document.querySelector(".rp-panel")`);
  await page.key("Enter", { repeat: true });
  assert.deepEqual((await page.posted()).filter((m) => m.type === "dialogResult"), [], "a repeat is not a yes");
  await page.key("Enter");
  assert.deepEqual(
    (await page.posted()).filter((m) => m.type === "dialogResult"),
    [{ type: "dialogResult", dialogId: "d1", dialogValue: "ok" }],
    "a fresh press is",
  );

  // Every kind of question the menu's items raise: a pick, a name, a checklist.
  const specs = [
    { kind: "pick", title: "Check out 'origin/feature'", choices: [{ id: "checkout", label: "Switch to local 'feature'" }, { id: "reset", label: "Reset…" }] },
    { kind: "input", title: "Rename branch feature", value: "feature-2", confirmLabel: "Rename" },
    { kind: "multiPick", title: "Pick", choices: [{ id: "a", label: "A", picked: true }], confirmLabel: "OK" },
  ];
  let n = 1;
  for (const spec of specs) {
    const id = `d${++n}`;
    await page.send({ type: "dialog", dialogId: id, spec });
    await page.page.waitFor(`!!document.querySelector(".rp-panel")`);
    await page.key("Enter", { repeat: true });
    assert.deepEqual(
      (await page.posted()).filter((m) => m.type === "dialogResult" && m.dialogId === id),
      [],
      `${spec.kind}: a repeat is not an answer`,
    );
    await page.key("Enter");
    assert.equal(
      (await page.posted()).filter((m) => m.type === "dialogResult" && m.dialogId === id).length,
      1,
      `${spec.kind}: a fresh press is`,
    );
  }
});

test("the reset item: on a local branch tracking a remote branch, current or not — named, dangerous, and nowhere else", { skip }, async () => {
  await openMenu(page);
  const itemsFor = async (query: string): Promise<{ labels: string[]; danger: string[] }> => {
    await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
    await page.type(query);
    await page.key("ArrowRight");
    const labels = await submenuLabels(page);
    const danger = await page.eval<string[]>(
      `Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction.danger"), function (b) { return b.textContent.trim(); })`,
    );
    await page.key("ArrowLeft");
    return { labels, danger };
  };

  const feature = await itemsFor("feature");
  assert.ok(feature.labels.includes("Reset to 'origin/feature'…"), feature.labels.join(" | "));
  assert.deepEqual(feature.danger, ["Reset to 'origin/feature'…", "Delete"], "in the danger style, beside Delete");
  assert.ok(
    feature.labels.indexOf("Reset to 'origin/feature'…") < feature.labels.indexOf("Delete"),
    "above Delete",
  );

  const main = await itemsFor("main");
  assert.ok(main.labels.includes("Reset to 'origin/main'…"), `the current branch has it too: ${main.labels.join(" | ")}`);
  assert.deepEqual(main.danger, ["Reset to 'origin/main'…"]);

  for (const q of ["topic", "tracks-local", "gone-upstream"]) {
    const other = await itemsFor(q);
    assert.ok(!other.labels.some((l) => l.startsWith("Reset")), `${q}: no reset item (${other.labels.join(" | ")})`);
  }
  for (const q of ["origin/main", "v1.0"]) {
    const other = await itemsFor(q);
    assert.ok(!other.labels.some((l) => l.startsWith("Reset")), `${q}: a remote branch or tag has no reset item`);
  }

  // Run it from the keyboard: it asks the host, by the branch's name.
  await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  await page.type("feature");
  await page.key("ArrowRight");
  const labels = await submenuLabels(page);
  for (let i = 0; i < labels.indexOf("Reset to 'origin/feature'…"); i++) await page.key("ArrowDown");
  assert.equal((await snap(page)).sub, "Reset to 'origin/feature'…");
  await page.key("Enter");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchRefCommand"), [
    { type: "branchRefCommand", command: "gitstudio.branch.resetToUpstream", ref: "feature", refType: "head" },
  ]);
});

test("the pointer moves the highlight — but not a list scrolling under a still pointer, nor crossing rows to an open submenu", { skip }, async () => {
  // A view with room beside the menu, where a branch's actions open there
  // and the way to them can cross other rows.
  await page.resize(900, 640);
  try {
    await pointerMovesTheHighlight();
  } finally {
    await page.resize(520, 640);
  }
});
async function pointerMovesTheHighlight(): Promise<void> {
  await openMenu(page);
  const centre = (sel: string): Promise<{ x: number; y: number }> =>
    page.eval(`(function () { var r = document.querySelector(${jsLiteral(sel)}).getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
  const topic = await centre(`.bm-branch[data-bname="topic"]`);
  await page.mouseMove(topic.x, topic.y);
  assert.equal((await snap(page)).main, "b:local:topic", "hover moves the highlight");
  await page.key("ArrowDown");
  assert.equal((await snap(page)).main, "b:local:tracks-local", "and the keys carry on from there");
  // The same pointer position again — what a scroll under a still mouse sends.
  await page.mouseMove(topic.x, topic.y);
  assert.equal((await snap(page)).main, "b:local:tracks-local", "a pointer that did not move takes nothing");

  // A click opens the submenu and leaves focus in the search box.
  const feature = await centre(`.bm-branch[data-bname="feature"]`);
  await page.click(feature.x, feature.y);
  let s = await snap(page);
  assert.ok(s.subOpen && s.focusIsSearch, "clicked open, and the keys still work");
  assert.equal(s.main, "b:local:feature");
  // Another main row the submenu does not cover (in a narrow view it can
  // flip over the menu itself).
  const other = await page.eval<{ x: number; y: number; key: string }>(`(function () {
    var sub = document.querySelector(".branch-submenu").getBoundingClientRect();
    var rows = document.querySelectorAll(".bm-list [data-bmkey]");
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i].getBoundingClientRect();
      var x = Math.round(r.left + r.width / 2), y = Math.round(r.top + r.height / 2);
      var covered = x >= sub.left && x <= sub.right && y >= sub.top && y <= sub.bottom;
      if (!covered && rows[i].dataset.bmkey !== "b:local:feature" && r.height > 0) return { x: x, y: y, key: rows[i].dataset.bmkey };
    }
    return null;
  })()`);
  assert.ok(other, "a main row outside the submenu");
  await page.mouseMove(other.x, other.y);
  s = await snap(page);
  assert.ok(s.subOpen, `crossing another row (${other.key}) on the way does not close the submenu`);
  assert.equal(s.main, "b:local:feature", "nor move the highlight off its branch");
  await page.key("ArrowDown");
  assert.equal((await snap(page)).sub, "Checkout", "Down after a click goes into the open submenu");
  const second = await centre(`.branch-submenu #bm-sub-1`);
  await page.mouseMove(second.x, second.y);
  assert.equal((await snap(page)).sub, "Pull 1 Commit into 'feature'", "hovering an item highlights it");
}

test("the highlight scrolls into view, and survives the host repainting the menu", { skip }, async () => {
  const many: LocalBranch[] = [
    ...LOCAL,
    ...Array.from({ length: 60 }, (_, i) => ({ name: `work/item-${String(i).padStart(2, "0")}` })),
  ];
  await openMenu(page, stateMessage({ local: many, remote: ["origin/main", "origin/feature"] }));
  for (let i = 0; i < 40; i++) await page.key("ArrowDown");
  const inView = await page.eval<{ key: string; ok: boolean }>(`(function () {
    var list = document.querySelector(".bm-list").getBoundingClientRect();
    var row = document.querySelector(".bm-list .is-active");
    var r = row.getBoundingClientRect();
    return { key: row.dataset.bmkey, ok: r.top >= list.top - 1 && r.bottom <= list.bottom + 1 };
  })()`);
  assert.ok(inView.ok, `the highlighted row ${inView.key} is inside the list's visible box`);

  // A submenu open from the keyboard, then the host repaints with new counts.
  await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  await page.type("feature");
  await page.key("ArrowRight");
  await page.key("ArrowDown");
  await page.key("ArrowDown");
  const before = (await snap(page)).sub;
  const fresh = many.map((b) => (b.name === "feature" ? { ...b, ahead: 3 } : b));
  await page.send(stateMessage({ local: fresh, remote: ["origin/main", "origin/feature"] }));
  const s = await snap(page);
  assert.ok(s.subOpen, "the submenu is rebuilt, not lost");
  assert.equal(s.sub, before, "with the same item highlighted");
  assert.ok(s.activeDescendantIsHighlighted);
});

test("Tab and Shift+Tab leave focus in the search box; nothing in the menu is in the tab order", { skip }, async () => {
  const tabbable = (): Promise<string[]> =>
    page.eval<string[]>(`Array.prototype.filter.call(
      document.querySelectorAll(".branch-menu button, .branch-menu [tabindex], .branch-submenu button, .branch-submenu [tabindex]"),
      function (n) { return n.tabIndex >= 0; }).map(function (n) { return n.className + ": " + n.textContent.trim(); })`);
  // Enough tags for a "Show more" row.
  const tags = Array.from({ length: 45 }, (_, i) => `v1.${i}`);
  await openMenu(page, stateMessage({ local: LOCAL, remote: ["origin/main", "origin/feature"], tags }));
  assert.ok(await page.eval(`!!document.querySelector(".bm-more") && !!document.querySelector(".bm-action") && !!document.querySelector(".bm-star")`));
  // The last page says its number once — as a stash's files do (changesStashes).
  assert.equal(await page.eval<string>(`document.querySelector(".bm-more").textContent`), "Show 5 more");
  assert.deepEqual(await tabbable(), [], "top actions, rows, stars, group headers and 'Show more' take no Tab stop");
  await page.key("Tab");
  assert.ok((await snap(page)).focusIsSearch, "Tab keeps focus in the search box");
  await page.key("ArrowDown");
  assert.equal((await snap(page)).main, "a:fetch", "and the arrows still work");
  await page.key("Tab", { with: ["shift"] });
  assert.ok((await snap(page)).focusIsSearch, "Shift+Tab too");
  await page.type("feature");
  await page.key("ArrowRight");
  await page.key("Tab");
  const s = await snap(page);
  assert.ok(s.focusIsSearch && s.subOpen, "and with a submenu open");
  assert.deepEqual(await tabbable(), [], "nor do the submenu's items");
  await page.key("Escape");
  await page.key("Escape");
});

test("a local branch's submenu stars it, and so does the star — at once, before the host answers", { skip }, async () => {
  const groupOf = (name: string): Promise<string | null> =>
    page.eval(`(function () {
      var r = document.querySelector('.bm-list .bm-branch[data-bname="${name}"]');
      var g = r && r.closest(".bm-group-body");
      return g ? g.getAttribute("aria-label") : null;
    })()`);
  const starOn = (name: string): Promise<boolean> =>
    page.eval(`document.querySelector('.bm-list .bm-branch[data-bname="${name}"] .bm-star').classList.contains("on")`);

  await openMenu(page);
  await page.type("topic");
  await page.key("ArrowRight");
  const labels = await submenuLabels(page);
  assert.ok(labels.includes("Add to Favorites"), labels.join(" | "));
  for (let i = 0; i < labels.indexOf("Add to Favorites"); i++) await page.key("ArrowDown");
  assert.equal((await snap(page)).sub, "Add to Favorites");
  await page.key("Enter");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction"), [
    { type: "branchAction", action: "favorite", ref: "topic" },
  ]);
  let s = await snap(page);
  assert.ok(s.menuOpen && s.subOpen, "the menu and its submenu stay open");
  assert.equal(s.sub, "Remove from Favorites", "the same item, highlighted, now says what it will do");
  assert.equal(await groupOf("topic"), "Favorites", "the row is in Favorites before any reply");
  assert.ok(await starOn("topic"));

  // The host's own push agrees: nothing moves.
  const starred = LOCAL.map((b) => (b.name === "topic" ? { ...b, favorite: true } : b));
  await page.send(stateMessage({ local: starred, remote: ["origin/main", "origin/feature"], tags: ["v1.0"] }));
  s = await snap(page);
  assert.equal(s.sub, "Remove from Favorites");
  assert.equal(await groupOf("topic"), "Favorites");

  // The star, by mouse: un-starred at once, too.
  await page.key("Escape");
  await page.eval(`document.querySelector('.bm-list .bm-branch[data-bname="topic"] .bm-star').click()`);
  assert.equal(await groupOf("topic"), "Local", "back in Local before any reply");
  assert.ok(!(await starOn("topic")));
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction").slice(-1), [
    { type: "branchAction", action: "favorite", ref: "topic" },
  ]);

  // The current branch has the item; a remote branch and a tag do not.
  await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  await page.type("main");
  await page.key("ArrowRight");
  assert.ok((await submenuLabels(page)).includes("Add to Favorites"), "the current branch");
  await page.key("ArrowLeft");
  for (const q of ["origin/main", "v1.0"]) {
    await page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
    await page.type(q);
    await page.key("ArrowRight");
    assert.ok(!(await submenuLabels(page)).some((l) => /Favorites/.test(l)), `${q}: no favourites item`);
    await page.key("ArrowLeft");
  }
  await page.key("Escape");
});

// Only rows and submenu items kept focus on a press; the rest of the menu let
// it fall to the page, where the arrows did nothing and Tab went to the branch
// pill behind the scrim with the menu still open.
test("a press anywhere in the menu or a submenu leaves focus in the search box", { skip }, async () => {
  /** A real mouse press on `sel` — its centre, or just inside its left edge (its padding). */
  const pressOn = async (sel: string, at: "centre" | "edge" = "centre"): Promise<Snap> => {
    const c = await page.eval<{ x: number; y: number } | null>(`(function () {
      var n = document.querySelector(${jsLiteral(sel)}); if (!n) return null;
      var r = n.getBoundingClientRect();
      return { x: ${at === "edge" ? "r.left + 2" : "r.left + r.width / 2"}, y: r.top + r.height / 2 };
    })()`);
    assert.ok(c, `${sel} is on screen`);
    await page.click(c.x, c.y);
    return snap(page);
  };
  const clear = () => page.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);

  await openMenu(page);
  let s = await pressOn(".branch-menu .bm-search", "edge");
  assert.ok(s.menuOpen && s.focusIsSearch, "the search row's padding");

  // Drilled in (this view has no room beside the menu): the back row takes
  // the press and goes back; the rest of the actions' box takes nothing.
  await page.type("feature");
  await page.key("ArrowRight");
  assert.ok(await page.eval<boolean>(`document.querySelector(".branch-menu").contains(document.querySelector(".branch-submenu"))`), "drilled in");
  for (const [sel, at] of [
    [".branch-submenu .bm-subsep", "centre"],
    [".branch-submenu", "edge"],
  ] as const) {
    s = await pressOn(sel, at);
    assert.ok(s.subOpen && s.focusIsSearch, `drilled in, a press on ${sel} (${at})`);
  }
  s = await pressOn(".branch-submenu .bm-subhead");
  assert.ok(!s.subOpen && s.menuOpen && s.focusIsSearch, "drilled in, the back row goes back, focus in the box");
  assert.equal(s.main, "b:local:feature", "to its branch");
  await page.key("ArrowDown");
  assert.equal((await snap(page)).main, "b:remote:origin/feature", "and the arrows move on in the list");

  // Beside the menu, in a view with room for it there.
  await page.resize(900, 640);
  try {
    await openMenu(page);
    await page.type("feature");
    await page.key("ArrowRight");
    assert.ok(!(await page.eval<boolean>(`document.querySelector(".branch-menu").contains(document.querySelector(".branch-submenu"))`)), "beside the menu");
    for (const [sel, at] of [
      [".branch-submenu .bm-subhead", "centre"],
      [".branch-submenu .bm-subsep", "centre"],
      [".branch-submenu", "edge"],
    ] as const) {
      s = await pressOn(sel, at);
      assert.ok(s.subOpen && s.focusIsSearch, `a press on ${sel} (${at})`);
    }
    // After a press on the submenu's title band the arrows still move in it.
    s = await pressOn(".branch-submenu .bm-subhead");
    const was = s.sub;
    await page.key("ArrowDown");
    assert.notEqual((await snap(page)).sub, was, `Down moved on from '${was}'`);
    await page.key("ArrowLeft");
  } finally {
    await page.resize(520, 640);
  }

  await clear();
  await page.type("zzzq");
  s = await pressOn(".bm-list .bm-empty");
  assert.ok(s.menuOpen && s.focusIsSearch, "the 'No matches' row");
  await page.key("Tab");
  s = await snap(page);
  assert.ok(s.menuOpen && s.focusIsSearch, "and Tab after it stays in the box, the menu open");

  // The loading row too.
  const first = stateMessage({ local: LOCAL });
  delete first.branches;
  await openMenu(page, first);
  s = await pressOn(".bm-list .bm-loading");
  assert.ok(s.menuOpen && s.focusIsSearch, "the 'Loading branches…' row");
  await page.key("Escape");
});

// The host answers a star with a state post, and the first of those carries
// the list it had before the star (the fast post). A post like that must not
// put the row back where it was, and the host's own answer, which agrees,
// must not rebuild the list the click already rebuilt.
test("a star holds through a host post sent before it, and the host's agreeing post rebuilds nothing", { skip }, async () => {
  const groupOf = (name: string): Promise<string | null> =>
    page.eval(`(function () {
      var r = document.querySelector('.bm-list .bm-branch[data-bname="${name}"]');
      var g = r && r.closest(".bm-group-body");
      return g ? g.getAttribute("aria-label") : null;
    })()`);
  const rebuilds = (): Promise<number> => page.eval(`window.__bmRebuilds`);
  await openMenu(page);
  await page.eval(`window.__bmRebuilds = 0;
    new MutationObserver(function (ms) { ms.forEach(function (m) { if (m.removedNodes.length > 3) window.__bmRebuilds++; }); })
      .observe(document.querySelector(".bm-list"), { childList: true })`);
  const star = await page.eval<{ x: number; y: number }>(`(function () {
    var r = document.querySelector('.bm-list .bm-branch[data-bname="topic"] .bm-star').getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`);
  // An empty star shows on the row under the pointer: the pointer gets there first.
  await page.mouseMove(star.x, star.y);
  await page.click(star.x, star.y);
  assert.equal(await groupOf("topic"), "Favorites", "starred at once");
  assert.deepEqual((await page.posted()).filter((m) => m.type === "branchAction"), [
    { type: "branchAction", action: "favorite", ref: "topic" },
  ]);
  const afterClick = await rebuilds();

  // The host's fast post, with the list from before the star.
  await page.send(STATE);
  assert.equal(await groupOf("topic"), "Favorites", "a post from before the star does not un-star it");
  assert.equal(await rebuilds(), afterClick, "nor rebuild the list");
  await page.type("t");
  assert.equal(await groupOf("topic"), "Favorites", "nor does the next repaint");
  const afterType = await rebuilds();

  // The host's own answer: the same list, starred.
  const starred = stateMessage({
    local: LOCAL.map((b) => (b.name === "topic" ? { ...b, favorite: true } : b)),
    remote: ["origin/main", "origin/feature"],
    tags: ["v1.0"],
  });
  await page.send(starred);
  assert.equal(await groupOf("topic"), "Favorites");
  assert.equal(await rebuilds(), afterType, "the host's agreeing post rebuilds nothing");

  // Once it has answered, the host's list is the truth again (starred elsewhere, un-starred elsewhere).
  await page.send(STATE);
  assert.equal(await groupOf("topic"), "Local", "a later post that un-stars it is taken");
  await page.key("Escape");
});

test("PageUp/PageDown move a page of rows and Ctrl+Home/End go to the ends; plain Home/End stay in the box", { skip }, async () => {
  const many: LocalBranch[] = [
    ...LOCAL,
    ...Array.from({ length: 60 }, (_, i) => ({ name: `work/item-${String(i).padStart(2, "0")}` })),
  ];
  await openMenu(page, stateMessage({ local: many, remote: ["origin/main", "origin/feature"] }));
  const order = await page.eval<string[]>(
    `Array.prototype.map.call(document.querySelectorAll(".bm-list [data-bmkey]"), function (n) { return n.dataset.bmkey; })`,
  );
  const at = async (): Promise<number> => order.indexOf((await snap(page)).main!);
  const inView = (): Promise<boolean> =>
    page.eval(`(function () {
      var l = document.querySelector(".bm-list").getBoundingClientRect(), r = document.querySelector(".bm-list .is-active").getBoundingClientRect();
      return r.top >= l.top - 1 && r.bottom <= l.bottom + 1;
    })()`);

  await page.key("ArrowDown");
  assert.equal(await at(), 0);
  await page.key("PageDown");
  const page1 = await at();
  assert.ok(page1 > 3, `PageDown moves more than a row (to ${page1})`);
  assert.ok(await inView(), "and the row is in view");
  await page.key("PageDown");
  assert.ok((await at()) > page1, "again");
  for (let i = 0; i < 20; i++) await page.key("PageDown");
  assert.equal(await at(), order.length - 1, "clamped at the last row");
  await page.key("PageUp");
  const up = await at();
  assert.ok(up < order.length - 4, `PageUp moves more than a row (to ${up})`);
  assert.ok(await inView());

  await page.key("Home", { with: ["ctrl"] });
  assert.equal(await at(), 0, "Ctrl+Home: the first row");
  await page.key("End", { with: ["ctrl"] });
  assert.equal(await at(), order.length - 1, "Ctrl+End: the last row");
  assert.ok(await inView());
  await page.key("Home", { with: ["meta"] });
  assert.equal(await at(), 0, "Cmd+Home as well");
  await page.key("End");
  assert.equal(await at(), 0, "plain End moves the caret, not the highlight");

  // The same keys in a submenu.
  await page.type("feature");
  await page.key("ArrowRight");
  await page.key("End", { with: ["ctrl"] });
  assert.equal((await snap(page)).sub, "Delete", "Ctrl+End: the submenu's last item");
  await page.key("Home", { with: ["ctrl"] });
  assert.equal((await snap(page)).sub, "Checkout");
  await page.key("PageDown");
  assert.equal((await snap(page)).sub, "Delete", "PageDown: a page down, clamped — the whole submenu is one page");
  await page.key("PageUp");
  assert.equal((await snap(page)).sub, "Checkout");
  await page.key("Escape");
  await page.key("Escape");
});

/** The highlighted row against its neighbour, per theme — does it stand out? */
async function highlightLooks(theme: VsCodeTheme): Promise<{
  bg: string;
  plainBg: string;
  outline: string;
  outlineColor: string;
  subOutline: string;
}> {
  const p = theme === "dark" ? page : await ChangesPage.open(theme);
  try {
    await openMenu(p);
    await p.type("feature");
    const main = await p.eval<{ bg: string; plainBg: string; outline: string; outlineColor: string }>(`(function () {
      var a = getComputedStyle(document.querySelector(".bm-list .is-active"));
      var plain = getComputedStyle(document.querySelector('.bm-branch[data-bname="origin/feature"]'));
      return { bg: a.backgroundColor, plainBg: plain.backgroundColor, outline: a.outlineStyle + " " + a.outlineWidth, outlineColor: a.outlineColor };
    })()`);
    await p.key("ArrowRight");
    const subOutline = await p.eval<string>(`(function () {
      var a = getComputedStyle(document.querySelector(".branch-submenu .is-active"));
      return a.outlineStyle + " " + a.outlineWidth + " " + a.outlineColor;
    })()`);
    await p.key("Escape");
    await p.key("Escape");
    return { ...main, subOutline };
  } finally {
    if (p !== page) await p.close();
  }
}

const TRANSPARENT = /^(transparent|rgba\(0, 0, 0, 0\))$/;

// Lit, never outlined, in the light and dark themes (the owner's rule:
// nothing highlighted wears a line). The high-contrast themes paint a
// selection with VS Code's contrast ring, whole: there, and only there, the
// highlight keeps it. branchMenuLit.test.ts measures every kind of row.
for (const theme of ["dark", "light", "hc-dark", "hc-light"] as VsCodeTheme[]) {
  test(`the highlight is plain to see in ${theme}`, { skip }, async () => {
    const look = await highlightLooks(theme);
    assert.notEqual(look.bg, look.plainBg, `filled (${JSON.stringify(look)})`);
    if (theme === "dark" || theme === "light") {
      assert.match(look.outline, /^none /, `and never outlined (${JSON.stringify(look)})`);
      assert.match(look.subOutline, /^none /, `a submenu item's highlight neither: ${look.subOutline}`);
    } else {
      assert.equal(look.outline, "solid 1px", `high contrast: its ring, whole (${JSON.stringify(look)})`);
      assert.ok(!TRANSPARENT.test(look.outlineColor), `with a colour the theme gives it: ${look.outlineColor}`);
      assert.match(look.subOutline, /^solid 1px /, `a submenu item's highlight too: ${look.subOutline}`);
      assert.doesNotMatch(look.subOutline, /rgba\(0, 0, 0, 0\)$/);
    }
  });
}
