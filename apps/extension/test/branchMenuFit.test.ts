import { test, after } from "node:test";
import assert from "node:assert/strict";
import { ChangesPage, stateMessage, type LocalBranch, type VsCodeTheme } from "./changesPage";

// The Changes view's branch menu ("Search for branches and actions") where
// the sidebar is narrow or short, in the real page commitView.ts serves, in a
// windowless Chrome:
//   · a branch's submenu stays inside the view, however narrow or short it
//     is — every item reachable, the highlighted one scrolled into view, and
//     the same for the file rows' action menu, which is the same popup;
//   · the menu keeps its width while you type;
//   · a new query starts the list at the top, its first group header in view;
//   · the menu takes the room below the pill, fits a view narrower than its
//     least width, and is placed again (with its submenu) when the view is
//     resized while it is open;

const chrome = ChangesPage.chrome();
const skip = chrome ? false : "no windowless Chrome on this machine (set GS_CHROME)";

const pages: ChangesPage[] = [];
async function open(theme: VsCodeTheme, width: number, height: number): Promise<ChangesPage> {
  const p = await ChangesPage.open(theme, { width, height });
  pages.push(p);
  return p;
}
after(async () => {
  for (const p of pages) await p.close();
});

const LONG = "feature/checkout-flow/billing-address-validation-for-international-customers-v2";
const FEW: LocalBranch[] = [
  { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
  { name: "feature", upstream: "origin/feature", upstreamOnRemote: true, ahead: 2, behind: 1 },
  { name: "release/2.1", upstream: "origin/release/2.1", upstreamOnRemote: true },
  { name: "spike/cache" },
];

async function openMenu(p: ChangesPage, state: unknown): Promise<void> {
  await p.send(state);
  await p.send({ type: "openBranchMenu" });
  await p.page.waitFor(`!!document.querySelector(".branch-menu .bm-search input")`);
  await p.eval(`new Promise(function (r) { setTimeout(r, 20); })`);
}
async function closeMenu(p: ChangesPage): Promise<void> {
  await p.eval(`(function () { if (document.querySelector(".branch-menu")) document.getElementById("branch-pill").click(); })()`);
}
async function query(p: ChangesPage, q: string): Promise<void> {
  await p.eval(`(function () { var i = document.querySelector(".bm-search input"); i.value = ""; i.dispatchEvent(new Event("input")); })()`);
  if (q) await p.type(q);
}
/** Put the highlight on a row by its key, the way the arrows get there. */
async function arrowTo(p: ChangesPage, key: string): Promise<void> {
  for (let i = 0; i < 80; i++) {
    const on = await p.eval<string>(`(function () { var a = document.querySelector(".bm-list .is-active"); return a ? a.dataset.bmkey : ""; })()`);
    if (on === key) return;
    await p.key("ArrowDown");
  }
  throw new Error(`never reached ${key}`);
}

interface Box { left: number; top: number; right: number; bottom: number; width: number; height: number }
const box = (p: ChangesPage, sel: string): Promise<Box> =>
  p.eval<Box>(`(function () { var r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; })()`);
const viewport = (p: ChangesPage): Promise<{ w: number; h: number }> => p.eval(`({ w: innerWidth, h: innerHeight })`);

function assertInside(b: Box, vp: { w: number; h: number }, what: string): void {
  const m = 0.5;
  assert.ok(b.left >= -m && b.right <= vp.w + m, `${what} fits across the ${vp.w}px view: ${JSON.stringify(b)}`);
  assert.ok(b.top >= -m && b.bottom <= vp.h + m, `${what} fits down the ${vp.h}px view: ${JSON.stringify(b)}`);
}

test("a branch's submenu stays inside a narrow view", { skip }, async () => {
  for (const width of [260, 300]) {
    const p = await open("dark", width, 640);
    const local: LocalBranch[] = [
      { name: "main", current: true, upstream: "origin/main", upstreamOnRemote: true },
      { name: LONG, upstream: "origin/" + LONG, upstreamOnRemote: true, ahead: 1 },
    ];
    await openMenu(p, stateMessage({ local, remote: ["origin/main", "origin/" + LONG] }));
    for (const q of [LONG.slice(0, 30), "main"]) {
      await query(p, q);
      await arrowTo(p, q === "main" ? "b:local:main" : "b:local:" + LONG);
      await p.key("ArrowRight");
      assertInside(await box(p, ".branch-submenu"), await viewport(p), `${q}'s submenu at ${width}px`);
      await p.key("ArrowLeft");
    }
    await closeMenu(p);
  }
});

test("a branch's submenu stays inside a short view: every item reachable, the highlighted one in view", { skip }, async () => {
  const p = await open("dark", 300, 400);
  await openMenu(p, stateMessage({ local: FEW, remote: ["origin/main", "origin/feature"] }));
  await query(p, "feature");
  await arrowTo(p, "b:local:feature");
  await p.key("ArrowRight");
  const vp = await viewport(p);
  assertInside(await box(p, ".branch-submenu"), vp, "the submenu");
  const labels = await p.eval<string[]>(`Array.prototype.map.call(document.querySelectorAll(".branch-submenu .bm-subaction"), function (b) { return b.textContent.trim(); })`);
  // Walk to the last item: every one on the way is shown.
  for (let i = 1; i < labels.length; i++) {
    await p.key("ArrowDown");
    const at = await p.eval<{ label: string; item: Box; list: Box }>(`(function () {
      var a = document.querySelector(".branch-submenu .is-active");
      var r = a.getBoundingClientRect(), l = a.parentElement.getBoundingClientRect();
      return { label: a.textContent.trim(),
        item: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height },
        list: { left: l.left, top: l.top, right: l.right, bottom: l.bottom, width: l.width, height: l.height } };
    })()`);
    assert.equal(at.label, labels[i]);
    assertInside(at.item, vp, `'${at.label}'`);
    const clip = await box(p, ".branch-submenu .bm-sublist");
    assert.ok(at.item.top >= clip.top - 0.5 && at.item.bottom <= clip.bottom + 0.5, `'${at.label}' is scrolled into the submenu's visible part`);
  }
  assert.equal(labels[labels.length - 1], "Delete");

  // The host repaints the menu (fresh counts): the item stays highlighted AND in view.
  await p.send(stateMessage({ local: FEW.map((b) => (b.name === "feature" ? { ...b, ahead: 3 } : b)), remote: ["origin/main", "origin/feature"] }));
  const after = await p.eval<{ label: string; top: number; bottom: number; clipTop: number; clipBottom: number }>(`(function () {
    var a = document.querySelector(".branch-submenu .is-active");
    var r = a.getBoundingClientRect(), c = a.parentElement.getBoundingClientRect();
    return { label: a.textContent.trim(), top: r.top, bottom: r.bottom, clipTop: c.top, clipBottom: c.bottom };
  })()`);
  assert.equal(after.label, "Delete");
  assert.ok(after.top >= after.clipTop - 0.5 && after.bottom <= after.clipBottom + 0.5, `still in view after the repaint: ${JSON.stringify(after)}`);
  await closeMenu(p);
});

test("the file rows' action menu — the same popup — stays inside a short view too", { skip }, async () => {
  const p = await open("dark", 300, 220);
  await p.send(stateMessage({ local: FEW }));
  await p.page.waitFor(`!!document.querySelector('.row.is-file[data-path="src/app.ts"]')`);
  // A right-click on the row, where a person can see it.
  await p.eval(`(function () {
    var row = document.querySelector('.row.is-file[data-path="src/app.ts"]');
    row.scrollIntoView({ block: "nearest" });
    row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  })()`);
  await p.page.waitFor(`!!document.querySelector(".action-menu")`);
  const vp = await viewport(p);
  assertInside(await box(p, ".action-menu"), vp, "the file's action menu");
  // Its first item has focus (Tab walks this menu): the ring is whole, not
  // clipped by the list that now scrolls.
  const ring = await p.eval<{ focused: boolean; drawn: boolean; out: number; item: Box; list: Box }>(`(function () {
    var a = document.activeElement, s = getComputedStyle(a);
    var r = a.getBoundingClientRect(), l = a.parentElement.getBoundingClientRect();
    var out = parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth);
    return { focused: a.classList.contains("bm-subaction"), drawn: s.outlineStyle !== "none", out: out,
      item: { left: r.left - out, top: r.top - out, right: r.right + out, bottom: r.bottom + out, width: 0, height: 0 },
      list: { left: l.left, top: l.top, right: l.right, bottom: l.bottom, width: 0, height: 0 } };
  })()`);
  assert.ok(ring.focused && ring.drawn, `the first item has focus, and its ring shows: ${JSON.stringify(ring)}`);
  assert.ok(
    ring.item.left >= ring.list.left - 0.5 && ring.item.right <= ring.list.right + 0.5 && ring.item.top >= ring.list.top - 0.5,
    `its focus ring lies inside the list that clips it: ${JSON.stringify(ring)}`,
  );
  // Its last item can be scrolled to.
  const last = await p.eval<{ top: number; bottom: number; clipTop: number; clipBottom: number }>(`(function () {
    var items = document.querySelectorAll(".action-menu .bm-subaction");
    var a = items[items.length - 1];
    a.scrollIntoView({ block: "nearest" });
    var r = a.getBoundingClientRect(), c = a.parentElement.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, clipTop: Math.max(0, c.top), clipBottom: Math.min(innerHeight, c.bottom) };
  })()`);
  assert.ok(last.top >= last.clipTop - 0.5 && last.bottom <= last.clipBottom + 0.5, `its last item scrolls into view: ${JSON.stringify(last)}`);
});

test("the menu takes all the room below the pill in a short view, and no more", { skip }, async () => {
  const p = await open("dark", 300, 380);
  const many: LocalBranch[] = [
    ...FEW,
    ...Array.from({ length: 40 }, (_, i) => ({ name: `work/item-${String(i).padStart(2, "0")}` })),
  ];
  await openMenu(p, stateMessage({ local: many }));
  const m = await box(p, ".branch-menu");
  const pill = await box(p, "#branch-pill");
  const vp = await viewport(p);
  assert.ok(m.top >= pill.bottom, `under the pill: ${JSON.stringify({ m, pill })}`);
  assert.ok(m.bottom <= vp.h - 8 + 0.5, `inside the view: ${JSON.stringify(m)}`);
  assert.ok(m.bottom >= vp.h - 8 - 1, `down to the view's foot, not a fixed share of it: ${JSON.stringify(m)} in ${vp.h}px`);
  await closeMenu(p);
});

test("a view narrower than the menu's least width still holds the whole menu", { skip }, async () => {
  const p = await open("dark", 236, 480);
  await openMenu(p, stateMessage({ local: FEW }));
  assertInside(await box(p, ".branch-menu"), await viewport(p), "the menu");
  await closeMenu(p);
});

test("the sidebar resized with the menu and a submenu open: both are placed inside it again", { skip }, async () => {
  const p = await open("dark", 560, 640);
  await openMenu(p, stateMessage({ local: FEW, remote: ["origin/main", "origin/feature"] }));
  await query(p, "feature");
  await arrowTo(p, "b:local:feature");
  await p.key("ArrowRight");
  await p.key("ArrowDown");
  const before = await p.eval<string>(`document.querySelector(".branch-submenu .is-active").textContent.trim()`);
  for (const [w, h] of [[300, 400], [260, 360]]) {
    await p.resize(w, h);
    const vp = await viewport(p);
    assertInside(await box(p, ".branch-menu"), vp, `the menu at ${w}×${h}`);
    assertInside(await box(p, ".branch-submenu"), vp, `the submenu at ${w}×${h}`);
    const now = await p.eval<{ head: string; active: string }>(`({
      head: document.querySelector(".branch-submenu .bm-subhead-name").textContent,
      active: document.querySelector(".branch-submenu .is-active").textContent.trim(),
    })`);
    assert.deepEqual(now, { head: "feature", active: before }, "the same branch's submenu, the same item highlighted");
  }
  await closeMenu(p);
});

test("the menu keeps its width while you type", { skip }, async () => {
  const p = await open("dark", 320, 640);
  await openMenu(p, stateMessage({ local: FEW, remote: ["origin/main", "origin/feature", "origin/release/2.1"], tags: ["v2.1.0"] }));
  const w0 = (await box(p, ".branch-menu")).width;
  for (const q of ["re", "release", "zzzq", ""]) {
    await query(p, q);
    const w = (await box(p, ".branch-menu")).width;
    assert.ok(Math.abs(w - w0) < 0.5, `the same width with '${q}' in the box: ${w}px, opened at ${w0}px`);
  }
  await closeMenu(p);
});

test("a new query starts the list at the top, its first group header in view", { skip }, async () => {
  const p = await open("dark", 320, 480);
  const many: LocalBranch[] = [
    ...FEW,
    ...Array.from({ length: 60 }, (_, i) => ({ name: `work/item-${String(i).padStart(2, "0")}` })),
  ];
  await openMenu(p, stateMessage({ local: many }));
  await p.eval(`document.querySelector(".bm-list").scrollTop = 400`);
  await p.type("item");
  const s = await p.eval<{ scrollTop: number; headerTop: number; listTop: number }>(`(function () {
    var list = document.querySelector(".bm-list");
    return { scrollTop: list.scrollTop, headerTop: list.querySelector(".bm-sep").getBoundingClientRect().top, listTop: list.getBoundingClientRect().top };
  })()`);
  assert.equal(s.scrollTop, 0, "scrolled to the top");
  assert.ok(s.headerTop >= s.listTop, `the first group header is in view: ${JSON.stringify(s)}`);
  await closeMenu(p);
});
